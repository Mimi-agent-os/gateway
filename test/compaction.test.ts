/** Thresholds as fractions of contextTokens; compaction fires, or provably does not. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chainHash, foldEvents, IMAGE_TOKENS } from "@mimi-os/protocol";
import type { CompactionPayload, EventBody, Message, StoredEvent } from "@mimi-os/protocol";
import { createFakeModel, type ScriptedTurn } from "@mimi-os/sdk/testing";
import { addModel, setDefaultModel } from "../src/llm/models.ts";
import { olderImages, parseNotes, planCompaction, thresholdsFor } from "../src/turn/compaction.ts";
import { momentStamp } from "../src/turn/prompt.ts";
import { GatewayDb } from "../src/store/db.ts";
import { HELD_IMAGES, IMAGE_NOT_SHOWN } from "../src/turn/sessions.ts";
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
        assert.equal(compaction.covers?.[0], 1, "the summary anchors at the session's first seq");
        assert.ok(compaction.covers![1] >= 3);

        const scopes = env.db.listLlmCalls(20).map((r) => r.scope);
        assert.ok(scopes.includes("toto:compaction"), "the summarize call is accounted");

        const entry = await env.core.sessions.ensure("toto", sid);
        assert.equal(env.core.sessions.history(entry)[0]?.content, compaction.summary);
    } finally {
        await env.stop();
    }
});

test("the summarizer reads each user line with the time it was said, so a summary can keep the dates", async () => {
    const env = await boot();
    try {
        const { h, sid } = await seeded(env);
        const said = Date.UTC(2026, 9, 5, 6, 30);
        for (const ev of h.sessions.get(sid)!.events) ev.createdAt = said;
        env.model.nextTurn(textTurn("answered", 900));
        env.model.nextTurn(textTurn("On Monday the owner asked for x.", 50));

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });

        const transcript = String((env.model.requests[1]?.["messages"] as Message[])[1]?.content);
        assert.ok(transcript.includes(`\nuser: [${momentStamp(said)}]\n${BODY.slice(0, 100)}`), transcript.slice(0, 400));
        assert.equal(transcript.includes("assistant: ["), false, "only the user's lines carry a time");
        assert.equal(summaryOf(h, sid)?.summary, "On Monday the owner asked for x.");
    } finally {
        await env.stop();
    }
});

test("a compaction mid-turn keeps the turn's opening line, stamped, as the newest line the next round reads", async () => {
    const env = await boot();
    try {
        const { h, sid } = await seeded(env);
        env.model.nextTurn(callTurn([{ id: "t1", name: "get_time" }], 900));
        env.model.nextTurn(textTurn("A short summary of the earlier part.", 50));
        env.model.nextTurn(textTurn("answered"));

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });

        assert.ok(h.sessions.get(sid)!.events.some((e) => e.type === "compaction"), "it compacted between the rounds");
        const opening = env.core.sessions.entry("toto", sid)!.events.find((e) => e.type === "message" && (e.payload as Message).content === "go")!;
        const next = env.model.requests[2]?.["messages"] as Message[];
        assert.equal(next[1]?.content, "A short summary of the earlier part.");
        assert.equal(next.findLast((m) => m.role === "user")?.content, `[${momentStamp(opening.createdAt)}]\ngo`);
        assert.deepEqual(next.slice(-2).map((m) => m.role), ["assistant", "tool"], "the round it compacted after follows the opening line");
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
        keepImages: 12,
        imagesAt: 25,
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
        maxParallel: null,
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
    const t = { at: 0.6, keepTailTokens: 500, minPrefixTokens: 250, keepImages: 12, imagesAt: 25 };
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
    const t = { at: 0.6, keepTailTokens: 500, minPrefixTokens: 250, keepImages: 12, imagesAt: 25 };
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

const img = (n: number): string => `data:image/png;base64,${String(n).padStart(40, "A")}`;
const album = (from: number, count: number): string[] => Array.from({ length: count }, (_v, i) => img(from + i));
const pictured = (content: string, images: string[]): EventBody => ({ type: "message", payload: { role: "user", content, images } });
const DESCRIBE_SYSTEM = "You turn images into the words that will replace them in a conversation log.";

/** The describe call's answer: one numbered line per image, `what` and the number it stands for. */
const lines = (count: number, what: string): ScriptedTurn => textTurn(Array.from({ length: count }, (_v, i) => `${i + 1}: ${what} ${i + 1}`).join("\n"));

