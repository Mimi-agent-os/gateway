/** The registry: describe validation and bounds, the handshake clocks, replaced sockets, and what a re-describe stores and wakes. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test, { type TestContext } from "node:test";

import { allPerms, type DescribePayload, type HealthOkPayload } from "@mimi-os/protocol";

import { EventHub } from "../src/events.ts";
import type { AgentSocket } from "../src/registry/peer.ts";
import { Registry, type RegistryOptions } from "../src/registry/registry.ts";
import { GatewayDb } from "../src/store/db.ts";
import { systemPrompt } from "../src/turn/prompt.ts";
import { boot, waitFor } from "./harness-env.ts";

function socket(): { adapter: AgentSocket; sent: Array<Record<string, unknown>> } {
    const sent: Array<Record<string, unknown>> = [];
    return {
        adapter: {
            open: true,
            send: (text) => void sent.push(JSON.parse(text) as Record<string, unknown>),
            close: () => undefined,
            openAppStream: () => null,
            onmessage: null,
            onclose: null,
            onerror: null,
        },
        sent,
    };
}

/** A registry over a fresh db with an approved pin per name; `describe` is a hello then that describe on a new socket. */
function setup(t: TestContext, names = ["toto"], opts: Partial<RegistryOptions> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "mimi-registry-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    for (const name of names) {
        db.createPin({ name, pubkey: `key-${name}`, fingerprint: `fp-${name}`, status: "approved", perms: allPerms() });
    }
    const registry = new Registry({ db, events: new EventHub(), grants: () => [], ...opts });
    t.after(() => {
        registry.stop();
        db.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const describe = async (payload: Record<string, unknown>, name = "toto", from: string | null = null) => {
        const wire = socket();
        const peer = registry.accept(wire.adapter, name, from);
        wire.adapter.onmessage?.(JSON.stringify({ id: "h", type: "hello", payload: { agent: name } }));
        await nextTurn();
        wire.adapter.onmessage?.(JSON.stringify({ id: "d", type: "describe", payload }));
        await nextTurn();
        return { wire, peer, status: wire.sent.at(-1)?.["status"] };
    };
    return { db, registry, describe };
}

const manifest = { name: "toto", chain: false };

test("a describe failure does not publish a half-initialized peer", async (t) => {
    const { registry, describe } = setup(t, ["toto"], {
        grants: () => {
            throw new Error("model policy unavailable");
        },
    });
    const { peer, status } = await describe({ manifest });
    assert.equal(status, "error");
    assert.equal(peer.stage, "helloed");
    assert.equal(peer.describe, null);
    assert.equal(registry.get("toto"), undefined);
});

test("malformed request payloads never cross the registry hook boundary", async (t) => {
    const { registry, describe } = setup(t);
    let calls = 0;
    registry.hooks = {
        chat: async () => {
            calls++;
            return { text: "", thinking: "", toolCalls: [], finishReason: "stop" };
        },
        askApprove: async () => {
            calls++;
            return { approved: false };
        },
        a2aCall: async () => {
            calls++;
            return { result: { text: "" } };
        },
        changed: () => calls++,
        notify: () => calls++,
    };
    const { wire } = await describe({ manifest });
    wire.adapter.onmessage?.(JSON.stringify({ id: "c", type: "chat", payload: null }));
    wire.adapter.onmessage?.(JSON.stringify({ id: "n", type: "notify", payload: { title: "x", target: null } }));
    wire.adapter.onmessage?.(JSON.stringify({ id: "s", type: "session_changed", payload: null }));
    await nextTurn();

    assert.equal(calls, 0);
    assert.equal(wire.sent.find((f) => f["id"] === "c")?.["status"], "error");
});

test("a later authoritative describe removes an app the agent no longer declares", async (t) => {
    const { db, describe } = setup(t);
    assert.equal((await describe({ manifest, app: { title: "Orders", upstream: "http://127.0.0.1:3377" } })).status, "ok");
    assert.ok(db.getAgentApp("toto", "toto"));

    assert.equal((await describe({ manifest: null })).status, "error");
    assert.ok(db.getAgentApp("toto", "toto"));

    assert.equal((await describe({ manifest })).status, "ok");
    assert.equal(db.getAgentApp("toto", "toto"), null);
});

test("describe bounds tool and a2a command counts, tool name and description lengths", async (t) => {
    const { registry, describe } = setup(t);
    const many = Array.from({ length: 5_000 }, (_, i) => ({ name: `t${i}`, writes: false }));

    // the last command names a tool that survives the cap, so only the command cap can drop it
    const commands = [...Array.from({ length: 4_999 }, (_, i) => `u${i}`), "t0"];
    assert.equal((await describe({ manifest: { ...manifest, a2a: { commands } }, tools: many })).status, "ok");
    const capped = registry.info("toto");
    assert.equal(capped.tools.length, 128);
    assert.equal(capped.tools[0]?.name, "t0");
    assert.equal(capped.manifest?.a2a, undefined);

    const tools = [
        { name: "t0", writes: false, description: "d".repeat(5_000) },
        { name: "x".repeat(129), writes: false },
    ];
    assert.equal((await describe({ manifest: { ...manifest, a2a: { commands: ["t0"] } }, tools })).status, "ok");
    const kept = registry.info("toto");
    assert.deepEqual(kept.manifest?.a2a, { commands: ["t0"] });
    assert.equal(kept.tools.length, 1);
    assert.equal(kept.tools[0]?.description?.length, 4_000);
});

test("describe carries a2a.commands through validation, dropping reserved and unmounted names", async (t) => {
    const { registry, describe } = setup(t);
    const { wire } = await describe({
        manifest: { ...manifest, a2a: { commands: ["read_thing", "a2a_sneaky", "never_mounted"] } },
        prompt: [],
        tools: [
            { name: "read_thing", writes: false },
            { name: "a2a_sneaky", writes: false },
        ],
    });
    assert.deepEqual(wire.sent.map((f) => f["type"]), ["hello_ok", "describe_ok"]);
    assert.deepEqual(registry.info("toto").manifest?.a2a, { commands: ["read_thing"] });
});

test("describe keeps a one-line description of at most 300 chars in the registry row, and drops any other", async (t) => {
    const { db, registry, describe } = setup(t);
    const stored = async (description: unknown): Promise<unknown> => {
        assert.equal((await describe({ manifest: { ...manifest, description } })).status, "ok", "a bad description never refuses the describe");
        const row = db.getAgentRegistry("toto")?.describe as { manifest: { description?: string } };
        assert.equal(registry.info("toto").manifest?.description, row.manifest.description);
        return row.manifest.description;
    };

    assert.equal(await stored("  Keeps a reading list.  "), "Keeps a reading list.");
    assert.equal(await stored("d".repeat(300)), "d".repeat(300));
    assert.equal(await stored("d".repeat(301)), undefined);
    assert.equal(await stored("two\nlines"), undefined);
    assert.equal(await stored("carriage\rreturn"), undefined);
    assert.equal(await stored("line separator"), undefined);
    assert.equal(await stored("Plans the week.\n"), "Plans the week.");
    assert.equal(await stored("   "), undefined);
    assert.equal(await stored(42), undefined);
});

test("describe refuses an over-long model, an oversized allowedTools or budgets, and too many prompt parts", async (t) => {
    const { registry, describe } = setup(t);
    const status = async (extra: Record<string, unknown>, rest: Record<string, unknown> = {}): Promise<unknown> =>
        (await describe({ manifest: { ...manifest, ...extra }, ...rest })).status;
    const tools = (n: number, len = 8): string[] => Array.from({ length: n }, (_, i) => `${i}`.padStart(len, "t"));
    const parts = (n: number): Array<{ name: string; text: string }> => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, text: "x" }));
    const budgets = (names: string[]): Record<string, number> => Object.fromEntries(names.map((name) => [name, 1]));

    assert.equal(await status({ model: "m".repeat(200) }), "ok");
    assert.equal(await status({ model: "m".repeat(201) }), "error");
    assert.equal(await status({ policy: { allowedTools: tools(256, 128) } }), "ok");
    assert.equal(await status({ policy: { allowedTools: tools(257) } }), "error");
    assert.equal(await status({ policy: { allowedTools: ["t".repeat(129)] } }), "error");
    assert.equal(await status({ policy: { budgets: budgets(tools(256, 128)) } }), "ok");
    assert.equal(await status({ policy: { budgets: budgets(tools(257)) } }), "error");
    assert.equal(await status({ policy: { budgets: budgets(["t".repeat(129)]) } }), "error");
    assert.equal(await status({}, { prompt: parts(64) }), "ok");
    assert.equal(await status({}, { prompt: parts(65) }), "error");
    assert.equal(registry.get("toto")?.describe?.prompt.length, 64, "a refused describe leaves the last accepted one in place");
});

