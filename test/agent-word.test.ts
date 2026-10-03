/** What a connected agent says about its own chats is its word: ids, rows, cards and enrolment are checked before the owner acts on them. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";

import type { HubEvent } from "../src/events.ts";
import { modelGrantsFor } from "../src/llm/policy.ts";
import type { AgentPeer } from "../src/registry/peer.ts";
import type { Harness } from "./agent-harness.ts";
import { pairDevice } from "../src/device-client.ts";
import { boot, waitFor, type Env } from "./harness-env.ts";

async function connected(env: Env, ...names: string[]): Promise<Harness[]> {
    const out: Harness[] = [];
    for (const name of names) {
        out.push(await env.connect({ name }));
        await waitFor(() => env.core.registry.get(name) !== undefined, 4000, `${name} registered`);
    }
    return out;
}

/** A row the lying agent keeps under any key, with any field overridden — the harness lists it as it is. */
function plant(h: Harness, id: unknown, fields: Record<string, unknown> = {}): void {
    const now = Date.now();
    const row = {
        id,
        title: "Groceries",
        titleByUser: true,
        archived: false,
        pinned: false,
        createdAt: now,
        updatedAt: now,
        revision: 0,
        headSeq: 0,
        headHash: "",
        events: [],
        ...fields,
    };
    (h.sessions as Map<unknown, unknown>).set(id, row);
}

/** The agent's `session_create` answers this head instead; every other request goes through. */
function lieOnCreate(t: TestContext, peer: AgentPeer, head: unknown): void {
    const real = peer.request.bind(peer);
    t.mock.method(peer, "request", ((type: string, payload: unknown, opts?: unknown) =>
        type === "session_create"
            ? Promise.resolve({ head })
            : (real as (...args: unknown[]) => Promise<unknown>)(type, payload, opts)) as typeof peer.request);
}

const replyTo = async (h: Harness, id: string): Promise<Record<string, unknown>> => {
    await waitFor(() => h.frames().some((f) => f["id"] === id), 4000, `the ${id} reply`);
    return h.frames().find((f) => f["id"] === id)!;
};

test("a planted chat id never reaches the list, and a dot-segment path is refused before any route matches it", async () => {
    const env = await boot();
    try {
        const [, evil] = await connected(env, "victim", "evil");
        const real = evil!.createSession("Real one", true);
        plant(evil!, "../../../pins/victim");
        plant(evil!, "../../../pins/victim/block?");

        const list = await env.api<Array<{ id: unknown }>>("GET", "/api/agents/evil/conversations");
        assert.equal(list.status, 200);
        assert.deepEqual(list.json.map((row) => row.id), [real]);
        assert.ok(env.logs.some((l) => l.includes("[chats] evil: dropped 2 session_list row(s)")));

        // the pult's row menu and chat view build these paths from a row id
        for (const [method, path] of [
            ["DELETE", "/api/agents/evil/conversations/../../../pins/victim"],
            ["POST", "/api/agents/evil/conversations/../../../pins/victim/block?/stop"],
            ["DELETE", "/api/agents/evil/conversations/%2e%2e/%2E%2E/%2e%2e/pins/victim"],
            ["DELETE", "/api/agents/evil/conversations/..\\..\\..\\pins\\victim"],
        ] as const) {
            const res = await env.api<{ error: string }>(method, path);
            assert.equal(res.status, 400, path);
            assert.match(res.json.error, /normal form/);
        }
        assert.equal(env.core.registry.pin("victim")?.status, "approved");
        assert.equal(env.core.agent("victim").connected, true);
    } finally {
        await env.stop();
    }
});

test("every session_list field is narrowed: a row off the contract is dropped and logged, the rest are served", async () => {
    const env = await boot();
    try {
        const [h] = await connected(env, "toto");
        const good = h!.createSession("Fine", true);
        plant(h!, 101, { title: { $$typeof: "x", evil: [1, 2] } });
        plant(h!, 102, { titleByUser: "yes" });
        plant(h!, 103, { archived: "no" });
        plant(h!, 104, { pinned: { a: 1 } });
        plant(h!, 105, { events: { length: -1 } });
        plant(h!, 106, { events: { length: 1.5 } });
        plant(h!, 107, { createdAt: 1e300 });
        plant(h!, 108, { updatedAt: "yesterday" });
        plant(h!, 109, { title: null, titleByUser: false });

        const list = await env.api<Array<Record<string, unknown>>>("GET", "/api/agents/toto/conversations?all=1");
        assert.equal(list.status, 200);
        assert.deepEqual(list.json.map((row) => row["id"]), [good, 109]);
        assert.deepEqual(
            list.json.map((row) => [row["title"], row["titleByUser"], row["archived"], row["pinned"], row["messages"]]),
            [["Fine", true, false, false, 0], [null, false, false, false, 0]],
        );
        assert.ok(env.logs.some((l) => l.includes("[chats] toto: dropped 8 session_list row(s)")));
    } finally {
        await env.stop();
    }
});

test("a created chat without a real id fails the create, announces nothing, and gives Discuss nothing to open", async (t) => {
    const env = await boot();
    try {
        await connected(env, "evil");
        lieOnCreate(t, env.core.registry.get("evil")!, { session: "../../../pins/victim", revision: 0, headSeq: 0, headHash: "" });
        const changed: HubEvent[] = [];
        env.core.events.subscribe((ev) => {
            if (ev.type === "chat_changed") changed.push(ev);
        });

        const made = await env.api<{ error: string }>("POST", "/api/agents/evil/conversations");
        assert.equal(made.status, 503);
        assert.match(made.json.error, /without a real chat id/);

        const item = env.db.insertInboxItem({ source: "agent", agent: "evil", title: "Report", body: "Details" });
        const discussed = await env.api("POST", `/api/inbox/${item.id}/discuss`);
        assert.equal(discussed.status, 409);
        assert.equal(env.db.getInboxItem(item.id)?.target, undefined);
        assert.deepEqual(changed, []);
    } finally {
        await env.stop();
    }
});

