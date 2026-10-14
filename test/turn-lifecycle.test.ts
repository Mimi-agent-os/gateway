import "./pq-home.ts";

import assert from "node:assert/strict";
import { createServer, IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import test from "node:test";

import { chainHash, REPLY_OF, type CompactionPayload, type EventBody, type SessionHead, type StoredEvent } from "@mimi-os/protocol";
import type { GatewayCore } from "../src/core.ts";
import { Router } from "../src/http/router.ts";
import { registerTurns } from "../src/http/turns.ts";
import { addModel, setDefaultModel } from "../src/llm/models.ts";
import { createFakeAgentCore, fakeAgentSocket, fakeIdentity, type FakeAgentCore } from "@mimi-os/sdk/testing";
import { autoApprove, boot, callTurn, textTurn, waitFor, type Env, type NdjsonStream } from "./harness-env.ts";
import type { Harness } from "./agent-harness.ts";

interface PendingModelRequest {
    body: Record<string, unknown>;
    res: ServerResponse;
}

interface ControlledModel {
    readonly requests: PendingModelRequest[];
    listen(): Promise<string>;
    respondText(index: number, text: string): void;
    respondAll(text: string): void;
    autoRespond(text: string): void;
    close(): Promise<void>;
}

function sseChunk(model: string, delta: Record<string, unknown>, finish: string | null = null): string {
    return `data: ${JSON.stringify({
        id: `test-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
}

function usageChunk(model: string): string {
    return `data: ${JSON.stringify({
        id: `test-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`;
}

function createControlledModel(): ControlledModel {
    const requests: PendingModelRequest[] = [];
    let automatic: string | null = null;
    let server: Server;

    const answer = (p: PendingModelRequest, text: string): void => {
        if (p.res.destroyed || p.res.writableEnded) return;
        const model = typeof p.body["model"] === "string" ? p.body["model"] : "fake-model";
        p.res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
        });
        p.res.write(sseChunk(model, { content: text }));
        p.res.write(sseChunk(model, {}, "stop"));
        p.res.write(usageChunk(model));
        p.res.write("data: [DONE]\n\n");
        p.res.end();
    };

    server = createServer((req, res) => {
        if (req.method !== "POST") {
            res.writeHead(404).end();
            return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let body: Record<string, unknown> = {};
            try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            } catch {
                res.writeHead(400).end();
                return;
            }
            const pending = { body, res };
            requests.push(pending);
            if (automatic !== null) setImmediate(() => answer(pending, automatic!));
        });
    });

    return {
        requests,
        listen: () =>
            new Promise<string>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                    const addr = server.address();
                    if (addr === null || typeof addr === "string") reject(new Error("controlled model: no port"));
                    else resolve(`http://127.0.0.1:${addr.port}`);
                });
            }),
        respondText: (index, text) => {
            const pending = requests[index];
            if (!pending) throw new Error(`controlled model: no request ${index}`);
            answer(pending, text);
        },
        respondAll: (text) => {
            for (const pending of requests) answer(pending, text);
        },
        autoRespond: (text) => {
            automatic = text;
            for (const pending of requests) answer(pending, text);
        },
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
}

function addControlledModel(env: Env, name: string, endpoint: string): void {
    addModel({ name, provider: "llamacpp", endpoint, contextTokens: 4000 }, env.db);
}

async function connected(env: Env, opts: Parameters<Env["connect"]>[0]): Promise<Harness> {
    const h = await env.connect(opts);
    await waitFor(() => env.core.registry.get(opts.name) !== undefined, 4000, `${opts.name} registered`);
    return h;
}

async function expectIdle(env: Env, agent: string, session: number): Promise<void> {
    const listed = await env.api<Array<{ id: number; busy: boolean }>>("GET", `/api/agents/${agent}/conversations`);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.find((c) => c.id === session)?.busy, false);
}

