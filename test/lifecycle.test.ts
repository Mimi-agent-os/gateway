/** What a connection owns dies with it: parked gates, running turns, one-shot model calls, app proxies. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { addModel, setDefaultModel } from "../src/llm/models.ts";
import type { Harness } from "./agent-harness.ts";
import { boot, callTurn, textTurn, waitFor, type Env } from "./harness-env.ts";

const WRITE_TOOLS = [{ name: "send_email", writes: true, parameters: { type: "object", properties: {} } }];

async function connected(env: Env, opts: Parameters<Env["connect"]>[0]): Promise<Harness> {
    const h = await env.connect(opts);
    await waitFor(() => env.core.registry.get(opts.name) !== undefined, 4000, `${opts.name} registered`);
    return h;
}

/** A model endpoint that takes the request and never answers: a call there ends by cancellation or not at all. */
function stalledModel(): {
    taken: () => number;
    cut: () => number;
    listen: () => Promise<string>;
    close: () => Promise<void>;
} {
    let taken = 0;
    let cut = 0;
    const server: Server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            taken += 1;
            res.on("close", () => {
                if (!res.writableEnded) cut += 1;
            });
        });
    });
    return {
        taken: () => taken,
        cut: () => cut,
        listen: () =>
            new Promise<string>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                    const addr = server.address();
                    if (addr === null || typeof addr === "string") reject(new Error("stalled model: no port"));
                    else resolve(`http://127.0.0.1:${addr.port}`);
                });
            }),
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
}

/** Three chat frames on a stalled endpoint: the first runs, the other two wait in that endpoint's queue. */
async function pipelined(env: Env, h: Harness, stalled: ReturnType<typeof stalledModel>): Promise<string[]> {
    const ids = ["s1", "s2", "s3"];
    for (const id of ids) h.send({ id, type: "chat", payload: { messages: [{ role: "user", content: "hi" }] } });
    await waitFor(() => stalled.taken() === 1, 4000, "the first call to reach the endpoint");
    assert.equal(env.core.approvals.pending().length, 0);
    return ids;
}

test("an agent that drops mid-approval leaves no card and no wedged chat", async () => {
    const env = await boot();
    try {
        const h = await connected(env, {
            name: "toto",
            tools: WRITE_TOOLS,
            handlers: { send_email: { text: "SENT" } },
        });
        const sid = h.createSession();
        env.model.nextTurn(callTurn([{ id: "w1", name: "send_email" }]));

        let settled = false;
        const stranded = env.core.runTurn({ agent: "toto", session: sid, text: "mail them", attended: true, title: false });
        stranded.then(() => (settled = true), () => (settled = true));
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "a parked gate");
        const stale = env.core.approvals.pending()[0]!.gate;

        h.close();
        await waitFor(() => settled, 4000, "the stranded turn to settle");
        assert.equal(env.core.approvals.pending().length, 0, "the card the dead socket parked is retired");
        assert.equal(env.core.approvals.answer(stale, { w1: true }), false, "answering it cannot report success");
        assert.equal(env.core.turns.get("toto", sid), undefined, "the chat is free, not held for five minutes");

        // the restarted agent finds its chat usable at once, instead of 409 until the gate expires
        const back = await connected(env, { name: "toto", tools: WRITE_TOOLS, handlers: {} });
        assert.equal(back.createSession(), sid, "the restarted agent still keeps that chat");
        env.model.nextTurn(textTurn("back"));
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "again", title: false });
        assert.equal(out.text, "back");
        assert.equal(back.invokes().length, 0);
    } finally {
        await env.stop();
    }
});

test("a reconnect settles what the socket it replaced parked", async () => {
    const env = await boot();
    try {
        const first = await connected(env, {
            name: "toto",
            tools: WRITE_TOOLS,
            handlers: { send_email: { text: "SENT" } },
        });
        const sid = first.createSession();
        env.model.nextTurn(callTurn([{ id: "w1", name: "send_email" }]));

        let settled = false;
        const stranded = env.core.runTurn({ agent: "toto", session: sid, text: "mail them", attended: true, title: false });
        stranded.then(() => (settled = true), () => (settled = true));
        await waitFor(() => env.core.approvals.pending().length === 1, 4000, "a parked gate");

        await connected(env, { name: "toto", tools: WRITE_TOOLS, handlers: { send_email: { text: "SENT" } } });
        await waitFor(() => !first.socketOpen(), 4000, "the replaced socket to close");
        await waitFor(() => settled, 4000, "the stranded turn to settle");
        assert.equal(env.core.approvals.pending().length, 0, "the replaced socket's card is gone");
        assert.equal(env.core.turns.get("toto", sid), undefined, "and its chat is released");
    } finally {
        await env.stop();
    }
});

test("a paused agent is refused a turn and a one-shot chat, and resumes cleanly", async () => {
    const env = await boot();
    try {
        const h = await connected(env, { name: "worker" });
        const session = h.createSession();
        env.core.setPaused("worker", true);

        await assert.rejects(env.core.runTurn({ agent: "worker", session, text: "hi", attended: true, title: false }), /paused/);
        h.send({ id: "chat-p", type: "chat", payload: { messages: [{ role: "user", content: "hi" }] } });
        await waitFor(() => h.frames().some((f) => f["id"] === "chat-p"), 4000, "chat reply");
        const reply = h.frames().find((f) => f["id"] === "chat-p");
        assert.equal(reply?.["status"], "denied");
        assert.match(String((reply?.["error"] as { message?: string } | undefined)?.message), /paused/);
        assert.equal(env.db.listLlmCalls().length, 0);
        assert.equal(env.model.requests.length, 0);

        env.core.setPaused("worker", false);
        env.model.nextTurn(textTurn("back"));
        const out = await env.core.runTurn({ agent: "worker", session, text: "hi", attended: true, title: false });
        assert.equal(out.text, "back");
    } finally {
        await env.stop();
    }
});

