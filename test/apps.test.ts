/** Agent apps: the catalog an offline agent stays in, and the launches that open a /mini-app door. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import test from "node:test";

import { boot, waitFor, type Env } from "./harness-env.ts";

interface AppCard {
    agent: string;
    appId: string;
    title: string;
    entry?: string;
    pages?: Array<{ id: string; title: string; path?: string }>;
    available: boolean;
    status: string;
    revision: number;
    lastSeenAt: string;
}

interface Ticket {
    url: string;
    session: string;
    expiresAt: number;
}

const APP = {
    title: "Orders",
    entry: "/orders",
    pages: [{ id: "queue", title: "Queue", path: "/orders/queue" }],
    upstream: "",
};

interface Hit {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
}

/** The agent's own HTTP server: a page, an asset, and REST that echoes what it got. */
async function upstream(): Promise<{ base: string; hits: Hit[]; stop(): Promise<void> }> {
    const hits: Hit[] = [];
    const server = createServer((req, res) => {
        hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
        const url = new URL(req.url ?? "/", "http://upstream.invalid");
        if (req.method === "POST" && url.pathname === "/api/echo") {
            let body = "";
            req.setEncoding("utf8");
            req.on("data", (c: string) => (body += c));
            req.on("end", () => {
                res.writeHead(201, {
                    "content-type": "application/json; charset=utf-8",
                    "x-upstream": "yes",
                    "proxy-authenticate": "Basic",
                });
                res.end(JSON.stringify({ echoed: JSON.parse(body) as unknown, query: url.search }));
            });
            return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><title>orders</title>${url.pathname}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no upstream address");
    return {
        base: `http://127.0.0.1:${addr.port}`,
        hits,
        stop: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/** node:http, not fetch: a test about hop-by-hop headers has to put them on the wire itself. */
function raw(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const req = httpRequest(
            {
                hostname: target.hostname,
                port: target.port,
                path: `${target.pathname}${target.search}`,
                method: opts.method ?? "GET",
                headers: opts.headers ?? {},
            },
            (res) => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (c: string) => (body += c));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
            },
        );
        req.on("error", reject);
        if (opts.body !== undefined) req.write(opts.body);
        req.end();
    });
}

const catalog = async (env: Env): Promise<AppCard[]> => {
    const res = await env.api<{ apps: AppCard[] }>("GET", "/api/apps");
    assert.equal(res.status, 200);
    return res.json.apps;
};

const ticketFor = async (env: Env, agent: string, body: unknown = {}): Promise<Ticket> => {
    const res = await env.api<Ticket>("POST", `/api/apps/${agent}/ticket`, body);
    assert.equal(res.status, 200);
    return res.json;
};

/** The pult loads the ticket url on the gateway's own origin: the entry link spends the token and
 *  leaves the session cookie behind. */
async function enter(env: Env, ticket: Ticket): Promise<{ route: string; cookie: string }> {
    const landed = await raw(`${env.base}${ticket.url}`);
    assert.equal(landed.status, 302, "the ticket url is an entry link");
    const set = String(landed.headers["set-cookie"]?.[0] ?? "");
    return { route: String(landed.headers["location"]), cookie: set.split(";")[0] ?? "" };
}

const connected = (env: Env, name: string, is: boolean): Promise<void> =>
    waitFor(() => env.core.agent(name).connected === is, 4000, `${name} connected=${is}`);

test("an app described by an agent is cataloged, survives the agent, and re-registers by revision", async () => {
    const env = await boot();
    const server = await upstream();
    try {
        const bare = await env.connect({ name: "plain" });
        await connected(env, "plain", true);
        assert.deepEqual(await catalog(env), [], "no app block, no catalog row");

        const agent = await env.connect({ name: "shop", app: { ...APP, upstream: server.base } });
        await connected(env, "shop", true);
        const [row] = await catalog(env);
        assert.equal(row?.agent, "shop");
        assert.equal(row?.appId, "shop", "appId defaults to the agent name");
        assert.equal(row?.title, "Orders");
        assert.equal(row?.entry, "/orders");
        assert.deepEqual(row?.pages, [{ id: "queue", title: "Queue", path: "/orders/queue" }]);
        assert.equal(row?.available, true);
        assert.equal(row?.status, "approved", "the catalog says whether the agent may be launched at all");
        assert.equal(row?.revision, 1);
        assert.ok(row?.lastSeenAt);

        // the block is PERSISTED: the agent going away leaves the row, only `available` moves
        agent.close();
        await connected(env, "shop", false);
        const [offline] = await catalog(env);
        assert.equal(offline?.available, false);
        assert.equal(offline?.title, "Orders");
        assert.equal(offline?.revision, 1);

        // an unchanged reconnect moves no revision; a changed block bumps it
        const again = await env.connect({ name: "shop", app: { ...APP, upstream: server.base } });
        await connected(env, "shop", true);
        assert.equal((await catalog(env))[0]?.revision, 1);
        again.close();
        await connected(env, "shop", false);
        await env.connect({ name: "shop", app: { ...APP, title: "Orders v2", upstream: server.base } });
        await connected(env, "shop", true);
        const [bumped] = await catalog(env);
        assert.equal(bumped?.title, "Orders v2");
        assert.equal(bumped?.revision, 2);
        bare.close();
    } finally {
        await server.stop();
        await env.stop();
    }
});

test("hop-by-hop headers are stripped in both directions, and nothing else is touched", async () => {
    const env = await boot();
    const server = await upstream();
    try {
        await env.connect({ name: "shop", app: { ...APP, upstream: server.base } });
        await connected(env, "shop", true);
        const ticket = await ticketFor(env, "shop");
        const { cookie } = await enter(env, ticket);

        const answer = await raw(`${env.base}/mini-app/shop/api/echo`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "proxy-authorization": "Basic bogus",
                "x-mimi-app-base": "/forged/",
                "x-test": "kept",
                origin: env.base,
                cookie,
            },
            body: JSON.stringify({ order: 1 }),
        });
        assert.equal(answer.status, 201);
        assert.equal(answer.headers["x-upstream"], "yes");
        assert.equal(answer.headers["proxy-authenticate"], undefined, "response hop-by-hop is dropped");

        const hit = server.hits.find((h) => h.method === "POST");
        assert.equal(hit?.headers["proxy-authorization"], undefined, "request hop-by-hop is dropped");
        assert.equal(hit?.headers["x-test"], "kept");
        // x-mimi-* is the gateway's namespace: a client-sent one never reaches the app
        assert.equal(hit?.headers["x-mimi-app-base"], "/mini-app/shop/");
    } finally {
        await server.stop();
        await env.stop();
    }
});