test("an app upstream is only the agent's own address: loopback locally, the connecting address remotely", async (t) => {
    const { db, describe } = setup(t, ["local", "remote"]);
    const upstream = async (name: string, from: string | null, url: string): Promise<string | null> => {
        const { status } = await describe({ manifest: { name, chain: false }, app: { title: "Orders", upstream: url } }, name, from);
        assert.equal(status, "ok");
        return db.getAgentApp(name, name)?.upstream ?? null;
    };

    assert.equal(await upstream("local", "::ffff:127.0.0.1", "http://127.0.0.1:3377"), "http://127.0.0.1:3377");
    assert.equal(await upstream("local", "::ffff:127.0.0.1", "http://192.168.1.1/"), null);
    assert.equal(await upstream("local", null, "http://169.254.169.254/latest/meta-data/"), null);

    assert.equal(await upstream("remote", "::ffff:192.168.1.50", "http://192.168.1.50:3377"), "http://192.168.1.50:3377");
    assert.equal(await upstream("remote", "::ffff:192.168.1.50", "http://192.168.1.1/"), null);
    assert.equal(await upstream("remote", "::ffff:192.168.1.50", "http://127.0.0.1:46464"), null);
});

test("a refusal close reason fits the 123-byte close frame and a throwing socket never escapes the timer", async (t) => {
    const { registry } = setup(t);
    const wire = socket();
    const reasons: string[] = [];
    wire.adapter.close = (_code, reason): void => {
        reasons.push(reason ?? "");
        throw new RangeError("The message must not be greater than 123 bytes");
    };
    registry.accept(wire.adapter, "toto");
    wire.adapter.onmessage?.(JSON.stringify({ id: "h", type: "hello", payload: { agent: "€".repeat(200) } }));
    await nextTurn();
    assert.equal(wire.sent.at(-1)?.["status"], "denied");

    await waitFor(() => reasons.length === 1, 4000, "the refusal close");
    assert.ok(Buffer.byteLength(reasons[0] ?? "", "utf8") <= 123, "close reason is bounded by bytes");
});

