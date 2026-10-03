import "./pq-home.ts";

/** Agent keys: blocking and revoking a live key, standing perms, and the pin routes. */
import assert from "node:assert/strict";
import test from "node:test";

import { allPerms, fingerprint } from "@mimi-os/protocol";
import type { PinPerms } from "@mimi-os/protocol";
import { fakeIdentity } from "@mimi-os/sdk/testing";

import type { Harness } from "./agent-harness.ts";
import { autoApprove, boot, callTurn, textTurn, waitFor, type Env } from "./harness-env.ts";

const readyAgent = async (env: Env, name: string): Promise<void> =>
    waitFor(() => env.core.agent(name).connected, 4000, `${name} ready`);

// what the SDK's channel reports when the gateway's key lookup turns the agent away
const KEY_REFUSED = { name: "RefusedError", kind: "agent-key", message: /refused this agent's key/ };

// ── blocking and revoking a live key ─────────────────────────────────────────

test("a blocked name's key is refused at the handshake, and its live socket closed", async () => {
    const env = await boot();
    try {
        const h = await env.connect({ name: "bad" });
        await readyAgent(env, "bad");
        assert.ok(env.core.registry.block("bad"));
        await waitFor(() => !h.socketOpen(), 4000, "blocked socket closed");

        await assert.rejects(env.connect({ name: "bad" }, false), KEY_REFUSED);
        assert.equal(env.core.agent("bad").connected, false);
    } finally {
        await env.stop();
    }
});

test("a key that was never invited for a name is refused, and the name's own pin is untouched", async () => {
    const env = await boot();
    try {
        const mine = fakeIdentity();
        const theirs = fakeIdentity();
        env.pin("victim", mine.pubkey, "approved");
        await assert.rejects(env.connect({ name: "victim", identity: theirs }, false), KEY_REFUSED);
        assert.equal(env.db.getPin("victim")?.pubkey, mine.pubkey);
        assert.equal(env.core.agent("victim").connected, false);
    } finally {
        await env.stop();
    }
});

test("revoking drops the live socket, and the key finds no way back in", async () => {
    const env = await boot();
    try {
        const id = fakeIdentity();
        const h = await env.connect({ name: "rev", identity: id });
        await readyAgent(env, "rev");

        assert.equal(env.core.registry.revoke("rev"), true);
        await waitFor(() => !h.socketOpen(), 4000, "revoked socket closed");
        assert.equal(env.db.getPin("rev"), null);

        await assert.rejects(env.connect({ name: "rev", identity: id }, false), KEY_REFUSED);
        assert.equal(env.core.agent("rev").connected, false);
    } finally {
        await env.stop();
    }
});

// ── standing permissions ─────────────────────────────────────────────────────

async function twoAgents(env: Env): Promise<Harness> {
    const boss = await env.connect({
        name: "boss",
        tools: [{ name: "flip", description: "change a pin mid-round", writes: false }],
        handlers: {
            flip: (args) => {
                const name = String(args["name"]);
                if (args["block"] === true) env.core.registry.block(name);
                else env.core.registry.setPerms(name, args["perms"] as PinPerms);
                return { text: "flipped" };
            },
        },
    });
    await env.connect({ name: "helper" });
    await readyAgent(env, "boss");
    await readyAgent(env, "helper");
    return boss;
}

const runCalls = async (
    env: Env,
    session: number,
    calls: ReadonlyArray<{ id: string; name: string; args?: string }>,
): Promise<Record<string, string>> => {
    env.model.nextTurn(callTurn(calls));
    env.model.nextTurn(textTurn("done"));
    const out: Record<string, string> = {};
    const stop = autoApprove(env);
    try {
        await env.core.runTurn({
            agent: "boss",
            session,
            text: "go",
            attended: true,
            title: false,
            emit: (ev) => {
                if (ev["type"] === "tool_result") out[String(ev["id"])] = String(ev["text"]);
            },
        });
    } finally {
        stop();
    }
    return out;
};

const afterFlip = async (
    env: Env,
    session: number,
    flip: Record<string, unknown>,
    tool: string,
    args: string,
): Promise<string> =>
    (
        await runCalls(env, session, [
            { id: "f1", name: "flip", args: JSON.stringify(flip) },
            { id: "c1", name: tool, args },
        ])
    )["c1"] ?? "";

test("ask_<agent> needs the caller's delegate perm and the target's discoverable perm", async () => {
    const env = await boot();
    try {
        const boss = await twoAgents(env);
        const session = boss.createSession();
        const registry = env.core.registry;

        const noDelegate = { name: "boss", perms: { delegate: false, discoverable: true } };
        assert.match(await afterFlip(env, session, noDelegate, "ask_helper", '{"task":"x"}'), /no delegate/);

        registry.setPerms("boss", allPerms());
        const hidden = { name: "helper", perms: { delegate: true, discoverable: false } };
        assert.match(await afterFlip(env, session, hidden, "ask_helper", '{"task":"x"}'), /not discoverable/);

        registry.setPerms("helper", allPerms());
        const blocked = { name: "helper", block: true };
        assert.match(await afterFlip(env, session, blocked, "ask_helper", '{"task":"x"}'), /not approved/);
    } finally {
        await env.stop();
    }
});

// ── the device list ──────────────────────────────────────────────────────────

test("/api/pins lists an approved connected agent, narrows perms, blocks and revokes", async () => {
    const env = await boot();
    try {
        const id = fakeIdentity();
        env.pin("newbie", id.pubkey, "approved");
        const h = await env.connect({ name: "newbie", identity: id });
        await readyAgent(env, "newbie");

        const listed = await env.api<Array<Record<string, unknown>>>("GET", "/api/pins");
        assert.equal(listed.status, 200);
        const rows = listed.json;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.["name"], "newbie");
        assert.equal(rows[0]?.["status"], "approved");
        assert.equal(rows[0]?.["connected"], true);
        assert.equal(rows[0]?.["fingerprint"], fingerprint(id.pubkey));
        assert.deepEqual(rows[0]?.["perms"], allPerms());
        assert.equal(typeof rows[0]?.["lastSeen"], "string");
        assert.ok(String(rows[0]?.["lastFrom"] ?? "").length > 0);

        const narrowed = await env.api("PATCH", "/api/pins/newbie", { perms: { delegate: false } });
        assert.deepEqual((narrowed.json as Record<string, unknown>)["perms"], {
            delegate: false,
            discoverable: true,
        });

        const blocked = await env.api("POST", "/api/pins/newbie/block");
        assert.equal((blocked.json as Record<string, unknown>)["status"], "blocked");
        await waitFor(() => !h.socketOpen(), 4000, "blocked socket closed");

        const gone = await env.api("DELETE", "/api/pins/newbie");
        assert.deepEqual(gone.json, { ok: true, revoked: "newbie" });
        assert.deepEqual((await env.api("GET", "/api/pins")).json, []);
        assert.equal((await env.api("DELETE", "/api/pins/newbie")).status, 404);
    } finally {
        await env.stop();
    }
});

