/** GET /api/agents/:agent/describe: what the gateway made of an agent's describe, what it dropped and why, and which model a turn gets. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { definePack, defineTool, runAgent } from "@mimi-os/sdk";
import { fakeAgentSocket, fakeIdentity } from "@mimi-os/sdk/testing";

import { boot, waitFor } from "./harness-env.ts";

interface Described {
    connected: boolean;
    manifest: { name: string; model?: string };
    tools: Array<{ name: string; description?: string }>;
    prompt: Array<{ name: string; text: string }> | null;
    app: unknown;
    bytes: number | null;
    dropped: Array<{ kind: string; name?: string; reason: string }>;
    gatewayTools: string[];
    lastError: string | null;
    packsDisabled: Array<{ name: string; missing: string[] }>;
    model: { asked: string | null; runsOn: string | null; ok: boolean; reason?: string };
}

test("describe route: a real SDK agent's tools, live prompt, drops, disabled packs, last error and model", async () => {
    const env = await boot();
    const dir = mkdtempSync(join(tmpdir(), "mimi-describe-"));
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "notes" }));
    writeFileSync(join(dir, "prompt.md"), "You are Notes.\n");
    const identity = fakeIdentity();
    env.pin("notes", identity.pubkey);
    const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
    const agent = await runAgent({
        dir,
        model: "qwen-lan",
        url: `${env.ws}/channel`,
        socket: (url) => fakeAgentSocket(url, identity, env.core.devices.gatewayPub),
        log: () => undefined,
        tools: [
            defineTool("notes_add", "x".repeat(4100), schema, () => "Saved.", { writes: true }),
            defineTool("done", "Mark a note done.", schema, () => "Done."),
        ],
        app: { title: "Notes", upstream: "http://10.9.9.9:8080" },
        packs: [
            definePack({ name: "calendar", env: ["GOOGLE_CALENDAR_KEY"], tools: [] }),
            definePack({
                name: "broken",
                tools: [],
                prompt: () => {
                    throw new Error("boom");
                },
            }),
        ],
    });
    const describe = async (): Promise<Described> => {
        const reply = await env.api<Described>("GET", "/api/agents/notes/describe");
        assert.equal(reply.status, 200);
        return reply.json;
    };
    try {
        await waitFor(() => env.core.agent("notes").connected && agent.client.connected, 4000, "the agent registered");

        const live = await describe();
        assert.equal(live.connected, true);
        assert.equal(live.manifest.model, "qwen-lan");
        assert.deepEqual(live.tools.map((t) => t.name).sort(), ["done", "notes_add", "notify_user"]);
        assert.equal(live.tools.find((t) => t.name === "notes_add")?.description?.length, 4000);
        assert.deepEqual(live.prompt, [{ name: "persona", text: "You are Notes." }]);
        assert.equal(live.app, null);
        assert.ok(live.bytes !== null && live.bytes > 4100 && live.bytes < 6000, `bytes ${live.bytes}`);
        assert.deepEqual(live.dropped, [
            { kind: "tool", name: "notes_add", reason: "description cut to 4000 chars" },
            { kind: "app", name: "Notes", reason: "upstream host 10.9.9.9 is not the address this agent connected from" },
            { kind: "tool", name: "done", reason: "a gateway tool of the same name takes its place" },
        ]);
        assert.deepEqual(live.packsDisabled, [{ name: "calendar", missing: ["GOOGLE_CALENDAR_KEY"] }]);
        assert.deepEqual(live.gatewayTools, ["get_time", "done", "ask_owner"]);
        assert.match(live.lastError ?? "", /pack broken: prompt\(\) failed — boom/);
        assert.equal(live.model.ok, false);
        assert.equal(live.model.asked, "qwen-lan");
        assert.equal(live.model.runsOn, null);
        assert.match(live.model.reason ?? "", /Unknown model "qwen-lan"/);

        const policy = await env.api("PATCH", "/api/agents/notes/models", { primary: "fake" });
        assert.equal(policy.status, 200);
        assert.deepEqual((await describe()).model, { asked: "qwen-lan", runsOn: "fake", ok: true });

        await agent.stop();
        await waitFor(() => !env.core.agent("notes").connected, 4000, "the agent gone");
        const offline = await describe();
        assert.equal(offline.connected, false);
        assert.deepEqual(offline.tools.map((t) => t.name).sort(), ["done", "notes_add", "notify_user"]);
        assert.deepEqual(
            [offline.prompt, offline.app, offline.bytes, offline.lastError, offline.packsDisabled],
            [null, null, null, null, []],
        );
        assert.deepEqual(offline.dropped.map((d) => d.name), ["done"]);

        const ghost = await env.api<{ error: string }>("GET", "/api/agents/ghost/describe");
        assert.equal(ghost.status, 404);
    } finally {
        await agent.stop();
        await env.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("describe route: every part the gateway leaves out of a describe on the wire is named with its reason", async () => {
    const env = await boot();
    try {
        const h = await env.connect({ name: "raw", tools: [{ name: "keep", writes: false }] });
        await waitFor(() => env.core.agent("raw").connected, 4000, "raw ready");
        h.send({
            id: "d2",
            type: "describe",
            payload: {
                manifest: { name: "raw", description: "two\nlines", chain: true, a2a: { commands: ["keep", "a2a_x", "ghost"] } },
                prompt: [{ name: "persona", text: "hi" }, { name: "empty", text: "" }],
                tools: [
                    { name: "keep", writes: false },
                    { name: "loose", writes: false, parameters: "nope" },
                    { description: "no name" },
                    { name: "chain", writes: false },
                ],
                app: { upstream: "http://127.0.0.1:1" },
                packsDisabled: [{ name: "mail", missing: ["IMAP_HOST", 7] }, { missing: [] }],
            },
        });
        await waitFor(() => h.frames().some((f) => f["id"] === "d2"), 4000, "the describe_ok");
        const described = await env.api<Described>("GET", "/api/agents/raw/describe");
        assert.deepEqual(described.json.dropped, [
            { kind: "manifest", name: "description", reason: "not one line of at most 300 chars" },
            { kind: "tool", name: "loose", reason: "parameters is not an object, so the tool takes none" },
            { kind: "tool", reason: "no name" },
            { kind: "a2a", name: "a2a_x", reason: 'the "a2a_" prefix is reserved' },
            { kind: "a2a", name: "ghost", reason: "names no described tool" },
            { kind: "prompt", name: "empty", reason: "no text" },
            { kind: "app", reason: "no title" },
            { kind: "tool", name: "chain", reason: "a gateway tool of the same name takes its place" },
        ]);
        assert.deepEqual(described.json.packsDisabled, [{ name: "mail", missing: ["IMAP_HOST"] }]);
        assert.deepEqual(described.json.prompt, [{ name: "persona", text: "hi" }]);
    } finally {
        await env.stop();
    }
});
