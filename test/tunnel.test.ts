import "./pq-home.ts";

/** Channel tunnels over a real active device session: raw api streams, stream bounds, and the cleanup a revoke or RESET runs. */
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";

import {
    APP_CHUNK,
    APP_CREDIT,
    APP_PATH_MAX,
    DEVICE_CREDIT,
    DEVICE_WINDOW,
    FLAG_DATA,
    FLAG_END,
    FLAG_RESET,
    type ChannelStreamFrame,
} from "@mimi-os/protocol";

import { connectRawAgent, nextFrame, nextRequest, replyFrame } from "./agent-wire.ts";
import { rawSession, type RawSession } from "./channel-client.ts";
import { activeDevice, boot, connectAppAgent, waitFor, type Env } from "./harness-env.ts";

type Device = RawSession & { id: string };

async function activeSession(env: Env): Promise<Device> {
    const { s, id } = await activeDevice(env, "tunnel");
    const d = await rawSession(env, s);
    assert.ok(d && !d.pending);
    return Object.assign(d, { id });
}

function request(d: Device, stream: number, header: unknown, body?: Uint8Array | string, end = true): void {
    d.send(stream, FLAG_DATA, Buffer.from(JSON.stringify(header)));
    if (body !== undefined) d.send(stream, FLAG_DATA, typeof body === "string" ? Buffer.from(body) : body);
    if (end) d.send(stream, FLAG_END);
}

interface Answer {
    head: { t: string; status: number; headers: Record<string, string | string[]> };
    headBytes: Uint8Array;
    body: Buffer;
    end: "END" | "RESET";
}

async function answer(d: Device, stream: number): Promise<Answer> {
    const first = await d.frame(stream);
    assert.ok(first && first.flags === FLAG_DATA, "head frame");
    const chunks: Buffer[] = [];
    for (;;) {
        const f = await d.frame(stream);
        assert.ok(f, "session closed mid-answer");
        if (f.flags === FLAG_DATA) chunks.push(Buffer.from(f.payload));
        else
            return {
                head: JSON.parse(Buffer.from(first.payload).toString("utf8")) as Answer["head"],
                headBytes: first.payload,
                body: Buffer.concat(chunks),
                end: f.flags === FLAG_END ? "END" : "RESET",
            };
    }
}

/** A grant is an ordinary reply: a 200 head, then its JSON body. */
async function grant(d: Device, stream: number, appId = "shop"): Promise<string> {
    request(d, stream, { t: "app_grant", appId });
    const granted = await answer(d, stream);
    assert.equal(granted.head.status, 200);
    assert.equal(granted.end, "END");
    return (JSON.parse(granted.body.toString("utf8")) as { credential: string }).credential;
}

test("api: GET matches another tunnel's answer, POST carries its body, refused paths and upgrades", async () => {
    const env = await boot();
    try {
        const d = await activeSession(env);
        request(d, 1, { t: "api", method: "GET", path: "/api/agents" });
        const agents = await answer(d, 1);
        assert.equal(agents.head.t, "head");
        assert.equal(agents.head.status, 200);
        assert.equal(agents.end, "END");
        const direct = await env.api("GET", "/api/agents");
        assert.deepEqual(JSON.parse(agents.body.toString("utf8")), direct.json);

        request(d, 3, { t: "api", method: "POST", path: "/api/devices/settings", headers: { "content-type": "application/json" } }, JSON.stringify({ approveMode: "code" }));
        const posted = await answer(d, 3);
        assert.equal(posted.head.status, 200);
        assert.deepEqual(JSON.parse(posted.body.toString("utf8")), { approveMode: "code" });
        assert.deepEqual((await env.api("GET", "/api/devices/settings")).json, { approveMode: "code" });

        // neither /app/* nor the loopback-only bootstrap route is reachable over the tunnel
        for (const [stream, path] of [
            [5, "/app/index.html"],
            [7, "/local/invite"],
        ] as const) {
            request(d, stream, { t: "api", method: "GET", path }, "{}");
            const refused = await answer(d, stream);
            assert.equal(refused.head.status, 403, path);
            assert.equal(refused.end, "END");
        }
        request(d, 13, { t: "api", method: "GET", path: "/api/events", headers: { Upgrade: "websocket" } });
        assert.equal((await answer(d, 13)).head.status, 501);

        request(d, 15, { t: "api", method: "GET", path: "/api/nope" });
        assert.equal((await answer(d, 15)).head.status, 404);

        d.send(17, FLAG_DATA, Buffer.from("not json"));
        assert.equal((await d.frame(17))?.flags, FLAG_RESET);
        d.ws.close();
    } finally {
        await env.stop();
    }
});

