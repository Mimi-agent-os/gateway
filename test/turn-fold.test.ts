/** Deterministic fold: a `fold`-marked tool's traffic drops out of history even without `done`. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import test from "node:test";

import type { CompactionPayload, EventBody } from "@mimi-os/protocol";
import { addModel, setDefaultModel } from "../src/llm/models.ts";
import { momentStamp } from "../src/turn/prompt.ts";
import { boot, callTurn, textTurn, waitFor } from "./harness-env.ts";
import type { Env } from "./harness-env.ts";
import type { Harness } from "./agent-harness.ts";

const FOLD_TOOL = { name: "search", writes: false, fold: true, parameters: { type: "object", properties: {} } };
const PLAIN_TOOL = { name: "note", writes: false, parameters: { type: "object", properties: {} } };

const compactionsOf = (h: Harness, sid: number): CompactionPayload[] =>
    h.sessions
        .get(sid)!
        .events.filter((e) => e.type === "compaction")
        .map((e) => e.payload as CompactionPayload);

async function connected(env: Env): Promise<{ h: Harness; sid: number }> {
    const h = await env.connect({
        name: "toto",
        tools: [FOLD_TOOL, PLAIN_TOOL],
        handlers: { search: { text: "SEARCHED" }, note: { text: "NOTED" } },
    });
    await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
    return { h, sid: h.createSession() };
}

test("a turn that used only a fold tool, no `done`, folds its tool traffic mechanically", async () => {
    const env = await boot();
    try {
        const { h, sid } = await connected(env);
        env.model.nextTurn(callTurn([{ id: "s1", name: "search" }]));
        env.model.nextTurn(textTurn("all done"));

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });

        const comps = compactionsOf(h, sid);
        assert.equal(comps.length, 1, "the fold tool's traffic was folded");
        assert.equal(comps[0]!.summary, "Earlier in this turn: 1 tool call: search.");
        assert.equal(env.model.requests.length, 2, "no summarize model call — the fold is mechanical");
    } finally {
        await env.stop();
    }
});

test("a turn that also used a non-fold tool is NOT auto-folded", async () => {
    const env = await boot();
    try {
        const { h, sid } = await connected(env);
        env.model.nextTurn(callTurn([{ id: "s1", name: "search" }, { id: "n1", name: "note" }]));
        env.model.nextTurn(textTurn("all done"));

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });

        assert.equal(compactionsOf(h, sid).length, 0, "a non-fold result may need to stay");
    } finally {
        await env.stop();
    }
});

test("`done` wins over auto-fold: the fold carries the model's summary, not the mechanical one", async () => {
    const env = await boot();
    try {
        const { h, sid } = await connected(env);
        env.model.nextTurn(
            callTurn([
                { id: "s1", name: "search" },
                { id: "d1", name: "done", args: JSON.stringify({ summary: "Found the thing." }) },
            ]),
        );
        env.model.nextTurn(textTurn("all done"));

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });

        const comps = compactionsOf(h, sid);
        assert.equal(comps.length, 1);
        assert.equal(comps[0]!.summary, "Found the thing.");
        assert.doesNotMatch(comps[0]!.summary, /tool call/, "rule 1 wins, not the mechanical summary");
    } finally {
        await env.stop();
    }
});

test("a turn with only non-fold tools, no `done`, is left intact", async () => {
    const env = await boot();
    try {
        const { h, sid } = await connected(env);
        env.model.nextTurn(callTurn([{ id: "n1", name: "note" }]));
        env.model.nextTurn(textTurn("all done"));

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });

        assert.equal(compactionsOf(h, sid).length, 0);
    } finally {
        await env.stop();
    }
});

test("auto-fold waits for the turn's end: the model reads the fold tool's result, and the final answer survives", async () => {
    const env = await boot();
    try {
        const { h, sid } = await connected(env);
        env.model.nextTurn(callTurn([{ id: "s1", name: "search" }]));
        env.model.nextTurn(textTurn("the answer is SEARCHED"));

        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });

        const second = env.model.requests[1]?.["messages"] as Array<{ role: string; content: unknown }>;
        assert.ok(
            second.some((m) => m.role === "tool" && m.content === "SEARCHED"),
            "round 2 was asked with the tool's output, not a folded stub",
        );
        assert.equal(out.text, "the answer is SEARCHED");
        assert.deepEqual(compactionsOf(h, sid).map((c) => c.summary), ["Earlier in this turn: 1 tool call: search."]);
        const entry = await env.core.sessions.ensure("toto", sid);
        const history = env.core.sessions.history(entry);
        assert.deepEqual(
            history.map((m) => [m.role, m.content]),
            [
                ["user", `[${momentStamp(entry.events[0]!.createdAt)}]\ngo`],
                ["assistant", "Earlier in this turn: 1 tool call: search."],
                ["assistant", "the answer is SEARCHED"],
            ],
        );
    } finally {
        await env.stop();
    }
});

test("a `done` after a mid-turn compaction folds only what came after it: the compaction's summary survives", async () => {
    const env = await boot();
    try {
        const { h, sid } = await connected(env);
        const seeded: EventBody[] = [];
        for (let i = 0; i < 12; i++) {
            seeded.push({ type: "message", payload: { role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(600) } });
        }
        h.append(sid, seeded);
        env.model.nextTurn(callTurn([{ id: "n1", name: "note" }], 900)); // past 0.6 of the window
        env.model.nextTurn(textTurn("EARLIER SUMMARY"));
        env.model.nextTurn(callTurn([{ id: "d1", name: "done", args: JSON.stringify({ summary: "Wrapped up." }) }]));
        env.model.nextTurn(textTurn("finished"));

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });

        const comps = compactionsOf(h, sid);
        assert.deepEqual(comps.map((c) => c.summary), ["EARLIER SUMMARY", "Wrapped up."]);
        const midTurn = h.sessions.get(sid)!.events.find((e) => e.type === "compaction")!.seq;
        assert.ok(comps[1]!.covers![0] > midTurn, "the fold range starts after the compaction event");
        const history = env.core.sessions.history(await env.core.sessions.ensure("toto", sid));
        assert.equal(history[0]?.content, "EARLIER SUMMARY", "the earlier conversation is still summarized");
        assert.ok(history.some((m) => m.content === "Wrapped up."));
        assert.equal(history.at(-1)?.content, "finished");
    } finally {
        await env.stop();
    }
});

test("an image fold before the first call leaves the turn's own tool run to fold as usual", async () => {
    const env = await boot();
    try {
        addModel({ name: "eye", provider: "llamacpp", endpoint: env.model.url, contextTokens: 128_000, vision: true }, env.db);
        setDefaultModel("eye", env.db);
        const { h, sid } = await connected(env);
        const photo = (n: number): string => `data:image/png;base64,${String(n).padStart(40, "A")}`;
        // 26 undescribed: the newest 6 stay, the older 20 fold
        h.append(sid, [
            { type: "message", payload: { role: "user", content: "old", images: Array.from({ length: 20 }, (_v, i) => photo(i)) } },
            { type: "message", payload: { role: "user", content: "new", images: Array.from({ length: 6 }, (_v, i) => photo(50 + i)) } },
        ]);
        const lines = (count: number): string => Array.from({ length: count }, (_v, i) => `${i + 1}: shot ${i + 1}`).join("\n");
        env.model.nextTurn(textTurn(lines(8)));
        env.model.nextTurn(textTurn(lines(8)));
        env.model.nextTurn(textTurn(lines(4)));
        env.model.nextTurn(callTurn([{ id: "s1", name: "search" }]));
        env.model.nextTurn(textTurn("all done"));

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });

        const comps = compactionsOf(h, sid);
        assert.deepEqual(comps.map((c) => [c.summary, c.images?.map((i) => [i.seq, i.notes.length])]), [
            [undefined, [[1, 20]]],
            ["Earlier in this turn: 1 tool call: search.", undefined],
        ]);
        const history = env.core.sessions.history(await env.core.sessions.ensure("toto", sid));
        assert.ok(history[0]?.content?.endsWith("[earlier image: shot 4]"));
        assert.equal(history[1]?.images?.length, 6);
        assert.equal(history.at(-1)?.content, "all done");
        assert.equal(history.some((m) => m.content === "SEARCHED"), false, "the tool traffic is folded away");
    } finally {
        await env.stop();
    }
});
