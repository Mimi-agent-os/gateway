/** ask_owner: the argument and answer checks, the question gate on the approval plumbing, the reply route, and every way the wait ends. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import type { Message, OwnerQuestion } from "@mimi-os/protocol";

import { Gates } from "../src/gates/gates.ts";
import { parseAnswers, parseQuestions } from "../src/gates/questions.ts";
import { buildRouter } from "../src/http/index.ts";
import { gatewayToolNames } from "../src/turn/gateway-tools.ts";
import type { HubEvent } from "../src/events.ts";
import { boot, callTurn, textTurn, waitFor, type Env } from "./harness-env.ts";
import type { Harness } from "./agent-harness.ts";

const ASK = {
    questions: [
        { question: " Which database? ", options: [{ label: "Postgres", description: " the usual " }, { label: "SQLite" }] },
        {
            question: "Which features?",
            options: [{ label: "Auth" }, { label: "Billing", description: "" }, { label: "Audit" }],
            multi: true,
            other: true,
        },
    ],
};

const QUESTIONS: OwnerQuestion[] = [
    {
        question: "Which database?",
        options: [{ label: "Postgres", description: "the usual" }, { label: "SQLite" }],
        multi: false,
        other: false,
    },
    { question: "Which features?", options: [{ label: "Auth" }, { label: "Billing" }, { label: "Audit" }], multi: true, other: true },
];

const UNANSWERED = /^The owner did not answer/;

interface Row {
    gate: string;
    kind: string;
    agent: string;
    conversation?: number;
    tool: string;
    label: string;
    actions: unknown[];
    deadline: number;
}

async function connected(env: Env): Promise<Harness> {
    const h = await env.connect({ name: "toto" });
    await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
    return h;
}

/** One attended turn that calls ask_owner with `args`, collecting what its stream and the device fanout carried. */
function asking(env: Env, h: Harness, args: unknown, attended = true): {
    turn: Promise<unknown>;
    emitted: Record<string, unknown>[];
    hub: HubEvent[];
    result: () => string | undefined;
} {
    const emitted: Record<string, unknown>[] = [];
    const hub: HubEvent[] = [];
    env.core.events.subscribe((ev) => void hub.push(ev));
    env.model.nextTurn(callTurn([{ id: "q1", name: "ask_owner", args: JSON.stringify(args) }]));
    env.model.nextTurn(textTurn("noted"));
    const turn = env.core.runTurn({
        agent: "toto",
        session: h.createSession(),
        text: "set it up",
        attended,
        title: false,
        emit: (ev) => void emitted.push(ev),
    });
    const result = (): string | undefined => {
        const ev = emitted.find((e) => e["type"] === "tool_result" && e["id"] === "q1");
        return typeof ev?.["text"] === "string" ? ev["text"] : undefined;
    };
    return { turn, emitted, hub, result };
}

test("parseQuestions: the questions come back trimmed, with multi and other filled in", () => {
    assert.deepEqual(parseQuestions(ASK), QUESTIONS);
});

test("parseQuestions: every bound is checked, and the error names the field", () => {
    const options = [{ label: "Yes" }, { label: "No" }];
    const one = (q: Record<string, unknown>): Record<string, unknown> => ({ questions: [{ question: "Go?", options, ...q }] });
    const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{}, /^questions must be a list of 1 to 4 questions$/],
        [{ questions: [] }, /^questions must be a list of 1 to 4/],
        [{ questions: Array(5).fill({ question: "Go?", options }) }, /^questions must be a list of 1 to 4/],
        [{ questions: ["Go?"] }, /^questions\[0\] must be an object$/],
        [one({ question: "  " }), /^questions\[0\]\.question must be 1 to 500 characters$/],
        [one({ question: "x".repeat(501) }), /^questions\[0\]\.question must be 1 to 500/],
        [one({ options: [{ label: "Yes" }] }), /^questions\[0\]\.options must be a list of 2 to 8 options$/],
        [one({ options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })) }), /options must be a list of 2 to 8/],
        [one({ options: [{ label: "Yes" }, "No"] }), /^questions\[0\]\.options\[1\] must be an object$/],
        [one({ options: [{ label: "Yes" }, { label: " yes " }] }), /^questions\[0\]\.options\[1\]\.label "yes" repeats another option's label$/],
        [one({ options: [{ label: "Yes" }, { label: "" }] }), /options\[1\]\.label must be one line of 1 to 80 characters/],
        [one({ options: [{ label: "Yes" }, { label: "x".repeat(81) }] }), /label must be one line of 1 to 80/],
        [one({ options: [{ label: "Yes" }, { label: "N\no" }] }), /label must be one line/],
        [one({ options: [{ label: "Yes" }, { label: 2 }] }), /label must be one line/],
        [one({ options: [{ label: "Yes", description: "x".repeat(301) }, { label: "No" }] }), /options\[0\]\.description must be text of at most 300 characters/],
        [one({ options: [{ label: "Yes", description: 7 }, { label: "No" }] }), /description must be text/],
        [one({ multi: "yes" }), /^questions\[0\]\.multi must be true or false$/],
        [one({ other: 1 }), /^questions\[0\]\.other must be true or false$/],
    ];
    for (const [args, why] of cases) {
        const got = parseQuestions(args);
        assert.equal(typeof got, "string", JSON.stringify(args).slice(0, 80));
        assert.match(got as string, why);
    }
});

