import "./pq-home.ts";

/** The secure-channel device plane over real sockets: pairing, sessions, decisions, bounds, ops. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { connect, Socket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import test from "node:test";

import {
    ClientSession,
    CLOSE_NOT_PAIRED,
    FLAG_DATA,
    FLAG_END,
    FLAG_RESET,
    PairingInitiator,
    PairingResponder,
    gatewayId,
    parseInviteUri,
    PROTOCOL_VERSION,
} from "@mimi-os/protocol";

import { pairDevice } from "../src/device-client.ts";
import type { HubEvent } from "../src/events.ts";
import { dialRaw, rawSession, type RawSession, type RawWire } from "./channel-client.ts";
import { activeDevice, boot, waitFor, type Env } from "./harness-env.ts";

/** One upgrade request written by hand: it holds a pre-auth slot without speaking the channel.
 *  `headers` are extra raw header lines, each ending in CRLF. */
function rawUpgrade(port: number, headers = ""): Promise<{ sock: Socket; status: string } | null> {
    return new Promise((resolve) => {
        const sock = connect({ port, host: "127.0.0.1" });
        sock.on("error", () => resolve(null));
        sock.once("connect", () => {
            sock.write(
                "GET /channel HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                    `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${headers}\r\n`,
            );
        });
        sock.once("data", (d: Buffer) => resolve({ sock, status: d.toString("utf8").split("\r\n")[0] ?? "" }));
    });
}

/** A client forwarded by a reverse proxy on this host. */
const PROXIED = "X-Real-IP: 203.0.113.7\r\n";

/** Device invites are minted only through an ACTIVE device's tunnel — here, the harness's own. */
async function invite(env: Env): Promise<string> {
    const r = await env.api<{ uri: string }>("POST", "/api/devices/invite");
    assert.equal(r.status, 200);
    return r.json.uri;
}

/** /channel/pair takes the invite id as a query param — the id is not secret, only `s` in the uri is. */
const pairPath = (uri: string): string => `/channel/pair?invite=${encodeURIComponent(parseInviteUri(uri).id)}`;

/** The sas on success, or null when the invite refuses the redemption (spent / unknown id). */
async function pair(env: Env, s: Uint8Array, name: string): Promise<string | null> {
    try {
        return (await pairDevice(env.ws, await invite(env), s, name)).sas;
    } catch {
        return null;
    }
}

/** A control message is exactly one stream-0 frame, completed by FLAG_END. */
function sendJson(live: RawSession, msg: unknown): Uint8Array {
    const payload = new TextEncoder().encode(JSON.stringify(msg));
    live.send(0, FLAG_END, payload);
    return payload;
}

async function nextJson(live: RawSession): Promise<Record<string, unknown> | null> {
    const f = await live.frame();
    if (f === null) return null;
    assert.equal(f.stream, 0);
    return JSON.parse(new TextDecoder().decode(f.payload)) as Record<string, unknown>;
}

/** Runs the handshake by hand until the gateway turns the key away, and resolves with its close code and reason. */
async function refusal(env: Env, s: Uint8Array, gatewayPub = env.core.devices.gatewayPub): Promise<[number, string]> {
    const client = new ClientSession({ s, gatewayPub, protocol: PROTOCOL_VERSION });
    const w = await dialRaw(env, "/channel");
    const closed = once(w.ws, "close") as Promise<[number, Buffer]>;
    w.send(client.start());
    for (let bytes = await w.next(); bytes !== null; bytes = await w.next()) w.send(client.feed(bytes).out);
    const [code, reason] = await closed;
    return [code, reason.toString("utf8")];
}

const NOT_PAIRED: [number, string] = [CLOSE_NOT_PAIRED, "not paired with this gateway"];

async function deviceRow(env: Env, name: string): Promise<Record<string, unknown>> {
    const r = await env.api<{ devices: Array<Record<string, unknown>> }>("GET", "/api/devices");
    const row = r.json.devices.find((d) => d["name"] === name);
    assert.ok(row, `device ${name}`);
    return row;
}

test("identity: a 0600 key file, channelId in health, invite carries the same key", async () => {
    const env = await boot();
    try {
        const health = (await (await fetch(`${env.base}/api/health`)).json()) as Record<string, unknown>;
        const pub = env.core.devices.gatewayPub;
        assert.equal(health["channelId"], gatewayId(pub));
        assert.equal(statSync(join(env.dir, ".channel.key")).size, 32);
        if (process.platform !== "win32") assert.equal(statSync(join(env.dir, ".channel.key")).mode & 0o777, 0o600);
        const r = await env.api<{ expiresAt: string; uri: string; id: string }>("POST", "/api/devices/invite");
        assert.match(r.json.expiresAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        assert.match(r.json.uri, /^mimi:\/\/pair\/v2\?/);
        assert.equal(typeof r.json.id, "string");
    } finally {
        await env.stop();
    }
});

test("identity: an existing key keeps its bytes, has its mode repaired, and refuses a symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mimi-key-"));
    const keyFile = join(dir, ".channel.key");
    const bytes = randomBytes(32);
    writeFileSync(keyFile, bytes);
    chmodSync(keyFile, 0o644);
    const env = await boot({ devices: { keyFile } });
    try {
        const pub = env.core.devices.gatewayPub;
        assert.deepEqual(readFileSync(keyFile), bytes);
        if (process.platform !== "win32") assert.equal(statSync(keyFile).mode & 0o777, 0o600);
        // the repaired key is the same identity: it still pairs a device
        await pairDevice(env.ws, env.core.devices.createLocalInvite().uri, new Uint8Array(randomBytes(32)), "phone");
        assert.deepEqual(env.core.devices.gatewayPub, pub);
    } finally {
        await env.stop();
        rmSync(dir, { recursive: true, force: true });
    }

    const linked = mkdtempSync(join(tmpdir(), "mimi-key-"));
    writeFileSync(join(linked, "real.key"), bytes, { mode: 0o600 });
    symlinkSync(join(linked, "real.key"), join(linked, ".channel.key"));
    const viaLink = await boot({ devices: { keyFile: join(linked, ".channel.key") } });
    try {
        assert.throws(() => viaLink.core.devices.gatewayPub, /regular file/);
    } finally {
        await viaLink.stop();
        rmSync(linked, { recursive: true, force: true });
    }
});