type WirePart = { type: string; text?: string; image_url?: { url: string } };
type WireMessage = { role: string; content: string | WirePart[] | null };
const sent = (env: Env, i: number): WireMessage[] => env.model.requests[i]?.["messages"] as WireMessage[];
const partsOf = (m: WireMessage | undefined): WirePart[] => (Array.isArray(m?.content) ? m.content : []);
const textOf = (m: WireMessage | undefined): string =>
    typeof m?.content === "string" ? m.content : partsOf(m).map((p) => p.text ?? "").join("");

/** The default model becomes "eye": the fake endpoint, seeing images, with this window. */
function eye(env: Env, contextTokens = 128_000): void {
    addModel({ name: "eye", provider: "llamacpp", endpoint: env.model.url, contextTokens, vision: true }, env.db);
    setDefaultModel("eye", env.db);
}

const compactions = (h: Harness, sid: number): CompactionPayload[] =>
    h.sessions.get(sid)!.events.filter((e) => e.type === "compaction").map((e) => e.payload as CompactionPayload);

test("image thresholds are counts from window fractions: keep 12 and fold past 25 at 128k, clamped at both ends, overridable", () => {
    const base = {
        name: "m",
        modelUid: "uid-m",
        provider: "llamacpp",
        endpointUrl: "http://x",
        params: {},
        vision: true,
        maxParallel: null,
        isDefault: true,
        priceInPerM: 0,
        priceOutPerM: 0,
        limit: null,
    };
    const dir = mkdtempSync(join(tmpdir(), "mimi-thr-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    try {
        const counts = (contextTokens: number, params: Record<string, unknown> = {}): number[] => {
            const t = thresholdsFor({ ...base, contextTokens, params }, db)!;
            return [t.keepImages, t.imagesAt];
        };
        assert.deepEqual(counts(128_000), [12, 25]);
        assert.deepEqual(counts(32_000), [3, 6]);
        // a tiny window still keeps the newest image and folds past one more
        assert.deepEqual(counts(1_000), [1, 2]);
        // a huge one keeps at most a full message and folds before the cache runs out of held images
        assert.deepEqual(counts(1_000_000), [32, 64]);
        assert.deepEqual(counts(128_000, { compaction: { keepImages: 0.05, imagesAt: 0.5 } }), [4, 42]);
        assert.deepEqual(counts(128_000, { compaction: { keepImages: 2, imagesAt: "x" } }), [12, 25], "a fraction or nothing");
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("describe lines are read by their number; a missing, foreign or repeated one leaves its slot empty, a long one is cut", () => {
    const long = "w".repeat(900);
    assert.deepEqual(
        parseNotes(
            [
                "Here are the descriptions:",
                "1: a receipt from Bakery Lviv, 2 croissants, 6.40 EUR, 2026-10-12",
                "**2.** a cat on a sofa",
                "3) a bridge at night",
                "- 5: a dog",
                "2: a second try",
                "7: out of range",
                "0: none",
                `6: ${long}`,
            ].join("\n"),
            6,
        ),
        [
            "a receipt from Bakery Lviv, 2 croissants, 6.40 EUR, 2026-10-12",
            "a cat on a sofa",
            "a bridge at night",
            "",
            "a dog",
            `${"w".repeat(799)}…`,
        ],
    );
    assert.deepEqual(parseNotes("", 2), ["", ""]);
});

test("the pixel window keeps the newest whole messages within keepImages, and the newest one whatever its size", () => {
    const pictures = new Map([[1, 4], [3, 6], [5, 5], [7, 3]]);
    assert.deepEqual(olderImages(pictures, 12), [1, 3]);
    assert.deepEqual(olderImages(pictures, 2), [1, 3, 5], "the newest stays even past keepImages");
    assert.deepEqual(olderImages(pictures, 100), []);
    assert.deepEqual(olderImages(new Map(), 12), []);
    // contiguous from the newest: a smaller older message does not slip back into the window
    assert.deepEqual(olderImages(new Map([[1, 1], [2, 10], [3, 5]]), 12), [1, 2]);
});

test("an image-heavy prefix qualifies on what its undescribed images cost the window; the tail walk counts words only", () => {
    const t = { at: 0.6, keepTailTokens: 500, minPrefixTokens: 4_000, keepImages: 12, imagesAt: 25 };
    const entries = foldEvents(logOf([
        pictured("look", album(1, 2)),
        msg("assistant", "ok"),
        pictured("", album(3, 1)),
        msg("assistant", "ok2"),
        msg("user", "QUESTION"),
        msg("assistant", "z".repeat(2_500)),
    ]));
    assert.equal(planCompaction(entries, 1, t), null, "by its words alone the prefix is too small");
    const plan = planCompaction(entries, 1, t, new Map([[1, 2], [3, 1]]));
    assert.ok(plan);
    assert.equal(plan.prefixTokens, Math.round(9 / 4 + 3 * IMAGE_TOKENS));
    assert.deepEqual(plan.covers, [1, 4]);
    assert.deepEqual(plan.lines, ["user: [2 images] look", "assistant: ok", "user: [1 image]", "assistant: ok2"]);
});

test("past imagesAt, a vision turn describes the older images BEFORE its first call and stores only their notes", async () => {
    const env = await boot();
    try {
        eye(env);
        const h = await env.connect({ name: "toto", tools: [], handlers: {} });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        const sid = h.createSession("photos", true);
        // 32 undescribed images at seqs 1, 3, 5, 7: past the 25 a 128k window folds at
        for (let m = 0; m < 4; m++) h.append(sid, [pictured(`batch ${m}`, album(m * 10, 8)), msg("assistant", `seen ${m}`)]);
        env.model.nextTurn(lines(8, "receipt"));
        env.model.nextTurn(lines(8, "cat"));
        env.model.nextTurn(lines(8, "bridge"));
        env.model.nextTurn(textTurn("all clear"));
        const events: Array<Record<string, unknown>> = [];
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "and now?", title: false, emit: (ev) => void events.push(ev) });
        assert.equal(out.text, "all clear");

        // three describe calls of eight, one message each, then the turn
        assert.equal(env.model.requests.length, 4);
        for (const [i, from] of [[0, 0], [1, 10], [2, 20]] as const) {
            const asked = sent(env, i);
            assert.equal(asked[0]?.content, DESCRIBE_SYSTEM);
            assert.ok(textOf(asked[1]).endsWith(`\n\nImages 1-8 came with the message: batch ${from / 10}`));
            assert.deepEqual(partsOf(asked[1]).filter((p) => p.type === "image_url").map((p) => p.image_url?.url), album(from, 8));
        }
        const turn = sent(env, 3).filter((m) => m.role === "user");
        assert.deepEqual(turn.map((m) => partsOf(m).filter((p) => p.type === "image_url").length), [0, 0, 0, 8, 0], "the newest eight stay pixels");
        assert.ok(textOf(turn[0]).endsWith(Array.from({ length: 8 }, (_v, i) => `[earlier image: receipt ${i + 1}]`).join("\n")));
        assert.ok(textOf(turn[2]).includes("[earlier image: bridge 8]"));

        assert.deepEqual(compactions(h, sid), [{
            images: [
                { seq: 1, notes: Array.from({ length: 8 }, (_v, i) => `receipt ${i + 1}`) },
                { seq: 3, notes: Array.from({ length: 8 }, (_v, i) => `cat ${i + 1}`) },
                { seq: 5, notes: Array.from({ length: 8 }, (_v, i) => `bridge ${i + 1}`) },
            ],
        }]);
        const seqs = h.sessions.get(sid)!.events.map((e) => [e.seq, e.type]);
        assert.deepEqual(seqs.slice(8), [[9, "message"], [10, "compaction"], [11, "message"]], "the notes come after the turn's own message, before its answer");
        assert.deepEqual(
            env.db.listLlmCalls(10).map((r) => [r.scope, r.callKind, r.turnSeq]).reverse(),
            [["toto:compaction", "compaction", 9], ["toto:compaction", "compaction", 9], ["toto:compaction", "compaction", 9], ["toto", "turn", 9]],
        );
        assert.equal(events.some((ev) => ev["type"] === "compacted"), false, "an images-only pass emits no turn event");
        assert.ok(env.logs.some((l) => l.includes("described the images of 3 messages (32 were undescribed)")));

        // the next turn starts under the threshold: no describe call at all
        env.model.nextTurn(textTurn("still clear"));
        await env.core.runTurn({ agent: "toto", session: sid, text: "ok", title: false });
        assert.equal(env.model.requests.length, 5);
    } finally {
        await env.stop();
    }
});

test("a describe batch that fails leaves its images as pixels: a message gets notes only when every image got a line", async () => {
    const env = await boot();
    try {
        eye(env);
        const h = await env.connect({ name: "toto", tools: [], handlers: {} });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        const sid = h.createSession("photos", true);
        // 30 images: the newest two messages (12) stay, 18 fold in batches [6 + 2], [4 + 4], [2]
        for (let m = 0; m < 5; m++) h.append(sid, [pictured(`m${m}`, album(m * 10, 6)), msg("assistant", `seen ${m}`)]);
        env.model.nextTurn(lines(8, "ok"));
        env.model.nextTurn({ events: [{ kind: "text", text: "1: half" }, { kind: "finish", reason: "length" }], usage: { prompt_tokens: 9, completion_tokens: 9 } });
        env.model.nextTurn(textTurn("1: tail one"));
        env.model.nextTurn(textTurn("answered"));
        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });

        assert.deepEqual(textOf(sent(env, 0)[1]).split("\n").slice(-2), ["Images 1-6 came with the message: m0", "Images 7-8 came with the message: m1"]);
        assert.deepEqual(textOf(sent(env, 1)[1]).split("\n").slice(-2), ["Images 1-4 came with the message: m1", "Images 5-8 came with the message: m2"]);
        assert.deepEqual(textOf(sent(env, 2)[1]).split("\n").slice(-1), ["Images 1-2 came with the message: m2"]);
        // seq 1 is whole; seq 3 lost its last four lines and seq 5 its first four; the third batch named only one of two
        assert.deepEqual(compactions(h, sid), [{ images: [{ seq: 1, notes: Array.from({ length: 6 }, (_v, i) => `ok ${i + 1}`) }] }]);
        const turn = sent(env, 3).filter((m) => m.role === "user");
        assert.deepEqual(turn.map((m) => partsOf(m).filter((p) => p.type === "image_url").length), [0, 6, 6, 6, 6, 0]);
        assert.equal(env.db.listLlmCalls(10).filter((r) => r.callKind === "compaction").length, 3, "every describe call is accounted");
    } finally {
        await env.stop();
    }
});

