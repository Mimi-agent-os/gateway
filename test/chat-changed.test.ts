/** chat_changed: every screen learns that one agent's chat moved — a turn, a title, the agent's own write, a list edit. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import test from "node:test";

import type { HubEvent } from "../src/events.ts";
import { boot, drained, textTurn, waitFor, type Env } from "./harness-env.ts";
import type { Harness } from "./agent-harness.ts";

async function toto(env: Env): Promise<Harness> {
    const h = await env.connect({ name: "toto" });
    await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
    return h;
}

test("chat_changed: a chat turn announces its start and its settle, with busy already flipped each time", async () => {
    const env = await boot();
    try {
        const h = await toto(env);
        const sid = h.createSession();
        const seen: Array<HubEvent & { busy: boolean }> = [];
        env.core.events.subscribe((ev) => {
            if (ev.type === "chat_changed") seen.push({ ...ev, busy: env.core.turns.get("toto", sid) !== undefined });
        });

        env.model.nextTurn(textTurn("hi"));
        await env.core.runTurn({ agent: "toto", session: sid, text: "hello", title: false });
        assert.deepEqual(seen, [
            { type: "chat_changed", agent: "toto", session: sid, busy: true },
            { type: "chat_changed", agent: "toto", session: sid, busy: false },
        ]);
    } finally {
        await env.stop();
    }
});

test("chat_changed: an auto-title that lands is one more event, and a chat already titled adds none", async () => {
    const env = await boot();
    try {
        const h = await toto(env);
        const sid = h.createSession();
        const titles: Array<string | null> = [];
        env.core.events.subscribe((ev) => {
            if (ev.type === "chat_changed") titles.push(h.sessions.get(sid)?.title ?? null);
        });

        env.model.nextTurn(textTurn("Miso."));
        env.model.nextTurn(textTurn('{"title":"The cat\'s name"}'));
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "what is the cat called?", title: true });
        assert.equal(await out.titling, true);
        await waitFor(() => titles.length === 3, 4000, "the title's event");
        assert.deepEqual(titles, [null, null, "The cat's name"], "announced once the title is on the agent");

        env.model.nextTurn(textTurn("Still Miso."));
        const again = await env.core.runTurn({ agent: "toto", session: sid, text: "and now?", title: true });
        assert.equal(await again.titling, false);
        assert.equal(titles.length, 5, "start and settle only");
    } finally {
        await env.stop();
    }
});

test("chat_changed: the agent's own session_changed push fans out, and a head naming no real session does not", async () => {
    const env = await boot();
    try {
        const h = await toto(env);
        const sid = h.createSession();
        const seen: HubEvent[] = [];
        env.core.events.subscribe((ev) => {
            if (ev.type === "chat_changed") seen.push(ev);
        });

        // a cron wrote to the chat past the gateway, and says so
        const head = h.append(sid, [{ type: "message", payload: { role: "user", content: "reminder: water the plants" } }]);
        h.send({ id: "bad", type: "session_changed", payload: { ...head, session: "1 OR 1=1" } });
        h.send({ id: "good", type: "session_changed", payload: head });
        await waitFor(() => seen.length > 0, 4000, "the fanout");
        assert.deepEqual(seen, [{ type: "chat_changed", agent: "toto", session: sid }]);
    } finally {
        await env.stop();
    }
});

test("chat_changed: create, rename, pin and delete each reach /api/events, and a change that applied nothing is silent", async () => {
    const env = await boot();
    try {
        await toto(env);
        const events = await env.stream("GET", "/api/events");
        await waitFor(() => events.lines.some((e) => e["type"] === "ready"), 4000, "the stream opened");
        const changed = (): Array<Record<string, unknown>> => events.lines.filter((e) => e["type"] === "chat_changed");

        const created = await env.api<{ id: number }>("POST", "/api/agents/toto/conversations");
        const id = created.json.id;
        await env.api("PATCH", `/api/agents/toto/conversations/${id}`, { title: "Groceries" });
        await env.api("PATCH", `/api/agents/toto/conversations/${id + 100}`, { title: "Nobody" });
        await env.api("PATCH", `/api/agents/toto/conversations/${id}`, { pinned: true });
        await env.api("DELETE", `/api/agents/toto/conversations/${id + 100}`);
        await env.api("DELETE", `/api/agents/toto/conversations/${id}`);

        await waitFor(() => changed().length === 4, 4000, "four list changes");
        assert.deepEqual(changed(), Array(4).fill({ type: "chat_changed", agent: "toto", session: id }));
        events.close();
    } finally {
        await env.stop();
    }
});

test("chat_changed: a truncate, a manual compaction and an inbox discussion each announce the chat once their write is on the agent", async () => {
    const env = await boot();
    try {
        const h = await toto(env);
        const sid = h.createSession("seeded", true);
        h.append(sid, Array.from({ length: 12 }, (_, i) => ({
            type: "message" as const,
            payload: { role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(600) },
        })));
        // what the agent holds for that chat at the moment each event goes out
        const seen: Array<{ session: unknown; events: number; last: string | undefined }> = [];
        env.core.events.subscribe((ev) => {
            if (ev.type !== "chat_changed") return;
            const s = h.sessions.get(ev["session"] as number);
            seen.push({ session: ev["session"], events: s?.events.length ?? -1, last: s?.events.at(-1)?.type });
        });
        const chat = `/api/agents/toto/conversations/${sid}`;

        env.model.nextTurn(textTurn("The earlier part, summarized."));
        assert.equal((await env.api<{ compacted: boolean }>("POST", `${chat}/compact`)).json.compacted, true);
        assert.equal((await env.api<{ compacted: boolean }>("POST", `${chat}/compact`)).json.compacted, false);
        assert.equal((await env.api("POST", `${chat}/truncate`, { messageId: 0 })).status, 400);
        assert.equal((await env.api("POST", `${chat}/truncate`, { messageId: 11 })).status, 200);
        assert.deepEqual(seen, [
            { session: sid, events: 13, last: "compaction" },
            { session: sid, events: 14, last: "truncate" },
        ], "a compaction that folded nothing and a refused truncate are silent");

        // discuss creates the chat, then seeds it: the last word comes once the seed is in
        seen.length = 0;
        const item = env.db.insertInboxItem({ source: "agent", agent: "toto", title: "Report", body: "Details" });
        const discussed = (await env.api<{ conversation: number }>("POST", `/api/inbox/${item.id}/discuss`)).json;
        assert.deepEqual(seen, [
            { session: discussed.conversation, events: 0, last: undefined },
            { session: discussed.conversation, events: 1, last: "message" },
        ]);
    } finally {
        await env.stop();
    }
});

/** A short notice window, so the fold is tested in ms: every wait below is two windows. */
const WINDOW = 20;

