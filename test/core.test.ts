/** The turn engine end to end: batches, gates, failures, caps, accounting. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import test from "node:test";

import type { ChatOkPayload, Message, StreamEvent } from "@mimi-os/protocol";
import { fakeIdentity } from "@mimi-os/sdk/testing";
import { setModelPricing } from "../src/llm/models.ts";
import { boot, callTurn, textTurn, waitFor } from "./harness-env.ts";
import type { Env } from "./harness-env.ts";
import type { Harness } from "./agent-harness.ts";

const READ_TOOLS = [
    { name: "look", writes: false, parameters: { type: "object", properties: {} } },
    { name: "read", writes: false, parameters: { type: "object", properties: {} } },
];

const messagesOf = (h: Harness, sid: number): Message[] =>
    h.sessions
        .get(sid)!
        .events.filter((e) => e.type === "message")
        .map((e) => e.payload as Message);

async function connected(env: Env, opts: Parameters<Env["connect"]>[0]): Promise<Harness> {
    const h = await env.connect(opts);
    await waitFor(() => env.core.registry.get(opts.name) !== undefined, 4000, "registration");
    return h;
}

test("two tool_calls run the full cycle and every call is paired", async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            tools: READ_TOOLS,
            handlers: { look: { text: "LOOKED" }, read: { text: "READ" } },
        });
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "c1", name: "look" }, { id: "c2", name: "read" }]));
        env.model.nextTurn(textTurn("all done"));

        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });
        assert.equal(out.dropped, false);
        assert.equal(out.text, "all done");

        const invoked = h.invokes().map((f) => (f["payload"] as { tool: string }).tool);
        assert.deepEqual(invoked.sort(), ["look", "read"]);

        const msgs = messagesOf(h, sid);
        assert.equal(msgs[0]?.role, "user");
        assert.deepEqual(
            msgs[1]?.tool_calls?.map((c) => c.id),
            ["c1", "c2"],
        );
        const results = msgs.filter((m) => m.role === "tool");
        assert.deepEqual(
            results.map((m) => m.tool_call_id).sort(),
            ["c1", "c2"],
        );
        assert.equal(results.find((m) => m.tool_call_id === "c1")?.content, "LOOKED");
        assert.equal(msgs.at(-1)?.content, "all done");
    } finally {
        await env.stop();
    }
});

test("a silent tool times out, the error result is synthesized AND appended", async () => {
    const env = await boot({ deadlineGraceMs: 100 });
    try {
        const h = await connected(env, {
            name: "toto",
            tools: READ_TOOLS,
            handlers: { look: { text: "LOOKED" }, read: { text: "READ" } },
        });
        h.core.setMisbehavior("read", "silent");
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "c1", name: "look" }, { id: "c2", name: "read" }]));
        env.model.nextTurn(textTurn("recovered"));

        const out = await env.core.runTurn({
            agent: "toto",
            session: sid,
            text: "go",
            title: false,
            invokeDeadlineMs: 150,
        });
        assert.equal(out.dropped, false);
        const results = messagesOf(h, sid).filter((m) => m.role === "tool");
        assert.equal(results.length, 2, "every tool_call gets exactly one result");
        const timedOut = results.find((m) => m.tool_call_id === "c2");
        assert.match(String(timedOut?.content), /did not answer within 150ms/);
    } finally {
        await env.stop();
    }
});

test("a 100 KB tool result reaches history, the tool_result event and the next model call whole", async () => {
    const env = await boot();
    try {
        // multi-byte, astral and newline-heavy: a cut or a re-encoding anywhere would show
        const big = Array.from({ length: 4_000 }, (_, i) => `row ${i}: ${"é".repeat(16)} 😀\n`).join("");
        assert.ok(big.length > 100_000);
        const h = await connected(env, { name: "toto", tools: READ_TOOLS, handlers: { look: { text: big } } });
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "c1", name: "look" }]));
        env.model.nextTurn(textTurn("read it all"));

        const events: Array<Record<string, unknown>> = [];
        const out = await env.core.runTurn({
            agent: "toto",
            session: sid,
            text: "go",
            title: false,
            emit: (ev) => void events.push(ev),
        });
        assert.equal(out.text, "read it all");
        assert.equal(events.find((ev) => ev["type"] === "tool_result")?.["text"], big);
        assert.equal(messagesOf(h, sid).find((m) => m.role === "tool")?.content, big);
        const sent = env.model.requests[1]?.["messages"] as Message[];
        assert.equal(sent.find((m) => m.role === "tool")?.content, big);
    } finally {
        await env.stop();
    }
});

test("two results that add up past one channel message are each stored whole, in an append of their own", async () => {
    const env = await boot();
    try {
        const a = "a".repeat(600_000);
        const b = "b".repeat(600_000);
        const h = await connected(env, {
            name: "toto",
            tools: READ_TOOLS,
            handlers: { look: { text: a }, read: { text: b } },
        });
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "c1", name: "look" }, { id: "c2", name: "read" }]));
        env.model.nextTurn(textTurn("read both"));

        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });
        assert.equal(out.dropped, false);
        assert.equal(out.text, "read both");
        assert.ok(h.socketOpen(), "the agent's session lives on");
        const stored = messagesOf(h, sid).filter((m) => m.role === "tool");
        assert.deepEqual(stored.map((m) => m.content === a || m.content === b), [true, true]);
        const sent = (env.model.requests[1]?.["messages"] as Message[]).filter((m) => m.role === "tool");
        assert.deepEqual(sent.map((m) => m.content), stored.map((m) => m.content));
        const appends = h.frames().filter((f) => f["type"] === "append");
        assert.ok(appends.every((f) => (f["payload"] as { events: unknown[] }).events.length === 1));
    } finally {
        await env.stop();
    }
});

test("a chain too big for history is refused whole; the agent and its other chats live on", { timeout: 15_000 }, async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            manifest: { chain: true },
            tools: READ_TOOLS,
            handlers: { look: { text: "y".repeat(600_000) }, read: { text: "READ" } },
        });
        h.core.setMisbehavior("read", "silent");
        // another chat on the same agent, waiting on its own invoke the whole time
        const other = h.createSession();
        env.model.nextTurn(callTurn([{ id: "r1", name: "read" }]));
        const waiting = env.core.turns.start({
            agent: "toto",
            session: other,
            text: "read",
            attended: true,
            title: false,
        });
        await waitFor(() => h.invokes().length === 1, 4000, "the other chat's invoke");

        const sid = h.createSession();
        const steps = [{ tool: "look" }, { tool: "look" }];
        env.model.nextTurn(callTurn([{ id: "c1", name: "chain", args: JSON.stringify({ steps }) }]));
        env.model.nextTurn(textTurn("asked for less"));
        const events: Array<Record<string, unknown>> = [];
        const out = await env.core.runTurn({
            agent: "toto",
            session: sid,
            text: "go",
            title: false,
            emit: (ev) => void events.push(ev),
        });
        assert.equal(h.invokes().length, 3, "both steps ran");
        assert.equal(out.dropped, false);
        assert.equal(out.text, "asked for less");
        const refused = events.find((ev) => ev["type"] === "tool_result")?.["text"];
        assert.match(String(refused), /^Error: the result of "chain" is \d+ bytes, over the \d+ .* it was not kept/);
        assert.equal(messagesOf(h, sid).find((m) => m.role === "tool")?.content, refused);
        const sent = env.model.requests[2]?.["messages"] as Message[];
        assert.equal(sent.find((m) => m.role === "tool")?.content, refused);

        assert.ok(h.socketOpen(), "the agent's session lives on");
        assert.ok(env.core.registry.get("toto"), "and the agent stays registered");
        let settled = false;
        void waiting.result.finally(() => {
            settled = true;
        });
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(settled, false, "the other chat's invoke is still waiting");
        waiting.stop();
        assert.equal((await waiting.result).dropped, false);
    } finally {
        await env.stop();
    }
});

test("a message too big for the channel fails only its own request, never the agent's session", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: READ_TOOLS, handlers: {} });
        const sid = h.createSession();
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "z".repeat(1_100_000), title: false });
        assert.equal(out.dropped, true, "the turn whose append could not be sent");
        assert.ok(env.logs.some((l) => /append lost — .*over the 1048576 one channel message carries/.test(l)));
        assert.ok(h.socketOpen(), "the agent's session lives on");

        env.model.nextTurn(textTurn("still here"));
        const next = await env.core.runTurn({ agent: "toto", session: sid, text: "hi", title: false });
        assert.equal(next.text, "still here");
    } finally {
        await env.stop();
    }
});

test("an invoke with no deadline carries none, outlives the default timeout and is ended by a Stop", { timeout: 15_000 }, async () => {
    // the peer's 30 s default cut to 400 ms: a model invoke that fell back to it would end on its own
    const env = await boot({ defaultTimeoutMs: 400 });
    try {
        const h = await connected(env, { name: "toto", tools: READ_TOOLS, handlers: { look: { text: "LOOKED" } } });
        h.core.setMisbehavior("look", "silent");
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "c1", name: "look" }]));

        const events: Array<Record<string, unknown>> = [];
        const run = env.core.turns.start({
            agent: "toto",
            session: sid,
            text: "go",
            attended: true,
            title: false,
            emit: (ev) => void events.push(ev),
        });
        await waitFor(() => h.invokes().length === 1, 4000, "the invoke");
        assert.equal(h.invokes()[0]?.["deadline"], undefined);
        // nothing for a mid-invoke approval to be clamped to either
        assert.equal(env.core.registry.get("toto")?.deadlineAt(), undefined);

        // the knob is live: the same silent tool, asked with no timeout of its own, is cut at 400 ms
        const plain = env.core.registry.get("toto")!.request("invoke", { tool: "look", args: {} });
        await assert.rejects(plain, /no reply within 400ms/);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(events.some((ev) => ev["type"] === "tool_result"), false, "the model's invoke still waits");

        run.stop();
        const out = await run.result;
        assert.equal(out.text, "Stopped by user before completion.");
        const result = messagesOf(h, sid).find((m) => m.role === "tool");
        assert.equal(result?.tool_call_id, "c1", "the stopped call still leaves its result");
    } finally {
        await env.stop();
    }
});

test("an invoke with no deadline ends when the agent disconnects", { timeout: 15_000 }, async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: READ_TOOLS, handlers: { look: { text: "LOOKED" } } });
        h.core.setMisbehavior("look", "silent");
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "c1", name: "look" }]));

        const turn = env.core.runTurn({ agent: "toto", session: sid, text: "go", attended: true, title: false });
        await waitFor(() => h.invokes().length === 1, 4000, "the invoke");
        h.close();
        assert.equal((await turn).dropped, true, "the agent is gone, so is the turn");
    } finally {
        await env.stop();
    }
});

test("an agent that dies mid-batch drops the turn cleanly, nothing is replayed", async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            tools: READ_TOOLS,
            handlers: { look: { text: "LOOKED" }, read: { text: "READ" } },
        });
        h.core.setMisbehavior("read", "die");
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "c1", name: "look" }, { id: "c2", name: "read" }]));

        const out = await env.core.runTurn({
            agent: "toto",
            session: sid,
            text: "go",
            title: false,
            invokeDeadlineMs: 500,
        });
        assert.equal(out.dropped, true, "the turn is dropped, not buffered");

        const msgs = messagesOf(h, sid);
        // the tool_calls message landed before the death; repairing that parity is the SDK's job at its next boot, not the gateway's
        assert.equal(msgs.filter((m) => m.role === "tool").length, 0);
        assert.ok(msgs.some((m) => m.tool_calls?.length));
        // the gateway is still alive and the cache of that session was dropped
        assert.equal(env.core.sessions.entry("toto", sid), undefined);
    } finally {
        await env.stop();
    }
});

test("a denied write tool never leaves the gateway — the agent got no invoke", async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            tools: [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { send_email: { text: "SENT" } },
        });
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "w1", name: "send_email" }]));
        env.model.nextTurn(textTurn("told the user"));

        const turn = env.core.runTurn({
            agent: "toto",
            session: sid,
            text: "mail them",
            attended: true,
            title: false,
        });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "a parked gate");
        const gate = env.core.approvals.pending()[0]!;
        assert.equal(gate.tool, "send_email");
        assert.equal(env.core.approvals.answer(gate.gate, {}), true); // an empty answer denies

        await turn;
        assert.equal(h.invokes().length, 0, "the fake agent received no invoke");
        const result = messagesOf(h, sid).find((m) => m.role === "tool");
        assert.match(String(result?.content), /DENIED/);
    } finally {
        await env.stop();
    }
});

test("an approval nobody answers expires: the model hears it timed out, never that the owner denied it", async () => {
    const env = await boot({ approvalTimeoutMs: 100 });
    try {
        const h = await connected(env, {
            name: "toto",
            manifest: { chain: true },
            tools: [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { send_email: { text: "SENT" } },
        });
        const sid = h.createSession();
        env.model.nextTurn(callTurn([
            { id: "w1", name: "send_email" },
            { id: "c1", name: "chain", args: JSON.stringify({ steps: [{ tool: "send_email" }] }) },
        ]));
        env.model.nextTurn(textTurn("you did not answer in time"));

        await env.core.runTurn({ agent: "toto", session: sid, text: "mail them", attended: true, title: false });
        assert.equal(h.invokes().length, 0, "an expired call is never sent");
        const results = messagesOf(h, sid).filter((m) => m.role === "tool");
        const batch = String(results.find((m) => m.tool_call_id === "w1")?.content);
        assert.equal(
            batch,
            "Not run: the approval request EXPIRED unanswered after 5 minutes. The owner did not deny it. " +
                "Tell them it timed out and offer to send it again.",
        );
        const step = String(results.find((m) => m.tool_call_id === "c1")?.content);
        assert.match(step, /FAILED: the approval for "send_email" expired unanswered after 5 minutes/);
        assert.doesNotMatch(batch + step, /DENIED|denied "/);
    } finally {
        await env.stop();
    }
});

test("write calls past the run's budget are refused before the gate, so the owner never allows what cannot run", async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            manifest: { policy: { budgets: { send_email: 2 } } },
            tools: [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { send_email: { text: "SENT" } },
        });
        const sid = h.createSession();
        env.model.nextTurn(callTurn(["w1", "w2", "w3", "w4"].map((id) => ({ id, name: "send_email" }))));
        env.model.nextTurn(textTurn("two sent"));

        const turn = env.core.runTurn({ agent: "toto", session: sid, text: "mail four", attended: true, title: false });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the gate");
        const gate = env.core.approvals.pending()[0]!.gate;
        assert.deepEqual(env.core.approvals.describe(gate)?.actions.map((a) => a.id), ["w1", "w2"], "only what the budget lets run");
        env.core.approvals.answer(gate, { w1: true, w2: true });
        await turn;

        assert.equal(h.invokes().length, 2);
        const results = messagesOf(h, sid).filter((m) => m.role === "tool");
        for (const id of ["w3", "w4"]) {
            assert.equal(results.find((m) => m.tool_call_id === id)?.content, 'Denied: the call budget for "send_email" in this run is exhausted.');
        }
    } finally {
        await env.stop();
    }
});

test("an agent that disconnects while its gate waits: the calls read as not run, never as the owner's stop", async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            tools: [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { send_email: { text: "SENT" } },
        });
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "w1", name: "send_email" }, { id: "w2", name: "send_email" }]));

        const events: Array<Record<string, unknown>> = [];
        const run = env.core.turns.start(
            { agent: "toto", session: sid, text: "mail them", attended: true, title: false, emit: (ev) => void events.push(ev) },
            (outcome) => ({ type: "done", answer: outcome.text }),
        );
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the gate");
        h.close();
        await run.finished;

        assert.equal(events.find((ev) => ev["type"] === "approval_resolved")?.["outcome"], "gone");
        assert.deepEqual(
            events.filter((ev) => ev["type"] === "tool_result").map((ev) => ev["text"]),
            Array(2).fill("Not run: the agent disconnected while this call waited."),
        );
        assert.equal(events.at(-1)?.["answer"], "The agent disconnected before completion.");
        assert.equal(JSON.stringify(events).includes("stopped by user"), false);
    } finally {
        await env.stop();
    }
});

test("a chat's own approval keeps its five minutes while the agent serves an a2a invoke", async () => {
    const env = await boot();
    try {
        let release = (): void => undefined;
        const h = await connected(env, {
            name: "toto",
            manifest: { a2a: { commands: ["slow"] } },
            tools: [{ name: "slow", writes: false, parameters: { type: "object", properties: {} } }],
            handlers: { slow: () => new Promise((done) => { release = () => done({ text: "SLOW" }); }) },
        });
        const sid = h.createSession();
        // another agent's request with the 60 s a2a deadline, still unanswered
        const served = env.core.registry.get("toto")!.request("a2a_invoke", { from: "mate", command: "slow", args: {} }, { deadline: 60_000 });
        await waitFor(() => h.frames().some((f) => f["type"] === "a2a_invoke"), 4000, "the a2a invoke");

        h.send({ id: "k1", type: "ask_approve", payload: { label: "add the event", session: sid } });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the chat's gate");
        const chat = env.core.approvals.pending()[0]!;
        assert.ok(chat.deadline - Date.now() > 4 * 60_000, "not capped by the a2a deadline");

        // an ask that names no chat may come from that a2a invoke, so it still dies with it
        h.send({ id: "k2", type: "ask_approve", payload: { label: "ship it" } });
        await waitFor(() => env.core.approvals.pending().length === 2, 4000, "the session-less gate");
        const loose = env.core.approvals.pending().find((g) => g.gate !== chat.gate)!;
        assert.ok(loose.deadline - Date.now() <= 60_000);

        for (const g of env.core.approvals.pending()) env.core.approvals.answer(g.gate, { a1: false });
        release();
        await served;
    } finally {
        await env.stop();
    }
});

test("with no approver (unattended / one-shot) write tools are denied without even asking", async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            tools: [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { send_email: { text: "SENT" } },
        });
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "w1", name: "send_email" }]));
        env.model.nextTurn(textTurn("nothing sent"));

        await env.core.runTurn({ agent: "toto", session: sid, text: "mail them", title: false });
        assert.equal(h.invokes().length, 0);
        assert.equal(env.core.approvals.pending().length, 0, "nobody was asked");
    } finally {
        await env.stop();
    }
});

test("a chain step obeys the run's plan and budgets, like any other call", async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            manifest: { chain: true, policy: { allowedTools: ["chain", "look"], budgets: { look: 1 } } },
            tools: [
                ...READ_TOOLS,
                { name: "secret", writes: false, parameters: { type: "object", properties: {} } },
            ],
            handlers: { look: { text: "LOOKED" }, read: { text: "READ" }, secret: { text: "SECRETS" } },
        });
        const sid = h.createSession();
        env.model.nextTurn(
            callTurn([
                {
                    id: "c1",
                    name: "chain",
                    args: JSON.stringify({
                        steps: [{ tool: "look" }, { tool: "look" }, { tool: "secret" }],
                    }),
                },
            ]),
        );
        env.model.nextTurn(textTurn("done"));

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });
        const invoked = h.invokes().map((f) => (f["payload"] as { tool: string }).tool);
        assert.deepEqual(invoked, ["look"], "the budget stops the second look; the plan stops secret");
    } finally {
        await env.stop();
    }
});

test("a write tool inside a chain is denied when nobody is there to ask", async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            manifest: { chain: true },
            tools: [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }],
            handlers: { send_email: { text: "SENT" } },
        });
        const sid = h.createSession();
        env.model.nextTurn(
            callTurn([
                { id: "c1", name: "chain", args: JSON.stringify({ steps: [{ tool: "send_email" }] }) },
            ]),
        );
        env.model.nextTurn(textTurn("nothing sent"));

        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });
        assert.equal(h.invokes().length, 0, "the write never left the gateway");
        assert.equal(env.core.approvals.pending().length, 0);
    } finally {
        await env.stop();
    }
});

test("reconnecting under the same name replaces the socket, never duplicates it", async () => {
    const env = await boot();
    try {
        const first = await connected(env, {
            name: "toto",
            tools: READ_TOOLS,
            handlers: { look: { text: "A" } },
        });
        const firstPeer = env.core.registry.get("toto");
        const second = await connected(env, {
            name: "toto",
            tools: READ_TOOLS,
            handlers: { look: { text: "B" } },
        });
        await waitFor(() => env.core.registry.get("toto") !== firstPeer, 4000, "the replacement");
        await waitFor(() => !first.socketOpen(), 4000, "the OLD socket to close");
        assert.equal(env.core.listAgents().filter((a) => a.connected).length, 1);

        const sid = second.createSession();
        env.model.nextTurn(callTurn([{ id: "c1", name: "look" }]));
        env.model.nextTurn(textTurn("done"));
        await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });
        assert.equal(first.invokes().length, 0, "the replaced socket is not addressed");
        assert.equal(second.invokes().length, 1);
    } finally {
        await env.stop();
    }
});

test("a tool_call the append never answered still reads as a PAIRED history", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: READ_TOOLS, handlers: {} });
        const sid = h.createSession();
        // the state an agent is left in when it dies between sending a result and the gateway's append landing: calls on record, no results
        h.append(sid, [
            { type: "message", payload: { role: "user", content: "go" } },
            {
                type: "message",
                payload: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{ id: "c1", name: "look", arguments: "{}" }],
                },
            },
        ]);
        env.model.nextTurn(textTurn("carried on"));

        const entry = await env.core.sessions.ensure("toto", sid);
        const history = env.core.sessions.history(entry);
        const answers = history.filter((m) => m.role === "tool" && m.tool_call_id === "c1");
        assert.equal(answers.length, 1, "the next prompt carries a result for every call");
        assert.match(String(answers[0]?.content), /interrupted/);

        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "again", title: false });
        assert.equal(out.dropped, false);
    } finally {
        await env.stop();
    }
});

test("a hello naming anything but the key's pinned name is refused, and pins nothing", async () => {
    const env = await boot();
    try {
        const key = fakeIdentity();
        env.pin("toto", key.pubkey);
        await assert.rejects(env.connect({ name: "my-agent", identity: key, tools: [] }, false), /refused/);
        assert.equal(env.core.registry.get("my-agent"), undefined);
        assert.equal(env.core.registry.get("toto"), undefined);
        assert.equal(env.db.getPin("my-agent"), null);
    } finally {
        await env.stop();
    }
});

test("the tool loop stops at MAX_TOOL_TURNS", async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            tools: READ_TOOLS,
            handlers: { look: { text: "again" } },
        });
        const sid = h.createSession();
        for (let i = 0; i < 30; i++) env.model.nextTurn(callTurn([{ id: `c${i}`, name: "look" }]));

        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "loop", title: false });
        assert.match(out.text, /tool loop limit of 25 turns reached/);
        assert.equal(out.rounds, 25);
        assert.equal(env.model.requests.length, 25);
    } finally {
        await env.stop();
    }
});

test("a turn and its auto-title are both accounted, under their own scopes", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        const sid = h.createSession(null);
        env.model.nextTurn(textTurn("hello there"));
        env.model.nextTurn({
            events: [
                { kind: "text", text: '{"title":"A named thread"}' },
                { kind: "finish", reason: "stop" },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 6 },
        });

        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "hi", title: true });
        await out.titling;

        const rows = env.db.listLlmCalls(20);
        const scopes = rows.map((r) => r.scope);
        assert.ok(scopes.includes("toto"), "the turn is accounted");
        assert.ok(scopes.includes("toto:title"), "the title call is accounted");
        assert.equal(rows.every((r) => r.agent === "toto"), true);
        assert.equal(h.sessions.get(sid)?.title, "A named thread");

        // the scope strings above are untouched; callKind is the categorical beside them
        const turn = rows.find((r) => r.scope === "toto")!;
        const title = rows.find((r) => r.scope === "toto:title")!;
        assert.equal(turn.callKind, "turn");
        assert.equal(title.callKind, "title");
        assert.equal(turn.attempt, 1);
        assert.equal(turn.parentCallId, null);
        assert.equal(title.parentCallId, null, "the first title try is nobody's retry");
        assert.equal(turn.registryModel, "fake");
        assert.equal(turn.model, "fake", "requestedModel: what went on the wire");
        assert.equal(turn.reportedModel, "fake", "the endpoint named the model it served");
        assert.match(String(turn.callId), /^[0-9a-f]{32}$/);
        assert.notEqual(turn.callId, title.callId, "every call is its own id");
        assert.equal(turn.turnSeq, 1, "the user message that opened the turn");
        assert.equal(title.turnSeq, 1, "the title call belongs to the same turn");
        assert.ok((turn.durationMs ?? 0) >= 0);
    } finally {
        await env.stop();
    }
});

test("core shutdown aborts and drains an in-flight auto-title before its database can close", async () => {
    const env = await boot();
    const originalFetch = globalThis.fetch;
    const titleStarted = Promise.withResolvers<void>();
    let releaseTitle: ((reason?: unknown) => void) | undefined;
    let calls = 0;
    let blockTitle = true;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
        calls++;
        if (calls === 2 && blockTitle) {
            titleStarted.resolve();
            const signal = args[1]?.signal;
            return new Promise<Response>((_resolve, reject) => {
                releaseTitle = reject;
                if (signal?.aborted) reject(signal.reason);
                else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
        }
        return originalFetch(...args);
    }) as typeof fetch;
    try {
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        const sid = h.createSession(null);
        env.model.nextTurn(textTurn("hello there"));
        env.model.nextTurn(textTurn('{"title":"Late title"}'));

        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "hi", title: true });
        await titleStarted.promise;
        await env.core.stop();
        await out.titling;

        assert.equal(env.db.listLlmCalls(10).filter((row) => row.callKind === "title").length, 1);
    } finally {
        blockTitle = false;
        releaseTitle?.(new Error("test cleanup"));
        globalThis.fetch = originalFetch;
        await env.stop();
    }
});

test("each round of a turn is its own call row, tied to the seqs that round appended", async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            tools: READ_TOOLS,
            handlers: { look: { text: "LOOKED" }, read: { text: "READ" } },
        });
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "c1", name: "look" }, { id: "c2", name: "read" }]));
        env.model.nextTurn(textTurn("all done"));

        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });
        assert.equal(out.rounds, 2);

        const rows = env.db.listLlmCalls(20).reverse(); // oldest first: the round list, in order
        assert.equal(rows.length, 2);
        assert.equal(rows.every((r) => r.callKind === "turn"), true);
        assert.equal(rows.every((r) => r.turnSeq === 1), true, "one turn, one initiating seq");
        assert.notEqual(rows[0]?.callId, rows[1]?.callId);

        const events = h.sessions.get(sid)!.events;
        const seqOf = (pick: (m: Message) => boolean): number =>
            events.find((e) => e.type === "message" && pick(e.payload as Message))!.seq;
        // round 1 wrote the tool_calls message and both results; round 2 wrote the answer
        assert.deepEqual(rows[0]?.messageSeqs, [
            seqOf((m) => (m.tool_calls?.length ?? 0) > 0),
            seqOf((m) => m.tool_call_id === "c1"),
            seqOf((m) => m.tool_call_id === "c2"),
        ]);
        assert.deepEqual(rows[1]?.messageSeqs, [seqOf((m) => m.content === "all done")]);
        // the turn's own metrics name the LAST call, never a position
        assert.equal(out.metrics?.finalCallId, rows[1]?.callId);
        assert.equal(out.metrics?.registryModel, "fake");
        assert.equal(out.metrics?.requestedModel, "fake");
        // the done event feeds the chat tok/s footer: it carries the final call's completion tokens
        assert.equal(out.metrics?.completionTokens, rows[1]?.completionTokens);
        assert.equal(out.metrics?.rounds, 2);
        assert.ok((out.metrics?.turnDurationMs ?? -1) >= (out.metrics?.callDurationMs ?? 0));
    } finally {
        await env.stop();
    }
});

test("an agent's own one-shot chat is accounted as its own kind of call", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        env.model.nextTurn(textTurn("one shot"));
        h.send({ id: "chat-1", type: "chat", payload: { messages: [{ role: "user", content: "hi" }] } });
        await waitFor(() => h.frames().some((f) => f["id"] === "chat-1"), 4000, "the chat reply");

        const row = env.db.listLlmCalls(5)[0]!;
        assert.equal(row.scope, "toto:chat", "the existing scope string is untouched");
        assert.equal(row.callKind, "oneshot");
        assert.equal(row.attempt, 1);
        assert.equal(row.parentCallId, null);
        assert.equal(row.registryModel, "fake");
        assert.equal(row.reportedModel, "fake");
        assert.equal(row.turnSeq, null, "a one-shot belongs to no turn");
        assert.equal(row.messageSeqs, null, "and writes no history of its own");
        assert.match(String(row.callId), /^[0-9a-f]{32}$/);
    } finally {
        await env.stop();
    }
});

test("a reported reasoning count reaches the streamed done, the chat_ok and the stored row", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        env.model.nextTurn({
            events: [{ kind: "text", text: "thought it over" }, { kind: "finish", reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 40, reasoning_tokens: 32 },
        });
        h.send({
            id: "chat-r",
            type: "chat",
            payload: { messages: [{ role: "user", content: "hi" }], stream: true },
        });
        await waitFor(
            () => h.frames().some((f) => f["type"] === "chat_ok" && f["id"] === "chat-r"),
            4000,
            "the chat reply",
        );

        const done = h
            .frames()
            .find((f) => f["type"] === "stream" && (f["payload"] as StreamEvent).type === "done");
        assert.equal((done?.["payload"] as Extract<StreamEvent, { type: "done" }>).usage?.reasoningTokens, 32);

        const ok = h.frames().find((f) => f["type"] === "chat_ok" && f["id"] === "chat-r");
        const usage = (ok?.["payload"] as ChatOkPayload).usage;
        assert.equal(usage?.reasoningTokens, 32);
        assert.equal(usage?.completionTokens, 40, "reasoning is a subset — the completion count is untouched");
        assert.equal(usage?.totalTokens, 50);

        const row = env.db.listLlmCalls(5)[0]!;
        assert.equal(row.reasoningTokens, 32);
        assert.equal(row.completionTokens, 40);
        assert.equal(row.totalTokens, 50, "no total ever grows by the reasoning count");
    } finally {
        await env.stop();
    }
});

test("a provider that reports no reasoning count leaves it absent on the wire and null on the row", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        env.model.nextTurn(textTurn("plain answer"));
        h.send({
            id: "chat-s",
            type: "chat",
            payload: { messages: [{ role: "user", content: "hi" }], stream: true },
        });
        await waitFor(
            () => h.frames().some((f) => f["type"] === "chat_ok" && f["id"] === "chat-s"),
            4000,
            "the chat reply",
        );

        const ok = h.frames().find((f) => f["type"] === "chat_ok" && f["id"] === "chat-s");
        const usage = (ok?.["payload"] as ChatOkPayload).usage;
        assert.equal("reasoningTokens" in (usage as object), false);
        assert.equal(env.db.listLlmCalls(5)[0]?.reasoningTokens, null);
    } finally {
        await env.stop();
    }
});

test("a failed model call is still accounted", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        const sid = h.createSession();
        // no scripted turn queued, so the provider throws; the matcher must exclude an admission refusal from satisfying this rejection
        await assert.rejects(
            env.core.runTurn({ agent: "toto", session: sid, text: "hi", title: false }),
            (e: unknown) => !/is blocked|has no pin/.test((e as Error).message),
        );
        const rows = env.db.listLlmCalls(10);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.scope, "toto");
        assert.equal(rows[0]?.finishReason, "error");
        // the conversation never ends on a bare user message
        assert.match(String(messagesOf(h, sid).at(-1)?.content), /provider error/);
    } finally {
        await env.stop();
    }
});

const WRITE_TOOLS = [
    { name: "save_draft", writes: true, parameters: { type: "object", properties: {} } },
    { name: "send_email", writes: true, parameters: { type: "object", properties: {} } },
];

const frameOf = (h: Harness, id: string): Record<string, unknown> => {
    const frame = h.frames().find((f) => f["id"] === id);
    assert.ok(frame, `no reply to ${id}`);
    return frame;
};

const errorOf = (frame: Record<string, unknown>): string =>
    String((frame["error"] as { message?: string } | undefined)?.message ?? "");

/** One ask_approve frame, answered or refused — resolves with the reply frame either way. */
async function ask(h: Harness, id: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    h.send({ id, type: "ask_approve", payload });
    await waitFor(() => h.frames().some((f) => f["id"] === id), 4000, `the ${id} reply`);
    return frameOf(h, id);
}

