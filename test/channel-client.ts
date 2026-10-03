/** Raw sockets and frame-level sessions on the secure channel; the device client itself is src/device-client.ts. */
import { ClientSession, PROTOCOL_VERSION, type ChannelStreamFrame } from "@mimi-os/protocol";
import WsSocket from "ws";

import type { Env } from "./harness-env.ts";

const EMPTY = new Uint8Array(0);

/** A raw socket on the gateway: binary messages kept in arrival order. */
export interface RawWire {
    readonly ws: WsSocket;
    readonly closed: boolean;
    send(chunks: Uint8Array[]): void;
    /** The next binary message, or null once the socket is closed. */
    next(ms?: number): Promise<Uint8Array | null>;
}

/** Resolves after `ms`, or sooner when one of `waiters` is called. */
function nap(waiters: Set<() => void>, ms: number): Promise<void> {
    return new Promise((resolve) => {
        const done = (): void => {
            clearTimeout(timer);
            waiters.delete(done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        waiters.add(done);
    });
}

/** Dials `path` on the booted gateway. */
export function dialRaw(env: Env, path: string): Promise<RawWire> {
    return new Promise((resolve, reject) => {
        const ws = new WsSocket(`${env.ws}${path}`);
        const inbox: Uint8Array[] = [];
        const waiters = new Set<() => void>();
        let closed = false;
        const wire: RawWire = {
            ws,
            get closed() {
                return closed;
            },
            send: (chunks) => {
                for (const c of chunks) ws.send(c);
            },
            next: async (ms = 3000) => {
                const deadline = Date.now() + ms;
                while (inbox.length === 0 && !closed) {
                    if (Date.now() >= deadline) throw new Error("no message");
                    await nap(waiters, deadline - Date.now());
                }
                return inbox.shift() ?? null;
            },
        };
        ws.on("open", () => resolve(wire));
        ws.on("message", (data: Buffer) => {
            inbox.push(new Uint8Array(data));
            for (const w of [...waiters]) w();
        });
        ws.on("error", () => reject(new Error("websocket error")));
        ws.on("close", () => {
            closed = true;
            for (const w of [...waiters]) w();
            reject(new Error("closed before open"));
        });
    });
}

/** One channel session driven frame by frame, on the `ws` client so a test can stop reading at the socket. */
export interface RawSession {
    readonly ws: WsSocket;
    readonly closed: boolean;
    /** The session came up for a device that is not active yet. */
    readonly pending: boolean;
    send(stream: number, flags: number, payload?: Uint8Array): void;
    /** The next frame on `stream` (on any stream when omitted), or null once the session is gone. */
    frame(stream?: number, ms?: number): Promise<ChannelStreamFrame | null>;
    /** Frames that arrived on `stream` and were not read yet. */
    queued(stream: number): number;
    /** Every later frame goes to `fn` instead of the queue. */
    listen(fn: (frame: ChannelStreamFrame) => void): void;
    /** Stops reading at the socket, so the gateway's own send queue fills. */
    pause(): void;
}

/** Dials `/channel` with the key `s`; null when the gateway closes the socket before the session is ready. */
export function rawSession(env: Env, s: Uint8Array): Promise<RawSession | null> {
    const client = new ClientSession({ s, gatewayPub: env.core.devices.gatewayPub, protocol: PROTOCOL_VERSION });
    const ws = new WsSocket(`${env.ws}/channel`);
    const frames: ChannelStreamFrame[] = [];
    const waiters = new Set<() => void>();
    let listener: ((frame: ChannelStreamFrame) => void) | null = null;
    let closed = false;
    const session = (pending: boolean): RawSession => ({
        ws,
        get closed() {
            return closed;
        },
        pending,
        send: (stream, flags, payload = EMPTY) => {
            for (const c of client.send({ stream, flags, payload })) ws.send(c);
        },
        frame: async (stream, ms = 3000) => {
            const deadline = Date.now() + ms;
            const at = (): number => frames.findIndex((f) => stream === undefined || f.stream === stream);
            while (at() < 0) {
                if (closed) return null;
                if (Date.now() >= deadline) throw new Error(`no frame on stream ${stream ?? "any"}`);
                await nap(waiters, deadline - Date.now());
            }
            return frames.splice(at(), 1)[0] ?? null;
        },
        queued: (stream) => frames.filter((f) => f.stream === stream).length,
        listen: (fn) => void (listener = fn),
        pause: () => ws.pause(),
    });
    return new Promise((resolve, reject) => {
        ws.on("open", () => {
            for (const c of client.start()) ws.send(c);
        });
        ws.on("message", (data: Buffer) => {
            const r = client.feed(new Uint8Array(data));
            for (const c of r.out) ws.send(c);
            for (const ev of r.events) {
                if (ev.type === "ready") resolve(session(ev.info.activation === "pending"));
                else if (ev.type !== "frame") continue;
                else if (listener) listener(ev.frame);
                else frames.push(ev.frame);
            }
            for (const w of [...waiters]) w();
        });
        ws.on("error", () => reject(new Error("websocket error")));
        ws.on("close", () => {
            closed = true;
            for (const w of [...waiters]) w();
            resolve(null);
        });
    });
}