test("parseAnswers: picks are checked against the gate's own options and come back in the options' order", () => {
    assert.deepEqual(parseAnswers(QUESTIONS, [{ selected: ["SQLite"] }, { selected: ["Audit", "Auth"], other: "  and logs " }]), [
        { selected: ["SQLite"] },
        { selected: ["Auth", "Audit"], other: "and logs" },
    ]);
    // own words stand in for a pick where the question allows them
    assert.deepEqual(parseAnswers(QUESTIONS, [{ selected: ["Postgres"] }, { selected: [], other: "none of these" }]), [
        { selected: ["Postgres"] },
        { selected: [], other: "none of these" },
    ]);
    const cases: Array<[unknown, RegExp]> = [
        [undefined, /^answers must be a list of 2, one per question$/],
        [[{ selected: ["Postgres"] }], /one per question/],
        [["Postgres", { selected: ["Auth"] }], /^answers\[0\] must be an object$/],
        [[{ selected: "Postgres" }, { selected: ["Auth"] }], /^answers\[0\]\.selected must be a list of option labels$/],
        [[{ selected: ["MySQL"] }, { selected: ["Auth"] }], /^answers\[0\]\.selected: "MySQL" is not an option of this question$/],
        [[{ selected: ["postgres"] }, { selected: ["Auth"] }], /"postgres" is not an option/],
        [[{ selected: ["Postgres", "SQLite"] }, { selected: ["Auth"] }], /^answers\[0\]: this question takes a single pick$/],
        [[{ selected: ["Postgres"], other: "maybe" }, { selected: ["Auth"] }], /^answers\[0\]: this question takes no answer in the owner's own words$/],
        [[{ selected: [] }, { selected: ["Auth"] }], /^answers\[0\]: pick one option$/],
        [[{ selected: ["Postgres"] }, { selected: ["Auth", "Auth"] }], /^answers\[1\]\.selected names an option twice$/],
        [[{ selected: ["Postgres"] }, { selected: [], other: "  " }], /^answers\[1\]: pick at least one option or answer in your own words$/],
        [[{ selected: ["Postgres"] }, { selected: ["Auth"], other: 5 }], /^answers\[1\]\.other must be text$/],
        [[{ selected: ["Postgres"] }, { selected: ["Auth"], other: "x".repeat(2001) }], /^answers\[1\]\.other is over 2000 characters$/],
    ];
    for (const [raw, why] of cases) {
        const got = parseAnswers(QUESTIONS, raw);
        assert.equal(typeof got, "string", JSON.stringify(raw));
        assert.match(got as string, why);
    }
});

test("a question gate waits twelve hours, and only its own kind of answer settles it", async () => {
    const parked: Array<{ kind: string; tool: string }> = [];
    const gates = new Gates({ onPark: (g) => void parked.push(g) });
    const t0 = Date.now();
    const question = gates.askOwner({ agent: "toto", session: 3 }, QUESTIONS);
    const approval = gates.ask({ agent: "toto", session: 3 }, [{ id: "w1", tool: "send_email", args: {} }]);
    assert.deepEqual(parked.map((p) => [p.kind, p.tool]), [["question", "ask_owner"], ["approval", "send_email"]]);

    const q = gates.pending().find((g) => g.kind === "question")!;
    const a = gates.pending().find((g) => g.kind === "approval")!;
    assert.equal(q.tool, "ask_owner");
    assert.ok(q.deadline >= t0 + 12 * 3_600_000 && q.deadline <= Date.now() + 12 * 3_600_000);
    assert.ok(a.deadline <= Date.now() + 5 * 60_000);
    assert.deepEqual(gates.describe(q.gate)?.questions, QUESTIONS);
    assert.deepEqual(gates.describe(q.gate)?.actions, []);

    assert.equal(gates.answer(q.gate, { w1: true }), false, "decisions never settle a question");
    assert.equal(gates.reply(a.gate, null), false, "a dismissal never settles an approval");
    assert.equal(gates.reply(q.gate, [{ selected: ["SQLite"] }, { selected: ["Auth"] }]), true);
    assert.deepEqual(await question, [{ selected: ["SQLite"] }, { selected: ["Auth"] }]);
    gates.stop();
    assert.deepEqual(await approval, { decisions: { w1: false }, outcome: "gone" });
});

test("an expired question resolves unanswered, on the turn stream and to the devices", async () => {
    const resolved: string[] = [];
    const lines: string[] = [];
    const gates = new Gates({ log: (msg) => void lines.push(msg), onResolve: (g) => void resolved.push(g.outcome) });
    const emitted: Record<string, unknown>[] = [];
    const answers = await gates.askOwner(
        { agent: "toto", session: null, deadline: Date.now() - 1, emit: (ev) => void emitted.push(ev) },
        QUESTIONS,
    );
    assert.equal(answers, null);
    assert.deepEqual(emitted.map((e) => e["type"]), ["question_required", "log", "question_resolved"]);
    assert.deepEqual(emitted[0]?.["questions"], QUESTIONS);
    assert.equal(emitted[2]?.["outcome"], "expired");
    assert.equal(emitted[2]?.["answers"], null);
    assert.deepEqual(resolved, ["expired"]);
    assert.ok(lines.some((l) => /expired in toto — the owner did not answer/.test(l)));
});

test("ask_owner parks the turn on a gate the Inbox lists, and the owner's picks resume it", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        await connected(env);
        const events = await env.stream("GET", "/api/events");
        await waitFor(() => events.lines.some((e) => e["type"] === "ready"), 4000, "the stream opened");
        const id = (await env.api<{ id: number }>("POST", "/api/agents/toto/conversations")).json.id;
        env.model.nextTurn(callTurn([{ id: "q1", name: "ask_owner", args: JSON.stringify(ASK) }]));
        env.model.nextTurn(textTurn("going with SQLite"));

        const turn = await env.stream("POST", `/api/agents/toto/conversations/${id}/messages`, { text: "set it up" });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the question gate");

        const listed = await env.api<{ approvals: Row[] }>("GET", "/api/approvals");
        assert.equal(listed.text.includes("Which database"), false, "the listing carries no question text");
        const row = listed.json.approvals[0]!;
        assert.equal(listed.json.approvals.length, 1);
        assert.equal(row.kind, "question");
        assert.equal(row.agent, "toto");
        assert.equal(row.conversation, id);
        assert.equal(row.tool, "ask_owner");
        assert.equal(row.label, "toto asks you 2 questions");
        assert.deepEqual(row.actions, []);
        assert.ok(row.deadline > Date.now() + 11 * 3_600_000);

        const card = await env.api<Row & { questions: OwnerQuestion[] }>("GET", `/api/approvals/${row.gate}`);
        assert.deepEqual(card.json.questions, QUESTIONS);
        await waitFor(() => turn.lines.some((e) => e["type"] === "question_required"), 4000, "the card on the turn stream");
        const required = turn.lines.find((e) => e["type"] === "question_required");
        assert.equal(required?.["gate"], row.gate);
        assert.deepEqual(required?.["questions"], QUESTIONS);
        const parked = events.lines.find((e) => e["type"] === "approval");
        assert.equal(parked?.["kind"], "question");
        assert.equal(parked?.["tool"], "ask_owner");

        const answered = await env.api("POST", `/api/approvals/${row.gate}/reply`, {
            answers: [{ selected: ["SQLite"] }, { selected: ["Audit", "Auth"], other: "and logs" }],
        });
        assert.deepEqual(answered.json, { ok: true });
        await turn.done;

        const text = "The owner answered.\nQ: Which database?\nA: SQLite\nQ: Which features?\nA: Auth, Audit\nIn their own words: and logs";
        assert.equal(turn.lines.find((e) => e["type"] === "tool_result" && e["id"] === "q1")?.["text"], text);
        const sent = env.model.requests[1]?.["messages"] as Message[];
        assert.equal(sent.find((m) => m.role === "tool")?.content, text, "the model reads exactly that");
        const settled = turn.lines.find((e) => e["type"] === "question_resolved");
        assert.equal(settled?.["outcome"], "answered");
        assert.deepEqual(settled?.["answers"], [{ selected: ["SQLite"] }, { selected: ["Auth", "Audit"], other: "and logs" }]);
        await waitFor(() => events.lines.some((e) => e["type"] === "approval_resolved"), 4000, "the fanout");
        assert.equal(events.lines.find((e) => e["type"] === "approval_resolved")?.["outcome"], "answered");
        assert.deepEqual((await env.api("GET", "/api/approvals")).json, { approvals: [] });
        events.close();
    } finally {
        await env.stop();
    }
});

