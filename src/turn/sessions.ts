/** RAM cache of agent sessions — HEAD check, delta fold, integrity reload; never the truth. */

import { foldEvents, GENESIS_HASH, chainHash, imageNotesOf, MAX_IMAGES, projectMessage, sanitizeHistory } from "@mimi-os/protocol";
import type {
    EventBody,
    EventsAfterOkPayload,
    EventsAfterPayload,
    FoldedEntry,
    Message,
    SessionHead,
    SessionId,
    StoredEvent,
} from "@mimi-os/protocol";

import type { AgentPeer } from "../registry/peer.ts";
import type { Registry } from "../registry/registry.ts";
import { momentStamp } from "./prompt.ts";

export interface CacheEntry {
    agent: string;
    session: SessionId;
    revision: number;
    headSeq: number;
    headHash: string;
    /** As the agent stored them, minus every message's `images`: those leave once the chain has checked them. */
    events: StoredEvent[];
    /** False while paging stopped short of the agent's head: a prefix that is never served as history. */
    complete: boolean;
    /** The events as held, and the pixels. */
    bytes: number;
    /** How many images each message had, by seq: what `events` no longer carries. */
    images: Map<number, number>;
    /** The data-URIs of the newest undescribed visible image messages, by seq: whole messages, the newest always, at most HELD_IMAGES. */
    pixels: Map<number, string[]>;
    /** Lines a describe pass got for part of a message's images, by seq: the next pass asks only for the rest. */
    drafts: Map<number, string[]>;
    /** No image fold is tried before this time: the last describe left images without a line. */
    foldAfter: number;
    touchedAt: number;
    /** Memo of folded(): foldEvents(events) with pixels attached and the user lines stamped; dropped whenever `events` or `pixels` change. */
    projection: FoldedEntry[] | null;
}

interface SessionCacheOptions {
    registry: Registry;
    log?: (msg: string) => void;
    maxBytes?: number | undefined;
    ttlMs?: number | undefined;
    maxPages?: number | undefined;
}

const EVENTS_PAGE = 500;
const MAX_PAGES = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
// entries are small once their images are stripped: a reopen within a day refetches only the held ones
const DEFAULT_TTL_MS = 24 * 3_600_000;
const UNMEASURABLE_BYTES = 64 * 1024;
/** Event reads in flight to agents at once across the gateway: one may carry a 16 MiB event, which
 *  the agent and the gateway each hold several times over while it travels. */
const READS = 2;
/** Image data-URIs one cached chat holds for its prompt: at most 30 720 000 bytes. */
export const HELD_IMAGES = 2 * MAX_IMAGES;
export const IMAGE_NOT_SHOWN = "[image not shown: older images of this chat wait to be described]";

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

/** The event as the cache keeps it, without its images, and the images of it a model can be shown. */
function stripped(ev: StoredEvent): [StoredEvent, string[]] {
    // the payload is as the agent wrote it, whatever its type says
    if (ev.type !== "message" || ev.payload === null || typeof ev.payload !== "object" || !("images" in ev.payload)) return [ev, []];
    const { images: _images, ...rest } = ev.payload;
    return [{ ...ev, payload: rest }, projectMessage(ev.payload)?.images ?? []];
}

