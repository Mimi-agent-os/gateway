/** The `/mini-app/:appId/*` door: what a browser makes necessary around one bridge exchange — the
 *  Host and CSRF checks, the ticket redemption, the response-header policy and its HTML pages. */

import { STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { isAgentName } from "@mimi-os/protocol";

import type { AppSink } from "../apps/bridge.ts";
import { appCookieName, APP_TICKET_PARAM } from "../apps/tickets.ts";
import type { GatewayCore } from "../core.ts";
import { devUiPort, isLoopbackHost } from "../flags.ts";

/** The one prefix every miniapp is published under — also the Tauri frame guard's (app/tauri). */
export const MINI_APP_PREFIX = "/mini-app";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const METHOD = /^[A-Z]{1,16}$/;

/** Written after the app's own cleaned headers and OVERRIDING them, so one owner decides each: an
 *  app may neither re-open framing nor cache itself onto the pult's origin. Never on a 101. */
const RESPONSE_HEADERS = {
    "content-security-policy": "frame-ancestors 'self'",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
};

const page = (title: string, line: string): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;` +
    `font:14px system-ui,sans-serif;color:#444;background:#fafafa}p{max-width:32em;text-align:center}` +
    `</style></head><body><p><strong>${title}</strong><br>${line}</p></body></html>`;

/** The frame must show something, so every refusal this door can answer has a page of its own. */
const PAGES = new Map<number, string>([
    [403, page("Session expired", "Relaunch this interface from the mimi app.")],
    [404, page("No such app", "Nothing in the catalog is published at this address.")],
    [414, page("Address too long", "This app was asked for a path the gateway will not carry.")],
    [431, page("Too many headers", "This request carries more headers than the gateway will carry.")],
    [501, page("Not implemented", "This app was asked for something the gateway does not carry.")],
    [502, page("This app's server is unreachable", "The agent is running, but its own HTTP server did not answer. Start it and reload.")],
    [503, page("This interface is offline", "Its agent is not connected. Start the agent and reload.")],
    [504, page("This app's server timed out", "The agent is running, but its own HTTP server did not answer in time.")],
]);
const FORBIDDEN = page("Forbidden", "This request is not addressed to this app.");

function refuse(req: IncomingMessage, res: ServerResponse, status: number, body = PAGES.get(status) ?? FORBIDDEN): void {
    req.resume();
    const html = Buffer.from(body, "utf8");
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": html.length, ...RESPONSE_HEADERS });
    res.end(html);
}

/** An upgrade has no HTML to show: the bare shape listeners.ts refuses an unknown upgrade with. */
function refuseUpgrade(duplex: Duplex, status: number): true {
    duplex.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => duplex.destroy());
    return true;
}

/** The origin this request was actually addressed to, or null. The pult answers at 127.0.0.1 AND
 *  at localhost and the frame inherits whichever the owner typed, so the hostname is checked by
 *  shape; the exact port is what still refuses DNS rebinding. An absolute-form request target
 *  would name another origin, so the target is re-resolved against this one. */
export function doorOrigin(req: IncomingMessage, port: number): string | null {
    const host = req.headers.host;
    const parsed = host === undefined ? null : URL.parse(`http://${host}`);
    if (parsed === null || !isLoopbackHost(parsed.hostname) || Number(parsed.port || 80) !== port) return null;
    const origin = `http://${parsed.host}`;
    return URL.parse(req.url ?? "/", origin)?.origin === origin ? origin : null;
}

/** An origin a page of this machine's pult may carry: this listener's port, or the vite dev one. */
function acceptedOrigin(sent: string | undefined, port: number): boolean {
    const origin = sent === undefined ? null : URL.parse(sent);
    if (origin === null || origin.protocol !== "http:" || !isLoopbackHost(origin.hostname)) return false;
    const from = Number(origin.port || 80);
    return from === port || from === devUiPort();
}

const appIdOf = (pathname: string): string => pathname.slice(MINI_APP_PREFIX.length + 1).split("/")[0] ?? "";

