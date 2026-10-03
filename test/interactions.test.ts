/** Interaction records: written where the operation happens, then listed, paged and followed. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GatewayDb, type InteractionRow } from "../src/store/db.ts";
import { autoApprove, boot, callTurn, textTurn, waitFor, type Env, type NdjsonStream } from "./harness-env.ts";

const ready = (env: Env, name: string): Promise<void> =>
    waitFor(() => env.core.agent(name).connected, 4000, `${name} ready`);

/** The `interaction` lines of the stream, waited for so an assertion never races the fanout. */
async function fired(events: NdjsonStream, count: number): Promise<Array<Record<string, unknown>>> {
    const mine = (): Array<Record<string, unknown>> => events.lines.filter((e) => e["type"] === "interaction");
    await waitFor(() => mine().length >= count, 4000, `${count} interaction events`);
    return mine();
}

const rows = async (
    env: Env,
    query: string,
): Promise<{ interactions: InteractionRow[]; hasMore: boolean }> => {
    const res = await env.api<{ interactions: InteractionRow[]; hasMore: boolean }>(
        "GET",
        `/api/interactions${query}`,
    );
    assert.equal(res.status, 200, query);
    return res.json;
};

test("a delegation is recorded sent → answered, carrying both ends of the exchange", async () => {
    const env = await boot();
    const stopGates = autoApprove(env);
    try {
        const boss = await env.connect({ name: "boss" });
        const mate = await env.connect({ name: "mate" });
        await ready(env, "boss");
        await ready(env, "mate");

        const events = await env.stream("GET", "/api/events");
        await waitFor(() => events.lines.some((e) => e["type"] === "ready"), 4000, "the stream opened");

        env.model.nextTurn(callTurn([{ id: "a1", name: "ask_mate", args: '{"task":"count them"}' }]));
        env.model.nextTurn(textTurn("seventeen")); // mate's own turn, run inside the tool
        env.model.nextTurn(textTurn("done"));
        const session = boss.createSession();
        await env.core.runTurn({
            agent: "boss",
            session,
            text: "go",
            actor: { kind: "human" },
            attended: true,
            title: false,
        });

        const listed = env.db.listInteractions();
        assert.equal(listed.hasMore, false);
        assert.equal(listed.interactions.length, 1);
        const row = listed.interactions[0];
        assert.ok(row);
        assert.equal(row.kind, "delegate");
        assert.equal(row.from, "boss");
        assert.equal(row.to, "mate");
        assert.equal(row.status, "answered");
        assert.equal(row.originConversation, session);
        const delegated = [...mate.sessions.values()].find((s) => s.title?.startsWith("←"));
        assert.ok(delegated, "the delegate got its own thread");
        assert.equal(row.targetConversation, delegated.id);
        // the sender's call that made the tool call, joinable to its accounting row
        assert.ok(
            env.db.listLlmCalls(50, "boss").some((c) => c.callId === row.originCallId),
            "originCallId names a real call of the sender",
        );
        // the report rode a return gate, and the row points at it — the gate stays the authority
        assert.match(row.gate ?? "", /^[0-9a-f]{32}$/);

        const one = await env.api("GET", `/api/interactions/${row.id}`);
        assert.equal(one.status, 200);
        assert.deepEqual(one.json, row);

        const events2 = await fired(events, 2);
        assert.deepEqual(
            events2.map((e) => e["status"]),
            ["sent", "answered"],
        );
        assert.ok(events2.every((e) => e["id"] === row.id && e["kind"] === "delegate"));
    } finally {
        stopGates();
        await env.stop();
    }
});