test("pausing an agent cuts the model call it has running and drops the ones it queued", async () => {
    const env = await boot();
    const stalled = stalledModel();
    try {
        addModel({ name: "stall", provider: "llamacpp", endpoint: await stalled.listen(), contextTokens: 1000 }, env.db);
        setDefaultModel("stall", env.db);
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        const ids = await pipelined(env, h, stalled);

        env.core.setPaused("toto", true);
        await waitFor(() => ids.every((id) => h.frames().some((f) => f["id"] === id)), 4000, "every reply");

        assert.equal(stalled.taken(), 1, "the queued calls never reach the endpoint");
        await waitFor(() => stalled.cut() === 1, 4000, "the running call to be cut off");
        for (const id of ids.slice(1)) {
            const frame = h.frames().find((f) => f["id"] === id)!;
            assert.equal(frame["status"], "denied");
            assert.match(String((frame["error"] as { message?: string }).message), /stopped — the call was cancelled/);
        }
        // the queued calls never reached the endpoint and spent nothing; the one it had is estimated
        const rows = env.db.listLlmCalls(10, "toto");
        const cut = rows.filter((r) => r.usageEstimated);
        assert.equal(cut.length, 1, "only the call the endpoint had is charged");
        assert.ok(rows.filter((r) => !r.usageEstimated).every((r) => r.promptTokens === null));
        assert.equal(env.db.spendByAgent().get("toto")?.tokens, cut[0]!.promptTokens! + cut[0]!.completionTokens!);
    } finally {
        await stalled.close();
        await env.stop();
    }
});

test("revoking an agent's pin cuts the model calls it left behind", async () => {
    const env = await boot();
    const stalled = stalledModel();
    try {
        addModel({ name: "stall", provider: "llamacpp", endpoint: await stalled.listen(), contextTokens: 1000 }, env.db);
        setDefaultModel("stall", env.db);
        const h = await connected(env, { name: "toto", tools: [], handlers: {} });
        await pipelined(env, h, stalled);

        assert.equal(env.core.registry.revoke("toto"), true);
        await waitFor(() => stalled.cut() === 1, 4000, "the running call to be cut off");
        await waitFor(() => !h.socketOpen(), 4000, "the revoked socket to close");
        assert.equal(stalled.taken(), 1, "nothing is billed to a pin that is gone");
    } finally {
        await stalled.close();
        await env.stop();
    }
});

test("an app re-declared on another upstream retires the session minted against the old one", async () => {
    const env = await boot();
    const hits: string[] = [];
    const serve = (tag: string): Server =>
        createServer((req, res) => {
            hits.push(`${tag} ${req.headers.cookie ?? "-"}`);
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(tag);
        });
    const own = serve("own");
    const other = serve("other");
    try {
        const base = async (server: Server): Promise<string> => {
            await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
            const addr = server.address();
            if (addr === null || typeof addr === "string") throw new Error("no upstream address");
            return `http://127.0.0.1:${addr.port}`;
        };
        const ownBase = await base(own);
        const otherBase = await base(other);

        const app = { title: "Orders", entry: "/orders", upstream: ownBase };
        const agent = await connected(env, { name: "shop", app });
        const first = await env.api<{ url: string }>("POST", "/api/apps/shop/ticket", {});
        assert.equal(first.status, 200);
        const entered = await fetch(`${env.base}${first.json.url}`, { redirect: "manual" });
        assert.equal(entered.status, 302);
        const cookie = (entered.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
        const door = `${env.base}/mini-app/shop/orders`;
        assert.equal((await fetch(door, { headers: { cookie } })).status, 200);
        assert.deepEqual(hits, ["own -"], "the agent dials its own server, and only that one");

        agent.close();
        await waitFor(() => env.core.agent("shop").connected === false, 4000, "shop to go away");
        await connected(env, { name: "shop", app: { ...app, upstream: otherBase } });
        // what the owner signs in to on the NEW origin lands in the same jar, keyed by the app
        env.db.setAppCookie("shop", "shop", { name: "sid", value: "from-other", path: "/", expiresAt: null });

        const stale = await fetch(door, { headers: { cookie } });
        assert.equal(stale.status, 403, "the session was minted against the upstream that is gone");
        assert.deepEqual(hits, ["own -"], "and never carries the new origin's cookie to the old server");

        const relaunch = await env.api<{ url: string }>("POST", "/api/apps/shop/ticket", {});
        assert.equal(relaunch.status, 200);
        const landed = await fetch(`${env.base}${relaunch.json.url}`, { redirect: "manual" });
        const fresh = (landed.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
        // both apps share one origin now, so what retires the dropped session is its own secret
        assert.notEqual(fresh, cookie, "the relaunch is a session of its own");
        assert.equal((await fetch(door, { headers: { cookie } })).status, 403, "the old session's cookie buys nothing");
        assert.equal((await fetch(door, { headers: { cookie: fresh } })).status, 200);
        assert.deepEqual(hits, ["own -", "other sid=from-other"], "only the current upstream is proxied");
    } finally {
        for (const server of [own, other]) {
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
        }
        await env.stop();
    }
});
