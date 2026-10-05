/** Token accounting on the real paths: what spent is, estimated usage, gated side calls, cost at the current price, the Calls wire, the owner's day. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EventBody, Message, Tool } from "@mimi-os/protocol";
import { runAgent } from "@mimi-os/sdk";
import { fakeAgentSocket, fakeIdentity, type ScriptedTurn } from "@mimi-os/sdk/testing";

import { addModel, getModel, setDefaultModel, setModelPricing } from "../src/llm/models.ts";
import { waitingCalls } from "../src/llm/queue.ts";
import { estimateUsage, newCallId, PING_AGENT, recordLlmCall } from "../src/store/accounting.ts";
import { dayInfo, dayStart, localDay, setTimeZone, shiftDay, timeZone } from "../src/store/day.ts";
import { autoTitle } from "../src/turn/autotitle.ts";
import { summarize } from "../src/turn/compaction.ts";
import { boot, waitFor, type Env } from "./harness-env.ts";

const said = (text: string, prompt: number, completion: number): ScriptedTurn => ({
    events: [
        { kind: "text", text },
        { kind: "finish", reason: "stop" },
    ],
    usage: { prompt_tokens: prompt, completion_tokens: completion },
});

const looks = (prompt: number): ScriptedTurn => ({
    events: [
        { kind: "tool_call", index: 0, id: "c1", name: "look", arguments: "{}" },
        { kind: "finish", reason: "tool_calls" },
    ],
    usage: { prompt_tokens: prompt, completion_tokens: 20 },
});

const rows = (env: Env, agent: string) => env.db.listLlmCalls(50, agent).reverse();

async function agentUp(env: Env, name: string, look = false) {
    const h = await env.connect(
        look
            ? { name, tools: [{ name: "look", description: "look", parameters: { type: "object", properties: {} }, writes: false }], handlers: { look: { text: "seen" } } }
            : { name, tools: [], handlers: {} },
    );
    await waitFor(() => env.core.registry.get(name) !== undefined, 4000, `${name} registered`);
    return h;
}

/** An endpoint that streams part of an answer and then never finishes — a call only a stop ends. */
async function hangingModel(): Promise<{ url: string; requests: () => number; aborted: () => number; close: () => Promise<void> }> {
    let requests = 0;
    let aborted = 0;
    const open = new Set<ServerResponse>();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        req.resume();
        req.on("end", () => {
            requests++;
            open.add(res);
            res.on("close", () => {
                if (open.delete(res)) aborted++;
            });
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial answer ".repeat(20) }, finish_reason: null }] })}\n\n`);
        });
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const port = (server.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${port}`,
        requests: () => requests,
        aborted: () => aborted,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
        },
    };
}

const delta = (d: Record<string, unknown>, finish: string | null = null): string =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;

/** An endpoint that answers request `n` (from 1) by hand: the wire states a scripted turn cannot reach. */
async function rawModel(answer: (res: ServerResponse, n: number) => void): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
    let requests = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        req.resume();
        req.on("end", () => answer(res, ++requests));
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    return {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        requests: () => requests,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
        },
    };
}

/** A port nothing listens on: every connection is refused, like a vLLM host that is down. */
async function closedPort(): Promise<string> {
    const server = createServer();
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as { port: number };
    await new Promise<void>((done) => server.close(() => done()));
    return `http://127.0.0.1:${port}`;
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── spent: every prompt and every completion, of every call

test("every call counts its whole prompt and completion: turns, the title between them, and compaction", async () => {
    const env = await boot({ contextTokens: 100_000 });
    try {
        const h = await agentUp(env, "alfa");
        const session = h.createSession();
        env.model.nextTurn(said("hello back", 1000, 50));
        env.model.nextTurn(said('{"title":"Greeting"}', 80, 10));
        env.model.nextTurn(said("second answer", 1100, 50));
        assert.equal(await (await env.core.runTurn({ agent: "alfa", session, text: "hello" })).titling, true);
        await env.core.runTurn({ agent: "alfa", session, text: "and more", title: false });

        assert.deepEqual(
            rows(env, "alfa").map((r) => [r.callKind, r.promptTokens, r.completionTokens]),
            [
                ["turn", 1000, 50],
                ["title", 80, 10],
                ["turn", 1100, 50],
            ],
        );
        const cell = env.db.usageMatrix("")[0]!;
        assert.equal(cell.promptTokens, 2180, "the re-sent context counts again, as a provider bills it");
        assert.equal(cell.totalTokens, 2290);
    } finally {
        await env.stop();
    }
});

test("a compaction is spent like any call, and reasoning tokens never count twice", async () => {
    const env = await boot();
    try {
        const h = await agentUp(env, "toto");
        const session = h.createSession("seeded", true);
        const bodies: EventBody[] = [];
        for (let i = 0; i < 12; i++) bodies.push({ type: "message", payload: { role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(600) } });
        h.append(session, bodies);
        const thought = said("answered", 900, 40);
        thought.usage.reasoning_tokens = 30;
        env.model.nextTurn(thought);
        env.model.nextTurn(said("A short summary of the earlier part.", 700, 30));
        await env.core.runTurn({ agent: "toto", session, text: "go", title: false });

        assert.deepEqual(
            rows(env, "toto").map((r) => [r.callKind, r.promptTokens, r.completionTokens]),
            [
                ["turn", 900, 40],
                ["compaction", 700, 30],
            ],
        );
        assert.equal(env.db.spendByAgent().get("toto")?.tokens, 1670, "reasoning is a subset of the completion");
    } finally {
        await env.stop();
    }
});

test("a real SDK ask() loop is spent round by round, whole, with no key of its own", async () => {
    const env = await boot({ contextTokens: 100_000 });
    const dir = mkdtempSync(join(tmpdir(), "mimi-agent-"));
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "wren", description: "Keeps the week in order." }));
    const identity = fakeIdentity();
    env.pin("wren", identity.pubkey);
    const agent = await runAgent({
        dir,
        url: `${env.ws}/channel`,
        socket: (url) => fakeAgentSocket(url, identity, env.core.devices.gatewayPub),
        log: () => undefined,
    });
    try {
        await waitFor(() => env.core.agent("wren").connected && agent.client.connected, 4000, "the agent registered");
        // an agent-side tool loop: re-send the growing transcript every round
        const messages: Message[] = [{ role: "user", content: "plan" }];
        const prompts = [3000, 3100, 3180];
        for (const [i, prompt] of prompts.entries()) {
            env.model.nextTurn(i < prompts.length - 1 ? looks(prompt) : said("planned", prompt, 30));
            const r = await agent.ask(messages, { scope: "routine" });
            messages.push({ role: "assistant", content: r.text || null, tool_calls: r.toolCalls });
            for (const call of r.toolCalls) messages.push({ role: "tool", tool_call_id: call.id, content: "seen" });
        }

        assert.deepEqual(
            rows(env, "wren").map((r) => [r.scope, r.callKind, r.promptTokens]),
            [
                ["wren:routine", "oneshot", 3000],
                ["wren:routine", "oneshot", 3100],
                ["wren:routine", "oneshot", 3180],
            ],
        );
        assert.equal(env.db.spendByAgent().get("wren")?.tokens, 9280 + 20 * 2 + 30);
    } finally {
        await agent.stop();
        await env.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an ask() with a session is the agent's spend and still names its chat; a room's turns are the agent's too", async () => {
    const env = await boot({ contextTokens: 100_000 });
    try {
        const h = await agentUp(env, "beta", true);
        const session = h.createSession("seeded", true);
        env.model.nextTurn(said("side", 300, 20));
        h.send({ id: "side", type: "chat", payload: { messages: [{ role: "user", content: "q" }], session, scope: "side" } });
        await waitFor(() => h.frames().some((f) => f["id"] === "side"), 4000, "side reply");
        assert.equal(rows(env, "beta")[0]?.conversationId, session);

        const room = (await env.api<{ room: { id: string } }>("POST", "/api/rooms", { title: "r" })).json.room.id;
        await env.api("POST", `/api/rooms/${room}/participants`, { agent: "beta" });
        env.model.nextTurn(looks(8000));
        env.model.nextTurn(said("done", 8030, 50));
        await (await env.stream("POST", `/api/rooms/${room}/messages`, { text: "beta, look", to: "beta" })).done;
        assert.deepEqual(rows(env, "beta").map((r) => [r.scope, r.room, r.promptTokens]), [
            ["beta:side", null, 300],
            ["beta", room, 8000],
            ["beta", room, 8030],
        ]);
        assert.equal(env.db.spendByAgent().get("beta")?.tokens, 300 + 20 + 8000 + 20 + 8030 + 50);
    } finally {
        await env.stop();
    }
});

