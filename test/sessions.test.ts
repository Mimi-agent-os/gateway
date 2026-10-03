/** The session cache: the HEAD check, a delta against a full reload, and integrity on every read. */
import assert from "node:assert/strict";
import test from "node:test";

import type { EventBody, Message } from "@mimi-os/protocol";
import { boot, callTurn, drained, textTurn, waitFor } from "./harness-env.ts";
import type { Env } from "./harness-env.ts";
import type { Harness } from "./agent-harness.ts";

const msg = (role: Message["role"], content: string): EventBody => ({
    type: "message",
    payload: { role, content },
});

async function connected(env: Env, name: string): Promise<Harness> {
    const h = await env.connect({ name, tools: [], handlers: {} });
    await waitFor(() => env.core.registry.get(name) !== undefined, 4000, "registration");
    return h;
}

const afterSeqsOf = (h: Harness): number[] =>
    h.frames()
        .filter((f) => f["type"] === "events_after")
        .map((f) => Number((f["payload"] as { afterSeq: number }).afterSeq));

test("a higher revision is caught up with a DELTA, not a full reload", async () => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        h.append(sid, [msg("user", "one"), msg("assistant", "two")]);

        const first = await env.core.sessions.ensure("toto", sid);
        assert.equal(first.headSeq, 2);
        assert.deepEqual(afterSeqsOf(h), [0], "the cold cache reads from 0");

        // the agent writes behind the gateway's back
        h.append(sid, [msg("user", "three")]);
        const again = await env.core.sessions.ensure("toto", sid);
        assert.equal(again.headSeq, 3);
        assert.deepEqual(afterSeqsOf(h), [0, 2], "the delta starts at the cached head");
        assert.equal(env.core.sessions.history(again).at(-1)?.content, "three");
    } finally {
        await env.stop();
    }
});

test("the same revision with a different hash forces a FULL reload", async () => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        h.append(sid, [msg("user", "one"), msg("assistant", "two")]);
        await env.core.sessions.ensure("toto", sid);

        // a hand edit / a restore from backup: revision unchanged, chain no longer the same
        h.sessions.get(sid)!.headHash = "0".repeat(64);
        const reloaded = await env.core.sessions.ensure("toto", sid);
        assert.deepEqual(afterSeqsOf(h), [0, 0], "integrity mismatch re-reads everything");
        assert.equal(reloaded.headHash, "0".repeat(64));
    } finally {
        await env.stop();
    }
});

test("a hand-edited row is caught on a COLD full reload, not only on a delta", async () => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        h.append(sid, [msg("user", "one"), msg("assistant", "two"), msg("user", "three")]);
        await env.core.sessions.ensure("toto", sid);

        // a payload UPDATE on a middle row leaves revision and head hash matching — only the chain itself can tell, and only a cold read (restart/eviction) sees it
        const middle = h.sessions.get(sid)!.events[1]!;
        (middle as { payload: unknown }).payload = { role: "assistant", content: "TAMPERED" };
        env.core.sessions.drop("toto", sid);
        env.logs.length = 0;
        await env.core.sessions.ensure("toto", sid);
        assert.ok(
            env.logs.some((l) => l.includes("INTEGRITY") && l.includes("seq 2")),
            "the broken chain is logged loudly",
        );

        // and a middle row DELETED outright, hashes untouched
        env.core.sessions.drop("toto", sid);
        h.sessions.get(sid)!.events.splice(1, 1);
        env.logs.length = 0;
        await env.core.sessions.ensure("toto", sid);
        assert.ok(env.logs.some((l) => l.includes("INTEGRITY")), "a missing row breaks the chain too");
    } finally {
        await env.stop();
    }
});

test("an honest cold load logs no integrity complaint", async () => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        h.append(sid, [msg("user", "one"), msg("assistant", "two")]);
        h.append(sid, [{ type: "compaction", payload: { summary: "s", covers: [1, 1] } }]);
        env.logs.length = 0;
        await env.core.sessions.ensure("toto", sid);
        assert.equal(env.logs.filter((l) => l.includes("INTEGRITY")).length, 0);
    } finally {
        await env.stop();
    }
});

test("an unchanged head is served straight from RAM", async () => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        h.append(sid, [msg("user", "one")]);
        await env.core.sessions.ensure("toto", sid);
        await env.core.sessions.ensure("toto", sid);
        assert.deepEqual(afterSeqsOf(h), [0], "no second fetch");
    } finally {
        await env.stop();
    }
});