test("an upstream that is not listening answers 502 with a page the iframe can show", async () => {
    const env = await boot();
    const server = await upstream();
    try {
        await env.connect({ name: "shop", app: { ...APP, upstream: server.base } });
        await connected(env, "shop", true);
        const ticket = await ticketFor(env, "shop");
        const { cookie } = await enter(env, ticket);
        await server.stop();

        const dead = await raw(`${env.base}/mini-app/shop/`, { headers: { cookie } });
        assert.equal(dead.status, 502);
        assert.equal(dead.headers["content-type"], "text/html; charset=utf-8");
        assert.match(dead.body, /unreachable/i);
        assert.match(dead.body, /^<!doctype html>/);
    } finally {
        await server.stop();
        await env.stop();
    }
});

test("a second ticket reuses the live session and mints a fresh token", async () => {
    const env = await boot();
    const server = await upstream();
    try {
        await env.connect({ name: "shop", app: { ...APP, upstream: server.base } });
        await connected(env, "shop", true);
        const first = await ticketFor(env, "shop");
        const second = await ticketFor(env, "shop", { appId: "shop", route: "/orders/queue" });
        assert.equal(second.session, first.session, "one live session per app, so one live cookie");
        assert.notEqual(new URL(second.url, env.base).search, new URL(first.url, env.base).search);
        assert.equal(new URL(second.url, env.base).pathname, "/mini-app/shop/orders/queue", "the route still steers the launch");
        assert.ok(second.expiresAt >= first.expiresAt);

        // the older token is dead once the newer one replaced it; the newer one still enters
        const stale = await raw(`${env.base}${first.url}`);
        assert.equal(stale.status, 403);
        assert.equal((await enter(env, second)).route, "/mini-app/shop/orders/queue");

        const raced = await Promise.all([ticketFor(env, "shop"), ticketFor(env, "shop")]);
        assert.equal(raced[0].session, first.session);
        assert.equal(raced[1].session, first.session);
    } finally {
        await server.stop();
        await env.stop();
    }
});

test("launch refusals: unknown app 404, offline agent 409, a route that leaves the app 400", async () => {
    const env = await boot();
    const server = await upstream();
    try {
        const agent = await env.connect({ name: "shop", app: { ...APP, upstream: server.base } });
        await connected(env, "shop", true);

        const unknownAgent = await env.api("POST", "/api/apps/ghost/ticket", {});
        assert.equal(unknownAgent.status, 404);
        const unknownApp = await env.api("POST", "/api/apps/shop/ticket", { appId: "other" });
        assert.equal(unknownApp.status, 404);
        const invalidApp = await env.api("POST", "/api/apps/shop/ticket", { appId: ["shop"] });
        assert.equal(invalidApp.status, 400);

        for (const route of ["orders", "//evil.example/x", "http://evil.example/x", "\\evil.example"]) {
            const bad = await env.api("POST", "/api/apps/shop/ticket", { appId: "shop", route });
            assert.equal(bad.status, 400, `route ${route} must be refused`);
        }

        agent.close();
        await connected(env, "shop", false);
        const offline = await env.api("POST", "/api/apps/shop/ticket", { appId: "shop" });
        assert.equal(offline.status, 409);
        assert.deepEqual(offline.json, { error: "agent offline" });
    } finally {
        await server.stop();
        await env.stop();
    }
});

test("blocking the agent's pin ends its launches: the ticket is 403 and the catalog says why", async () => {
    const env = await boot();
    const server = await upstream();
    try {
        await env.connect({ name: "shop", app: { ...APP, upstream: server.base } });
        await connected(env, "shop", true);
        const ticket = await ticketFor(env, "shop");
        const { cookie } = await enter(env, ticket);
        assert.equal((await raw(`${env.base}/mini-app/shop/orders`, { headers: { cookie } })).status, 200);

        assert.equal((await env.api("POST", "/api/pins/shop/block")).status, 200);
        const refused = await env.api<{ error: string }>("POST", "/api/apps/shop/ticket", { appId: "shop" });
        assert.equal(refused.status, 403);
        assert.deepEqual(refused.json, { error: "agent not approved" });
        assert.equal((await catalog(env))[0]?.status, "blocked");

        // the cookie the owner already held opens nothing: the session went with the pin
        assert.equal((await raw(`${env.base}/mini-app/shop/orders`, { headers: { cookie } })).status, 403);
    } finally {
        await server.stop();
        await env.stop();
    }
});
