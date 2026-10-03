/** A Node device on the secure channel: pairing, then `/api` requests as tunnel streams. */
import {
    ClientSession,
    FLAG_DATA,
    FLAG_END,
    FLAG_RESET,
    PairingInitiator,
    parseInviteUri,
    PROTOCOL_VERSION,
    type ChannelStreamFrame,
} from "@mimi-os/protocol";

const utf8 = new TextEncoder();
const EMPTY = new Uint8Array(0);
const CHUNK = 16 * 1024;

export type Line = Record<string, unknown>;

export interface TunnelReply {
    status: number;
    headers: Headers;
    body: ReadableStream<Uint8Array>;
}

export interface ApiReply<T> {
    status: number;
    headers: Headers;
    bytes: Uint8Array;
    text: string;
    /** The body parsed as JSON, or null when it is not JSON. */
    json: T;
}

export interface NdjsonStream extends AsyncIterable<Line> {
    readonly status: number;
    readonly headers: Headers;
    /** Every line received so far, in order. */
    readonly lines: Line[];
    /** Settles when the response ends (END), is reset, or the stream is closed. */
    readonly done: Promise<void>;
    /** The next unconsumed line; one cursor shared with every `for await` over this stream. */
    next(): Promise<IteratorResult<Line, undefined>>;
    /** Cancels the request (RESET on its stream). */
    close(): void;
}