// ── calls the provider had but never reported

test("a stopped call is charged an estimate, flagged and rolled up", async () => {
    const env = await boot({ contextTokens: 100_000 });
    const hanging = await hangingModel();
    try {
        const h = await agentUp(env, "alfa");
        const session = h.createSession("seeded", true);
        env.model.nextTurn(said("one", 2000, 50));
        await env.core.runTurn({ agent: "alfa", session, text: "one", title: false });

        addModel({ name: "slow", provider: "llamacpp", endpoint: hanging.url, contextTokens: 100_000 }, env.db);
        setDefaultModel("slow", env.db);
        let streamed = false;
        const run = env.core.turns.start({ agent: "alfa", session, text: "two", title: false, emit: (ev) => (streamed ||= ev["type"] === "text") });
        await waitFor(() => streamed, 4000, "the partial answer to stream");
        run.stop();
        await run.result;

        setDefaultModel("fake", env.db);
        env.model.nextTurn(said("three", 2100, 50));
        await env.core.runTurn({ agent: "alfa", session, text: "three", title: false });

        const [first, stopped, third] = rows(env, "alfa");
        assert.equal(stopped?.usageEstimated, true);
        assert.ok(stopped.promptTokens! > 0 && stopped.completionTokens! > 0, "the prompt and the streamed text both count");
        assert.equal(first?.usageEstimated, false);
        assert.equal(third?.usageEstimated, false);

        const today = env.db.usageMatrix(localDay());
        assert.equal(today.reduce((n, r) => n + r.estimatedCalls, 0), 1);
        assert.equal(
            env.db.spendByAgent().get("alfa")?.tokens,
            2050 + stopped.promptTokens! + stopped.completionTokens! + 2150,
            "spent includes the estimate",
        );
        const slow = (await env.api<Array<{ name: string; today: { tokens: number } }>>("GET", "/api/limits")).json.find((m) => m.name === "slow");
        assert.equal(slow?.today.tokens, stopped.promptTokens! + stopped.completionTokens!, "the estimate counts toward the model's limit");
        const wire = (await env.api<Array<Record<string, unknown>>>("GET", `/api/agents/alfa/calls?conversation=${session}`)).json;
        assert.deepEqual(wire.map((c) => c["usageEstimated"]), [false, true, false]);
    } finally {
        await hanging.close();
        await env.stop();
    }
});