test("pairing enrolls inactive; the pending session is upgraded in place by a tap approve", async () => {
    const env = await boot();
    try {
        const events: HubEvent[] = [];
        env.core.events.subscribe((e) => void events.push(e));
        const s = new Uint8Array(randomBytes(32));
        const sas = await pair(env, s, "phone");
        assert.ok(sas);
        const enrolled = events.find((e) => e.type === "device_enrolled");
        assert.ok(enrolled);
        assert.equal(enrolled["name"], "phone");
        assert.equal(enrolled["sas"], sas);
        const row = await deviceRow(env, "phone");
        assert.equal(row["status"], "inactive");
        assert.equal(row["sas"], sas);
        assert.equal(row["id"], enrolled["id"]);
        assert.equal(row["connected"], false);

        const refused = await rawSession(env, s);
        assert.ok(refused);
        assert.equal(refused.pending, true);
        refused.send(1, FLAG_DATA, new Uint8Array([1]));
        assert.equal(await refused.frame(), null);

        const live = await rawSession(env, s);
        assert.ok(live);
        assert.equal(live.pending, true);
        sendJson(live, { t: "ping" });
        assert.deepEqual(await nextJson(live), { t: "pong" });
        sendJson(live, { t: "epoch", epoch: "e1" });
        assert.deepEqual(await nextJson(live), { t: "error", code: "pending_activation" });
        assert.equal((await deviceRow(env, "phone"))["connected"], true);

        const id = row["id"] as string;
        assert.deepEqual((await env.api("POST", `/api/devices/${id}/approve`)).json, { ok: true });
        assert.deepEqual(await nextJson(live), { t: "activated" });
        assert.ok(events.some((e) => e.type === "device_activated" && e["id"] === id));
        live.send(3, FLAG_DATA, new TextEncoder().encode("GET /"));
        const reset = await live.frame();
        assert.equal(reset?.stream, 3);
        assert.equal(reset?.flags, FLAG_RESET);
        const active = await deviceRow(env, "phone");
        assert.equal(active["status"], "active");
        assert.equal(typeof active["activatedAt"], "string");
        assert.equal(typeof active["lastSeen"], "string");
        assert.equal((await env.api("POST", `/api/devices/${id}/approve`)).status, 404);
        live.ws.close();
    } finally {
        await env.stop();
    }
});

test("an enrollment write failure closes that pairing without escaping the socket handler", async () => {
    const env = await boot();
    try {
        const uri = await invite(env);
        const createDevice = env.db.createDevice.bind(env.db);
        env.db.createDevice = () => {
            throw new Error("disk unavailable");
        };
        await assert.rejects(pairDevice(env.ws, uri, new Uint8Array(randomBytes(32)), "phone"));
        env.db.createDevice = createDevice;
        assert.ok(env.logs.some((line) => line.includes("enrollment failed: disk unavailable")));
        assert.equal((await env.api("GET", "/api/health")).status, 200);
    } finally {
        await env.stop();
    }
});

test("code mode: approve needs the device's sas; settings round-trip and refuse other values", async () => {
    const env = await boot();
    try {
        assert.deepEqual((await env.api("GET", "/api/devices/settings")).json, { approveMode: "tap" });
        assert.equal((await env.api("POST", "/api/devices/settings", { approveMode: "strict" })).status, 400);
        assert.equal((await env.api("POST", "/api/devices/settings", {})).status, 400);
        assert.deepEqual((await env.api("POST", "/api/devices/settings", { approveMode: "code" })).json, {
            approveMode: "code",
        });
        assert.deepEqual((await env.api("GET", "/api/devices/settings")).json, { approveMode: "code" });

        const sas = await pair(env, new Uint8Array(randomBytes(32)), "laptop");
        assert.ok(sas);
        const id = (await deviceRow(env, "laptop"))["id"] as string;
        const wrong = sas === "000000" ? "111111" : "000000";
        assert.equal((await env.api("POST", `/api/devices/${id}/approve`)).status, 409);
        assert.equal((await env.api("POST", `/api/devices/${id}/approve`, { code: wrong })).status, 409);
        assert.equal((await env.api("POST", `/api/devices/${id}/approve`, { code: `${sas}0` })).status, 409);
        assert.equal((await deviceRow(env, "laptop"))["status"], "inactive");
        assert.deepEqual((await env.api("POST", `/api/devices/${id}/approve`, { code: sas })).json, { ok: true });
        assert.equal((await deviceRow(env, "laptop"))["status"], "active");
        assert.equal((await env.api("POST", "/api/devices/0000000000000000/approve", { code: sas })).status, 404);
    } finally {
        await env.stop();
    }
});