test("a text-only model describes nothing: its images read as the omitted marker and the summary counts them", async () => {
    const env = await boot({ contextTokens: 10_000 });
    try {
        const h = await env.connect({ name: "toto", tools: [], handlers: {} });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        const sid = h.createSession("photos", true);
        const bodies: EventBody[] = [pictured(BODY, album(1, 30))];
        for (let i = 1; i < 20; i++) bodies.push(msg(i % 2 === 0 ? "user" : "assistant", BODY));
        h.append(sid, bodies);
        env.model.nextTurn(textTurn("answered", 9_000));
        env.model.nextTurn(textTurn("The owner sent thirty photos."));
        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });

        assert.equal(env.model.requests.length, 2, "the turn, then the summary: no describe call");
        assert.ok(textOf(sent(env, 0)[1]).endsWith("\n[image omitted: this model cannot see images]"));
        assert.match(textOf(sent(env, 1)[1]), /\nuser: \[30 images\] \[/);
        assert.deepEqual(Object.keys(compactions(h, sid)[0]!), ["summary", "covers"]);
    } finally {
        await env.stop();
    }
});

test("a summary on a vision model describes the prefix's images first and reads their notes; a failed summary still keeps them", async () => {
    const env = await boot();
    try {
        eye(env, 10_000);
        const h = await env.connect({ name: "toto", tools: [], handlers: {} });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        const sid = h.createSession("photos", true);
        const bodies: EventBody[] = [pictured("my receipt", [img(1)])];
        for (let i = 1; i < 20; i++) bodies.push(msg(i % 2 === 0 ? "user" : "assistant", BODY));
        h.append(sid, bodies);

        // the summary is cut off: no summary, but the notes are stored on their own
        env.model.nextTurn(textTurn("answered", 9_000));
        env.model.nextTurn(textTurn("1: a receipt from Bakery Lviv, 6.40 EUR"));
        env.model.nextTurn({ events: [{ kind: "text", text: "half" }, { kind: "finish", reason: "length" }], usage: { prompt_tokens: 9, completion_tokens: 9 } });
        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });
        assert.equal(sent(env, 1)[0]?.content, DESCRIBE_SYSTEM);
        const transcript = textOf(sent(env, 2)[1]);
        assert.ok(transcript.includes("my receipt\n[earlier image: a receipt from Bakery Lviv, 6.40 EUR]\nassistant: "), transcript.slice(0, 400));
        assert.equal(transcript.includes("[1 image]"), false);
        assert.deepEqual(compactions(h, sid), [{ images: [{ seq: 1, notes: ["a receipt from Bakery Lviv, 6.40 EUR"] }] }]);

        // the next summary finds the image described already: no describe call, the notes in its transcript
        env.model.nextTurn(textTurn("answered", 9_000));
        env.model.nextTurn(textTurn("The owner shared a receipt."));
        await env.core.runTurn({ agent: "toto", session: sid, text: "again", title: false });
        assert.equal(env.model.requests.length, 5);
        assert.ok(textOf(sent(env, 4)[1]).includes("my receipt\n[earlier image: a receipt from Bakery Lviv, 6.40 EUR]"));
        const last = compactions(h, sid).at(-1)!;
        assert.equal(last.summary, "The owner shared a receipt.");
        assert.equal(last.images, undefined);
        assert.equal(last.covers?.[0], 1);
    } finally {
        await env.stop();
    }
});