test("a tool call cut off mid-stream is charged the arguments it streamed: a stop, a dropped socket, an agent's own ask", async () => {
    const env = await boot({ contextTokens: 100_000 });
    const args = JSON.stringify({ path: "notes.md", content: "y".repeat(8_000) });
    const streamed = Math.ceil(`write_file${args}`.length / 4);
    const opened = (res: ServerResponse): void => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "write_file", arguments: args } }] }));
    };
    const holding = await rawModel(opened);
    const dropping = await rawModel((res) => {
        opened(res);
        setTimeout(() => res.destroy(), 50);
    });
    try {
        const h = await agentUp(env, "alfa");
        addModel({ name: "holding", provider: "llamacpp", endpoint: holding.url, contextTokens: 100_000 }, env.db);
        addModel({ name: "dropping", provider: "llamacpp", endpoint: dropping.url, contextTokens: 100_000 }, env.db);

        setDefaultModel("holding", env.db);
        const run = env.core.turns.start({ agent: "alfa", session: h.createSession("stop", true), text: "write it", title: false });
        await waitFor(() => holding.requests() === 1, 4000, "the call to reach the endpoint");
        await pause(200);
        run.stop();
        await run.result;

        setDefaultModel("dropping", env.db);
        await assert.rejects(env.core.runTurn({ agent: "alfa", session: h.createSession("drop", true), text: "write it", title: false }));
        h.send({ id: "ask", type: "chat", payload: { messages: [{ role: "user", content: "write it" }], scope: "routine", stream: true } });
        await waitFor(() => h.frames().some((f) => f["id"] === "ask" && f["type"] !== "stream"), 4000, "the ask to fail");

        const calls = rows(env, "alfa");
        assert.deepEqual(calls.map((r) => [r.registryModel, r.callKind, r.usageEstimated]), [
            ["holding", "turn", true],
            ["dropping", "turn", true],
            ["dropping", "oneshot", true],
        ]);
        for (const r of calls) {
            assert.ok(r.promptTokens! > 0, "the prompt it was sent counts");
            assert.equal(r.completionTokens, streamed, `${r.callKind} on ${r.registryModel}: the streamed name and arguments count`);
            assert.ok(r.firstOutputMs !== null, "the first tool-call delta was output");
        }
        const streamedToAgent = h.frames().filter((f) => f["id"] === "ask" && f["type"] === "stream").map((f) => (f["payload"] as { type: string }).type);
        assert.ok(!streamedToAgent.some((t) => t === "accepted" || t === "tool_args"), "the gateway's own progress events never reach an agent");
    } finally {
        await holding.close();
        await dropping.close();
        await env.stop();
    }
});

test("a tool-call round's first output is its first tool-call delta, not the end of the stream", async () => {
    const env = await boot({ contextTokens: 100_000 });
    const slow = await rawModel((res, n) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`;
        if (n > 1) {
            res.end(delta({ content: "done" }) + delta({}, "stop") + usage + "data: [DONE]\n\n");
            return;
        }
        res.write(delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "look", arguments: "{" } }] }));
        setTimeout(() => res.end(delta({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }) + delta({}, "tool_calls") + usage + "data: [DONE]\n\n"), 500);
    });
    try {
        const h = await agentUp(env, "alfa", true);
        addModel({ name: "slow", provider: "llamacpp", endpoint: slow.url, contextTokens: 100_000 }, env.db);
        setDefaultModel("slow", env.db);
        assert.equal((await env.core.runTurn({ agent: "alfa", session: h.createSession("t", true), text: "look", title: false })).text, "done");
        const round = rows(env, "alfa")[0]!;
        assert.ok(round.durationMs! >= 500);
        assert.ok(round.firstOutputMs! < round.durationMs! - 300, `first output ${round.firstOutputMs}ms of ${round.durationMs}ms`);
    } finally {
        await slow.close();
        await env.stop();
    }
});

test("a stop before any provider took the call spends nothing: a refused connection, a 503 while the model loads", async () => {
    const env = await boot({ contextTokens: 100_000 });
    const loading = await rawModel((res) => res.writeHead(503).end("Loading model"));
    try {
        const h = await agentUp(env, "alfa");
        addModel({ name: "down", provider: "llamacpp", endpoint: await closedPort(), contextTokens: 100_000 }, env.db);
        addModel({ name: "loading", provider: "llamacpp", endpoint: loading.url, contextTokens: 100_000 }, env.db);
        for (const name of ["down", "loading"]) {
            setDefaultModel(name, env.db);
            const run = env.core.turns.start({ agent: "alfa", session: h.createSession(name, true), text: "x".repeat(20_000), title: false });
            // the first attempt failed at once: postSSE now sleeps 1 s before its retry
            await pause(300);
            run.stop();
            await run.result;
        }
        assert.equal(loading.requests(), 1, "the only answer was a 503");
        assert.deepEqual(rows(env, "alfa").map((r) => [r.registryModel, r.usageEstimated, r.promptTokens]), [
            ["down", false, null],
            ["loading", false, null],
        ]);
        const limits = (await env.api<Array<{ name: string; today: { tokens: number } }>>("GET", "/api/limits")).json;
        assert.deepEqual(limits.filter((m) => m.name !== "fake").map((m) => [m.name, m.today.tokens]), [
            ["down", 0],
            ["loading", 0],
        ]);
    } finally {
        await loading.close();
        await env.stop();
    }
});

test("a call the provider took and lost before any output is estimated: a cut socket, an error chunk", async () => {
    const env = await boot({ contextTokens: 100_000 });
    const cut = await rawModel((res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(delta({ role: "assistant" }));
        setTimeout(() => res.destroy(), 50);
    });
    const failing = await rawModel((res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ error: { code: 502, message: "upstream died" }, choices: [{ index: 0, delta: {}, finish_reason: "error" }] })}\n\n`);
    });
    try {
        const h = await agentUp(env, "alfa");
        addModel({ name: "cut", provider: "llamacpp", endpoint: cut.url, contextTokens: 100_000 }, env.db);
        addModel({ name: "failing", provider: "llamacpp", endpoint: failing.url, contextTokens: 100_000 }, env.db);
        for (const name of ["cut", "failing"]) {
            setDefaultModel(name, env.db);
            await assert.rejects(env.core.runTurn({ agent: "alfa", session: h.createSession(name, true), text: "x".repeat(20_000), title: false }));
        }
        const calls = rows(env, "alfa");
        assert.deepEqual(calls.map((r) => [r.registryModel, r.usageEstimated, r.completionTokens]), [
            ["cut", true, 0],
            ["failing", true, 0],
        ]);
        assert.ok(calls.every((r) => r.promptTokens! > 5_000), "the whole prompt it was sent");
    } finally {
        await cut.close();
        await failing.close();
        await env.stop();
    }
});