test("reject and revoke close live sessions; a spent key never pairs or connects again", async () => {
    const env = await boot();
    try {
        const events: HubEvent[] = [];
        env.core.events.subscribe((e) => void events.push(e));
        const s1 = new Uint8Array(randomBytes(32));
        assert.ok(await pair(env, s1, "tablet"));
        const id1 = (await deviceRow(env, "tablet"))["id"] as string;
        const pending = await rawSession(env, s1);
        assert.ok(pending);
        assert.deepEqual((await env.api("POST", `/api/devices/${id1}/reject`)).json, { ok: true });
        assert.equal(await pending.frame(), null);
        assert.equal((await deviceRow(env, "tablet"))["status"], "revoked");
        assert.equal((await env.api("POST", `/api/devices/${id1}/reject`)).status, 404);
        assert.equal((await env.api("POST", `/api/devices/${id1}/approve`)).status, 404);
        assert.equal(await rawSession(env, s1), null);
        const before = events.filter((e) => e.type === "device_enrolled").length;
        assert.equal(await pair(env, s1, "tablet again"), null);
        assert.equal(events.filter((e) => e.type === "device_enrolled").length, before);

        const { s: s2, id: id2 } = await activeDevice(env, "watch");
        const live = await rawSession(env, s2);
        assert.ok(live);
        assert.equal(live.pending, false);
        assert.equal((await env.api("POST", `/api/devices/${id2}/reject`)).status, 404);
        assert.deepEqual((await env.api("POST", `/api/devices/${id2}/revoke`)).json, { ok: true });
        assert.equal(await live.frame(), null);
        assert.ok(events.some((e) => e.type === "device_revoked" && e["id"] === id2));
        assert.equal((await env.api("POST", `/api/devices/${id2}/revoke`)).status, 404);
        assert.equal(await rawSession(env, s2), null);
        assert.equal(await pair(env, s2, "watch again"), null);
    } finally {
        await env.stop();
    }
});

test("an unknown key is closed only after msg2 and the kem step", async () => {
    const env = await boot();
    try {
        const client = new ClientSession({
            s: new Uint8Array(randomBytes(32)),
            gatewayPub: env.core.devices.gatewayPub,
            protocol: PROTOCOL_VERSION,
        });
        const w = await dialRaw(env, "/channel");
        w.send(client.start());
        const msg2 = await w.next();
        assert.ok(msg2);
        const r = client.feed(msg2);
        assert.equal(r.out.length, 1);
        assert.equal(w.closed, false);
        w.send(r.out);
        assert.equal(await w.next(), null);
    } finally {
        await env.stop();
    }
});

test("a handshake that does not authenticate closes as not paired: another gateway's key, an unknown key, a revoked device", async () => {
    const env = await boot();
    try {
        const { s, id } = await activeDevice(env, "desk");
        assert.deepEqual(await refusal(env, s, new Uint8Array(randomBytes(32))), NOT_PAIRED, "pinned to another gateway's key");
        assert.deepEqual(await refusal(env, new Uint8Array(randomBytes(32))), NOT_PAIRED, "a key this gateway never paired");

        const live = await rawSession(env, s);
        assert.ok(live, "the same device still connects with the right gateway key");
        const dropped = once(live.ws, "close") as Promise<[number, Buffer]>;
        assert.deepEqual((await env.api("POST", `/api/devices/${id}/revoke`)).json, { ok: true });
        assert.equal((await dropped)[0], 1000, "a revoke still closes a live session as before");
        assert.deepEqual(await refusal(env, s), NOT_PAIRED, "a revoked device");

        // the right gateway key and then an unreadable kem record: a broken session, not an unpaired one
        const client = new ClientSession({ s: new Uint8Array(randomBytes(32)), gatewayPub: env.core.devices.gatewayPub, protocol: PROTOCOL_VERSION });
        const w = await dialRaw(env, "/channel");
        const closed = once(w.ws, "close") as Promise<[number, Buffer]>;
        w.send(client.start());
        assert.ok(await w.next());
        w.send([Buffer.concat([Buffer.from([0x04, 0xb0]), randomBytes(1200)])]);
        assert.equal((await closed)[0], 1000);
    } finally {
        await env.stop();
    }
});