test("stopping a queued turn releases that chat before an unrelated model call finishes", { timeout: 10_000 }, async () => {
    const env = await boot({ contextTokens: 4000 });
    const model = createControlledModel();
    try {
        const endpoint = await model.listen();
        addControlledModel(env, "blocking", endpoint);
        setDefaultModel("blocking", env.db);

        const first = await connected(env, { name: "alpha" });
        const second = await connected(env, { name: "beta" });
        const firstSession = first.createSession("alpha", true);
        const secondSession = second.createSession("beta", true);

        const firstStream = await env.stream("POST", `/api/agents/alpha/conversations/${firstSession}/messages`, { text: "hold" });
        await waitFor(() => model.requests.length === 1, 4000, "first provider request");

        const queued = await env.stream("POST", `/api/agents/beta/conversations/${secondSession}/messages`, { text: "queued" });
        await waitFor(() => model.requests.length === 1, 4000, "second turn still queued behind first model call");

        const stopped = await env.api<{ stopped: boolean }>("POST", `/api/agents/beta/conversations/${secondSession}/stop`);
        assert.deepEqual(stopped.json, { ok: true, stopped: true });
        await queued.done;
        await expectIdle(env, "beta", secondSession);

        model.respondText(0, "alpha done");
        await firstStream.done;
    } finally {
        model.autoRespond("cleanup");
        await env.stop();
        await model.close();
    }
});

test("stopping a turn blocked in an agent invoke returns promptly and leaves the chat idle", { timeout: 10_000 }, async () => {
    const env = await boot({ contextTokens: 4000 });
    let finishSlow!: (value: { text: string }) => void;
    const slow = new Promise<{ text: string }>((resolve) => {
        finishSlow = resolve;
    });
    try {
        const h = await connected(env, {
            name: "toto",
            tools: [{ name: "slow", writes: false, parameters: { type: "object", properties: {} } }],
            handlers: { slow: () => slow },
        });
        const session = h.createSession("slow", true);
        env.model.nextTurn(callTurn([{ id: "s1", name: "slow" }]));

        const stream = await env.stream("POST", `/api/agents/toto/conversations/${session}/messages`, { text: "run slow" });
        await waitFor(() => h.invokes().length === 1, 4000, "slow invoke reached the agent");

        const stopped = await env.api<{ stopped: boolean }>("POST", `/api/agents/toto/conversations/${session}/stop`);
        assert.deepEqual(stopped.json, { ok: true, stopped: true });
        await stream.done;
        assert.match(String(stream.lines.find((ev) => ev["type"] === "done")?.["answer"]), /Stopped by user/);
        await expectIdle(env, "toto", session);
    } finally {
        finishSlow({ text: "late" });
        await env.stop();
    }
});

interface DelayedAppendAgent {
    core: FakeAgentCore;
    delayedAppends: Array<() => void>;
    close(): void;
}

