/** The HTTP surface end to end over the channel tunnel: models CRUD, conversation proxy, ndjson turns, approvals. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { request as rawRequest } from "node:http";
import test from "node:test";

import type { EventBody, MessageMeta } from "@mimi-os/protocol";
import type { FakeAgentOptions } from "@mimi-os/sdk/testing";

import type { Harness } from "./agent-harness.ts";
import { boot, callTurn, textTurn, waitFor, type Env } from "./harness-env.ts";

async function connected(env: Env, opts: FakeAgentOptions): Promise<Harness> {
    const h = await env.connect(opts);
    await waitFor(() => env.core.registry.get(opts.name) !== undefined, 4000, "registration");
    return h;
}

async function conversation(env: Env, agent = "toto"): Promise<number> {
    const created = await env.api<{ id: number }>("POST", `/api/agents/${agent}/conversations`);
    assert.equal(created.status, 201);
    return created.json.id;
}

/** A LITERAL request line — fetch() normalizes paths, and the listener must refuse an unnormalized one too. */
function rawStatus(base: string, path: string): Promise<number> {
    const port = Number(new URL(base).port);
    return new Promise((resolve, reject) => {
        const req = rawRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
    });
}

test("models: CRUD roundtrip over the HTTP surface", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const list = await env.api<Array<{ name: string; modelUid: string | null }>>("GET", "/api/models");
        assert.ok(list.json.some((m) => m.name === "fake"));
        assert.equal(typeof list.json.find((m) => m.name === "fake")?.modelUid, "string");

        const added = await env.api("POST", "/api/models", {
            name: "second",
            provider: "llamacpp",
            endpoint: "http://x",
            contextTokens: 1000,
        });
        assert.equal(added.status, 201);

        const patched = await env.api("PATCH", "/api/models/second", { contextTokens: 2000 });
        assert.equal(patched.status, 200);

        const deleted = await env.api("DELETE", "/api/models/second");
        assert.equal(deleted.status, 200);
        assert.deepEqual(deleted.json, { ok: true });
    } finally {
        await env.stop();
    }
});

test("models: the vision flag round-trips over the HTTP surface and defaults false", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const list = await env.api<Array<{ name: string; vision: boolean }>>("GET", "/api/models");
        assert.equal(list.json.find((m) => m.name === "fake")?.vision, false);

        assert.equal(
            (await env.api("POST", "/api/models", { name: "seer", provider: "llamacpp", endpoint: "http://x", contextTokens: 1000, vision: true })).status,
            201,
        );
        assert.equal(
            (await env.api("POST", "/api/models", { name: "bad", provider: "llamacpp", endpoint: "http://x", contextTokens: 1000, vision: "yes" })).status,
            400,
        );

        const afterAdd = await env.api<Array<{ name: string; vision: boolean }>>("GET", "/api/models");
        assert.equal(afterAdd.json.find((m) => m.name === "seer")?.vision, true);

        assert.equal((await env.api("PATCH", "/api/models/seer", { vision: false })).status, 200);
        assert.equal((await env.api("PATCH", "/api/models/fake", { vision: "nope" })).status, 400);

        const afterPatch = await env.api<Array<{ name: string; vision: boolean }>>("GET", "/api/models");
        assert.equal(afterPatch.json.find((m) => m.name === "seer")?.vision, false);
        assert.equal(afterPatch.json.find((m) => m.name === "fake")?.vision, false);
    } finally {
        await env.stop();
    }
});

test("models: contextTokens must be a JSON number", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        for (const contextTokens of [true, null, "1000", " ", 0, 1.5, 9_007_199_254_740_992]) {
            const result = await env.api("POST", "/api/models", {
                name: "invalid",
                provider: "llamacpp",
                endpoint: "http://x",
                contextTokens,
            });
            assert.equal(result.status, 400, String(contextTokens));
        }
        const models = await env.api<Array<{ name: string }>>("GET", "/api/models");
        assert.equal(models.json.some((m) => m.name === "invalid"), false);
    } finally {
        await env.stop();
    }
});

