import "./pq-home.ts";

/** The desktop app's native door end to end: a device session crediting like the pult, the bridge, the SDK executor, a real app. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import test from "node:test";

import {
    APP_CHUNK,
    DEVICE_CREDIT,
    DEVICE_WINDOW,
    FLAG_DATA,
    FLAG_END,
    FLAG_RESET,
    type ChannelStreamFrame,
} from "@mimi-os/protocol";
import { WebSocketServer } from "ws";

import { rawSession } from "./channel-client.ts";
import { activeDevice, boot, connectAppAgent, waitFor, type Env } from "./harness-env.ts";

const EMPTY = new Uint8Array(0);
const utf8 = new TextEncoder();

interface Head {
    status: number;
    headers: Record<string, string | string[]>;
}

interface Stream {
    readonly head: Promise<Head>;
    /** The first of the gateway's END or RESET on this stream. */
    readonly done: Promise<"END" | "RESET">;
    /** Reply body frames as they arrived. */
    readonly chunks: Array<{ at: number; bytes: Buffer }>;
    /** Request-direction credits the gateway sent. */
    readonly credits: number;
    /** Reply bytes the gateway had in flight to us uncredited, at most, over the stream's life. */
    readonly peak: number;
    /** A paused consumer takes nothing and so credits nothing. */
    pause(): void;
    resume(): void;
    /** Request bytes under the device window: waits on the gateway's credit, never overruns it. */
    send(bytes: Uint8Array): Promise<void>;
    end(): void;
    body(): Buffer;
}

interface Device {
    grant(appId: string): Promise<string>;
    app(credential: string, method: string, path: string, headers?: Record<string, string>, upgrade?: boolean): Stream;
    close(): void;
}

/** An active device session that speaks app streams exactly as the desktop pult does. */
async function device(env: Env): Promise<Device> {
    const { s } = await activeDevice(env, "desktop");
    const session = await rawSession(env, s);
    assert.ok(session && !session.pending);
    const routes = new Map<number, (frame: ChannelStreamFrame) => void>();
    session.listen((frame) => routes.get(frame.stream)?.(frame));

    let nextStream = 1;
    const open = (header: Record<string, unknown>): Stream => {
        const stream = nextStream;
        nextStream += 2;
        const credited = header["t"] === "app";
        let settleHead: (head: Head) => void = () => undefined;
        let failHead: (e: Error) => void = () => undefined;
        let settleDone: (how: "END" | "RESET") => void = () => undefined;
        const head = new Promise<Head>((resolve, reject) => {
            settleHead = resolve;
            failHead = reject;
        });
        head.catch(() => undefined);
        const done = new Promise<"END" | "RESET">((resolve) => (settleDone = resolve));
        const chunks: Array<{ at: number; bytes: Buffer }> = [];
        let headSeen = false;
        let gone = false;
        let paused = false;
        let outstanding = 0;
        let taken = 0;
        let peak = 0;
        let unacked = 0;
        let credits = 0;
        let wake: (() => void) | null = null;
        const give = (): void => {
            while (credited && !paused && taken >= DEVICE_CREDIT) {
                taken -= DEVICE_CREDIT;
                outstanding -= DEVICE_CREDIT;
                session.send(stream, FLAG_DATA, EMPTY);
            }
        };
        const nudge = (): void => {
            const next = wake;
            wake = null;
            next?.();
        };
        routes.set(stream, (frame) => {
            if (frame.flags === FLAG_RESET) {
                gone = true;
                failHead(new Error("the gateway reset the stream"));
                settleDone("RESET");
                nudge();
                return;
            }
            if (frame.flags === FLAG_DATA && frame.payload.length === 0) {
                credits += 1;
                unacked = Math.max(0, unacked - DEVICE_CREDIT);
                nudge();
                return;
            }
            if (frame.payload.length > 0 && !headSeen) {
                headSeen = true;
                const parsed = JSON.parse(Buffer.from(frame.payload).toString("utf8")) as Head & { t: string };
                assert.equal(parsed.t, "head");
                settleHead({ status: parsed.status, headers: parsed.headers });
            } else if (frame.payload.length > 0) {
                chunks.push({ at: Date.now(), bytes: Buffer.from(frame.payload) });
                outstanding += frame.payload.length;
                peak = Math.max(peak, outstanding);
                taken += frame.payload.length;
                give();
            }
            if (frame.flags === FLAG_END) settleDone("END");
        });
        session.send(stream, FLAG_DATA, utf8.encode(JSON.stringify(header)));
        return {
            head,
            done,
            chunks,
            get credits() {
                return credits;
            },
            get peak() {
                return peak;
            },
            pause: () => void (paused = true),
            resume: () => {
                paused = false;
                give();
            },
            send: async (bytes) => {
                for (let i = 0; i < bytes.length; i += APP_CHUNK) {
                    while (unacked >= DEVICE_WINDOW && !gone) await new Promise<void>((resolve) => (wake = resolve));
                    if (gone) throw new Error("the gateway reset the stream mid-upload");
                    const slice = bytes.subarray(i, i + APP_CHUNK);
                    unacked += slice.length;
                    session.send(stream, FLAG_DATA, slice);
                }
            },
            end: () => session.send(stream, FLAG_END, EMPTY),
            body: () => Buffer.concat(chunks.map((c) => c.bytes)),
        };
    };

    return {
        grant: async (appId) => {
            const st = open({ t: "app_grant", appId });
            st.end();
            const granted = await st.head;
            assert.equal(granted.status, 200);
            assert.equal(await st.done, "END");
            return (JSON.parse(st.body().toString("utf8")) as { credential: string }).credential;
        },
        app: (credential, method, path, headers = {}, upgrade = false) =>
            open({ t: "app", appId: "shop", credential, method, path, headers, upgrade: upgrade ? true : undefined }),
        close: () => session.ws.close(),
    };
}