test("api: ndjson events stream incrementally, and a RESET mid-stream runs the route cleanup", async () => {
    const env = await boot();
    try {
        const d = await activeSession(env);
        const before = env.core.events.size();
        request(d, 1, { t: "api", method: "GET", path: "/api/events" });
        const head = await d.frame(1);
        assert.ok(head);
        const parsed = JSON.parse(Buffer.from(head.payload).toString("utf8")) as Answer["head"];
        assert.equal(parsed.status, 200);
        assert.match(String(parsed.headers["content-type"]), /application\/x-ndjson/);
        const ready = await d.frame(1);
        assert.equal(ready?.flags, FLAG_DATA);
        assert.equal((JSON.parse(Buffer.from(ready.payload).toString("utf8")) as { type: string }).type, "ready");
        assert.equal(env.core.events.size(), before + 1);

        env.core.events.emit({ type: "usage_changed", agent: "toto" });
        const live = await d.frame(1);
        assert.equal(live?.flags, FLAG_DATA);
        assert.equal((JSON.parse(Buffer.from(live.payload).toString("utf8")) as { agent: string }).agent, "toto");

        d.send(1, FLAG_RESET);
        await waitFor(() => env.core.events.size() === before);
        env.core.events.emit({ type: "usage_changed", agent: "after" });
        request(d, 3, { t: "api", method: "GET", path: "/api/devices/settings" });
        assert.equal((await answer(d, 3)).head.status, 200);
        assert.equal(d.queued(1), 0);
        d.ws.close();
    } finally {
        await env.stop();
    }
});

test("data after the client END resets the stream and runs its cleanup", async () => {
    const env = await boot();
    try {
        const d = await activeSession(env);
        const before = env.core.events.size();
        request(d, 1, { t: "api", method: "GET", path: "/api/events" });
        assert.equal((await d.frame(1))?.flags, FLAG_DATA);
        assert.equal((await d.frame(1))?.flags, FLAG_DATA);
        await waitFor(() => env.core.events.size() === before + 1);

        d.send(1, FLAG_DATA, Buffer.from("after end"));
        assert.equal((await d.frame(1))?.flags, FLAG_RESET);
        await waitFor(() => env.core.events.size() === before);
        d.ws.close();
    } finally {
        await env.stop();
    }
});

test("bounds: the 65th concurrent stream and a body over 256 KiB are RESET", async () => {
    const env = await boot();
    try {
        const d = await activeSession(env);
        for (let i = 0; i < 64; i++) {
            request(d, 1 + i * 2, { t: "api", method: "POST", path: "/api/devices/settings" }, undefined, false);
        }
        request(d, 201, { t: "api", method: "POST", path: "/api/devices/settings" }, undefined, false);
        assert.equal((await d.frame(201))?.flags, FLAG_RESET);

        d.send(1, FLAG_DATA, Buffer.from(JSON.stringify({ approveMode: "tap" })));
        d.send(1, FLAG_END);
        const first = await answer(d, 1);
        assert.equal(first.head.status, 200);
        for (let i = 1; i < 64; i++) d.send(1 + i * 2, FLAG_RESET);

        request(d, 301, { t: "api", method: "GET", path: "/api/agents" }, undefined, false);
        assert.equal((await answer(d, 301)).end, "END");
        const chunk = new Uint8Array(16 * 1024);
        for (let i = 0; i < 17; i++) d.send(301, FLAG_DATA, chunk);
        assert.equal((await d.frame(301))?.flags, FLAG_RESET);
        d.ws.close();
    } finally {
        await env.stop();
    }
});