test("models: JSON field types are validated before a create or patch", async () => {
    const env = await boot({ contextTokens: 4000 });
    const base = { provider: "llamacpp", endpoint: "http://x", contextTokens: 1000 };
    try {
        const invalidCreates: Record<string, unknown>[] = [
            { ...base, name: "not routable" },
            { ...base, name: ["array-name"] },
            { name: "missing-provider", endpoint: "http://x", contextTokens: 1000 },
            { ...base, name: "array-provider", provider: ["llamacpp"] },
            { ...base, name: "object-endpoint", endpoint: { url: "http://x" } },
            { ...base, name: "array-model-id", modelId: ["remote"] },
            { ...base, name: "array-params", params: [] },
            { ...base, name: "numeric-key", apiKey: 123 },
        ];
        for (const body of invalidCreates) {
            const result = await env.api("POST", "/api/models", body);
            assert.equal(result.status, 400, JSON.stringify(body));
        }
        const afterCreates = await env.api<Array<{ name: string }>>("GET", "/api/models");
        assert.deepEqual(afterCreates.json.map((m) => m.name), ["fake"]);

        assert.equal((await env.api("POST", "/api/models", { ...base, name: "target" })).status, 201);
        for (const body of [
            { contextTokens: 2000, name: ["moved"] },
            { contextTokens: 2000, endpoint: 42 },
            { contextTokens: 2000, modelId: ["remote"] },
            { contextTokens: 2000, apiKey: true },
        ]) {
            const result = await env.api("PATCH", "/api/models/target", body);
            assert.equal(result.status, 400, JSON.stringify(body));
        }
        const afterPatches = await env.api<Array<{ name: string; contextTokens: number }>>("GET", "/api/models");
        assert.equal(afterPatches.json.find((m) => m.name === "target")?.contextTokens, 1000);
        assert.equal(afterPatches.json.some((m) => m.name === "moved"), false);
    } finally {
        await env.stop();
    }
});

test("paged HTTP routes reject non-positive and fractional limits", async () => {
    const env = await boot();
    try {
        for (const path of ["/api/agents/toto/calls", "/api/inbox", "/api/interactions"]) {
            for (const limit of ["0", "-1", "1.5", "9007199254740992", "nope"]) {
                assert.equal((await env.api("GET", `${path}?limit=${limit}`)).status, 400, `${path}: ${limit}`);
            }
            assert.equal((await env.api("GET", `${path}?limit=1`)).status, 200, path);
        }
        assert.equal((await env.api("GET", "/api/inbox?before=9007199254740992")).status, 400);
        assert.equal((await env.api("GET", "/api/interactions?conversation=9007199254740992")).status, 400);
    } finally {
        await env.stop();
    }
});

test("models: modelUid is minted once, survives a rename, and is fresh after recreation", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const uidOf = async (name: string): Promise<string | null | undefined> => {
            const rows = await env.api<Array<{ name: string; modelUid: string | null }>>("GET", "/api/models");
            return rows.json.find((m) => m.name === name)?.modelUid;
        };
        const post = async (body: Record<string, unknown>): Promise<number> =>
            (await env.api("POST", "/api/models", body)).status;

        assert.equal(await post({ name: "alpha", provider: "llamacpp", endpoint: "http://x", contextTokens: 1000 }), 201);
        const minted = await uidOf("alpha");
        assert.equal(typeof minted, "string");
        assert.notEqual(minted, await uidOf("fake"), "every model gets its own identity");

        const patched = await env.api("PATCH", "/api/models/alpha", { name: "beta", contextTokens: 2000 });
        assert.equal(patched.status, 200);
        assert.deepEqual(patched.json, { ok: true, renamed: { from: "alpha", to: "beta" } });
        assert.equal(await uidOf("alpha"), undefined);
        assert.equal(await uidOf("beta"), minted, "a rename is a new alias over the same identity");

        const invalid = await env.api("PATCH", "/api/models/beta", { name: "moved", contextTokens: 0 });
        assert.equal(invalid.status, 400);
        assert.equal(await uidOf("beta"), minted, "an invalid patch does not partially rename the model");
        assert.equal(await uidOf("moved"), undefined);

        assert.equal((await env.api("DELETE", "/api/models/beta")).status, 200);
        assert.equal(await post({ name: "beta", provider: "llamacpp", endpoint: "http://x", contextTokens: 1000 }), 201);
        assert.notEqual(await uidOf("beta"), minted, "a recreated model is a different model");
    } finally {
        await env.stop();
    }
});

test("providers: every kind declares whether a provider key is required", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const res = await env.api<Array<{ kind: string; keyRequirement?: string }>>("GET", "/api/providers");
        assert.equal(res.status, 200);
        assert.ok(res.json.length > 0);
        for (const row of res.json) {
            assert.ok(
                row.keyRequirement === "required" || row.keyRequirement === "optional",
                `provider "${row.kind}" declares no keyRequirement`,
            );
        }
        const byKind = new Map(res.json.map((r) => [r.kind, r.keyRequirement]));
        assert.equal(byKind.get("openrouter"), "required");
        assert.equal(byKind.get("llamacpp"), "optional");
        assert.equal(byKind.get("vllm"), "optional");
    } finally {
        await env.stop();
    }
});

