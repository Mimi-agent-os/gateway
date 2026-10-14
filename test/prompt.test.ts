/** What a model is shown: the agent's own system prompt, images only to a model that sees them, and only inline ones. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import type { Message } from "@mimi-os/protocol";
import { createFakeModel, type FakeModel } from "@mimi-os/sdk/testing";

import { addModel } from "../src/llm/models.ts";
import { setTimeZone, timeZone } from "../src/store/day.ts";
import type { ModelsPolicy } from "../src/store/db.ts";
import { autoTitle } from "../src/turn/autotitle.ts";
import { momentStamp, nowStamp } from "../src/turn/prompt.ts";
import type { Harness } from "./agent-harness.ts";
import { autoApprove, boot, callTurn, textTurn, waitFor, type Env } from "./harness-env.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const OMITTED = "[image omitted: this model cannot see images]";

type WireMessage = { role: string; content: unknown };
const sentMessages = (m: FakeModel, i: number): WireMessage[] => m.requests[i]?.["messages"] as WireMessage[];
/** The newest user line of request `i`: the stamp it opens with is what the model reads as now. */
const newestUser = (m: FakeModel, i: number): unknown => sentMessages(m, i).findLast((x) => x.role === "user")?.content;

/** The stamp toto's user line at `seq` opens with: the time the gateway's cache holds for that event. */
const stampOf = (env: Env, sid: number, seq: number): string =>
    `[${momentStamp(env.core.sessions.entry("toto", sid)!.events.find((e) => e.seq === seq)!.createdAt)}]`;

/** A model endpoint that answers every call with this status and SSE body (or none). */
async function endpoint(status: number, sse = ""): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
    let hits = 0;
    const server: Server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            hits++;
            res.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "application/json" });
            res.end(status === 200 ? sse : '{"error":"refused"}');
        });
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const addr = server.address() as { port: number };
    return {
        url: `http://127.0.0.1:${addr.port}`,
        hits: () => hits,
        close: () => {
            server.closeAllConnections();
            return new Promise((done) => server.close(() => done()));
        },
    };
}

/** "seer" is the one model that sees images; the policy sits on the pin before the handshake. */
async function withSeer(env: Env, policy: ModelsPolicy, seerUrl?: string): Promise<{ h: Harness; seer: FakeModel }> {
    const seer = createFakeModel();
    const url = await seer.listen();
    addModel({ name: "seer", provider: "llamacpp", endpoint: seerUrl ?? url, contextTokens: 1000, vision: true }, env.db);
    env.pin("toto");
    env.db.setModelsPolicy("toto", policy);
    const h = await env.connect({ name: "toto", tools: [], handlers: {} }, false);
    await waitFor(() => env.core.agent("toto").connected, 4000, "toto ready");
    return { h, seer };
}

async function chat(h: Harness, id: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    h.send({ id, type: "chat", payload });
    await waitFor(() => h.frames().some((f) => f["id"] === id && "status" in f), 4000, `the ${id} reply`);
    return h.frames().find((f) => f["id"] === id && "status" in f)!;
}

test("a text-only model reads older photos as a marker, never as multipart it cannot parse", async () => {
    const env = await boot();
    const { h, seer } = await withSeer(env, { allowed: ["fake", "seer"], primary: "seer" });
    try {
        const sid = h.createSession();
        seer.nextTurn(textTurn("a cat"));
        await env.core.runTurn({ agent: "toto", session: sid, text: "what is this?", images: [PNG], title: false });
        const withImage = sentMessages(seer, 0).find((m) => m.role === "user")!;
        assert.deepEqual(withImage.content, [
            { type: "text", text: `${stampOf(env, sid, 1)}\nwhat is this?` },
            { type: "image_url", image_url: { url: PNG } },
        ]);

        env.model.nextTurn(textTurn("still a cat"));
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "and now?", model: "fake", title: false });
        assert.equal(out.text, "still a cat", "the chat keeps working after switching to a text-only model");
        const blind = sentMessages(env.model, 0);
        assert.equal(blind.find((m) => m.role === "user")?.content, `${stampOf(env, sid, 1)}\nwhat is this?\n${OMITTED}`);
        assert.ok(blind.every((m) => typeof m.content === "string" || m.content === null), "no multipart at all");
    } finally {
        await seer.close();
        await env.stop();
    }
});

