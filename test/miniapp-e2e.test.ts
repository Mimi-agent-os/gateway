/** The whole miniapp path in one file: the pult asks for a ticket over its device tunnel, the
 *  browser walks the entry link on the gateway's own origin, the bridge carries every exchange
 *  over the agent's /channel session, and the SDK's real executor dials a real node:http app
 *  shaped like a typical express app. Nothing here is stubbed but the browser. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import { APP_MAX_STREAMS, type AppStreamPort } from "@mimi-os/protocol";

import { boot, connectAppAgent, waitFor, type Env } from "./harness-env.ts";

const APP_ID = "e2e";
const DOOR = `/mini-app/${APP_ID}`;

const PAGE = '<!doctype html><html><head></head><body><script type="module" src="assets/x.js"></script></body></html>';

interface Hit {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
}

interface App {
    base: string;
    hits: Hit[];
    /** The SSE responses still open on this server, in the order they were opened. */
    live: ServerResponse[];
    /** When the slow reader saw the first byte of the upload, 0 until it does. */
    firstChunkAt: number;
    stop(): Promise<void>;
}

/** The agent's own HTTP server: a page that publishes its prefix, an asset, a deliberately slow
 *  upload reader, and an SSE stream the test drives tick by tick. */
async function boardApp(): Promise<App> {
    const hits: Hit[] = [];
    const live: ServerResponse[] = [];
    let firstChunkAt = 0;
    const server = createServer((req, res) => {
        hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
        const url = new URL(req.url ?? "/", "http://app.invalid");
        if (url.pathname === "/assets/x.js") {
            res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
            res.end("export const x = 1;\n");
            return;
        }
        if (url.pathname === "/write") {
            const parts: Buffer[] = [];
            req.on("data", (chunk: Buffer) => {
                firstChunkAt ||= Date.now();
                parts.push(chunk);
                req.pause();
                setTimeout(() => req.resume(), 5);
            });
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/octet-stream" });
                res.end(Buffer.concat(parts));
            });
            return;
        }
        if (url.pathname === "/events") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.flushHeaders(); // an SSE endpoint opens its stream before it has anything to say
            live.push(res);
            return;
        }
        // what a real app does: publish the prefix the gateway serves it under (x-mimi-app-base)
        const sent = String(req.headers["x-mimi-app-base"] ?? "/");
        const base = sent.startsWith("/") && !sent.startsWith("//") ? sent : "/";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "app_sid=s1; Path=/" });
        res.end(PAGE.replace("<head>", `<head><base href="${base}">`));
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("the app server has no address");
    return {
        base: `http://127.0.0.1:${addr.port}`,
        hits,
        live,
        get firstChunkAt() {
            return firstChunkAt;
        },
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
    body: Buffer;
}

/** node:http, not fetch: these tests write their own Cookie, Origin and Referer, stream a request
 *  body against backpressure, and destroy a response mid-answer. */
function send(
    env: Env,
    path: string,
    opts: { method?: string; headers?: Record<string, string> } = {},
): { req: ReturnType<typeof httpRequest>; response: Promise<IncomingMessage> } {
    const req = httpRequest({
        hostname: "127.0.0.1",
        port: env.port,
        path,
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
    });
    const response = new Promise<IncomingMessage>((resolve, reject) => {
        req.on("response", resolve);
        req.on("error", reject);
    });
    return { req, response };
}

async function browse(env: Env, path: string, headers: Record<string, string> = {}): Promise<Answer> {
    const { req, response } = send(env, path, { headers });
    req.end();
    const res = await response;
    const parts: Buffer[] = [];
    for await (const chunk of res) parts.push(chunk as Buffer);
    return { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) };
}

/** Everything a browser needs before it can reach the app: the agent, the ticket the pult asks for
 *  over its own device tunnel, and the cookie the entry link's 302 leaves behind. */