test("push is an optimisation: a lost one only delays, a lying one changes nothing", async () => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        h.append(sid, [msg("user", "one")]);
        const first = await env.core.sessions.ensure("toto", sid);
        assert.equal(first.headSeq, 1);

        // the harness never sends session_changed at all — this is the "push was lost" world
        h.append(sid, [msg("assistant", "two")]);
        assert.equal(env.core.sessions.entry("toto", sid)?.headSeq, 1, "no push, no cache move");
        assert.equal((await env.core.sessions.ensure("toto", sid)).headSeq, 2, "HEAD catches up");

        // and a push that lies about the head moves nothing: nothing is pulled from a notice
        h.send({
            id: "liar",
            type: "session_changed",
            payload: { session: sid, revision: 999, headSeq: 999, headHash: "f".repeat(64) },
        });
        await drained(h, "after-liar");
        const entry = env.core.sessions.entry("toto", sid)!;
        assert.equal(entry.headSeq, 2);
        assert.equal(entry.headHash, h.sessions.get(sid)!.headHash);
        assert.equal((await env.core.sessions.ensure("toto", sid)).headSeq, 2);
    } finally {
        await env.stop();
    }
});

test("the gateway's own append is replayed locally, not refetched", async () => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        env.model.nextTurn(textTurn("hi back"));
        await env.core.runTurn({ agent: "toto", session: sid, text: "hi", title: false });

        const entry = env.core.sessions.entry("toto", sid)!;
        assert.equal(entry.headSeq, h.sessions.get(sid)!.headSeq);
        assert.equal(entry.headHash, h.sessions.get(sid)!.headHash);
        assert.deepEqual(afterSeqsOf(h), [0], "the turn's own writes cost no extra fetch");
    } finally {
        await env.stop();
    }
});

test("a deleted session drops out of the cache on the next HEAD check", async () => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        h.append(sid, [msg("user", "one")]);
        await env.core.sessions.ensure("toto", sid);
        h.sessions.delete(sid);
        await env.core.sessions.sync("toto", [sid]);
        assert.equal(env.core.sessions.entry("toto", sid), undefined);
    } finally {
        await env.stop();
    }
});

test("a session over the byte budget stays cached for the sync that returned it, so `done` still folds", async () => {
    // a one-byte budget: every entry is over it
    const env = await boot({ cache: { maxBytes: 1 } });
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "d1", name: "done", args: JSON.stringify({ summary: "Wrapped up." }) }]));
        env.model.nextTurn(textTurn("hi back"));
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "hi", title: false });

        assert.equal(out.dropped, false);
        assert.equal(out.text, "hi back");
        const compactions = h.sessions.get(sid)!.events.filter((e) => e.type === "compaction");
        assert.equal(compactions.length, 1, "`done` saw the session it had just synced");
        assert.ok(env.core.sessions.entry("toto", sid), "the entry the last sync returned is still held");

        // the next sync of ANOTHER session is what evicts it, never its own
        const other = h.createSession();
        await env.core.sessions.ensure("toto", other);
        assert.equal(env.core.sessions.entry("toto", sid), undefined);
        assert.ok(env.core.sessions.entry("toto", other));
    } finally {
        await env.stop();
    }
});

test("an aborted queued reconciliation does not cancel or corrupt another session reader", async (t) => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        h.append(sid, [msg("user", "one")]);
        const peer = env.core.registry.get("toto")!;
        const request = peer.request.bind(peer) as (type: string, payload: unknown, opts?: unknown) => Promise<unknown>;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let delayed = true;
        const delayedRequest = async (type: string, payload: unknown, opts?: unknown): Promise<unknown> => {
            if (type === "events_after" && delayed) {
                delayed = false;
                entered.resolve();
                await release.promise;
            }
            return request(type, payload, opts);
        };
        t.mock.method(peer, "request", delayedRequest as unknown as typeof peer.request);

        const first = env.core.sessions.ensure("toto", sid);
        await entered.promise;
        const abort = new AbortController();
        const cancelled = env.core.sessions.ensure("toto", sid, abort.signal);
        await waitFor(
            () => h.frames().filter((frame) => frame["type"] === "session_head").length === 2,
            4000,
            "second head request",
        );
        abort.abort(new Error("turn stopped"));
        await assert.rejects(cancelled, /turn stopped/);

        release.resolve();
        assert.equal((await first).headSeq, 1);
        assert.equal((await env.core.sessions.ensure("toto", sid)).headSeq, 1);
        assert.deepEqual(afterSeqsOf(h), [0], "the aborted waiter never starts its queued reload");
    } finally {
        await env.stop();
    }
});