test("the reply route checks every answer against the gate's own options, and only a paired device may send it", async () => {
    const env = await boot();
    try {
        const h = await connected(env);
        const { turn, result } = asking(env, h, ASK);
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the question gate");
        const gate = env.core.approvals.pending()[0]!.gate;

        const refused: Array<[unknown, RegExp]> = [
            [{ answers: [{ selected: ["MySQL"] }, { selected: ["Auth"] }] }, /"MySQL" is not an option of this question/],
            [{ answers: [{ selected: ["Postgres", "SQLite"] }, { selected: ["Auth"] }] }, /takes a single pick/],
            [{ answers: [{ selected: ["Postgres"], other: "maybe" }, { selected: ["Auth"] }] }, /no answer in the owner's own words/],
            [{ answers: [{ selected: ["Postgres"] }] }, /one per question/],
            [{}, /one per question/],
            [{ dismiss: false }, /^pass \{ answers \} or \{ dismiss: true \}$/],
            [{ dismiss: true, answers: [] }, /^pass \{ answers \} or \{ dismiss: true \}$/],
        ];
        for (const [body, why] of refused) {
            const reply = await env.api<{ error: string }>("POST", `/api/approvals/${gate}/reply`, body);
            assert.equal(reply.status, 400, JSON.stringify(body));
            assert.match(reply.json.error, why);
        }

        const viaDecisions = await env.api<{ error: string }>("POST", `/api/approvals/${gate}/answer`, { decisions: {} });
        assert.equal(viaDecisions.status, 409);
        assert.match(viaDecisions.json.error, /is a question/);

        // off the tunnel nobody speaks for the owner
        let status = 0;
        const res = { writeHead: (code: number) => void (status = code), end: () => undefined } as unknown as ServerResponse;
        const req = { method: "POST", url: `/api/approvals/${gate}/reply` } as unknown as IncomingMessage;
        assert.equal(await buildRouter(env.core).dispatch(req, res, null), true);
        assert.equal(status, 403);
        assert.equal(env.core.approvals.pending().length, 1, "nothing refused settled the gate");

        const ok = await env.api("POST", `/api/approvals/${gate}/reply`, { answers: [{ selected: ["Postgres"] }, { selected: [], other: "just auth" }] });
        assert.equal(ok.status, 200);
        await turn;
        assert.equal(result(), "The owner answered.\nQ: Which database?\nA: Postgres\nQ: Which features?\nA: none of the options\nIn their own words: just auth");
        const late = await env.api<{ outcome: string }>("POST", `/api/approvals/${gate}/reply`, { dismiss: true });
        assert.equal(late.status, 409);
        assert.equal(late.json.outcome, "gone");

        h.send({ id: "k1", type: "ask_approve", payload: { label: "wire 40 EUR" } });
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "an approval gate");
        const approval = env.core.approvals.pending()[0]!.gate;
        const wrongKind = await env.api<{ error: string }>("POST", `/api/approvals/${approval}/reply`, { dismiss: true });
        assert.equal(wrongKind.status, 409);
        assert.match(wrongKind.json.error, /is an approval/);
        env.core.approvals.answer(approval, {});
    } finally {
        await env.stop();
    }
});