test("one invite spans connections: a retransmitted msg1 on a second socket costs no debit", async () => {
    const env = await boot();
    try {
        const uri = await invite(env);
        const path = pairPath(uri);
        const first = new PairingInitiator({ s: new Uint8Array(randomBytes(32)), uri, deviceName: "a" });
        const msg1 = first.start();
        const a = await dialRaw(env, path);
        const b = await dialRaw(env, path);
        a.send(msg1);
        const replyA = await a.next();
        b.send(msg1);
        const replyB = await b.next();
        assert.ok(replyA && replyB);
        assert.deepEqual(replyB, replyA);

        // debits: a = 1, c = 2, d = 3; had b debited, d would exhaust the invite.
        const c = await dialRaw(env, path);
        c.send(new PairingInitiator({ s: new Uint8Array(randomBytes(32)), uri, deviceName: "c" }).start());
        assert.ok(await c.next());
        const d = await dialRaw(env, path);
        d.send(new PairingInitiator({ s: new Uint8Array(randomBytes(32)), uri, deviceName: "d" }).start());
        assert.ok(await d.next());

        // Only the first message owns the pending Noise state; extra attempts can consume their
        // remaining debits but cannot take it over. Its confirmation must still complete.
        const confirm = first.feed(replyA);
        a.send(confirm.out);
        const ok = await a.next();
        assert.ok(ok);
        assert.ok(first.feed(ok).events.some((ev) => ev.type === "enrolled"));
        assert.equal(await a.next(), null);
        await waitFor(() => b.closed && c.closed && d.closed);
        assert.equal((await deviceRow(env, "a"))["status"], "inactive");
    } finally {
        await env.stop();
    }
});

test("a msg1 that never confirms costs its own attempt only: the invite still pairs a device", async () => {
    let clock = Date.now();
    const env = await boot({ devices: { now: () => clock, preauthDeadlineMs: 200 } });
    try {
        const uri = env.core.devices.createDeviceInvite().uri;
        const squatter = await dialRaw(env, pairPath(uri));
        squatter.send(new PairingInitiator({ s: new Uint8Array(randomBytes(32)), uri, deviceName: "squat" }).start());
        assert.ok(await squatter.next(), "the squatter holds the pending slot");
        clock += 11_000;
        await waitFor(() => squatter.closed, 4000, "the squatter's pre-auth deadline");

        const { sas } = await pairDevice(env.ws, uri, new Uint8Array(randomBytes(32)), "phone");
        assert.match(sas, /^\d{6}$/);
        assert.ok(env.db.listDevices().some((d) => d.name === "phone"));
    } finally {
        await env.stop();
    }
});

test("a key belongs to one identity plane: an agent pin never enrolls as a device, or the other way", async () => {
    const env = await boot();
    try {
        const agent = new Uint8Array(randomBytes(32));
        await pairDevice(env.ws, env.core.devices.createAgentInvite("helper").uri, agent, "helper");
        assert.ok(env.db.getPin("helper"));
        await assert.rejects(pairDevice(env.ws, env.core.devices.createDeviceInvite().uri, agent, "phone"));
        assert.ok(!env.db.listDevices().some((d) => d.name === "phone"));

        const device = new Uint8Array(randomBytes(32));
        await pairDevice(env.ws, env.core.devices.createDeviceInvite().uri, device, "tablet");
        await assert.rejects(pairDevice(env.ws, env.core.devices.createAgentInvite("worker").uri, device, "worker"));
        assert.equal(env.db.getPin("worker"), null);
    } finally {
        await env.stop();
    }
});

test("a message that is not exactly one u16 frame, or any text frame, closes the socket", async () => {
    const env = await boot();
    try {
        const short = await dialRaw(env, pairPath(await invite(env)));
        short.send([new Uint8Array([0, 5, 1, 2])]);
        assert.equal(await short.next(), null);

        const two = await dialRaw(env, "/channel");
        two.send([new Uint8Array([0, 1, 9, 0, 1, 9])]);
        assert.equal(await two.next(), null);

        const text = await dialRaw(env, "/channel");
        text.ws.send("hello");
        assert.equal(await text.next(), null);
    } finally {
        await env.stop();
    }
});

test("pre-auth bounds: arrivals over the caps are refused, in-progress ones are kept", async () => {
    const perIp = await boot({ devices: { maxPreauthPerIp: 2 } });
    try {
        const path = pairPath(await invite(perIp));
        const one = await dialRaw(perIp, "/channel");
        const two = await dialRaw(perIp, path);
        await assert.rejects(dialRaw(perIp, "/channel"));
        assert.equal(one.closed || two.closed, false);
        one.ws.close();
        await waitFor(() => one.closed, 4000, "the first socket closed");
        // the slot is freed in the server's own close handler, a beat after the client sees the close
        let three: RawWire | null = null;
        for (let i = 0; i < 200 && three === null; i++) {
            three = await dialRaw(perIp, "/channel").catch(() => null);
        }
        assert.ok(three !== null && !three.closed, "the freed slot admits the next arrival");
    } finally {
        await perIp.stop();
    }
    const global = await boot({ devices: { maxPreauth: 1 } });
    try {
        const { s } = await activeDevice(global, "desk");
        const ready = await rawSession(global, s);
        assert.ok(ready);
        sendJson(ready, { t: "ping" });
        assert.deepEqual(await nextJson(ready), { t: "pong" });
        const held = await dialRaw(global, "/channel");
        await assert.rejects(dialRaw(global, "/channel/pair"));
        assert.equal(held.closed, false);
    } finally {
        await global.stop();
    }
});

test("pre-auth deadline closes a connection that never reaches ready", async () => {
    const env = await boot({ devices: { preauthDeadlineMs: 100 } });
    try {
        const idle = await dialRaw(env, "/channel");
        const t0 = Date.now();
        assert.equal(await idle.next(2000), null);
        assert.ok(Date.now() - t0 < 1500);
    } finally {
        await env.stop();
    }
});