test("a turn carrying images never falls back to a text-only model; one without images still does", async () => {
    const env = await boot();
    const down = await endpoint(400);
    const { h, seer } = await withSeer(env, { allowed: ["fake", "seer"], primary: "seer", fallback: "fake" }, down.url);
    try {
        const sid = h.createSession();
        await assert.rejects(
            env.core.runTurn({ agent: "toto", session: sid, text: "what is this?", images: [PNG], title: false }),
            /400/,
        );
        assert.equal(env.model.requests.length, 0, "the text-only fallback was never asked about the photo");
        assert.deepEqual(env.db.listLlmCalls().map((r) => r.scope), ["toto"]);

        env.model.nextTurn(textTurn("answered by the fallback"));
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "just text", title: false });
        assert.equal(out.text, "answered by the fallback");
        assert.equal(
            sentMessages(env.model, 0).find((m) => m.role === "user")?.content,
            `${stampOf(env, sid, 1)}\nwhat is this?\n${OMITTED}`,
        );
    } finally {
        await seer.close();
        await down.close();
        await env.stop();
    }
});

test("a mid-stream provider error is an outage: the fallback answers, and nothing half-written is stored as clean", async () => {
    const env = await boot();
    const flaky = await endpoint(
        200,
        [
            JSON.stringify({ choices: [{ delta: { content: "half an ans" }, finish_reason: null }] }),
            JSON.stringify({ error: { code: 502, message: "Provider disconnected" }, choices: [{ delta: {}, finish_reason: "error" }] }),
        ]
            .map((l) => `data: ${l}\n\n`)
            .join("") + "data: [DONE]\n\n",
    );
    try {
        addModel({ name: "flaky", provider: "llamacpp", endpoint: flaky.url, contextTokens: 1000 }, env.db);
        env.pin("toto");
        env.db.setModelsPolicy("toto", { allowed: ["fake", "flaky"], primary: "flaky", fallback: "fake" });
        env.pin("solo");
        env.db.setModelsPolicy("solo", { allowed: ["flaky"], primary: "flaky" });
        const h = await env.connect({ name: "toto", tools: [], handlers: {} }, false);
        const solo = await env.connect({ name: "solo", tools: [], handlers: {} }, false);
        await waitFor(() => env.core.agent("toto").connected && env.core.agent("solo").connected, 4000, "agents ready");

        env.model.nextTurn(textTurn("recovered"));
        const out = await env.core.runTurn({ agent: "toto", session: h.createSession(), text: "hi", title: false });
        assert.equal(out.text, "recovered");
        const rows = env.db.listLlmCalls().reverse();
        assert.deepEqual(rows.map((r) => [r.registryModel, r.finishReason]), [["flaky", "error"], ["fake", "stop"]]);

        const sid = solo.createSession();
        await assert.rejects(env.core.runTurn({ agent: "solo", session: sid, text: "hi", title: false }), /Provider disconnected/);
        const stored = solo.sessions.get(sid)!.events.map((e) => (e.payload as Message).content);
        assert.deepEqual(stored, ["hi", "half an ans\n[provider error — the response did not complete]"]);
    } finally {
        await flaky.close();
        await env.stop();
    }
});