test("revoke: in-flight api and app streams die with the session, and the grants are deleted", async () => {
    const env = await boot();
    // answers every request with a head and never ends the body — enough to hold an app stream open
    let upClosed = 0;
    const up: Server = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("started");
        res.on("close", () => upClosed++);
    });
    await new Promise<void>((ready) => up.listen(0, "127.0.0.1", ready));
    const upAddr = up.address();
    if (upAddr === null || typeof upAddr === "string") throw new Error("no address");
    try {
        await connectAppAgent(env, "shop", `http://127.0.0.1:${upAddr.port}`);
        const d = await activeSession(env);
        const before = env.core.events.size();

        const credential = await grant(d, 1);

        request(d, 3, { t: "api", method: "GET", path: "/api/events" });
        assert.equal((await d.frame(3))?.flags, FLAG_DATA);
        await waitFor(() => env.core.events.size() === before + 1);
        request(d, 5, { t: "app", appId: "shop", credential, method: "GET", path: "/" });
        assert.equal((await d.frame(5))?.flags, FLAG_DATA);

        assert.deepEqual((await env.api("POST", `/api/devices/${d.id}/revoke`)).json, { ok: true });
        for (;;) if ((await d.frame(3)) === null) break;
        for (;;) if ((await d.frame(5)) === null) break;
        await waitFor(() => env.core.events.size() === before);
        await waitFor(() => upClosed === 1);
        assert.equal(env.db.getDeviceAppGrant(d.id, "shop"), null);
    } finally {
        await env.stop();
        up.closeAllConnections();
        await new Promise<void>((done) => up.close(() => done()));
    }
});

test("miniapp streams are gated on the agent's pin: no pin mints no grant, and a block stops a grant already held", async () => {
    const env = await boot();
    // one route answers and ends; /live streams until the gateway cuts it off
    const live = new Set<ServerResponse>();
    const up: Server = createServer((req, res) => {
        req.resume();
        if (req.url?.endsWith("/live")) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write("data: tick\n\n");
            live.add(res);
            res.on("close", () => live.delete(res));
            return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("app");
    });
    await new Promise<void>((ready) => up.listen(0, "127.0.0.1", ready));
    const upAddr = up.address();
    if (upAddr === null || typeof upAddr === "string") throw new Error("no address");
    try {
        const upstream = `http://127.0.0.1:${upAddr.port}`;
        // a catalog row with no pin and no live agent: the door refuses it before the bridge
        env.db.upsertAgentApp({ agent: "ghost", appId: "ghost", title: "Ghost", upstream });
        // a base path in the upstream is what makes a path escape possible at all
        await connectAppAgent(env, "shop", `${upstream}/base`);
        const d = await activeSession(env);

        // a catalog row whose agent has no pin at all is not an app anyone may open
        request(d, 1, { t: "app_grant", appId: "ghost" });
        assert.equal((await answer(d, 1)).head.status, 403);

        const credential = await grant(d, 3);
        request(d, 5, { t: "app", appId: "shop", credential, method: "GET", path: "/" });
        const served = await answer(d, 5);
        assert.equal(served.head.status, 200);
        assert.equal(served.body.toString("utf8"), "app");

        // the agent owns the check that a path stays inside its own prefix; this door renders its
        // refusal as the Forbidden it has always answered, not as the browser door's 404
        request(d, 13, { t: "app", appId: "shop", credential, method: "GET", path: "/../secret" });
        assert.equal((await answer(d, 13)).head.status, 403);

        // the outbound caps are the bridge's, so this door renders them from its own reason table
        request(d, 15, { t: "app", appId: "shop", credential, method: "GET", path: `/${"a".repeat(APP_PATH_MAX)}` });
        const long = await answer(d, 15);
        assert.equal(long.head.status, 414);
        assert.equal(long.body.toString("utf8"), "URI Too Long");

        // an answer already in flight when the pin goes is cut off with it, not left forwarding
        request(d, 11, { t: "app", appId: "shop", credential, method: "GET", path: "/live" });
        const opened = await d.frame(11);
        assert.equal(JSON.parse(Buffer.from(opened!.payload).toString("utf8"))["status"], 200);
        await waitFor(() => live.size === 1, 4000, "the streaming upstream");

        // the grant row outlives the block; the stream must not
        assert.equal((await env.api("POST", "/api/pins/shop/block")).status, 200);
        await waitFor(() => live.size === 0, 4000, "the in-flight stream and its upstream are dropped");
        assert.ok(env.db.getDeviceAppGrant(d.id, "shop"), "the grant is still on disk");
        request(d, 7, { t: "app", appId: "shop", credential, method: "GET", path: "/" });
        assert.equal((await answer(d, 7)).head.status, 403);
        request(d, 9, { t: "app_grant", appId: "shop" });
        assert.equal((await answer(d, 9)).head.status, 403);
        d.ws.close();
    } finally {
        await env.stop();
        up.closeAllConnections();
        await new Promise<void>((done) => up.close(() => done()));
    }
});