async function connectDelayedAppendAgent(env: Env, name: string): Promise<DelayedAppendAgent> {
    const identity = fakeIdentity();
    env.pin(name, identity.pubkey);
    const core = createFakeAgentCore({ name });
    const sock = fakeAgentSocket(`${env.ws}/channel`, identity, env.core.devices.gatewayPub);
    const session = 1;
    const events: StoredEvent[] = [];
    const delayedAppends: Array<() => void> = [];
    let appendRequests = 0;

    const head = (): SessionHead => ({
        session,
        revision: events.length,
        headSeq: events.length,
        headHash: events.at(-1)?.hash ?? "",
    });
    const send = (frame: Record<string, unknown>): void => {
        try {
            sock.send(JSON.stringify(frame));
        } catch {
            // the gateway may close during shutdown
        }
    };
    const wire = { send: (text: string): void => send(JSON.parse(text) as Record<string, unknown>), close: (): void => sock.close() };
    const reply = (id: string, requestType: keyof typeof REPLY_OF, payload: unknown): void =>
        send({ id, type: REPLY_OF[requestType], status: "ok", payload });
    const applyAppend = (bodies: readonly EventBody[]): number[] => {
        const seqs: number[] = [];
        for (const body of bodies) {
            const seq = events.length + 1;
            const hash = chainHash(events.at(-1)?.hash ?? "", { seq, type: body.type, payload: body.payload });
            events.push({ ...body, seq, hash, createdAt: Date.now() });
            seqs.push(seq);
        }
        return seqs;
    };

    await new Promise<void>((resolve, reject) => {
        sock.onopen = (): void => {
            core.handshake(wire).then(resolve, reject);
        };
        sock.onmessage = (ev: { data: unknown }): void => {
            const raw = typeof ev.data === "string" ? ev.data : "";
            void core.receive(raw, wire);
            let frame: Record<string, unknown>;
            try {
                frame = JSON.parse(raw) as Record<string, unknown>;
            } catch {
                return;
            }
            if ("status" in frame || typeof frame["type"] !== "string") return;
            const id = String(frame["id"]);
            const payload = (frame["payload"] ?? {}) as Record<string, unknown>;
            if (frame["type"] === "session_head") {
                const ids = (payload["sessions"] as number[] | undefined) ?? [];
                reply(id, "session_head", { heads: ids.includes(session) ? [head()] : [] });
                return;
            }
            if (frame["type"] === "events_after") {
                const afterSeq = Number(payload["afterSeq"] ?? 0);
                reply(id, "events_after", { events: events.filter((event) => event.seq > afterSeq), head: head(), more: false });
                return;
            }
            if (frame["type"] === "append") {
                const bodies = ((payload["events"] as EventBody[] | undefined) ?? []).slice();
                const complete = (): void => {
                    const seqs = applyAppend(bodies);
                    reply(id, "append", { head: head(), seqs });
                };
                if (appendRequests === 0) complete();
                else delayedAppends.push(complete);
                appendRequests += 1;
            }
        };
        sock.onerror = (): void => reject(new Error(`delayed ${name}: socket error`));
        sock.onclose = (): void => reject(new Error(`delayed ${name}: closed before ready`));
    });
    await waitFor(() => env.core.registry.get(name) !== undefined, 4000, `${name} registered`);
    return { core, delayedAppends, close: () => sock.close() };
}

async function connectHeadlessAgent(env: Env, name: string): Promise<{ core: FakeAgentCore; close(): void }> {
    const identity = fakeIdentity();
    env.pin(name, identity.pubkey);
    const core = createFakeAgentCore({ name });
    const sock = fakeAgentSocket(`${env.ws}/channel`, identity, env.core.devices.gatewayPub);
    const wire = {
        send: (text: string): void => {
            try {
                sock.send(text);
            } catch {
                // the test may close the socket while an ignored request is still outstanding
            }
        },
        close: (): void => sock.close(),
    };
    await new Promise<void>((resolve, reject) => {
        sock.onopen = (): void => {
            core.handshake(wire).then(resolve, reject);
        };
        sock.onmessage = (ev: { data: unknown }): void => {
            const raw = typeof ev.data === "string" ? ev.data : "";
            void core.receive(raw, wire);
        };
        sock.onerror = (): void => reject(new Error(`headless ${name}: socket error`));
        sock.onclose = (): void => reject(new Error(`headless ${name}: closed before ready`));
    });
    await waitFor(() => env.core.registry.get(name) !== undefined, 4000, `${name} registered`);
    return { core, close: () => sock.close() };
}

test("stopping while the turn waits on session HEAD/read closes the stream", { timeout: 10_000 }, async () => {
    const env = await boot({ contextTokens: 4000 });
    let agent: { core: FakeAgentCore; close(): void } | null = null;
    try {
        agent = await connectHeadlessAgent(env, "headless");

        const stream = await env.stream("POST", "/api/agents/headless/conversations/1/messages", { text: "hi" });
        await waitFor(
            () => agent!.core.log.some((frame) => (frame as Record<string, unknown>)["type"] === "session_head"),
            4000,
            "session HEAD request",
        );

        const stopped = await env.api<{ stopped: boolean }>("POST", "/api/agents/headless/conversations/1/stop");
        assert.deepEqual(stopped.json, { ok: true, stopped: true });
        await stream.done;
    } finally {
        agent?.close();
        await env.stop();
    }
});

