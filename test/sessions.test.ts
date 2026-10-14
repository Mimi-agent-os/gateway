/** The session cache: the HEAD check, a delta against a full reload, and integrity on every read. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import test from "node:test";

import type { EventBody, Message } from "@mimi-os/protocol";
import { addModel, setDefaultModel } from "../src/llm/models.ts";
import { momentStamp } from "../src/turn/prompt.ts";
import { HELD_IMAGES, IMAGE_NOT_SHOWN } from "../src/turn/sessions.ts";
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

/** A distinct data-URI of `size` base64 chars, told apart by `n`. */
const img = (n: number, size = 40): string => `data:image/png;base64,${String(n).padStart(size, "A")}`;
const album = (from: number, count: number, size?: number): string[] => Array.from({ length: count }, (_v, i) => img(from + i, size));
const pictured = (content: string, images: string[]): EventBody => ({ type: "message", payload: { role: "user", content, images } });
const sortedKeys = (map: Map<number, unknown>): number[] => [...map.keys()].sort((a, b) => a - b);

/** The events_after requests the gateway made, as sent. */
const pagesOf = (h: Harness): Array<{ afterSeq: number; limit: number }> =>
    h.frames()
        .filter((f) => f["type"] === "events_after")
        .map((f) => {
            const { afterSeq, limit } = f["payload"] as { afterSeq: number; limit: number };
            return { afterSeq, limit };
        });

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
        assert.equal(env.core.sessions.history(again).at(-1)?.content, `[${momentStamp(again.events.at(-1)!.createdAt)}]\nthree`);
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
    const env = await boot({ cache: { maxBytes: 1, maxPages: 200 } });
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
        assert.equal(env.core.sessions.history(full).at(-1)?.content, `[${momentStamp(full.events.at(-1)!.createdAt)}]\nm449`);
    } finally {
        await env.stop();
    }
});

test("a message's images leave the cached log once the chain has checked them, and the newest are held as pixels", async () => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        const photos = album(1, 2);
        h.append(sid, [
            pictured("what is this?", photos),
            msg("assistant", "two cats"),
            pictured("and this", ["https://tracker.example/pixel.png"]),
        ]);
        const entry = await env.core.sessions.ensure("toto", sid);
        assert.equal(entry.events.some((e) => "images" in (e.payload as object)), false, "no cached payload keeps its images");
        assert.deepEqual([...entry.images], [[1, 2]], "a remote URL is no image and is not counted");
        assert.deepEqual([...entry.pixels], [[1, photos]]);
        assert.ok(entry.bytes > photos.join("").length, "the pixels are charged to the entry");
        assert.equal(env.logs.filter((l) => l.includes("INTEGRITY")).length, 0, "the chain was checked on the whole payloads");

        const first = env.core.sessions.history(entry)[0]!;
        assert.deepEqual(first.images, photos);
        assert.equal(first.content, `[${momentStamp(entry.events[0]!.createdAt)}]\nwhat is this?`);
        assert.deepEqual(h.sessions.get(sid)!.events[0]!.payload, { role: "user", content: "what is this?", images: photos }, "the agent's log is untouched");
    } finally {
        await env.stop();
    }
});