test("a device that resets the stream it stopped reading loses the connection, not just the stream", async () => {
    // the bytes already handed to the socket outlive the stream object that counted them
    const env = await boot({ devices: { streamStallMs: 400 } });
    const chunk = Buffer.alloc(64 * 1024, 7);
    const up: Server = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const pump = (): void => {
            while (res.write(chunk)) if (res.writableLength > 8 * 1024 * 1024) return;
            res.once("drain", pump);
        };
        pump();
    });
    await new Promise<void>((ready) => up.listen(0, "127.0.0.1", ready));
    const upAddr = up.address();
    if (upAddr === null || typeof upAddr === "string") throw new Error("no address");
    try {
        await connectAppAgent(env, "shop", `http://127.0.0.1:${upAddr.port}`);
        const d = await activeSession(env);
        const credential = await grant(d, 1);

        d.pause();
        // every round parks an answer for a peer that is not reading and then throws the stream
        // away: the bytes the socket still holds outlive the stream object that counted them
        for (let stream = 3; stream < 43 && !d.closed; stream += 2) {
            request(d, stream, { t: "app", appId: "shop", credential, method: "GET", path: "/big" });
            await new Promise((r) => setTimeout(r, 100));
            d.send(stream, FLAG_RESET);
        }
        await waitFor(() => d.closed, 6000, "the connection that stopped reading is dropped");
    } finally {
        await env.stop();
        up.closeAllConnections();
        await new Promise<void>((done) => up.close(() => done()));
    }
});

