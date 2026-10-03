/** What a model is shown: the agent's own system prompt, images only to a model that sees them, and only inline ones. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import type { Message } from "@mimi-os/protocol";
import { createFakeModel, type FakeModel } from "@mimi-os/sdk/testing";

import { addModel } from "../src/llm/models.ts";
import type { ModelsPolicy } from "../src/store/db.ts";
import type { Harness } from "./agent-harness.ts";
import { boot, textTurn, waitFor, type Env } from "./harness-env.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const OMITTED = "[image omitted: this model cannot see images]";

type WireMessage = { role: string; content: unknown };
const sentMessages = (m: FakeModel, i: number): WireMessage[] => m.requests[i]?.["messages"] as WireMessage[];

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
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: PNG } },
        ]);

        env.model.nextTurn(textTurn("still a cat"));
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "and now?", model: "fake", title: false });
        assert.equal(out.text, "still a cat", "the chat keeps working after switching to a text-only model");
        const blind = sentMessages(env.model, 0);
        assert.equal(blind.find((m) => m.role === "user")?.content, `what is this?\n${OMITTED}`);
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
        assert.equal(sentMessages(env.model, 0).find((m) => m.role === "user")?.content, `what is this?\n${OMITTED}`);
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
        assert.match(String(system?.content), /^You are Toto, a terse planner\.\n\nThe owner's cat is called Miso\.\n\nCurrent date\/time: \d{4}-\d\d-\d\d \d\d:\d\d$/);
        assert.deepEqual(user, { role: "user", content: "the cat?" });

        env.model.nextTurn(textTurn("Miso"));
        await env.core.runTurn({ agent: "toto", session: h.createSession(), text: "the cat?", title: false });
        const undated = (m: WireMessage | undefined): string => String(m?.content).replace(/Current date\/time: .*$/, "");
        assert.equal(undated(sentMessages(env.model, 1)[0]), undated(system), "one builder for both");

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