test("a refusal written to a socket the peer already reset does not take the gateway down", async () => {
    const env = await boot({ devices: { maxPreauthPerIp: 0 } });
    try {
        // node hands an upgrade over with no 'error' listener, so the refusal must bring its own
        const req = { url: "/channel", headers: {}, socket: { remoteAddress: "10.0.0.1" } };
        const gone = new Socket();
        const closed = new Promise((r) => gone.once("close", r));
        assert.equal(env.core.handleUpgrade(req as unknown as IncomingMessage, gone, Buffer.alloc(0)), true);
        await closed;
        assert.equal((await fetch(`${env.base}/api/health`)).status, 200);
    } finally {
        await env.stop();
    }
});

test("the global pre-auth cap is fair: a flood from one address still admits another", async () => {
    const env = await boot({ devices: { maxPreauth: 2, preauthDeadlineMs: 4000 } });
    try {
        const flood = [await rawUpgrade(env.port, PROXIED), await rawUpgrade(env.port, PROXIED)];
        for (const f of flood) assert.match(f?.status ?? "", /^HTTP\/1\.1 101/);
        const mine = await rawUpgrade(env.port);
        assert.match(mine?.status ?? "", /^HTTP\/1\.1 101/);
        for (const f of [...flood, mine]) f?.sock.destroy();
    } finally {
        await env.stop();
    }
});

test("sessions are bounded: per device key the oldest gives way, and the gateway caps them in all", async () => {
    const env = await boot({ devices: { maxDeviceSessions: 2 } });
    try {
        const { s } = await activeDevice(env, "phone");
        const first = await rawSession(env, s);
        const second = await rawSession(env, s);
        assert.ok(first && second);
        const third = await rawSession(env, s);
        assert.ok(third);
        assert.equal(await first.frame(), null);
        sendJson(second, { t: "ping" });
        assert.deepEqual(await nextJson(second), { t: "pong" });
        sendJson(third, { t: "ping" });
        assert.deepEqual(await nextJson(third), { t: "pong" });
        second.ws.close();
        third.ws.close();
    } finally {
        await env.stop();
    }
    // two slots: the harness's own device session, and the one this test opens
    const total = await boot({ devices: { maxSessions: 2, preauthDeadlineMs: 4000 } });
    try {
        const { s } = await activeDevice(total, "phone");
        const live = await rawSession(total, s);
        assert.ok(live);
        // the one slot is an established session now, so there is no handshake left to give way
        const refused = await rawUpgrade(total.port);
        assert.match(refused?.status ?? "", /^HTTP\/1\.1 503/);
        refused?.sock.destroy();
        live.ws.close();
    } finally {
        await total.stop();
    }
});

test("the total cap evicts an anonymous handshake rather than lock a known device out", async () => {
    const env = await boot({ devices: { maxSessions: 2, maxPreauthPerIp: 64, preauthDeadlineMs: 4000 } });
    try {
        const flood = [await rawUpgrade(env.port, PROXIED), await rawUpgrade(env.port, PROXIED)];
        for (const f of flood) assert.match(f?.status ?? "", /^HTTP\/1\.1 101/);
        // every slot is held, all of them by handshakes that named nobody: the owner still gets in
        const mine = await rawUpgrade(env.port);
        assert.match(mine?.status ?? "", /^HTTP\/1\.1 101/);
        for (const f of [...flood, mine]) f?.sock.destroy();
    } finally {
        await env.stop();
    }
});

test("behind a proxy on this host, pre-auth slots are counted per X-Real-IP and apart from loopback's", async () => {
    const env = await boot({ devices: { maxPreauthPerIp: 2, preauthDeadlineMs: 4000 } });
    try {
        const held = [
            await rawUpgrade(env.port, PROXIED),
            await rawUpgrade(env.port, PROXIED),
            await rawUpgrade(env.port, "X-Real-IP: 2001:db8::7\r\n"),
            await rawUpgrade(env.port),
            await rawUpgrade(env.port),
        ];
        for (const h of held) assert.match(h?.status ?? "", /^HTTP\/1\.1 101/);
        const over = [await rawUpgrade(env.port, PROXIED), await rawUpgrade(env.port)];
        for (const o of over) assert.match(o?.status ?? "", /^HTTP\/1\.1 503/);
        for (const u of [...held, ...over]) u?.sock.destroy();
    } finally {
        await env.stop();
    }
});

test("a handshake flood through the proxy no longer locks a local agent out", async () => {
    const env = await boot({ devices: { preauthDeadlineMs: 4000 } });
    try {
        const flood: Array<{ sock: Socket; status: string } | null> = [];
        for (const client of ["203.0.113.7", "198.51.100.9"]) {
            const headers = `X-Real-IP: ${client}\r\n`;
            for (let i = 0; i < 9; i++) flood.push(await rawUpgrade(env.port, headers));
        }
        const held = [...Array<string>(8).fill("101"), "503"];
        assert.deepEqual(flood.map((f) => f?.status.split(" ")[1]), [...held, ...held]);
        await env.connect({ name: "helper" });
        await waitFor(() => env.core.registry.get("helper") !== undefined, 4000, "helper is registered");
        for (const f of flood) f?.sock.destroy();
    } finally {
        await env.stop();
    }
});

