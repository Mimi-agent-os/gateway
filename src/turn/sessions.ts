/** RAM cache of agent sessions — HEAD check, delta fold, integrity reload; never the truth. */

import { foldEvents, GENESIS_HASH, chainHash, sanitizeHistory } from "@mimi-os/protocol";
import type {
    EventBody,
    FoldedEntry,
    Message,
    SessionHead,
    SessionId,
    StoredEvent,
} from "@mimi-os/protocol";

import type { AgentPeer } from "../registry/peer.ts";
import type { Registry } from "../registry/registry.ts";

export interface CacheEntry {
    agent: string;
    session: SessionId;
    revision: number;
    headSeq: number;
    headHash: string;
    events: StoredEvent[];
    /** False while paging stopped short of the agent's head: a prefix that is never served as history. */
    complete: boolean;
    bytes: number;
    touchedAt: number;
    /** Memo of foldEvents(events); dropped whenever `events` changes. */
    projection: FoldedEntry[] | null;
}

interface SessionCacheOptions {
    registry: Registry;
    log?: (msg: string) => void;
    maxBytes?: number | undefined;
    ttlMs?: number | undefined;
}

const EVENTS_PAGE = 500;
const MAX_PAGES = 200;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TTL_MS = 30 * 60_000;
const UNMEASURABLE_BYTES = 64 * 1024;

/** The seq where the hash chain recomputed from `prev` first disagrees, or null when it holds. */
function chainBreak(prev: string, events: readonly StoredEvent[]): number | null {
    for (const ev of events) {
        let expect: string;
        try {
            expect = chainHash(prev, { seq: ev.seq, type: ev.type, payload: ev.payload });
        } catch {
            // a payload canon() refuses to encode cannot match its own hash: that IS the break
            return ev.seq;
        }
        if (expect !== ev.hash) return ev.seq;
        prev = ev.hash;
    }
    return null;
}

/** What an event costs the cache. A payload JSON.stringify refuses (nested deeper than the stack
 *  survives — JSON.parse accepts far more than it can write back) is charged a flat cost instead
 *  of throwing, so it can never be free either. */
const sizeOf = (ev: StoredEvent): number => {
    try {
        // an event with no `payload` key at all stringifies to undefined
        return (JSON.stringify(ev.payload)?.length ?? 0) + 96;
    } catch {
        return UNMEASURABLE_BYTES;
    }
};

const key = (agent: string, session: SessionId): string => `${agent}#${session}`;

// an agent names its own sessions and the pult builds request paths from them: nothing but a positive safe integer passes
export const isSessionId = (value: unknown): value is SessionId =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
        const abort = (): void => reject(signal.reason);
        const settle = (): void => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, { once: true });
        promise.then(
            (value) => {
                settle();
                resolve(value);
            },
            (error: unknown) => {
                settle();
                reject(error);
            },
        );
    });
}

export class SessionCache {
    private readonly registry: Registry;
    private readonly log: (msg: string) => void;
    private readonly maxBytes: number;
    private readonly ttlMs: number;
    private readonly map = new Map<string, CacheEntry>();
    private readonly inflight = new Map<string, Promise<void>>();

    constructor(opts: SessionCacheOptions) {
        this.registry = opts.registry;
        this.log = opts.log ?? ((): void => undefined);
        this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
        this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    }

    /** HEAD-check one session and return it up to date — every LLM call goes through here. */
    async ensure(agent: string, session: SessionId, signal?: AbortSignal): Promise<CacheEntry> {
        const got = await this.sync(agent, [session], signal);
        const entry = got.get(session);
        if (!entry) throw new Error(`agent "${agent}" does not know session ${session}`);
        // serving a prefix as the whole conversation is the one outcome that must not happen
        if (!entry.complete) {
            throw new Error(
                `agent "${agent}": session ${session} could not be read in full — ` +
                    `${entry.events.length} events are cached up to seq ${entry.headSeq}, retry to page on`,
            );
        }
        return entry;
    }

    /** One `session_head` frame for every session we hold of this agent — batched on purpose. */
    async sync(
        agent: string,
        ids: readonly SessionId[],
        signal?: AbortSignal,
    ): Promise<Map<SessionId, CacheEntry>> {
        const out = new Map<SessionId, CacheEntry>();
        if (!ids.length) return out;
        const peer = this.peer(agent);
        const heads = await peer.request("session_head", {
            sessions: [...new Set(ids)],
        }, signal ? { signal } : undefined);
        const byId = new Map(heads.heads.map((h) => [h.session, h]));
        for (const id of new Set(ids)) {
            const head = byId.get(id);
            if (!head) {
                // the agent no longer has it — a delete, or a session that never existed here
                this.drop(agent, id);
                continue;
            }
            // one reconcile at a time per session: two overlapping deltas would splice out of order
            out.set(
                id,
                await this.serialize(key(agent, id), () => this.reconcile(agent, head, signal), signal),
            );
        }
        this.prune(new Set([...out.keys()].map((id) => key(agent, id))));
        return out;
    }