test("conversations: create, list, rename proxy through to the agent", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        await connected(env, { name: "toto" });
        const id = await conversation(env);

        const listed = await env.api<Array<{ id: number; title: string | null; busy: boolean }>>(
            "GET",
            "/api/agents/toto/conversations",
        );
        assert.ok(listed.json.some((c) => c.id === id && c.title === null && c.busy === false));

        const patched = await env.api("PATCH", `/api/agents/toto/conversations/${id}`, { title: "renamed" });
        assert.deepEqual(patched.json, { ok: true });

        const after = await env.api<Array<{ id: number; title: string | null; titleByUser: boolean }>>(
            "GET",
            "/api/agents/toto/conversations",
        );
        const row = after.json.find((c) => c.id === id);
        assert.equal(row?.title, "renamed");
        assert.equal(row?.titleByUser, true);
    } finally {
        await env.stop();
    }
});

test("conversations: each row carries updatedAt beside createdAt, as the agent keeps them", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const h = await connected(env, { name: "toto" });
        const id = await conversation(env);
        const kept = h.sessions.get(id)!;
        kept.createdAt = Date.UTC(2020, 0, 2, 3, 4, 5);
        kept.updatedAt = Date.UTC(2020, 8, 20, 21, 22, 23);
        type Row = { id: number; createdAt: string; updatedAt: string };
        const row = async (): Promise<Row | undefined> =>
            (await env.api<Row[]>("GET", "/api/agents/toto/conversations")).json.find((c) => c.id === id);
        const before = (await row())!;
        assert.equal(before.createdAt, "2020-01-02 03:04:05");
        assert.equal(before.updatedAt, "2020-09-20 21:22:23");

        // a turn appends, so the agent moves updatedAt and the next listing follows it
        env.model.nextTurn(textTurn("hi"));
        await env.core.runTurn({ agent: "toto", session: id, text: "hello", title: false });
        const after = (await row())!;
        assert.equal(after.createdAt, "2020-01-02 03:04:05");
        assert.ok(after.updatedAt > "2020-09-20 21:22:23", after.updatedAt);
    } finally {
        await env.stop();
    }
});

test("conversation mutations reject coercible JSON values instead of changing state", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        await connected(env, { name: "toto" });
        const id = await conversation(env);
        const path = `/api/agents/toto/conversations/${id}`;

        assert.equal((await env.api("PATCH", path, { archived: "true" })).status, 400);
        assert.equal((await env.api("PATCH", path, {})).status, 400);
        for (const messageId of [true, "1"]) {
            assert.equal((await env.api("POST", `${path}/truncate`, { messageId })).status, 400);
        }

        env.model.nextTurn(textTurn("must not run"));
        assert.equal((await env.api("POST", `${path}/messages`, { text: ["hello"] })).status, 400);
        assert.equal(env.model.requests.length, 0);
        for (const decisions of [{ action: "true" }, ["true"], null]) {
            assert.equal((await env.api("POST", "/api/approvals/deadbeef/answer", { decisions })).status, 400);
        }

        const sessions = await env.api<Array<{ id: number; archived: boolean }>>(
            "GET",
            "/api/agents/toto/conversations?all=1",
        );
        assert.equal(sessions.json.find((s) => s.id === id)?.archived, false);
    } finally {
        await env.stop();
    }
});

test("pin permission patches reject malformed fields instead of reporting a no-op success", async () => {
    const env = await boot();
    try {
        env.pin("toto");
        for (const body of [
            {},
            { perms: null },
            { perms: [] },
            { perms: {} },
            { perms: { future: true } },
            { perms: { delegate: "false" } },
        ]) {
            assert.equal((await env.api("PATCH", "/api/pins/toto", body)).status, 400, JSON.stringify(body));
        }
        const pin = (await env.api<Array<{ name: string; perms: Record<string, boolean> }>>("GET", "/api/pins")).json[0];
        assert.deepEqual(pin?.perms, { delegate: true, discoverable: true });
    } finally {
        await env.stop();
    }
});