test("an X-Real-IP that is not exactly one address counts against the proxy's own slots", async () => {
    const env = await boot({ devices: { maxPreauthPerIp: 1, preauthDeadlineMs: 4000 } });
    try {
        const local = await rawUpgrade(env.port);
        assert.match(local?.status ?? "", /^HTTP\/1\.1 101/);
        for (const headers of [
            "X-Real-IP: 203.0.113.7, 198.51.100.9\r\n",
            "X-Real-IP: 203.0.113.7\r\nX-Real-IP: 198.51.100.9\r\n",
            "X-Real-IP: 203.0.113.7:4000\r\n",
            "X-Real-IP: [2001:db8::7]\r\n",
            "X-Real-IP: mimi.example\r\n",
            "X-Real-IP:\r\n",
        ]) {
            const refused = await rawUpgrade(env.port, headers);
            assert.match(refused?.status ?? "", /^HTTP\/1\.1 503/, headers);
            refused?.sock.destroy();
        }
        local?.sock.destroy();
    } finally {
        await env.stop();
    }
});

test("an X-Real-IP from a peer off this host is ignored", async () => {
    const env = await boot({ devices: { maxPreauthPerIp: 1, preauthDeadlineMs: 4000 } });
    // every peer of this listener reads as a LAN address, the way the --lan listener sees one
    const lan = createServer();
    lan.on("upgrade", (req: IncomingMessage, duplex: Duplex, head: Buffer) => {
        Object.defineProperty(req.socket, "remoteAddress", { value: "192.0.2.10" });
        env.core.handleUpgrade(req, duplex, head);
    });
    await new Promise<void>((ready) => lan.listen(0, "127.0.0.1", ready));
    try {
        const port = (lan.address() as AddressInfo).port;
        const first = await rawUpgrade(port, PROXIED);
        assert.match(first?.status ?? "", /^HTTP\/1\.1 101/);
        const second = await rawUpgrade(port, "X-Real-IP: 198.51.100.9\r\n");
        assert.match(second?.status ?? "", /^HTTP\/1\.1 503/);
        const local = await rawUpgrade(env.port);
        assert.match(local?.status ?? "", /^HTTP\/1\.1 101/);
        for (const u of [first, second, local]) u?.sock.destroy();
    } finally {
        lan.close();
        await env.stop();
    }
});

test("a stream-0 message that stops half-way closes the session instead of parking its buffers", async () => {
    const env = await boot({ devices: { preauthDeadlineMs: 500 } });
    try {
        const { s } = await activeDevice(env, "phone");
        const live = await rawSession(env, s);
        assert.ok(live);
        sendJson(live, { t: "ping" });
        assert.deepEqual(await nextJson(live), { t: "pong" });
        // one DATA frame, no END: the message never completes
        live.send(0, FLAG_DATA, new TextEncoder().encode('{"t":"pi'));
        assert.equal(await live.frame(), null);
    } finally {
        await env.stop();
    }
});

test("a stream-0 message cannot outlive its deadline by trickling frames, nor grow on empty ones", async () => {
    const env = await boot({ devices: { preauthDeadlineMs: 300 } });
    try {
        const { s } = await activeDevice(env, "phone");
        const live = await rawSession(env, s);
        assert.ok(live);
        // a frame every deadline/3: the deadline runs from the message's first frame, not its last
        const trickle = setInterval(() => live.send(0, FLAG_DATA, new Uint8Array(0)), 100);
        try {
            live.send(0, FLAG_DATA, new TextEncoder().encode('{"t":"pi'));
            assert.equal(await live.frame(), null);
        } finally {
            clearInterval(trickle);
        }

        const second = await rawSession(env, s);
        assert.ok(second);
        // empty frames are charged too, so the assembled ceiling ends this one as well
        for (let n = 0; n < 20_000 && !second.closed; n++) second.send(0, FLAG_DATA, new Uint8Array(0));
        assert.equal(await second.frame(), null);
    } finally {
        await env.stop();
    }
});