test("two tool calls sharing one model id become two approval rows, decided apart", async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            tools: WRITE_TOOLS,
            handlers: { save_draft: { text: "SAVED" }, send_email: { text: "SENT" } },
        });
        const sid = h.createSession();
        // one batch, one id — and it is the very id the gateway mints, so the replacement it picks
        // must not collide with it either: the model decides what it calls, never what an approval
        // addresses
        env.model.nextTurn(
            callTurn([{ id: "call#1", name: "save_draft" }, { id: "call#1", name: "send_email" }]),
        );
        env.model.nextTurn(textTurn("done"));

        const turn = env.core.runTurn({ agent: "toto", session: sid, text: "go", attended: true, title: false });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the batch gate");
        const gate = env.core.approvals.pending()[0]!.gate;
        const card = env.core.approvals.describe(gate)!;
        assert.deepEqual(
            card.actions.map((a) => a.tool),
            ["save_draft", "send_email"],
        );
        assert.equal(new Set(card.actions.map((a) => a.id)).size, 2, "one approval key per call");

        // the owner ticks the benign row only
        assert.equal(env.core.approvals.answer(gate, { [card.actions[0]!.id]: true }), true);
        await turn;

        assert.deepEqual(
            h.invokes().map((f) => (f["payload"] as { tool: string }).tool),
            ["save_draft"],
            "the denied row never left the gateway",
        );
        const msgs = messagesOf(h, sid);
        const opening = msgs.find((m) => (m.tool_calls?.length ?? 0) > 0);
        const results = msgs.filter((m) => m.role === "tool");
        assert.deepEqual(
            opening?.tool_calls?.map((c) => c.id),
            results.map((m) => m.tool_call_id),
            "every result pairs with its own tool_call",
        );
        assert.equal(new Set(results.map((m) => m.tool_call_id)).size, 2);
        assert.equal(results.find((m) => m.content === "SAVED")?.tool_call_id, card.actions[0]!.id);
    } finally {
        await env.stop();
    }
});