test("an app answer a device stops reading is paused at its window, then reset with its upstream", async () => {
    // a stall deadline in ms, so the reset this asserts does not wait the production 30 s out
    const env = await boot({ apps: { stallMs: 400 } });
    const TOTAL = 64 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 7);
    let written = 0;
    let upClosed = 0;
    // an upstream that honours backpressure: `written` is what the gateway has taken off it
    const up: Server = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "application/octet-stream" });
        let dead = false;
        res.on("close", () => {
            dead = true;
            upClosed++;
        });
        const pump = (): void => {
            while (!dead && written < TOTAL) {
                written += chunk.length;
                if (!res.write(chunk)) {
                    res.once("drain", pump);
                    return;
                }
            }
            if (!dead) res.end();
        };
        pump();
    });
    await new Promise<void>((ready) => up.listen(0, "127.0.0.1", ready));
    const upAddr = up.address();
    if (upAddr === null || typeof upAddr === "string") throw new Error("no address");
    try {
        await connectAppAgent(env, "shop", `http://127.0.0.1:${upAddr.port}`, { handlers: { ping: { text: "pong" } } });
        const d = await activeSession(env);
        const credential = await grant(d, 1);

        d.pause();
        request(d, 3, { t: "app", appId: "shop", credential, method: "GET", path: "/big" });
        await waitFor(() => written > 0, 4000, "the upstream started answering");
        // the agent's socket is never paused: its stream 0 answers while this stream is wedged
        const peer = env.core.registry.get("shop");
        assert.ok(peer);
        assert.deepEqual(await peer.request("invoke", { tool: "ping", args: {} }), { text: "pong" });
        await waitFor(() => upClosed === 1, 6000, "the stalled stream is reset and its upstream destroyed");
        assert.ok(written < TOTAL / 2, `the producer was paused, not drained into memory (wrote ${written})`);
        d.ws.terminate();
    } finally {
        await env.stop();
        up.closeAllConnections();
        await new Promise<void>((done) => up.close(() => done()));
    }
});

/** Every frame that arrives on `stream` within `ms` of quiet, in order. */
async function drain(d: Device, stream: number, ms = 300): Promise<ChannelStreamFrame[]> {
    const got: ChannelStreamFrame[] = [];
    for (;;) {
        const f = await d.frame(stream, ms).catch(() => undefined);
        if (f === undefined || f === null) return got;
        got.push(f);
        if (f.flags !== FLAG_DATA) return got;
    }
}

const bytesOf = (frames: ChannelStreamFrame[]): number => frames.reduce((n, f) => n + f.payload.length, 0);

test("app_grant is an ordinary reply: a 200 head with a JSON body, and a second grant retires the first credential", async () => {
    const env = await boot();
    const up: Server = createServer((req, res) => {
        req.resume();
        res.end("app");
    });
    await new Promise<void>((ready) => up.listen(0, "127.0.0.1", ready));
    try {
        await connectAppAgent(env, "shop", `http://127.0.0.1:${(up.address() as { port: number }).port}`);
        const d = await activeSession(env);
        request(d, 1, { t: "app_grant", appId: "shop" });
        const granted = await answer(d, 1);
        assert.equal(granted.head.status, 200);
        assert.equal(granted.head.headers["content-type"], "application/json; charset=utf-8");
        assert.equal(granted.head.headers["cache-control"], "no-store");
        assert.equal(granted.head.headers["content-length"], String(granted.body.length));
        const first = JSON.parse(granted.body.toString("utf8")) as Record<string, string>;
        assert.deepEqual(Object.keys(first).sort(), ["appId", "credential"]);
        assert.equal(first["appId"], "shop");
        assert.equal(Buffer.from(first["credential"] ?? "", "base64").length, 32);

        const second = await grant(d, 3);
        assert.notEqual(second, first["credential"]);
        request(d, 5, { t: "app", appId: "shop", credential: first["credential"], method: "GET", path: "/" });
        assert.equal((await answer(d, 5)).head.status, 403, "the old credential is gone");
        request(d, 7, { t: "app", appId: "shop", credential: second, method: "GET", path: "/" });
        assert.equal((await answer(d, 7)).head.status, 200);
        d.ws.close();
    } finally {
        await env.stop();
        up.closeAllConnections();
        await new Promise<void>((done) => up.close(() => done()));
    }
});