test("turns: ndjson stream happy path ends in done with the model's answer", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        await connected(env, { name: "toto" });
        const id = await conversation(env);
        env.model.nextTurn(textTurn("hello there"));

        const turn = await env.stream("POST", `/api/agents/toto/conversations/${id}/messages`, { text: "hi" });
        assert.equal(turn.status, 200);
        await turn.done;
        const done = turn.lines.find((ev) => ev["type"] === "done");
        assert.equal(done?.["answer"], "hello there");

        // the metadata rides the SAME done: the answer and every older field are untouched
        assert.match(String(done?.["finalCallId"]), /^[0-9a-f]{32}$/);
        assert.equal(done?.["registryModel"], "fake");
        assert.equal(done?.["requestedModel"], "fake");
        assert.equal(done?.["rounds"], 1);
        assert.equal(typeof done?.["callDurationMs"], "number");
        assert.ok(Number(done?.["turnDurationMs"]) >= Number(done?.["callDurationMs"]));

        // …and the call the stream named is the row the trace route serves
        const calls = await env.api<
            Array<{
                callId: string;
                callKind: string;
                scope: string;
                model: string | null;
                registryModel: string | null;
                requestedModel: string | null;
                reportedModel: string | null;
                attempt: number | null;
                parentCallId: string | null;
                conversationId: number | null;
                turnSeq: number | null;
                messageSeqs: number[] | null;
                durationMs: number | null;
            }>
        >("GET", "/api/agents/toto/calls");
        const row = calls.json.find((c) => c.callId === done?.["finalCallId"]);
        assert.ok(row, "the final call of the stream is on the trace");
        assert.equal(row.callKind, "turn");
        assert.equal(row.scope, "toto", "the existing scope string is byte-identical");
        assert.equal(row.registryModel, "fake");
        assert.equal(row.requestedModel, row.model);
        assert.equal(row.reportedModel, "fake");
        assert.equal(row.attempt, 1);
        assert.equal(row.parentCallId, null);
        assert.equal(row.conversationId, id);
        assert.equal(row.turnSeq, 1);
        assert.deepEqual(row.messageSeqs, [2], "the assistant event this round appended");
        assert.equal(typeof row.durationMs, "number");
    } finally {
        await env.stop();
    }
});

test("calls: the trace row carries the provider's reasoning count, and null when none was reported", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        await connected(env, { name: "toto" });
        const id = await conversation(env);
        env.model.nextTurn({
            events: [{ kind: "text", text: "thought it over" }, { kind: "finish", reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 40, reasoning_tokens: 32 },
        });
        // whatever else the turn triggers (auto-title) reports no reasoning count of its own
        for (let i = 0; i < 3; i++) env.model.nextTurn(textTurn("plain answer"));

        const turn = await env.stream("POST", `/api/agents/toto/conversations/${id}/messages`, { text: "hi" });
        await turn.done;
        const reasonedId = String(turn.lines.find((ev) => ev["type"] === "done")?.["finalCallId"]);

        // the auto-title call is the second, unreported row this turn writes
        await waitFor(() => env.db.listLlmCalls().length >= 2, 4000, "the auto-title call");
        const calls = await env.api<Array<{ callId: string; completionTokens: number | null; reasoningTokens: number | null }>>(
            "GET",
            "/api/agents/toto/calls",
        );
        const reasoned = calls.json.find((c) => c.callId === reasonedId);
        assert.equal(reasoned?.reasoningTokens, 32);
        assert.equal(reasoned?.completionTokens, 40, "the completion count already contains it");
        assert.equal(
            calls.json.filter((c) => c.callId !== reasonedId).every((c) => c.reasoningTokens === null),
            true,
            "unreported is null, never a fabricated 0",
        );
    } finally {
        await env.stop();
    }
});