export function serveMiniApp(
    core: GatewayCore,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    port: number,
): void {
    if (doorOrigin(req, port) === null) return refuse(req, res, 403, FORBIDDEN);
    const appId = appIdOf(url.pathname);
    if (!isAgentName(appId)) return refuse(req, res, 404);
    const publicBase = `${MINI_APP_PREFIX}/${appId}`;
    // load-bearing: relative URLs inside the app's HTML resolve only under the trailing slash, and
    // so does the cookie Path the next step sets
    if (url.pathname === publicBase) {
        req.resume();
        res.writeHead(302, { location: `${publicBase}/${url.search}`, ...RESPONSE_HEADERS });
        res.end();
        return;
    }
    // node's parser accepts M-SEARCH; the wire contract says the front door validated the method
    if (!METHOD.test(method)) return refuse(req, res, 501);

    const session = core.appTickets.match(appId, req.headers.cookie);
    const ticket = url.searchParams.get(APP_TICKET_PARAM);
    if (ticket !== null) {
        // the token is spent either way; a caller already holding the cookie may walk the link again
        const entered = core.appTickets.redeem(appId, ticket) ?? session;
        if (entered === null) return refuse(req, res, 403);
        req.resume();
        url.searchParams.delete(APP_TICKET_PARAM);
        const cookies = [`${appCookieName(entered.id)}=${entered.secret}; Path=${publicBase}/; HttpOnly; SameSite=Strict`];
        // cookies an earlier gateway process left behind name no live session: clear them here
        for (const id of core.appTickets.stale(req.headers.cookie)) {
            cookies.push(`${appCookieName(id)}=; Path=${publicBase}/; Max-Age=0`);
        }
        res.writeHead(302, { location: `${url.pathname}${url.search}`, "set-cookie": cookies, ...RESPONSE_HEADERS });
        res.end();
        return;
    }
    if (session === null) return refuse(req, res, 403);
    // the jar makes an unsafe request the owner's own, so its source has to be a page of this origin
    const site = req.headers["sec-fetch-site"];
    const sourced =
        req.headers.origin === undefined
            ? site === "same-origin" || site === "none"
            : acceptedOrigin(req.headers.origin, port);
    if (!SAFE_METHODS.has(method) && !sourced) return refuse(req, res, 403, FORBIDDEN);
    const path = `${url.pathname.slice(publicBase.length)}${url.search}`;

    let answered = false;
    const sink: AppSink = {
        head: (status, headers) => {
            // x-frame-options would contradict frame-ancestors 'self' in older engines, and node —
            // not the app — frames the body: a content-length of the app's own choosing would let
            // it declare one length, write another, and smuggle a second answer onto this socket
            const { "x-frame-options": _framing, "content-length": _length, ...rest } = headers;
            res.writeHead(status, { ...rest, ...RESPONSE_HEADERS });
            // node holds a head until the first body byte; an SSE stream has none until its first event
            res.flushHeaders();
        },
        data: (chunk) => res.write(chunk),
        end: () => {
            answered = true;
            res.end();
        },
        fail: (status) => {
            answered = true;
            refuse(req, res, status);
        },
        abort: () => {
            answered = true;
            res.destroy();
        },
        onDrain: (resume) => void res.once("drain", resume),
    };
    const exchange = core.appBridge.open(
        { appId, method, path, headers: req.headers, mode: "http", publicBase, upstreamPin: session.upstream },
        sink,
    );
    if (exchange === null) return;
    // the session died under this request — its device revoked, or the gateway stopping — so the
    // answer ends with it: a page while nothing has been written, a destroyed stream after
    const release = core.appTickets.hold(session.id, () => {
        exchange.reset();
        if (res.headersSent) sink.abort();
        else sink.fail(403, "session_closed");
    });
    req.on("data", (chunk: Buffer) => {
        if (exchange.write(chunk)) return;
        req.pause();
        exchange.onDrain(() => req.resume());
    });
    req.on("end", () => exchange.end());
    // ServerResponse emits close on a NORMAL completion too: only an unanswered one is a cancel
    res.on("close", () => {
        release();
        if (!answered) exchange.reset();
    });
}

/** The `/mini-app` branch of `server.on("upgrade")`, built only where the loopback HTTP handler is
 *  (main.ts). false = the target names no app at all, so the listener answers its own bare 404. */
export function miniAppUpgrade(
    core: GatewayCore,
    port: number,
): (req: IncomingMessage, duplex: Duplex, head: Buffer) => boolean {
    return (req, duplex, head) => {
        const url = URL.parse(req.url ?? "/", "http://localhost");
        const appId = url === null ? "" : appIdOf(url.pathname);
        if (url === null || !isAgentName(appId)) return false;
        // node hands the upgrade socket over with no 'error' listener: a peer RST would be fatal
        duplex.on("error", () => duplex.destroy());
        if (doorOrigin(req, port) === null) return refuseUpgrade(duplex, 403);
        const method = req.method ?? "GET";
        if (!METHOD.test(method)) return refuseUpgrade(duplex, 501);
        const session = core.appTickets.match(appId, req.headers.cookie);
        if (session === null) return refuseUpgrade(duplex, 403);
        // an upgrade is never a "safe" method, so the Origin itself has to be one of the pult's
        if (!acceptedOrigin(req.headers.origin, port)) return refuseUpgrade(duplex, 403);
        const publicBase = `${MINI_APP_PREFIX}/${appId}`;
        const path = `${url.pathname.slice(publicBase.length)}${url.search}`;
        if (!path.startsWith("/")) return refuseUpgrade(duplex, 404);

        let upgraded = false;
        let answered = false;
        const sink: AppSink = {
            head: (status, headers) => {
                upgraded = status === 101;
                // a non-101 keeps no upgrade: this sink owns a raw socket, so the message is close-delimited
                const { "content-length": _length, "transfer-encoding": _encoding, ...rest } = headers;
                const fields = upgraded ? headers : { ...rest, connection: "close" };
                const lines = Object.entries(fields).flatMap(([name, value]) => [value].flat().map((v) => `${name}: ${v}\r\n`));
                duplex.write(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n${lines.join("")}\r\n`);
            },
            data: (chunk) => duplex.write(chunk),
            end: () => {
                answered = true;
                if (upgraded) duplex.end();
                else duplex.end(() => duplex.destroy());
            },
            fail: (status) => {
                answered = true;
                refuseUpgrade(duplex, status);
            },
            abort: () => {
                answered = true;
                duplex.destroy();
            },
            onDrain: (resume) => void duplex.once("drain", resume),
        };
        const exchange = core.appBridge.open(
            { appId, method, path, headers: req.headers, mode: "upgrade", publicBase, upstreamPin: session.upstream },
            sink,
        );
        if (exchange === null) return true;
        // the session died under this request: the socket goes with it, handshake completed or not
        const release = core.appTickets.hold(session.id, () => {
            exchange.reset();
            sink.abort();
        });
        duplex.on("data", (chunk: Buffer) => {
            if (exchange.write(chunk)) return;
            duplex.pause();
            exchange.onDrain(() => duplex.resume());
        });
        // bytes that arrived with the handshake are this stream's first, through the same pump
        if (head.length > 0) duplex.unshift(head);
        duplex.on("end", () => exchange.end());
        duplex.on("close", () => {
            release();
            if (!answered) exchange.reset();
        });
        return true;
    };
}