test("title, compaction and a model check the provider had are estimated when it never reports: no usage chunk, a stop mid-stream", async () => {
    const env = await boot({ contextTokens: 100_000 });
    const silent = await rawModel((res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(delta({ content: '{"title":"Quiet servers"}' }) + delta({}, "stop") + "data: [DONE]\n\n");
    });
    const hanging = await hangingModel();
    try {
        const h = await agentUp(env, "toto");
        const peer = env.core.registry.get("toto")!;
        addModel({ name: "silent", provider: "llamacpp", endpoint: silent.url, contextTokens: 100_000 }, env.db);
        addModel({ name: "slow", provider: "llamacpp", endpoint: hanging.url, contextTokens: 100_000 }, env.db);
        env.db.setModelsPolicy("toto", { allowed: ["fake", "silent", "slow"], primary: "fake" });
        const lines = ["user: what changed", "assistant: the server stopped sending usage"];

        assert.equal(await autoTitle({ agent: "toto", session: h.createSession(), peer, seed: "why is the server quiet", model: "silent", db: env.db }), true);
        assert.equal(await summarize({ agent: "toto", session: h.createSession(), cfg: getModel("silent", env.db)!, turnSeq: null }, lines, env.db), '{"title":"Quiet servers"}');
        assert.equal((await env.api("POST", "/api/models/silent/ping")).status, 200);

        const titleStop = new AbortController();
        const titled = autoTitle({ agent: "toto", session: h.createSession(), peer, seed: "a slow one", model: "slow", db: env.db, signal: titleStop.signal });
        await waitFor(() => hanging.requests() === 1, 4000, "the title call to reach the endpoint");
        titleStop.abort(new Error("chat deleted"));
        assert.equal(await titled, false);
        const compactionStop = new AbortController();
        const summary = summarize({ agent: "toto", session: h.createSession(), cfg: getModel("slow", env.db)!, turnSeq: null, signal: compactionStop.signal }, lines, env.db);
        await waitFor(() => hanging.requests() === 2, 4000, "the compaction call to reach the endpoint");
        compactionStop.abort(new Error("stopped by user"));
        assert.equal(await summary, null);

        const calls = env.db.listLlmCalls(10).reverse();
        assert.deepEqual(calls.map((r) => [r.callKind, r.registryModel, r.usageEstimated]), [
            ["title", "silent", true],
            ["compaction", "silent", true],
            ["ping", "silent", true],
            ["title", "slow", true],
            ["compaction", "slow", true],
        ]);
        assert.ok(calls.every((r) => r.promptTokens! > 0), "each prompt it was sent counts");
        assert.ok(calls.slice(0, 3).every((r) => r.completionTokens! > 0), "and each answer it streamed");
        const spentOn = (name: string): number =>
            calls.filter((r) => r.registryModel === name).reduce((n, r) => n + r.promptTokens! + r.completionTokens!, 0);
        const limits = (await env.api<Array<{ name: string; today: { tokens: number } }>>("GET", "/api/limits")).json;
        assert.deepEqual(limits.filter((m) => m.name !== "fake").map((m) => [m.name, m.today.tokens]), [
            ["silent", spentOn("silent")],
            ["slow", spentOn("slow")],
        ]);
    } finally {
        await silent.close();
        await hanging.close();
        await env.stop();
    }
});

test("an estimate leaves out only the images a message carries, never a tool parameter of that name", () => {
    const slides = (key: string): Tool => ({
        type: "function",
        function: { name: "make_slides", parameters: { type: "object", properties: { [key]: { type: "array", description: "d".repeat(4_000) } } } },
    });
    const ask: Message[] = [{ role: "user", content: "make slides", images: [`data:image/png;base64,${"A".repeat(40_000)}`] }];
    const named = estimateUsage(ask, [slides("images")], "").promptTokens;
    assert.equal(named, estimateUsage(ask, [slides("photos")], "").promptTokens);
    assert.ok(named > 1_000, "the parameter's schema is in the prompt");
    assert.equal(estimateUsage(ask, [], "").promptTokens, estimateUsage([{ role: "user", content: "make slides" }], [], "").promptTokens);
});

test("a call stopped while it waits in the queue never reached the provider and spends nothing", async () => {
    const env = await boot({ contextTokens: 100_000 });
    const hanging = await hangingModel();
    try {
        const h = await agentUp(env, "alfa");
        addModel({ name: "slow", provider: "llamacpp", endpoint: hanging.url, contextTokens: 100_000 }, env.db);
        setDefaultModel("slow", env.db);
        const a = h.createSession("a", true);
        const b = h.createSession("b", true);
        const busy = env.core.turns.start({ agent: "alfa", session: a, text: "hold the slot", title: false });
        await waitFor(() => hanging.requests() === 1, 4000, "the slot to be taken");
        const queued = env.core.turns.start({ agent: "alfa", session: b, text: "wait", title: false });
        await waitFor(() => waitingCalls(hanging.url) === 1, 4000, "the second call to queue behind the first");
        queued.stop();
        await waitFor(() => waitingCalls(hanging.url) === 0, 4000, "the stopped call to leave the queue");
        await queued.result;
        busy.stop();
        await busy.result;
        const held = rows(env, "alfa").find((r) => r.conversationId === a);
        const waited = rows(env, "alfa").find((r) => r.conversationId === b);
        assert.equal(held?.usageEstimated, true);
        assert.equal(waited?.usageEstimated, false);
        assert.equal(waited?.promptTokens, null);
        assert.equal(hanging.requests(), 1);
        // the stopped call stays a trace, never a model call: one call on the model's tally, one timing sample
        assert.deepEqual(env.db.usageMatrix(localDay()).map((r) => [r.registryModel, r.calls]), [["slow", 1]]);
        const perf = (await env.api<{ modelRows: Array<{ registryModel: string; calls: number; latencyMs: { samples: number } }> }>("GET", "/api/stats/performance?days=1")).json;
        assert.deepEqual(perf.modelRows.map((r) => [r.registryModel, r.calls, r.latencyMs.samples]), [["slow", 1, 1]]);
    } finally {
        await hanging.close();
        await env.stop();
    }
});