test("history: new turns carry actor + callId, the agent's own appends stay bare, and no meta reaches the model", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const h = await connected(env, { name: "toto" });
        const id = await conversation(env);
        // appended by the agent itself: no provenance
        h.append(id, [
            { type: "message", payload: { role: "user", content: "an old question" } },
            { type: "message", payload: { role: "assistant", content: "an old answer" } },
        ]);

        env.model.nextTurn(textTurn("hello there"));
        env.model.nextTurn(textTurn('{"title":"Greetings"}'));
        const turn = await env.stream("POST", `/api/agents/toto/conversations/${id}/messages`, { text: "hi" });
        await turn.done;
        const done = turn.lines.find((ev) => ev["type"] === "done");
        assert.equal(done?.["answer"], "hello there");
        // the auto-title runs after done: let it take its own scripted answer before the next turn is queued
        await waitFor(() => h.sessions.get(id)?.title === "Greetings", 4000, "the auto-title");

        const history = await env.api<{ items: Array<{ role: string; content: string; meta?: MessageMeta }> }>(
            "GET",
            `/api/agents/toto/conversations/${id}/messages`,
        );
        const byText = (content: string): { role: string; content: string; meta?: MessageMeta } => {
            const row = history.json.items.find((i) => i.content === content);
            assert.ok(row, `"${content}" is in the history`);
            return row;
        };

        // served exactly as recorded — the mapper never invents an author
        assert.equal("meta" in byText("an old question"), false);
        assert.equal("meta" in byText("an old answer"), false);

        // new: the route a person typed into vouched for the human, the loop for the agent
        assert.deepEqual(byText("hi").meta, { actor: { kind: "human" } });
        assert.deepEqual(byText("hello there").meta, {
            callId: done?.["finalCallId"],
            registryModel: "fake",
            actor: { kind: "agent", agent: "toto" },
        });

        // a second turn replays the first through the projection: display metadata must not be in it
        env.model.nextTurn(textTurn("still here"));
        await (await env.stream("POST", `/api/agents/toto/conversations/${id}/messages`, { text: "again" })).done;
        const prompt = env.model.requests.at(-1)?.["messages"] as Array<Record<string, unknown>>;
        assert.ok(
            prompt.some((m) => m["content"] === "hi"),
            "the stamped message really is in the prompt",
        );
        for (const m of prompt) assert.equal("meta" in m, false);
    } finally {
        await env.stop();
    }
});

interface ApprovalRow {
    gate: string;
    agent: string;
    conversation?: number;
    tool: string;
    label: string;
    actions: Array<{ id: string; label: string; detail?: Record<string, unknown> }>;
    since: string;
    deadline: number;
}

test("approvals: the listing shows what is waiting, and ONLY the per-gate route shows the arguments", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const h = await connected(env, {
            name: "toto",
            tools: [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { send_email: { text: "SENT" } },
        });
        const id = await conversation(env);
        const secret = "the-body-of-the-email";
        env.model.nextTurn(callTurn([{ id: "w1", name: "send_email", args: `{"body":"${secret}"}` }]));
        env.model.nextTurn(textTurn("mailed"));

        const turn = await env.stream("POST", `/api/agents/toto/conversations/${id}/messages`, { text: "send it" });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "a parked gate");

        const listed = await env.api<{ approvals: ApprovalRow[] }>("GET", "/api/approvals");
        assert.equal(listed.status, 200);
        assert.equal(listed.text.includes(secret), false, "the listing must never carry the arguments");
        assert.equal(listed.json.approvals.length, 1);
        const row = listed.json.approvals[0]!;
        assert.match(row.gate, /^[0-9a-f]{32}$/);
        assert.equal(row.agent, "toto");
        assert.equal(row.conversation, id);
        assert.equal(row.tool, "send_email");
        assert.ok(row.label.includes("send_email"));
        assert.deepEqual(row.actions, [{ id: "w1", label: "send_email" }]);
        assert.equal(typeof row.since, "string");
        assert.ok(row.deadline > Date.now());

        const detail = (await env.api<ApprovalRow>("GET", `/api/approvals/${row.gate}`)).json;
        // the same row, plus the one thing the listing withholds
        assert.equal(detail.gate, row.gate);
        assert.equal(detail.conversation, id);
        assert.equal(detail.tool, row.tool);
        assert.equal(detail.label, row.label);
        assert.equal(detail.since, row.since);
        assert.equal(detail.deadline, row.deadline);
        assert.deepEqual(detail.actions[0]?.detail, { body: secret });

        // a chat gate resolves through the one answer route too; the per-chat route is gone
        assert.equal((await env.api("POST", `/api/agents/toto/conversations/${id}/approval`, { gate: row.gate, decisions: { w1: true } })).status, 404);
        const answered = await env.api("POST", `/api/approvals/${row.gate}/answer`, { decisions: { w1: true } });
        assert.equal(answered.status, 200);
        await turn.done;
        assert.equal(h.invokes().length, 1);
        // answered means gone: a pending listing never shows a decided gate again
        assert.deepEqual((await env.api("GET", "/api/approvals")).json, { approvals: [] });
        const stale = await env.api<{ outcome: string }>("GET", `/api/approvals/${row.gate}`);
        assert.equal(stale.status, 404);
        assert.equal(stale.json.outcome, "gone");
    } finally {
        await env.stop();
    }
});