test("ask_approve is bounded — label, detail, the cards left open and the rate", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });

        assert.match(errorOf(await ask(h, "v1", { label: "x".repeat(201) })), /label must be 1-200/);
        assert.match(errorOf(await ask(h, "v2", { label: "   " })), /label must be 1-200/);
        assert.match(errorOf(await ask(h, "v3", { label: "ok", detail: "nope" })), /detail must be an object/);
        assert.match(
            errorOf(await ask(h, "v4", { label: "ok", detail: { blob: "y".repeat(9_000) } })),
            /detail is over 8192/,
        );
        assert.equal(env.core.approvals.pending().length, 0, "a refused ask parks nothing");

        for (let i = 0; i < 8; i++) h.send({ id: `p${i}`, type: "ask_approve", payload: { label: `park ${i}` } });
        await waitFor(() => env.core.approvals.pending().length === 8, 4000, "eight parked cards");
        const over = await ask(h, "p8", { label: "one too many" });
        assert.equal(over["status"], "denied");
        assert.match(errorOf(over), /already has 8 approvals waiting/);
        assert.equal(env.core.approvals.pending().length, 8);

        // answered cards free the cap but never the minute: past 12/min the ask itself is refused
        for (const g of env.core.approvals.pending()) env.core.approvals.answer(g.gate, {});
        for (let i = 8; i < 12; i++) {
            h.send({ id: `p${i}`, type: "ask_approve", payload: { label: `park ${i}` } });
            await waitFor(() => env.core.approvals.pending().length === 1, 4000, `card ${i}`);
            env.core.approvals.answer(env.core.approvals.pending()[0]!.gate, {});
        }
        const rated = await ask(h, "p12", { label: "thirteenth" });
        assert.equal(rated["status"], "denied");
        assert.match(errorOf(rated), /over 12\/min/);
    } finally {
        await env.stop();
    }
});

