/** Thresholds as fractions of contextTokens; compaction fires, or provably does not. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chainHash, foldEvents } from "@mimi-os/protocol";
import type { CompactionPayload, EventBody, Message, StoredEvent } from "@mimi-os/protocol";
import { createFakeModel } from "@mimi-os/sdk/testing";
import { addModel } from "../src/llm/models.ts";
import { planCompaction, thresholdsFor } from "../src/turn/compaction.ts";
import { GatewayDb } from "../src/store/db.ts";
import { boot, callTurn, textTurn, waitFor } from "./harness-env.ts";
import type { Env } from "./harness-env.ts";
import type { Harness } from "./agent-harness.ts";

const BODY = "x".repeat(600);

const msg = (role: Message["role"], content: string): EventBody => ({
    type: "message",
    payload: { role, content },
});

async function seeded(env: Env): Promise<{ h: Harness; sid: number }> {
    const h = await env.connect({ name: "toto", tools: [], handlers: {} });
    await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
    const sid = h.createSession("seeded", true);
    const bodies: EventBody[] = [];
    for (let i = 0; i < 12; i++) bodies.push(msg(i % 2 === 0 ? "user" : "assistant", BODY));
    h.append(sid, bodies);
    return { h, sid };
}

/** A seq-ordered log with a real hash chain, as the agent stores it. */
function logOf(bodies: readonly EventBody[]): StoredEvent[] {
    const events: StoredEvent[] = [];
    let hash = "";
    for (const b of bodies) {
        const seq = events.length + 1;
        hash = chainHash(hash, { seq, type: b.type, payload: b.payload });
        events.push({ ...b, seq, hash, createdAt: 0 } as StoredEvent);
    }
    return events;
}

const summaryOf = (h: Harness, sid: number): CompactionPayload | null => {
    const last = h.sessions.get(sid)!.events.at(-1);
    return last?.type === "compaction" ? last.payload : null;
};

test("compaction fires once prompt_tokens crosses the fraction, and appends an event", async () => {
    const env = await boot();
    try {
        const { h, sid } = await seeded(env);
        env.model.nextTurn(textTurn("answered", 900)); // 900 >= 1000 * 0.7
        env.model.nextTurn(textTurn("A short summary of the earlier part.", 50));

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });

        const compaction = summaryOf(h, sid);
        assert.ok(compaction, "a compaction event was appended");
        assert.equal(compaction.summary, "A short summary of the earlier part.");
        assert.equal(compaction.covers[0], 1, "the summary anchors at the session's first seq");
        assert.ok(compaction.covers[1] >= 3);

        const scopes = env.db.listLlmCalls(20).map((r) => r.scope);
        assert.ok(scopes.includes("toto:compaction"), "the summarize call is accounted");

        const entry = await env.core.sessions.ensure("toto", sid);
        assert.equal(env.core.sessions.history(entry)[0]?.content, compaction.summary);
    } finally {
        await env.stop();
    }
});

test("below the threshold nothing is compacted and no extra call is made", async () => {
    const env = await boot();
    try {
        const { h, sid } = await seeded(env);
        env.model.nextTurn(textTurn("answered", 100));

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });
        assert.equal(summaryOf(h, sid), null);
        assert.equal(env.model.requests.length, 1, "no summarize call");
    } finally {
        await env.stop();
    }
});

test("a summarize that does not finish cleanly compacts NOTHING", async () => {
    const env = await boot();
    try {
        const { h, sid } = await seeded(env);
        env.model.nextTurn(textTurn("answered", 900));
        env.model.nextTurn({
            events: [
                { kind: "text", text: "half a summ" },
                { kind: "finish", reason: "length" },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 20 },
        });

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });
        assert.equal(summaryOf(h, sid), null, "real history is never replaced by a stub");
        const rows = env.db.listLlmCalls(20).filter((r) => r.scope === "toto:compaction");
        assert.equal(rows.length, 1, "the failed summarize is still accounted");
    } finally {
        await env.stop();
    }
});