/** One read of events, checked and stripped page by page: what a load or a delta keeps. */
interface Pulled {
    events: StoredEvent[];
    images: Map<number, number>;
    /** The newest image messages read, whole, at most HELD_IMAGES images (the newest always). */
    pixels: Map<number, string[]>;
    head: SessionHead;
    complete: boolean;
    /** The first seq whose hash does not chain from the one before it. */
    broken: number | null;
}

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
    private readonly maxPages: number;
    private readonly map = new Map<string, CacheEntry>();
    private readonly inflight = new Map<string, Promise<void>>();
    private reading = 0;
    private readonly readers: Array<() => void> = [];

    constructor(opts: SessionCacheOptions) {
        this.registry = opts.registry;
        this.log = opts.log ?? ((): void => undefined);
        this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
        this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
        this.maxPages = opts.maxPages ?? MAX_PAGES;
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
                await this.serialize(
                    key(agent, id),
                    async () => this.hold(await this.reconcile(agent, head, signal), signal),
                    signal,
                ),
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

    /**
     * What every model-facing read of a session works from (the prompt, both compactions): the fold,
     * each user line opened by the time its event was stored, so "tomorrow" in a message from last
     * week reads as last week's. Stored times make the stamps byte-identical turn to turn (the
     * provider's prompt cache holds); the log keeps no stamp, and the app reads `events`, never this.
     */
    folded(entry: CacheEntry): FoldedEntry[] {
        if (entry.projection) return entry.projection;
        const times = new Map(entry.events.map((ev) => [ev.seq, ev.createdAt]));
        const described = imageNotesOf(entry.events);
        entry.projection = foldEvents(entry.events).map((raw) => {
            // a summary stands at a covered seq: only a message's own entry has span === seq
            const count = raw.span === raw.seq && !described.has(raw.seq) ? (entry.images.get(raw.seq) ?? 0) : 0;
            const pixels = count ? entry.pixels.get(raw.seq) : undefined;
            const unseen = Array.from({ length: pixels ? 0 : count }, () => IMAGE_NOT_SHOWN).join("\n");
            const e: FoldedEntry = pixels
                ? { ...raw, message: { ...raw.message, images: pixels } }
                : unseen
                  ? { ...raw, message: { ...raw.message, content: raw.message.content ? `${raw.message.content}\n${unseen}` : unseen } }
                  : raw;
            const at = times.get(e.seq);
            // the user's lines only: a stamped assistant line teaches a model to write stamps itself.
            // A summary is an assistant line too, whatever seq it anchors at; and a time that is no
            // real date (the log is read as the agent wrote it) leaves its line unstamped
            if (e.message.role !== "user" || typeof at !== "number" || Number.isNaN(new Date(at).getTime())) return e;
            const stamp = `[${momentStamp(at)}]`;
            // images alone still happened at a time: the stamp is then the whole text
            return { ...e, message: { ...e.message, content: e.message.content ? `${stamp}\n${e.message.content}` : stamp } };
        });
        return entry.projection;
    }

    /** The prompt history: folded, then paired, so no request can carry a broken pair. */
    history(entry: CacheEntry): Message[] {
        return sanitizeHistory(this.folded(entry).map((e) => e.message));
    }

    /** Each visible message whose images no compaction has described, oldest first: seq → how many. */
    undescribed(entry: CacheEntry): Map<number, number> {
        const described = imageNotesOf(entry.events);
        const out = new Map<number, number>();
        for (const e of this.folded(entry)) {
            const count = e.span === e.seq && !described.has(e.seq) ? (entry.images.get(e.seq) ?? 0) : 0;
            if (count) out.set(e.seq, count);
        }
        return out;
    }

    /** One message's images: held, or read back from the agent one event at a time and checked
     *  against the hash the cache verified for it — what describe and the app's image route read. */
    async images(entry: CacheEntry, seq: number, signal?: AbortSignal): Promise<string[]> {
        const held = entry.pixels.get(seq);
        if (held) return held;
        const at = entry.events.findIndex((e) => e.seq === seq);
        const cached = entry.events[at];
        if (!cached) throw new Error(`seq ${seq} is not in the cached log of ${entry.agent}#${entry.session}`);
        const prev = at > 0 ? entry.events[at - 1]!.hash : GENESIS_HASH;
        const got = await this.eventsAfter(this.peer(entry.agent), { session: entry.session, afterSeq: seq - 1, limit: 1 }, signal);
        const ev = got.events[0];
        if (ev?.seq !== seq || chainHash(prev, { seq, type: ev.type, payload: ev.payload }) !== cached.hash) {
            throw new Error(`the agent's copy of seq ${seq} does not match the hash the gateway checked`);
        }
        return projectMessage(ev.payload)?.images ?? [];
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
        // a plain message moves no image window: only images, a compaction or a truncate can
        let moved = false;
        for (const ev of added) {
            const [kept, shown] = stripped(ev);
            entry.events.push(kept);
            entry.bytes += sizeOf(kept);
            entry.projection = null;
            if (shown.length) {
                // the turn's own images: the strings the route parsed, never a copy
                entry.images.set(ev.seq, shown.length);
                this.setPixels(entry, ev.seq, shown);
            }
            moved ||= ev.type !== "message" || shown.length > 0;
        }
        entry.revision = revision;
        entry.headSeq = seq;
        entry.headHash = hash;
        entry.touchedAt = Date.now();
        if (moved) this.trim(entry);
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

    /** One events_after request, at most READS of them in flight and the rest waiting in order. */
    private async eventsAfter(peer: AgentPeer, payload: EventsAfterPayload, signal?: AbortSignal): Promise<EventsAfterOkPayload> {
        signal?.throwIfAborted();
        if (this.reading < READS) this.reading++;
        else {
            await new Promise<void>((go, stop) => {
                const turn = (): void => {
                    signal?.removeEventListener("abort", quit);
                    go();
                };
                const quit = (): void => {
                    this.readers.splice(this.readers.indexOf(turn), 1);
                    stop(signal?.reason);
                };
                this.readers.push(turn);
                signal?.addEventListener("abort", quit, { once: true });
            });
        }
        try {
            return await peer.request("events_after", payload, signal ? { signal } : undefined);
        } finally {
            // the slot passes straight to the next caller, so a waiter is never overtaken
            const next = this.readers.shift();
            if (next) next();
            else this.reading--;
        }
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

    /** Pages from `afterSeq`, each chained onto `prev` and stripped of its images before the next is
     *  asked for: a chat's whole image history streams through, never sits in memory at once. */
    private async pull(
        peer: AgentPeer,
        session: SessionId,
        afterSeq: number,
        prev: string,
        signal?: AbortSignal,
    ): Promise<Pulled | null> {
        let cursor = afterSeq;
        let head: SessionHead | null = null;
        let broken: number | null = null;
        const events: StoredEvent[] = [];
        const images = new Map<number, number>();
        const pixels = new Map<number, string[]>();
        let held = 0;
        for (let page = 0; page < this.maxPages; page++) {
            const got = await this.eventsAfter(peer, { session, afterSeq: cursor, limit: EVENTS_PAGE }, signal);
            head = got.head;
            broken ??= chainBreak(prev, got.events);
            for (const ev of got.events) {
                prev = ev.hash;
                const [kept, shown] = stripped(ev);
                events.push(kept);
                if (!shown.length) continue;
                images.set(ev.seq, shown.length);
                pixels.set(ev.seq, shown);
                held += shown.length;
                for (const [seq, older] of pixels) {
                    if (held <= HELD_IMAGES || pixels.size === 1) break;
                    pixels.delete(seq);
                    held -= older.length;
                }
            }
            if (got.events.length) cursor = got.events[got.events.length - 1]!.seq;
            if (cursor >= head.headSeq) break;
            if (!got.events.length) break; // no progress: the head moved but nothing is readable
        }
        if (!head) return null;
        // out of pages, or a page that read nothing: what we hold stops short of the agent's head
        return { events, images, pixels, head, complete: cursor >= head.headSeq, broken };
    }

    /**
     * The chain is recomputed from genesis (there's no cached head to chain onto), so an
     * in-place edit of an old row won't go unnoticed just because the cache is warm — loud
     * only, since the agent's db IS the truth and there's nothing better to fall back to.
     */
    private verify(agent: string, session: SessionId, got: Pulled): void {
        const complain = (what: string): void =>
            this.log(
                `[sessions] INTEGRITY ${agent}#${session}: ${what} — the log was written ` +
                    `past the SDK; serving it as read\n`,
            );
        if (got.broken !== null) {
            complain(`the chain breaks at seq ${got.broken}`);
            return;
        }
        const last = got.events.at(-1);
        // an incomplete read (paging cut short) is not a broken chain: only judge a whole log
        if (last?.seq === got.head.headSeq && last.hash !== got.head.headHash) {
            complain("the head hash does not match the chain");
        }
    }

    private async load(agent: string, session: SessionId, signal?: AbortSignal): Promise<CacheEntry> {
        const peer = this.peer(agent);
        this.map.delete(key(agent, session));
        const got = await this.pull(peer, session, 0, GENESIS_HASH, signal);
        if (!got) throw new Error(`agent "${agent}": session ${session} could not be read`);
        this.verify(agent, session, got);
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
            images: got.images,
            pixels: new Map(),
            drafts: new Map(),
            foldAfter: 0,
            touchedAt: Date.now(),
            projection: null,
        };
        for (const [seq, uris] of got.pixels) this.setPixels(entry, seq, uris);
        this.map.set(key(agent, session), entry);
        return entry;
    }

    private async delta(agent: string, cached: CacheEntry, signal?: AbortSignal): Promise<CacheEntry> {
        const peer = this.peer(agent);
        // the chain is what makes a delta safe to trust: recomputed onto our own head
        const got = await this.pull(peer, cached.session, cached.headSeq, cached.headHash, signal);
        if (!got || !got.events.length) return this.load(agent, cached.session, signal);
        const first = got.events[0]!;
        if (first.seq !== cached.headSeq + 1) return this.load(agent, cached.session, signal);
        if (got.broken !== null) {
            this.log(
                `[sessions] INTEGRITY ${agent}#${cached.session}: the delta's hash chain breaks ` +
                    `at seq ${got.broken} — full reload\n`,
            );
            return this.load(agent, cached.session, signal);
        }
        const last = got.events.at(-1)!;
        if (got.complete && (last.seq !== got.head.headSeq || last.hash !== got.head.headHash)) {
            return this.load(agent, cached.session, signal);
        }
        cached.events.push(...got.events);
        cached.bytes += got.events.reduce((n, e) => n + sizeOf(e), 0);
        for (const [seq, count] of got.images) cached.images.set(seq, count);
        for (const [seq, uris] of got.pixels) this.setPixels(cached, seq, uris);
        cached.revision = got.head.revision;
        cached.headSeq = last.seq;
        cached.headHash = last.hash;
        cached.complete = got.complete;
        cached.projection = null;
        cached.touchedAt = Date.now();
        return cached;
    }

    /** The window a prompt shows as pixels: the newest undescribed visible image messages, whole,
     *  the newest always, at most HELD_IMAGES. Held pixels outside it are dropped; the window is
     *  returned newest first. */
    private trim(entry: CacheEntry): number[] {
        const window: number[] = [];
        let count = 0;
        for (const [seq, n] of [...this.undescribed(entry)].reverse()) {
            if (window.length && count + n > HELD_IMAGES) break;
            window.push(seq);
            count += n;
        }
        for (const seq of [...entry.pixels.keys()]) if (!window.includes(seq)) this.setPixels(entry, seq, undefined);
        return window;
    }

    /** Trims to the window and reads back what it lacks, one event at a time; runs inside the
     *  serialized reconcile, so no delta splices while it reads. */
    private async hold(entry: CacheEntry, signal?: AbortSignal): Promise<CacheEntry> {
        if (!entry.complete || !entry.images.size) return entry;
        let fetched = false;
        for (const seq of this.trim(entry)) {
            if (entry.pixels.has(seq)) continue;
            try {
                this.setPixels(entry, seq, await this.images(entry, seq, signal));
                fetched = true;
            } catch (e) {
                signal?.throwIfAborted();
                this.log(`[sessions] ${entry.agent}#${entry.session}: the images of seq ${seq} were not read back — ${(e as Error).message}\n`);
            }
        }
        // a turn's append may have moved the window while this read
        if (fetched) this.trim(entry);
        return entry;
    }

    private setPixels(entry: CacheEntry, seq: number, uris: string[] | undefined): void {
        const before = entry.pixels.get(seq);
        if (before === uris) return;
        entry.bytes += (uris?.reduce((n, u) => n + u.length, 0) ?? 0) - (before?.reduce((n, u) => n + u.length, 0) ?? 0);
        if (uris) entry.pixels.set(seq, uris);
        else entry.pixels.delete(seq);
        entry.projection = null;
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
        // pixels go before entries: an idle chat reads back at most HELD_IMAGES when it is next opened
        for (const [k, e] of oldest) {
            if (total <= this.maxBytes) return;
            if (keep.has(k)) continue;
            total -= e.bytes;
            for (const seq of [...e.pixels.keys()]) this.setPixels(e, seq, undefined);
            total += e.bytes;
        }
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