    entry(agent: string, session: SessionId): CacheEntry | undefined {
        return this.map.get(key(agent, session));
    }

    /** Every session of this agent currently held — what a reconnect re-checks. */
    held(agent: string): SessionId[] {
        return [...this.map.values()].filter((e) => e.agent === agent).map((e) => e.session);
    }

    folded(entry: CacheEntry): FoldedEntry[] {
        entry.projection ??= foldEvents(entry.events);
        return entry.projection;
    }

    /** The prompt history: folded, then paired, so no request can carry a broken pair. */
    history(entry: CacheEntry): Message[] {
        return sanitizeHistory(this.folded(entry).map((e) => e.message));
    }

    /**
     * Replay our own append locally instead of refetching it — the hash chain is deterministic,
     * so a mismatch against the reported head means somebody else wrote in between (legal), and
     * our replay is no longer the agent's history: drop and refetch.
     */
    applyAppend(
        agent: string,
        session: SessionId,
        bodies: readonly EventBody[],
        head: SessionHead,
    ): void {
        const entry = this.map.get(key(agent, session));
        if (!entry) return;
        let seq = entry.headSeq;
        let revision = entry.revision;
        let hash = entry.headHash;
        const now = Date.now();
        const added: StoredEvent[] = [];
        for (const body of bodies) {
            seq += 1;
            revision += 1;
            hash = chainHash(hash, { seq, type: body.type, payload: body.payload });
            added.push({ ...body, seq, hash, createdAt: now });
        }
        if (head.headSeq !== seq || head.headHash !== hash || head.revision !== revision) {
            this.drop(agent, session);
            return;
        }
        entry.events.push(...added);
        entry.bytes += added.reduce((n, e) => n + sizeOf(e), 0);
        entry.revision = revision;
        entry.headSeq = seq;
        entry.headHash = hash;
        entry.projection = null;
        entry.touchedAt = Date.now();
    }

    drop(agent: string, session?: SessionId): void {
        if (session !== undefined) {
            this.map.delete(key(agent, session));
            return;
        }
        for (const k of [...this.map.keys()]) {
            if (this.map.get(k)?.agent === agent) this.map.delete(k);
        }
    }

    clear(): void {
        this.map.clear();
        this.inflight.clear();
    }

    private serialize<T>(k: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const prev = this.inflight.get(k) ?? Promise.resolve();
        const run = async (): Promise<T> => {
            signal?.throwIfAborted();
            return fn();
        };
        const next = prev.then(run, run);
        this.inflight.set(
            k,
            next.then(
                () => undefined,
                () => undefined,
            ),
        );
        return waitFor(next, signal);
    }

    private peer(agent: string): AgentPeer {
        const peer = this.registry.get(agent);
        if (!peer) throw new Error(`agent "${agent}" is not connected`);
        return peer;
    }

    private async reconcile(agent: string, head: SessionHead, signal?: AbortSignal): Promise<CacheEntry> {
        const cached = this.map.get(key(agent, head.session));
        if (!cached) return this.load(agent, head.session, signal);
        // a prefix never matches a head: page on from where the last read stopped
        if (!cached.complete) return this.delta(agent, cached, signal);
        if (cached.revision === head.revision) {
            if (cached.headHash === head.headHash) {
                cached.touchedAt = Date.now();
                return cached;
            }
            this.log(
                `[sessions] INTEGRITY ${agent}#${head.session}: revision ` +
                    `${head.revision} but hash ${cached.headHash.slice(0, 12)} != ` +
                    `${head.headHash.slice(0, 12)} — cache dropped, reloading in full\n`,
            );
            return this.load(agent, head.session, signal);
        }
        if (head.revision < cached.revision) {
            this.log(
                `[sessions] INTEGRITY ${agent}#${head.session}: the agent's revision went ` +
                    `backwards (${cached.revision} → ${head.revision}) — full reload\n`,
            );
            return this.load(agent, head.session, signal);
        }
        return this.delta(agent, cached, signal);
    }

    private async pull(
        peer: AgentPeer,
        session: SessionId,
        afterSeq: number,
        signal?: AbortSignal,
    ): Promise<{ events: StoredEvent[]; head: SessionHead; complete: boolean } | null> {
        let cursor = afterSeq;
        let head: SessionHead | null = null;
        const events: StoredEvent[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
            const got = await peer.request("events_after", {
                session,
                afterSeq: cursor,
                limit: EVENTS_PAGE,
            }, signal ? { signal } : undefined);
            head = got.head;
            if (got.events.length) {
                events.push(...got.events);
                cursor = got.events[got.events.length - 1]!.seq;
            }
            if (cursor >= head.headSeq) break;
            if (!got.events.length) break; // no progress: the head moved but nothing is readable
        }
        if (!head) return null;
        // out of pages, or a page that read nothing: what we hold stops short of the agent's head
        return { events, head, complete: cursor >= head.headSeq };
    }