async function launch(env: Env, app: App, opts: { idleMs?: number } = {}): Promise<string> {
    await connectAppAgent(env, APP_ID, app.base, opts);
    const ticket = await env.api<{ url: string }>("POST", `/api/apps/${APP_ID}/ticket`, {});
    assert.equal(ticket.status, 200);
    const landed = await browse(env, ticket.json.url);
    assert.equal(landed.status, 302, "the ticket url is the entry link");
    assert.equal(landed.headers["location"], `${DOOR}/`);
    return (landed.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
}

/** Stream slots this agent session still has free: openAppStream refuses past APP_MAX_STREAMS, so
 *  a full count means every earlier exchange released its slot on both sides. */
function freeStreams(env: Env): number {
    const socket = env.core.registry.get(APP_ID)?.socket;
    if (!socket) return 0;
    const held: AppStreamPort[] = [];
    for (let port = socket.openAppStream(() => undefined); port; port = socket.openAppStream(() => undefined)) held.push(port);
    for (const port of held) port.reset();
    return held.length;
}

/** The SSE stream every cancellation test below opens, already answering. `cut` resolves once the
 *  browser's answer is over and says whether it was torn down rather than finished. */
async function events(env: Env, cookie: string, app: App): Promise<{ req: ReturnType<typeof httpRequest>; cut: Promise<boolean> }> {
    const { req, response } = send(env, `${DOOR}/events`, { headers: { cookie } });
    req.end();
    const res = await response;
    assert.equal(res.statusCode, 200);
    res.resume();
    const cut = new Promise<boolean>((over) => {
        // an answer the gateway destroyed errors here on its way to "close"; `complete` is the verdict
        res.on("error", () => undefined);
        res.on("close", () => over(!res.complete));
    });
    await waitFor(() => app.live.length === 1, 4000, "the upstream SSE response");
    return { req, cut };
}

test("the page: the pult's ticket becomes a same-origin frame the agent's own app answered", async () => {
    const env = await boot();
    const app = await boardApp();
    try {
        const cookie = await launch(env, app);
        const page = await browse(env, `${DOOR}/`, { cookie });
        assert.equal(page.status, 200);
        assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
        assert.equal(page.headers["content-security-policy"], "frame-ancestors 'self'");
        assert.equal(page.headers["cache-control"], "no-store");
        assert.equal(page.headers["referrer-policy"], "no-referrer");
        assert.equal(page.headers["x-content-type-options"], "nosniff");
        assert.equal(page.headers["set-cookie"], undefined, "the app's own cookie stays in the gateway's jar");
        assert.match(page.body.toString(), /<base href="\/mini-app\/e2e\/">/);
        assert.equal(app.hits.at(-1)?.url, "/", "the door stripped its own prefix");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("the asset: the page's relative src resolves under the prefix and comes back intact", async () => {
    const env = await boot();
    const app = await boardApp();
    try {
        const cookie = await launch(env, app);
        const page = await browse(env, `${DOOR}/`, { cookie });
        const src = /src="([^"]+)"/.exec(page.body.toString())?.[1] ?? "";
        // what the browser does with <base href> and a relative src
        const resolved = new URL(src, `${env.base}${DOOR}/`);
        assert.equal(resolved.href, `${env.base}${DOOR}/assets/x.js`);

        const asset = await browse(env, resolved.pathname, { cookie });
        assert.equal(asset.status, 200);
        assert.equal(asset.headers["content-type"], "application/javascript; charset=utf-8");
        assert.equal(asset.body.toString(), "export const x = 1;\n");
        assert.equal(app.hits.at(-1)?.url, "/assets/x.js");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("an upload streams to a slow reader while the browser is still writing, and is echoed back", async () => {
    const env = await boot();
    const app = await boardApp();
    try {
        const cookie = await launch(env, app);
        await browse(env, `${DOOR}/`, { cookie }); // the app's Set-Cookie lands in the jar here

        const body = Buffer.alloc(1024 * 1024, "mimi-os:");
        const { req, response } = send(env, `${DOOR}/write`, {
            method: "POST",
            headers: { cookie, origin: env.base, referer: `${env.base}${DOOR}/`, "content-type": "application/octet-stream" },
        });
        // the streaming proof: a body anything on the way buffered whole would never get past this line
        req.write(body.subarray(0, 64 * 1024));
        await waitFor(() => app.firstChunkAt > 0, 4000, "the app's first chunk");
        for (let at = 64 * 1024; at < body.length; at += 64 * 1024) {
            if (!req.write(body.subarray(at, at + 64 * 1024))) await once(req, "drain");
        }
        req.end();
        await once(req, "finish");
        const wroteAt = Date.now();

        const res = await response;
        const parts: Buffer[] = [];
        for await (const chunk of res) parts.push(chunk as Buffer);
        assert.equal(res.statusCode, 200);
        assert.ok(Buffer.concat(parts).equals(body), "a megabyte round-trips byte for byte");
        assert.ok(app.firstChunkAt < wroteAt, "the app was reading while the browser was still writing");

        const upload = app.hits.at(-1);
        assert.equal(upload?.headers["cookie"], "app_sid=s1", "the server-side jar, never the browser's own cookie");
        assert.equal(upload?.headers["origin"], app.base);
        assert.equal(upload?.headers["referer"], `${app.base}${DOOR}/`);
        assert.equal(upload?.headers["x-mimi-app-base"], `${DOOR}/`);
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("an SSE stream is delivered tick by tick, not held until the app is done", async () => {
    const env = await boot();
    const app = await boardApp();
    try {
        const cookie = await launch(env, app);
        const { req, response } = send(env, `${DOOR}/events`, { headers: { cookie } });
        req.end();
        const res = await response;
        assert.equal(res.statusCode, 200);
        let seen = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (seen += chunk));
        await waitFor(() => app.live.length === 1, 4000, "the upstream SSE response");

        const stream = app.live[0]!;
        stream.write("data: 1\n\n");
        stream.write("data: 2\n\n");
        await waitFor(() => seen === "data: 1\n\ndata: 2\n\n", 4000, "the first two ticks");
        stream.write("data: 3\n\n");
        await waitFor(() => seen.endsWith("data: 3\n\n"), 4000, "the third tick");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("an SSE stream outlives the agent's deadline, heartbeat or silence, and ends when its upstream does", async () => {
    const env = await boot();
    const app = await boardApp();
    try {
        const cookie = await launch(env, app, { idleMs: 200 });
        const { cut } = await events(env, cookie, app);
        let over = false;
        void cut.then(() => (over = true));

        const beat = setInterval(() => app.live[0]?.write(": ping\n\n"), 50);
        await new Promise((tick) => setTimeout(tick, 700));
        assert.equal(over, false, "traffic is never idle, however long the stream lives");

        clearInterval(beat);
        await new Promise((tick) => setTimeout(tick, 700));
        assert.equal(over, false, "past its head the deadline is gone: a quiet stream is a legitimate one");

        app.live[0]?.end();
        assert.equal(await cut, false, "the upstream ending is a complete answer, not a cut");
        assert.equal(app.hits.length, 1, "and the door opened nothing new");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("a browser that goes away mid-stream frees the upstream socket and the agent's stream slot", async () => {
    const env = await boot();
    const app = await boardApp();
    try {
        const cookie = await launch(env, app);
        assert.equal(freeStreams(env), APP_MAX_STREAMS, "nothing is live before the stream opens");

        const { req } = await events(env, cookie, app);
        const upstreamClosed = once(app.live[0]!, "close");
        req.destroy();
        await upstreamClosed;
        await waitFor(() => freeStreams(env) === APP_MAX_STREAMS, 4000, "the agent's stream slot comes back");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("revoking the agent's pin kills the stream it is answering and every way back in", async () => {
    const env = await boot();
    const app = await boardApp();
    try {
        const cookie = await launch(env, app);
        const { cut } = await events(env, cookie, app);

        assert.equal((await env.api("DELETE", `/api/pins/${APP_ID}`)).status, 200);
        assert.equal(await cut, true, "the answer in flight died with the pin");
        assert.equal((await browse(env, `${DOOR}/`, { cookie })).status, 403, "the session went with the pin");
        // the catalog row goes with the pin too, so the pult's next launch names an app nobody has
        assert.equal((await env.api("POST", `/api/apps/${APP_ID}/ticket`, {})).status, 404);
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("core.stop() tears a live stream down before the sockets under it go", async () => {
    const env = await boot();
    const app = await boardApp();
    try {
        const cookie = await launch(env, app);
        const { cut } = await events(env, cookie, app);
        const upstreamClosed = once(app.live[0]!, "close");

        await env.core.stop();
        assert.equal(await cut, true, "the exchange is reset, not left to the socket going out under it");
        await upstreamClosed;
    } finally {
        await app.stop();
        await env.stop();
    }
});