test("a re-describe from a socket a reconnect already replaced is refused and changes nothing", async (t) => {
    const { registry, describe } = setup(t);
    const memory = (text: string) => ({ manifest, prompt: [{ name: "pack:memory", text }] });
    const stale = await describe(memory("old"));
    assert.equal(stale.status, "ok");
    assert.equal((await describe(memory("new"))).status, "ok");

    stale.wire.adapter.onmessage?.(JSON.stringify({ id: "r", type: "describe", payload: memory("stale") }));
    await nextTurn();
    assert.equal(stale.wire.sent.at(-1)?.["status"], "error");
    assert.match(String((stale.wire.sent.at(-1)?.["error"] as { message: string }).message), /replaced/);
    assert.deepEqual(registry.get("toto")?.describe?.prompt, [{ name: "pack:memory", text: "new" }]);
});

test("an agent session that never says hello is closed after 5 s, not left holding its slot for 15", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { registry } = setup(t);
    const closes: number[] = [];
    const wire = socket();
    wire.adapter.close = (code) => void closes.push(code ?? 0);
    registry.accept(wire.adapter, "toto");
    t.mock.timers.tick(4_999);
    assert.deepEqual(closes, []);
    t.mock.timers.tick(1);
    assert.deepEqual(closes, [1002]);
});

test("an agent that said hello in time may take up to 15 s to land a big describe over a thin link", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { registry } = setup(t);
    const closes: number[] = [];
    const wire = socket();
    wire.adapter.close = (code) => void closes.push(code ?? 0);
    registry.accept(wire.adapter, "toto");
    wire.adapter.onmessage?.(JSON.stringify({ id: "h", type: "hello", payload: { agent: "toto" } }));
    await nextTurn();
    t.mock.timers.tick(14_000);
    assert.deepEqual(closes, [], "still uploading its describe");
    const prompt = [{ name: "memory", text: "x".repeat(900_000) }];
    wire.adapter.onmessage?.(JSON.stringify({ id: "d", type: "describe", payload: { manifest, prompt } }));
    await nextTurn();
    assert.equal(wire.sent.at(-1)?.["status"], "ok");
    t.mock.timers.tick(1_000);
    assert.deepEqual(closes, [], "a registered agent is never timed out");
    assert.ok(registry.get("toto"));
});

