/** The /mini-app/:appId/* door: the ticket→cookie walk, the browser-side refusals (Host, CSRF,
 *  service workers), the response-header policy, and a real request carried to a real upstream. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import test from "node:test";

import { APP_HEADER_COUNT, APP_PATH_MAX, FLAG_DATA, FLAG_END } from "@mimi-os/protocol";

import { AppTickets } from "../src/apps/tickets.ts";
import { EventHub } from "../src/events.ts";
import { notFound } from "../src/http/listeners.ts";
import { connectRawAgent, nextRequest, replyFrame } from "./agent-wire.ts";
import { boot, waitFor, type Env } from "./harness-env.ts";

interface Ticket {
    url: string;
    session: string;
    expiresAt: number;
}

interface Hit {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
}

interface Upstream {
    base: string;
    hits: Hit[];
    /** The SSE responses still open on this server. */
    live: ServerResponse[];
    stop(): Promise<void>;
}

/** The agent's own HTTP server, shaped like a small express app. */
async function upstream(tag = "orders"): Promise<Upstream> {
    const hits: Hit[] = [];
    const live: ServerResponse[] = [];
    const server = createServer((req, res) => {
        hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
        const url = new URL(req.url ?? "/", "http://upstream.invalid");
        if (req.method === "PUT") {
            res.writeHead(204, { "x-upstream": tag });
            res.end();
            return;
        }
        if (req.method === "POST") {
            let body = "";
            req.setEncoding("utf8");
            req.on("data", (c: string) => (body += c));
            req.on("end", () => {
                res.writeHead(201, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ echoed: body, query: url.search }));
            });
            return;
        }
        if (url.pathname === "/assets/x.js") {
            res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
            res.end("export const x = 1;\n");
            return;
        }
        if (url.pathname === "/sticky") {
            // everything an app may try to force onto the pult's own origin
            res.writeHead(200, {
                "content-type": "text/plain; charset=utf-8",
                "content-security-policy": "default-src 'none'",
                "cache-control": "public, max-age=600",
                "x-frame-options": "DENY",
                "set-cookie": "app_session=abc; Path=/",
            });
            res.end("sticky");
            return;
        }
        if (url.pathname === "/sse") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write("data: tick\n\n");
            live.push(res);
            return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><title>${tag}</title>${url.pathname}`);
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no upstream address");
    return {
        base: `http://127.0.0.1:${String(addr.port)}`,
        hits,
        live,
        stop: async () => {
            for (const res of live) res.end();
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
        },
    };
}

interface Answer {
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
}

/** node:http, not fetch: these tests set Host, Origin and hop-by-hop headers themselves. */
function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
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

const ticketFor = async (env: Env, agent: string, body: unknown = {}): Promise<Ticket> => {
    const res = await env.api<Ticket>("POST", `/api/apps/${agent}/ticket`, body);
    assert.equal(res.status, 200);
    return res.json;
};

/** Walk the entry link the way the iframe does, and keep what the 302 left behind. */
async function enter(env: Env, ticket: Ticket): Promise<{ cookie: string; location: string; set: string[] }> {
    const landed = await raw(`${env.base}${ticket.url}`);
    assert.equal(landed.status, 302, "the ticket url is an entry link");
    const set = landed.headers["set-cookie"] ?? [];
    return { cookie: (set[0] ?? "").split(";")[0] ?? "", location: String(landed.headers["location"]), set };
}

const connected = (env: Env, name: string, is: boolean): Promise<void> =>
    waitFor(() => env.core.agent(name).connected === is, 4000, `${name} connected=${String(is)}`);

/** One app, launched and entered: the state every later request in a test carries. */
async function launched(env: Env, name: string, app: Upstream): Promise<{ cookie: string; ticket: Ticket }> {
    await env.connect({ name, app: { title: "Orders", entry: "/orders", upstream: app.base } });
    await connected(env, name, true);
    const ticket = await ticketFor(env, name);
    const { cookie } = await enter(env, ticket);
    return { cookie, ticket };
}