test("the roster and dashboard reflect an approved, connected agent's status", async () => {
    const env = await boot();
    try {
        await env.connect({ name: "toto" });
        await readyAgent(env, "toto");

        const rows = (await env.api<Array<Record<string, unknown>>>("GET", "/api/agents")).json;
        assert.equal(rows[0]?.["name"], "toto");
        assert.equal(rows[0]?.["status"], "approved");
        assert.deepEqual(rows[0]?.["perms"], allPerms());

        const dash = (await env.api<{ agents: Array<Record<string, unknown>> }>("GET", "/api/dashboard")).json;
        assert.equal(dash.agents[0]?.["status"], "approved");
        assert.equal(dash.agents[0]?.["health"], "ok");
        assert.equal(dash.agents[0]?.["why"], "");

        // a pin is approved or blocked, nothing waits for approval: the row says how to undo a block
        await env.api("POST", "/api/pins/toto/block");
        const blocked = (await env.api<{ agents: Array<Record<string, unknown>> }>("GET", "/api/dashboard")).json.agents[0];
        assert.equal(blocked?.["health"], "down", "a block closes its channel");
        assert.equal(blocked?.["why"], 'blocked — run "mimi unblock toto" on the gateway\'s machine, or revoke its pin and pair it again');
    } finally {
        await env.stop();
    }
});