test("withPrompt: a one-shot opens with the same system prompt a turn builds; without it, nothing is added", async () => {
    const env = await boot();
    try {
        const h = await env.connect({ name: "toto", tools: [], handlers: {} });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        const prompt = [
            { name: "persona", text: "You are Toto, a terse planner." },
            { name: "pack:memory", text: "The owner's cat is called Miso." },
        ];
        h.send({
            id: "rd",
            type: "describe",
            payload: { manifest: { name: "toto", chain: false }, prompt, tools: [] },
        });
        await waitFor(() => h.frames().some((f) => f["id"] === "rd"), 4000, "the re-describe reply");

        env.model.nextTurn(textTurn("Miso"));
        const reply = await chat(h, "with", { messages: [{ role: "user", content: "the cat?" }], withPrompt: true });
        assert.equal(reply["status"], "ok", JSON.stringify(reply));
        const [system, user] = sentMessages(env.model, 0);
        assert.equal(system?.role, "system");
        assert.match(String(system?.content), /^You are Toto, a terse planner\.\n\nThe owner's cat is called Miso\.\n\nA bracketed line [^\n]+$/);
        // no stamp is added: a routine's caller (the crons pack) writes the time into its own line
        assert.deepEqual(user, { role: "user", content: "the cat?" });

        env.model.nextTurn(textTurn("Miso"));
        await env.core.runTurn({ agent: "toto", session: h.createSession(), text: "the cat?", title: false });
        assert.deepEqual(sentMessages(env.model, 1)[0], system, "one builder for both");

        env.model.nextTurn(textTurn("Miso"));
        await chat(h, "without", { messages: [{ role: "user", content: "the cat?" }] });
        assert.deepEqual(sentMessages(env.model, 2), [{ role: "user", content: "the cat?" }]);
    } finally {
        await env.stop();
    }
});

test("a one-shot's images: only inline ones reach a vision model, and a text-only model reads a marker", async () => {
    const env = await boot();
    const { h, seer } = await withSeer(env, { allowed: ["fake", "seer"], primary: "seer" });
    try {
        const messages = [
            { role: "user", content: "look", images: [PNG] },
            { role: "user", content: "and this", images: ["http://192.168.1.1/admin"] },
        ];
        seer.nextTurn(textTurn("seen"));
        assert.equal((await chat(h, "seer", { messages }))["status"], "ok");
        assert.deepEqual(sentMessages(seer, 0), [
            { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: PNG } }] },
            { role: "user", content: "and this" },
        ]);

        env.model.nextTurn(textTurn("described"));
        assert.equal((await chat(h, "blind", { messages, model: "fake" }))["status"], "ok");
        assert.deepEqual(sentMessages(env.model, 0), [
            { role: "user", content: `look\n${OMITTED}` },
            { role: "user", content: `and this\n${OMITTED}` },
        ]);
    } finally {
        await seer.close();
        await env.stop();
    }
});

test("a one-shot with images falls back to a text-only model only when the primary could not see them either", async () => {
    const env = await boot();
    const down = await endpoint(400);
    try {
        addModel({ name: "blind", provider: "llamacpp", endpoint: down.url, contextTokens: 1000 }, env.db);
        addModel({ name: "seer", provider: "llamacpp", endpoint: down.url, contextTokens: 1000, vision: true }, env.db);
        env.pin("toto");
        env.db.setModelsPolicy("toto", { allowed: ["fake", "blind"], primary: "blind", fallback: "fake" });
        env.pin("vis");
        env.db.setModelsPolicy("vis", { allowed: ["fake", "seer"], primary: "seer", fallback: "fake" });
        const toto = await env.connect({ name: "toto", tools: [], handlers: {} }, false);
        const vis = await env.connect({ name: "vis", tools: [], handlers: {} }, false);
        await waitFor(() => env.core.agent("toto").connected && env.core.agent("vis").connected, 4000, "agents ready");
        const messages = [{ role: "user", content: "look", images: [PNG] }];

        assert.equal((await chat(vis, "seen", { messages }))["status"], "error");
        assert.equal(env.model.requests.length, 0, "the text-only fallback never answers blind what the primary could see");

        env.model.nextTurn(textTurn("answered by the fallback"));
        const reply = await chat(toto, "unseen", { messages });
        assert.equal(reply["status"], "ok", JSON.stringify(reply));
        assert.deepEqual(sentMessages(env.model, 0), [{ role: "user", content: `look\n${OMITTED}` }]);
        assert.deepEqual(
            env.db.listLlmCalls().map((r) => [r.scope, r.registryModel, r.finishReason]).reverse(),
            [
                ["vis:chat", "seer", "error"],
                ["toto:chat", "blind", "error"],
                ["toto:chat:fallback", "fake", "stop"],
            ],
        );
    } finally {
        await down.close();
        await env.stop();
    }
});