test("an a2a_call spends the same approval budget it would park a card against", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        const call = async (id: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
            h.send({ id, type: "a2a_call", payload: { agent: "mate", command: "ship", args } });
            await waitFor(() => h.frames().some((f) => f["id"] === id), 4000, `the ${id} reply`);
            return frameOf(h, id);
        };

        // the write gate parks these args for five minutes: agent-sized ones never get that far
        const fat = await call("c1", { blob: "y".repeat(9_000) });
        assert.equal(fat["status"], "error");
        assert.match(errorOf(fat), /detail is over 8192/);

        for (let i = 0; i < 8; i++) h.send({ id: `q${i}`, type: "ask_approve", payload: { label: `park ${i}` } });
        await waitFor(() => env.core.approvals.pending().length === 8, 4000, "eight parked cards");
        const over = await call("c2", { to: "ops" });
        assert.equal(over["status"], "denied");
        assert.match(errorOf(over), /already has 8 approvals waiting/);
        assert.equal(env.core.approvals.pending().length, 8, "the refused call parked nothing");
        assert.equal(env.db.listInteractions({}).interactions.length, 0, "and started no interaction");
    } finally {
        await env.stop();
    }
});

test("a paused agent parks no approvals and files no inbox items", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        env.core.setPaused("toto", true);

        const refused = await ask(h, "pa1", { label: "sneak one in" });
        assert.equal(refused["status"], "denied");
        assert.match(errorOf(refused), /paused/);
        assert.equal(env.core.approvals.pending().length, 0);

        h.send({ id: "n1", type: "notify", payload: { title: "still here", body: "hello" } });
        await waitFor(() => env.logs.some((l) => l.includes("is paused — dropped")), 4000, "the dropped notify");
        assert.equal(env.db.listInbox().items.length, 0);
    } finally {
        await env.stop();
    }
});

