/** A real runAgent against the real gateway: what the SDK describes is what the roster serves and the model is prompted with. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { definePack, defineTool, runAgent, type AgentRuntime, type PackRuntime } from "@mimi-os/sdk";
import { fakeAgentSocket, fakeIdentity } from "@mimi-os/sdk/testing";

import type { HubEvent } from "../src/events.ts";
import { boot, callTurn, textTurn, waitFor, type Env } from "./harness-env.ts";

/** agent.json + prompt.md in a fresh folder, pinned approved, booted through the SDK's own runAgent. */
async function toto(env: Env, facts: string[]): Promise<{ agent: AgentRuntime; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), "mimi-agent-"));
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "toto", description: "  Keeps the owner's notes.  " }));
    writeFileSync(join(dir, "prompt.md"), "You are Toto.\n");
    const identity = fakeIdentity();
    env.pin("toto", identity.pubkey);
    // the shape of the memory pack: a writes:false tool that changes what prompt() returns, then calls redescribe()
    let rt: PackRuntime | undefined;
    const note = defineTool(
        "note",
        "Keep one fact.",
        { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
        (args) => {
            facts.push(`- ${String(args["fact"])}`);
            rt?.redescribe();
            return "Noted.";
        },
    );
    const notes = definePack({
        name: "notes",
        tools: [note],
        prompt: () => facts.join("\n"),
        mount: (r) => {
            rt = r;
        },
    });
    const agent = await runAgent({
        dir,
        url: `${env.ws}/channel`,
        socket: (url) => fakeAgentSocket(url, identity, env.core.devices.gatewayPub),
        log: () => undefined,
        packs: [notes],
    });
    // both ends: the gateway marks the peer connected a beat before the SDK reads its describe reply and may push
    await waitFor(() => env.core.agent("toto").connected && agent.client.connected, 4000, "the agent registered");
    return { agent, dir };
}

test("runAgent: agent.json's description reaches the roster, and a pack's redescribe reaches the very next model round", async () => {
    const env = await boot();
    const { agent, dir } = await toto(env, ["- The owner has a cat."]);
    try {
        const row = (await env.api<Array<{ name: string; description?: string }>>("GET", "/api/agents")).json
            .find((r) => r.name === "toto");
        assert.equal(row?.description, "Keeps the owner's notes.");

        const sid = (await env.api<{ id: number }>("POST", "/api/agents/toto/conversations")).json.id;
        env.model.nextTurn(callTurn([{ id: "n1", name: "note", args: JSON.stringify({ fact: "The cat is called Miso." }) }]));
        env.model.nextTurn(textTurn("Noted."));
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "the cat is Miso", title: false });
        assert.equal(out.text, "Noted.");
        assert.equal(env.core.approvals.pending().length, 0, "a writes:false pack tool never parks a card");

        const systems = env.model.requests.map((r) => (r["messages"] as Array<{ role: string; content: string }>)[0]!);
        assert.equal(systems.length, 2);
        assert.ok(systems.every((m) => m.role === "system"));
        assert.match(systems[0]!.content, /^You are Toto\.\n\n- The owner has a cat\.\n\nCurrent date\/time: /);
        assert.match(systems[1]!.content, /^You are Toto\.\n\n- The owner has a cat\.\n- The cat is called Miso\.\n\nCurrent date\/time: /);
    } finally {
        await agent.stop();
        await env.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("runAgent: a burst of more remembered facts than the re-describe budget still reaches the very next model round", async () => {
    const env = await boot();
    const { agent, dir } = await toto(env, []);
    try {
        const sid = (await env.api<{ id: number }>("POST", "/api/agents/toto/conversations")).json.id;
        const calls = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, name: "note", args: JSON.stringify({ fact: `Fact ${i}.` }) }));
        env.model.nextTurn(callTurn(calls));
        env.model.nextTurn(textTurn("Noted all of them."));
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "remember these", title: false });
        assert.equal(out.text, "Noted all of them.");
        const system = (env.model.requests.at(-1)!["messages"] as Array<{ content: string }>)[0]!.content;
        const missing = calls.map((_, i) => `- Fact ${i}.`).filter((fact) => !system.includes(fact));
        assert.deepEqual(missing, [], "every fact, the 21st on included");
    } finally {
        await agent.stop();
        await env.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("runAgent: the agent's own write to a chat, past the gateway, reaches /api/events as chat_changed", async () => {
    const env = await boot();
    const { agent, dir } = await toto(env, []);
    try {
        const seen: HubEvent[] = [];
        env.core.events.subscribe((ev) => {
            if (ev.type === "chat_changed") seen.push(ev);
        });
        // a cron's shape: the agent's code opens a chat and writes to it, the gateway runs no turn
        const sid = agent.chat.createSession({ title: "Reminders", titleByUser: true });
        agent.chat.append(sid, { type: "message", payload: { role: "assistant", content: "Water the plants." } });
        await waitFor(() => seen.length > 0, 4000, "the push");
        assert.deepEqual(seen, [{ type: "chat_changed", agent: "toto", session: sid }]);
    } finally {
        await agent.stop();
        await env.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});