test("a delegation the delegate cannot run is recorded failed, target and all", async () => {
    const env = await boot();
    const stopGates = autoApprove(env);
    try {
        const boss = await env.connect({ name: "boss" });
        await env.connect({ name: "mate" });
        await ready(env, "boss");
        await ready(env, "mate");
        // the delegate resolves no model of its own, so its turn dies after the record exists
        env.db.setModelsPolicy("mate", { allowed: ["ghost-model"], primary: "ghost-model" });

        const events = await env.stream("GET", "/api/events");
        await waitFor(() => events.lines.some((e) => e["type"] === "ready"), 4000, "the stream opened");

        env.model.nextTurn(callTurn([{ id: "a1", name: "ask_mate", args: '{"task":"count them"}' }]));
        env.model.nextTurn(textTurn("done"));
        const session = boss.createSession();
        const results: Record<string, string> = {};
        await env.core.runTurn({
            agent: "boss",
            session,
            text: "go",
            attended: true,
            title: false,
            emit: (ev) => {
                if (ev["type"] === "tool_result") results[String(ev["id"])] = String(ev["text"]);
            },
        });
        assert.match(results["a1"] ?? "", /could not run/);

        const row = env.db.listInteractions().interactions[0];
        assert.ok(row);
        assert.equal(row.status, "failed");
        assert.equal(row.originConversation, session);
        // the thread was made before the turn was refused: the record keeps the real reference
        assert.ok(row.targetConversation);
        assert.equal(row.gate, undefined);
        assert.deepEqual(
            (await fired(events, 2)).map((e) => e["status"]),
            ["sent", "failed"],
        );
    } finally {
        stopGates();
        await env.stop();
    }
});

test("a chain step's data carries the ids the sender's card links the exchange by", async () => {
    const env = await boot();
    const stopGates = autoApprove(env);
    try {
        const boss = await env.connect({
            name: "boss",
            manifest: { chain: true },
            tools: [{ name: "echo", description: "echo the arguments back", writes: false }],
            handlers: { echo: (args) => ({ text: JSON.stringify(args) }) },
        });
        await env.connect({ name: "mate" });
        await ready(env, "boss");
        await ready(env, "mate");

        // a chain is the one place a tool result's data channel is observable end to end
        const steps = [
            { tool: "ask_mate", args: { task: "count them" } },
            {
                tool: "echo",
                args: { ask: "${0.interactionId}", conversation: "${0.conversation}" },
            },
        ];
        env.model.nextTurn(callTurn([{ id: "c1", name: "chain", args: JSON.stringify({ steps }) }]));
        env.model.nextTurn(textTurn("seventeen"));
        env.model.nextTurn(textTurn("done"));
        await env.core.runTurn({
            agent: "boss",
            session: boss.createSession(),
            text: "go",
            attended: true,
            title: false,
        });

        const invoke = boss
            .invokes()
            .find((f) => ((f["payload"] ?? {}) as Record<string, unknown>)["tool"] === "echo");
        assert.ok(invoke, "the echo step ran, so every reference resolved");
        const args = ((invoke["payload"] ?? {}) as Record<string, unknown>)["args"] as Record<
            string,
            unknown
        >;
        const delegate = env.db.listInteractions({ kind: "delegate" }).interactions[0];
        assert.ok(delegate);
        assert.equal(args["ask"], delegate.id);
        assert.equal(args["conversation"], delegate.targetConversation);
    } finally {
        stopGates();
        await env.stop();
    }
});

test("an agent and conversation filter refer to the same end of an interaction", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "mimi-interaction-scope-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    t.after(() => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const sent = db.insertInteraction({ kind: "delegate", from: "alpha", to: "beta", status: "answered", originConversation: 1, targetConversation: 9 });
    db.insertInteraction({ kind: "delegate", from: "alpha", to: "beta", status: "answered", originConversation: 2, targetConversation: 1 });
    const received = db.insertInteraction({ kind: "delegate", from: "beta", to: "alpha", status: "answered", originConversation: 8, targetConversation: 1 });
    db.insertInteraction({ kind: "delegate", from: "beta", to: "alpha", status: "answered", originConversation: 1, targetConversation: 3 });

    assert.deepEqual(db.listInteractions({ agent: "alpha", conversation: 1 }).interactions.map((row) => row.id), [received.id, sent.id]);
    assert.equal(db.listInteractions({ agent: "alpha" }).interactions.length, 4);
    assert.equal(db.listInteractions({ conversation: 1 }).interactions.length, 4);
});

