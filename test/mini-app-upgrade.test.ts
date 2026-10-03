/** The /mini-app upgrade branch: a WebSocket handshake carried to the agent's own server over the
 *  agent channel, the refusals an upgrade has no HTML to show for, and what a non-101 upstream
 *  answer looks like on a raw duplex. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import test from "node:test";

import { FLAG_END } from "@mimi-os/protocol";

import { connectRawAgent, nextRequest, replyFrame } from "./agent-wire.ts";
import { boot, waitFor, type Env } from "./harness-env.ts";

interface Upstream {
    base: string;
    /** Every upgraded socket the app's own server took, newest last. */
    sockets: Socket[];
    stop(): Promise<void>;
}

/** The agent's own server: /ws upgrades and echoes in upper case, /plain refuses to upgrade. */
async function upstream(): Promise<Upstream> {
    const sockets: Socket[] = [];
    const server = createServer();
    server.on("upgrade", (req, duplex, head) => {
        const socket = duplex as Socket;
        sockets.push(socket);
        // a destroyed peer socket is how several of these tests END; it is not a failure
        socket.on("error", () => socket.destroy());
        if (new URL(req.url ?? "/", "http://upstream.invalid").pathname === "/plain") {
            socket.end("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\n\r\nplain");
            return;
        }
        socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                `Sec-WebSocket-Accept: ${String(req.headers["sec-websocket-key"] ?? "")}\r\n\r\n`,
        );
        if (head.length > 0) socket.write(head.toString("utf8").toUpperCase());
        socket.on("data", (c: Buffer) => socket.write(c.toString("utf8").toUpperCase()));
        // what a real WS server does when its peer half-closes: an http server socket is
        // allowHalfOpen, so without this the chain would stop at the FIN
        socket.on("end", () => socket.destroy());
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no upstream address");
    return {
        base: `http://127.0.0.1:${String(addr.port)}`,
        sockets,
        stop: async () => {
            for (const s of sockets) s.destroy();
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
        },
    };
}

interface Browser {
    socket: Socket;
    text(): string;
    until(match: RegExp, ms?: number): Promise<string>;
    closed(): boolean;
}

/** The browser's side of an upgrade, written by hand: `ws` would hide the status line. */
function dial(port: number, path: string, headers: Record<string, string>): Browser {
    const socket = connect(port, "127.0.0.1");
    let got = "";
    let done = false;
    // every refusal here ends with the gateway destroying this socket: an RST is the expected end
    socket.on("error", () => socket.destroy());
    socket.on("close", () => (done = true));
    socket.on("data", (c: Buffer) => (got += c.toString("utf8")));
    socket.on("connect", () => {
        const lines = Object.entries(headers)
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join("");
        socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n${lines}\r\n`);
    });
    return {
        socket,
        text: () => got,
        closed: () => done,
        until: async (match, ms = 4000) => {
            const t0 = Date.now();
            while (!match.test(got)) {
                if (Date.now() - t0 > ms) throw new Error(`never saw ${String(match)} in ${JSON.stringify(got)}`);
                await new Promise((r) => setTimeout(r, 5));
            }
            return got;
        },
    };
}

/** The cookie a launch of `name` leaves behind — what every upgrade below carries. */
async function cookieFor(env: Env, name: string): Promise<string> {
    const ticket = await env.api<{ url: string }>("POST", `/api/apps/${name}/ticket`, {});
    assert.equal(ticket.status, 200);
    const landed = await fetch(`${env.base}${ticket.json.url}`, { redirect: "manual" });
    assert.equal(landed.status, 302);
    const set = landed.headers.getSetCookie()[0] ?? "";
    return set.split(";")[0] ?? "";
}

/** A launched app behind the SDK's real executor, and its cookie. */
async function launched(env: Env, app: Upstream): Promise<string> {
    await env.connect({ name: "board", app: { title: "Board", entry: "/", upstream: app.base } });
    await waitFor(() => env.core.agent("board").connected, 4000, "board connected");
    return cookieFor(env, "board");
}

const handshake = (cookie: string, origin: string): Record<string, string> => ({
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
    "Sec-WebSocket-Version": "13",
    Origin: origin,
    Cookie: cookie,
});

test("an upgrade under /mini-app reaches the app's own server and pipes bytes both ways", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const cookie = await launched(env, app);
        const browser = dial(env.port, "/mini-app/board/ws", handshake(cookie, env.base));
        const head = await browser.until(/\r\n\r\n/);
        assert.match(head, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
        // connection and upgrade are hop-by-hop: without the re-add the handshake never completes
        assert.match(head, /\r\nconnection: Upgrade\r\n/i);
        assert.match(head, /\r\nupgrade: websocket\r\n/i);
        assert.match(head, /\r\nsec-websocket-accept: MDEyMzQ1Njc4OWFiY2RlZg==\r\n/i);
        assert.doesNotMatch(head, /content-security-policy|cache-control/i, "the overrides are meaningless on a 101");

        browser.socket.write("ping");
        await browser.until(/PING/);
        browser.socket.write("again");
        await browser.until(/AGAIN/);
        assert.equal(app.sockets.length, 1, "one upgrade, one upstream socket");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("an upgrade with no session cookie, or a foreign Origin, is refused and the socket destroyed", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const cookie = await launched(env, app);
        for (const headers of [handshake("", env.base), handshake(cookie, "http://evil.example")]) {
            const browser = dial(env.port, "/mini-app/board/ws", headers);
            const answer = await browser.until(/\r\n\r\n/);
            assert.match(answer, /^HTTP\/1\.1 403 Forbidden\r\n/);
            assert.match(answer, /Content-Length: 0/);
            await waitFor(() => browser.closed(), 4000, "the refused socket to close");
        }
        assert.equal(app.sockets.length, 0, "a refusal never reaches the app");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("closing the browser socket resets the stream and takes the upstream socket with it", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const cookie = await launched(env, app);
        const browser = dial(env.port, "/mini-app/board/ws", handshake(cookie, env.base));
        await browser.until(/^HTTP\/1\.1 101 /);
        const upstreamSocket = app.sockets[0];
        assert.ok(upstreamSocket);

        // the tab went: a reset, not a half-close: the duplex "close" branch
        browser.socket.resetAndDestroy();
        await waitFor(() => upstreamSocket.destroyed, 4000, "the app's socket to go with the browser's");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("a live upgraded socket goes when the session under it does", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const cookie = await launched(env, app);
        const browser = dial(env.port, "/mini-app/board/ws", handshake(cookie, env.base));
        await browser.until(/^HTTP\/1\.1 101 /);
        const upstreamSocket = app.sockets[0];
        assert.ok(upstreamSocket);

        // the owner revoked the device that launched this app: the socket has no session left to sit on
        const { id } = await env.device();
        assert.ok(env.core.devices.revoke(id).ok);
        await waitFor(() => browser.closed(), 4000, "the browser socket to go with the session");
        await waitFor(() => upstreamSocket.destroyed, 4000, "the app's socket to go with it");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("an upstream that answers 200 instead of 101 comes back as a close-delimited message", async () => {
    const env = await boot();
    const app = await upstream();
    try {
        const cookie = await launched(env, app);
        const browser = dial(env.port, "/mini-app/board/plain", handshake(cookie, env.base));
        const answer = await browser.until(/plain/);
        assert.match(answer, /^HTTP\/1\.1 200 OK\r\n/);
        assert.match(answer, /\r\nconnection: close\r\n/i);
        assert.doesNotMatch(answer, /content-length/i, "the sink owns a raw socket: the message is close-delimited");
        assert.ok(answer.endsWith("plain"));
        await waitFor(() => browser.closed(), 4000, "the duplex to be destroyed after the body");
    } finally {
        await app.stop();
        await env.stop();
    }
});

test("a crafted 101 writes no headers of the agent's own, and a refused upgrade is a bare 501", async () => {
    const env = await boot();
    try {
        // a raw channel agent: the reply head is whatever this test writes, not an HTTP client's
        const agent = await connectRawAgent(env, { name: "rogue", app: { title: "Rogue", entry: "/", upstream: "http://127.0.0.1:1" } });
        const cookie = await cookieFor(env, "rogue");

        const browser = dial(env.port, "/mini-app/rogue/ws", handshake(cookie, env.base));
        const opened = await nextRequest(agent);
        assert.equal(opened.header["mode"], "upgrade");
        // `upgrade` is re-added verbatim onto a raw socket, so a value carrying CRLF would frame
        // headers of the agent's choosing — a Set-Cookie on the pult's own origin, among others
        agent.send(
            replyFrame(opened.stream, {
                t: "head",
                status: 101,
                headers: { upgrade: "websocket\r\nSet-Cookie: pwned=1; Path=/", "sec-websocket-accept": "MDEyMzQ1Njc4OWFiY2RlZg==" },
            }),
        );
        const head = await browser.until(/\r\n\r\n/);
        assert.match(head, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
        assert.doesNotMatch(head, /set-cookie/i, "a value that is not a header value cannot become one");
        assert.match(head, /\r\nupgrade: websocket\r\n/i, "and the handshake still completes");
        browser.socket.destroy();

        const refused = dial(env.port, "/mini-app/rogue/ws", handshake(cookie, env.base));
        const asked = await nextRequest(agent);
        agent.send(replyFrame(asked.stream, { t: "error", code: "refused_upgrade" }));
        agent.send({ stream: asked.stream, flags: FLAG_END, payload: new Uint8Array(0) });
        const answer = await refused.until(/\r\n\r\n/);
        assert.match(answer, /^HTTP\/1\.1 501 Not Implemented\r\n/);
        await waitFor(() => refused.closed(), 4000, "the refused socket to close");
        agent.close();
    } finally {
        await env.stop();
    }
});