test("reply credit: the gateway stops at DEVICE_WINDOW, a credit after the device's END sends one quantum more, and a late one is dropped", async () => {
    const env = await boot();
    const TOTAL = 2 * 1024 * 1024;
    const up: Server = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.alloc(TOTAL, 9));
    });
    await new Promise<void>((ready) => up.listen(0, "127.0.0.1", ready));
    try {
        await connectAppAgent(env, "shop", `http://127.0.0.1:${(up.address() as { port: number }).port}`);
        const d = await activeSession(env);
        const credential = await grant(d, 1);
        request(d, 3, { t: "app", appId: "shop", credential, method: "GET", path: "/big" });
        assert.equal((await d.frame(3))?.flags, FLAG_DATA, "the head");
        let got = 0;
        while (got < DEVICE_WINDOW) got += (await d.frame(3))!.payload.length;
        got += bytesOf(await drain(d, 3));
        assert.ok(got < DEVICE_WINDOW + APP_CHUNK, `one window and no more before any credit: ${got}`);

        // the device ended its request long ago: this credit is still credit, not a violation
        d.send(3, FLAG_DATA);
        const more: ChannelStreamFrame[] = [];
        while (got + bytesOf(more) < DEVICE_WINDOW + DEVICE_CREDIT - APP_CHUNK) more.push((await d.frame(3))!);
        more.push(...(await drain(d, 3)));
        assert.ok(more.every((f) => f.flags === FLAG_DATA), "no RESET for a credit after END");
        got += bytesOf(more);
        assert.ok(got < DEVICE_WINDOW + DEVICE_CREDIT + APP_CHUNK, `one quantum more: ${got}`);

        // a reader that credits each quantum it took
        let acked = DEVICE_CREDIT;
        let ended = false;
        while (!ended) {
            for (; got - acked >= DEVICE_CREDIT; acked += DEVICE_CREDIT) d.send(3, FLAG_DATA);
            const f = await d.frame(3);
            assert.ok(f && f.flags !== FLAG_RESET);
            got += f.payload.length;
            ended = f.flags === FLAG_END;
        }
        assert.equal(got, TOTAL);

        // both sides ended stream 3: a credit for it now, or for an id never opened, opens nothing
        d.send(3, FLAG_DATA);
        d.send(99, FLAG_DATA);
        request(d, 5, { t: "app", appId: "shop", credential, method: "GET", path: "/big" });
        assert.equal((await d.frame(5))?.flags, FLAG_DATA);
        assert.equal(d.queued(3), 0);
        assert.equal(d.queued(99), 0);
        d.ws.close();
    } finally {
        await env.stop();
        up.closeAllConnections();
        await new Promise<void>((done) => up.close(() => done()));
    }
});

test("request credit: one empty DATA frame per DEVICE_CREDIT the agent took, before any head; a device past its window is reset", async () => {
    const env = await boot();
    try {
        const agent = await connectRawAgent(env, { name: "raw", app: { title: "Raw", upstream: "http://127.0.0.1:9" } });
        const d = await activeSession(env);
        const credential = await grant(d, 1, "raw");

        request(d, 3, { t: "app", appId: "raw", credential, method: "PUT", path: "/up" }, undefined, false);
        for (let i = 0; i < DEVICE_WINDOW / APP_CHUNK; i++) d.send(3, FLAG_DATA, new Uint8Array(APP_CHUNK));
        const { stream } = await nextRequest(agent);
        // an agent that takes every byte and credits each quantum at once
        let taken = 0;
        while (taken < DEVICE_WINDOW) {
            const f = await nextFrame(agent, stream);
            taken += f.payload.length;
            if (taken % APP_CREDIT === 0) agent.send({ stream, flags: FLAG_DATA, payload: new Uint8Array(0) });
        }
        const credits: ChannelStreamFrame[] = [];
        while (credits.length < DEVICE_WINDOW / DEVICE_CREDIT) credits.push((await d.frame(3))!);
        assert.ok(credits.every((f) => f.flags === FLAG_DATA && f.payload.length === 0), "credit, and no head yet");
        d.send(3, FLAG_END);
        assert.equal((await nextFrame(agent, stream)).flags, FLAG_END);
        agent.send(replyFrame(stream, { t: "head", status: 204, headers: {} }));
        agent.send({ stream, flags: FLAG_END, payload: new Uint8Array(0) });
        // one credit too many would reach answer() ahead of the head and fail its parse
        assert.equal((await answer(d, 3)).head.status, 204);

        // an agent that never credits: the gateway holds what the device sent, and a device that
        // runs past its own window is reset — the gateway never buffers more than one
        request(d, 5, { t: "app", appId: "raw", credential, method: "PUT", path: "/up" }, undefined, false);
        for (let i = 0; i < DEVICE_WINDOW / APP_CHUNK + 2; i++) d.send(5, FLAG_DATA, new Uint8Array(APP_CHUNK));
        let cut = await d.frame(5);
        while (cut?.flags === FLAG_DATA) cut = await d.frame(5);
        assert.equal(cut?.flags, FLAG_RESET);
        agent.close();
        d.ws.close();
    } finally {
        await env.stop();
    }
});