test("a limit spent while a call waits in the queue hands that call to the fallback", async () => {
    const env = await boot({ contextTokens: 100_000 });
    const hanging = await hangingModel();
    try {
        const h = await agentUp(env, "alfa");
        addModel({ name: "slow", provider: "llamacpp", endpoint: hanging.url, contextTokens: 100_000 }, env.db);
        setModelPricing("slow", { limit: { unit: "tokens", value: 1000 } }, env.db);
        env.db.setModelsPolicy("alfa", { allowed: ["slow", "fake"], primary: "slow", fallback: "fake" });
        const a = h.createSession("a", true);
        const b = h.createSession("b", true);
        const busy = env.core.turns.start({ agent: "alfa", session: a, text: "hold the slot", title: false });
        await waitFor(() => hanging.requests() === 1, 4000, "the slot to be taken");
        const queued = env.core.turns.start({ agent: "alfa", session: b, text: "wait", title: false });
        await waitFor(() => waitingCalls(hanging.url) === 1, 4000, "the second call to queue behind the first");
        // another agent spends the model's day while this call still waits
        recordLlmCall(
            { agent: "beta", scope: "beta", callId: newCallId(), callKind: "oneshot", modelUid: getModel("slow", env.db)!.modelUid, registryModel: "slow", usage: { promptTokens: 5000, completionTokens: 0, totalTokens: 5000, cachedTokens: 0 }, raw: {} },
            env.db,
        );
        env.model.nextTurn(said("from the fallback", 40, 5));
        busy.stop();
        await busy.result;
        assert.equal((await queued.result).text, "from the fallback");

        const calls = rows(env, "alfa").filter((r) => r.conversationId === b);
        assert.deepEqual(calls.map((r) => [r.registryModel, r.attempt, r.finishReason, r.promptTokens]), [
            ["slow", 1, "error", null],
            ["fake", 2, "stop", 40],
        ]);
        assert.match(calls[0]!.raw, /model slow reached its daily limit; resets at midnight/);
        assert.equal(hanging.requests(), 1, "the full model never saw the queued call");
    } finally {
        await hanging.close();
        await env.stop();
    }
});

test("deleting a chat stops its running turn before the chat goes", async () => {
    const env = await boot({ contextTokens: 100_000 });
    const hanging = await hangingModel();
    try {
        const h = await agentUp(env, "alfa");
        addModel({ name: "slow", provider: "llamacpp", endpoint: hanging.url, contextTokens: 100_000 }, env.db);
        setDefaultModel("slow", env.db);
        const session = h.createSession("doomed", true);
        const run = env.core.turns.start({ agent: "alfa", session, text: "go", title: false });
        await waitFor(() => hanging.requests() === 1, 4000, "the call to reach the endpoint");

        const gone = await env.api("DELETE", `/api/agents/alfa/conversations/${session}`);
        assert.equal(gone.status, 200);
        assert.equal(env.core.turns.get("alfa", session), undefined, "the turn is over");
        assert.equal((await run.result).text, "Stopped by user before completion.");
        await waitFor(() => hanging.aborted() === 1, 4000, "the provider request to be cut");
        assert.equal(h.sessions.has(session), false);
        assert.equal(rows(env, "alfa")[0]?.usageEstimated, true, "what it had already spent is charged");
    } finally {
        await hanging.close();
        await env.stop();
    }
});

// ── side calls pass the same gate

test("compaction and the auto-title are refused once the model's limit is spent: no provider call, no charge", async () => {
    const env = await boot();
    try {
        const h = await agentUp(env, "toto");
        setModelPricing("fake", { limit: { unit: "tokens", value: 1000 } }, env.db);
        const session = h.createSession();
        const bodies: EventBody[] = [];
        for (let i = 0; i < 12; i++) bodies.push({ type: "message", payload: { role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(600) } });
        h.append(session, bodies);
        env.model.nextTurn(said("answered", 900, 200));
        env.model.nextTurn(said("A short summary of the earlier part.", 4000, 300));
        env.model.nextTurn(said('{"title":"Over the limit"}', 150, 10));
        const out = await env.core.runTurn({ agent: "toto", session, text: "go" });
        await out.titling;

        assert.equal(env.model.requests.length, 1, "only the turn itself reached the model");
        assert.equal(env.db.spendByAgent().get("toto")?.tokens, 1100);
        assert.deepEqual(
            rows(env, "toto").map((r) => [r.callKind, r.promptTokens]),
            [
                ["turn", 900],
                ["compaction", null],
                ["title", null],
            ],
        );
        assert.match(env.db.listLlmCalls(1, "toto")[0]!.raw, /model fake reached its daily limit; resets at midnight/);
    } finally {
        await env.stop();
    }
});