export interface ChannelConn {
    readonly session: ClientSession;
    readonly ws: WebSocket;
    /** Resolves once the session is ready; carries `activation: "pending"` for an inactive device. */
    readonly ready: Promise<{ activation?: "pending" }>;
    /** The socket is gone: every request from here on rejects at once. */
    readonly closed: boolean;
    /** One tunnel request: `{t:"api"}` head + body + END; resolves at the response head. */
    request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<TunnelReply>;
    api<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiReply<T>>;
    stream(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<NdjsonStream>;
    close(): void;
}

interface Pending {
    onHead: (reply: TunnelReply) => void;
    onError: (e: Error) => void;
    controller: ReadableStreamDefaultController<Uint8Array> | null;
}

/** Dials `/channel` with an already-paired key. Does not wait for `ready` — await `.ready` for that. */
export function dialChannel(url: string, s: Uint8Array, gatewayPub: Uint8Array): ChannelConn {
    const session = new ClientSession({ s, gatewayPub, protocol: PROTOCOL_VERSION });
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const tunnels = new Map<number, Pending>();
    let nextStream = 1;
    let closed = false;
    let settleReady: (info: { activation?: "pending" }) => void = () => undefined;
    let failReady: (e: Error) => void = () => undefined;
    const ready = new Promise<{ activation?: "pending" }>((resolve, reject) => {
        settleReady = resolve;
        failReady = reject;
    });
    ready.catch(() => undefined);

    const send = (frame: ChannelStreamFrame): void => {
        try {
            for (const chunk of session.send(frame)) ws.send(chunk);
        } catch {
            // the session is already gone; the close path fails every open request
        }
    };

    const failAll = (reason: string): void => {
        closed = true;
        failReady(new Error(reason));
        for (const [id, t] of tunnels) {
            tunnels.delete(id);
            if (t.controller) t.controller.error(new Error(reason));
            else t.onError(new Error(reason));
        }
    };

    const route = (frame: ChannelStreamFrame): void => {
        const t = tunnels.get(frame.stream);
        if (!t) return;
        if (frame.flags === FLAG_RESET) {
            tunnels.delete(frame.stream);
            if (t.controller) t.controller.error(new Error("the gateway reset this response"));
            else t.onError(new Error("the gateway reset this request"));
            return;
        }
        if (t.controller) {
            if (frame.payload.length > 0) t.controller.enqueue(frame.payload.slice());
            if (frame.flags === FLAG_END) {
                tunnels.delete(frame.stream);
                t.controller.close();
            }
            return;
        }
        let head: { t?: unknown; status?: unknown; headers?: unknown } = {};
        try {
            head = JSON.parse(new TextDecoder().decode(frame.payload)) as typeof head;
        } catch {
            // an invalid head is refused below
        }
        if (head.t !== "head" || typeof head.status !== "number") {
            tunnels.delete(frame.stream);
            t.onError(new Error("the gateway sent an invalid response head"));
            return;
        }
        const headers = new Headers();
        for (const [k, v] of Object.entries((head.headers ?? {}) as Record<string, string | string[]>)) {
            for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
        }
        const stream = frame.stream;
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                t.controller = controller;
            },
            cancel: () => {
                if (tunnels.get(stream) !== t) return;
                tunnels.delete(stream);
                send({ stream, flags: FLAG_RESET, payload: EMPTY });
            },
        });
        t.onHead({ status: head.status, headers, body });
    };

    ws.onopen = (): void => {
        for (const chunk of session.start()) ws.send(chunk);
    };
    ws.onmessage = (ev: MessageEvent): void => {
        let fed: ReturnType<ClientSession["feed"]>;
        try {
            fed = session.feed(new Uint8Array(ev.data as ArrayBuffer));
        } catch {
            ws.close();
            return;
        }
        for (const chunk of fed.out) ws.send(chunk);
        for (const event of fed.events) {
            if (event.type === "ready") settleReady(event.info);
            else if (event.type === "frame") route(event.frame);
            else if (event.type === "error") failReady(new Error(`channel: ${event.code}`));
            else failAll("the channel closed");
        }
    };
    ws.onerror = (): void => failReady(new Error("socket error"));
    ws.onclose = (): void => failAll("the channel closed");

    const request = async (
        method: string,
        path: string,
        body?: unknown,
        headers: Record<string, string> = {},
    ): Promise<TunnelReply> => {
        await ready;
        if (closed) throw new Error("the channel closed");
        const raw = body === undefined || typeof body === "string" || body instanceof Uint8Array;
        const bytes = body === undefined ? EMPTY : body instanceof Uint8Array ? body : utf8.encode(raw ? String(body) : JSON.stringify(body));
        const all = raw ? headers : { "content-type": "application/json", ...headers };
        const stream = nextStream++;
        return new Promise<TunnelReply>((resolve, reject) => {
            tunnels.set(stream, { onHead: resolve, onError: reject, controller: null });
            send({ stream, flags: FLAG_DATA, payload: utf8.encode(JSON.stringify({ t: "api", method, path, headers: all })) });
            for (let off = 0; off < bytes.length; off += CHUNK) {
                send({ stream, flags: FLAG_DATA, payload: bytes.subarray(off, off + CHUNK) });
            }
            send({ stream, flags: FLAG_END, payload: EMPTY });
        });
    };

    const api = async <T>(
        method: string,
        path: string,
        body?: unknown,
        headers?: Record<string, string>,
    ): Promise<ApiReply<T>> => {
        const reply = await request(method, path, body, headers);
        const bytes = new Uint8Array(await new Response(reply.body).arrayBuffer());
        const text = new TextDecoder().decode(bytes);
        let json: unknown = null;
        try {
            json = JSON.parse(text);
        } catch {
            // not JSON: `text` carries it
        }
        return { status: reply.status, headers: reply.headers, bytes, text, json: json as T };
    };

    const stream = async (
        method: string,
        path: string,
        body?: unknown,
        headers?: Record<string, string>,
    ): Promise<NdjsonStream> => {
        const reply = await request(method, path, body, headers);
        const reader = reply.body.getReader();
        const lines: Line[] = [];
        const waiters: Array<() => void> = [];
        const wake = (): void => {
            for (const w of waiters.splice(0)) w();
        };
        let cursor = 0;
        let finished = false;
        let failure: unknown = null;
        const done = (async () => {
            const dec = new TextDecoder();
            let buf = "";
            try {
                for (;;) {
                    const chunk = await reader.read();
                    buf += chunk.done ? dec.decode() : dec.decode(chunk.value, { stream: true });
                    const parts = buf.split("\n");
                    buf = chunk.done ? "" : (parts.pop() ?? "");
                    for (const line of parts) if (line.trim()) lines.push(JSON.parse(line) as Line);
                    wake();
                    if (chunk.done) return;
                }
            } catch (e) {
                failure = e;
                throw e;
            } finally {
                finished = true;
                wake();
            }
        })();
        done.catch(() => undefined);
        const next = async (): Promise<IteratorResult<Line, undefined>> => {
            while (cursor >= lines.length && !finished) await new Promise<void>((r) => waiters.push(r));
            if (cursor < lines.length) return { done: false, value: lines[cursor++]! };
            if (failure !== null) throw failure;
            return { done: true, value: undefined };
        };
        return {
            status: reply.status,
            headers: reply.headers,
            lines,
            done,
            next,
            close: () => void reader.cancel().catch(() => undefined),
            [Symbol.asyncIterator]: () => ({ next, return: async () => ({ done: true, value: undefined }) }),
        };
    };

    return {
        session,
        ws,
        ready,
        get closed() {
            return closed;
        },
        request,
        api,
        stream,
        close: () => ws.close(),
    };
}

/** Runs PairingInitiator to completion against `<wsBase>/channel/pair?invite=<id>`. */
export function pairDevice(
    wsBase: string,
    invite: string,
    s: Uint8Array,
    name: string,
): Promise<{ gatewayPub: Uint8Array; sas: string }> {
    const parsed = parseInviteUri(invite);
    const initiator = new PairingInitiator({ s, uri: invite, deviceName: name });
    const ws = new WebSocket(`${wsBase}/channel/pair?invite=${encodeURIComponent(parsed.id)}`);
    ws.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
        ws.onopen = (): void => {
            for (const chunk of initiator.start()) ws.send(chunk);
        };
        ws.onmessage = (ev: MessageEvent): void => {
            const { out, events } = initiator.feed(new Uint8Array(ev.data as ArrayBuffer));
            for (const chunk of out) ws.send(chunk);
            for (const event of events) {
                if (event.type === "enrolled") resolve({ gatewayPub: parsed.gwPub, sas: event.sas });
                else reject(new Error("pairing was refused"));
                ws.close();
            }
        };
        ws.onerror = (): void => reject(new Error("socket error during pairing"));
        ws.onclose = (): void => reject(new Error("pairing socket closed before enrollment"));
    });
}