test("manual compaction runs the same pass: older images described, the prefix summarized, one event", async () => {
    const env = await boot();
    try {
        eye(env, 10_000);
        const h = await env.connect({ name: "toto", tools: [], handlers: {} });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        const sid = h.createSession("photos", true);
        const bodies: EventBody[] = [pictured("first", album(1, 2))];
        for (let i = 1; i < 18; i++) bodies.push(msg(i % 2 === 0 ? "user" : "assistant", BODY));
        bodies.push(pictured("newest", album(10, 2)), msg("assistant", "seen"));
        h.append(sid, bodies);

        env.model.nextTurn(lines(2, "photo"));
        env.model.nextTurn(textTurn("Earlier: two photos and a long talk."));
        const cut = await env.api<{ compacted: boolean; covers?: [number, number] }>("POST", `/api/agents/toto/conversations/${sid}/compact`);
        assert.equal(cut.status, 200);
        assert.equal(cut.json.compacted, true);
        assert.deepEqual(compactions(h, sid), [{
            summary: "Earlier: two photos and a long talk.",
            covers: cut.json.covers,
            images: [{ seq: 1, notes: ["photo 1", "photo 2"] }],
        }]);
        assert.equal(partsOf(sent(env, 0)[1]).filter((p) => p.type === "image_url").length, 2, "the newest message stays as pixels");
    } finally {
        await env.stop();
    }
});