test("a paused agent's compaction and title calls never reach the model", async () => {
    const env = await boot();
    try {
        const h = await agentUp(env, "toto");
        const session = h.createSession();
        env.db.setPaused("toto", true);
        const cfg = getModel("fake", env.db)!;
        assert.equal(await summarize({ agent: "toto", session, cfg, turnSeq: null }, ["user: hi"], env.db), null);
        const peer = env.core.registry.get("toto")!;
        await autoTitle({ agent: "toto", session, peer, seed: "hello there", model: "fake", db: env.db });
        assert.equal(env.model.requests.length, 0);
        assert.ok(rows(env, "toto").every((r) => /paused/.test(r.raw)));
    } finally {
        await env.stop();
    }
});

// ── the read routes

test("the Calls wire carries the cost at the current price, the model uid and the estimate flag, and filters by chat", async () => {
    const env = await boot({ contextTokens: 100_000 });
    try {
        const h = await agentUp(env, "alfa");
        const one = h.createSession("one", true);
        const two = h.createSession("two", true);
        env.model.nextTurn(said("a", 100, 10));
        await env.core.runTurn({ agent: "alfa", session: one, text: "a", title: false });
        env.model.nextTurn(said("b", 200, 10));
        await env.core.runTurn({ agent: "alfa", session: two, text: "b", title: false });
        env.model.nextTurn(said("c", 160, 10));
        await env.core.runTurn({ agent: "alfa", session: one, text: "c", title: false });

        type Wire = Array<Record<string, unknown>>;
        const mine = (await env.api<Wire>("GET", `/api/agents/alfa/calls?conversation=${one}`)).json;
        assert.deepEqual(mine.map((c) => [c["conversationId"], c["promptTokens"], c["cost"]]), [
            [one, 160, 0],
            [one, 100, 0],
        ]);
        assert.equal("freshInput" in mine[0]!, false);
        // a price set later re-prices the calls already made: $1/M in, $4/M out
        setModelPricing("fake", { priceInPerM: 1, priceOutPerM: 4 }, env.db);
        const priced = (await env.api<Wire>("GET", `/api/agents/alfa/calls?conversation=${one}`)).json;
        assert.deepEqual(priced.map((c) => c["cost"]), [(160 + 10 * 4) / 1e6, (100 + 10 * 4) / 1e6]);
        assert.equal(mine[0]?.["modelUid"], getModel("fake", env.db)!.modelUid);
        assert.equal(mine[0]?.["usageEstimated"], false);
        assert.equal((await env.api<Wire>("GET", "/api/agents/alfa/calls")).json.length, 3);
        assert.equal((await env.api("GET", "/api/agents/alfa/calls?conversation=zero")).status, 400);
        assert.equal((await env.api("GET", "/api/agents/alfa/calls?conversation=0")).status, 400);
    } finally {
        await env.stop();
    }
});

test("every today view is the same raw spend on the owner's day, priced now, with the reset instant beside it", async () => {
    const env = await boot({ contextTokens: 100_000 });
    try {
        const h = await agentUp(env, "alfa");
        const session = h.createSession("one", true);
        env.model.nextTurn(said("a", 1000, 50));
        await env.core.runTurn({ agent: "alfa", session, text: "a", title: false });
        env.model.nextTurn(said("b", 1100, 50));
        await env.core.runTurn({ agent: "alfa", session, text: "b", title: false });
        const spent = 2200;
        // 2100 prompt at $3/M + 100 completion at $15/M
        setModelPricing("fake", { priceInPerM: 3, priceOutPerM: 15 }, env.db);
        const cost = (2100 * 3 + 100 * 15) / 1e6;

        const dash = (await env.api<{ day: unknown; agents: Array<{ name: string; tokensToday: number; costToday: number }> }>("GET", "/api/dashboard")).json;
        const card = dash.agents.find((a) => a.name === "alfa");
        assert.deepEqual([card?.tokensToday, card?.costToday], [spent, cost]);
        assert.deepEqual(dash.day, dayInfo());
        const usage = (await env.api<{ day: unknown; rows: Array<{ cost: number }>; totals: { totalTokens: number; cost: number } }>("GET", "/api/stats/usage?days=1")).json;
        assert.deepEqual([usage.totals.totalTokens, usage.totals.cost, usage.rows[0]?.cost], [spent, cost, cost]);
        assert.equal("freshInput" in usage.totals, false);
        const daily = (await env.api<{ rows: Array<{ totalTokens: number; cost: number }> }>("GET", "/api/stats/daily?days=1&group=registry")).json;
        assert.equal(daily.rows.reduce((n, r) => n + r.totalTokens, 0), spent, "the chart and the tile are one measure");
        assert.equal(daily.rows.reduce((n, r) => n + r.cost, 0), cost);
        const limits = (await env.api<Array<{ name: string; today: unknown }>>("GET", "/api/limits")).json;
        assert.deepEqual(limits.find((m) => m.name === "fake")?.today, { tokens: spent, promptTokens: 2100, completionTokens: 100, cost });
        // the policy view no longer carries a spend of its own
        const policy = (await env.api<Record<string, unknown>>("GET", "/api/agents/alfa/models")).json;
        assert.equal("spentToday" in policy, false);
    } finally {
        await env.stop();
    }
});

test("two aliases over one provider model id keep their own daily cells", async () => {
    const env = await boot();
    try {
        const day = localDay();
        for (const [uid, alias, prompt] of [["uid-a", "fast", 100], ["uid-b", "cheap", 40], ["uid-b", "cheap", 2]] as const) {
            recordLlmCall(
                { agent: "alfa", scope: "alfa", callId: newCallId(), callKind: "oneshot", model: "gpt", modelUid: uid, registryModel: alias, usage: { promptTokens: prompt, completionTokens: 0, totalTokens: prompt, cachedTokens: 0 }, raw: {} },
                env.db,
                day,
            );
        }
        assert.deepEqual(
            env.db.usageByRegistry(day).map((r) => [r.modelUid, r.registryModel, r.calls, r.totalTokens]),
            [
                ["uid-a", "fast", 1, 100],
                ["uid-b", "cheap", 2, 42],
            ],
        );
        assert.equal(env.db.usageMatrix(day)[0]?.totalTokens, 142, "the provider-model view still sums both");

        // "fast" renamed to "alpha": another agent's newer call names the bucket, never the older alias
        recordLlmCall(
            { agent: "beta", scope: "beta", callId: newCallId(), callKind: "oneshot", model: "gpt", modelUid: "uid-a", registryModel: "alpha", usage: { promptTokens: 8, completionTokens: 0, totalTokens: 8, cachedTokens: 0 }, raw: {} },
            env.db,
            day,
        );
        assert.equal(env.db.usageByRegistry(day).find((r) => r.modelUid === "uid-a")?.registryModel, "alpha");
        assert.equal(env.db.usageSeries(day)[0]?.registryModel, "alpha");
    } finally {
        await env.stop();
    }
});

