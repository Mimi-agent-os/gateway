import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import { acceptWebSocket, MAX_MESSAGE_BYTES, type WsSocket } from "../src/transport/ws.ts";

async function serve(
    wire: (sock: WsSocket) => void,
    options: { closeTimeout?: number } = {},
): Promise<{ url: string; port: number; stop(): Promise<void> }> {
    const server: Server = createServer((_req, res) => res.end());
    server.on("upgrade", (req, duplex, head) => {
        const sock = acceptWebSocket(req, duplex, head, options);
        if (sock) wire(sock);
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    return {
        url: `ws://127.0.0.1:${address.port}`,
        port: address.port,
        stop: () => new Promise<void>((done) => server.close(() => done())),
    };
}

function open(url: string): Promise<WebSocket> {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error("socket error"));
    });
}

const closed = (ws: WebSocket): Promise<number> => new Promise((resolve) => (ws.onclose = (ev) => resolve(ev.code)));

test("binary messages reach onbinary and sendBinary answers", async () => {
    const srv = await serve((sock) => {
        sock.onbinary = (data) => sock.sendBinary(Buffer.concat([data, data]));
    });
    try {
        const ws = await open(srv.url);
        const reply = new Promise<Uint8Array>((resolve) => (ws.onmessage = (ev) => resolve(new Uint8Array(ev.data as ArrayBuffer))));
        ws.send(new Uint8Array([1, 2, 3]));
        assert.deepEqual([...(await reply)], [1, 2, 3, 1, 2, 3]);
        ws.close();
    } finally {
        await srv.stop();
    }
});

test("binary is refused with 1003 when the endpoint wires no onbinary", async () => {
    const srv = await serve(() => undefined);
    try {
        const ws = await open(srv.url);
        const code = closed(ws);
        ws.send(new Uint8Array([1]));
        assert.equal(await code, 1003);
    } finally {
        await srv.stop();
    }
});

test("text reaches onmessage and a message over the cap closes with 1009", async () => {
    const texts: string[] = [];
    const srv = await serve((sock) => {
        sock.onmessage = (text) => texts.push(text);
        sock.onbinary = () => undefined;
    });
    try {
        const ws = await open(srv.url);
        ws.send("hello");
        const code = closed(ws);
        ws.send(new Uint8Array(MAX_MESSAGE_BYTES + 1));
        assert.equal(await code, 1009);
        assert.deepEqual(texts, ["hello"]);
    } finally {
        await srv.stop();
    }
});

test("onclose fires with the peer's code, and open turns false", async () => {
    const accepted: WsSocket[] = [];
    const codes: number[] = [];
    const gone = Promise.withResolvers<void>();
    const srv = await serve((sock) => {
        accepted.push(sock);
        sock.onclose = (code) => {
            codes.push(code);
            gone.resolve();
        };
    });
    try {
        const ws = await open(srv.url);
        ws.close(4001);
        await gone.promise;
        assert.deepEqual(codes, [4001]);
        assert.equal(accepted[0]?.open, false);
    } finally {
        await srv.stop();
    }
});

test("a request that is not a WebSocket upgrade gets no socket", async () => {
    let accepted = 0;
    const srv = await serve(() => accepted++);
    try {
        const reply = await new Promise<string>((resolve) => {
            const raw = connect(srv.port, "127.0.0.1", () =>
                raw.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"),
            );
            let text = "";
            raw.on("data", (chunk) => (text += String(chunk)));
            raw.on("close", () => resolve(text));
        });
        assert.match(reply, /^HTTP\/1\.1 400/);
        assert.equal(accepted, 0);
    } finally {
        await srv.stop();
    }
});

test("a peer that never answers our close frame is dropped after the close timeout, not ws's 30 s", async () => {
    const CLOSE = 100;
    const srv = await serve((sock) => sock.close(1000), { closeTimeout: CLOSE });
    try {
        const t0 = Date.now();
        const closedAfter = await new Promise<number>((resolve) => {
            const raw = connect(srv.port, "127.0.0.1", () =>
                raw.write(
                    "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
                ),
            );
            const giveUp = setTimeout(() => {
                raw.destroy();
                resolve(Infinity);
            }, CLOSE + 3000);
            raw.on("error", () => undefined);
            // read (and drop) what arrives, or the client never sees the server hang up
            raw.resume();
            raw.on("close", () => {
                clearTimeout(giveUp);
                resolve(Date.now() - t0);
            });
        });
        assert.ok(closedAfter >= CLOSE - 10 && closedAfter < CLOSE + 1500, `closed after ${closedAfter} ms`);
    } finally {
        await srv.stop();
    }
});
