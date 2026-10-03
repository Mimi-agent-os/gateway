import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type ServerOptions, type WebSocket } from "ws";

export const MAX_MESSAGE_BYTES = 1_048_576;
/** How long a socket we closed may wait for the peer's close frame before it is destroyed. */
export const CLOSE_TIMEOUT_MS = 3_000;

export interface WsSocket {
    readonly open: boolean;
    send(text: string): void;
    /** `onSent` fires once the frame has left for the socket — the drain signal a sender pauses on;
     *  it never fires on a socket that is no longer open. */
    sendBinary(data: Uint8Array, onSent?: () => void): void;
    close(code?: number, reason?: string): void;
    /** Drops the socket without the closing handshake: the only way to free what a peer that
     *  stopped reading (or never started) has queued, since `close` waits on that peer. */
    terminate(): void;
    onmessage: ((text: string) => void) | null;
    /** null keeps binary refused with 1003 — an endpoint opts in by wiring it. */
    onbinary: ((data: Buffer) => void) | null;
    onclose: ((code: number, reason: string) => void) | null;
    onerror: ((err: Error) => void) | null;
}

/** One server per close timeout; they differ only in how long a closed socket waits. */
const servers = new Map<number, WebSocketServer>();

/** null when the request is not a valid WebSocket upgrade (ws has already answered the socket). */
export function acceptWebSocket(
    req: IncomingMessage,
    duplex: Duplex,
    head: Buffer = Buffer.alloc(0),
    { closeTimeout = CLOSE_TIMEOUT_MS }: { closeTimeout?: number } = {},
): WsSocket | null {
    let server = servers.get(closeTimeout);
    if (!server) {
        // @types/ws 8.18 predates ws 8.21's closeTimeout; ws's own default holds a silent peer's buffers for 30 s
        const options: ServerOptions & { closeTimeout: number } = {
            noServer: true,
            clientTracking: false,
            maxPayload: MAX_MESSAGE_BYTES,
            closeTimeout,
        };
        server = new WebSocketServer(options);
        servers.set(closeTimeout, server);
    }
    let ws: WebSocket | null = null;
    const sock: WsSocket = {
        get open() {
            return ws?.readyState === 1;
        },
        send: (text) => {
            if (sock.open) ws?.send(text);
        },
        sendBinary: (data, onSent) => {
            if (sock.open) ws?.send(data, onSent);
        },
        close: (code = 1000, reason = "") => ws?.close(code, reason),
        terminate: () => ws?.terminate(),
        onmessage: null,
        onbinary: null,
        onclose: null,
        onerror: null,
    };

    // ws calls back synchronously here: there is no async verifyClient
    server.handleUpgrade(req, duplex, head, (socket) => {
        ws = socket;
        socket.on("message", (data, isBinary) => {
            const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
            if (!isBinary) sock.onmessage?.(bytes.toString("utf8"));
            else if (sock.onbinary) sock.onbinary(bytes);
            else socket.close(1003, "binary frames are not accepted");
        });
        socket.on("close", (code, reason) => sock.onclose?.(code, reason.toString()));
        socket.on("error", (err) => sock.onerror?.(err));
    });
    return ws === null ? null : sock;
}