test("the cache holds the newest undescribed visible images, whole messages, at most HELD_IMAGES; older ones read as a marker until described", async () => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        // five messages of 20 images at seqs 1, 3, 5, 7, 9: 100 undescribed, three messages held
        for (let m = 0; m < 5; m++) h.append(sid, [pictured(`batch ${m}`, album(m * 100, 20)), msg("assistant", `seen ${m}`)]);
        const entry = await env.core.sessions.ensure("toto", sid);
        assert.equal(HELD_IMAGES, 64);
        assert.deepEqual(sortedKeys(entry.pixels), [5, 7, 9]);
        assert.deepEqual([...env.core.sessions.undescribed(entry)], [[1, 20], [3, 20], [5, 20], [7, 20], [9, 20]]);
        let users = env.core.sessions.history(entry).filter((m) => m.role === "user");
        assert.deepEqual(users.map((m) => m.images?.length ?? 0), [0, 0, 20, 20, 20]);
        assert.equal(users[0]!.content!.split("\n").filter((l) => l === IMAGE_NOT_SHOWN).length, 20, "one marker per image not held");
        assert.ok(users[0]!.content!.startsWith(`[${momentStamp(entry.events[0]!.createdAt)}]\nbatch 0\n`));

        // the two newest are described: the window moves back over the older ones, read again from the agent
        const asked = pagesOf(h).length;
        const notes = (what: string): string[] => Array.from({ length: 20 }, (_v, i) => `${what} ${i}`);
        h.append(sid, [{ type: "compaction", payload: { images: [{ seq: 7, notes: notes("a cat") }, { seq: 9, notes: notes("a dog") }] } }]);
        const moved = await env.core.sessions.ensure("toto", sid);
        assert.deepEqual(sortedKeys(moved.pixels), [1, 3, 5]);
        assert.deepEqual(pagesOf(h).slice(asked), [
            { afterSeq: 10, limit: 500 },
            { afterSeq: 2, limit: 1 },
            { afterSeq: 0, limit: 1 },
        ], "the delta, then each missing message on its own, newest first");
        users = env.core.sessions.history(moved).filter((m) => m.role === "user");
        assert.deepEqual(users.map((m) => m.images?.length ?? 0), [20, 20, 20, 0, 0]);
        assert.deepEqual(users[0]!.images, album(0, 20));
        assert.ok(users[3]!.content!.endsWith(notes("a cat").map((n) => `[earlier image: ${n}]`).join("\n")));
        assert.equal(users.some((m) => m.content?.includes(IMAGE_NOT_SHOWN)), false);
        assert.deepEqual([...env.core.sessions.undescribed(moved).keys()], [1, 3, 5]);
    } finally {
        await env.stop();
    }
});

test("an image read back from the agent must match the hash the cache checked; a held one is served without a read", async () => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        for (let m = 0; m < 5; m++) h.append(sid, [pictured(`batch ${m}`, album(m * 100, 20))]);
        const entry = await env.core.sessions.ensure("toto", sid);
        assert.deepEqual(sortedKeys(entry.pixels), [3, 4, 5]);

        // the agent's copy edited behind the chain: the bytes no longer match what was checked
        const row = h.sessions.get(sid)!.events[0]!;
        (row as { payload: unknown }).payload = { role: "user", content: "batch 0", images: album(999, 20) };
        await assert.rejects(env.core.sessions.images(entry, 1), /does not match the hash the gateway checked/);
        assert.deepEqual(await env.core.sessions.images(entry, 2), album(100, 20));
        const asked = pagesOf(h).length;
        assert.equal(await env.core.sessions.images(entry, 5), entry.pixels.get(5), "held: the very array, no request");
        assert.equal(pagesOf(h).length, asked);
        await assert.rejects(env.core.sessions.images(entry, 99), /not in the cached log/);
    } finally {
        await env.stop();
    }
});

test("a cold load checks the chain and strips the images page by page, one image message per page past 512 KiB", async () => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sid = h.createSession();
        for (let m = 0; m < 4; m++) h.append(sid, [pictured(`photo ${m}`, [img(m, 400_000)]), msg("assistant", `ok ${m}`)]);
        const entry = await env.core.sessions.ensure("toto", sid);
        assert.deepEqual(afterSeqsOf(h), [0, 2, 4, 6], "a page per image message");
        assert.equal(entry.events.length, 8);
        assert.equal(env.logs.filter((l) => l.includes("INTEGRITY")).length, 0);
        assert.deepEqual(sortedKeys(entry.pixels), [1, 3, 5, 7], "every image is in the window, none read twice");
        assert.ok(entry.bytes < 4 * 400_000 + 8_000, "the cached log itself is small");

        // an image edited in place breaks the chain at its seq, on a cold read across pages
        (h.sessions.get(sid)!.events[4]!.payload as Message).images = [img(77, 400_000)];
        env.core.sessions.drop("toto", sid);
        env.logs.length = 0;
        await env.core.sessions.ensure("toto", sid);
        assert.ok(env.logs.some((l) => l.includes("INTEGRITY") && l.includes("seq 5")), env.logs.join(""));
    } finally {
        await env.stop();
    }
});