test("all reattached HTTP streams close at turn finish after receiving replayed data", { timeout: 10_000 }, async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const h = await connected(env, {
            name: "toto",
            tools: [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { send_email: { text: "sent" } },
        });
        const session = h.createSession("reattach", true);
        env.model.nextTurn(callTurn([{ id: "w1", name: "send_email" }]));
        env.model.nextTurn(textTurn("finished"));

        const first = await env.stream("POST", `/api/agents/toto/conversations/${session}/messages`, { text: "send it" });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "approval gate");
        const second = await env.stream("GET", `/api/agents/toto/conversations/${session}/stream`);
        const third = await env.stream("GET", `/api/agents/toto/conversations/${session}/stream`);
        const streams: NdjsonStream[] = [first, second, third];
        await Promise.all(
            streams.map((s, i) =>
                waitFor(() => s.lines.some((ev) => ev["type"] === "approval_required"), 4000, `stream ${i} replayed data`),
            ),
        );

        const gate = env.core.approvals.pending()[0]!.gate;
        env.core.approvals.answer(gate, { w1: true });
        await Promise.all(streams.map((s) => s.done));
        assert.ok(third.lines.some((ev) => ev["type"] === "done" && ev["answer"] === "finished"));
    } finally {
        await env.stop();
    }
});

test("every device on a running chat gets each later gate and the end, whichever attached last", { timeout: 10_000 }, async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const h = await connected(env, {
            name: "toto",
            tools: [{ name: "add_event", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { add_event: { text: "added" } },
        });
        const session = h.createSession("two devices", true);
        // two rounds of two writes each: the second gate parks after a second device opened the chat
        env.model.nextTurn(callTurn([{ id: "a", name: "add_event" }, { id: "b", name: "add_event" }]));
        env.model.nextTurn(callTurn([{ id: "c", name: "add_event" }, { id: "d", name: "add_event" }]));
        env.model.nextTurn(textTurn("four added"));
        const gates = (s: NdjsonStream): unknown[] => s.lines.filter((ev) => ev["type"] === "approval_required").map((ev) => ev["gate"]);

        const desktop = await env.stream("POST", `/api/agents/toto/conversations/${session}/messages`, { text: "add four" });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "gate 1");
        const phone = await env.stream("GET", `/api/agents/toto/conversations/${session}/stream`);
        await waitFor(() => gates(phone).length === 1, 4000, "the phone's replay");
        const first = env.core.approvals.pending()[0]!.gate;
        env.core.approvals.answer(first, { a: true, b: true });

        await waitFor(() => env.core.approvals.pending().length === 1 && env.core.approvals.pending()[0]!.gate !== first, 4000, "gate 2");
        const second = env.core.approvals.pending()[0]!.gate;
        await waitFor(() => gates(desktop).length === 2 && gates(phone).length === 2, 4000, "gate 2 on both devices");
        assert.deepEqual(gates(desktop), [first, second], "the device that attached first still gets the second gate");
        for (const s of [desktop, phone]) {
            assert.ok(s.lines.some((ev) => ev["type"] === "approval_resolved" && ev["gate"] === first), "and the first one's resolution");
        }

        // the phone goes away: the desktop keeps the turn to its end
        phone.close();
        await new Promise((r) => setTimeout(r, 50));
        env.core.approvals.answer(second, { c: true, d: true });
        await desktop.done;
        assert.equal(desktop.lines.at(-1)?.["type"], "done");
        assert.equal(desktop.lines.at(-1)?.["answer"], "four added");
        assert.equal(h.invokes().length, 4);
    } finally {
        await env.stop();
    }
});