test("stream-0 ops: executed, byte-identical replay, conflict, out_of_order, wrong_epoch, post-commit revoke", async () => {
    let clock = 1_000_000;
    const env = await boot({ devices: { now: () => clock } });
    try {
        const { s, id } = await activeDevice(env, "main");
        const live = await rawSession(env, s);
        assert.ok(live);
        live.send(0, FLAG_DATA, new TextEncoder().encode('{"t":'));
        live.send(0, FLAG_RESET, new Uint8Array(0));
        sendJson(live, { t: "ping" });
        assert.deepEqual(await nextJson(live), { t: "pong" });
        sendJson(live, { t: "device_status" });
        assert.deepEqual(await nextJson(live), { t: "device_status", epoch: null, maxSeq: 0 });
        sendJson(live, { t: "epoch", epoch: "e1" });
        assert.deepEqual(await nextJson(live), { t: "device_status", epoch: "e1", maxSeq: 0 });
        sendJson(live, { t: "epoch", epoch: "e2" });
        assert.deepEqual(await nextJson(live), { t: "error", code: "rate_limited" });

        const listPayload = sendJson(live, { t: "op", seq: 1, epoch: "e1", kind: "devices.list", args: {} });
        const executed = await nextJson(live);
        assert.equal(executed?.["t"], "op_result");
        assert.equal(executed?.["status"], "executed");
        const listed = (executed?.["result"] as { devices: Array<{ id: string }> }).devices;
        assert.ok(listed.some((d) => d.id === id));

        live.send(0, FLAG_END, listPayload);
        const replay = await nextJson(live);
        assert.equal(replay?.["status"], "replay");
        assert.deepEqual(replay?.["result"], executed?.["result"]);

        sendJson(live, { t: "op", seq: 1, epoch: "e1", kind: "devices.list", args: { x: 1 } });
        assert.deepEqual(await nextJson(live), { t: "op_result", seq: 1, status: "conflict" });
        sendJson(live, { t: "op", seq: 3, epoch: "e1", kind: "devices.list", args: {} });
        assert.deepEqual(await nextJson(live), { t: "op_result", seq: 3, status: "out_of_order" });
        sendJson(live, { t: "op", seq: 2, epoch: "zz", kind: "devices.list", args: {} });
        assert.deepEqual(await nextJson(live), { t: "op_result", seq: 2, status: "wrong_epoch" });
        sendJson(live, { t: "op", seq: 2, epoch: "e1", kind: "devices.explode", args: {} });
        assert.deepEqual(await nextJson(live), { t: "error", code: "bad_op", seq: 2 });

        const { s: s2, id: id2 } = await activeDevice(env, "other");
        const other = await rawSession(env, s2);
        assert.ok(other);
        sendJson(live, { t: "op", seq: 2, epoch: "e1", kind: "devices.revoke", args: { id: id2 } });
        assert.deepEqual(await nextJson(live), { t: "op_result", seq: 2, status: "executed", result: { ok: true } });
        assert.equal(await other.frame(), null);
        sendJson(live, { t: "op", seq: 3, epoch: "e1", kind: "devices.revoke", args: { id: id2 } });
        const gone = await nextJson(live);
        assert.equal(gone?.["status"], "executed");
        assert.equal((gone?.["result"] as { ok: boolean }).ok, false);
        sendJson(live, { t: "device_status" });
        assert.deepEqual(await nextJson(live), { t: "device_status", epoch: "e1", maxSeq: 3 });

        clock += 61_000;
        sendJson(live, { t: "epoch", epoch: "e2" });
        assert.deepEqual(await nextJson(live), { t: "device_status", epoch: "e2", maxSeq: 0 });
        live.ws.close();
    } finally {
        await env.stop();
    }
});

test("sweep drops expired pending enrollments and closes their live sessions", async () => {
    let clock = Date.now();
    const env = await boot({ devices: { inactiveTtlMs: 0, now: () => clock } });
    try {
        const s = new Uint8Array(randomBytes(32));
        assert.ok(await pair(env, s, "stale"));
        const live = await rawSession(env, s);
        assert.ok(live);
        clock += 5_000;
        env.core.devices.sweep();
        assert.equal(await live.frame(), null);
        const rows = (await env.api<{ devices: Array<{ name: string }> }>("GET", "/api/devices")).json.devices;
        assert.ok(!rows.some((d) => d.name === "stale"));
    } finally {
        await env.stop();
    }
});

test("an agent invite is cancelled by id: gone from the list, and its URI no longer pairs", async () => {
    const env = await boot();
    try {
        const minted = await env.api<{ uri: string; id: string }>("POST", "/api/agent-invites", { name: "helper" });
        assert.equal(minted.status, 200);
        const { uri, id } = minted.json;

        assert.equal((await env.api("DELETE", `/api/agent-invites/${id}`)).status, 200);
        const listed = await env.api<{ invites: Array<{ id: string }> }>("GET", "/api/agent-invites");
        assert.deepEqual(listed.json.invites, []);
        assert.equal((await env.api("DELETE", `/api/agent-invites/${id}`)).status, 404, "a spent id is simply unknown");

        await assert.rejects(pairDevice(env.ws, uri, new Uint8Array(randomBytes(32)), "helper"));
        assert.equal(env.db.getPin("helper"), null);
    } finally {
        await env.stop();
    }
});

test("an invite whose debits run out is burned for everyone, not left listed and hanging", async () => {
    const env = await boot();
    try {
        const { uri } = env.core.devices.createAgentInvite("helper");
        const path = pairPath(uri);
        for (const name of ["a", "b", "c"]) {
            const wire = await dialRaw(env, path);
            wire.send(new PairingInitiator({ s: new Uint8Array(randomBytes(32)), uri, deviceName: name }).start());
            assert.ok(await wire.next(), `${name} spends a debit and is answered`);
        }
        const spent = await dialRaw(env, path);
        spent.send(new PairingInitiator({ s: new Uint8Array(randomBytes(32)), uri, deviceName: "d" }).start());
        assert.equal(await spent.next(), null, "the attempt past the debits is closed unanswered");

        assert.deepEqual(env.core.devices.listAgentInvites(), []);
        await assert.rejects(pairDevice(env.ws, uri, new Uint8Array(randomBytes(32)), "helper"));
        assert.equal(env.db.getPin("helper"), null);
    } finally {
        await env.stop();
    }
});