test("POST …/messages takes only inline images within the wire contract, in a body of about 1 MB", async () => {
    const env = await boot();
    const { h, seer } = await withSeer(env, { allowed: ["fake", "seer"], primary: "seer" });
    try {
        const sid = h.createSession();
        const path = `/api/agents/toto/conversations/${sid}/messages`;
        const big = `data:image/jpeg;base64,${"A".repeat(190_000)}`;
        const refused = [
            ["https://tracker.example/pixel.png"],
            ["data:image/svg+xml;base64,PHN2Zz4="],
            [PNG, PNG, PNG, PNG, PNG],
            [big, big, big, big],
        ];
        const errors: string[] = [];
        for (const images of refused) {
            const r = await env.api<{ error?: string }>("POST", path, { text: "look", images });
            assert.equal(r.status, 400, images[0]!.slice(0, 40));
            errors.push(String(r.json.error));
        }
        assert.match(errors[2]!, /at most 4 images/);
        assert.match(errors[3]!, /total at most 750000 bytes/);
        assert.equal((await env.api("POST", path, { text: "x".repeat(1_100_000) })).status, 400, "the body limit");
        assert.equal(seer.requests.length, 0);
        assert.equal(h.sessions.get(sid)!.events.length, 0, "nothing refused was stored");

        seer.nextTurn(textTurn("four photos"));
        const turn = await env.stream("POST", path, { text: "look", images: [big, big, big, PNG] });
        assert.equal(turn.status, 200);
        await turn.done;
        assert.deepEqual((h.sessions.get(sid)!.events[0]!.payload as Message).images, [big, big, big, PNG]);
    } finally {
        await seer.close();
        await env.stop();
    }
});

test("images alone are a message: a vision model gets only image parts, the history keeps no text, a text-only model reads the note", async () => {
    const env = await boot();
    const { h, seer } = await withSeer(env, { allowed: ["fake", "seer"], primary: "seer" });
    try {
        const sid = h.createSession("photos", true);
        const path = `/api/agents/toto/conversations/${sid}/messages`;
        seer.nextTurn(textTurn("a cat"));
        const turn = await env.stream("POST", path, { text: "", images: [PNG] });
        assert.equal(turn.status, 200);
        await turn.done;
        // the words are only the time it was sent: the stamp is the whole text part
        assert.deepEqual(sentMessages(seer, 0).find((m) => m.role === "user")?.content, [
            { type: "text", text: stampOf(env, sid, 1) },
            { type: "image_url", image_url: { url: PNG } },
        ]);
        const history = await env.api<{ items: { role: string; content: string; images?: string[] }[] }>("GET", path);
        assert.deepEqual(history.json.items.map((m) => [m.role, m.content, m.images]), [
            ["user", "", [PNG]],
            ["assistant", "a cat", undefined],
        ]);

        env.model.nextTurn(textTurn("still a cat"));
        await env.core.runTurn({ agent: "toto", session: sid, text: "and now?", model: "fake", title: false });
        assert.deepEqual(sentMessages(env.model, 0).filter((m) => m.role === "user").map((m) => m.content), [
            `${stampOf(env, sid, 1)}\n${OMITTED}`,
            `${stampOf(env, sid, 3)}\nand now?`,
        ]);
    } finally {
        await seer.close();
        await env.stop();
    }
});