test("a re-describe: a prompt change is live and stores nothing; a catalog change stores and wakes, at most 20 a minute", async () => {
    const env = await boot();
    try {
        const h = await env.connect({ name: "toto" });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        const woke: string[] = [];
        env.core.events.subscribe((ev) => {
            if (ev.type === "agent_changed") woke.push(String(ev["name"]));
        });
        let writes = 0;
        const upsert = env.db.upsertAgentRegistry.bind(env.db);
        env.db.upsertAgentRegistry = (...args) => {
            writes++;
            upsert(...args);
        };
        const logged = env.logs.length;
        const facts = (n: number): Array<{ name: string; text: string }> => [{ name: "pack:memory", text: `- fact ${n}` }];
        const tools = (n: number): Array<{ name: string; writes: boolean }> => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, writes: false }));
        const redescribe = async (id: string, fact: number, toolCount = 0): Promise<unknown> => {
            h.send({ id, type: "describe", payload: { manifest, prompt: facts(fact), tools: tools(toolCount) } });
            await waitFor(() => h.frames().some((f) => f["id"] === id), 4000, `the reply to ${id}`);
            return h.frames().find((f) => f["id"] === id)?.["status"];
        };
        const live = (): string => systemPrompt(env.core.registry.get("toto")!).content ?? "";

        assert.equal(await redescribe("p1", 1), "ok");
        assert.equal(await redescribe("p2", 2), "ok");
        assert.match(live(), /- fact 2/, "the next turn is prompted with the latest describe");
        assert.equal(writes, 0, "a prompt change is never stored");
        assert.deepEqual(woke, [], "and wakes no device");

        for (let n = 1; n <= 20; n++) assert.equal(await redescribe(`t${n}`, 2, n), "ok");
        assert.equal(writes, 20);
        assert.equal(woke.length, 20);
        assert.equal(await redescribe("t21", 2, 21), "ok", "over budget is not a refusal");
        assert.equal(writes, 20, "over budget writes nothing");
        assert.equal(woke.length, 20, "and wakes nobody");
        assert.equal(env.core.registry.get("toto")?.describe?.tools.length, 21, "yet the live describe is the latest");
        assert.equal(await redescribe("p3", 3, 21), "ok");
        assert.match(live(), /- fact 3/, "a prompt change is never metered");
        assert.deepEqual(env.logs.slice(logged).filter((l) => l.startsWith("[registry]")), [], "a refresh is not a reconnect");

        h.close();
        await waitFor(() => !env.core.agent("toto").connected, 4000, "the disconnect");
        const stored = env.db.getAgentRegistry("toto")?.describe as Record<string, unknown>;
        assert.deepEqual(Object.keys(stored).sort(), ["manifest", "tools"], "the stored row holds the catalog, never the prompt");
        assert.equal((stored["tools"] as unknown[]).length, 21, "the row catches up when the socket goes");
        assert.equal(woke.at(-1), "toto");
    } finally {
        await env.stop();
    }
});

for (const outcome of ["reply", "error"] as const) {
    test(`a replaced peer's late health ${outcome} cannot overwrite its successor`, async (t) => {
        const env = await boot();
        t.after(() => env.stop());
        await env.connect({ name: "worker" });
        await waitFor(() => env.core.agent("worker").connected);
        const first = env.core.registry.get("worker")!;
        const probe = Promise.withResolvers<HealthOkPayload>();
        t.mock.method(first, "request", () => probe.promise);
        const polling = env.core.registry.poll();

        await env.connect({ name: "worker" });
        // the channel drops the old session at the new handshake, so the successor registers a beat later
        await waitFor(() => ![undefined, first].includes(env.core.registry.get("worker")));
        await env.core.registry.poll();
        const current = env.core.agent("worker").health;
        assert.ok(current);

        if (outcome === "reply") probe.resolve({ uptimeMs: 999, sessions: 999 });
        else probe.reject(new Error("old connection failed"));
        await polling;
        assert.deepEqual(env.core.agent("worker").health, current);
        assert.equal(env.core.agent("worker").healthError, null);
    });
}

test("a replaced peer's close cannot restore its old persisted manifest", async (t) => {
    const env = await boot();
    t.after(() => env.stop());
    await env.connect({ name: "worker", manifest: { model: "old-model" } });
    await waitFor(() => env.core.agent("worker").connected);
    const first = env.core.registry.get("worker")!;
    await env.connect({ name: "worker", manifest: { model: "new-model" } });
    await waitFor(() => ![undefined, first].includes(env.core.registry.get("worker")));
    first.onClosed?.(first);
    const stored = env.db.getAgentRegistry("worker")?.describe as DescribePayload;
    assert.equal(stored.manifest.model, "new-model");
});