test("the list route filters by agent, conversation and kind, and pages newest first", async () => {
    const env = await boot();
    try {
        const seeded = [
            env.db.insertInteraction({
                kind: "delegate",
                from: "boss",
                to: "mate",
                status: "answered",
                originConversation: 1,
                targetConversation: 7,
            }),
            env.db.insertInteraction({
                kind: "delegate",
                from: "boss",
                to: "mate",
                status: "sent",
                originConversation: 2,
                targetConversation: 6,
            }),
            env.db.insertInteraction({
                kind: "delegate",
                from: "boss",
                to: "mate",
                status: "sent",
                originConversation: 1,
                targetConversation: 9,
            }),
            env.db.insertInteraction({
                kind: "delegate",
                from: "zed",
                to: "zoe",
                status: "sent",
                originConversation: 4,
            }),
        ];
        const ids = seeded.map((r) => r.id);

        const all = await rows(env, "");
        assert.deepEqual(
            all.interactions.map((r) => r.id),
            [...ids].reverse(),
        );
        assert.equal(all.hasMore, false);

        const first = await rows(env, "?limit=2");
        assert.deepEqual(
            first.interactions.map((r) => r.id),
            [ids[3], ids[2]],
        );
        assert.equal(first.hasMore, true);
        const second = await rows(env, `?limit=2&before=${ids[2]}`);
        assert.deepEqual(
            second.interactions.map((r) => r.id),
            [ids[1], ids[0]],
        );
        assert.equal(second.hasMore, false);

        const a2a = env.db.insertInteraction({ kind: "a2a", from: "boss", to: "mate", status: "answered", command: "sync" });
        assert.deepEqual(
            (await rows(env, "?kind=delegate")).interactions.map((r) => r.id),
            [...ids].reverse(),
        );
        assert.deepEqual((await rows(env, "?kind=a2a")).interactions.map((r) => r.id), [a2a.id]);
        // either end of the operation answers an agent filter
        assert.deepEqual((await rows(env, "?agent=zoe")).interactions.map((r) => r.id), [ids[3]]);
        assert.equal((await rows(env, "?agent=nobody")).interactions.length, 0);
        // a conversation matches whichever side of the exchange it sits on
        assert.deepEqual((await rows(env, "?conversation=9")).interactions.map((r) => r.id), [ids[2]]);
        assert.deepEqual(
            (await rows(env, "?conversation=1&kind=delegate")).interactions.map((r) => r.id),
            [ids[2], ids[0]],
        );

        assert.equal((await env.api("GET", "/api/interactions?kind=bogus")).status, 400);
        assert.equal((await env.api("GET", "/api/interactions?agent=Boss")).status, 400);
        assert.equal((await env.api("GET", "/api/interactions?limit=0")).status, 400);
        assert.equal((await env.api("GET", "/api/interactions?conversation=x")).status, 400);
    } finally {
        await env.stop();
    }
});

test("list rows leave an a2a exchange's args and result to the detail route", async () => {
    const env = await boot();
    try {
        const big = JSON.stringify({ blob: "x".repeat(200_000) });
        const sent = env.db.insertInteraction({ kind: "a2a", from: "boss", to: "mate", status: "sent", command: "lookup", args: big });
        env.db.updateInteraction(sent.id, { status: "answered", result: big, durationMs: 12 });

        const listed = await env.api<{ interactions: Array<Record<string, unknown>> }>("GET", "/api/interactions");
        assert.equal(listed.status, 200);
        const [row] = listed.json.interactions;
        assert.ok(row);
        assert.equal(row["id"], sent.id);
        assert.equal(row["command"], "lookup");
        assert.equal(row["durationMs"], 12);
        assert.equal("args" in row, false);
        assert.equal("result" in row, false);
        assert.ok(JSON.stringify(listed.json).length < 2_000, "a list page carries no payloads");

        const detail = await env.api<Record<string, unknown>>("GET", `/api/interactions/${sent.id}`);
        assert.equal(detail.json["args"], big);
        assert.equal(detail.json["result"], big);
    } finally {
        await env.stop();
    }
});

