/** The gateway's end of one agent socket: correlation by id, nothing above transport. */

import { randomUUID } from "node:crypto";

import { NOTICE_TYPES, parseEnvelope, REPLY_OF } from "@mimi-os/protocol";
import type {
    AppStreamPort,
    ChannelStreamFrame,
    DescribePayload,
    OkPayloadOf,
    ProtocolError,
    RequestOf,
    RequestType,
    Status,
    StreamEvent,
} from "@mimi-os/protocol";

import type { AgentAvatarRow } from "../store/db.ts";
import type { DescribeDrop, IncomingRequest, RequestOptions } from "./registry-types.ts";

/** The slice of the channel adapter an AgentPeer needs — see registry/devices.ts for who builds
 *  one: a stream-0 message wrapper over an agent-role ServerSession. */
export interface AgentSocket {
    readonly open: boolean;
    send(text: string): void;
    close(code?: number, reason?: string): void;
    /** The next gateway-initiated stream on this session, or null when the socket is closing or
     *  the session already holds its stream cap. Only the gateway opens streams on an agent. */
    openAppStream(onFrame: (frame: ChannelStreamFrame) => void): AppStreamPort | null;
    onmessage: ((text: string) => void) | null;
    onclose: ((code: number, reason: string) => void) | null;
    onerror: ((err: Error) => void) | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** A deadline is the agent's budget; the gateway waits a little longer before giving up on it. */
const DEADLINE_GRACE_MS = 5_000;

export class PeerError extends Error {
    readonly status: Status;
    constructor(message: string, status: Status) {
        super(message);
        this.name = "PeerError";
        this.status = status;
    }
}

interface Pending {
    replyType: string;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
    cleanup(): void;
}

export class AgentPeer {
    readonly socket: AgentSocket;
    readonly connectedAt = Date.now();
    /** Remote address, as the device list sees it. */
    readonly from: string | null;
    /** The name the /channel handshake already pinned this key to — hello must repeat it exactly. */
    readonly pinName: string;
    name = "";
    describe: DescribePayload | null = null;
    /** The latest describe's checked avatar, stored at disconnect if a rate-limited refresh held it back. */
    avatar: AgentAvatarRow | null = null;
    /** What validateDescribe left out of the latest describe, and its JSON size in bytes. */
    dropped: DescribeDrop[] = [];
    describeBytes = 0;
    lastSeen = Date.now();
    stage: "new" | "helloed" | "ready" = "new";
    onRequest: ((frame: IncomingRequest, peer: AgentPeer) => Promise<unknown>) | null = null;
    onClosed: ((peer: AgentPeer) => void) | null = null;

    private readonly log: (msg: string) => void;
    private readonly deadlineGraceMs: number;
    private readonly pending = new Map<string, Pending>();
    /** Epoch ms each deadlined request told the agent to finish by, kept until that moment even if
     *  the waiter here is gone: a turn Stop frees the gateway, the agent's own expire timer ends it. */
    private readonly deadlines = new Map<string, number>();

    constructor(
        socket: AgentSocket,
        pinName: string,
        log: (msg: string) => void,
        from: string | null = null,
        deadlineGraceMs = DEADLINE_GRACE_MS,
    ) {
        this.socket = socket;
        this.pinName = pinName;
        this.log = log;
        this.from = from;
        this.deadlineGraceMs = deadlineGraceMs;
        socket.onmessage = (text): void => this.receive(text);
        socket.onclose = (): void => {
            this.teardown(new PeerError(`agent "${this.name || "?"}" disconnected`, "error"));
            this.onClosed?.(this);
        };
        socket.onerror = (e): void => this.log(`[peer] ${this.name || "?"}: ${e.message}\n`);
    }

    get connected(): boolean {
        return this.socket.open && this.stage === "ready";
    }

    /** The earliest deadline this peer is still being held to. An approval it asks for while
     *  serving that request cannot outlive it: the SDK stops listening when the deadline passes. */
    get deadlineAt(): number | undefined {
        const now = Date.now();
        let earliest: number | undefined;
        for (const at of this.deadlines.values()) {
            if (at > now && (earliest === undefined || at < earliest)) earliest = at;
        }
        return earliest;
    }