test("a spent daily model limit stops the calls one socket pipelined against it", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        setModelPricing("fake", { limit: { unit: "tokens", value: 10 } }, env.db);
        for (let i = 0; i < 4; i++) env.model.nextTurn(textTurn("hi"));

        const ids = ["c1", "c2", "c3", "c4"];
        for (const id of ids) {
            h.send({ id, type: "chat", payload: { messages: [{ role: "user", content: "hi" }] } });
        }
        await waitFor(() => ids.every((id) => h.frames().some((f) => f["id"] === id)), 4000, "every reply");

        assert.equal(env.model.requests.length, 1, "only the call admitted against an unspent limit ran");
        const denied = ids.filter((id) => frameOf(h, id)["status"] === "denied");
        assert.deepEqual(denied, ["c2", "c3", "c4"]);
        assert.match(errorOf(frameOf(h, "c2")), /model fake reached its daily limit/);
    } finally {
        await env.stop();
    }
});

test("one socket may not hold more than four admitted model calls at once", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        for (let i = 0; i < 4; i++) env.model.nextTurn(textTurn("hi"));

        const ids = ["b1", "b2", "b3", "b4", "b5", "b6"];
        for (const id of ids) {
            h.send({ id, type: "chat", payload: { messages: [{ role: "user", content: "hi" }] } });
        }
        await waitFor(() => ids.every((id) => h.frames().some((f) => f["id"] === id)), 4000, "every reply");

        const refused = ids.filter((id) => /in flight/.test(errorOf(frameOf(h, id))));
        assert.deepEqual(refused, ["b5", "b6"]);
        assert.equal(env.model.requests.length, 4);
    } finally {
        await env.stop();
    }
});

