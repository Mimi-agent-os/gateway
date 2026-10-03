/** A fake agent that ALSO keeps sessions: the SDK's store semantics, in RAM, over a real /channel socket. */
import { APP_IDLE_MS, chainHash, REPLY_OF } from "@mimi-os/protocol";
import type { EventBody, SessionHead, StoredEvent } from "@mimi-os/protocol";
import {
    createFakeAgentCore,
    fakeAgentSocket,
    fakeIdentity,
    type AgentIdentity,
    type AgentSocketLike,
    type FakeAgentCore,
    type FakeAgentOptions,
} from "@mimi-os/sdk/testing";

export interface HarnessOptions extends FakeAgentOptions {
    /** The agent's channel key; a fresh one when omitted. */
    identity?: AgentIdentity | undefined;
    /** The app executor's upstream idle deadline; APP_IDLE_MS when omitted. */
    idleMs?: number;
    /** false declares the app on describe but runs no executor: every stream the gateway opens is RESET. */
    serves?: boolean;
}

export interface SessionState {
    id: number;
    title: string | null;
    titleByUser: boolean;
    archived: boolean;
    pinned: boolean;
    /** Epoch ms, as the SDK keeps them: only an append moves `updatedAt`, never a rename or a pin. */
    createdAt: number;
    updatedAt: number;
    revision: number;
    headSeq: number;
    headHash: string;
    events: StoredEvent[];
}

export interface Harness {
    readonly core: FakeAgentCore;
    readonly sessions: Map<number, SessionState>;
    createSession(title?: string | null, titleByUser?: boolean): number;
    append(id: number, bodies: readonly EventBody[]): SessionHead;
    head(id: number): SessionHead;
    /** Every frame the gateway sent us, in order — «the agent received no invoke» reads from here. */
    frames(): Array<Record<string, unknown>>;
    /** Put an arbitrary frame on the wire — how a lying or missing push is staged. */
    send(frame: Record<string, unknown>): void;
    invokes(): Array<Record<string, unknown>>;
    connect(url: string): Promise<void>;
    socketOpen(): boolean;
    close(): void;
}

const stored = (b: EventBody, seq: number, hash: string, createdAt: number): StoredEvent => {
    if (b.type === "message") return { type: "message", payload: b.payload, seq, hash, createdAt };
    if (b.type === "compaction") return { type: "compaction", payload: b.payload, seq, hash, createdAt };
    return { type: "truncate", payload: b.payload, seq, hash, createdAt };
};

