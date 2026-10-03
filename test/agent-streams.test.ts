import "./pq-home.ts";

/** Gateway-opened streams on an agent channel session: allocation, unknown ids, the stream cap, resets, and the watermark. */
import assert from "node:assert/strict";
import test from "node:test";

import {
    APP_MAX_STREAMS,
    FLAG_DATA,
    FLAG_END,
    FLAG_RESET,
    type AppStreamPort,
    type ChannelStreamFrame,
} from "@mimi-os/protocol";

import { connectRawAgent, nextFrame } from "./agent-wire.ts";
import { boot, waitFor, type Env } from "./harness-env.ts";

const EMPTY = new Uint8Array(0);
const utf8 = new TextEncoder();

function openStream(env: Env, name: string, onFrame: (frame: ChannelStreamFrame) => void): AppStreamPort | null {
    const peer = env.core.registry.get(name);
    assert.ok(peer, `${name} is not connected`);
    return peer.socket.openAppStream(onFrame);
}

test("a gateway-opened stream carries frames to the agent and back", async () => {
    const env = await boot();
    try {
        const agent = await connectRawAgent(env, { name: "shop" });
        const got: ChannelStreamFrame[] = [];
        const port = openStream(env, "shop", (f) => void got.push(f));
        assert.ok(port);

        assert.equal(port.send({ flags: FLAG_DATA, payload: utf8.encode("req") }), true);
        const head = await nextFrame(agent, 1);
        assert.equal(head.flags, FLAG_DATA);
        assert.equal(Buffer.from(head.payload).toString("utf8"), "req");
        port.send({ flags: FLAG_END, payload: EMPTY });
        assert.equal((await nextFrame(agent, 1)).flags, FLAG_END);

        agent.send({ stream: 1, flags: FLAG_DATA, payload: utf8.encode("reply") });
        agent.send({ stream: 1, flags: FLAG_END, payload: EMPTY });
        await waitFor(() => got.length === 2, 3000, "the reply frames reach onFrame");
        assert.equal(Buffer.from(got[0]!.payload).toString("utf8"), "reply");
        assert.equal(got[1]!.flags, FLAG_END);

        // one counter per connection, and only the gateway allocates on it
        const second = openStream(env, "shop", () => undefined);
        assert.ok(second);
        second.send({ flags: FLAG_DATA, payload: utf8.encode("x") });
        assert.equal((await nextFrame(agent, 2)).flags, FLAG_DATA);
        agent.close();
    } finally {
        await env.stop();
    }
});

test("an agent frame on an id the gateway does not hold is reset, and its reset is answered with nothing", async () => {
    const env = await boot();
    try {
        const agent = await connectRawAgent(env, { name: "shop" });
        const got: ChannelStreamFrame[] = [];
        const port = openStream(env, "shop", (f) => void got.push(f));
        assert.ok(port);

        agent.send({ stream: 900, flags: FLAG_DATA, payload: utf8.encode("unsolicited") });
        const refused = await nextFrame(agent, 900);
        assert.equal(refused.flags, FLAG_RESET);

        // both ends have ended stream 1: it is finished, so the next frame on it is refused too
        port.send({ flags: FLAG_END, payload: EMPTY });
        assert.equal((await nextFrame(agent, 1)).flags, FLAG_END);
        agent.send({ stream: 1, flags: FLAG_END, payload: EMPTY });
        await waitFor(() => got.length === 1, 3000, "the agent's END reaches onFrame");
        agent.send({ stream: 1, flags: FLAG_DATA, payload: utf8.encode("late") });
        assert.equal((await nextFrame(agent, 1)).flags, FLAG_RESET);
        assert.equal(got.length, 1, "a finished stream is no longer delivered");

        agent.send({ stream: 901, flags: FLAG_RESET, payload: EMPTY });
        // a credit that outlived its stream is dropped, never answered: it is no violation
        agent.send({ stream: 902, flags: FLAG_DATA, payload: EMPTY });
        // DATA on an unknown id is reset: that RESET is ordered after anything the two frames above drew
        agent.send({ stream: 903, flags: FLAG_DATA, payload: utf8.encode("barrier") });
        assert.equal((await nextFrame(agent, 903)).flags, FLAG_RESET);
        assert.equal(
            agent.inbox.some((f) => f.stream === 901 || f.stream === 902),
            false,
            "a reset or a late credit for an unknown stream is never answered",
        );

        // the connection survived both: a fresh stream still works
        const later: ChannelStreamFrame[] = [];
        const next = openStream(env, "shop", (f) => void later.push(f));
        assert.ok(next);
        next.send({ flags: FLAG_DATA, payload: utf8.encode("still here") });
        assert.equal((await nextFrame(agent, 2)).flags, FLAG_DATA);
        // the agent's reply ended while the request is still open: a credit after that END is credit
        agent.send({ stream: 2, flags: FLAG_END, payload: EMPTY });
        agent.send({ stream: 2, flags: FLAG_DATA, payload: EMPTY });
        await waitFor(() => later.length === 2, 3000, "the END and the credit reach onFrame");
        assert.deepEqual([later[1]?.flags, later[1]?.payload.length], [FLAG_DATA, 0]);
        agent.send({ stream: 904, flags: FLAG_DATA, payload: utf8.encode("barrier") });
        assert.equal((await nextFrame(agent, 904)).flags, FLAG_RESET);
        assert.equal(agent.inbox.some((f) => f.stream === 2), false, "and it draws no RESET");
        assert.equal(agent.closed, false);
        agent.close();
    } finally {
        await env.stop();
    }
});