test("POST …/messages refuses a message with neither text nor images", async () => {
    const env = await boot();
    const { h, seer } = await withSeer(env, { allowed: ["fake", "seer"], primary: "seer" });
    try {
        const sid = h.createSession();
        for (const body of [{}, { text: "  \n " }, { text: "", images: [] }]) {
            const r = await env.api<{ error?: string }>("POST", `/api/agents/toto/conversations/${sid}/messages`, body);
            assert.equal(r.status, 400, JSON.stringify(body));
            assert.equal(r.json.error, "pass { text } or { images }");
        }
        assert.equal(seer.requests.length, 0);
        assert.equal(h.sessions.get(sid)!.events.length, 0);
    } finally {
        await seer.close();
        await env.stop();
    }
});

test("a chat opened by images alone is titled from the reply, and nothing to name asks no title at all", async () => {
    const env = await boot();
    const { h, seer } = await withSeer(env, { allowed: ["fake", "seer"], primary: "seer" });
    try {
        const sid = h.createSession();
        seer.nextTurn(textTurn("A bakery receipt for two croissants."));
        seer.nextTurn(textTurn('{"title":"Bakery receipt"}'));
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "", images: [PNG] });
        assert.equal(await out.titling, true);
        assert.equal(h.sessions.get(sid)!.title, "Bakery receipt");
        assert.match(String(sentMessages(seer, 1).at(-1)?.content), /\n\nuser: \[images only\]\nassistant: A bakery receipt for two croissants\.$/);

        const peer = env.core.registry.get("toto")!;
        assert.equal(await autoTitle({ agent: "toto", session: h.createSession(), peer, seed: " ", reply: "", model: "seer", db: env.db }), false);
        assert.equal(seer.requests.length, 2, "no title call with an empty prompt");
        assert.deepEqual(env.db.listLlmCalls().map((r) => r.callKind).reverse(), ["turn", "title"]);
    } finally {
        await seer.close();
        await env.stop();
    }
});

