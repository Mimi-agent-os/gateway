/** Per-agent model grants: the whitelist, primary, fallback, each model's daily limit, and the model names a policy holds. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { runAgent, setAgentEnv, type AgentRuntime } from "@mimi-os/sdk";
import {
    createFakeModel,
    type FakeAgentOptions,
    type FakeModel,
    type ScriptedTurn,
} from "@mimi-os/sdk/testing";

import { addModel, getModel, patchModel, removeModel, setModelPricing } from "../src/llm/models.ts";
import { newCallId, recordLlmCall } from "../src/store/accounting.ts";
import type { ModelsPolicy } from "../src/store/db.ts";
import { timeZone } from "../src/store/day.ts";
import type { Harness } from "./agent-harness.ts";
import { boot, textTurn, waitFor, type Env } from "./harness-env.ts";

const lengthTurn: ScriptedTurn = {
    events: [
        { kind: "text", text: "partial" },
        { kind: "finish", reason: "length" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
};

/** A second real endpoint, so "which model ran" is answered by which server was hit. */
async function secondModel(env: Env, name = "second"): Promise<FakeModel> {
    const m = createFakeModel();
    const endpoint = await m.listen();
    addModel({ name, provider: "llamacpp", endpoint, contextTokens: 1000 }, env.db);
    return m;
}

/** A model whose endpoint refuses every call with a 400: the call fails at once, with no provider retry. */
async function deadModel(t: TestContext, env: Env, name = "dead"): Promise<void> {
    const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => res.writeHead(400, { "content-type": "application/json" }).end('{"error":"refused"}'));
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    t.after(() => {
        server.closeAllConnections();
        return new Promise<void>((done) => server.close(() => done()));
    });
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    addModel({ name, provider: "llamacpp", endpoint, contextTokens: 1000 }, env.db);
}

/** The policy has to be on the pin BEFORE the handshake for describe_ok to reflect it. */
async function agentWith(
    env: Env,
    name: string,
    policy: ModelsPolicy | null,
    manifest?: FakeAgentOptions["manifest"],
): Promise<Harness> {
    env.pin(name);
    if (policy) env.db.setModelsPolicy(name, policy);
    const h = await env.connect({ name, manifest }, false);
    await waitFor(() => env.core.agent(name).connected, 4000, `${name} ready`);
    return h;
}

const scopes = (env: Env): string[] =>
    env.db
        .listLlmCalls()
        .map((r) => r.scope)
        .reverse();

// ── the whitelist ────────────────────────────────────────────────────────────

test("with no policy an agent may use ONLY the registry's default model", async () => {
    const env = await boot();
    const second = await secondModel(env);
    try {
        const h = await agentWith(env, "toto", null);
        const session = h.createSession();

        // the default runs — and it is the whole grant, not a starting point
        env.model.nextTurn(textTurn("from fake"));
        const ran = await env.core.runTurn({ agent: "toto", session, text: "hi", title: false });
        assert.equal(ran.text, "from fake");

        // any other registry model is refused, and the refusal says how to open it
        await assert.rejects(
            env.core.runTurn({ agent: "toto", session, text: "hi", model: "second", title: false }),
            (e: unknown) => {
                const m = (e as Error).message;
                return (
                    m.includes(`model "second" is not granted to agent "toto"`) &&
                    m.includes("granted: fake") &&
                    m.includes("allowed models")
                );
            },
        );
        assert.equal(second.requests.length, 0);
        assert.equal(env.db.listLlmCalls().length, 1, "the refusal spent nothing");
    } finally {
        await second.close();
        await env.stop();
    }
});

test("a manifest naming an ungranted model is refused like every other source", async () => {
    const env = await boot();
    const second = await secondModel(env);
    try {
        const h = await agentWith(env, "toto", null, { model: "second" });
        const session = h.createSession();
        await assert.rejects(
            env.core.runTurn({ agent: "toto", session, text: "hi", title: false }),
            /model "second" is not granted to agent "toto"/,
        );
        assert.equal(env.db.listLlmCalls().length, 0);
        assert.equal(env.model.requests.length, 0);
        assert.equal(second.requests.length, 0);
    } finally {
        await second.close();
        await env.stop();
    }
});