test("upgrade: a 101, then raw bytes both ways and END as a half-close; the malformed and the early are reset", async () => {
    const env = await boot();
    const sockets: Socket[] = [];
    const up: Server = createServer((_req, res) => res.end("not an upgrade"));
    up.on("upgrade", (req, duplex) => {
        const socket = duplex as Socket;
        sockets.push(socket);
        socket.on("error", () => socket.destroy());
        if (req.url === "/hold") return;
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${String(req.headers["sec-websocket-key"])}\r\n\r\n`);
        socket.on("data", (c: Buffer) => socket.write(c.toString("utf8").toUpperCase()));
        socket.on("end", () => socket.end());
    });
    await new Promise<void>((ready) => up.listen(0, "127.0.0.1", ready));
    try {
        await connectAppAgent(env, "shop", `http://127.0.0.1:${(up.address() as { port: number }).port}`);
        const d = await activeSession(env);
        const credential = await grant(d, 1);
        const headers = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "k3y", "sec-websocket-version": "13" };

        request(d, 3, { t: "app", appId: "shop", credential, method: "GET", path: "/ws", headers, upgrade: true }, undefined, false);
        const head = await d.frame(3);
        const parsed = JSON.parse(Buffer.from(head!.payload).toString("utf8")) as Answer["head"];
        assert.equal(parsed.status, 101);
        assert.equal(parsed.headers["upgrade"], "websocket");
        assert.equal(parsed.headers["sec-websocket-accept"], "k3y");
        d.send(3, FLAG_DATA, Buffer.from("ping"));
        assert.equal(Buffer.from((await d.frame(3))!.payload).toString("utf8"), "PING");
        d.send(3, FLAG_END);
        assert.equal((await d.frame(3))?.flags, FLAG_END, "our half-close reached the app, and its FIN came back");

        // an app upgrade without the flag keeps the 501; the flag without the header, or on an api
        // stream, is malformed; a byte before the 101 is a device that did not wait
        request(d, 5, { t: "app", appId: "shop", credential, method: "GET", path: "/ws", headers });
        assert.equal((await answer(d, 5)).head.status, 501);
        request(d, 7, { t: "app", appId: "shop", credential, method: "GET", path: "/ws", upgrade: true }, undefined, false);
        assert.equal((await d.frame(7))?.flags, FLAG_RESET);
        request(d, 9, { t: "api", method: "GET", path: "/api/events", headers, upgrade: true }, undefined, false);
        assert.equal((await d.frame(9))?.flags, FLAG_RESET);
        request(d, 11, { t: "app", appId: "shop", credential, method: "GET", path: "/hold", headers, upgrade: true }, undefined, false);
        await waitFor(() => sockets.length === 2, 4000, "the held handshake reached the app");
        d.send(11, FLAG_DATA, Buffer.from("too soon"));
        assert.equal((await d.frame(11))?.flags, FLAG_RESET);
        d.ws.close();
    } finally {
        for (const socket of sockets) socket.destroy();
        await env.stop();
        up.closeAllConnections();
        await new Promise<void>((done) => up.close(() => done()));
    }
});