test("closing one concurrent chat stream does not stop another chat", { timeout: 10_000 }, async () => {
    const env = await boot({ contextTokens: 4000 });
    const aliceModel = createControlledModel();
    const bobModel = createControlledModel();
    try {
        addControlledModel(env, "alice-model", await aliceModel.listen());
        addControlledModel(env, "bob-model", await bobModel.listen());
        const alice = await connected(env, { name: "alice" });
        const bob = await connected(env, { name: "bob" });
        assert.equal(env.db.setModelsPolicy("alice", { allowed: ["alice-model"], primary: "alice-model" }), true);
        assert.equal(env.db.setModelsPolicy("bob", { allowed: ["bob-model"], primary: "bob-model" }), true);
        const aliceSession = alice.createSession("alice", true);
        const bobSession = bob.createSession("bob", true);

        const aliceStream = await env.stream("POST", `/api/agents/alice/conversations/${aliceSession}/messages`, { text: "hold" });
        const bobStream = await env.stream("POST", `/api/agents/bob/conversations/${bobSession}/messages`, { text: "finish" });
        await waitFor(() => aliceModel.requests.length === 1, 4000, "alice model request");
        await waitFor(() => bobModel.requests.length === 1, 4000, "bob model request");

        aliceStream.close();
        bobModel.respondText(0, "bob done");
        await bobStream.done;
        assert.equal(bobStream.lines.find((ev) => ev["type"] === "done")?.["answer"], "bob done");

        aliceModel.respondText(0, "alice done");
        await waitFor(
            () =>
                env.core.sessions
                    .entry("alice", aliceSession)
                    ?.events.some((e) => e.type === "message" && e.payload.role === "assistant") === true,
            4000,
            "alice turn cleanup",
        );
    } finally {
        aliceModel.autoRespond("cleanup");
        bobModel.autoRespond("cleanup");
        await env.stop();
        await aliceModel.close();
        await bobModel.close();
    }
});