test("a throw out of a gateway-opened stream's owner loses that stream, not the connection", async () => {
    const env = await boot();
    try {
        const agent = await connectRawAgent(env, { name: "shop" });
        const port = openStream(env, "shop", () => {
            throw new Error("the sink is gone");
        });
        assert.ok(port);
        port.send({ flags: FLAG_DATA, payload: utf8.encode("req") });
        assert.equal((await nextFrame(agent, 1)).flags, FLAG_DATA);

        // whatever the bridge writes into — a ServerResponse, a raw duplex — may throw at any frame
        agent.send({ stream: 1, flags: FLAG_DATA, payload: utf8.encode("reply") });
        assert.equal((await nextFrame(agent, 1)).flags, FLAG_RESET, "the stream nobody can take goes");
        assert.ok(env.logs.some((line) => line.includes("app stream frame failed")));

        const next = openStream(env, "shop", () => undefined);
        assert.ok(next);
        next.send({ flags: FLAG_DATA, payload: utf8.encode("still here") });
        assert.equal((await nextFrame(agent, 2)).flags, FLAG_DATA, "the connection carries on");
        assert.equal(agent.closed, false);
        agent.close();
    } finally {
        await env.stop();
    }
});

test("one agent session opens APP_MAX_STREAMS streams and the next one is refused", async () => {
    const env = await boot();
    try {
        const agent = await connectRawAgent(env, { name: "shop" });
        const ports: AppStreamPort[] = [];
        for (let i = 0; i < APP_MAX_STREAMS; i++) {
            const port = openStream(env, "shop", () => undefined);
            assert.ok(port, `stream ${i + 1} was refused`);
            ports.push(port);
        }
        assert.equal(openStream(env, "shop", () => undefined), null);

        // a finished stream frees its slot
        ports[0]!.reset();
        const reused = openStream(env, "shop", () => undefined);
        assert.ok(reused);
        agent.close();
    } finally {
        await env.stop();
    }
});

test("every live gateway-opened stream is reset when the agent socket closes or reconnects", async () => {
    const env = await boot();
    try {
        const first = await connectRawAgent(env, { name: "shop" });
        const got: ChannelStreamFrame[] = [];
        for (let i = 0; i < 2; i++) assert.ok(openStream(env, "shop", (f) => void got.push(f)));
        first.close();
        await waitFor(() => got.length === 2, 3000, "a closed socket resets its streams");
        assert.deepEqual(
            got.map((f) => f.flags),
            [FLAG_RESET, FLAG_RESET],
        );

        // a reconnect closes the socket the registry was holding: its streams die the same way
        const second = await connectRawAgent(env, { name: "shop", identity: first.identity });
        const live: ChannelStreamFrame[] = [];
        assert.ok(openStream(env, "shop", (f) => void live.push(f)));
        const third = await connectRawAgent(env, { name: "shop", identity: first.identity });
        await waitFor(() => live.length === 1, 3000, "a replaced socket resets its streams");
        assert.equal(live[0]!.flags, FLAG_RESET);
        await waitFor(() => second.closed, 3000, "the replaced socket is closed");
        third.close();
    } finally {
        await env.stop();
    }
});

test("an agent connection that stops reading is terminated at the watermark, with its streams reset", async () => {
    // a stall deadline in ms, so the terminate this asserts does not wait the production 30 s out
    const env = await boot({ devices: { streamStallMs: 400 } });
    try {
        const agent = await connectRawAgent(env, { name: "shop" });
        const got: ChannelStreamFrame[] = [];
        const port = openStream(env, "shop", (f) => void got.push(f));
        assert.ok(port);

        agent.pause();
        const chunk = new Uint8Array(16 * 1024);
        const deadline = Date.now() + 4000;
        let blocked = false;
        // the kernel buffers the first megabytes: the producer has to keep going to park bytes in
        // the gateway's own queue, and to still be parked when the stall deadline comes round
        while (Date.now() < deadline && env.core.registry.get("shop") !== undefined) {
            const burst = blocked ? 1 : 16;
            for (let i = 0; i < burst; i++) if (!port.send({ flags: FLAG_DATA, payload: chunk })) blocked = true;
            await new Promise((r) => setTimeout(r, 5));
        }
        assert.ok(blocked, "the per-connection watermark pushed back on the producer");
        // the peer is not reading, so it learns nothing: the gateway's own side is what must go
        assert.equal(env.core.registry.get("shop"), undefined, "the stalled agent connection is terminated");
        await waitFor(() => got.length === 1, 3000, "the terminated connection resets its streams");
        assert.equal(got[0]!.flags, FLAG_RESET);
    } finally {
        await env.stop();
    }
});