test("while describing keeps failing the cache still holds at most HELD_IMAGES: older images read as waiting, never as pixels", async () => {
    const env = await boot();
    try {
        eye(env);
        const h = await env.connect({ name: "toto", tools: [], handlers: {} });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        const sid = h.createSession("photos", true);
        for (let m = 0; m < 3; m++) h.append(sid, [pictured(`m${m}`, album(m * 100, 20))]);
        // 60 seeded + 10 new: the 60 older ones go to eight describe calls, each answered with no usable line
        for (let i = 0; i < 8; i++) env.model.nextTurn(textTurn("Sorry, I cannot help with that."));
        env.model.nextTurn(textTurn("seventy photos"));
        await env.core.runTurn({ agent: "toto", session: sid, text: "more", images: album(900, 10), title: false });

        assert.equal(env.model.requests.length, 9);
        assert.deepEqual(compactions(h, sid), [], "no notes, no event: real history is never stubbed");
        const entry = env.core.sessions.entry("toto", sid)!;
        assert.deepEqual([...entry.pixels.keys()].sort((a, b) => a - b), [2, 3, 4]);
        assert.ok([...entry.pixels.values()].reduce((n, uris) => n + uris.length, 0) <= HELD_IMAGES);
        const turn = sent(env, 8).filter((m) => m.role === "user");
        assert.deepEqual(turn.map((m) => partsOf(m).filter((p) => p.type === "image_url").length), [0, 20, 20, 10]);
        assert.equal(textOf(turn[0]).split("\n").filter((l) => l === IMAGE_NOT_SHOWN).length, 20);
    } finally {
        await env.stop();
    }
});