/** byte i of every generated body — the reader checks it without a hash round trip */
const pattern = (from: number, length: number): Buffer => {
    const out = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) out[i] = ((from + i) * 31) % 251;
    return out;
};

interface App {
    base: string;
    handshakes: IncomingMessage[];
    stop(): Promise<void>;
}

async function startApp(): Promise<App> {
    const handshakes: IncomingMessage[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://app.invalid");
        const hash = createHash("sha256");
        let length = 0;
        let seen = 0;
        req.on("data", (chunk: Buffer) => {
            hash.update(chunk);
            length += chunk.length;
            // a slow app: it stops reading for a moment every MiB, so the upload is paced end to end
            if (url.searchParams.has("slow") && Math.floor(length / 1048576) > seen) {
                seen = Math.floor(length / 1048576);
                req.pause();
                setTimeout(() => req.resume(), 20);
            }
        });
        req.on("end", () => {
            switch (url.pathname) {
                case "/echo":
                    res.writeHead(200, { "content-type": "application/json", "x-multi": ["one", "two"] });
                    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, length, sha256: hash.digest("hex") }));
                    return;
                case "/empty":
                    res.writeHead(204, { "x-empty": "yes" });
                    res.end();
                    return;
                case "/moved":
                    res.writeHead(302, { location: "/landed?x=1" });
                    res.end();
                    return;
                case "/cookie":
                    res.writeHead(200, { "set-cookie": ["sid=abc; Path=/; HttpOnly", "theme=dark; Path=/; Max-Age=60"] });
                    res.end(req.headers.cookie ?? "");
                    return;
                case "/stream": {
                    res.writeHead(200, { "content-type": "text/plain" });
                    let n = 0;
                    const tick = setInterval(() => {
                        res.write(`chunk ${n}\n`);
                        n += 1;
                        if (n === 10) {
                            clearInterval(tick);
                            res.end();
                        }
                    }, 100);
                    return;
                }
                case "/big": {
                    const total = Number(url.searchParams.get("bytes"));
                    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(total) });
                    let at = 0;
                    const pump = (): void => {
                        while (at < total) {
                            const n = Math.min(64 * 1024, total - at);
                            const ok = res.write(pattern(at, n));
                            at += n;
                            if (!ok) {
                                res.once("drain", pump);
                                return;
                            }
                        }
                        res.end();
                    };
                    pump();
                    return;
                }
                default:
                    res.writeHead(200, { "content-type": "text/html" });
                    res.end(`base=${String(req.headers["x-mimi-app-base"])}`);
            }
        });
    });
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (socket, req) => {
        handshakes.push(req);
        socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
        const url = new URL(req.url ?? "/", "http://app.invalid");
        if (url.pathname === "/ws") return wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
        // an upstream that writes its last bytes and hangs up at once, as a server closing a socket does
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: raw\r\nConnection: Upgrade\r\n\r\n");
        socket.end(pattern(0, Number(url.searchParams.get("bytes"))));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        handshakes,
        stop: async () => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

async function withApp(run: (env: Env, d: Device, credential: string, app: App) => Promise<void>): Promise<void> {
    const env = await boot();
    const app = await startApp();
    try {
        await connectAppAgent(env, "shop", app.base);
        const d = await device(env);
        await run(env, d, await d.grant("shop"), app);
        d.close();
    } finally {
        await env.stop();
        await app.stop();
    }
}

test("every method, header and status crosses the native door as the app sent it", async () => {
    await withApp(async (_env, d, credential) => {
        for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"]) {
            const st = d.app(credential, method, `/echo?m=${method}`, { "x-probe": "kept", "x-mimi-forged": "dropped" });
            const body = method === "GET" || method === "HEAD" ? EMPTY : utf8.encode(`${method} body`);
            await st.send(body);
            st.end();
            const head = await st.head;
            assert.equal(head.status, 200, method);
            // node:http on the agent joins a repeated list header, as RFC 9110 allows; Set-Cookie stays a list
            assert.equal(head.headers["x-multi"], "one, two", "a multi-valued header keeps every value");
            assert.equal(head.headers["cache-control"], "no-store");
            assert.equal(await st.done, "END");
            if (method === "HEAD") {
                assert.equal(st.body().length, 0);
                continue;
            }
            const echo = JSON.parse(st.body().toString("utf8")) as { method: string; url: string; headers: Record<string, string>; length: number };
            assert.equal(echo.method, method);
            assert.equal(echo.url, `/echo?m=${method}`);
            assert.equal(echo.length, body.length);
            assert.equal(echo.headers["x-probe"], "kept");
            assert.equal(echo.headers["x-mimi-forged"], undefined);
            assert.equal(echo.headers["x-mimi-app-base"], "/", "the app owns its origin's root on this door");
        }

        const empty = d.app(credential, "GET", "/empty");
        empty.end();
        assert.equal((await empty.head).status, 204);
        assert.equal(await empty.done, "END");
        assert.equal(empty.chunks.length, 0, "a 204 carries no body frame");

        const moved = d.app(credential, "GET", "/moved");
        moved.end();
        const head = await moved.head;
        assert.equal(head.status, 302);
        assert.equal(head.headers["location"], "/landed?x=1", "a root-relative Location is the app's own, unprefixed");
    });
});