test("a ping is recorded as the gateway's own call: outside every agent's calls, on the model's own tally", async () => {
    const env = await boot();
    try {
        await agentUp(env, "alfa");
        env.model.nextTurn(said("pong", 12, 1));
        assert.equal((await env.api("POST", "/api/models/fake/ping")).status, 200);
        const [ping] = env.db.listLlmCalls(5);
        assert.equal(ping?.agent, PING_AGENT);
        assert.equal(ping?.callKind, "ping");
        assert.equal(ping?.modelUid, getModel("fake", env.db)!.modelUid);
        assert.equal((await env.api<unknown[]>("GET", "/api/agents/alfa/calls")).json.length, 0);
        const dash = (await env.api<{ agents: Array<{ name: string }> }>("GET", "/api/dashboard")).json;
        assert.deepEqual(dash.agents.map((a) => a.name), ["alfa"]);
        const usage = (await env.api<{ rows: Array<{ agent: string; totalTokens: number }> }>("GET", "/api/stats/usage?days=1")).json;
        assert.deepEqual(usage.rows.map((r) => [r.agent, r.totalTokens]), [[PING_AGENT, 13]]);
        const limits = (await env.api<Array<{ name: string; today: { tokens: number } }>>("GET", "/api/limits")).json;
        assert.equal(limits.find((m) => m.name === "fake")?.today.tokens, 13);

        // a ping is never refused, not even by a spent limit
        setModelPricing("fake", { limit: { unit: "tokens", value: 13 } }, env.db);
        env.model.nextTurn(said("pong", 12, 1));
        assert.equal((await env.api("POST", "/api/models/fake/ping")).status, 200);
    } finally {
        await env.stop();
    }
});

// ── the owner's day

test("MIMI_TZ sets the day every bucket and limit uses; DST days are 23 and 25 hours", async (t) => {
    const host = timeZone();
    t.after(() => setTimeZone(host));
    assert.throws(() => setTimeZone("Mars/Base"), /MIMI_TZ="Mars\/Base" is not an IANA time zone/);
    assert.equal(timeZone(), host, "a refused zone changes nothing");

    assert.equal(setTimeZone("Europe/Helsinki"), "Europe/Helsinki");
    // 22:30 UTC on Sep 29 is already Sep 30 in Helsinki
    assert.equal(localDay(Date.parse("2026-09-29T22:30:00Z")), "2026-09-30");
    assert.equal(localDay(Date.parse("2026-09-29T20:59:59Z")), "2026-09-29");
    assert.equal(new Date(dayStart("2026-09-30")).toISOString(), "2026-09-29T21:00:00.000Z");
    // the clocks go back on Oct 25: that day runs 25 hours, from 21:00 UTC to 22:00 UTC next day
    assert.equal(new Date(dayStart("2026-10-25")).toISOString(), "2026-10-24T21:00:00.000Z");
    assert.equal(new Date(dayStart("2026-10-26")).toISOString(), "2026-10-25T22:00:00.000Z");
    assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
    assert.deepEqual(dayInfo(Date.parse("2026-09-29T12:00:00Z")), {
        today: "2026-09-29",
        timeZone: "Europe/Helsinki",
        resetsAt: "2026-09-29T21:00:00.000Z",
    });

    // a call recorded now lands on the owner's day, and the model's limit reads that same day
    const env = await boot();
    try {
        const uid = getModel("fake", env.db)!.modelUid;
        recordLlmCall(
            { agent: "alfa", scope: "alfa", callId: newCallId(), callKind: "oneshot", modelUid: uid, usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12, cachedTokens: 0 }, raw: {} },
            env.db,
        );
        assert.deepEqual(env.db.usageSeries(shiftDay(localDay(), -1)).map((r) => r.day), [localDay()]);
        assert.deepEqual(env.db.modelTokens().get(uid), { promptTokens: 7, completionTokens: 5 });
        assert.equal(env.db.modelTokens(shiftDay(localDay(), -1)).size, 0);
    } finally {
        await env.stop();
    }
});

test("a day whose local midnight a DST switch skips starts at the switch, not an hour before it", (t) => {
    const host = timeZone();
    t.after(() => setTimeZone(host));
    setTimeZone("America/Santiago");
    // Sep 6, 2026: 00:00 at -04 is already 01:00 at -03
    assert.equal(new Date(dayStart("2026-09-06")).toISOString(), "2026-09-06T04:00:00.000Z");
    assert.equal(dayInfo(Date.parse("2026-09-05T15:00:00Z")).resetsAt, "2026-09-06T04:00:00.000Z");
    setTimeZone("America/Havana");
    assert.equal(new Date(dayStart("2026-03-08")).toISOString(), "2026-03-08T05:00:00.000Z");
    // every day of the year, in zones that switch at midnight, at another hour, by half an hour, or never
    for (const zone of ["America/Santiago", "America/Havana", "Europe/Helsinki", "Australia/Lord_Howe", "Asia/Kolkata"]) {
        setTimeZone(zone);
        for (let day = "2026-01-01"; day <= "2026-12-31"; day = shiftDay(day, 1)) {
            const at = dayStart(day);
            assert.deepEqual([localDay(at), localDay(at - 1000)], [day, shiftDay(day, -1)], `${zone} ${day}`);
        }
    }
});