test("turn handles are scoped per gateway core for the same agent and session id", { timeout: 10_000 }, async () => {
    const first = await boot({ contextTokens: 4000 });
    const second = await boot({ contextTokens: 4000 });
    try {
        const firstAgent = await connected(first, {
            name: "toto",
            tools: [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { send_email: { text: "first sent" } },
        });
        const secondAgent = await connected(second, {
            name: "toto",
            tools: [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { send_email: { text: "second sent" } },
        });
        const firstSession = firstAgent.createSession("same", true);
        const secondSession = secondAgent.createSession("same", true);
        assert.equal(firstSession, secondSession, "the two cores use the same agent/session ids");

        first.model.nextTurn(callTurn([{ id: "f1", name: "send_email" }]));
        second.model.nextTurn(callTurn([{ id: "s1", name: "send_email" }]));
        second.model.nextTurn(textTurn("second done"));

        const firstStream = await first.stream("POST", `/api/agents/toto/conversations/${firstSession}/messages`, { text: "first" });
        const secondStream = await second.stream("POST", `/api/agents/toto/conversations/${secondSession}/messages`, { text: "second" });
        await waitFor(() => first.core.approvals.pending().length === 1, 4000, "first gate");
        await waitFor(() => second.core.approvals.pending().length === 1, 4000, "second gate");

        const stopped = await first.api<{ stopped: boolean }>("POST", `/api/agents/toto/conversations/${firstSession}/stop`);
        assert.deepEqual(stopped.json, { ok: true, stopped: true });
        await firstStream.done;
        assert.equal(second.core.approvals.pending().length, 1, "stopping the first core leaves the second core gate alive");
        assert.ok(second.core.turns.get("toto", secondSession), "the second core still owns its turn");

        const gate = second.core.approvals.pending()[0]!.gate;
        second.core.approvals.answer(gate, { s1: true });
        await secondStream.done;
        assert.equal(secondStream.lines.find((ev) => ev["type"] === "done")?.["answer"], "second done");
    } finally {
        await first.stop();
        await second.stop();
    }
});


test("core shutdown waits for a stopped turn cleanup append to finish", { timeout: 10_000 }, async () => {
    const env = await boot({ contextTokens: 4000 });
    const model = createControlledModel();
    let agent: DelayedAppendAgent | null = null;
    try {
        addControlledModel(env, "shutdown-model", await model.listen());
        setDefaultModel("shutdown-model", env.db);
        agent = await connectDelayedAppendAgent(env, "shutdowner");

        const run = env.core.turns.start({ agent: "shutdowner", session: 1, text: "wait", title: false });
        run.result.catch(() => undefined);
        await waitFor(() => model.requests.length === 1, 4000, "provider request before stop");

        run.stop();
        await waitFor(() => agent!.delayedAppends.length === 1, 4000, "stopped cleanup append is pending");

        let shutdownReturned = false;
        const stopping = env.core.stop().then(() => {
            shutdownReturned = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(shutdownReturned, false, "core.stop must wait for the stopped turn cleanup append");

        agent.delayedAppends.shift()?.();
        await stopping;
    } finally {
        agent?.close();
        model.autoRespond("cleanup");
        await env.stop();
        await model.close();
    }
});

test("a delegate turn runs in the turn registry, so Stop reaches it and no second turn joins it", async () => {
    const env = await boot();
    const stopGates = autoApprove(env);
    const seen: Array<{ turns: number; second: string }> = [];
    try {
        const boss = await connected(env, { name: "boss" });
        await connected(env, {
            name: "mate",
            tools: [{ name: "dig", writes: false, parameters: { type: "object", properties: {} } }],
            handlers: {
                // runs INSIDE the delegate turn: what the registry knows about it right now
                dig: () => {
                    const run = env.core.turns.forAgent("mate")[0];
                    let second = "started";
                    try {
                        env.core.turns
                            .start({ agent: "mate", session: run?.session ?? 0, text: "second", title: false })
                            .result.catch(() => undefined);
                    } catch (e) {
                        second = (e as Error).message;
                    }
                    seen.push({ turns: env.core.turns.forAgent("mate").length, second });
                    return { text: "DUG" };
                },
            },
        });

        env.model.nextTurn(callTurn([{ id: "a1", name: "ask_mate", args: '{"task":"dig"}' }]));
        env.model.nextTurn(callTurn([{ id: "d1", name: "dig" }]));
        env.model.nextTurn(textTurn("found it"));
        env.model.nextTurn(textTurn("done"));

        const session = boss.createSession();
        const out = await env.core.runTurn({
            agent: "boss",
            session,
            text: "go",
            attended: true,
            title: false,
        });
        assert.equal(out.text, "done");
        const observed = seen[0];
        assert.ok(observed, "the delegate invoked the target's tool");
        assert.equal(observed.turns, 1, "the delegate turn is registered while it runs");
        assert.match(observed.second, /a turn is already running here/);
        assert.deepEqual(env.core.turns.forAgent("mate"), [], "and it leaves the registry when it ends");
    } finally {
        stopGates();
        await env.stop();
    }
});

const IMG = "data:image/png;base64,iVBORw0KGgo=";

test("a turn with images on a non-vision model is refused before any provider call", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "seer" });
        const session = h.createSession("imgs", true);
        // the default "fake" model has vision: false
        await assert.rejects(
            env.core.runTurn({ agent: "seer", session, text: "what is this?", images: [IMG], attended: true, title: false }),
            /has no image support/,
        );
    } finally {
        await env.stop();
    }
});

test("a message with more images than half the window holds is refused before it is stored", async () => {
    const env = await boot();
    try {
        // 32k: floor(0.5 x 32 000 / 1 500) = 10 images in one message
        addModel({ name: "eye", provider: "llamacpp", endpoint: env.model.url, contextTokens: 32_000, vision: true }, env.db);
        setDefaultModel("eye", env.db);
        const h = await connected(env, { name: "seer" });
        const session = h.createSession("imgs", true);
        const eleven = Array.from({ length: 11 }, () => IMG);
        await assert.rejects(
            env.core.runTurn({ agent: "seer", session, text: "look", images: eleven, attended: true, title: false }),
            /11 images are more than model "eye" takes in one message \(10\)/,
        );
        assert.equal(h.sessions.get(session)!.events.length, 0, "nothing was stored, so nothing is stuck in history");
        assert.equal(env.model.requests.length, 0);

        env.model.nextTurn(textTurn("ten photos"));
        const out = await env.core.runTurn({ agent: "seer", session, text: "look", images: eleven.slice(1), attended: true, title: false });
        assert.equal(out.text, "ten photos");
    } finally {
        await env.stop();
    }
});