test("a model outside the allowed list refuses the turn and spends nothing", async () => {
    const env = await boot();
    const second = await secondModel(env);
    try {
        // the default model is "fake"; only "second" is granted, so the turn never resolves one
        const h = await agentWith(env, "toto", { allowed: ["second"] });
        const session = h.createSession();
        await assert.rejects(
            env.core.runTurn({ agent: "toto", session, text: "hi", attended: true, title: false }),
            /not granted/,
        );
        // and an explicit request for a forbidden model is refused just the same
        await assert.rejects(
            env.core.runTurn({
                agent: "toto",
                session,
                text: "hi",
                model: "fake",
                attended: true,
                title: false,
            }),
            /not granted/,
        );
        assert.equal(env.db.listLlmCalls().length, 0);
        assert.equal(env.model.requests.length, 0);
        assert.equal(second.requests.length, 0);
    } finally {
        await second.close();
        await env.stop();
    }
});

test("the allowed list refuses the agent's own one-shot chat before a provider exists", async () => {
    const env = await boot();
    const second = await secondModel(env);
    try {
        const h = await agentWith(env, "toto", { allowed: ["second"] });
        h.send({
            id: "chat-1",
            type: "chat",
            payload: { messages: [{ role: "user", content: "hi" }], model: "fake" },
        });
        await waitFor(() => h.frames().some((f) => f["id"] === "chat-1"), 4000, "chat reply");
        const reply = h.frames().find((f) => f["id"] === "chat-1");
        assert.equal(reply?.["status"], "denied");
        assert.match(String((reply?.["error"] as { message: string }).message), /not granted/);
        assert.equal(env.db.listLlmCalls().length, 0);
        assert.equal(env.model.requests.length, 0);
        assert.equal(second.requests.length, 0);
    } finally {
        await second.close();
        await env.stop();
    }
});

// ── resolution order ─────────────────────────────────────────────────────────

test("policy.primary beats the default, and an explicit req.model beats policy.primary", async () => {
    const env = await boot();
    const second = await secondModel(env);
    try {
        // both are on the allowed list: the order below is about RESOLUTION, not about grants
        const h = await agentWith(env, "toto", { allowed: ["fake", "second"], primary: "second" });
        const session = h.createSession();

        second.nextTurn(textTurn("from second"));
        const first = await env.core.runTurn({
            agent: "toto",
            session,
            text: "hi",
            attended: true,
            title: false,
        });
        assert.equal(first.text, "from second");
        assert.equal(second.requests.length, 1);
        assert.equal(env.model.requests.length, 0);
        assert.equal(env.db.listLlmCalls()[0]?.model, "second");

        env.model.nextTurn(textTurn("from fake"));
        const override = await env.core.runTurn({
            agent: "toto",
            session,
            text: "hi again",
            model: "fake",
            attended: true,
            title: false,
        });
        assert.equal(override.text, "from fake");
        assert.equal(env.model.requests.length, 1);
        assert.equal(second.requests.length, 1);
        assert.equal(env.db.listLlmCalls()[0]?.model, "fake");
    } finally {
        await second.close();
        await env.stop();
    }
});

// ── the fallback ─────────────────────────────────────────────────────────────

test("a dead primary falls back exactly once, and both calls are accounted", async (t) => {
    const env = await boot();
    try {
        await deadModel(t, env);
        const h = await agentWith(env, "toto", {
            allowed: ["dead", "fake"],
            primary: "dead",
            fallback: "fake",
        });
        const session = h.createSession();

        env.model.nextTurn(textTurn("recovered"));
        const out = await env.core.runTurn({
            agent: "toto",
            session,
            text: "hi",
            attended: true,
            title: false,
        });
        assert.equal(out.text, "recovered");
        assert.equal(out.dropped, false);

        assert.deepEqual(scopes(env), ["toto", "toto:fallback"]);
        const rows = env.db.listLlmCalls().reverse();
        assert.equal(rows[0]?.model, "dead");
        assert.equal(rows[0]?.finishReason, "error");
        assert.equal(rows[1]?.model, "fake");
        assert.equal(rows[1]?.finishReason, "stop");
        // the chain is explicit: the retry is attempt 2 and names the call it replaced
        assert.equal(rows[0]?.attempt, 1);
        assert.equal(rows[0]?.parentCallId, null);
        assert.equal(rows[1]?.attempt, 2);
        assert.equal(rows[1]?.parentCallId, rows[0]?.callId);
        assert.equal(rows[1]?.registryModel, "fake");
        assert.equal(out.metrics?.finalCallId, rows[1]?.callId, "done names the call that answered");
        assert.equal(out.metrics?.registryModel, "fake");
        assert.ok(env.logs.some((l) => l.includes(`retrying once on "fake"`)));
    } finally {
        await env.stop();
    }
});