test("approvals: a chat-less gate is listed, resolves through the answer route, and its outcome fans out", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const h = await connected(env, { name: "toto" });
        const events = await env.stream("GET", "/api/events");
        await waitFor(() => events.lines.some((e) => e["type"] === "ready"), 4000, "the stream opened");

        // ask_approve from inside a running tool: no session, so nothing chat-scoped can list it
        h.send({ id: "k1", type: "ask_approve", payload: { label: "wire 40 EUR", detail: { iban: "X" } } });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "a parked gate");

        const row = (await env.api<{ approvals: ApprovalRow[] }>("GET", "/api/approvals")).json.approvals[0]!;
        assert.equal("conversation" in row, false, "a gate with no chat carries no conversation");
        assert.equal(row.tool, "wire 40 EUR");
        const detail = (await env.api<ApprovalRow>("GET", `/api/approvals/${row.gate}`)).json;
        assert.deepEqual(detail.actions[0]?.detail, { iban: "X" });

        const answered = await env.api("POST", `/api/approvals/${row.gate}/answer`, {
            decisions: { [detail.actions[0]!.id]: true },
        });
        assert.deepEqual(answered.json, { ok: true });
        await waitFor(
            () => h.frames().some((f) => f["id"] === "k1" && f["type"] === "ask_approve_ok"),
            4000,
            "the agent was told",
        );
        const reply = h.frames().find((f) => f["id"] === "k1");
        assert.equal((reply?.["payload"] as { approved: boolean }).approved, true);

        await waitFor(() => events.lines.some((e) => e["type"] === "approval_resolved"), 4000, "the fanout");
        const resolved = events.lines.find((e) => e["type"] === "approval_resolved");
        assert.equal(resolved?.["gate"], row.gate);
        assert.equal(resolved?.["outcome"], "approved");
        events.close();
    } finally {
        await env.stop();
    }
});

test("approvals: a denied gate fans out as denied, and two gates never share an id", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const h = await connected(env, { name: "toto" });
        const events = await env.stream("GET", "/api/events");
        await waitFor(() => events.lines.some((e) => e["type"] === "ready"), 4000, "the stream opened");

        const ids: string[] = [];
        for (const k of ["k1", "k2"]) {
            h.send({ id: k, type: "ask_approve", payload: { label: `step ${k}` } });
            await waitFor(() => env.core.approvals.pending().length === 1, 4000, "a parked gate");
            const gate = env.core.approvals.pending()[0]!.gate;
            ids.push(gate);
            // an empty answer denies every action in the batch
            assert.equal(env.core.approvals.answer(gate, {}), true);
            await waitFor(() => env.core.approvals.pending().length === 0, 4000, "the gate closed");
        }
        assert.equal(new Set(ids).size, 2);
        for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);

        const resolutions = (): Array<Record<string, unknown>> =>
            events.lines.filter((e) => e["type"] === "approval_resolved");
        await waitFor(() => resolutions().length === 2, 4000, "both resolutions");
        assert.deepEqual(
            resolutions().map((e) => e["outcome"]),
            ["denied", "denied"],
        );
        events.close();
    } finally {
        await env.stop();
    }
});

test("approvals: every device hears a batch gate by its id and its call count, not as one call", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        await connected(env, {
            name: "toto",
            tools: [{ name: "add_event", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { add_event: { text: "ADDED" } },
        });
        const events = await env.stream("GET", "/api/events");
        await waitFor(() => events.lines.some((e) => e["type"] === "ready"), 4000, "the stream opened");
        const id = await conversation(env);
        env.model.nextTurn(callTurn(["a", "b", "c", "d"].map((call) => ({ id: call, name: "add_event" }))));
        env.model.nextTurn(textTurn("added"));
        const turn = await env.stream("POST", `/api/agents/toto/conversations/${id}/messages`, { text: "add four" });
        await waitFor(() => events.lines.some((e) => e["type"] === "approval"), 4000, "the announcement");

        const gate = env.core.approvals.pending()[0]!.gate;
        const { type, ...announced } = events.lines.find((e) => e["type"] === "approval")!;
        assert.equal(type, "approval");
        assert.deepEqual(announced, { kind: "approval", agent: "toto", session: id, gate, tool: "add_event", actions: 4 });
        env.core.approvals.answer(gate, {});
        await turn.done;
        events.close();
    } finally {
        await env.stop();
    }
});

