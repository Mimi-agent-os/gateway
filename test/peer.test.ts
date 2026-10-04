import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

import { REPLY_OF } from "@mimi-os/protocol";

import { AgentPeer, PeerError, type AgentSocket } from "../src/registry/peer.ts";

test("a request settles only from its matching reply type and a valid status", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const socket: AgentSocket = {
        open: true,
        send: (text) => void sent.push(JSON.parse(text) as Record<string, unknown>),
        close: () => undefined,
        openAppStream: () => null,
        onmessage: null,
        onclose: null,
        onerror: null,
    };
    const peer = new AgentPeer(socket, "toto", () => undefined);
    let settled = false;
    const pending = peer.request("health", {}).finally(() => {
        settled = true;
    });
    const id = String(sent[0]?.["id"]);

    socket.onmessage?.(JSON.stringify({ id, type: "describe_ok", status: "ok", payload: { uptimeMs: 1 } }));
    socket.onmessage?.(JSON.stringify({ id, type: "health_ok", status: "invalid", payload: { uptimeMs: 2 } }));
    socket.onmessage?.(JSON.stringify({ id, type: "health_ok", status: "ok" }));
    socket.onmessage?.(JSON.stringify({ id, type: "health_ok", status: "error", error: {} }));
    await nextTurn();
    assert.equal(settled, false);

    socket.onmessage?.(JSON.stringify({ id, type: "health_ok", status: "ok", payload: { uptimeMs: 3 } }));
    assert.deepEqual(await pending, { uptimeMs: 3 });
});

test("an already-aborted request is not sent", async () => {
    const sent: string[] = [];
    const socket: AgentSocket = {
        open: true,
        send: (text) => void sent.push(text),
        close: () => undefined,
        openAppStream: () => null,
        onmessage: null,
        onclose: null,
        onerror: null,
    };
    const peer = new AgentPeer(socket, "toto", () => undefined);
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    controller.abort(reason);

    await assert.rejects(peer.request("health", {}, { signal: controller.signal }), reason);
    assert.deepEqual(sent, []);
});

test("aborting an in-flight request removes its waiter", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const socket: AgentSocket = {
        open: true,
        send: (text) => void sent.push(JSON.parse(text) as Record<string, unknown>),
        close: () => undefined,
        openAppStream: () => null,
        onmessage: null,
        onclose: null,
        onerror: null,
    };
    const peer = new AgentPeer(socket, "toto", () => undefined);
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const pending = peer.request("health", {}, { signal: controller.signal, timeoutMs: 60_000 });
    const id = sent[0]?.["id"];

    controller.abort(reason);
    await assert.rejects(pending, reason);
    socket.onmessage?.(JSON.stringify({ id, type: "health_ok", status: "ok", payload: { uptimeMs: 3 } }));
});

test("a request naming an Object.prototype key is still answered, under the generic reply type", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const socket: AgentSocket = {
        open: true,
        send: (text) => void sent.push(JSON.parse(text) as Record<string, unknown>),
        close: () => undefined,
        openAppStream: () => null,
        onmessage: null,
        onclose: null,
        onerror: null,
    };
    const peer = new AgentPeer(socket, "toto", () => undefined);
    peer.onRequest = () => Promise.reject(new Error("unknown frame type"));
    // the reply name must be the gateway's own decision, not whatever REPLY_OF happens to inherit
    Object.setPrototypeOf(REPLY_OF, Object.prototype);
    try {
        socket.onmessage?.(JSON.stringify({ id: "c", type: "constructor", payload: {} }));
        socket.onmessage?.(JSON.stringify({ id: "p", type: "__proto__", payload: {} }));
        await nextTurn();
    } finally {
        Object.setPrototypeOf(REPLY_OF, null);
    }

    assert.deepEqual(
        sent.map((f) => [f["id"], f["type"], f["status"]]),
        [["c", "result", "error"], ["p", "result", "error"]],
    );
});

/** A socket that records every frame the peer sends. */
function recording(): { socket: AgentSocket; sent: Array<Record<string, unknown>> } {
    const sent: Array<Record<string, unknown>> = [];
    const socket: AgentSocket = {
        open: true,
        send: (text) => void sent.push(JSON.parse(text) as Record<string, unknown>),
        close: () => undefined,
        openAppStream: () => null,
        onmessage: null,
        onclose: null,
        onerror: null,
    };
    return { socket, sent };
}

test("a request with timeoutMs null has no timer: the 30 s default never fires, only the reply settles it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const { socket, sent } = recording();
        const peer = new AgentPeer(socket, "toto", () => undefined);
        const plain = peer.request("health", {});
        let settled = false;
        const invoke = peer.request("invoke", { tool: "slow", args: {} }, { timeoutMs: null }).finally(() => {
            settled = true;
        });
        // runAll fires every pending timer whatever its delay: the plain request's 30 s goes, and so
        // would any timer behind the invoke — Node fires a delay over 2^31-1 ms after 1 ms anyway
        t.mock.timers.runAll();
        await assert.rejects(plain, /no reply within 30000ms/);
        await nextTurn();
        assert.equal(settled, false);
        assert.equal(sent[1]?.["deadline"], undefined, "no deadline goes on the wire either");

        socket.onmessage?.(JSON.stringify({ id: sent[1]?.["id"], type: "result", status: "ok", payload: { text: "DONE" } }));
        assert.deepEqual(await invoke, { text: "DONE" });
    } finally {
        t.mock.timers.reset();
    }
});

test("a timerless request is still rejected by its signal and by the socket closing", async () => {
    const { socket } = recording();
    const peer = new AgentPeer(socket, "toto", () => undefined);
    const controller = new AbortController();
    const reason = new Error("stopped by user");
    const stopped = peer.request("invoke", { tool: "slow", args: {} }, { timeoutMs: null, signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(stopped, reason);

    const orphaned = peer.request("invoke", { tool: "slow", args: {} }, { timeoutMs: null });
    socket.onclose?.(1006, "channel closed");
    await assert.rejects(orphaned, (e) => e instanceof PeerError && /disconnected/.test(e.message));
});
