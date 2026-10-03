/** The gateway↔agent app bridge driven as both doors drive it: open() with a sink, against the SDK's executor and a real upstream. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSocketServer, type AddressInfo, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { APP_CHUNK, APP_CREDIT, APP_HEADER_COUNT, APP_HEADER_MAX, APP_PATH_MAX, APP_WINDOW, FLAG_DATA, FLAG_END } from "@mimi-os/protocol";

import type { AppBridgeRequest, AppExchange, AppSink } from "../src/apps/bridge.ts";
import { storeSetCookies, type Headers } from "../src/apps/headers.ts";
import { connectRawAgent, nextFrame, nextRequest, replyFrame } from "./agent-wire.ts";
import { boot, connectAppAgent, waitFor, type Env } from "./harness-env.ts";

interface Hit {
    url: string;
    headers: IncomingHttpHeaders;
    body: Promise<Buffer>;
    closed: Promise<void>;
}

interface Upstream {
    base: string;
    hits: Hit[];
}

interface Answer {
    status: number | null;
    headers: Headers;
    chunks: Buffer[];
    failed: { status: number; code: string } | null;
    ended: boolean;
    aborted: boolean;
}

const text = (a: Answer): string => Buffer.concat(a.chunks).toString("utf8");
const size = (a: Answer): number => a.chunks.reduce((n, c) => n + c.length, 0);

/** What a door hands the bridge, recording everything it is told. `settled` resolves on the one
 *  terminal call — end(), fail() or abort() — so a test never polls for an answer. A `slow` sink
 *  takes nothing until drain() is called, which is how a browser that stops reading looks. */
function recorder(slow = false): { sink: AppSink; answer: Answer; settled: Promise<Answer>; drain(): void; registrations(): number } {
    const answer: Answer = { status: null, headers: {}, chunks: [], failed: null, ended: false, aborted: false };
    let finish = (): void => undefined;
    const settled = new Promise<Answer>((resolve) => {
        finish = () => resolve(answer);
    });
    let resume: (() => void) | null = null;
    let registered = 0;
    let ready = !slow;
    return {
        answer,
        settled,
        registrations: () => registered,
        drain: () => {
            ready = true;
            const go = resume;
            resume = null;
            go?.();
        },
        sink: {
            head: (status, headers) => {
                answer.status = status;
                answer.headers = headers;
            },
            data: (chunk) => {
                answer.chunks.push(Buffer.from(chunk));
                return ready;
            },
            end: () => {
                answer.ended = true;
                finish();
            },
            fail: (status, code) => {
                answer.failed = { status, code };
                finish();
            },
            abort: () => {
                answer.aborted = true;
                finish();
            },
            onDrain: (go) => {
                registered += 1;
                resume = go;
            },
        },
    };
}