test("an active session read observes its caller cancellation", { timeout: 10_000 }, async (t) => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        h.append(sid, [msg("user", "one")]);
        const peer = env.core.registry.get("toto")!;
        const request = peer.request.bind(peer) as (type: string, payload: unknown, opts?: unknown) => Promise<unknown>;
        const abort = new AbortController();
        const entered = Promise.withResolvers<void>();
        const activeRead = async (type: string, payload: unknown, opts?: unknown): Promise<unknown> => {
            if (type !== "events_after") return request(type, payload, opts);
            const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
            assert.equal(signal, abort.signal);
            entered.resolve();
            return new Promise<never>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
        };
        t.mock.method(peer, "request", activeRead as unknown as typeof peer.request);

        const reading = env.core.sessions.ensure("toto", sid, abort.signal);
        await entered.promise;
        abort.abort(new Error("turn stopped"));
        await assert.rejects(reading, /turn stopped/);
    } finally {
        await env.stop();
    }
});

test("an event canon() refuses to hash breaks the chain instead of killing the session", async (t) => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        h.append(sid, [msg("user", "one"), msg("assistant", "two")]);
        await env.core.sessions.ensure("toto", sid);

        // a hostile agent's own db: a row with no payload key at all
        const rows = h.sessions.get(sid)!.events;
        delete (rows[0] as { payload?: unknown }).payload;
        env.core.sessions.drop("toto", sid);
        env.logs.length = 0;

        // and one nested deeper than JSON.stringify survives — JSON.parse accepts far more than it
        // can write back, so such a payload only ever exists on this side of the wire
        const peer = env.core.registry.get("toto")!;
        const request = peer.request.bind(peer) as (type: string, payload: unknown, opts?: unknown) => Promise<unknown>;
        const nested = async (type: string, payload: unknown, opts?: unknown): Promise<unknown> => {
            const reply = await request(type, payload, opts);
            if (type !== "events_after") return reply;
            const last = (reply as { events: Array<{ payload: unknown }> }).events.at(-1);
            let deep: unknown = 1;
            for (let i = 0; i < 20_000; i++) deep = [deep];
            if (last) last.payload = deep;
            return reply;
        };
        t.mock.method(peer, "request", nested as unknown as typeof peer.request);

        const entry = await env.core.sessions.ensure("toto", sid);
        assert.equal(entry.events.length, 2, "the log is still served as read");
        assert.ok(
            env.logs.some((l) => l.includes("INTEGRITY") && l.includes("seq 1")),
            "the unhashable row is the break, and it is logged",
        );
        assert.deepEqual(env.core.sessions.history(entry), [], "nothing unreadable reaches a prompt");
    } finally {
        await env.stop();
    }
});

test("a log that pages out of pages is kept as a prefix and never served as history", async (t) => {
    // a cache too small to hold the prefix: eviction must not restart the read from seq 0 forever
    const env = await boot({ cache: { maxBytes: 1 } });
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        h.append(sid, Array.from({ length: 450 }, (_v, i) => msg("user", `m${i}`)));

        const peer = env.core.registry.get("toto")!;
        const request = peer.request.bind(peer) as (type: string, payload: unknown, opts?: unknown) => Promise<unknown>;
        // an agent that answers one row per page: legal, and 200 pages never reach the head
        const dripping = async (type: string, payload: unknown, opts?: unknown): Promise<unknown> =>
            type === "events_after"
                ? request(type, { ...(payload as Record<string, unknown>), limit: 1 }, opts)
                : request(type, payload, opts);
        t.mock.method(peer, "request", dripping as unknown as typeof peer.request);

        await assert.rejects(env.core.sessions.ensure("toto", sid), /could not be read in full/);
        assert.ok(
            env.logs.some((l) => l.includes("INTEGRITY") && l.includes("prefix")),
            "a short read is loud",
        );
        assert.equal(env.core.sessions.entry("toto", sid)?.headSeq, 200, "the prefix is stamped with what was read");

        await assert.rejects(env.core.sessions.ensure("toto", sid), /could not be read in full/);
        assert.equal(env.core.sessions.entry("toto", sid)?.headSeq, 400, "the next check pages on");

        const full = await env.core.sessions.ensure("toto", sid);
        assert.equal(full.events.length, 450);
        assert.equal(full.headSeq, h.sessions.get(sid)!.headSeq);
        assert.equal(full.headHash, h.sessions.get(sid)!.headHash);
        assert.equal(env.core.sessions.history(full).at(-1)?.content, "m449");
    } finally {
        await env.stop();
    }
});