test("a delegate that answers without a real chat id is recorded failed, and no turn starts on it", async (t) => {
    const env = await boot();
    const stopGates = autoApprove(env);
    try {
        const boss = await env.connect({ name: "boss" });
        await env.connect({ name: "mate" });
        await ready(env, "boss");
        await ready(env, "mate");
        const mate = env.core.registry.get("mate")!;
        const real = mate.request.bind(mate);
        t.mock.method(mate, "request", ((type: string, payload: unknown, opts?: unknown) =>
            type === "session_create"
                ? Promise.resolve({ head: { session: "../../../pins/boss", revision: 0, headSeq: 0, headHash: "" } })
                : (real as (...args: unknown[]) => Promise<unknown>)(type, payload, opts)) as typeof mate.request);
        const changed: string[] = [];
        env.core.events.subscribe((ev) => {
            if (ev.type === "chat_changed") changed.push(String(ev["agent"]));
        });

        env.model.nextTurn(callTurn([{ id: "a1", name: "ask_mate", args: '{"task":"count them"}' }]));
        env.model.nextTurn(textTurn("done"));
        const session = boss.createSession();
        const results: Record<string, string> = {};
        await env.core.runTurn({
            agent: "boss",
            session,
            text: "go",
            attended: true,
            title: false,
            emit: (ev) => {
                if (ev["type"] === "tool_result") results[String(ev["id"])] = String(ev["text"]);
            },
        });
        const row = env.db.listInteractions().interactions[0];
        assert.ok(row);
        assert.equal(row.status, "failed");
        assert.equal(row.targetConversation, undefined);
        assert.equal(changed.includes("mate"), false);
        assert.match(results["a1"] ?? "", /could not run: it answered without a real chat id/);
    } finally {
        stopGates();
        await env.stop();
    }
});

test("an id nothing was ever recorded under is a 404, as a row and as a cursor", async () => {
    const env = await boot();
    try {
        const ghost = "a".repeat(32);
        assert.equal((await env.api("GET", `/api/interactions/${ghost}`)).status, 404);
        // an unknown cursor would read as "the end of the list": it is refused instead
        assert.equal((await env.api("GET", `/api/interactions?before=${ghost}`)).status, 404);
        assert.equal((await env.api("GET", "/api/interactions/not-an-id")).status, 404);
    } finally {
        await env.stop();
    }
});

test("a paused target is refused before anything is sent, and records nothing", async () => {
    const env = await boot();
    const stopGates = autoApprove(env);
    try {
        const boss = await env.connect({ name: "boss" });
        const mate = await env.connect({ name: "mate" });
        await ready(env, "boss");
        await ready(env, "mate");
        env.core.setPaused("mate", true);

        env.model.nextTurn(callTurn([{ id: "a1", name: "ask_mate", args: '{"task":"count them"}' }]));
        env.model.nextTurn(textTurn("done"));
        const session = boss.createSession();
        const results: Record<string, string> = {};
        await env.core.runTurn({
            agent: "boss",
            session,
            text: "go",
            attended: true,
            title: false,
            emit: (ev) => {
                if (ev["type"] === "tool_result") results[String(ev["id"])] = String(ev["text"]);
            },
        });

        assert.match(results["a1"] ?? "", /Denied: "mate" is paused/);
        assert.equal(env.db.listInteractions().interactions.length, 0);
        assert.equal([...mate.sessions.values()].length, 0, "no thread was opened on the paused agent");
    } finally {
        stopGates();
        await env.stop();
    }
});