    request<K extends RequestType>(
        type: K,
        payload: RequestOf<K>["payload"],
        opts?: RequestOptions,
    ): Promise<OkPayloadOf<K>> {
        if (!this.socket.open) {
            return Promise.reject(new PeerError(`agent "${this.name}" is not connected`, "error"));
        }
        if (opts?.signal?.aborted) return Promise.reject(opts.signal.reason);
        const id = randomUUID();
        if (opts?.deadline !== undefined) {
            const now = Date.now();
            for (const [key, at] of this.deadlines) if (at <= now) this.deadlines.delete(key);
            this.deadlines.set(id, now + opts.deadline);
        }
        const timeoutMs =
            opts?.timeoutMs ??
            (opts?.deadline !== undefined ? opts.deadline + this.deadlineGraceMs : DEFAULT_TIMEOUT_MS);
        return new Promise<OkPayloadOf<K>>((resolve, reject) => {
            const signal = opts?.signal;
            const abort = (): void => {
                const pending = this.pending.get(id);
                if (!pending) return;
                this.pending.delete(id);
                pending.cleanup();
                reject(signal?.reason);
            };
            const entry: Pending = {
                replyType: REPLY_OF[type],
                resolve: (v) => resolve(v as OkPayloadOf<K>),
                reject,
                timer: setTimeout(() => {
                    this.pending.delete(id);
                    signal?.removeEventListener("abort", abort);
                    reject(new PeerError(`${type}: no reply within ${timeoutMs}ms`, "timeout"));
                }, timeoutMs),
                cleanup: () => {
                    clearTimeout(entry.timer);
                    signal?.removeEventListener("abort", abort);
                },
            };
            this.pending.set(id, entry);
            signal?.addEventListener("abort", abort, { once: true });
            try {
                this.write({ id, type, payload, deadline: opts?.deadline });
            } catch (e) {
                this.pending.delete(id);
                entry.cleanup();
                reject(new PeerError((e as Error).message, "error"));
            }
        });
    }

    stream(id: string, ev: StreamEvent): void {
        try {
            this.write({ id, type: "stream", payload: ev });
        } catch {
            /* a lost stream frame costs the agent live output, never the answer */
        }
    }

    close(code = 1000, reason = "closed"): void {
        this.socket.close(code, reason);
    }

    private write(frame: unknown): void {
        this.socket.send(JSON.stringify(frame));
    }

    private receive(raw: string): void {
        this.lastSeen = Date.now();
        let decoded: unknown;
        try {
            decoded = JSON.parse(raw) as unknown;
        } catch (e) {
            this.log(`[peer] ${this.name || "?"}: undecodable frame — ${(e as Error).message}\n`);
            return;
        }
        const frame = parseEnvelope(decoded);
        if (!frame) return;

        if ("status" in frame) {
            const waiter = this.pending.get(frame.id);
            if (!waiter) return;
            if (frame.type !== waiter.replyType) return;
            this.pending.delete(frame.id);
            // answered: the agent cleared its own expire timer, so this deadline caps nothing now
            this.deadlines.delete(frame.id);
            waiter.cleanup();
            if (frame.status === "ok") {
                waiter.resolve(frame.payload);
                return;
            }
            waiter.reject(new PeerError(`${frame.type}: ${frame.error.message}`, frame.status));
            return;
        }
        void this.serve({ id: frame.id, type: frame.type, payload: frame.payload });
    }

    private async serve(frame: IncomingRequest): Promise<void> {
        // own-property only: `frame.type` is untrusted, and an inherited key is not a reply name
        const type = Object.hasOwn(REPLY_OF, frame.type)
            ? (REPLY_OF as Record<string, string>)[frame.type]!
            : "result";
        let answer: { status: Status; payload?: unknown; error?: ProtocolError };
        try {
            if (!this.onRequest) throw new PeerError("gateway is not ready", "error");
            answer = { status: "ok", payload: await this.onRequest(frame, this) };
        } catch (e) {
            const status = e instanceof PeerError ? e.status : "error";
            answer = { status, error: { message: (e as Error).message } };
        }
        // a notice has no reply: answering session_changed would put an orphan frame on the wire
        if ((NOTICE_TYPES as readonly string[]).includes(frame.type)) {
            if (answer.error) this.log(`[peer] ${this.name}: ${frame.type} refused — ${answer.error.message}\n`);
            return;
        }
        try {
            this.write({ id: frame.id, type, ...answer });
        } catch (e) {
            this.log(`[peer] ${this.name}: reply ${type} lost — ${(e as Error).message}\n`);
        }
    }

    private teardown(reason: Error): void {
        for (const p of this.pending.values()) {
            p.cleanup();
            p.reject(reason);
        }
        this.pending.clear();
    }
}