test("chat_changed: an agent's notice flood folds into one trailing event per chat, and made-up ids stop at the window cap", async () => {
    const env = await boot({ changedWindowMs: WINDOW });
    try {
        const h = await toto(env);
        const sid = h.createSession();
        const seen: HubEvent[] = [];
        env.core.events.subscribe((ev) => {
            if (ev.type === "chat_changed") seen.push(ev);
        });
        const head = h.head(sid);
        for (let i = 0; i < 500; i++) h.send({ id: `s${i}`, type: "session_changed", payload: head });
        await drained(h, "after-same");
        await waitFor(() => seen.length > 0, 4000, "the trailing event");
        await new Promise((r) => setTimeout(r, 2 * WINDOW));
        assert.deepEqual(seen, [{ type: "chat_changed", agent: "toto", session: sid }]);

        seen.length = 0;
        const t0 = Date.now();
        for (let i = 0; i < 2000; i++) {
            h.send({ id: `m${i}`, type: "session_changed", payload: { ...head, session: 1_000_000 + i } });
        }
        await drained(h, "after-made-up");
        const windows = Math.ceil((Date.now() - t0) / WINDOW) + 1;
        await new Promise((r) => setTimeout(r, 2 * WINDOW));
        const sessions = seen.map((ev) => ev["session"]);
        assert.ok(sessions.length > 0 && sessions.length <= 32 * windows, `${sessions.length} events for 2000 made-up chats`);
        assert.equal(new Set(sessions).size, sessions.length, "no chat twice");
    } finally {
        await env.stop();
    }
});

test("chat_changed: a paused agent's own notices announce nothing until it is resumed", async () => {
    const env = await boot({ changedWindowMs: WINDOW });
    try {
        const h = await toto(env);
        const sid = h.createSession();
        const seen: HubEvent[] = [];
        env.core.events.subscribe((ev) => {
            if (ev.type === "chat_changed") seen.push(ev);
        });
        env.core.setPaused("toto", true);
        for (let i = 0; i < 20; i++) h.send({ id: `p${i}`, type: "session_changed", payload: h.head(sid) });
        await drained(h, "after-paused");
        await new Promise((r) => setTimeout(r, 2 * WINDOW));
        assert.deepEqual(seen, []);

        env.core.setPaused("toto", false);
        h.send({ id: "r", type: "session_changed", payload: h.head(sid) });
        await waitFor(() => seen.length > 0, 4000, "the resumed agent's notice");
        assert.deepEqual(seen, [{ type: "chat_changed", agent: "toto", session: sid }]);
    } finally {
        await env.stop();
    }
});

test("chat_changed: a notice that lands while the gateway stops opens no window to outlive it", async () => {
    const env = await boot({ changedWindowMs: WINDOW });
    try {
        const h = await toto(env);
        const sid = h.createSession();
        const peer = env.core.registry.get("toto")!;
        const stopping = env.core.stop();
        // the registry still dispatches frames while stop() waits on running turns: this is that dispatch
        env.core.registry.hooks!.changed(peer, h.head(sid));
        await stopping;
        const seen: HubEvent[] = [];
        env.core.events.subscribe((ev) => void seen.push(ev));
        await new Promise((r) => setTimeout(r, 2 * WINDOW));
        assert.deepEqual(seen, []);
    } finally {
        await env.stop();
    }
});