export function createHarness(opts: HarnessOptions, gatewayPub: Uint8Array): Harness {
    const identity = opts.identity ?? fakeIdentity();
    const core = createFakeAgentCore(opts);
    const sessions = new Map<number, SessionState>();
    let nextId = 1;
    let socket: AgentSocketLike | null = null;

    function createSession(title: string | null = null, titleByUser = false): number {
        const id = nextId++;
        const now = Date.now();
        sessions.set(id, {
            id,
            title,
            titleByUser,
            archived: false,
            pinned: false,
            createdAt: now,
            updatedAt: now,
            revision: 0,
            headSeq: 0,
            headHash: "",
            events: [],
        });
        return id;
    }

    function head(id: number): SessionHead {
        const s = sessions.get(id);
        if (!s) throw new Error(`no session ${id}`);
        return { session: id, revision: s.revision, headSeq: s.headSeq, headHash: s.headHash };
    }

    function append(id: number, bodies: readonly EventBody[]): SessionHead {
        const s = sessions.get(id);
        if (!s) throw new Error(`no session ${id}`);
        const now = Date.now();
        for (const b of bodies) {
            s.headSeq += 1;
            s.revision += 1;
            s.headHash = chainHash(s.headHash, { seq: s.headSeq, type: b.type, payload: b.payload });
            s.events.push(stored(b, s.headSeq, s.headHash, now));
        }
        s.updatedAt = now;
        return head(id);
    }

    function put(frame: Record<string, unknown>): void {
        try {
            socket?.send(JSON.stringify(frame));
        } catch {
            // the session is gone
        }
    }

    function answer(id: string, type: string, payload: unknown): void {
        put({ id, type: (REPLY_OF as Record<string, string | undefined>)[type] ?? "result", status: "ok", payload });
    }

    function fail(id: string, type: string, message: string): void {
        put({ id, type: (REPLY_OF as Record<string, string | undefined>)[type] ?? "result", status: "error", error: { message } });
    }

    function serve(frame: Record<string, unknown>): void {
        const id = String(frame["id"]);
        const type = String(frame["type"]);
        const p = (frame["payload"] ?? {}) as Record<string, unknown>;
        try {
            switch (type) {
                case "session_head": {
                    const ids = (p["sessions"] as number[] | undefined) ?? [];
                    answer(id, type, { heads: ids.filter((s) => sessions.has(s)).map(head) });
                    return;
                }
                case "events_after": {
                    const sid = Number(p["session"]);
                    const s = sessions.get(sid);
                    if (!s) {
                        fail(id, type, `no session ${sid}`);
                        return;
                    }
                    const after = Number(p["afterSeq"] ?? 0);
                    const limit = Math.max(1, Math.min(1000, Number(p["limit"] ?? 1000)));
                    const rows = s.events.filter((e) => e.seq > after);
                    const page = rows.slice(0, limit);
                    answer(id, type, { events: page, head: head(sid), more: rows.length > limit });
                    return;
                }
                case "append": {
                    const sid = Number(p["session"]);
                    if (!sessions.has(sid)) {
                        fail(id, type, `no session ${sid}`);
                        return;
                    }
                    const bodies = (p["events"] as EventBody[] | undefined) ?? [];
                    const before = sessions.get(sid)!.headSeq;
                    const h = append(sid, bodies);
                    answer(id, type, { head: h, seqs: bodies.map((_b, i) => before + 1 + i) });
                    return;
                }
                case "session_create": {
                    const sid = createSession(
                        typeof p["title"] === "string" ? p["title"] : null,
                        p["titleByUser"] === true,
                    );
                    answer(id, type, { head: head(sid) });
                    return;
                }
                case "session_list": {
                    const all = [...sessions.values()].filter(
                        (s) => p["includeArchived"] === true || !s.archived,
                    );
                    answer(id, type, {
                        sessions: all.map((s) => ({
                            session: s.id,
                            title: s.title,
                            titleByUser: s.titleByUser,
                            archived: s.archived,
                            pinned: s.pinned,
                            events: s.events.length,
                            createdAt: s.createdAt,
                            updatedAt: s.updatedAt,
                            head: head(s.id),
                        })),
                    });
                    return;
                }
                case "session_update": {
                    const s = sessions.get(Number(p["session"]));
                    if (!s) {
                        answer(id, type, { applied: false });
                        return;
                    }
                    if (typeof p["title"] === "string" && !s.titleByUser) {
                        s.title = p["title"];
                        if (p["titleByUser"] === true) s.titleByUser = true;
                    }
                    if (typeof p["archived"] === "boolean") s.archived = p["archived"];
                    if (typeof p["pinned"] === "boolean") s.pinned = p["pinned"];
                    answer(id, type, { applied: true });
                    return;
                }
                case "session_delete": {
                    answer(id, type, { deleted: sessions.delete(Number(p["session"])) });
                    return;
                }
                case "health":
                    answer(id, type, { uptimeMs: 1, sessions: sessions.size });
                    return;
                default:
                    return;
            }
        } catch (e) {
            fail(id, type, (e as Error).message);
        }
    }

    /** `url` is the gateway's `/channel` endpoint: the real Noise IK session, whose lookup admits
     *  the key only through an approved agent pin (see harness-env.ts). A refused key rejects. */
    function connect(url: string): Promise<void> {
        return new Promise((resolve, reject) => {
            // with an `app` the socket carries the SDK's real executor
            const declared = opts.serves === false ? undefined : opts.app;
            const app = declared === undefined ? undefined : { appId: opts.name, upstream: declared.upstream };
            const sock = fakeAgentSocket(url, identity, gatewayPub, { app, idleMs: opts.idleMs ?? APP_IDLE_MS });
            // a delayed reply can land after the test closed the socket — a dead session must not throw into receive()
            const wire = {
                send: (text: string): void => {
                    try {
                        sock.send(text);
                    } catch {
                        // the session is gone
                    }
                },
                close: (): void => sock.close(),
            };
            let opened = false;
            socket = sock;
            sock.onopen = (): void => {
                opened = true;
                core.handshake(wire).then(resolve, reject);
            };
            sock.onmessage = (ev: { data: unknown }): void => {
                const raw = typeof ev.data === "string" ? ev.data : "";
                void core.receive(raw, wire);
                let frame: Record<string, unknown>;
                try {
                    frame = JSON.parse(raw) as Record<string, unknown>;
                } catch {
                    return;
                }
                if (typeof frame["type"] === "string" && !("status" in frame)) serve(frame);
            };
            // a refusal arrives here as the SDK's RefusedError, whose kind says which key was turned away
            sock.onerror = (e: unknown): void => reject(e instanceof Error ? e : new Error(`harness: ${url} failed`));
            sock.onclose = (): void => {
                if (socket === sock) socket = null;
                if (!opened) reject(new Error(`harness: ${url} closed before the handshake`));
            };
        });
    }

    return {
        core,
        sessions,
        createSession,
        append,
        head,
        frames: () => core.log as Array<Record<string, unknown>>,
        send: put,
        invokes: () =>
            (core.log as Array<Record<string, unknown>>).filter((f) => f["type"] === "invoke"),
        connect,
        socketOpen: () => socket !== null && socket.readyState === 1,
        close: () => {
            socket?.close();
            socket = null;
        },
    };
}