test("ask_approve names a real chat or none: a planted session parks no card", async () => {
    const env = await boot();
    try {
        const [h] = await connected(env, "evil");
        h!.send({ id: "a1", type: "ask_approve", payload: { label: "send 40 EUR", session: "../../../pins/victim" } });
        const reply = await replyTo(h!, "a1");
        assert.equal(reply["status"], "error");
        assert.match(String((reply["error"] as { message?: string }).message), /session must be a positive integer/);
        assert.deepEqual(env.core.approvals.pending(), []);
    } finally {
        await env.stop();
    }
});

test("a notice's chat target keeps its session only when it is a real chat id", async () => {
    const env = await boot();
    try {
        const [h] = await connected(env, "evil");
        const sid = h!.createSession();
        const cases = [["bad", 1.5], ["zero", 0], ["good", sid]] as const;
        for (const [title, session] of cases) {
            h!.send({ id: title, type: "notify", payload: { title, target: { kind: "chat", agent: "evil", session } } });
        }
        await waitFor(() => env.db.listInbox({ limit: 10 }).items.length === cases.length, 4000, "three items");
        const byTitle = new Map(env.db.listInbox({ limit: 10 }).items.map((row) => [row.title, row.target]));
        assert.deepEqual(byTitle.get("bad"), { kind: "chat", agent: "evil" });
        assert.deepEqual(byTitle.get("zero"), { kind: "chat", agent: "evil" });
        assert.deepEqual(byTitle.get("good"), { kind: "chat", agent: "evil", session: sid });
    } finally {
        await env.stop();
    }
});

test("a notice's target is a chat or an app: a retired view kind is refused, and stray fields are not kept", async () => {
    const env = await boot();
    try {
        const [h] = await connected(env, "evil");
        // a notice gets no reply; frames of one socket run in order, so the app item lands after the refusal
        h!.send({ id: "v", type: "notify", payload: { title: "view", target: { kind: "view", agent: "evil", view: "status" } } });
        h!.send({ id: "a", type: "notify", payload: { title: "app", target: { kind: "app", agent: "evil", route: "/orders/7", view: "status" } } });
        await waitFor(() => env.db.listInbox({ limit: 10 }).items.length === 1, 4000, "the app item");
        const { items } = env.db.listInbox({ limit: 10 });
        const [item] = items;
        assert.deepEqual(items.map((i) => i.title), ["app"], "the view notice filed nothing");
        assert.deepEqual(item?.target, { kind: "app", agent: "evil", route: "/orders/7" });
    } finally {
        await env.stop();
    }
});

test("a redeemed agent invite files an action item and starts the agent on the default daily budget; an explicit policy stays", async () => {
    const env = await boot();
    try {
        const filed: HubEvent[] = [];
        env.core.events.subscribe((ev) => {
            if (ev.type === "inbox_item") filed.push(ev);
        });
        const redeem = (): Promise<unknown> =>
            pairDevice(env.ws, env.core.devices.createAgentInvite("helper").uri, new Uint8Array(randomBytes(32)), "helper");

        await redeem();
        const [item] = env.db.listInbox({ limit: 10 }).items;
        assert.ok(item);
        assert.equal(item.title, "New agent connected: helper");
        assert.equal(item.level, "action");
        assert.equal(item.source, "system");
        assert.equal(item.agent, null);
        assert.match(item.body, /permissions and its model policy in the app/);
        assert.deepEqual(filed, [
            { type: "inbox_item", id: item.id, source: "system", agent: null, title: item.title, level: "action" },
        ]);

        // no budget is written for it: with no policy it may use the default model alone
        assert.equal(env.db.getModelsPolicy("helper"), null);
        assert.deepEqual(modelGrantsFor("helper", env.db), [{ id: "fake", contextTokens: 1000 }]);

        // a re-key of an agent the owner already configured changes nothing it decided
        env.db.setModelsPolicy("helper", { allowed: ["fake"] });
        await redeem();
        assert.deepEqual(env.db.getModelsPolicy("helper"), { allowed: ["fake"] });
        assert.equal(env.db.listInbox({ limit: 10 }).items.length, 2);
    } finally {
        await env.stop();
    }
});

test("an enrolment whose Inbox write fails is logged, and the next redemption is still announced", async (t) => {
    const env = await boot();
    try {
        const insert = env.db.insertInboxItem.bind(env.db);
        let failures = 1;
        t.mock.method(env.db, "insertInboxItem", ((...args: Parameters<typeof insert>) => {
            if (failures-- > 0) throw new Error("disk I/O error");
            return insert(...args);
        }) as typeof insert);
        for (const name of ["first", "second"]) {
            await pairDevice(env.ws, env.core.devices.createAgentInvite(name).uri, new Uint8Array(randomBytes(32)), name);
        }

        assert.deepEqual(env.db.listInbox({ limit: 10 }).items.map((item) => item.title), ["New agent connected: second"]);
        assert.ok(env.logs.some((l) => l.includes("[registry] agent first enrolled, but its Inbox item failed: disk I/O error")));
    } finally {
        await env.stop();
    }
});
