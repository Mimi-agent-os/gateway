/** Channel access over real sockets: invite TTLs, stream-0 framing, device names, code-mode SAS, agent key recovery, the /mini-app door. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { allPerms, ClientSession, FLAG_END, noPerms, PROTOCOL_VERSION, type ChannelStreamFrame } from "@mimi-os/protocol";

import { createGatewayCore, type GatewayCore } from "../src/core.ts";
import type { HubEvent } from "../src/events.ts";
import { channelUpgradeHandler, loopbackHandler } from "../src/http/listeners.ts";
import { GatewayDb } from "../src/store/db.ts";
import { dialChannel, pairDevice } from "../src/device-client.ts";
import { waitFor } from "./harness-env.ts";

interface Env {
    core: GatewayCore;
    db: GatewayDb;
    ws: string;
    events: HubEvent[];
    clock: { now: number };
    stop(): Promise<void>;
}

async function boot(): Promise<Env> {
    const dir = mkdtempSync(join(tmpdir(), "mimi-access-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    const clock = { now: 1_000_000 };
    const core = createGatewayCore({
        db,
        log: () => undefined,
        devices: { keyFile: join(dir, ".channel.key"), now: () => clock.now },
    });
    const server = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const listening = (server.address() as AddressInfo).port;
    server.on(
        "upgrade",
        channelUpgradeHandler((req, duplex, head) => core.handleUpgrade(req, duplex, head)),
    );
    const events: HubEvent[] = [];
    core.events.subscribe((ev) => void events.push(ev));
    return {
        core,
        db,
        ws: `ws://127.0.0.1:${listening}`,
        events,
        clock,
        stop: async () => {
            await core.stop();
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

const key = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

test("an agent invite lives 24 h: still redeemable after 120 s, a device invite is not", async () => {
    const env = await boot();
    try {
        const agent = env.core.devices.createAgentInvite("mate");
        assert.equal(agent.expiresAt - env.clock.now, 24 * 3_600_000);
        const device = env.core.devices.createDeviceInvite();
        assert.equal(device.expiresAt - env.clock.now, 120_000);
        env.clock.now += 121_000;
        await pairDevice(env.ws, agent.uri, key(), "mate");
        // admitted (the owner minted the invite) but CLOSED: the operator grants perms in the pult
        assert.equal(env.db.getPin("mate")?.status, "approved");
        assert.deepEqual(env.db.getPin("mate")?.perms, noPerms());
        await assert.rejects(pairDevice(env.ws, device.uri, key(), "late"));
    } finally {
        await env.stop();
    }
});

test("stream-0 control replies complete a message with FLAG_END", async () => {
    const env = await boot();
    try {
        const s = key();
        const { gatewayPub } = await pairDevice(env.ws, env.core.devices.createLocalInvite().uri, s, "console");
        const session = new ClientSession({ s, gatewayPub, protocol: PROTOCOL_VERSION });
        const ws = new WebSocket(`${env.ws}/channel`);
        ws.binaryType = "arraybuffer";
        const frames: ChannelStreamFrame[] = [];
        ws.onopen = () => {
            for (const chunk of session.start()) ws.send(chunk);
        };
        ws.onmessage = (ev) => {
            const { out, events } = session.feed(new Uint8Array(ev.data as ArrayBuffer));
            for (const chunk of out) ws.send(chunk);
            for (const event of events) {
                if (event.type === "ready") {
                    const ping = new TextEncoder().encode(JSON.stringify({ t: "ping" }));
                    for (const chunk of session.send({ stream: 0, flags: FLAG_END, payload: ping })) ws.send(chunk);
                } else if (event.type === "frame") frames.push(event.frame);
            }
        };
        await waitFor(() => frames.length > 0);
        assert.equal(frames[0]?.stream, 0);
        assert.equal(frames[0]?.flags, FLAG_END);
        assert.deepEqual(JSON.parse(new TextDecoder().decode(frames[0]?.payload)), { t: "pong" });
        ws.close();
    } finally {
        await env.stop();
    }
});

test("a device name keeps its spaces and hyphens, only control characters go", async () => {
    const env = await boot();
    try {
        await pairDevice(env.ws, env.core.devices.createDeviceInvite().uri, key(), "Browser on Linux x86_64 -dev");
        assert.equal(env.core.devices.list()[0]?.name, "Browser on Linux x86_64 -dev");
    } finally {
        await env.stop();
    }
});

test("code mode never shows the SAS; tap mode does", async () => {
    const env = await boot();
    try {
        const tap = await pairDevice(env.ws, env.core.devices.createDeviceInvite().uri, key(), "tap-pad");
        assert.ok(env.db.listInbox().items.some((i) => i.body === `Code: ${tap.sas.slice(0, 3)}-${tap.sas.slice(3)}`));
        assert.equal(env.core.devices.list()[0]?.sas, tap.sas);

        env.core.devices.setApproveMode("code");
        const code = await pairDevice(env.ws, env.core.devices.createDeviceInvite().uri, key(), "code-pad");
        const newest = env.db.listInbox().items[0];
        assert.equal(newest?.title, "New device awaiting approval: code-pad");
        assert.ok(!newest?.body.includes(code.sas.slice(3)));
        assert.ok(env.core.devices.list().every((d) => d.sas === ""));
        const enrolled = env.events.filter((e) => e.type === "device_enrolled");
        assert.equal(enrolled.at(-1)?.["sas"], "");
        const pending = env.core.devices.list().find((d) => d.name === "code-pad");
        assert.equal(env.core.devices.approve(pending?.id ?? "", code.sas).ok, true);
    } finally {
        await env.stop();
    }
});

test("re-inviting an agent swaps only its key and ends every session of the old key", async () => {
    const env = await boot();
    try {
        const oldKey = key();
        const { gatewayPub } = await pairDevice(env.ws, env.core.devices.createAgentInvite("mate").uri, oldKey, "mate");
        // the operator has since granted rights: recovery must swap the key without resetting them
        env.db.setPinPerms("mate", allPerms());
        const old = dialChannel(`${env.ws}/channel`, oldKey, gatewayPub);
        await old.ready;

        await pairDevice(env.ws, env.core.devices.createAgentInvite("mate").uri, key(), "mate");
        await waitFor(() => old.ws.readyState === WebSocket.CLOSED);
        const pin = env.db.getPin("mate");
        assert.equal(pin?.status, "approved");
        assert.deepEqual(pin?.perms, allPerms());

        env.db.setPinStatus("mate", "blocked", noPerms());
        await pairDevice(env.ws, env.core.devices.createAgentInvite("mate").uri, key(), "mate");
        assert.equal(env.db.getPin("mate")?.status, "blocked");
    } finally {
        await env.stop();
    }
});

test("an agent re-pair cannot claim another agent's key", async () => {
    const env = await boot();
    try {
        const identity = key();
        await pairDevice(env.ws, env.core.devices.createAgentInvite("owner").uri, identity.slice(), "owner");
        const ownerKey = env.db.getPin("owner")?.pubkey;

        await assert.rejects(pairDevice(env.ws, env.core.devices.createAgentInvite("claimant").uri, identity.slice(), "claimant"));
        assert.equal(env.db.getPin("owner")?.pubkey, ownerKey);
        assert.equal(env.db.getPin("claimant"), null);
    } finally {
        await env.stop();
    }
});

function raw(port: number, text: string): Promise<string> {
    return new Promise((done, fail) => {
        const socket = connect(port, "127.0.0.1");
        let got = "";
        socket.on("connect", () => socket.write(text));
        socket.on("data", (c: Buffer) => (got += String(c)));
        socket.on("close", () => done(got));
        socket.on("error", fail);
        setTimeout(() => socket.destroy(), 1500).unref();
    });
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    return (server.address() as AddressInfo).port;
}

test("the /mini-app door answers only requests addressed to this very listener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mimi-access-apps-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    const core = createGatewayCore({ db, log: () => undefined, devices: { keyFile: join(dir, ".channel.key") } });
    const server = createServer();
    const elsewhere = createServer((req, res) => res.end(`OTHER ${req.url}`));
    try {
        const port = await listen(server);
        const other = await listen(elsewhere);
        server.on("request", loopbackHandler(core, { host: "127.0.0.1", port }));
        const line = (target: string, host: string): string =>
            `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;

        // the door is reached at every loopback name the owner may have typed, and refuses there
        // only for want of a session — that page is what says the Host itself was accepted
        for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
            const answer = await raw(port, line("/mini-app/mate/ok", host));
            assert.match(answer, /^HTTP\/1\.1 403/, host);
            assert.match(answer, /Relaunch this interface from the mimi app/, host);
        }
        // DNS rebinding, and this listener's own path on another port: neither is addressed here
        for (const host of [`rebind.evil.example:${port}`, `127.0.0.1:${other}`]) {
            const answer = await raw(port, line("/mini-app/mate/ok", host));
            assert.match(answer, /^HTTP\/1\.1 403/, host);
            assert.match(answer, /not addressed to this app/, host);
        }
        // an absolute or scheme-relative request line would name another origin entirely
        for (const target of [`//127.0.0.1:${other}/mini-app/mate/ok`, `http://127.0.0.1:${other}/mini-app/mate/ok`]) {
            const answer = await raw(port, line(target, `127.0.0.1:${port}`));
            assert.match(answer, /^HTTP\/1\.1 403/, target);
            assert.doesNotMatch(answer, /OTHER/, target);
        }
        // the app id is the anchored agent-name charset, checked before any catalog lookup
        assert.match(await raw(port, line("/mini-app/MATE/ok", `127.0.0.1:${port}`)), /^HTTP\/1\.1 404/);
        // a service worker registered from ANY script of this origin would outlive its session
        assert.match(
            await raw(port, `GET /app/assets/x.js HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nSec-Fetch-Dest: serviceworker\r\nConnection: close\r\n\r\n`),
            /^HTTP\/1\.1 403/,
        );
    } finally {
        await core.stop();
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        elsewhere.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