test("a dismissed question ends the wait: the agent hears the owner did not answer", async () => {
    const env = await boot();
    try {
        const h = await connected(env);
        const { turn, emitted, hub, result } = asking(env, h, ASK);
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the question gate");
        const gate = env.core.approvals.pending()[0]!.gate;
        assert.deepEqual((await env.api("POST", `/api/approvals/${gate}/reply`, { dismiss: true })).json, { ok: true });
        await turn;
        assert.match(result() ?? "", UNANSWERED);
        const settled = emitted.find((e) => e["type"] === "question_resolved");
        assert.equal(settled?.["outcome"], "dismissed");
        assert.equal(settled?.["answers"], null);
        assert.equal(hub.find((e) => e.type === "approval_resolved")?.["outcome"], "dismissed");
    } finally {
        await env.stop();
    }
});

test("an unanswered question expires and the turn goes on without it", async () => {
    const env = await boot({ questionTimeoutMs: 50 });
    try {
        const h = await connected(env);
        const { turn, emitted, hub, result } = asking(env, h, ASK);
        await turn;
        assert.match(result() ?? "", UNANSWERED);
        assert.equal(emitted.find((e) => e["type"] === "question_resolved")?.["outcome"], "expired");
        assert.equal(hub.find((e) => e.type === "approval_resolved")?.["outcome"], "expired");
        assert.ok(env.logs.some((l) => /expired in toto — the owner did not answer/.test(l)));
        assert.equal(env.core.approvals.pending().length, 0);
    } finally {
        await env.stop();
    }
});