test("the dashboard's today is every agent's spend, a revoked agent's too, and never a model check", async () => {
    const env = await boot();
    try {
        const uid = getModel("fake", env.db)!.modelUid;
        setModelPricing("fake", { priceInPerM: 2, priceOutPerM: 6 }, env.db);
        const spend = (agent: string, prompt: number, completion: number): void =>
            recordLlmCall(
                { agent, scope: agent, callId: newCallId(), callKind: "turn", modelUid: uid, registryModel: "fake", usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, cachedTokens: 0 }, raw: {} },
                env.db,
            );
        env.pin("alfa");
        env.pin("beta");
        spend("alfa", 50_000, 5_000);
        spend("beta", 1_000, 100);
        spend(PING_AGENT, 12, 1);
        type Dash = { today: { tokens: number; cost: number }; agents: Array<{ name: string }> };
        const before = (await env.api<Dash>("GET", "/api/dashboard")).json;
        const cost = (51_000 * 2 + 5_100 * 6) / 1e6;
        assert.deepEqual(before.today, { tokens: 56_100, cost });

        assert.equal((await env.api("DELETE", "/api/pins/alfa")).status, 200);
        const after = (await env.api<Dash>("GET", "/api/dashboard")).json;
        assert.equal(after.agents.some((a) => a.name === "alfa"), false, "the roster is who is pinned now");
        assert.deepEqual(after.today, { tokens: 56_100, cost }, "what alfa spent today stays spent");
    } finally {
        await env.stop();
    }
});

test("a spent model reopens at the owner's midnight, not UTC's: real turns across the boundary", async (t) => {
    const host = timeZone();
    t.after(() => setTimeZone(host));
    setTimeZone("Europe/Helsinki");
    const env = await boot();
    try {
        const h = await agentUp(env, "toto");
        const session = h.createSession();
        setModelPricing("fake", { limit: { unit: "tokens", value: 100 } }, env.db);
        type Limits = Array<{ today: { tokens: number }; day: { today: string; resetsAt: string } }>;
        // 23:58 in Helsinki is 20:58 UTC
        t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-29T20:58:00Z") });
        env.model.nextTurn(said("before midnight", 90, 10));
        assert.equal((await env.core.runTurn({ agent: "toto", session, text: "a", title: false })).text, "before midnight");
        t.mock.timers.setTime(Date.parse("2026-09-29T20:59:59Z"));
        await assert.rejects(env.core.runTurn({ agent: "toto", session, text: "b", title: false }), /resets at midnight Europe\/Helsinki$/);
        const spent = (await env.api<Limits>("GET", "/api/limits")).json[0]!;
        assert.deepEqual([spent.today.tokens, spent.day.today, spent.day.resetsAt], [100, "2026-09-29", "2026-09-29T21:00:00.000Z"]);

        t.mock.timers.setTime(Date.parse("2026-09-29T21:00:00Z"));
        const fresh = (await env.api<Limits>("GET", "/api/limits")).json[0]!;
        assert.deepEqual([fresh.today.tokens, fresh.day.today], [0, "2026-09-30"]);
        env.model.nextTurn(said("after midnight", 90, 10));
        assert.equal((await env.core.runTurn({ agent: "toto", session, text: "c", title: false })).text, "after midnight");
    } finally {
        await env.stop();
    }
});

test("a stopped call's estimate closes the model's limit for the next call", async () => {
    const env = await boot({ contextTokens: 100_000 });
    const hanging = await hangingModel();
    try {
        const h = await agentUp(env, "alfa");
        addModel({ name: "slow", provider: "llamacpp", endpoint: hanging.url, contextTokens: 100_000 }, env.db);
        setDefaultModel("slow", env.db);
        setModelPricing("slow", { limit: { unit: "tokens", value: 50 } }, env.db);
        const session = h.createSession("one", true);
        let streamed = false;
        const run = env.core.turns.start({ agent: "alfa", session, text: "go", title: false, emit: (ev) => (streamed ||= ev["type"] === "text") });
        await waitFor(() => streamed, 4000, "the partial answer to stream");
        run.stop();
        await run.result;

        const [stopped] = rows(env, "alfa");
        assert.equal(stopped?.usageEstimated, true);
        assert.ok(stopped.promptTokens! + stopped.completionTokens! >= 50);
        await assert.rejects(env.core.runTurn({ agent: "alfa", session, text: "again", title: false }), /model slow reached its daily limit/);
        assert.equal(hanging.requests(), 1, "the refused turn never reached the model");
    } finally {
        await hanging.close();
        await env.stop();
    }
});

test("usage events stay with their own gateway when another core starts or stops", async (t) => {
    const first = await boot();
    const second = await boot();
    t.after(() => first.stop());
    t.after(() => second.stop());
    const firstUsage: string[] = [];
    const secondUsage: string[] = [];
    first.core.events.subscribe((event) => {
        if (event.type === "usage_changed") firstUsage.push(String(event["agent"]));
    });
    second.core.events.subscribe((event) => {
        if (event.type === "usage_changed") secondUsage.push(String(event["agent"]));
    });

    recordLlmCall({ agent: "alpha", scope: "alpha", callId: newCallId(), callKind: "turn", raw: {} }, first.db);
    assert.deepEqual(firstUsage, ["alpha"]);
    assert.deepEqual(secondUsage, []);
    await first.core.stop();
    recordLlmCall({ agent: "beta", scope: "beta", callId: newCallId(), callKind: "turn", raw: {} }, second.db);
    assert.deepEqual(secondUsage, ["beta"]);
});