test("a describe that leaves images without a line rests the image fold for ten minutes, then asks only for the images still lacking one", async () => {
    const env = await boot();
    try {
        eye(env);
        const h = await env.connect({ name: "toto", tools: [], handlers: {} });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        const sid = h.createSession("photos", true);
        for (let m = 0; m < 5; m++) h.append(sid, [pictured(`m${m}`, album(m * 10, 6)), msg("assistant", `seen ${m}`)]);
        // as in the failing-batch test: seq 1 is whole, seq 3 keeps its first two lines, seq 5 its fifth
        env.model.nextTurn(lines(8, "ok"));
        env.model.nextTurn({ events: [{ kind: "text", text: "1: half" }, { kind: "finish", reason: "length" }], usage: { prompt_tokens: 9, completion_tokens: 9 } });
        env.model.nextTurn(textTurn("2: tail one"));
        env.model.nextTurn(textTurn("answered"));
        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });
        assert.equal(env.model.requests.length, 4);
        const entry = env.core.sessions.entry("toto", sid)!;
        assert.ok(entry.foldAfter > Date.now() + 9 * 60_000, "the next try waits ten minutes");
        assert.ok(env.logs.some((l) => l.includes("some older images got no description; the next image fold waits until")));
        assert.deepEqual([...entry.drafts], [[3, ["ok 7", "ok 8", "", "", "", ""]], [5, ["", "", "", "", "", "tail one"]]]);

        // four more images carry the chat past imagesAt again, but the fold rests: the turn's own call only
        env.model.nextTurn(textTurn("four more"));
        await env.core.runTurn({ agent: "toto", session: sid, text: "more", images: album(90, 4), title: false });
        assert.equal(env.model.requests.length, 5);

        // ten minutes on: seqs 3, 5 and 7 are past the window, and only their 15 images without a line are asked for
        entry.foldAfter = Date.now() - 1;
        env.model.nextTurn(lines(8, "again"));
        env.model.nextTurn(lines(7, "last"));
        env.model.nextTurn(textTurn("all described"));
        await env.core.runTurn({ agent: "toto", session: sid, text: "now", title: false });
        assert.equal(env.model.requests.length, 8);
        const urls = (i: number): Array<string | undefined> => partsOf(sent(env, i)[1]).filter((p) => p.type === "image_url").map((p) => p.image_url?.url);
        assert.deepEqual(urls(5), [...album(12, 4), ...album(20, 4)]);
        assert.deepEqual(textOf(sent(env, 5)[1]).split("\n").slice(-2), ["Images 1-4 came with the message: m1", "Images 5-8 came with the message: m2"]);
        assert.deepEqual(urls(6), [img(24), ...album(30, 6)]);
        assert.deepEqual(textOf(sent(env, 6)[1]).split("\n").slice(-2), ["Image 1 came with the message: m2", "Images 2-7 came with the message: m3"]);
        assert.deepEqual(compactions(h, sid).at(-1), {
            images: [
                { seq: 3, notes: ["ok 7", "ok 8", "again 1", "again 2", "again 3", "again 4"] },
                { seq: 5, notes: ["again 5", "again 6", "again 7", "again 8", "last 1", "tail one"] },
                { seq: 7, notes: Array.from({ length: 6 }, (_v, i) => `last ${i + 2}`) },
            ],
        });
        assert.equal(entry.drafts.size, 0);
        assert.equal(entry.foldAfter, 0);
    } finally {
        await env.stop();
    }
});