test("a Stop frees the gateway's waiter, but a later ask still dies with the invoke the agent is running", async () => {
    const env = await boot();
    try {
        let invoked = false;
        let asking = false;
        let agent: Harness | null = null;
        const h = await connected(env, {
            name: "toto",
            tools: [{ name: "wire", writes: false, parameters: { type: "object", properties: {} } }],
            handlers: {
                wire: async () => {
                    invoked = true;
                    // the agent keeps running its tool after the Stop: only its own deadline ends it
                    await waitFor(() => asking, 4000, "the stop");
                    agent?.send({ id: "mid", type: "ask_approve", payload: { label: "send 40 EUR" } });
                    await waitFor(() => env.core.approvals.pending().length === 0, 4000, "the answer");
                    return { text: "WIRED" };
                },
            },
        });
        agent = h;
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "w1", name: "wire" }]));
        env.model.nextTurn(textTurn("done"));

        const run = env.core.turns.start({
            agent: "toto",
            session: sid,
            text: "go",
            attended: true,
            title: false,
            invokeDeadlineMs: 3_000,
        });
        run.result.catch(() => undefined);
        await waitFor(() => invoked, 4000, "the invoke");
        run.stop();
        asking = true;
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the post-stop gate");
        const gate = env.core.approvals.pending()[0]!;
        const left = gate.deadline - Date.now();
        assert.ok(left > 0 && left <= 3_000, `the card must not outlive the invoke, ${left}ms left`);

        env.core.approvals.answer(gate.gate, { a1: true });
        await run.finished;
    } finally {
        await env.stop();
    }
});