test("over the byte budget an idle chat sheds its pixels before it is evicted, and reads them back when opened again", async () => {
    const env = await boot({ cache: { maxBytes: 1_000_000 } });
    try {
        const h = await connected(env, "toto");
        const a = h.createSession();
        const big = [img(1, 400_000), img(2, 400_000)];
        h.append(a, [pictured("big", big), msg("assistant", "ok")]);
        assert.equal((await env.core.sessions.ensure("toto", a)).pixels.size, 1);

        const b = h.createSession();
        h.append(b, [pictured("small", [img(3, 300_000)])]);
        await env.core.sessions.ensure("toto", b);
        const idle = env.core.sessions.entry("toto", a);
        assert.ok(idle, "the idle chat is still cached");
        assert.equal(idle.pixels.size, 0, "but its pixels went first");
        assert.ok(idle.bytes < 10_000);

        const asked = pagesOf(h).length;
        const back = await env.core.sessions.ensure("toto", a);
        assert.deepEqual(back.pixels.get(1), big);
        assert.deepEqual(pagesOf(h).slice(asked), [{ afterSeq: 0, limit: 1 }], "only the held message is read back");
        assert.equal(env.core.sessions.entry("toto", b)?.pixels.size, 0, "now the other one is idle");
    } finally {
        await env.stop();
    }
});

test("a turn's own images go straight into the held pixels: no read back, the model gets them", async () => {
    const env = await boot();
    try {
        addModel({ name: "eye", provider: "llamacpp", endpoint: env.model.url, contextTokens: 128_000, vision: true }, env.db);
        setDefaultModel("eye", env.db);
        const h = await connected(env, "toto");
        const sid = h.createSession();
        const photos = album(1, 3);
        env.model.nextTurn(textTurn("three photos"));
        await env.core.runTurn({ agent: "toto", session: sid, text: "look", images: photos, title: false });

        const entry = env.core.sessions.entry("toto", sid)!;
        assert.deepEqual(entry.pixels.get(1), photos);
        assert.deepEqual([...entry.images], [[1, 3]]);
        assert.equal(entry.events.some((e) => "images" in (e.payload as object)), false);
        assert.deepEqual(afterSeqsOf(h), [0], "the turn's own writes cost no extra fetch");
        const user = (env.model.requests[0]!["messages"] as Array<{ role: string; content: unknown }>).find((m) => m.role === "user")!;
        assert.equal((user.content as Array<{ type: string }>).filter((p) => p.type === "image_url").length, 3);
    } finally {
        await env.stop();
    }
});

test("agent event reads are at most two in flight across the gateway: chats loading cold wait in line, and a cancelled one leaves it", async (t) => {
    const env = await boot();
    try {
        const h = await connected(env, "toto");
        const sids = Array.from({ length: 10 }, (_v, i) => {
            const sid = h.createSession();
            h.append(sid, [pictured(`chat ${i}`, album(i * 100, 4)), msg("assistant", "seen")]);
            return sid;
        });
        const peer = env.core.registry.get("toto")!;
        const request = peer.request.bind(peer) as (type: string, payload: unknown, opts?: unknown) => Promise<unknown>;
        let inFlight = 0;
        let most = 0;
        const read: number[] = [];
        const counted = async (type: string, payload: unknown, opts?: unknown): Promise<unknown> => {
            if (type !== "events_after") return request(type, payload, opts);
            read.push((payload as { session: number }).session);
            inFlight++;
            most = Math.max(most, inFlight);
            await new Promise((r) => setTimeout(r, 20));
            try {
                return await request(type, payload, opts);
            } finally {
                inFlight--;
            }
        };
        t.mock.method(peer, "request", counted as unknown as typeof peer.request);

        const loads = sids.slice(0, 9).map((sid) => env.core.sessions.ensure("toto", sid));
        await waitFor(() => inFlight === 2, 4000, "two reads in flight");
        const abort = new AbortController();
        const last = sids[9]!;
        const left = env.core.sessions.ensure("toto", last, abort.signal);
        await waitFor(() => h.frames().some((f) => f["type"] === "session_head" && (f["payload"] as { sessions: number[] }).sessions.includes(last)), 4000, "its head");
        await new Promise((r) => setTimeout(r, 5));
        abort.abort(new Error("the reader left"));
        await assert.rejects(left, /the reader left/);

        assert.deepEqual((await Promise.all(loads)).map((e) => e.pixels.size), Array(9).fill(1));
        assert.equal(most, 2);
        assert.equal(read.includes(last), false, "the cancelled load never read");
        assert.equal((await env.core.sessions.ensure("toto", last)).headSeq, 2, "and the line moves on without it");
        assert.equal(most, 2);
    } finally {
        await env.stop();
    }
});