test("both models down: the fallback is tried once and then the turn fails", async (t) => {
    const env = await boot();
    try {
        await deadModel(t, env, "dead1");
        await deadModel(t, env, "dead2");
        const h = await agentWith(env, "toto", {
            allowed: ["dead1", "dead2"],
            primary: "dead1",
            fallback: "dead2",
        });
        const session = h.createSession();
        await assert.rejects(
            env.core.runTurn({ agent: "toto", session, text: "hi", attended: true, title: false }),
        );
        // exactly two calls — the retry never recurses
        assert.deepEqual(scopes(env), ["toto", "toto:fallback"]);
    } finally {
        await env.stop();
    }
});

test("a fallback outside the grants is dropped, never used", async (t) => {
    const env = await boot();
    try {
        await deadModel(t, env);
        // the fallback still names "fake", but the allowed list was narrowed to "dead" alone — a stale fallback name must never widen the whitelist
        const h = await agentWith(env, "toto", {
            allowed: ["dead"],
            primary: "dead",
            fallback: "fake",
        });
        const session = h.createSession();
        await assert.rejects(
            env.core.runTurn({ agent: "toto", session, text: "hi", attended: true, title: false }),
        );
        assert.deepEqual(scopes(env), ["toto"], "no second attempt was made");
        assert.equal(env.model.requests.length, 0, `"fake" was never reached`);
    } finally {
        await env.stop();
    }
});

test("a finish_reason of length is an answer, not an outage: no fallback fires", async () => {
    const env = await boot();
    const second = await secondModel(env);
    try {
        const h = await agentWith(env, "toto", {
            allowed: ["fake", "second"],
            primary: "fake",
            fallback: "second",
        });
        const session = h.createSession();

        env.model.nextTurn(lengthTurn);
        const out = await env.core.runTurn({
            agent: "toto",
            session,
            text: "hi",
            attended: true,
            title: false,
        });
        assert.match(out.text, /partial/);
        assert.equal(second.requests.length, 0);
        assert.deepEqual(scopes(env), ["toto"]);
        assert.equal(env.db.listLlmCalls()[0]?.finishReason, "length");
    } finally {
        await second.close();
        await env.stop();
    }
});

// ── the daily model limit ────────────────────────────────────────────────────

/** Spend on a model through the accounting layer: limits read the daily rollup, not the pruned raw rows. */
const spend = (env: Env, agent: string, model: string, promptTokens: number, completionTokens = 0): void =>
    recordLlmCall(
        {
            agent,
            scope: agent,
            callId: newCallId(),
            callKind: "turn",
            finishReason: "stop",
            modelUid: getModel(model, env.db)!.modelUid,
            registryModel: model,
            usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedTokens: 0 },
            raw: {},
        },
        env.db,
    );

test("a model past its daily limit refuses turns and one-shot chats of every agent; under it, the turn runs", async () => {
    const env = await boot();
    try {
        setModelPricing("fake", { limit: { unit: "tokens", value: 1000 } }, env.db);
        const h = await agentWith(env, "toto", null);
        const session = h.createSession();

        env.model.nextTurn(textTurn("under the limit"));
        const ok = await env.core.runTurn({ agent: "toto", session, text: "hi", attended: true, title: false });
        assert.equal(ok.text, "under the limit");

        // ANOTHER agent spends the model's day: the limit is the model's, across all agents
        spend(env, "other", "fake", 900, 100);
        const before = env.db.listLlmCalls().length;
        const refusal = `model fake reached its daily limit; resets at midnight ${timeZone()}`;
        await assert.rejects(
            env.core.runTurn({ agent: "toto", session, text: "more", attended: true, title: false }),
            (e: Error) => e.message === refusal,
        );
        h.send({ id: "chat-2", type: "chat", payload: { messages: [{ role: "user", content: "hi" }] } });
        await waitFor(() => h.frames().some((f) => f["id"] === "chat-2"), 4000, "chat reply");
        const reply = h.frames().find((f) => f["id"] === "chat-2");
        assert.equal(reply?.["status"], "denied");
        assert.equal((reply?.["error"] as { message: string }).message, refusal);
        // neither refusal reached a provider, so neither wrote a row
        assert.equal(env.db.listLlmCalls().length, before);

        // clearing the limit reopens the model at once
        setModelPricing("fake", { limit: null }, env.db);
        env.model.nextTurn(textTurn("open again"));
        assert.equal((await env.core.runTurn({ agent: "toto", session, text: "again", attended: true, title: false })).text, "open again");
    } finally {
        await env.stop();
    }
});

