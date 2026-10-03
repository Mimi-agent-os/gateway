/** The peer set is the pin list, derived every round — no manifest, no wire frames. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { allPerms, noPerms } from "@mimi-os/protocol";
import type { Message, PinPerms, PinStatus } from "@mimi-os/protocol";

import { peersOf } from "../src/registry/peers.ts";
import { autoApprove, boot, callTurn, textTurn, waitFor, type Env } from "./harness-env.ts";
import type { Harness } from "./agent-harness.ts";

const ready = (env: Env, name: string): Promise<void> =>
    waitFor(() => env.core.agent(name).connected, 4000, `${name} ready`);

const offered = (req: Record<string, unknown> | undefined): string[] =>
    ((req?.["tools"] ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);

const perms = (over: Partial<PinPerms>): PinPerms => ({ ...allPerms(), ...over });

/** boss is live; the rest exist only as pins — a peer is an identity, not a socket. */
async function scene(env: Env): Promise<Harness> {
    const boss = await env.connect({
        name: "boss",
        tools: [{ name: "poke", description: "change a pin mid-round", writes: false }],
        handlers: {
            poke: (args) => {
                const name = String(args["name"]);
                const status = args["status"];
                if (args["block"] === true) env.core.registry.block(name);
                else if (typeof status === "string") {
                    // straight to the db: `block` would also close the socket under the turn
                    env.db.setPinStatus(name, status as PinStatus, noPerms());
                } else env.core.registry.setPerms(name, args["perms"] as PinPerms);
                return { text: "poked" };
            },
        },
    });
    await ready(env, "boss");
    env.pin("mate");
    env.pin("shy");
    env.core.registry.setPerms("shy", perms({ discoverable: false }));
    env.pin("banned", undefined, "blocked");
    return boss;
}

async function run(
    env: Env,
    session: number,
    calls: ReadonlyArray<{ id: string; name: string; args?: string }> = [],
): Promise<Record<string, string>> {
    if (calls.length) env.model.nextTurn(callTurn(calls));
    env.model.nextTurn(textTurn("done"));
    const results: Record<string, string> = {};
    const stop = autoApprove(env);
    try {
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
    } finally {
        stop();
    }
    return results;
}

test("peersOf: approved + discoverable pins only, never the caller itself", async () => {
    const env = await boot();
    try {
        await scene(env);
        const pins = env.core.registry.admission;
        assert.deepEqual(peersOf(pins, "boss"), ["mate"]);
        assert.deepEqual(peersOf(pins, "mate"), ["boss"]);
        assert.deepEqual(peersOf(pins, "shy"), ["boss", "mate"]);
    } finally {
        await env.stop();
    }
});

test("the toolset carries ask_ for approved discoverable peers and nobody else", async () => {
    const env = await boot();
    try {
        const boss = await scene(env);
        await run(env, boss.createSession());
        const tools = offered(env.model.requests[0]);
        assert.ok(tools.includes("ask_mate"));
        for (const gone of ["ask_boss", "ask_shy", "ask_banned"]) {
            assert.ok(!tools.includes(gone), `${gone} must not be offered`);
        }
    } finally {
        await env.stop();
    }
});

test("a caller that falls out of approved mid-turn is offered no cross-agent tools", async () => {
    const env = await boot();
    try {
        const boss = await scene(env);
        const args = JSON.stringify({ name: "boss", status: "blocked" });
        await run(env, boss.createSession(), [{ id: "p1", name: "poke", args }]);
        assert.ok(offered(env.model.requests[0]).includes("ask_mate"));
        const after = offered(env.model.requests[1]);
        assert.deepEqual(after.filter((t) => t.startsWith("ask_")), ["ask_owner"], "the owner is no cross-agent reach");
    } finally {
        await env.stop();
    }
});

test("dropping a peer's discoverable removes its tools by the NEXT round of a running turn", async () => {
    const env = await boot();
    try {
        const boss = await scene(env);
        const args = JSON.stringify({ name: "mate", perms: perms({ discoverable: false }) });
        await run(env, boss.createSession(), [{ id: "p1", name: "poke", args }]);

        const first = offered(env.model.requests[0]);
        const second = offered(env.model.requests[1]);
        assert.ok(first.includes("ask_mate"));
        assert.ok(!second.includes("ask_mate"));
    } finally {
        await env.stop();
    }
});

test("a delegated task is authored by the sending agent, never by the human it reads as", async () => {
    const env = await boot();
    try {
        const boss = await scene(env);
        const mate = await env.connect({ name: "mate" });
        await ready(env, "mate");

        env.model.nextTurn(callTurn([{ id: "a1", name: "ask_mate", args: '{"task":"count them"}' }]));
        env.model.nextTurn(textTurn("seventeen")); // mate's own turn, run inside the tool
        env.model.nextTurn(textTurn("done"));
        const stop = autoApprove(env);
        try {
            await env.core.runTurn({
                agent: "boss",
                session: boss.createSession(),
                text: "go",
                actor: { kind: "human" },
                attended: true,
                title: false,
            });
        } finally {
            stop();
        }

        const delegated = [...mate.sessions.values()].find((s) => s.title?.startsWith("←"));
        assert.ok(delegated, "the delegate got its own thread");
        const rows = delegated.events.flatMap((e) =>
            e.type === "message" ? [e.payload as Message] : [],
        );
        const task = rows.find((m) => m.content === "count them");
        // the model still reads it as `user`; the recorded author is the agent that sent it
        assert.equal(task?.role, "user");
        assert.deepEqual(task?.meta, { actor: { kind: "agent", agent: "boss" } });
        // and the delegate's own answer names itself plus the call that produced it
        const answered = rows.find((m) => m.content === "seventeen")?.meta;
        assert.deepEqual(answered?.actor, { kind: "agent", agent: "mate" });
        assert.equal(answered?.registryModel, "fake");
        assert.ok(
            env.db.listLlmCalls(50, "mate").some((c) => c.callId === answered?.callId),
            "the stamped call is a real accounting row for the delegate",
        );
    } finally {
        await env.stop();
    }
});

test("a disconnected peer keeps its tools and answers honestly when called", async () => {
    const env = await boot();
    try {
        const boss = await scene(env);
        assert.equal(env.core.registry.get("mate"), undefined);
        const results = await run(env, boss.createSession(), [
            { id: "a1", name: "ask_mate", args: '{"task":"x"}' },
        ]);
        assert.match(results["a1"] ?? "", /"mate" agent is not connected right now/);
        assert.match(results["a1"] ?? "", /nothing was sent/);
    } finally {
        await env.stop();
    }
});