test("a summarize whose provider cannot be built any more is accounted and skipped, never failing the answered turn", async () => {
    const env = await boot();
    const keyed = createFakeModel();
    const sharedKey = process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENROUTER_API_KEY"];
    process.env["KEYED_API_KEY"] = "k";
    try {
        addModel({ name: "keyed", provider: "openrouter", endpoint: await keyed.listen(), modelId: "m", contextTokens: 1000 }, env.db);
        env.pin("toto");
        env.db.setModelsPolicy("toto", { allowed: ["keyed"], primary: "keyed" });
        const h = await env.connect(
            {
                name: "toto",
                tools: [{ name: "rotate", writes: false, parameters: { type: "object", properties: {} } }],
                handlers: {
                    rotate: () => {
                        delete process.env["KEYED_API_KEY"];
                        return { text: "key rotated out" };
                    },
                },
            },
            false,
        );
        await waitFor(() => env.core.agent("toto").connected, 4000, "toto ready");
        const sid = h.createSession("seeded", true);
        h.append(sid, Array.from({ length: 12 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", BODY)));

        keyed.nextTurn(callTurn([{ id: "c1", name: "rotate" }]));
        keyed.nextTurn(textTurn("answered", 900));
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });
        assert.equal(out.text, "answered");
        assert.equal(summaryOf(h, sid), null);

        const cut = await env.api<{ compacted: boolean }>("POST", `/api/agents/toto/conversations/${sid}/compact`);
        assert.equal(cut.status, 200);
        assert.equal(cut.json.compacted, false);
        assert.deepEqual(
            env.db.listLlmCalls(2).map((r) => [r.scope, r.registryModel, r.model, r.finishReason]),
            [
                ["toto:compaction", "keyed", null, "error"],
                ["toto:compaction", "keyed", null, "error"],
            ],
        );
        assert.equal(keyed.requests.length, 2, "only the turn's two rounds reached the model");
        assert.deepEqual(
            env.db.usageMatrix("").map((r) => [r.model, r.calls]),
            [["m", 2]],
            "a provider never built leaves trace rows, never a model call",
        );
    } finally {
        if (sharedKey === undefined) delete process.env["OPENROUTER_API_KEY"];
        else process.env["OPENROUTER_API_KEY"] = sharedKey;
        delete process.env["KEYED_API_KEY"];
        await keyed.close();
        await env.stop();
    }
});

test("a second compaction never covers a message it did not summarize", () => {
    // this compaction is written late, so it stands at a seq well above the plain messages that follow it in the fold
    const events: StoredEvent[] = [];
    let hash = "";
    const push = (b: EventBody): void => {
        const seq = events.length + 1;
        hash = chainHash(hash, { seq, type: b.type, payload: b.payload });
        events.push({ ...b, seq, hash, createdAt: 0 } as StoredEvent);
    };
    for (let i = 1; i <= 8; i++) push(msg(i % 2 ? "user" : "assistant", `old ${i}`));
    push(msg("user", "B1 ".padEnd(1000, "x")));
    push(msg("assistant", "B2 ".padEnd(1000, "y")));
    push(msg("user", "TAIL A"));
    push(msg("assistant", "TAIL B"));
    push({ type: "compaction", payload: { summary: "S1 ".padEnd(1200, "s"), covers: [1, 8] } });
    push(msg("user", "N ".padEnd(1000, "z")));

    const entries = foldEvents(events);
    const plan = planCompaction(entries, events[0]!.seq, {
        at: 0.7,
        keepTailTokens: 500,
        minPrefixTokens: 250,
    });
    assert.ok(plan, "the prefix is big enough to compact");
    assert.equal(plan.lines.some((l) => l.includes("TAIL")), false, "the tail was not summarized");

    push({ type: "compaction", payload: { summary: "S2", covers: plan.covers } });
    const after = foldEvents(events).map((e) => String(e.message.content));
    assert.ok(after.some((c) => c.startsWith("TAIL A")), "an unsummarized message must survive");
    assert.ok(after.some((c) => c.startsWith("TAIL B")));
    assert.equal(after[0], "S2");
});

test("thresholds are fractions of contextTokens, and vanish without one", () => {
    const base = {
        name: "m",
        modelUid: "uid-m",
        provider: "llamacpp",
        endpointUrl: "http://x",
        params: {},
        vision: false,
        isDefault: true,
        priceInPerM: 0,
        priceOutPerM: 0,
        limit: null,
    };
    const dir = mkdtempSync(join(tmpdir(), "mimi-thr-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    try {
        assert.equal(thresholdsFor({ ...base, contextTokens: 0 }, db), null);
        assert.equal(thresholdsFor(null, db), null);

        const big = thresholdsFor({ ...base, contextTokens: 200_000 }, db)!;
        assert.equal(big.at, 0.6);
        assert.equal(big.keepTailTokens, 30_000);
        assert.equal(big.minPrefixTokens, 10_000);

        // floors keep a tiny window usable instead of producing a zero-token tail
        const small = thresholdsFor({ ...base, contextTokens: 100 }, db)!;
        assert.equal(small.keepTailTokens, 500);
        assert.equal(small.minPrefixTokens, 250);

        const overridden = thresholdsFor(
            { ...base, contextTokens: 100_000, params: { compaction: { at: 0.5, keepTail: 0.1 } } },
            db,
        )!;
        assert.equal(overridden.at, 0.5);
        assert.equal(overridden.keepTailTokens, 10_000);
        assert.equal(overridden.minPrefixTokens, 5_000);
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an oversized last entry never folds the question it answers", () => {
    const t = { at: 0.6, keepTailTokens: 500, minPrefixTokens: 250 };
    const bodies: EventBody[] = [];
    for (let i = 0; i < 8; i++) bodies.push(msg(i % 2 === 0 ? "user" : "assistant", `old ${i} `.padEnd(600, "x")));
    bodies.push(msg("user", "QUESTION"));
    bodies.push({
        type: "message",
        payload: { role: "assistant", content: null, tool_calls: [{ id: "c1", name: "fetch", arguments: "{}" }] },
    });
    bodies.push({ type: "message", payload: { role: "tool", tool_call_id: "c1", content: "r".repeat(5_000) } });
    const events = logOf(bodies);

    const plan = planCompaction(foldEvents(events), 1, t);
    assert.ok(plan, "the old part is still compacted");
    assert.equal(plan.lines.some((l) => l.includes("QUESTION")), false, "the question stays in the prompt");
    assert.equal(plan.covers[1], 8, "the summary ends right before the question");

    // no user message to hold on to, and a last entry bigger than the tail: nothing would be kept, so nothing is folded
    const notes = Array.from({ length: 8 }, (_, i) => msg("assistant", `note ${i} `.padEnd(600, "y")));
    const noUser = logOf([...notes, msg("assistant", "z".repeat(5_000))]);
    assert.equal(planCompaction(foldEvents(noUser), 1, t), null);
});

test("the summarizer reads where images were: an images-only message stays in the transcript", () => {
    const t = { at: 0.6, keepTailTokens: 500, minPrefixTokens: 250 };
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const events = logOf([
        { type: "message", payload: { role: "user", content: "", images: [png] } },
        msg("assistant", "a cat on a sofa ".padEnd(600, "x")),
        { type: "message", payload: { role: "user", content: "and these?", images: [png, png] } },
        msg("assistant", "two more cats ".padEnd(600, "x")),
        msg("user", "QUESTION"),
        msg("assistant", "z".repeat(5_000)),
    ]);

    const plan = planCompaction(foldEvents(events), 1, t);
    assert.ok(plan);
    assert.deepEqual(plan.lines.map((l) => l.slice(0, 30)), [
        "user: [1 image]",
        "assistant: a cat on a sofa xxx",
        "user: [2 images] and these?",
        "assistant: two more cats xxxxx",
    ]);
});

test("manual compaction asks the agent's own model and keeps only a summary that finished cleanly", async () => {
    const env = await boot();
    const roomy = createFakeModel();
    try {
        addModel({ name: "roomy", provider: "llamacpp", endpoint: await roomy.listen(), contextTokens: 1000 }, env.db);
        env.pin("toto");
        env.db.setModelsPolicy("toto", { allowed: ["fake", "roomy"], primary: "roomy" });
        const h = await env.connect({ name: "toto", tools: [], handlers: {} }, false);
        await waitFor(() => env.core.agent("toto").connected, 4000, "toto ready");
        const sid = h.createSession("seeded", true);
        h.append(sid, Array.from({ length: 12 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", BODY)));
        const compact = (): Promise<{ json: { compacted: boolean; reason?: string } }> =>
            env.api("POST", `/api/agents/toto/conversations/${sid}/compact`);

        roomy.nextTurn({
            events: [
                { kind: "text", text: "half a summ" },
                { kind: "finish", reason: "length" },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 20 },
        });
        const cut = await compact();
        assert.equal(cut.json.compacted, false, "a summary cut off by the token limit is not a summary");
        assert.equal(summaryOf(h, sid), null);

        roomy.nextTurn(textTurn("The whole earlier part, summarized."));
        const done = await compact();
        assert.equal(done.json.compacted, true, JSON.stringify(done.json));
        assert.equal(summaryOf(h, sid)?.summary, "The whole earlier part, summarized.");
        assert.equal(env.model.requests.length, 0, "the default model was never asked");
        assert.deepEqual(
            env.db.listLlmCalls(5).map((r) => [r.scope, r.registryModel, r.finishReason]),
            [
                ["toto:compaction", "roomy", "stop"],
                ["toto:compaction", "roomy", "length"],
            ],
        );
    } finally {
        await roomy.close();
        await env.stop();
    }
});