test("a 16 MiB upload reaches a slow app intact, paced by credit on both planes", async () => {
    await withApp(async (_env, d, credential) => {
        const body = randomBytes(16 * 1024 * 1024);
        const st = d.app(credential, "PUT", "/echo?slow=1", { "content-type": "application/octet-stream", "content-length": String(body.length) });
        const uploading = st.send(body).then(() => st.end());
        const head = await st.head;
        await uploading;
        assert.equal(head.status, 200);
        assert.equal(await st.done, "END");
        const echo = JSON.parse(st.body().toString("utf8")) as { length: number; sha256: string };
        assert.equal(echo.length, body.length);
        assert.equal(echo.sha256, createHash("sha256").update(body).digest("hex"));
        // the head came only once the app read everything: every credit went out before it
        assert.ok(st.credits >= body.length / DEVICE_CREDIT - DEVICE_WINDOW / DEVICE_CREDIT, `credits: ${st.credits}`);
    });
});

test("a reply streams progressively, and a 16-window reply read slowly is paced end to end, never reset", async () => {
    await withApp(async (_env, d, credential) => {
        const live = d.app(credential, "GET", "/stream");
        live.end();
        assert.equal((await live.head).status, 200);
        assert.equal(await live.done, "END");
        assert.equal(live.body().toString("utf8"), Array.from({ length: 10 }, (_, n) => `chunk ${n}\n`).join(""));
        const first = live.chunks[0]?.at ?? 0;
        const last = live.chunks.at(-1)?.at ?? 0;
        assert.ok(live.chunks.length >= 5 && last - first >= 600, `the chunks arrived as written, over ${last - first} ms`);

        const TOTAL = 16 * DEVICE_WINDOW;
        const big = d.app(credential, "GET", `/big?bytes=${TOTAL}`);
        big.pause();
        big.end();
        assert.equal((await big.head).status, 200);
        await waitFor(() => big.body().length >= DEVICE_WINDOW, 4000, "a paused reader's one window");
        let finished = false;
        void big.done.then(() => (finished = true));
        while (!finished) {
            big.resume();
            await new Promise((resolve) => setTimeout(resolve, 5));
            big.pause();
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        big.resume();
        assert.equal(await big.done, "END");
        assert.ok(big.peak <= DEVICE_WINDOW + APP_CHUNK, `the gateway never ran past the device window: ${big.peak}`);
        assert.ok(big.body().equals(pattern(0, TOTAL)), "every byte, in order");
    });
});

test("cookies pass through: the device's own cookie reaches the app and every Set-Cookie line comes back", async () => {
    await withApp(async (env, d, credential) => {
        const st = d.app(credential, "GET", "/cookie", { cookie: "sid=from-device; theme=light" });
        st.end();
        const head = await st.head;
        assert.deepEqual(head.headers["set-cookie"], ["sid=abc; Path=/; HttpOnly", "theme=dark; Path=/; Max-Age=60"]);
        await st.done;
        assert.equal(st.body().toString("utf8"), "sid=from-device; theme=light");
        assert.deepEqual(env.db.appCookiesFor("shop", "shop", "/"), [], "the gateway jar is the browser door's, never this one's");
    });
});

/** One masked client frame (RFC 6455 §5.2), FIN set. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
    const mask = randomBytes(4);
    const length = payload.length;
    let head: Buffer;
    if (length < 126) head = Buffer.from([0x80 | opcode, 0x80 | length]);
    else if (length < 65536) head = Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff]);
    else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | opcode;
        head[1] = 0x80 | 127;
        head.writeBigUInt64BE(BigInt(length), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < length; i += 1) masked[i] = (masked[i] as number) ^ (mask[i & 3] as number);
    return Buffer.concat([head, mask, masked]);
}

/** Every complete unmasked server frame in `bytes`. */
function serverFrames(bytes: Buffer): Array<{ opcode: number; payload: Buffer }> {
    const out: Array<{ opcode: number; payload: Buffer }> = [];
    let at = 0;
    while (at + 2 <= bytes.length) {
        let length = (bytes[at + 1] as number) & 0x7f;
        let start = at + 2;
        if (length === 126) {
            length = bytes.readUInt16BE(start);
            start += 2;
        } else if (length === 127) {
            length = Number(bytes.readBigUInt64BE(start));
            start += 8;
        }
        if (start + length > bytes.length) break;
        out.push({ opcode: (bytes[at] as number) & 0x0f, payload: bytes.subarray(start, start + length) });
        at = start + length;
    }
    return out;
}

test("a WebSocket upgrade echoes text and a 4 MiB binary message both ways, then closes cleanly", async () => {
    await withApp(async (_env, d, credential, app) => {
        const key = randomBytes(16).toString("base64");
        const handshake = {
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": key,
            "sec-websocket-version": "13",
            origin: "mimiapp://shop.0a1b2c3d4e.localhost",
            cookie: "sid=from-device",
        };
        const ws = d.app(credential, "GET", "/ws", handshake, true);
        const head = await ws.head;
        assert.equal(head.status, 101);
        assert.equal(head.headers["upgrade"], "websocket");
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        assert.equal(head.headers["sec-websocket-accept"], accept, "the app's own accept value, untouched");
        const seen = app.handshakes[0];
        assert.ok(seen);
        assert.equal(seen.headers["origin"], app.base, "the gateway rewrites Origin to the upstream's own");
        assert.equal(seen.headers["cookie"], "sid=from-device");

        await ws.send(clientFrame(0x1, Buffer.from("hello over the channel")));
        const big = randomBytes(4 * 1024 * 1024);
        await ws.send(clientFrame(0x2, big));
        await waitFor(() => serverFrames(ws.body()).length >= 2, 8000, "both echoes");
        const [text, binary] = serverFrames(ws.body());
        assert.equal(text?.opcode, 0x1);
        assert.equal(text?.payload.toString("utf8"), "hello over the channel");
        assert.equal(binary?.opcode, 0x2);
        assert.ok(binary?.payload.equals(big), "4 MiB each way, byte for byte");

        const bye = Buffer.alloc(2);
        bye.writeUInt16BE(1000);
        await ws.send(clientFrame(0x8, bye));
        await waitFor(() => serverFrames(ws.body()).some((f) => f.opcode === 0x8), 4000, "the app's close frame");
        const close = serverFrames(ws.body()).find((f) => f.opcode === 0x8);
        assert.equal(close?.payload.readUInt16BE(0), 1000);
        ws.end();
        assert.equal(await ws.done, "END");
        assert.ok(ws.peak <= DEVICE_WINDOW + APP_CHUNK, `raw socket bytes are credited like a body: ${ws.peak}`);
    });
});

test("an upstream that hangs up right after its last bytes loses none of them, however far behind the device reads", async () => {
    await withApp(async (_env, d, credential) => {
        // more than the device window: the tail is still held at the gateway when the agent ends and resets
        const TOTAL = DEVICE_WINDOW + 32 * 1024;
        const st = d.app(credential, "GET", `/tail?bytes=${TOTAL}`, { upgrade: "raw", connection: "Upgrade" }, true);
        st.pause();
        assert.equal((await st.head).status, 101);
        await new Promise((resolve) => setTimeout(resolve, 500));
        st.resume();
        await waitFor(() => st.body().length >= TOTAL, 4000, "every byte the upstream wrote");
        assert.ok(st.body().equals(pattern(0, TOTAL)), "every byte, in order");
        assert.equal(await st.done, "END", "the upstream's hang-up arrives as END after the last byte");
    });
});