test("the entry link spends the ticket for a cookie scoped to this app's prefix", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        await env.connect({ name: "board", app: { title: "Board", entry: "/orders", upstream: app.base } });
        await connected(env, "board", true);
        const ticket = await ticketFor(env, "board");
        assert.match(ticket.url, /^\/mini-app\/board\/orders\?mimi_ticket=[0-9a-f]{32}$/);
        assert.match(ticket.session, /^[0-9a-f]{32}$/);
        assert.ok(ticket.expiresAt > Date.now());

        const { set, location, cookie } = await enter(env, ticket);
        assert.equal(location, "/mini-app/board/orders", "the token is cleaned out of the URL");
        assert.match(set[0] ?? "", new RegExp(`^mimi_app_${ticket.session}=[0-9a-f]{64}; `));
        assert.match(set[0] ?? "", /; Path=\/mini-app\/board\/; HttpOnly; SameSite=Strict$/);
        assert.doesNotMatch(set[0] ?? "", /Secure|Domain|Max-Age/);

        // a cookie an earlier gateway process left behind names no live session: the next launch
        // expires it in the same 302, and the live one is untouched
        const dead = "00000000000000000000000000000000";
        const again = await raw(`${env.base}${ticket.url}`, { headers: { cookie: `mimi_app_${dead}=x; ${cookie}` } });
        assert.equal(again.status, 302);
        const relaunch = again.headers["set-cookie"] ?? [];
        assert.equal(relaunch.length, 2);
        assert.match(relaunch[0] ?? "", new RegExp(`^mimi_app_${ticket.session}=`));
        assert.doesNotMatch(relaunch[0] ?? "", /Max-Age/, "the live session's own cookie never expires in the 302");
        assert.equal(relaunch[1], `mimi_app_${dead}=; Path=/mini-app/board/; Max-Age=0`);

        const page = await raw(`${env.base}${location}`, { headers: { cookie } });
        assert.equal(page.status, 200);
        assert.match(page.body, /<title>orders<\/title>/);
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("the ticket is one-time, and only a live cookie may walk the entry link again", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const { cookie, ticket } = await launched(env, "board", app);
        const again = await raw(`${env.base}${ticket.url}`);
        assert.equal(again.status, 403, "a spent token with no cookie buys nothing");
        assert.match(again.body, /Relaunch this interface/);

        // the pult's "reload interface" button re-navigates the frame to the original entry link
        const reload = await raw(`${env.base}${ticket.url}`, { headers: { cookie } });
        assert.equal(reload.status, 302);
        assert.equal(reload.headers["location"], "/mini-app/board/orders");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("only a cookie naming a live session of THIS app is admitted, whatever else is presented", async () => {
    const env = await boot();
    const shop = await upstream("shop");
    const mate = await upstream("mate");
    try {
        const a = await launched(env, "shop", shop);
        const b = await launched(env, "mate", mate);

        assert.equal((await raw(`${env.base}/mini-app/shop/orders`)).status, 403, "no cookie at all");
        assert.equal((await raw(`${env.base}/mini-app/mate/orders`, { headers: { cookie: a.cookie } })).status, 403, "app A's cookie on app B");
        assert.equal((await raw(`${env.base}/mini-app/mate/orders`, { headers: { cookie: b.cookie } })).status, 200);

        // every candidate is scanned, so a same-origin page's forged cookie is harmless beside a real one
        const forged = "mimi_app_00000000000000000000000000000000=deadbeef";
        assert.equal((await raw(`${env.base}/mini-app/shop/orders`, { headers: { cookie: `${forged}; ${a.cookie}` } })).status, 200);
        assert.equal((await raw(`${env.base}/mini-app/shop/orders`, { headers: { cookie: forged } })).status, 403);
    } finally {
        await shop.stop();
        await mate.stop();
        await env.stop();
    }
});

test("an app address without its trailing slash redirects to one, query kept", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const { cookie } = await launched(env, "board", app);
        const bare = await raw(`${env.base}/mini-app/board?tab=new`, { headers: { cookie } });
        assert.equal(bare.status, 302);
        assert.equal(bare.headers["location"], "/mini-app/board/?tab=new");
        assert.equal((await raw(`${env.base}/mini-app`, { headers: { cookie } })).status, 404, "the prefix alone names no app");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("Host: the owner's own loopback name passes and is carried; anything else is 403", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const { cookie } = await launched(env, "board", app);
        const named = await raw(`http://localhost:${String(env.port)}/mini-app/board/orders`, { headers: { cookie } });
        assert.equal(named.status, 200, "the pult is reachable by name as well as by address");
        assert.match(named.body, /<title>orders<\/title>/);

        for (const host of [`evil.test:${String(env.port)}`, `127.0.0.1:${String(env.port + 1)}`]) {
            const answer = await raw(`${env.base}/mini-app/board/orders`, { headers: { cookie, host } });
            assert.equal(answer.status, 403, host);
            assert.match(answer.body, /not addressed to this app/, host);
        }
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("an unsafe method needs an accepted Origin, or a same-origin fetch that sent none", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const { cookie } = await launched(env, "board", app);
        const post = (headers: Record<string, string>): Promise<Answer> =>
            raw(`${env.base}/mini-app/board/api/echo`, { method: "POST", headers: { cookie, ...headers }, body: "x" });

        const before = app.hits.length;
        assert.equal((await post({})).status, 403, "no Origin and no Sec-Fetch-Site is a cross-site POST");
        assert.equal((await post({ origin: "http://evil.example" })).status, 403);
        assert.equal((await post({ origin: `http://127.0.0.1:${String(env.port + 1)}` })).status, 403);
        assert.equal(app.hits.length, before, "a refused POST opens no stream at all");

        assert.equal((await post({ origin: env.base })).status, 201);
        assert.equal((await post({ "sec-fetch-site": "same-origin" })).status, 201);

        // under `pnpm dev` vite proxies /mini-app, so the browser's Origin is the dev server's
        process.env["MIMI_DEV_UI"] = "http://127.0.0.1:5273";
        try {
            assert.equal((await post({ origin: "http://127.0.0.1:5273" })).status, 201);
            assert.equal((await post({ origin: "http://127.0.0.1:5274" })).status, 403);
        } finally {
            delete process.env["MIMI_DEV_UI"];
        }
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("every method, path and query reaches the app with the prefix stripped", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const { cookie } = await launched(env, "board", app);
        const asset = await raw(`${env.base}/mini-app/board/assets/x.js`, { headers: { cookie } });
        assert.equal(asset.status, 200);
        assert.equal(asset.headers["content-type"], "application/javascript; charset=utf-8");
        assert.equal(asset.body, "export const x = 1;\n");

        const head = await raw(`${env.base}/mini-app/board/orders`, { method: "HEAD", headers: { cookie } });
        assert.equal(head.status, 200);
        assert.equal(head.body, "");

        const echo = await raw(`${env.base}/mini-app/board/api/echo?tab=open`, {
            method: "POST",
            headers: { cookie, origin: env.base, "content-type": "text/plain" },
            body: "hello",
        });
        assert.equal(echo.status, 201);
        assert.deepEqual(JSON.parse(echo.body) as unknown, { echoed: "hello", query: "?tab=open" });

        const put = await raw(`${env.base}/mini-app/board/thing`, { method: "PUT", headers: { cookie, origin: env.base } });
        assert.equal(put.status, 204);
        assert.equal(put.headers["x-upstream"], "orders");

        assert.deepEqual(
            app.hits.map((h) => `${h.method} ${h.url}`),
            ["GET /assets/x.js", "HEAD /orders", "POST /api/echo?tab=open", "PUT /thing"],
        );
        // node's parser accepts M-SEARCH; the wire contract says the front door refuses it
        assert.equal((await raw(`${env.base}/mini-app/board/orders`, { method: "M-SEARCH", headers: { cookie } })).status, 501);
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("the gateway's own response headers override the app's, and nothing is cleared", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const { cookie } = await launched(env, "board", app);
        const answer = await raw(`${env.base}/mini-app/board/sticky`, { headers: { cookie } });
        assert.equal(answer.status, 200);
        assert.equal(answer.headers["content-security-policy"], "frame-ancestors 'self'");
        assert.equal(answer.headers["cache-control"], "no-store");
        assert.equal(answer.headers["referrer-policy"], "no-referrer");
        assert.equal(answer.headers["x-content-type-options"], "nosniff");
        assert.equal(answer.headers["x-frame-options"], undefined, "it would contradict frame-ancestors in older engines");
        assert.equal(answer.headers["set-cookie"], undefined, "the jar is server-side; a Set-Cookie never reaches the client");
        assert.equal(answer.headers["clear-site-data"], undefined, "this origin holds the pult's own storage");
        assert.equal(answer.headers["content-type"], "text/plain; charset=utf-8", "the app still owns its content type");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("a path or a header set past the caps is refused with a page, and the app never sees it", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const { cookie } = await launched(env, "board", app);
        const long = await raw(`${env.base}/mini-app/board/${"a".repeat(APP_PATH_MAX)}`, { headers: { cookie } });
        assert.equal(long.status, 414);
        assert.match(long.body, /Address too long/);

        const many: Record<string, string> = { cookie };
        for (let i = 0; i <= APP_HEADER_COUNT; i++) many[`x-h${i}`] = "1";
        const wide = await raw(`${env.base}/mini-app/board/orders`, { headers: many });
        assert.equal(wide.status, 431);
        assert.match(wide.body, /Too many headers/);
        assert.equal(app.hits.length, 0, "neither ever reaches the app's own server");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("an agent cannot frame the browser's socket: the gateway owns content-length, and 1xx is 502", async () => {
    const env = await boot();
    try {
        // a raw channel agent, so the reply head is whatever this test writes rather than an HTTP
        // client's: the upstream is never dialled at all
        const agent = await connectRawAgent(env, { name: "rogue", app: { title: "Rogue", entry: "/", upstream: "http://127.0.0.1:1" } });
        const { cookie } = await enter(env, await ticketFor(env, "rogue"));

        const smuggled = "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 25\r\n\r\n<script>alert(1)</script>";
        const answering = raw(`${env.base}/mini-app/rogue/x`, { headers: { cookie } });
        const first = await nextRequest(agent);
        agent.send(replyFrame(first.stream, { t: "head", status: 200, headers: { "content-type": "text/plain", "content-length": "3" } }));
        agent.send({ stream: first.stream, flags: FLAG_DATA, payload: Buffer.from(`AAA${smuggled}`, "utf8") });
        agent.send({ stream: first.stream, flags: FLAG_END, payload: new Uint8Array(0) });

        const answer = await answering;
        assert.equal(answer.status, 200);
        assert.equal(answer.headers["content-length"], undefined, "node frames this body, not the app");
        assert.equal(answer.body, `AAA${smuggled}`, "every byte past the declared length is body, not a second answer");

        // 101 belongs to an upgrade; an informational head here would hand the agent the
        // framing of a keep-alive socket the browser is still waiting on
        const informational = raw(`${env.base}/mini-app/rogue/y`, { headers: { cookie } });
        const second = await nextRequest(agent);
        agent.send(replyFrame(second.stream, { t: "head", status: 100, headers: {} }));
        assert.equal((await informational).status, 502);
        agent.close();
    } finally {
        await env.stop();
    }
});

test("an unspent ticket is dead after two minutes, while its session is still live", (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const tickets = new AppTickets({ events: new EventHub() });
    try {
        const first = tickets.open("board", "board", "http://127.0.0.1:3377", "device-1");
        t.mock.timers.tick(119_000);
        assert.equal(tickets.redeem("board", first.ticket)?.id, first.id, "a token still inside its window");

        const second = tickets.open("board", "board", "http://127.0.0.1:3377", "device-1");
        assert.equal(second.id, first.id, "the same live session, a fresh token");
        t.mock.timers.tick(121_000);
        assert.equal(tickets.redeem("board", second.ticket), null, "a ticket that sat around is a leaked URL");
        assert.ok(tickets.renew(second.id, "device-1"), "and the session itself is untouched by the token's age");
    } finally {
        tickets.stop();
    }
});

test("a session is renewed only by the device whose channel minted it", (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const tickets = new AppTickets({ events: new EventHub() });
    try {
        const launch = tickets.open("board", "board", "http://127.0.0.1:3377", "device-1");
        assert.equal(tickets.renew(launch.id, "device-2"), null, "another paired device holds no claim on it");
        assert.ok(tickets.renew(launch.id, "device-1"));
        const anonymous = tickets.open("shop", "shop", "http://127.0.0.1:3378", null);
        assert.ok(tickets.renew(anonymous.id, "device-2"), "a session with no device behind it keeps its id as its only key");
    } finally {
        tickets.stop();
    }
});

test("a service worker is refused across the whole loopback surface", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const { cookie } = await launched(env, "board", app);
        const worker = { cookie, "sec-fetch-dest": "serviceworker" };
        assert.equal((await raw(`${env.base}/mini-app/board/sw.js`, { headers: worker })).status, 403);
        assert.equal((await raw(`${env.base}/app/assets/x.js`, { headers: worker })).status, 403);
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("admission is re-checked per request: offline, blocked, and a re-declared upstream", async () => {
    const env = await boot();
    const app = await upstream();
    const moved = await upstream("moved");
    try {
        const agent = await env.connect({ name: "board", app: { title: "Board", entry: "/", upstream: app.base } });
        await connected(env, "board", true);
        const { cookie } = await enter(env, await ticketFor(env, "board"));
        assert.equal((await raw(`${env.base}/mini-app/board/`, { headers: { cookie } })).status, 200);

        agent.close();
        await connected(env, "board", false);
        const offline = await raw(`${env.base}/mini-app/board/`, { headers: { cookie } });
        assert.equal(offline.status, 503);
        assert.match(offline.body, /offline/i);

        // the agent comes back declaring another server: the session was minted against the old one
        await env.connect({ name: "board", app: { title: "Board", entry: "/", upstream: moved.base } });
        await connected(env, "board", true);
        assert.equal((await raw(`${env.base}/mini-app/board/`, { headers: { cookie } })).status, 403);

        // a fresh launch follows the catalog, and blocking the pin ends that one too
        const fresh = await enter(env, await ticketFor(env, "board"));
        assert.equal((await raw(`${env.base}/mini-app/board/`, { headers: { cookie: fresh.cookie } })).status, 200);
        assert.equal((await env.api("POST", "/api/pins/board/block")).status, 200);
        assert.equal((await raw(`${env.base}/mini-app/board/`, { headers: { cookie: fresh.cookie } })).status, 403);
    } finally {
        await app.stop();
        await moved.stop();
        await env.stop();
    }
});

test("blocking an agent resets the miniapp stream it already had in flight", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const { cookie } = await launched(env, "board", app);
        const stream = httpRequest(`${env.base}/mini-app/board/sse`, { headers: { cookie } });
        const first = await new Promise<{ status: number; ended: Promise<void> }>((resolve, reject) => {
            stream.on("response", (res) => {
                res.resume();
                resolve({ status: res.statusCode ?? 0, ended: new Promise<void>((done) => res.on("close", () => done())) });
            });
            stream.on("error", reject);
            stream.end();
        });
        assert.equal(first.status, 200);
        await waitFor(() => app.live.length === 1, 4000, "the upstream SSE response");

        assert.equal((await env.api("POST", "/api/pins/board/block")).status, 200);
        await first.ended;
        assert.equal((await raw(`${env.base}/mini-app/board/orders`, { headers: { cookie } })).status, 403);
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("a revoked device loses the sessions its channel minted", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const { cookie } = await launched(env, "board", app);
        assert.equal((await raw(`${env.base}/mini-app/board/orders`, { headers: { cookie } })).status, 200);

        // a request already being answered under that session ends with it, rather than hanging open
        const live = httpRequest(`${env.base}/mini-app/board/sse`, { headers: { cookie } });
        const answering = await new Promise<{ ended: Promise<void> }>((resolve, reject) => {
            live.on("response", (res) => {
                res.resume();
                resolve({ ended: new Promise<void>((done) => res.on("close", () => done())) });
            });
            live.on("error", reject);
            live.end();
        });
        await waitFor(() => app.live.length === 1, 4000, "the upstream SSE response");

        const { id } = await env.device();
        assert.ok(env.core.devices.revoke(id));
        await answering.ended;
        const gone = await raw(`${env.base}/mini-app/board/orders`, { headers: { cookie } });
        assert.equal(gone.status, 403);
        assert.match(gone.body, /Relaunch this interface/);
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("two launches of one app share one session, and a renew slides it", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        await env.connect({ name: "board", app: { title: "Board", entry: "/orders", upstream: app.base } });
        await connected(env, "board", true);
        const first = await ticketFor(env, "board");
        const second = await ticketFor(env, "board", { appId: "board", route: "/orders/7?tab=new" });
        assert.equal(second.session, first.session);
        // the route carries its own query: the token is added to it, not as a second "?"
        assert.equal(second.url, `/mini-app/board/orders/7?tab=new&mimi_ticket=${new URL(second.url, env.base).searchParams.get("mimi_ticket") ?? ""}`);

        const frame = await enter(env, second);
        assert.equal(frame.location, "/mini-app/board/orders/7?tab=new");
        const renewed = await env.api<{ expiresAt: number }>("POST", `/api/apps/sessions/${first.session}/renew`);
        assert.equal(renewed.status, 200);
        assert.ok(renewed.json.expiresAt >= first.expiresAt);
        assert.equal((await raw(`${env.base}/mini-app/board/orders`, { headers: { cookie: frame.cookie } })).status, 200);
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("a browser that goes away mid-answer resets the stream, and the door survives it", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const { cookie } = await launched(env, "board", app);
        const stream = httpRequest(`${env.base}/mini-app/board/sse`, { headers: { cookie } });
        await new Promise<void>((resolve, reject) => {
            stream.on("response", (res) => {
                res.resume();
                resolve();
            });
            stream.on("error", reject);
            stream.end();
        });
        await waitFor(() => app.live.length === 1, 4000, "the upstream SSE response");
        const upstreamReply = app.live[0];
        assert.ok(upstreamReply);

        // the tab closed: the whole chain unwinds, and a normal completion is NOT this path
        stream.destroy();
        await waitFor(() => upstreamReply.destroyed, 4000, "the app's own response to be destroyed");
        assert.equal((await raw(`${env.base}/mini-app/board/orders`, { headers: { cookie } })).status, 200);
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("a --lan listener answers the standard 404 blob for /mini-app", async () => {
    const server = createServer(notFound);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no lan address");
    try {
        const answer = await raw(`http://127.0.0.1:${String(addr.port)}/mini-app/board/orders`);
        assert.equal(answer.status, 404);
        assert.equal(answer.headers["content-type"], "text/plain");
        assert.equal(answer.body, "Not Found");
    } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
    }
});