    /**
     * The chain is recomputed from genesis (there's no cached head to chain onto), so an
     * in-place edit of an old row won't go unnoticed just because the cache is warm — loud
     * only, since the agent's db IS the truth and there's nothing better to fall back to.
     */
    private verify(
        agent: string,
        session: SessionId,
        events: readonly StoredEvent[],
        head: SessionHead,
    ): void {
        const complain = (what: string): void =>
            this.log(
                `[sessions] INTEGRITY ${agent}#${session}: ${what} — the log was written ` +
                    `past the SDK; serving it as read\n`,
            );
        const broken = chainBreak(GENESIS_HASH, events);
        if (broken !== null) {
            complain(`the chain breaks at seq ${broken}`);
            return;
        }
        const last = events.at(-1);
        // an incomplete read (paging cut short) is not a broken chain: only judge a whole log
        if (last?.seq === head.headSeq && last.hash !== head.headHash) {
            complain("the head hash does not match the chain");
        }
    }

    private async load(agent: string, session: SessionId, signal?: AbortSignal): Promise<CacheEntry> {
        const peer = this.peer(agent);
        this.map.delete(key(agent, session));
        const got = await this.pull(peer, session, 0, signal);
        if (!got) throw new Error(`agent "${agent}": session ${session} could not be read`);
        this.verify(agent, session, got.events, got.head);
        const last = got.events.at(-1);
        if (!got.complete) {
            this.log(
                `[sessions] INTEGRITY ${agent}#${session}: one pass read ${got.events.length} ` +
                    `events up to seq ${last?.seq ?? 0} but the head is at ${got.head.headSeq} — ` +
                    `kept as a prefix, the next check pages on\n`,
            );
        }
        const entry: CacheEntry = {
            agent,
            session,
            revision: got.head.revision,
            // a prefix is stamped with what was actually read, never with the head it never reached
            headSeq: got.complete ? got.head.headSeq : (last?.seq ?? 0),
            headHash: got.complete ? got.head.headHash : (last?.hash ?? GENESIS_HASH),
            events: got.events,
            complete: got.complete,
            bytes: got.events.reduce((n, e) => n + sizeOf(e), 0),
            touchedAt: Date.now(),
            projection: null,
        };
        this.map.set(key(agent, session), entry);
        return entry;
    }

    private async delta(agent: string, cached: CacheEntry, signal?: AbortSignal): Promise<CacheEntry> {
        const peer = this.peer(agent);
        const got = await this.pull(peer, cached.session, cached.headSeq, signal);
        if (!got || !got.events.length) return this.load(agent, cached.session, signal);
        const first = got.events[0]!;
        if (first.seq !== cached.headSeq + 1) return this.load(agent, cached.session, signal);

        // the chain is what makes a delta safe to trust: recompute it onto our own head
        const broken = chainBreak(cached.headHash, got.events);
        if (broken !== null) {
            this.log(
                `[sessions] INTEGRITY ${agent}#${cached.session}: the delta's hash chain breaks ` +
                    `at seq ${broken} — full reload\n`,
            );
            return this.load(agent, cached.session, signal);
        }
        const last = got.events.at(-1)!;
        if (got.complete && (last.seq !== got.head.headSeq || last.hash !== got.head.headHash)) {
            return this.load(agent, cached.session, signal);
        }
        cached.events.push(...got.events);
        cached.bytes += got.events.reduce((n, e) => n + sizeOf(e), 0);
        cached.revision = got.head.revision;
        cached.headSeq = last.seq;
        cached.headHash = last.hash;
        cached.complete = got.complete;
        cached.projection = null;
        cached.touchedAt = Date.now();
        return cached;
    }

    /** Eviction is always safe (the cache is never truth) — except of `keep`, what this sync is handing back. */
    private prune(keep: ReadonlySet<string>): void {
        const now = Date.now();
        for (const [k, e] of [...this.map]) {
            if (!keep.has(k) && now - e.touchedAt > this.ttlMs) this.map.delete(k);
        }
        let total = 0;
        for (const e of this.map.values()) total += e.bytes;
        if (total <= this.maxBytes) return;
        const oldest = [...this.map.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
        for (const [k, e] of oldest) {
            if (total <= this.maxBytes) break;
            if (keep.has(k)) continue;
            // a prefix still being paged in is the one entry eviction is not safe for: dropping it
            // restarts the read from seq 0, so the cursor would never reach the head (the TTL pass
            // above still reaps one nobody is retrying)
            if (!e.complete) continue;
            total -= e.bytes;
            this.map.delete(k);
        }
    }
}