test("a primary past its limit hands the turn and the ask() to a fallback with room, and a full fallback is never used", async () => {
    const env = await boot();
    const second = await secondModel(env);
    try {
        const h = await agentWith(env, "toto", { allowed: ["fake", "second"], primary: "fake", fallback: "second" });
        const session = h.createSession();
        setModelPricing("fake", { priceInPerM: 2, limit: { unit: "usd", value: 0.01 } }, env.db);
        // 5000 prompt tokens at $2/M = $0.01: the usd limit is reached exactly
        spend(env, "toto", "fake", 5000);

        second.nextTurn(textTurn("from the fallback"));
        const out = await env.core.runTurn({ agent: "toto", session, text: "hi", attended: true, title: false });
        assert.equal(out.text, "from the fallback");
        assert.equal(env.model.requests.length, 0, "the full primary is never called");
        assert.equal(env.db.listLlmCalls(1)[0]?.registryModel, "second");

        second.nextTurn(textTurn("asked the fallback"));
        h.send({ id: "ask-1", type: "chat", payload: { messages: [{ role: "user", content: "q" }] } });
        await waitFor(() => h.frames().some((f) => f["id"] === "ask-1"), 4000, "ask reply");
        assert.equal((h.frames().find((f) => f["id"] === "ask-1")?.["payload"] as { text: string }).text, "asked the fallback");

        // the fallback fills up too: nothing has room, the refusal names the model the agent asked for
        setModelPricing("second", { limit: { unit: "tokens", value: 50 } }, env.db);
        spend(env, "toto", "second", 50);
        await assert.rejects(
            env.core.runTurn({ agent: "toto", session, text: "more", attended: true, title: false }),
            /^Error: model fake reached its daily limit; resets at midnight/,
        );
        assert.equal(second.requests.length, 2);
    } finally {
        await second.close();
        await env.stop();
    }
});

test("a price change moves a usd limit at once: history is re-priced, never frozen", async () => {
    const env = await boot();
    try {
        const h = await agentWith(env, "toto", null);
        const session = h.createSession();
        setModelPricing("fake", { priceOutPerM: 10, limit: { unit: "usd", value: 1 } }, env.db);
        spend(env, "toto", "fake", 0, 60_000); // $0.60 at $10/M
        env.model.nextTurn(textTurn("still room"));
        assert.equal((await env.core.runTurn({ agent: "toto", session, text: "a", attended: true, title: false })).text, "still room");
        // the same tokens now cost $1.20: over the limit without a single new call
        setModelPricing("fake", { priceOutPerM: 20 }, env.db);
        await assert.rejects(env.core.runTurn({ agent: "toto", session, text: "b", attended: true, title: false }), /reached its daily limit/);
    } finally {
        await env.stop();
    }
});

test("yesterday's spend never counts toward today's limit", async () => {
    const env = await boot();
    try {
        setModelPricing("fake", { limit: { unit: "tokens", value: 100 } }, env.db);
        const h = await agentWith(env, "toto", null);
        const session = h.createSession();
        recordLlmCall(
            {
                agent: "toto", scope: "toto", callId: newCallId(), callKind: "turn",
                modelUid: getModel("fake", env.db)!.modelUid, registryModel: "fake",
                usage: { promptTokens: 5000, completionTokens: 0, totalTokens: 5000, cachedTokens: 0 }, raw: {},
            },
            env.db,
            "2020-01-01",
        );
        env.model.nextTurn(textTurn("a fresh day"));
        assert.equal((await env.core.runTurn({ agent: "toto", session, text: "hi", attended: true, title: false })).text, "a fresh day");
    } finally {
        await env.stop();
    }
});