test("an images-only chat whose reply is a gateway note, not model text, asks no title and stays untitled", async () => {
    const env = await boot();
    const { h, seer } = await withSeer(env, { allowed: ["fake", "seer"], primary: "seer" });
    try {
        for (const [reason, note] of [
            ["length", "[response cut off by the token limit]"],
            ["stop", 'No answer produced by the "toto" agent.'],
        ] as const) {
            const sid = h.createSession();
            seer.nextTurn({ events: [{ kind: "finish", reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
            const out = await env.core.runTurn({ agent: "toto", session: sid, text: "", images: [PNG] });
            assert.equal(out.text, note);
            assert.equal(await out.titling, false, reason);
            assert.equal(h.sessions.get(sid)!.title, null, reason);
        }
        assert.equal(seer.requests.length, 2, "no title call for either chat");
    } finally {
        await seer.close();
        await env.stop();
    }
});

/** Run `body` in the owner's zone as boot sets it from MIMI_TZ, then put the test's own back. */
async function inZone(zone: string, body: () => Promise<void> | void): Promise<void> {
    const was = timeZone();
    setTimeZone(zone);
    try {
        await body();
    } finally {
        setTimeZone(was);
    }
}

const NOW = "[A-Z][a-z]+day \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d";

test("a moment reads as weekday, date and time in the owner's zone (MIMI_TZ); now names that zone and its offset", async () => {
    await inZone("Europe/Kyiv", () => {
        assert.equal(momentStamp(Date.UTC(2026, 9, 12, 7, 4)), "Monday 2026-10-12 10:04");
        assert.equal(momentStamp(Date.UTC(2026, 9, 12, 21, 0)), "Tuesday 2026-10-13 00:00", "local midnight turns the weekday too");
        assert.equal(momentStamp(Date.UTC(2026, 0, 12, 21, 59)), "Monday 2026-01-12 23:59", "winter: UTC+02:00");
        // the owner's spelling, never ICU's older Europe/Kiev
        assert.match(nowStamp(), new RegExp(`^${NOW} \\(Europe/Kyiv, UTC\\+0[23]:00\\)$`));
    });
    await inZone("America/New_York", () => {
        assert.equal(momentStamp(Date.UTC(2026, 9, 13, 2, 30)), "Monday 2026-10-12 22:30", "the owner's day, not UTC's or the host's");
        assert.match(nowStamp(), / \(America\/New_York, UTC-0[45]:00\)$/);
    });
    await inZone("Asia/Kolkata", () => assert.match(nowStamp(), / \(Asia\/Kolkata, UTC\+05:30\)$/));
    await inZone("UTC", () => assert.match(nowStamp(), / \(UTC, UTC\+00:00\)$/));
});

test("the system prompt names the zone and offset every stamp is read in, the one get_time answers in", async () => {
    await inZone("Asia/Kolkata", async () => {
        const env = await boot();
        try {
            const h = await env.connect({ name: "toto", tools: [], handlers: {} });
            await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
            env.model.nextTurn(callTurn([{ id: "t1", name: "get_time" }]));
            env.model.nextTurn(textTurn("it is late"));
            await env.core.runTurn({ agent: "toto", session: h.createSession(), text: "what time is it?", title: false });

            const zone = "Asia/Kolkata, UTC\\+05:30";
            // the one note that says what a stamp is, so the model never writes one, and which one is now
            assert.match(
                String(sentMessages(env.model, 0)[0]?.content),
                new RegExp(
                    `\n\nA bracketed line opening a user message is added automatically: [^\n]+ in the owner's time zone \\(${zone}\\)\\. ` +
                        "The newest one is the time now: [^\n]+ Never write one yourself\\.$",
                ),
            );
            assert.match(String(sentMessages(env.model, 1).find((m) => m.role === "tool")?.content), new RegExp(`^${NOW} \\(${zone}\\)$`));
        } finally {
            await env.stop();
        }
    });
});

test("the system prompt holds no clock: two minutes apart it is byte for byte the same, and only the newest stamp moves", async (t) => {
    await inZone("Europe/Kyiv", async () => {
        const env = await boot();
        try {
            const h = await env.connect({ name: "toto", tools: [], handlers: {} });
            await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
            const sid = h.createSession("plans");
            t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 12, 7, 4, 50) });
            env.model.nextTurn(textTurn("one"));
            await env.core.runTurn({ agent: "toto", session: sid, text: "first", title: false });
            t.mock.timers.setTime(Date.UTC(2026, 9, 12, 7, 6, 50));
            env.model.nextTurn(textTurn("two"));
            await env.core.runTurn({ agent: "toto", session: sid, text: "second", title: false });

            const [before, after] = [sentMessages(env.model, 0), sentMessages(env.model, 1)];
            assert.equal(
                before[0]?.content,
                "You are a concise and helpful assistant.\n\nA bracketed line opening a user message is added automatically: " +
                    "when it was sent (in a room, also by whom), in the owner's time zone (Europe/Kyiv, UTC+03:00). The newest one " +
                    "is the time now: count today, tomorrow and every other relative date from it. Never write one yourself.",
            );
            assert.deepEqual(after.map((m) => [m.role, m.content]), [
                ["system", before[0]?.content],
                ["user", "[Monday 2026-10-12 10:04]\nfirst"],
                ["assistant", "one"],
                ["user", "[Monday 2026-10-12 10:06]\nsecond"],
            ]);
            // the whole first request is a prefix of the second, tools included: the provider's prompt cache holds
            assert.equal(JSON.stringify(after.slice(0, before.length)), JSON.stringify(before));
            assert.deepEqual(env.model.requests[1]?.["tools"], env.model.requests[0]?.["tools"]);
        } finally {
            await env.stop();
        }
    });
});

test("an owner's message, the follow-up the app sends once that turn is over, and a delegated task each open stamped with when they started", async (t) => {
    const env = await boot();
    const stopGates = autoApprove(env);
    try {
        const boss = await env.connect({ name: "boss", tools: [], handlers: {} });
        await env.connect({ name: "mate", tools: [], handlers: {} });
        await waitFor(() => env.core.agent("boss").connected && env.core.agent("mate").connected, 4000, "agents ready");
        const sid = boss.createSession("plans");
        const path = `/api/agents/boss/conversations/${sid}/messages`;
        t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
        const start = Date.now();
        const at = (minutes: number): string => `[${momentStamp(start + minutes * 60_000)}]`;

        env.model.nextTurn(textTurn("on it"));
        await (await env.stream("POST", path, { text: "plan my day" })).done;
        assert.equal(newestUser(env.model, 0), `${at(0)}\nplan my day`);

        // a follow-up typed mid-turn waits in the app and is sent after: stamped when it arrives, not when typed
        t.mock.timers.setTime(start + 3 * 60_000);
        env.model.nextTurn(textTurn("tomorrow too"));
        await (await env.stream("POST", path, { text: "and tomorrow?" })).done;
        assert.equal(newestUser(env.model, 1), `${at(3)}\nand tomorrow?`);
        assert.deepEqual(sentMessages(env.model, 1)[0], sentMessages(env.model, 0)[0], "the system line did not move");

        t.mock.timers.setTime(start + 9 * 60_000);
        env.model.nextTurn(callTurn([{ id: "a1", name: "ask_mate", args: '{"task":"count the meetings"}' }]));
        env.model.nextTurn(textTurn("three")); // mate's own turn, run inside the tool
        env.model.nextTurn(textTurn("done"));
        await env.core.runTurn({ agent: "boss", session: sid, text: "ask mate", attended: true, title: false });
        assert.equal(newestUser(env.model, 2), `${at(9)}\nask mate`);
        assert.equal(newestUser(env.model, 3), `${at(9)}\ncount the meetings`, "the delegate's turn opens on the task, stamped");
        assert.equal(newestUser(env.model, 4), `${at(9)}\nask mate`);
    } finally {
        stopGates();
        await env.stop();
    }
});

test("a turn that waited on an approval goes on from the same prompt: the system line unchanged, its opening stamp still the newest", async (t) => {
    const env = await boot();
    try {
        const h = await env.connect({
            name: "toto",
            tools: [{ name: "mail", description: "send the mail", writes: true }],
            handlers: { mail: () => ({ text: "sent" }) },
        });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
        const start = Date.now();
        env.model.nextTurn(callTurn([{ id: "m1", name: "mail" }]));
        env.model.nextTurn(textTurn("mailed"));
        const turn = env.core.runTurn({ agent: "toto", session: h.createSession("mail"), text: "mail them", attended: true, title: false });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the approval");
        t.mock.timers.setTime(start + 4 * 60_000);
        env.core.approvals.answer(env.core.approvals.pending()[0]!.gate, { m1: true });
        assert.equal((await turn).text, "mailed");

        const [asked, resumed] = [sentMessages(env.model, 0), sentMessages(env.model, 1)];
        assert.deepEqual(resumed[0], asked[0]);
        assert.equal(newestUser(env.model, 1), `[${momentStamp(start)}]\nmail them`);
        assert.deepEqual(resumed.at(-1), { role: "tool", tool_call_id: "m1", content: "sent" });
    } finally {
        await env.stop();
    }
});

test("each user line carries the time it was stored — never an assistant, tool, system or summary line, never the log or the app", async () => {
    await inZone("Europe/Kyiv", async () => {
        const env = await boot();
        try {
            const h = await env.connect({ name: "toto", tools: [], handlers: {} });
            await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
            const sid = h.createSession();
            h.append(sid, [
                { type: "message", payload: { role: "user", content: "first question" } },
                { type: "message", payload: { role: "assistant", content: "first answer" } },
                { type: "compaction", payload: { summary: "SUMMARY of the first exchange", covers: [1, 2] } },
                { type: "message", payload: { role: "user", content: "remind me tomorrow to call mom" } },
                { type: "message", payload: { role: "assistant", content: null, tool_calls: [{ id: "c1", name: "note", arguments: "{}" }] } },
                { type: "message", payload: { role: "tool", tool_call_id: "c1", content: "noted" } },
                { type: "message", payload: { role: "assistant", content: "Will do." } },
                { type: "message", payload: { role: "system", content: "a system line" } },
                { type: "message", payload: { role: "user", content: "", images: [PNG] } },
                { type: "message", payload: { role: "assistant", content: "a cat" } },
            ]);
            // the times the agent stored, days apart: what each line is stamped with, never the turn's own now
            const times = [
                Date.UTC(2026, 9, 3, 8, 0), Date.UTC(2026, 9, 3, 8, 1), Date.UTC(2026, 9, 5, 6, 30),
                Date.UTC(2026, 9, 5, 6, 30), Date.UTC(2026, 9, 5, 6, 30), Date.UTC(2026, 9, 5, 6, 31),
                Date.UTC(2026, 9, 5, 6, 31), Date.UTC(2026, 9, 5, 6, 31), Date.UTC(2026, 9, 7, 15, 5),
                Date.UTC(2026, 9, 7, 15, 6),
            ];
            for (const [i, ev] of h.sessions.get(sid)!.events.entries()) ev.createdAt = times[i]!;

            env.model.nextTurn(textTurn("Today is Monday."));
            env.model.nextTurn(textTurn('{"title":"Calling mom"}'));
            const out = await env.core.runTurn({ agent: "toto", session: sid, text: "and today?" });
            assert.equal(await out.titling, true);

            const asked = stampOf(env, sid, 11);
            assert.deepEqual(sentMessages(env.model, 0).slice(1).map((m) => [m.role, m.content]), [
                ["assistant", "SUMMARY of the first exchange"],
                ["user", "[Monday 2026-10-05 09:30]\nremind me tomorrow to call mom"],
                ["assistant", null],
                ["tool", "noted"],
                ["assistant", "Will do."],
                ["system", "a system line"],
                ["user", `[Wednesday 2026-10-07 18:05]\n${OMITTED}`],
                ["assistant", "a cat"],
                ["user", `${asked}\nand today?`],
            ]);
            // a title names a topic: its seed is the words as typed, never a date
            assert.match(String(sentMessages(env.model, 1).at(-1)?.content), /\n\nuser: and today\?$/);

            // the stamps come from stored times: the next turn's prompt repeats this one byte for byte
            const entry = await env.core.sessions.ensure("toto", sid);
            assert.deepEqual(env.core.sessions.history(entry), env.core.sessions.history(entry));
            env.model.nextTurn(textTurn("Still Monday."));
            await env.core.runTurn({ agent: "toto", session: sid, text: "sure?", title: false });
            const first = sentMessages(env.model, 0).slice(1);
            assert.equal(JSON.stringify(sentMessages(env.model, 2).slice(1, first.length + 1)), JSON.stringify(first));

            // model-facing only: the log keeps what was said, and the app shows it as said
            const stored = h.sessions.get(sid)!.events.flatMap((e) => (e.type === "message" ? [(e.payload as Message).content] : []));
            assert.equal(stored.some((c) => typeof c === "string" && /^\[[A-Z][a-z]+day /.test(c)), false, "no stamp in the log");
            assert.ok(stored.includes("and today?") && stored.includes("sure?"));
            const shown = await env.api<{ items: { role: string; content: string }[] }>("GET", `/api/agents/toto/conversations/${sid}/messages`);
            assert.deepEqual(
                shown.json.items.filter((m) => m.role === "user").map((m) => m.content),
                ["first question", "remind me tomorrow to call mom", "", "and today?", "sure?"],
            );
        } finally {
            await env.stop();
        }
    });
});