test("a fallback whose window cannot hold this turn's images is not taken", async () => {
    const env = await boot();
    const down: Server = createServer((req, res) => {
        req.resume();
        req.on("end", () => res.writeHead(400, { "content-type": "application/json" }).end('{"error":"down"}'));
    });
    await new Promise<void>((ready) => down.listen(0, "127.0.0.1", ready));
    try {
        const url = `http://127.0.0.1:${(down.address() as { port: number }).port}`;
        addModel({ name: "wide", provider: "llamacpp", endpoint: url, contextTokens: 128_000, vision: true }, env.db);
        // 16k: five images at most
        addModel({ name: "small", provider: "llamacpp", endpoint: env.model.url, contextTokens: 16_000, vision: true }, env.db);
        env.pin("vis");
        env.db.setModelsPolicy("vis", { allowed: ["wide", "small"], primary: "wide", fallback: "small" });
        const h = await env.connect({ name: "vis", tools: [], handlers: {} }, false);
        await waitFor(() => env.core.agent("vis").connected, 4000, "vis ready");
        const session = h.createSession("imgs", true);

        await assert.rejects(
            env.core.runTurn({ agent: "vis", session, text: "look", images: Array.from({ length: 8 }, () => IMG), title: false }),
            /400/,
        );
        assert.equal(env.model.requests.length, 0, "the small window was never asked");

        env.model.nextTurn(textTurn("four photos"));
        const out = await env.core.runTurn({ agent: "vis", session, text: "look", images: Array.from({ length: 4 }, () => IMG), title: false });
        assert.equal(out.text, "four photos", "four fit the fallback");
    } finally {
        down.closeAllConnections();
        await new Promise((done) => down.close(done));
        await env.stop();
    }
});

test("a turn whose own images carry the chat past imagesAt folds the older ones before its call, its own staying pixels", async () => {
    const env = await boot();
    try {
        addModel({ name: "eye", provider: "llamacpp", endpoint: env.model.url, contextTokens: 128_000, vision: true }, env.db);
        setDefaultModel("eye", env.db);
        const h = await connected(env, { name: "seer" });
        const session = h.createSession("imgs", true);
        const photo = (n: number): string => `data:image/png;base64,${String(n).padStart(40, "A")}`;
        h.append(session, [
            { type: "message", payload: { role: "user", content: "old", images: [1, 2, 3, 4, 5, 6, 7, 8].map(photo) } },
            { type: "message", payload: { role: "assistant", content: "seen" } },
        ]);
        const own = Array.from({ length: 32 }, (_v, i) => photo(100 + i));
        env.model.nextTurn(textTurn(Array.from({ length: 8 }, (_v, i) => `${i + 1}: old photo ${i + 1}`).join("\n")));
        env.model.nextTurn(textTurn("thirty-two new ones"));
        // 8 + 32 = 40 undescribed, past the 25 of a 128k window
        await env.core.runTurn({ agent: "seer", session, text: "and these", images: own, title: false });

        assert.equal(env.model.requests.length, 2, "one describe call, then the turn");
        const turn = (env.model.requests[1]!["messages"] as Array<{ role: string; content: unknown }>).filter((m) => m.role === "user");
        const urls = (m: { content: unknown }): string[] =>
            Array.isArray(m.content) ? (m.content as Array<{ image_url?: { url: string } }>).flatMap((p) => (p.image_url ? [p.image_url.url] : [])) : [];
        assert.deepEqual(urls(turn[0]!), [], "the old message reads its notes");
        assert.match(String(turn[0]!.content), /old\n\[earlier image: old photo 1\]/);
        assert.deepEqual(urls(turn[1]!), own);
        const notes = h.sessions.get(session)!.events.filter((e) => e.type === "compaction").map((e) => e.payload as CompactionPayload);
        assert.deepEqual(notes.map((n) => n.images?.map((i) => i.seq)), [[1]]);
    } finally {
        await env.stop();
    }
});