test("a vision primary past its limit never hands a photo to its text-only fallback", async () => {
    const env = await boot();
    const seer = createFakeModel();
    try {
        addModel({ name: "seer", provider: "llamacpp", endpoint: await seer.listen(), contextTokens: 1000, vision: true }, env.db);
        const h = await agentWith(env, "vis", { allowed: ["seer", "fake"], primary: "seer", fallback: "fake" });
        setModelPricing("seer", { limit: { unit: "tokens", value: 10 } }, env.db);
        spend(env, "other", "seer", 10);
        const refusal = `model seer reached its daily limit; resets at midnight ${timeZone()}`;
        const photo = "data:image/png;base64,iVBORw0KGgo=";

        h.send({ id: "img", type: "chat", payload: { messages: [{ role: "user", content: "look", images: [photo] }] } });
        await waitFor(() => h.frames().some((f) => f["id"] === "img"), 4000, "chat reply");
        const reply = h.frames().find((f) => f["id"] === "img");
        assert.equal(reply?.["status"], "denied");
        assert.equal((reply?.["error"] as { message: string }).message, refusal);
        const session = h.createSession();
        await assert.rejects(
            env.core.runTurn({ agent: "vis", session, text: "look", images: [photo], title: false }),
            (e: Error) => e.message === refusal,
        );
        assert.equal(env.model.requests.length, 0, "the text-only fallback never answers the photo blind");

        // without a photo the fallback takes the call as usual
        env.model.nextTurn(textTurn("text only"));
        assert.equal((await env.core.runTurn({ agent: "vis", session, text: "hi", title: false })).text, "text only");
    } finally {
        await seer.close();
        await env.stop();
    }
});

test("a turn whose own first round spends the primary's limit finishes its next round on the fallback", async () => {
    const env = await boot({ contextTokens: 100_000 });
    const second = await secondModel(env);
    try {
        env.pin("toto");
        env.db.setModelsPolicy("toto", { allowed: ["fake", "second"], primary: "fake", fallback: "second" });
        const h = await env.connect(
            {
                name: "toto",
                tools: [{ name: "look", description: "look", parameters: { type: "object", properties: {} }, writes: false }],
                handlers: { look: { text: "seen" } },
            },
            false,
        );
        await waitFor(() => env.core.agent("toto").connected, 4000, "toto ready");
        setModelPricing("fake", { limit: { unit: "tokens", value: 100 } }, env.db);
        env.model.nextTurn({
            events: [
                { kind: "tool_call", index: 0, id: "c1", name: "look", arguments: "{}" },
                { kind: "finish", reason: "tool_calls" },
            ],
            usage: { prompt_tokens: 150, completion_tokens: 20 },
        });
        second.nextTurn(textTurn("done on the fallback", 60));

        const out = await env.core.runTurn({ agent: "toto", session: h.createSession(), text: "go", attended: true, title: false });
        assert.equal(out.text, "done on the fallback");
        assert.equal(env.model.requests.length, 1, "the spent primary never saw round two");
        assert.deepEqual(
            env.db.listLlmCalls(10, "toto").reverse().map((r) => [r.registryModel, r.attempt, r.finishReason, r.promptTokens]),
            [
                ["fake", 1, "tool_calls", 150],
                ["fake", 1, "error", null],
                ["second", 2, "stop", 60],
            ],
        );
    } finally {
        await second.close();
        await env.stop();
    }
});

// ── grants ───────────────────────────────────────────────────────────────────

test("describe_ok grants the default model ALONE when there is no policy", async () => {
    const env = await boot();
    const second = await secondModel(env);
    try {
        const h = await agentWith(env, "toto", null);
        await waitFor(
            () => h.frames().some((f) => f["type"] === "describe_ok"),
            4000,
            "describe_ok",
        );
        const payload = (h.frames().find((f) => f["type"] === "describe_ok")?.["payload"] ??
            {}) as Record<string, unknown>;
        assert.deepEqual(payload["models"], [{ id: "fake", contextTokens: 1000 }]);
    } finally {
        await second.close();
        await env.stop();
    }
});

test("describe_ok grants exactly the allowed models", async () => {
    const env = await boot();
    const second = await secondModel(env);
    try {
        const h = await agentWith(env, "toto", { allowed: ["second"] });
        await waitFor(
            () => h.frames().some((f) => f["type"] === "describe_ok"),
            4000,
            "describe_ok",
        );
        const payload = (h.frames().find((f) => f["type"] === "describe_ok")?.["payload"] ??
            {}) as Record<string, unknown>;
        assert.deepEqual(payload["models"], [
            { id: "second", contextTokens: 1000 },
        ]);
    } finally {
        await second.close();
        await env.stop();
    }
});