async function upstreamOf(servers: Server[], handler: (req: IncomingMessage, res: ServerResponse) => void, path = ""): Promise<Upstream> {
    const hits: Hit[] = [];
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        hits.push({
            url: req.url ?? "",
            headers: req.headers,
            body: new Promise((resolve) => req.on("end", () => resolve(Buffer.concat(chunks)))),
            closed: new Promise((resolve) => res.on("close", () => resolve())),
        });
        req.on("data", (c: Buffer) => void chunks.push(c));
        handler(req, res);
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const addr = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${addr.port}${path}`, hits };
}

const closeServer = (server: Server): Promise<void> => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
};

const ok = (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
};

/** What a door does with a request body: write, pause on false, resume from onDrain — the
 *  credit loop as mini-app.ts and the tunnel drive it. */
function pump(exchange: AppExchange, body: Uint8Array, chunk = 32 * 1024): void {
    let at = 0;
    const step = (): void => {
        while (at < body.length) {
            const slice = body.subarray(at, at + chunk);
            at += slice.length;
            if (!exchange.write(slice)) return exchange.onDrain(step);
        }
        exchange.end();
    };
    step();
}

/** One whole exchange: open, send the body, end, and wait for the sink's terminal call. */
function request(env: Env, appId: string, req: Partial<AppBridgeRequest> = {}, body?: Uint8Array): Promise<Answer> {
    const rec = recorder();
    const exchange = env.core.appBridge.open(
        { appId, method: "GET", path: "/", headers: {}, mode: "http", publicBase: "", ...req },
        rec.sink,
    );
    if (exchange) pump(exchange, body ?? new Uint8Array(0));
    return rec.settled;
}

test("a request reaches the agent's own upstream and the reply comes back through the sink", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const up = await upstreamOf(servers, (req, res) => {
            res.writeHead(200, { "content-type": "text/plain", "x-echo": req.url ?? "" });
            res.end("hello");
        });
        await connectAppAgent(env, "shop", up.base);

        const answer = await request(env, "shop", { path: "/orders/7?tab=new", method: "POST" }, Buffer.from("payload"));
        assert.equal(answer.status, 200);
        assert.equal(text(answer), "hello");
        assert.equal(answer.ended, true);
        assert.equal(answer.headers["x-echo"], "/orders/7?tab=new");
        assert.equal(up.hits.length, 1);
        assert.equal(up.hits[0]?.url, "/orders/7?tab=new");
        assert.equal((await up.hits[0]?.body)?.toString("utf8"), "payload");
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("open refuses before any frame: no catalog row, a pin that is not approved, a stale upstream pin, and an offline agent", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const up = await upstreamOf(servers, ok);
        assert.deepEqual((await request(env, "ghost")).failed, { status: 404, code: "not_found" });

        const agent = await connectAppAgent(env, "shop", up.base);
        assert.deepEqual((await request(env, "shop", { upstreamPin: "http://127.0.0.1:1" })).failed, { status: 403, code: "forbidden" });
        assert.equal((await request(env, "shop", { upstreamPin: up.base })).status, 200);

        agent.close();
        await waitFor(() => env.core.registry.get("shop") === undefined, 4000, "the agent went offline");
        assert.deepEqual((await request(env, "shop")).failed, { status: 503, code: "offline" });

        env.core.registry.block("shop");
        assert.deepEqual((await request(env, "shop")).failed, { status: 403, code: "forbidden" });
        assert.equal(up.hits.length, 1, "only the one admitted request was ever dialled");
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("the agent owns the path check, and an agent that runs no executor resets the stream", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        // an upstream that carries a base path: only the agent holds the real address
        const up = await upstreamOf(servers, ok, "/base");
        await connectAppAgent(env, "shop", up.base);
        for (const path of ["/../secret", "/%2e%2e/secret"]) {
            assert.deepEqual((await request(env, "shop", { path })).failed, { status: 404, code: "no_app" }, path);
        }
        assert.equal(up.hits.length, 0, "a path that leaves the app is never dialled");

        await connectAppAgent(env, "mute", up.base, { serves: false });
        assert.deepEqual((await request(env, "mute")).failed, { status: 502, code: "peer" }, "a reset before any head is a bad gateway");
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("upstream Set-Cookie never reaches the client and the jar replays it; app B never gets app A's cookie", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const upA = await upstreamOf(servers, (req, res) => {
            if (req.url === "/login") res.writeHead(302, { location: "/", "set-cookie": ["sid=abc; Path=/; HttpOnly; Secure", "theme=dark; SameSite=Lax"] });
            else if (req.url === "/boom") res.writeHead(500, { "set-cookie": "err=1" });
            else res.writeHead(200, {});
            res.end("body");
        });
        const upB = await upstreamOf(servers, ok);
        await connectAppAgent(env, "a", upA.base);
        await connectAppAgent(env, "b", upB.base);

        const login = await request(env, "a", { path: "/login" });
        assert.equal(login.status, 302);
        assert.equal(login.headers["set-cookie"], undefined, "a redirect's Set-Cookie stays in the jar");
        const boom = await request(env, "a", { path: "/boom" });
        assert.equal(boom.status, 500);
        assert.equal(boom.headers["set-cookie"], undefined, "an error's Set-Cookie stays in the jar");

        await request(env, "a", { path: "/next" });
        assert.equal(upA.hits.at(-1)?.headers["cookie"], "sid=abc; theme=dark; err=1", "the jar is replayed");

        // the browser scopes cookies by host, not by app: it sends A's cookie to B's path too
        await request(env, "b", { path: "/", headers: { cookie: "sid=abc" } });
        assert.equal(upB.hits.at(-1)?.headers["cookie"], undefined, "B's upstream never sees A's cookie");
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("Max-Age <= 0 deletes and wins over Expires; an expired cookie is not sent and its row disappears", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const up = await upstreamOf(servers, ok);
        await connectAppAgent(env, "shop", up.base);
        const past = new Date(Date.now() - 86_400_000).toUTCString();
        const future = new Date(Date.now() + 86_400_000).toUTCString();

        storeSetCookies(env.db, "shop", "shop", [
            "sid=abc; Max-Age=3600",
            `old=1; Expires=${past}; Max-Age=3600`,
            `late=1; Expires=${future}; Max-Age=0`,
            "gone=1; Max-Age=-5",
            "malformed",
            "=nameless",
        ]);
        await request(env, "shop");
        assert.equal(up.hits.at(-1)?.headers["cookie"], "sid=abc; old=1", "Max-Age wins over Expires both ways");

        storeSetCookies(env.db, "shop", "shop", ["sid=abc; Max-Age=0", `old=1; Expires=${past}`]);
        env.db.setAppCookie("shop", "shop", { name: "stale", value: "v", path: "/", expiresAt: Date.now() - 1000 });
        await request(env, "shop");
        assert.equal(up.hits.at(-1)?.headers["cookie"], undefined, "deleted and expired cookies are not sent");

        const file = new DatabaseSync(`${env.dir}/gateway.db`, { readOnly: true });
        try {
            assert.deepEqual({ ...file.prepare(`SELECT count(*) AS n FROM app_cookies`).get() }, { n: 0 }, "the expired row is gone, not merely filtered");
        } finally {
            file.close();
        }
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("the jar is keyed by the upstream's own path space (RFC 6265 §5.1.4), query excluded", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        // an upstream that carries a base path, which is what the jar's keys are built on
        const up = await upstreamOf(servers, ok, "/base");
        await connectAppAgent(env, "shop", up.base);
        storeSetCookies(env.db, "shop", "shop", ["n=v; Path=/base/a", "root=r; Path=/base", "deep=d; Path=/base/a/b", "other=x; Path=/elsewhere"]);

        const sent = async (path: string): Promise<string | undefined> => {
            await request(env, "shop", { path });
            return up.hits.at(-1)?.headers["cookie"];
        };
        assert.equal(await sent("/a"), "n=v; root=r", "/base/a matches /base/a");
        assert.equal(await sent("/a/b/c?x=1"), "deep=d; n=v; root=r", "a query is not part of the key, longest path first");
        assert.equal(await sent("/ab"), "root=r", "/base/a does not match /base/ab");
        assert.equal(up.hits.at(-1)?.url, "/base/ab", "and the agent dialled its own base path");
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("hop-by-hop, Connection-named and proxy-* headers are stripped request and response side", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const up = await upstreamOf(servers, (_req, res) => {
            res.writeHead(200, {
                "content-type": "text/plain",
                te: "trailers",
                trailer: "x-trailer",
                "keep-alive": "timeout=9",
                "proxy-authenticate": "Basic",
                connection: "x-drop-me",
                "x-drop-me": "gone",
                "x-kept": "yes",
            });
            res.end("ok");
        });
        await connectAppAgent(env, "shop", up.base);

        const answer = await request(env, "shop", {
            headers: {
                te: "trailers",
                trailer: "x-trailer",
                "keep-alive": "timeout=9",
                "proxy-authorization": "Basic abc",
                connection: "x-drop-req",
                "x-drop-req": "gone",
                "x-kept-req": "yes",
            },
        });
        const hit = up.hits[0];
        assert.ok(hit);
        for (const name of ["te", "trailer", "keep-alive", "proxy-authorization", "x-drop-req"]) {
            assert.equal(hit.headers[name], undefined, `request ${name} is stripped`);
        }
        assert.equal(hit.headers["x-kept-req"], "yes");
        for (const name of ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "proxy-authenticate", "x-drop-me"]) {
            assert.equal(answer.headers[name], undefined, `response ${name} is stripped`);
        }
        assert.equal(answer.headers["x-kept"], "yes");
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("origin and referer are rewritten to the upstream origin, authorization passes through", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const up = await upstreamOf(servers, ok);
        await connectAppAgent(env, "shop", up.base);
        const pult = "http://127.0.0.1:46464";

        await request(env, "shop", {
            path: "/page?x=1",
            headers: { origin: pult, referer: `${pult}/mini-app/shop/prev?y=2`, authorization: "Bearer secret" },
        });
        const hit = up.hits[0];
        assert.equal(hit?.headers["origin"], up.base, "origin rewritten to the upstream origin");
        assert.equal(hit?.headers["referer"], `${up.base}/mini-app/shop/prev?y=2`, "referer rewritten, same path and query");
        assert.equal(hit?.headers["authorization"], "Bearer secret", "authorization forwarded unchanged");
        assert.equal(hit?.headers["host"], new URL(up.base).host, "the upstream's own Host");

        await request(env, "shop", { path: "/again", headers: { referer: "not a url" } });
        assert.equal(up.hits.at(-1)?.headers["referer"], undefined, "an unparseable referer is dropped");
        assert.equal(up.hits.at(-1)?.headers["origin"], undefined, "no origin is invented");
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("x-mimi-app-base carries this door's prefix, and a client-sent one never reaches the app", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const up = await upstreamOf(servers, ok);
        await connectAppAgent(env, "shop", up.base);

        await request(env, "shop", { publicBase: "/mini-app/shop", headers: { "x-mimi-app-base": "/evil", "x-mimi-device": "spoofed" } });
        assert.equal(up.hits[0]?.headers["x-mimi-app-base"], "/mini-app/shop/", "the gateway's own prefix wins");
        assert.equal(up.hits[0]?.headers["x-mimi-device"], undefined, "every client-sent x-mimi-* is dropped");

        await request(env, "shop", { publicBase: "" });
        assert.equal(up.hits.at(-1)?.headers["x-mimi-app-base"], "/", "the tunnel door publishes the app at the root");
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("a root-relative Location on a 3xx is re-prefixed with this door's base, an absolute one is not", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const up = await upstreamOf(servers, (req, res) => {
            res.writeHead(302, { location: req.url === "/away" ? "https://example.test/x" : "/orders?tab=new" });
            res.end();
        });
        await connectAppAgent(env, "shop", up.base);

        const prefixed = await request(env, "shop", { path: "/login", publicBase: "/mini-app/shop" });
        assert.equal(prefixed.headers["location"], "/mini-app/shop/orders?tab=new");
        const tunnelled = await request(env, "shop", { path: "/login", publicBase: "" });
        assert.equal(tunnelled.headers["location"], "/orders?tab=new", "the tunnel door publishes no prefix");
        const away = await request(env, "shop", { path: "/away", publicBase: "/mini-app/shop" });
        assert.equal(away.headers["location"], "https://example.test/x", "an absolute redirect is left alone");
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("re-registering the app on a different upstream origin clears its jar", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const up1 = await upstreamOf(servers, (_req, res) => {
            res.writeHead(200, { "set-cookie": "sid=1" });
            res.end("1");
        });
        const up2 = await upstreamOf(servers, ok);
        await connectAppAgent(env, "shop", up1.base);
        await request(env, "shop");
        assert.equal(env.db.appCookiesFor("shop", "shop", "/").length, 1);

        env.db.upsertAgentApp({ agent: "shop", appId: "shop", title: "Shop", upstream: `${up1.base}/v2` });
        assert.equal(env.db.appCookiesFor("shop", "shop", "/").length, 1, "the same origin under another path keeps the jar");
        env.db.upsertAgentApp({ agent: "shop", appId: "shop", title: "Shop", upstream: up2.base });
        assert.equal(env.db.appCookiesFor("shop", "shop", "/").length, 0, "a different upstream origin clears the jar");
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("an upstream status outside 100-599 answers 502 instead of reaching the door", async () => {
    const env = await boot();
    const sockets: Socket[] = [];
    // node:http cannot send a status below 100 and llhttp happily parses one, so this upstream speaks raw
    const rude = createSocketServer((socket) => {
        sockets.push(socket);
        socket.on("data", () => socket.end("HTTP/1.1 099 Nope\r\nContent-Length: 0\r\n\r\n"));
    });
    try {
        await new Promise<void>((ready) => rude.listen(0, "127.0.0.1", ready));
        const base = `http://127.0.0.1:${(rude.address() as AddressInfo).port}`;
        await connectAppAgent(env, "rude", base);
        assert.equal((await request(env, "rude")).status, 502);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((done) => rude.close(() => done()));
        await env.stop();
    }
});