test("burning an invite destroys its responder's copies of the gateway key and the invite secret", async () => {
    const env = await boot();
    const destroy = PairingResponder.prototype.destroy;
    let destroyed = 0;
    PairingResponder.prototype.destroy = function (this: PairingResponder): void {
        destroyed++;
        destroy.call(this);
    };
    try {
        const { id } = env.core.devices.createAgentInvite("helper");
        assert.equal(env.core.devices.cancelAgentInvite(id), true);
        assert.equal(destroyed, 1, "a cancel");
        env.core.devices.createAgentInvite("helper");
        env.core.devices.createAgentInvite("helper");
        assert.equal(destroyed, 2, "a re-mint for the same name burns the previous invite");
        env.core.devices.createDeviceInvite();
        await env.core.stop();
        assert.equal(destroyed, 4, "stop burns every invite still open");
    } finally {
        PairingResponder.prototype.destroy = destroy;
        await env.stop();
    }
});

test("an agent key holds one channel session: each newer handshake replaces the older one, and the log says so", async () => {
    const env = await boot();
    try {
        const s = new Uint8Array(randomBytes(32));
        await pairDevice(env.ws, env.core.devices.createAgentInvite("greedy").uri, s, "greedy");
        const held: RawSession[] = [];
        for (let i = 0; i < 6; i++) {
            const live = await rawSession(env, s);
            assert.ok(live, `handshake ${i} reached ready`);
            held.push(live);
        }
        const latest = held.pop()!;
        for (const older of held) assert.equal(await older.frame(), null, "an older session is gone");
        assert.equal(latest.closed, false);
        const replaced = env.logs.filter((l) => l === "[channel] agent greedy: a newer connection replaced the previous one\n");
        assert.equal(replaced.length, 5);
        latest.ws.close();
    } finally {
        await env.stop();
    }
});

test("agents never take the slots kept for devices: a new agent is turned away, the owner still gets in", async () => {
    // 18 slots, 16 of them kept for devices: agents share the other two
    const env = await boot({ devices: { maxSessions: 18 } });
    try {
        const keys = new Map<string, Uint8Array>();
        for (const name of ["one", "two", "three"]) {
            const s = new Uint8Array(randomBytes(32));
            await pairDevice(env.ws, env.core.devices.createAgentInvite(name).uri, s, name);
            keys.set(name, s);
        }
        const one = await rawSession(env, keys.get("one")!);
        const two = await rawSession(env, keys.get("two")!);
        assert.ok(one && two);
        assert.deepEqual(await refusal(env, keys.get("three")!), [1000, ""], "a third agent is refused at the lookup, for room, not as unpaired");
        const again = await rawSession(env, keys.get("one")!);
        assert.ok(again, "an agent already inside may still replace its own session");
        assert.equal(await one.frame(), null);
        assert.equal((await env.api("GET", "/api/pins")).status, 200, "the owner's device pairs, connects and is served");
        two.ws.close();
        again.ws.close();
    } finally {
        await env.stop();
    }
});

test("an unknown invite on /channel/pair is dropped at once: no socket waits out a close timeout on its buffers", async () => {
    const env = await boot();
    try {
        const size = 1_040_000;
        const t0 = Date.now();
        const closedAfter = await Promise.all(
            Array.from(
                { length: 20 },
                () =>
                    new Promise<number>((resolve) => {
                        const sock = connect(env.port, "127.0.0.1");
                        const giveUp = setTimeout(() => {
                            sock.destroy();
                            resolve(Infinity);
                        }, 4000);
                        sock.on("error", () => undefined);
                        sock.once("data", (d: Buffer) => {
                            if (!d.toString("latin1").startsWith("HTTP/1.1 101")) return;
                            // one masked binary frame a byte short: it can only ever sit in the receive buffer
                            const head = Buffer.alloc(14);
                            head[0] = 0x82;
                            head[1] = 0x80 | 127;
                            head.writeBigUInt64BE(BigInt(size), 2);
                            sock.write(head);
                            sock.write(randomBytes(size - 1));
                        });
                        sock.on("close", () => {
                            clearTimeout(giveUp);
                            resolve(Date.now() - t0);
                        });
                        sock.write(
                            "GET /channel/pair?invite=AAAAAAAAAA HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n" +
                                "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
                        );
                    }),
            ),
        );
        assert.ok(closedAfter.every((ms) => ms < 2000), `closed after ${closedAfter.join(", ")} ms`);
    } finally {
        await env.stop();
    }
});

test("redeeming an agent invite announces agent_enrolled; a redemption under the wrong name announces nothing", async () => {
    const env = await boot();
    try {
        const seen: HubEvent[] = [];
        env.core.events.subscribe((ev) => {
            if (ev.type === "agent_enrolled") seen.push(ev);
        });
        const invite = (): string => env.core.devices.createAgentInvite("helper").uri;
        await assert.rejects(pairDevice(env.ws, invite(), new Uint8Array(randomBytes(32)), "impostor"));
        assert.deepEqual(seen, []);
        await pairDevice(env.ws, invite(), new Uint8Array(randomBytes(32)), "helper");
        assert.deepEqual(seen, [{ type: "agent_enrolled", agent: "helper" }]);
        // a fresh key redeemed for a name that already has a pin is an enrolment too
        await pairDevice(env.ws, invite(), new Uint8Array(randomBytes(32)), "helper");
        assert.equal(seen.length, 2);
    } finally {
        await env.stop();
    }
});