type Posted = { req: IncomingMessage; reply: Promise<{ status: number; body: string }> };

/** POST …/messages straight into the turn route, its body pushed by hand; `running` says whether the chat has a turn. */
function turnRoute(running: () => boolean): () => Posted {
    const core = {
        registry: { get: () => ({}) },
        turns: { get: () => (running() ? {} : undefined) },
    } as unknown as GatewayCore;
    const router = new Router();
    registerTurns(router, core);
    return () => {
        const req = new IncomingMessage(new Socket());
        req.method = "POST";
        req.url = "/api/agents/toto/conversations/1/messages";
        const reply = Promise.withResolvers<{ status: number; body: string }>();
        const res = { headersSent: false, status: 0 };
        const fake = Object.assign(res, {
            writeHead: (code: number): void => {
                res.status = code;
                res.headersSent = true;
            },
            end: (body: string): void => reply.resolve({ status: res.status, body }),
        });
        void router.dispatch(req, fake as unknown as ServerResponse);
        return { req, reply: reply.promise };
    };
}

test("the turn route answers 409 and 429 before reading a body, and reads at most two bodies at once", async () => {
    let running = false;
    const post = turnRoute(() => running);
    const pending = async (p: { reply: Promise<unknown> }): Promise<boolean> =>
        (await Promise.race([p.reply.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 50))]));

    const first = post();
    first.req.push('{"text":"one", "images": [');
    const second = post();
    second.req.push('{"te');
    assert.ok(await pending(first), "an upload being read has no reply yet");
    const third = post();
    assert.deepEqual(await third.reply, { status: 429, body: JSON.stringify({ error: "two other messages are still uploading; send this one again in a moment" }) });
    assert.ok(third.req.readableLength === 0, "and its body was never read");

    // a body that ends, however it ends, frees its slot
    first.req.push("nope");
    first.req.push(null);
    assert.equal((await first.reply).status, 400);
    const fourth = post();
    fourth.req.push('{"text":');
    assert.ok(await pending(fourth));
    assert.equal((await post().reply).status, 429);

    // a chat with a turn running is refused before a byte is read
    running = true;
    assert.equal((await post().reply).status, 409);
    second.req.destroy();
    assert.equal((await second.reply).status, 400);
    fourth.req.push(null);
    assert.equal((await fourth.reply).status, 400);
    running = false;
    const fifth = post();
    fifth.req.push('{"text":""}');
    fifth.req.push(null);
    assert.deepEqual(await fifth.reply, { status: 400, body: JSON.stringify({ error: "pass { text } or { images }" }) }, "both slots are free again");
});

test("an upload that sends nothing for 30 s is dropped and gives its slot back; one still arriving keeps it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const post = turnRoute(() => false);
    const flow = (): Promise<void> => new Promise((r) => setImmediate(r));
    const stalled = post();
    stalled.req.push('{"text":"gone off the network", "images": [');
    const slow = post();
    slow.req.push('{"text":"a slow uplink"');
    await flow();
    assert.equal((await post().reply).status, 429);

    t.mock.timers.tick(29_000);
    slow.req.push(', "images": [');
    await flow();
    t.mock.timers.tick(1_000);
    await flow();
    assert.deepEqual(await stalled.reply, { status: 400, body: JSON.stringify({ error: "the body stopped arriving" }) });
    assert.ok(stalled.req.destroyed);

    const next = post();
    next.req.push('{"text":"hello"');
    await flow();
    assert.equal((await post().reply).status, 429, "the slow one still holds its slot, the new one the freed one");

    t.mock.timers.tick(29_000);
    await flow();
    assert.deepEqual(await slow.reply, { status: 400, body: JSON.stringify({ error: "the body stopped arriving" }) }, "30 s after its last byte");
    t.mock.timers.tick(1_000);
    await flow();
    assert.equal((await next.reply).status, 400);
});