test("dashboard: a waiting approval names its conversation, and a chat-less one names none rather than 0", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const h = await connected(env, {
            name: "toto",
            tools: [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { send_email: { text: "SENT" } },
        });
        const id = await conversation(env);
        env.model.nextTurn(callTurn([{ id: "w1", name: "send_email" }]));
        env.model.nextTurn(textTurn("mailed"));
        const turn = await env.stream("POST", `/api/agents/toto/conversations/${id}/messages`, { text: "send it" });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the chat gate");
        h.send({ id: "k1", type: "ask_approve", payload: { label: "wire 40 EUR" } });
        await waitFor(() => env.core.approvals.pending().length === 2, 4000, "the chat-less gate");

        type Row = { agent: string; conversation?: number; room?: string; tool: string; since: string };
        const body = (await env.api<{ waiting: { approvals: number }; approvals: Row[] }>("GET", "/api/dashboard")).json;
        assert.equal(body.waiting.approvals, 2);
        const shapes = body.approvals.map(({ since, ...rest }) => {
            assert.equal(typeof since, "string");
            return rest;
        });
        assert.deepEqual(shapes.sort((a, b) => a.tool.localeCompare(b.tool)), [
            { agent: "toto", conversation: id, tool: "send_email" },
            { agent: "toto", tool: "wire 40 EUR" },
        ]);

        for (const g of env.core.approvals.pending()) env.core.approvals.answer(g.gate, {});
        await turn.done;
    } finally {
        await env.stop();
    }
});

test("roster and dashboard carry the agent's description, and an offline agent keeps it", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const h = await connected(env, { name: "toto", manifest: { description: "Keeps a reading list." } });
        await connected(env, { name: "bare" });
        type Row = { name: string; connected: boolean; description?: string };
        const roster = async (): Promise<Row[]> => (await env.api<Row[]>("GET", "/api/agents")).json;
        const dashboard = async (): Promise<Row[]> =>
            (await env.api<{ agents: Row[] }>("GET", "/api/dashboard")).json.agents;

        for (const rows of [await roster(), await dashboard()]) {
            assert.equal(rows.find((r) => r.name === "toto")?.description, "Keeps a reading list.");
            assert.equal("description" in rows.find((r) => r.name === "bare")!, false, "none declared, none served");
        }

        // stored with the registry row: the roster still reads it once the socket is gone
        h.close();
        await waitFor(() => !env.core.agent("toto").connected, 4000, "the disconnect");
        const offline = (await roster()).find((r) => r.name === "toto");
        assert.equal(offline?.connected, false);
        assert.equal(offline?.description, "Keeps a reading list.");
    } finally {
        await env.stop();
    }
});

test("plain HTTP on the loopback listener: a dot-segment path never resolves into /api", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        // the listener must parse the path the way the router does — a raw-string check would misread these
        assert.equal(await rawStatus(env.base, "/x/../api/agents"), 404);
        assert.equal(await rawStatus(env.base, "/x/%2e%2e/api/agents"), 404);
        assert.equal(await rawStatus(env.base, "/app/../api/agents"), 404);
    } finally {
        await env.stop();
    }
});

test("proxied routes answer 503 honestly when the agent is not connected, never hang", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const res = await env.api<{ error: string }>("POST", "/api/agents/ghost/conversations");
        assert.equal(res.status, 503);
        assert.match(res.json.error, /not connected/);
    } finally {
        await env.stop();
    }
});

test("approvals: the global answer route resolves a gate by id alone", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const h = await connected(env, { name: "toto" });
        h.send({ id: "k2", type: "ask_approve", payload: { label: "erase the moon", detail: { sure: true } } });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "a parked gate");

        const row = (await env.api<{ approvals: ApprovalRow[] }>("GET", "/api/approvals")).json.approvals[0]!;
        const detail = (await env.api<ApprovalRow>("GET", `/api/approvals/${row.gate}`)).json;

        const bad = await env.api("POST", `/api/approvals/${row.gate}/answer`, { decisions: null });
        assert.equal(bad.status, 400);

        const answered = await env.api("POST", `/api/approvals/${row.gate}/answer`, {
            decisions: { [detail.actions[0]!.id]: false },
        });
        assert.deepEqual(answered.json, { ok: true });
        await waitFor(
            () => h.frames().some((f) => f["id"] === "k2" && f["type"] === "ask_approve_ok"),
            4000,
            "the agent was told",
        );
        assert.equal(
            (h.frames().find((f) => f["id"] === "k2")?.["payload"] as { approved: boolean }).approved,
            false,
        );

        // answered once = gone: the id is never reusable
        const again = await env.api<{ outcome: string }>("POST", `/api/approvals/${row.gate}/answer`, { decisions: {} });
        assert.equal(again.status, 409);
        assert.equal(again.json.outcome, "gone");
    } finally {
        await env.stop();
    }
});