// ── the HTTP surface ─────────────────────────────────────────────────────────

test("/api/agents/:name/models reads, validates and clears the policy", async () => {
    const env = await boot();
    const second = await secondModel(env);
    const call = (
        path: string,
        init?: { method?: string; body?: unknown },
    ): Promise<{ status: number; body: Record<string, unknown> }> =>
        env.api<Record<string, unknown>>(init?.method ?? "GET", path, init?.body).then((r) => ({
            status: r.status,
            body: (r.json ?? {}) as Record<string, unknown>,
        }));
    const patch = (body: unknown): Promise<{ status: number; body: Record<string, unknown> }> =>
        call("/api/agents/toto/models", { method: "PATCH", body });
    try {
        await agentWith(env, "toto", null);

        const empty = await call("/api/agents/toto/models");
        assert.equal(empty.status, 200);
        assert.deepEqual(empty.body, {
            primary: null,
            fallback: null,
            allowed: null,
            available: ["fake", "second"],
            default: "fake",
        });

        assert.equal((await patch({ primary: "nope" })).status, 400);
        assert.equal((await patch({})).status, 400);
        assert.equal((await patch({ future: true })).status, 400);
        assert.equal((await patch({ allowed: ["fake", "nope"] })).status, 400);
        // the per-agent budget is gone: the field is refused like any unknown one
        assert.equal((await patch({ budgetTokensPerDay: 5000 })).status, 400);
        // with no allowed list the whitelist is the default alone, so a primary naming anything else could never run a turn — such a policy is refused, not stored
        const ungranted = await patch({ primary: "second" });
        assert.equal(ungranted.status, 400);
        assert.match(String(ungranted.body["error"]), /not granted/);
        assert.equal(env.db.getModelsPolicy("toto"), null); // nothing bad was persisted

        const set = await patch({
            allowed: ["second", "fake"],
            primary: "second",
            fallback: "fake",
        });
        assert.equal(set.status, 200);
        assert.equal(set.body["primary"], "second");
        assert.equal(set.body["fallback"], "fake");
        assert.deepEqual(env.db.getModelsPolicy("toto"), {
            allowed: ["second", "fake"],
            primary: "second",
            fallback: "fake",
        });

        // a list that excludes the model the policy already names could never run a turn
        assert.equal((await patch({ allowed: ["second"] })).status, 400);
        const listed = await patch({ allowed: ["second", "fake"] });
        assert.deepEqual(listed.body["allowed"], ["second", "fake"]);

        // untouched fields keep their value; null clears exactly one field
        const cleared = await patch({ fallback: null });
        assert.equal(cleared.body["fallback"], null);
        assert.equal(cleared.body["primary"], "second");

        const gone = await patch({ primary: null, allowed: null });
        assert.deepEqual(gone.body, {
            primary: null,
            fallback: null,
            allowed: null,
            available: ["fake", "second"],
            default: "fake",
        });
        assert.equal(env.db.getModelsPolicy("toto"), null);

        // a name that never connected has no pin row to hang a policy on
        assert.equal(
            (await call("/api/agents/nobody/models", { method: "PATCH", body: { primary: "fake" } }))
                .status,
            404,
        );
    } finally {
        await second.close();
        await env.stop();
    }
});

test("the roster carries a primary/fallback summary of the policy", async () => {
    const env = await boot();
    const second = await secondModel(env);
    try {
        await agentWith(env, "plain", null);
        await agentWith(env, "toto", {
            allowed: ["second", "fake"],
            primary: "second",
            fallback: "fake",
        });
        const rows = (await env.api<Array<Record<string, unknown>>>("GET", "/api/agents")).json;
        const byName = new Map(rows.map((r) => [String(r["name"]), r]));
        assert.equal(byName.get("plain")?.["models"], null);
        assert.deepEqual(byName.get("toto")?.["models"], { primary: "second", fallback: "fake" });
    } finally {
        await second.close();
        await env.stop();
    }
});

// ── names that outlive their model ───────────────────────────────────────────