test("stopping the turn retires its question as gone", async () => {
    const env = await boot();
    try {
        const h = await connected(env);
        const { turn, hub, result } = asking(env, h, ASK);
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "the question gate");
        env.core.turns.forAgent("toto")[0]?.stop();
        await turn;
        assert.equal(env.core.approvals.pending().length, 0);
        assert.equal(hub.find((e) => e.type === "approval_resolved")?.["outcome"], "gone");
        assert.equal(result(), "Skipped: stopped by user.");
    } finally {
        await env.stop();
    }
});

test("a chain stopped mid-step parks no question after the stop", async () => {
    const env = await boot();
    let release = (): void => undefined;
    try {
        let reading = false;
        await env.connect({
            name: "mate",
            manifest: { a2a: { commands: ["read_thing"] } },
            tools: [{ name: "read_thing", writes: false, parameters: { type: "object", properties: {} } }],
            handlers: {
                read_thing: () => {
                    reading = true;
                    return new Promise((resolve) => (release = () => resolve({ text: "late" })));
                },
            },
        });
        const h = await env.connect({ name: "toto", manifest: { chain: true } });
        await waitFor(() => env.core.registry.get("toto") !== undefined && env.core.registry.get("mate") !== undefined, 4000, "registration");
        const steps = [{ tool: "a2a_mate", args: { command: "read_thing" } }, { tool: "ask_owner", args: ASK }];
        env.model.nextTurn(callTurn([{ id: "c1", name: "chain", args: JSON.stringify({ steps }) }]));
        env.model.nextTurn(textTurn("never reached"));
        const emitted: Record<string, unknown>[] = [];
        const turn = env.core.runTurn({
            agent: "toto",
            session: h.createSession(),
            text: "go",
            attended: true,
            title: false,
            emit: (ev) => void emitted.push(ev),
        });
        await waitFor(() => reading, 4000, "step 0 in flight");
        env.core.turns.forAgent("toto")[0]?.stop();
        assert.equal((await turn).text, "Stopped by user before completion.");
        assert.deepEqual(env.core.approvals.pending(), []);
        const chained = emitted.find((e) => e["type"] === "tool_result" && e["id"] === "c1")?.["text"];
        assert.match(String(chained), /\[1\] ask_owner → FAILED: stopped by user\n\nChain stopped at step 1\.$/);
    } finally {
        release();
        await env.stop();
    }
});

test("nothing parks for arguments off the schema, or in a run nobody attends", async () => {
    const env = await boot();
    try {
        const h = await connected(env);
        const bad = asking(env, h, { questions: [{ question: "Go?", options: [{ label: "Yes" }, { label: "yes" }] }] });
        await bad.turn;
        assert.equal(bad.result(), 'Error: questions[0].options[1].label "yes" repeats another option\'s label. Fix the arguments and call again.');

        const unattended = asking(env, h, ASK, false);
        await unattended.turn;
        assert.match(unattended.result() ?? "", /^Nobody can answer in this run, so the owner did not answer/);
        assert.equal([...bad.hub, ...unattended.hub].some((e) => e.type === "approval"), false, "no gate was parked");
    } finally {
        await env.stop();
    }
});

test("an agent named owner never takes the ask_owner name", async () => {
    const env = await boot();
    try {
        const h = await connected(env);
        env.pin("owner");
        await asking(env, h, { questions: [] }).turn;
        const tools = env.model.requests[0]?.["tools"] as Array<{ function: { name: string; description?: string } }>;
        const offered = tools.filter((t) => t.function.name === "ask_owner");
        assert.equal(offered.length, 1);
        assert.match(offered[0]?.function.description ?? "", /^Ask the owner, the person you work for/);
        assert.deepEqual(gatewayToolNames(env.core.registry, "toto", false), ["get_time", "done", "ask_owner"]);
    } finally {
        await env.stop();
    }
});