test("turn_started marks the boundary in the POST stream, the mid-turn replay, and the summary", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        await connected(env, {
            name: "toto",
            tools: [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { send_email: { text: "SENT" } },
        });
        env.model.nextTurn(callTurn([{ id: "c1", name: "send_email" }]));
        env.model.nextTurn(textTurn("all done"));
        const session = await conversation(env);

        const live = await env.stream("POST", `/api/agents/toto/conversations/${session}/messages`, { text: "send it" });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the gate parks");

        const started = live.lines.find((e) => e["type"] === "turn_started");
        assert.equal(typeof started?.["turnSeq"], "number", "the POST stream opened with the boundary");

        // the summary names the running turn's boundary while busy
        const convs = await env.api<Array<Record<string, unknown>>>("GET", "/api/agents/toto/conversations");
        assert.equal(convs.json.find((c) => c["id"] === session)?.["activeTurnSeq"], started?.["turnSeq"]);

        // a mid-turn re-attach replays the boundary first
        const attached = await env.stream("GET", `/api/agents/toto/conversations/${session}/stream`);
        assert.equal(attached.status, 200);
        await waitFor(() => attached.lines.some((e) => e["type"] === "turn_started"), 4000, "replayed boundary");
        assert.deepEqual(attached.lines.find((e) => e["type"] === "turn_started")?.["turnSeq"], started?.["turnSeq"]);

        const gate = env.core.approvals.pending()[0]!.gate;
        const card = env.core.approvals.describe(gate)!;
        env.core.approvals.answer(gate, { [card.actions[0]!.id]: true });
        await Promise.all([live.done, attached.done]);
        // the re-attach took over the single emit slot, so completion lands on the replay reader
        assert.ok(attached.lines.some((e) => e["type"] === "done"));
    } finally {
        await env.stop();
    }
});

test("history: a payload written past the SDK is narrowed by the projection, never served raw", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const h = await connected(env, { name: "toto" });
        const id = await conversation(env);
        // straight into the agent's own db: shapes `Chat.appendMany` never looks at
        h.append(id, [
            { type: "message", payload: { role: "user", content: ["[stopped by user]"] } },
            { type: "message", payload: { role: "assistant", content: "fine", tool_calls: "abc", thinking: 7 } },
            { type: "message", payload: { role: "root", content: "shell" } },
            { type: "message", payload: { role: "user", content: "plain", meta: "human" } },
            // every meta field the pult renders, written as an object the way React refuses to render
            {
                type: "message",
                payload: {
                    role: "assistant",
                    content: "metadata",
                    meta: { callId: { boom: 1 }, registryModel: ["x"], actor: { kind: "agent", agent: { boom: 2 } } },
                },
            },
            { type: "message", payload: { role: "user", content: "authored", meta: { actor: { kind: "wizard" } } } },
            // no payload object at all, on the two event types the route reads fields off
            { type: "compaction", payload: null },
            { type: "truncate", payload: null },
            // a cut the fold refuses to trust: it must hide nothing here either
            { type: "truncate", payload: { fromSeq: "1" } },
        ] as unknown as EventBody[]);

        const history = await env.api<{ items: Array<Record<string, unknown>> }>(
            "GET",
            `/api/agents/toto/conversations/${id}/messages`,
        );
        assert.equal(history.status, 200, "a bad row never 500s the whole conversation");
        const items = history.json.items;
        // the unreadable role is dropped exactly as the model path drops it
        assert.deepEqual(items.map((i) => i["content"]), ["", "fine", "plain", "metadata", "authored"]);
        for (const i of items) assert.equal(typeof i["content"], "string");
        assert.equal("toolCalls" in items[1]!, false, "a non-array tool_calls is not forwarded");
        assert.equal("thinking" in items[1]!, false, "a non-string thinking is not forwarded");
        assert.equal("meta" in items[2]!, false, "a non-object meta is not forwarded");
        // only the declared fields survive, and only as strings: an object here blanks the pult's render
        assert.deepEqual(items[3]!["meta"], { actor: { kind: "agent" } });
        assert.equal("meta" in items[4]!, false, "an unknown actor kind leaves the author unknown");
        // the malformed compaction and the two malformed cuts are dropped, never dereferenced
        assert.equal(items.length, 5, "a payload-less row is skipped, and no bad cut hides a real one");
    } finally {
        await env.stop();
    }
});