test("an approval asked mid-invoke expires with the invoke, whatever session it names", async () => {
    const env = await boot();
    try {
        let agent: Harness | null = null;
        const h = await connected(env, {
            name: "toto",
            tools: [{ name: "wire", writes: false, parameters: { type: "object", properties: {} } }],
            handlers: {
                wire: async () => {
                    // no `session`: the cap comes from the request the gateway is holding this
                    // peer to, not from a field the agent chooses (an a2a_invoke carries none)
                    agent?.send({ id: "mid", type: "ask_approve", payload: { label: "send 40 EUR" } });
                    await waitFor(() => env.core.approvals.pending().length === 0, 4000, "the answer");
                    return { text: "WIRED" };
                },
            },
        });
        agent = h;
        const sid = h.createSession();
        assert.equal(sid, 1);
        env.model.nextTurn(callTurn([{ id: "w1", name: "wire" }]));
        env.model.nextTurn(textTurn("done"));

        const turn = env.core.runTurn({
            agent: "toto",
            session: sid,
            text: "go",
            attended: true,
            title: false,
            invokeDeadlineMs: 2_000,
        });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the mid-invoke gate");
        const gate = env.core.approvals.pending()[0]!;
        const left = gate.deadline - Date.now();
        assert.ok(left > 0 && left <= 2_000, `the card must not outlive the invoke, ${left}ms left`);

        env.core.approvals.answer(gate.gate, { a1: true });
        assert.equal((await turn).text, "done");
    } finally {
        await env.stop();
    }
});

test("with no invoke deadline, an approval asked mid-invoke keeps its own five minutes", async () => {
    const env = await boot();
    try {
        let agent: Harness | null = null;
        const h = await connected(env, {
            name: "toto",
            tools: [{ name: "wire", writes: false, parameters: { type: "object", properties: {} } }],
            handlers: {
                wire: async () => {
                    agent?.send({ id: "mid", type: "ask_approve", payload: { label: "send 40 EUR" } });
                    await waitFor(() => env.core.approvals.pending().length === 0, 4000, "the answer");
                    return { text: "WIRED" };
                },
            },
        });
        agent = h;
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "w1", name: "wire" }]));
        env.model.nextTurn(textTurn("done"));

        const turn = env.core.runTurn({ agent: "toto", session: sid, text: "go", attended: true, title: false });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the mid-invoke gate");
        const gate = env.core.approvals.pending()[0]!;
        const left = gate.deadline - Date.now();
        assert.ok(left > 4 * 60_000 && left <= 5 * 60_000, `the approval's own timeout applies, ${left}ms left`);

        env.core.approvals.answer(gate.gate, { a1: true });
        assert.equal((await turn).text, "done");
    } finally {
        await env.stop();
    }
});

const SHIP = { name: "ship", writes: true, parameters: { type: "object", properties: {} } };

/** A target that lists one write command, `ship`, for other agents to call. */
async function shipper(env: Env, shipped: string[]): Promise<Harness> {
    return connected(env, {
        name: "mate",
        manifest: { a2a: { commands: ["ship"] } },
        tools: [SHIP],
        handlers: {
            ship: () => {
                shipped.push("ship");
                return { text: "SHIPPED" };
            },
        },
    });
}