test("a model a policy names cannot be removed, and a rename follows the policy", async () => {
    const env = await boot();
    try {
        addModel({ name: "spare", provider: "llamacpp", endpoint: "http://127.0.0.1:1/v1", contextTokens: 1000 }, env.db);
        env.pin("worker");
        env.db.setModelsPolicy("worker", { primary: "spare", allowed: ["spare", "fake"] });

        assert.throws(() => removeModel("spare", env.db), /model policy of worker/);
        assert.ok(env.db.getModel("spare"));

        patchModel("spare", { name: "spare2" }, env.db);
        assert.deepEqual(env.db.getModelsPolicy("worker"), { primary: "spare2", allowed: ["spare2", "fake"] });

        // and a model nobody's policy names is still removable
        env.db.setModelsPolicy("worker", null);
        removeModel("spare2", env.db);
        assert.equal(env.db.getModel("spare2"), null);
    } finally {
        await env.stop();
    }
});

test("the HTTP turn route cannot pick a model for the agent", async () => {
    const env = await boot();
    try {
        addModel({ name: "spare", provider: "llamacpp", endpoint: "http://127.0.0.1:1/v1", contextTokens: 1000 }, env.db);
        await env.connect({ name: "worker" });
        await waitFor(() => env.core.agent("worker").connected, 4000, "worker ready");
        const created = await env.api<{ id: number }>("POST", "/api/agents/worker/conversations");
        const session = created.json.id;
        env.db.setModelsPolicy("worker", { allowed: ["fake"] });

        env.model.nextTurn(textTurn("ok"));
        env.model.nextTurn(textTurn('{"title":"t"}'));
        const turn = await env.stream("POST", `/api/agents/worker/conversations/${session}/messages`, { text: "hi", model: "spare" });
        await turn.done;
        assert.ok(turn.lines.some((l) => l["type"] === "done"));
        assert.ok(!turn.lines.some((l) => JSON.stringify(l).includes("is not granted to agent")));
        assert.ok(env.db.listLlmCalls(10, "worker").every((c) => c.model !== "spare"));
    } finally {
        await env.stop();
    }
});

test("a policy set on an open agent invite lands on the pin its redemption creates, before the agent ever connected", async () => {
    const env = await boot();
    const dir = mkdtempSync(join(tmpdir(), "mimi-invited-"));
    let agent: AgentRuntime | undefined;
    try {
        const refused = await env.api<{ error: string }>("PATCH", "/api/agents/notes/models", { primary: "fake" });
        assert.equal(refused.status, 404);
        assert.match(refused.json.error, /no pin and no open agent invite/);

        const invite = await env.api<{ uri: string }>("POST", "/api/agent-invites", { name: "notes" });
        const set = await env.api<Record<string, unknown>>("PATCH", "/api/agents/notes/models", { primary: "fake", allowed: ["fake"] });
        assert.equal(set.status, 200);
        assert.equal((await env.api<{ primary: string }>("GET", "/api/agents/notes/models")).json.primary, "fake");
        assert.equal(env.db.getPin("notes"), null);

        // the lines `mimi invite --write` and devkit put in the agent's .env; the SDK reads all three itself
        writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "notes" }));
        setAgentEnv(dir, "MIMI_INVITE", invite.json.uri);
        setAgentEnv(dir, "MIMI_GATEWAY_URL", `${env.ws}/channel`, { encrypt: false });
        setAgentEnv(dir, "MIMI_DATA_DIR", ".mimi-dev/agent-data", { encrypt: false });
        agent = await runAgent({ dir, model: "qwen-lan", log: () => undefined });
        const started = agent;
        await waitFor(() => env.core.agent("notes").connected && started.client.connected, 8000, "the invited agent connected");

        assert.deepEqual(env.db.getModelsPolicy("notes"), { primary: "fake", allowed: ["fake"] });
        assert.deepEqual(agent.models(), [{ id: "fake", contextTokens: 1000 }]);
        for (const file of ["identity.key", "gateway.pub", "agent.db"]) {
            assert.ok(existsSync(join(dir, ".mimi-dev", "agent-data", file)), file);
        }
        assert.equal(existsSync(join(dir, "data")), false);

        // the manifest asks for a model this gateway does not have; the turn runs on the policy's primary
        const session = (await env.api<{ id: number }>("POST", "/api/agents/notes/conversations")).json.id;
        env.model.nextTurn(textTurn("on fake"));
        const out = await env.core.runTurn({ agent: "notes", session, text: "hi", title: false });
        assert.equal(out.text, "on fake");
        assert.deepEqual(env.db.listLlmCalls(10, "notes").map((c) => c.registryModel), ["fake"]);
    } finally {
        await agent?.stop();
        await env.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});