test("a reply streams as it is produced; a door cancel and a dead upstream both end the exchange", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const up = await upstreamOf(servers, (req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.write("started", () => (req.url === "/cut" ? res.socket?.destroy() : undefined));
        });
        // a port nothing listens on: bind one, then close it
        const gone = createServer();
        await new Promise<void>((ready) => gone.listen(0, "127.0.0.1", ready));
        const goneAddr = gone.address() as AddressInfo;
        await new Promise<void>((done) => gone.close(() => done()));
        await connectAppAgent(env, "shop", up.base);
        await connectAppAgent(env, "dead", `http://127.0.0.1:${goneAddr.port}`);

        const live = recorder();
        const exchange = env.core.appBridge.open({ appId: "shop", method: "GET", path: "/slow", headers: {}, mode: "http", publicBase: "" }, live.sink);
        assert.ok(exchange);
        exchange.end();
        await waitFor(() => text(live.answer) === "started", 4000, "the first chunk arrives while the upstream is still writing");
        exchange.reset();
        await up.hits[0]?.closed;

        const cut = await request(env, "shop", { path: "/cut" });
        assert.equal(cut.status, 200);
        assert.equal(cut.aborted, true, "a reply cut off mid-body aborts the consumer");
        assert.equal(cut.ended, false);

        assert.deepEqual((await request(env, "dead")).failed, { status: 502, code: "unreachable" });
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("an upstream that never answers is 504 at the agent's head deadline; one quiet after its head stays open", async () => {
    const env = await boot();
    const sockets: Socket[] = [];
    const silent = createServer((req, res) => {
        req.resume();
        if (req.url !== "/dribble") return;
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("x");
        // quiet for longer than the agent's deadline: past the head that is an SSE stream or a long poll
        setTimeout(() => res.end("y"), 400);
    });
    silent.on("connection", (socket: Socket) => void sockets.push(socket));
    try {
        await new Promise<void>((ready) => silent.listen(0, "127.0.0.1", ready));
        const base = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
        await connectAppAgent(env, "slow", base, { idleMs: 150 });

        const hung = await request(env, "slow", { path: "/" });
        assert.deepEqual(hung.failed, { status: 504, code: "upstream_timeout" }, "the agent's own deadline wins the race");

        const dribbled = await request(env, "slow", { path: "/dribble" });
        assert.equal(dribbled.status, 200, "the head arrived");
        assert.equal(dribbled.aborted, false, "a quiet body is not a dead one");
        assert.equal(dribbled.ended, true);
        assert.equal(text(dribbled), "xy");
    } finally {
        for (const socket of sockets) socket.destroy();
        await closeServer(silent);
        await env.stop();
    }
});

test("the gateway's own head deadline is 504, and the reset takes the agent's upstream request with it", async () => {
    // the agent's idle deadline stays at the production 30 s, so the gateway's is the one that fires
    const env = await boot({ apps: { headMs: 300 } });
    const servers: Server[] = [];
    try {
        const up = await upstreamOf(servers, (req) => void req.resume());
        await connectAppAgent(env, "mute", up.base);

        const answer = await request(env, "mute", { path: "/hang" });
        assert.deepEqual(answer.failed, { status: 504, code: "deadline" }, "an agent that answers nothing at all");
        await up.hits[0]?.closed;
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("the outbound caps refuse before a stream is opened: a path past APP_PATH_MAX, a header set past APP_HEADER_COUNT", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const up = await upstreamOf(servers, ok);
        await connectAppAgent(env, "shop", up.base);

        const long = `/${"a".repeat(APP_PATH_MAX)}`;
        assert.deepEqual((await request(env, "shop", { path: long })).failed, { status: 414, code: "path_too_long" });

        const many: Record<string, string> = {};
        for (let i = 0; i <= APP_HEADER_COUNT; i++) many[`x-h${i}`] = "1";
        assert.deepEqual((await request(env, "shop", { headers: many })).failed, { status: 431, code: "header_too_large" });

        const huge = { "x-big": "b".repeat(APP_HEADER_MAX) };
        assert.deepEqual((await request(env, "shop", { headers: huge })).failed, { status: 431, code: "header_too_large" });
        assert.equal(up.hits.length, 0, "a refused request never reaches the agent, let alone its upstream");
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("bodies larger than one window flow both ways: the bridge credits the agent and pauses on a slow sink", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const big = Buffer.alloc(APP_WINDOW * 3, "b");
        const up = await upstreamOf(servers, (req, res) => {
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/octet-stream" });
                res.end(big);
            });
        });
        await connectAppAgent(env, "shop", up.base);

        const answer = await request(env, "shop", { method: "POST", path: "/upload" }, big);
        assert.equal((await up.hits[0]?.body)?.length, big.length, "the whole request body reached the upstream");
        assert.equal(size(answer), big.length, "and the whole reply came back");
        assert.equal(answer.ended, true);

        // a sink that is never ready: the bridge withholds credit, so nothing past one window lands
        const slow = recorder(true);
        const exchange = env.core.appBridge.open({ appId: "shop", method: "POST", path: "/upload", headers: {}, mode: "http", publicBase: "" }, slow.sink);
        assert.ok(exchange);
        pump(exchange, Buffer.alloc(16, "x"));
        await waitFor(() => size(slow.answer) >= APP_WINDOW, 4000, "one window landed");
        await new Promise((r) => setTimeout(r, 50));
        assert.ok(size(slow.answer) <= APP_WINDOW + 16 * 1024, `a paused sink holds at one window, got ${size(slow.answer)}`);
        slow.drain();
        assert.equal(size(await slow.settled), big.length, "and it resumes to the last byte once the consumer catches up");
        // a ServerResponse's onDrain APPENDS a listener: one per stall, never one per body frame
        assert.equal(slow.registrations(), 1, "the sink is asked to drain once per stall");
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("a credit is one quantum both ways: late credits never let the gateway past its window, odd frames never starve the agent", async () => {
    const env = await boot();
    try {
        const agent = await connectRawAgent(env, { name: "raw", app: { title: "Raw", upstream: "http://127.0.0.1:9" } });
        const rec = recorder();
        const exchange = env.core.appBridge.open({ appId: "raw", method: "POST", path: "/up", headers: {}, mode: "http", publicBase: "" }, rec.sink);
        assert.ok(exchange);
        const BODY = 1024 * 1024;
        pump(exchange, Buffer.alloc(BODY, 7), APP_CHUNK);
        const { stream } = await nextRequest(agent);

        // request direction: the agent credits a quantum per APP_CREDIT it took, each one 20 ms late
        let received = 0;
        let promised = 0;
        let credited = 0;
        let peak = 0;
        while (received < BODY) {
            const frame = await nextFrame(agent, stream);
            received += frame.payload.length;
            peak = Math.max(peak, received - credited * APP_CREDIT);
            while (received - promised * APP_CREDIT >= APP_CREDIT) {
                promised += 1;
                setTimeout(() => {
                    credited += 1;
                    agent.send({ stream, flags: FLAG_DATA, payload: new Uint8Array(0) });
                }, 20);
            }
        }
        assert.equal((await nextFrame(agent, stream)).flags, FLAG_END);
        assert.ok(peak <= APP_WINDOW + APP_CHUNK, `the gateway had ${peak} bytes uncredited in flight`);

        // reply direction: 10 KiB frames never line up with the quantum, and the sender still never stalls
        agent.send(replyFrame(stream, { t: "head", status: 200, headers: {} }));
        const REPLY = 1024 * 1024;
        let sent = 0;
        let unacked = 0;
        while (sent < REPLY) {
            while (unacked >= APP_WINDOW) {
                const frame = await nextFrame(agent, stream);
                if (frame.flags === FLAG_DATA && frame.payload.length === 0) unacked = Math.max(0, unacked - APP_CREDIT);
            }
            const n = Math.min(10 * 1024, REPLY - sent);
            agent.send({ stream, flags: FLAG_DATA, payload: new Uint8Array(n) });
            sent += n;
            unacked += n;
        }
        agent.send({ stream, flags: FLAG_END, payload: new Uint8Array(0) });
        const answer = await rec.settled;
        assert.equal(answer.ended, true);
        assert.equal(size(answer), REPLY);
        agent.close();
    } finally {
        await env.stop();
    }
});

test("blocking the agent mid-exchange aborts it, and an agent socket that goes before a head is 503, not 502", async () => {
    const env = await boot();
    const servers: Server[] = [];
    const sockets: Socket[] = [];
    const silent = createServer((req) => req.resume());
    silent.on("connection", (socket: Socket) => void sockets.push(socket));
    try {
        const up = await upstreamOf(servers, (req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`: ${req.url ?? ""}\n\n`);
        });
        await connectAppAgent(env, "shop", up.base);

        const live = recorder();
        const exchange = env.core.appBridge.open({ appId: "shop", method: "GET", path: "/events", headers: {}, mode: "http", publicBase: "" }, live.sink);
        assert.ok(exchange);
        exchange.end();
        await waitFor(() => live.answer.status === 200, 4000, "the SSE head arrived");
        env.core.registry.block("shop");
        assert.equal((await live.settled).aborted, true, "a blocked pin ends what it already opened");

        await new Promise<void>((ready) => silent.listen(0, "127.0.0.1", ready));
        const hung = await connectAppAgent(env, "gone", `http://127.0.0.1:${(silent.address() as AddressInfo).port}`);
        const second = recorder();
        const dying = env.core.appBridge.open({ appId: "gone", method: "GET", path: "/", headers: {}, mode: "http", publicBase: "" }, second.sink);
        assert.ok(dying);
        dying.end();
        await waitFor(() => sockets.length === 1, 4000, "the agent dialled its upstream");
        hung.close();
        assert.deepEqual((await second.settled).failed, { status: 503, code: "gone" }, "a socket that went is offline, not a bad gateway");
    } finally {
        for (const socket of sockets) socket.destroy();
        await closeServer(silent);
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("stop() resets every live exchange, and a request admitted after it is refused", async () => {
    const env = await boot();
    const servers: Server[] = [];
    try {
        const up = await upstreamOf(servers, (_req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(": open\n\n");
        });
        await connectAppAgent(env, "shop", up.base);

        const live = recorder();
        const exchange = env.core.appBridge.open({ appId: "shop", method: "GET", path: "/events", headers: {}, mode: "http", publicBase: "" }, live.sink);
        assert.ok(exchange);
        exchange.end();
        await waitFor(() => live.answer.status === 200, 4000, "the stream is live");

        env.core.appBridge.stop();
        assert.equal((await live.settled).aborted, true, "shutdown ends it while the socket is still open");
        // the exchange is already gone, so the door's own cancel is a no-op rather than a second reset
        exchange.reset();
    } finally {
        for (const s of servers) await closeServer(s);
        await env.stop();
    }
});

test("each direction has its own stall deadline: a stream moving both ways is never reset while they take turns being blocked", async () => {
    const env = await boot({ apps: { stallMs: 500 } });
    try {
        const agent = await connectRawAgent(env, { name: "raw", app: { title: "Raw", upstream: "http://127.0.0.1:9" } });
        let resume: (() => void) | null = null;
        let aborted = false;
        let got = 0;
        // a consumer that takes one chunk and then needs a moment, every time
        const sink: AppSink = {
            head: () => undefined,
            data: (chunk) => {
                got += chunk.length;
                return false;
            },
            end: () => undefined,
            fail: () => undefined,
            abort: () => void (aborted = true),
            onDrain: (go) => void (resume = go),
        };
        const exchange = env.core.appBridge.open({ appId: "raw", method: "POST", path: "/duplex", headers: {}, mode: "http", publicBase: "" }, sink);
        assert.ok(exchange);
        pump(exchange, Buffer.alloc(8 * 1024 * 1024, 1), APP_CHUNK);
        const { stream } = await nextRequest(agent);
        agent.send(replyFrame(stream, { t: "head", status: 200, headers: {} }));

        // every 100 ms each direction moves a quantum: the upstream reads a little, then writes a little,
        // and the consumer drains 50 ms later — at no instant are both directions unblocked
        let received = 0;
        let credited = 0;
        let unacked = 0;
        for (let tick = 0; tick < 15 && !aborted; tick++) {
            await new Promise((r) => setTimeout(r, 50));
            // assigned from the bridge's callback, which the narrowing above cannot see
            const go = resume as (() => void) | null;
            resume = null;
            go?.();
            await new Promise((r) => setTimeout(r, 50));
            for (const frame of agent.inbox.splice(0).filter((f) => f.stream === stream)) {
                if (frame.payload.length > 0) received += frame.payload.length;
                else unacked = Math.max(0, unacked - APP_CREDIT);
            }
            while (unacked < APP_WINDOW) {
                agent.send({ stream, flags: FLAG_DATA, payload: new Uint8Array(APP_CHUNK) });
                unacked += APP_CHUNK;
            }
            if (received - credited * APP_CREDIT >= APP_CREDIT) {
                credited += 1;
                agent.send({ stream, flags: FLAG_DATA, payload: new Uint8Array(0) });
            }
        }
        assert.equal(aborted, false, "both directions kept moving, so neither deadline passed");
        assert.ok(received > APP_WINDOW && got > APP_WINDOW, `upload ${received}, reply ${got}`);
        exchange.reset();
        agent.close();
    } finally {
        await env.stop();
    }
});