test("a write a2a_call asked mid-invoke parks a card that dies with the invoke", async () => {
    const env = await boot();
    try {
        await shipper(env, []);
        let agent: Harness | null = null;
        const h = await connected(env, {
            name: "toto",
            tools: [{ name: "relay", writes: false, parameters: { type: "object", properties: {} } }],
            handlers: {
                relay: async () => {
                    agent?.send({ id: "mid", type: "a2a_call", payload: { agent: "mate", command: "ship", args: {} } });
                    await waitFor(() => agent?.frames().some((f) => f["id"] === "mid") === true, 4000, "the a2a reply");
                    return { text: "RELAYED" };
                },
            },
        });
        agent = h;
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "r1", name: "relay" }]));
        env.model.nextTurn(textTurn("done"));

        const turn = env.core.runTurn({ agent: "toto", session: sid, text: "go", attended: true, title: false, invokeDeadlineMs: 2_000 });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the a2a write gate");
        const gate = env.core.approvals.pending()[0]!;
        const left = gate.deadline - Date.now();
        assert.ok(left > 0 && left <= 2_000, `the card must not outlive the invoke, ${left}ms left`);

        env.core.approvals.answer(gate.gate, { a1: false });
        assert.equal((await turn).text, "done");
    } finally {
        await env.stop();
    }
});

test("a card approved after the target was paused or hidden sends nothing", async () => {
    const env = await boot();
    try {
        const shipped: string[] = [];
        const mate = await shipper(env, shipped);
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        const call = async (id: string, meanwhile: () => void): Promise<Record<string, unknown>> => {
            h.send({ id, type: "a2a_call", payload: { agent: "mate", command: "ship", args: {} } });
            await waitFor(() => env.core.approvals.pending().length === 1, 4000, `the ${id} card`);
            meanwhile();
            env.core.approvals.answer(env.core.approvals.pending()[0]!.gate, { a1: true });
            await waitFor(() => h.frames().some((f) => f["id"] === id), 4000, `the ${id} reply`);
            return frameOf(h, id);
        };

        const paused = await call("p1", () => env.core.setPaused("mate", true));
        assert.equal(paused["status"], "denied");
        assert.match(errorOf(paused), /"mate" is paused — nothing was sent/);

        env.core.setPaused("mate", false);
        const hidden = await call("p2", () => env.core.registry.setPerms("mate", { delegate: true, discoverable: false }));
        assert.equal(hidden["status"], "denied");
        assert.match(errorOf(hidden), /not discoverable — nothing was sent/);

        assert.deepEqual(shipped, []);
        assert.equal(mate.frames().filter((f) => f["type"] === "a2a_invoke").length, 0);
        const rows = env.db.listInteractions({ kind: "a2a" }).interactions;
        assert.deepEqual(rows.map((r) => r.status), ["denied", "denied"]);
    } finally {
        await env.stop();
    }
});

test("once the gateway is stopping an agent parks nothing, and stop() is not held by a card", { timeout: 15_000 }, async () => {
    const env = await boot();
    try {
        await shipper(env, []);
        await connected(env, { name: "toto", tools: [], handlers: {} });
        const peer = env.core.registry.get("toto")!;
        const hooks = env.core.registry.hooks!;
        const within = (work: Promise<unknown>): Promise<string> =>
            Promise.race([
                work.then(() => "answered", (e: unknown) => String(e)),
                new Promise<string>((r) => setTimeout(r, 2_000, "still waiting")),
            ]);

        const stopping = env.core.stop();
        assert.match(await within(hooks.a2aCall(peer, { agent: "mate", command: "ship", args: {} })), /gateway is stopping/);
        assert.match(await within(Promise.resolve(hooks.askApprove(peer, { label: "one more" }))), /gateway is stopping/);
        assert.equal(env.core.approvals.pending().length, 0);
        assert.equal(await within(stopping), "answered");
    } finally {
        await env.stop();
    }
});

test("a card approved after the target left or reconnected sends nothing, and fails as worth a retry", async () => {
    const env = await boot();
    try {
        const shipped: string[] = [];
        const mate = await shipper(env, shipped);
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        const call = async (id: string, meanwhile: () => Promise<void>): Promise<Record<string, unknown>> => {
            h.send({ id, type: "a2a_call", payload: { agent: "mate", command: "ship", args: {} } });
            await waitFor(() => env.core.approvals.pending().length === 1, 4000, `the ${id} card`);
            await meanwhile();
            env.core.approvals.answer(env.core.approvals.pending()[0]!.gate, { a1: true });
            await waitFor(() => h.frames().some((f) => f["id"] === id), 4000, `the ${id} reply`);
            return frameOf(h, id);
        };

        const left = await call("g1", async () => {
            mate.close();
            await waitFor(() => env.core.registry.get("mate") === undefined, 4000, "mate gone");
        });
        assert.equal(left["status"], "error");
        assert.equal(errorOf(left), 'the "mate" agent is not connected right now.');

        await shipper(env, shipped);
        const asked = env.core.registry.get("mate");
        const again = await call("g2", async () => {
            await shipper(env, shipped);
            await waitFor(() => ![undefined, asked].includes(env.core.registry.get("mate")), 4000, "mate reconnected");
        });
        assert.equal(again["status"], "error");
        assert.match(errorOf(again), /"mate" reconnected while the approval waited — nothing was sent/);

        assert.deepEqual(shipped, [], "no connection of mate ever ran the command");
        const rows = env.db.listInteractions({ kind: "a2a" }).interactions;
        assert.deepEqual(rows.map((r) => r.status), ["failed", "failed"]);
    } finally {
        await env.stop();
    }
});

test("an over-long notify is clamped and filed, never dropped", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        h.send({ id: "n1", type: "notify", payload: { title: `  ${"t".repeat(300)}  `, body: "b".repeat(70_000), level: "action" } });
        await waitFor(() => env.db.listInbox().items.length === 1, 4000, "the filed notice");
        const item = env.db.listInbox().items[0]!;
        assert.equal(item.title.length, 200);
        assert.ok(item.title.endsWith(`${"t".repeat(199)}…`));
        assert.equal(item.body.length, 65_536);
        assert.ok(item.body.endsWith("\n…[truncated]"));
        assert.equal(item.level, "action");

        // the cut lands inside a surrogate pair: what is stored is still well-formed text
        h.send({ id: "n2", type: "notify", payload: { title: `${"a".repeat(198)}😀tail` } });
        await waitFor(() => env.db.listInbox().items.length === 2, 4000, "the second notice");
        assert.equal(env.db.listInbox().items[0]!.title.isWellFormed(), true);

        h.send({ id: "n3", type: "notify", payload: { title: "   " } });
        await waitFor(() => env.logs.some((l) => l.includes("notify refused — notify: title must not be empty")), 4000, "the refusal");
        assert.equal(env.db.listInbox().items.length, 2);
    } finally {
        await env.stop();
    }
});
