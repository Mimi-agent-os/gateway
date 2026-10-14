/** The gateway decides compaction (it sees prompt_tokens and counts images); the agent just writes the append event. */

import { IMAGE_TOKENS, MAX_IMAGES, projectMessage } from "@mimi-os/protocol";
import type { CompactionPayload, FoldedEntry, ImageNotes, Message, SessionId } from "@mimi-os/protocol";

import { NotSentError, type ProviderResponse } from "../llm/base/index.ts";
import { createProvider, type ModelConfig } from "../llm/models.ts";
import { admitAtDequeue } from "../llm/policy.ts";
import { enqueueCall } from "../llm/queue.ts";
import { estimateUsage, newCallId, recordLlmCall } from "../store/accounting.ts";
import { gatewayDb, type GatewayDb } from "../store/db.ts";
import { HELD_IMAGES, IMAGE_NOT_SHOWN, type CacheEntry, type SessionCache } from "./sessions.ts";

export interface Thresholds {
    at: number;
    keepTailTokens: number;
    minPrefixTokens: number;
    /** Undescribed images a fold leaves as pixels, the newest message whole whatever its count. */
    keepImages: number;
    /** Undescribed visible images past which a vision model's turn folds the older ones. */
    imagesAt: number;
}

interface CompactionPlan {
    covers: [number, number];
    prefix: FoldedEntry[];
    lines: string[];
    prefixMessages: number;
    prefixTokens: number;
}

/** Mixed UA/EN on qwen-class tokenizers sits around here; good enough for a threshold. */
const CHARS_PER_TOKEN = 4;

/** Every threshold is a FRACTION of the model's own contextTokens — no absolute constants. */
const DEFAULT_COMPACT_AT = 0.6;
const DEFAULT_KEEP_TAIL = 0.15;
const DEFAULT_MIN_PREFIX = 0.05;
const DEFAULT_KEEP_IMAGES = 0.15;
const DEFAULT_IMAGES_AT = 0.3;

const KEEP_TAIL_FLOOR_TOKENS = 500;
const MIN_PREFIX_FLOOR_TOKENS = 250;
const MIN_PREFIX_MESSAGES = 3;

const SUMMARY_MSG_MAX = 600;
const SUMMARY_TRANSCRIPT_MAX = 20_000;

const DESCRIBE_BATCH = 8;
const NOTE_MAX_CHARS = 800;
/** After a describe that left images without a line, the image fold rests this long: each try is a call per eight images. */
const DESCRIBE_RETRY_MS = 10 * 60_000;
const DESCRIBE_CONTEXT_CHARS = 300;
const DESCRIBE_SYSTEM = "You turn images into the words that will replace them in a conversation log.";
const DESCRIBE_INSTRUCTION =
    "These images leave the conversation; your lines stay in their place. Write exactly one line per " +
    "image, '<n>: <description>' with n as numbered below: what it shows, then every text, number, " +
    "name, date and amount on it that matters, copied exactly. At most 80 words a line. No other lines.";

// the user lines arrive stamped with when they were said (SessionCache.folded): a summary that
// keeps the dates keeps "tomorrow" meaning the day it meant. In words, never the bracketed stamp:
// the summary returns as an assistant line, and a stamp there teaches the model to write them
const BASE_INSTRUCTION =
    "Compactly summarize this EARLIER PART of a long conversation so the summary can replace " +
    "it: durable facts, decisions, results, open threads. Where the day matters, name it in the " +
    "sentence itself, never as a bracketed line. 3-6 sentences, no preamble.";

const SUMMARY_SYSTEM = "You write terse work-session summaries.";

export interface SummaryCall {
    agent: string;
    session: SessionId;
    /** The model the summary is asked of: the agent's own, as its turns resolve it. */
    cfg: ModelConfig;
    turnSeq: number | null;
    signal?: AbortSignal | undefined;
}

/** The one summarize call both compaction paths make, always accounted; only a clean "stop" becomes a summary. */
export async function summarize(call: SummaryCall, lines: readonly string[], db: GatewayDb): Promise<string | null> {
    const text = await complete(call, [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: `${BASE_INSTRUCTION}\n\n${lines.join("\n")}` },
    ], db);
    return text?.trim() || null;
}

/** One compaction call of the agent's own model, accounted as "compaction": its text on a clean "stop", else null. */
async function complete(call: SummaryCall, request: Message[], db: GatewayDb): Promise<string | null> {
    const { agent, session, cfg, signal } = call;
    const t0 = performance.now();
    let model: string | null = null;
    // filled as it streams: a call that throws keeps what the provider already sent
    const got: ProviderResponse = { thinking: "", text: "", toolCalls: [], finishReason: "error" };
    let dispatched = false;
    let failed: unknown = null;
    // the model row may have changed since the turn began: a provider that cannot be built skips compaction, never fails the turn
    try {
        const provider = createProvider(cfg.name, db);
        model = provider.model ?? null;
        await enqueueCall(
            cfg.endpointUrl,
            () => {
                // the same gate as every other call of this agent, at dequeue: pause, grant, daily limit
                admitAtDequeue(agent, cfg, db);
                dispatched = true;
                return provider.complete(request, [], signal, got);
            },
            "background",
            signal,
        );
    } catch (e) {
        failed = e;
    }
    // as a turn: a call the provider had but never reported is estimated, never free
    const estimate =
        got.usage === undefined &&
        dispatched &&
        !(failed instanceof NotSentError) &&
        (got.accepted === true || signal?.aborted === true)
            ? estimateUsage(request, [], got.thinking + got.text)
            : undefined;
    recordLlmCall(
        {
            agent,
            scope: `${agent}:compaction`,
            callId: newCallId(),
            callKind: "compaction",
            session,
            model,
            provider: cfg.provider,
            registryModel: cfg.name,
            modelUid: cfg.modelUid,
            reportedModel: got.model ?? null,
            attempt: 1,
            parentCallId: null,
            turnSeq: call.turnSeq,
            finishReason: failed ? "error" : got.finishReason,
            usage: got.usage ?? estimate,
            usageEstimated: estimate !== undefined,
            dispatched,
            durationMs: Math.round(performance.now() - t0),
            raw: failed ? { error: String(failed) } : { text: got.text, finishReason: got.finishReason },
        },
        db,
    );
    return !failed && got.finishReason === "stop" ? got.text : null;
}

/** The model's "<n>: <description>" lines, one slot per image: "" where no line named it. */
export function parseNotes(text: string, count: number): string[] {
    const notes = Array.from({ length: count }, () => "");
    for (const line of text.split("\n")) {
        const m = /^[\s*#>-]*(\d+)\**\s*[:.)]\**\s*(.*\S)/.exec(line);
        if (!m) continue;
        const n = Number(m[1]);
        if (n < 1 || n > count || notes[n - 1]) continue;
        const note = m[2]!;
        notes[n - 1] = note.length > NOTE_MAX_CHARS ? `${note.slice(0, NOTE_MAX_CHARS - 1)}…` : note;
    }
    return notes;
}

/**
 * Notes for each message whose every image got a line, by seq. Batches of DESCRIBE_BATCH images,
 * read one message at a time (held pixels, else one event back from the agent); a batch that
 * fails leaves its messages as pixels for the next pass, which asks only for the images the
 * entry's drafts still lack a line for. Never throws: a stop just ends it early.
 */
async function describe(
    call: SummaryCall,
    sessions: SessionCache,
    entry: CacheEntry,
    seqs: readonly number[],
    db: GatewayDb,
): Promise<Map<number, string[]>> {
    const got = new Map<number, string[]>();
    let batch: string[] = [];
    let context: string[] = [];
    let owners: Array<[number, number]> = [];
    const flush = async (): Promise<void> => {
        if (!batch.length) return;
        const text = await complete(call, [
            { role: "system", content: DESCRIBE_SYSTEM },
            { role: "user", content: `${DESCRIBE_INSTRUCTION}\n\n${context.join("\n")}`, images: batch },
        ], db);
        const notes = text === null ? [] : parseNotes(text, batch.length);
        for (const [i, [seq, at]] of owners.entries()) got.get(seq)![at] = notes[i] ?? "";
        batch = [];
        context = [];
        owners = [];
    };
    for (const seq of seqs) {
        if (call.signal?.aborted) break;
        let uris: string[];
        try {
            uris = await sessions.images(entry, seq, call.signal);
        } catch {
            continue;
        }
        const notes = uris.map((_u, i) => entry.drafts.get(seq)?.[i] ?? "");
        got.set(seq, notes);
        const said = projectMessage(entry.events.find((e) => e.seq === seq)?.payload)?.content?.trim() ?? "";
        const missing = notes.flatMap((n, i) => (n ? [] : [i]));
        for (let k = 0; k < missing.length; ) {
            const take = Math.min(DESCRIBE_BATCH - batch.length, missing.length - k);
            const from = batch.length + 1;
            const which = take === 1 ? `Image ${from}` : `Images ${from}-${from + take - 1}`;
            context.push(said ? `${which} came with the message: ${said.slice(0, DESCRIBE_CONTEXT_CHARS)}` : `${which} came with no words.`);
            for (const i of missing.slice(k, k + take)) {
                batch.push(uris[i]!);
                owners.push([seq, i]);
            }
            k += take;
            if (batch.length === DESCRIBE_BATCH) await flush();
        }
    }
    if (!call.signal?.aborted) await flush();
    const out = new Map<number, string[]>();
    for (const [seq, notes] of got) {
        if (notes.length && notes.every((n) => n !== "")) {
            out.set(seq, notes);
            entry.drafts.delete(seq);
        } else if (notes.some((n) => n !== "")) entry.drafts.set(seq, notes);
    }
    return out;
}

const fraction = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1 ? v : fallback;

function overrideOf(model: ModelConfig | null, db: GatewayDb): Record<string, unknown> {
    const inParams = model?.params["compaction"];
    if (inParams !== null && typeof inParams === "object" && !Array.isArray(inParams)) {
        return inParams as Record<string, unknown>;
    }
    // providers that validate their params reject an unknown key, so settings is the other door
    if (!model) return {};
    const raw = db.getSetting(`compaction:${model.name}`);
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        /* a malformed override is no override */
    }
    return {};
}

/** null = compaction is OFF for this model: no context window means no honest threshold. */
export function thresholdsFor(model: ModelConfig | null, db: GatewayDb = gatewayDb()): Thresholds | null {
    const ctx = model?.contextTokens ?? 0;
    if (!Number.isFinite(ctx) || ctx <= 0) return null;
    const o = overrideOf(model, db);
    const keepImages = Math.min(
        MAX_IMAGES,
        Math.max(1, Math.floor((ctx * fraction(o["keepImages"], DEFAULT_KEEP_IMAGES)) / IMAGE_TOKENS)),
    );
    return {
        at: fraction(o["at"], DEFAULT_COMPACT_AT),
        keepTailTokens: Math.max(
            KEEP_TAIL_FLOOR_TOKENS,
            Math.round(ctx * fraction(o["keepTail"], DEFAULT_KEEP_TAIL)),
        ),
        minPrefixTokens: Math.max(
            MIN_PREFIX_FLOOR_TOKENS,
            Math.round(ctx * fraction(o["minPrefix"], DEFAULT_MIN_PREFIX)),
        ),
        keepImages,
        // the cache holds HELD_IMAGES: a trigger past it would leave images it cannot show
        imagesAt: Math.min(
            HELD_IMAGES,
            Math.max(keepImages + 1, Math.floor((ctx * fraction(o["imagesAt"], DEFAULT_IMAGES_AT)) / IMAGE_TOKENS)),
        ),
    };
}

export function shouldCompact(t: Thresholds, contextTokens: number, promptTokens: number): boolean {
    if (contextTokens <= 0 || promptTokens <= 0) return false;
    return promptTokens >= contextTokens * t.at;
}

/** Chars a message contributes to the prompt (text + tool-call names and arguments). */
function messageChars(m: Message): number {
    let total = typeof m.content === "string" ? m.content.length : 0;
    for (const c of m.tool_calls ?? []) total += c.name.length + c.arguments.length;
    return total;
}

/** History slice → "role: capped body" transcript lines for the summarizer. `pictures` counts the
 *  undescribed images by seq; a message in `notes` reads its new notes instead, uncut. */
function flattenForSummary(
    entries: readonly FoldedEntry[],
    pictures?: ReadonlyMap<number, number>,
    notes?: ReadonlyMap<number, string[]>,
): string[] {
    const lines: string[] = [];
    for (const { seq, message: m } of entries) {
        const raw =
            typeof m.content === "string" && m.content
                ? m.content
                : (m.tool_calls?.map((c) => `${c.name}(${c.arguments})`).join("; ") ?? "");
        const described = notes?.get(seq);
        const text = described ? raw.split("\n").filter((l) => l !== IMAGE_NOT_SHOWN).join("\n") : raw;
        // images sent without words still happened: the reply to them must not read as answering nothing
        const count = described ? 0 : (pictures?.get(seq) ?? m.images?.length ?? 0);
        const body = count ? `[${count} image${count === 1 ? "" : "s"}]${text ? ` ${text}` : ""}` : text;
        const capped = body.length > SUMMARY_MSG_MAX ? `${body.slice(0, SUMMARY_MSG_MAX)}…` : body;
        const said = [capped, ...(described ?? []).map((n) => `[earlier image: ${n}]`)].filter(Boolean).join("\n");
        if (said) lines.push(`${m.role}: ${said}`);
    }
    return lines;
}

/** Newest lines win — the summarize request must never approach the window that just overflowed. */
function capTranscript(lines: readonly string[]): string[] {
    let total = 0;
    const kept: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (total + line.length > SUMMARY_TRANSCRIPT_MAX) break;
        total += line.length + 1;
        kept.unshift(line);
    }
    if (kept.length < lines.length) {
        kept.unshift(`(${lines.length - kept.length} earlier messages omitted)`);
    }
    return kept;
}

/**
 * `covers[0]` is the session's first seq, so an earlier compaction's anchor there is REPLACED
 * rather than duplicated; `covers[1]` is the largest raw seq any folded prefix entry stands for,
 * so an older summary's events are re-covered along with it.
 */
export function planCompaction(
    entries: readonly FoldedEntry[],
    firstSeq: number,
    t: Thresholds,
    pictures?: ReadonlyMap<number, number>,
): CompactionPlan | null {
    if (entries.length < MIN_PREFIX_MESSAGES + 1) return null;
    let kept = 0;
    let boundary = entries.length;
    while (boundary > 0) {
        const size = messageChars(entries[boundary - 1]!.message) / CHARS_PER_TOKEN;
        if (kept + size > t.keepTailTokens) break;
        kept += size;
        boundary--;
    }
    // the question being answered always stays: a prompt that is only a summary has nothing to answer
    const lastUser = entries.findLastIndex((e) => e.message.role === "user");
    if (lastUser >= 0) boundary = Math.min(boundary, lastUser);
    // never split a tool run: the kept tail must not START with a tool result
    while (boundary > 0 && entries[boundary]?.message.role === "tool") boundary--;
    if (boundary === entries.length) return null;
    const prefix = entries.slice(0, boundary);
    if (prefix.length < MIN_PREFIX_MESSAGES) return null;
    // undescribed images weigh in: an image-heavy prefix qualifies on what it costs the window
    const prefixTokens = prefix.reduce(
        (n, e) => n + messageChars(e.message) / CHARS_PER_TOKEN + (pictures?.get(e.seq) ?? 0) * IMAGE_TOKENS,
        0,
    );
    if (prefixTokens < t.minPrefixTokens) return null;
    // a summary entry stands for the compaction event that WROTE it, which can sit past the kept
    // tail: covering up to its span would hide tail messages this summary never described
    const firstKept = entries[boundary];
    const reach = prefix.reduce((n, e) => Math.max(n, e.span), 0);
    const coversEnd = firstKept === undefined ? reach : Math.min(reach, firstKept.seq - 1);
    if (coversEnd < firstSeq) return null;
    return {
        covers: [firstSeq, coversEnd],
        prefix,
        lines: capTranscript(flattenForSummary(prefix, pictures)),
        prefixMessages: prefix.length,
        prefixTokens: Math.round(prefixTokens),
    };
}

/** The undescribed image messages past the pixel window, oldest first: the newest whole messages
 *  within keepImages stay, and the newest always does (the turn guard fitted it to the window). */
export function olderImages(pictures: ReadonlyMap<number, number>, keepImages: number): number[] {
    const seqs = [...pictures.keys()];
    let kept = 0;
    let at = seqs.length;
    while (at > 0) {
        const count = pictures.get(seqs[at - 1]!) ?? 0;
        if (at < seqs.length && kept + count > keepImages) break;
        kept += count;
        at--;
    }
    return seqs.slice(0, at);
}

/** What one pass may do: summarize the prefix, and fold the images older than the pixel window. */
export interface PassWant {
    text: boolean;
    images: boolean;
}

export interface PassResult {
    /** The one compaction event to append, or null when there is nothing to write. */
    payload: CompactionPayload | null;
    /** The summarized prefix, when the text plan found one. */
    plan: CompactionPlan | null;
}

/**
 * The one pass both compaction paths run. A vision model describes the images it folds, and the
 * undescribed ones of the prefix a summary will cover, BEFORE the summary call: the summary reads
 * the notes, and a summary that fails still leaves them to store. A text-only model describes nothing.
 */
export async function compactionPass(
    call: SummaryCall,
    sessions: SessionCache,
    entry: CacheEntry,
    t: Thresholds,
    want: PassWant,
    db: GatewayDb,
): Promise<PassResult> {
    const pictures = sessions.undescribed(entry);
    const plan = want.text ? planCompaction(sessions.folded(entry), entry.events[0]?.seq ?? 0, t, pictures) : null;
    const older = new Set(want.images ? olderImages(pictures, t.keepImages) : []);
    const seqs = call.cfg.vision
        ? [...pictures.keys()].filter((seq) => older.has(seq) || (plan !== null && seq >= plan.covers[0] && seq <= plan.covers[1]))
        : [];
    const notes = seqs.length ? await describe(call, sessions, entry, seqs, db) : new Map<number, string[]>();
    if (seqs.length && !call.signal?.aborted) entry.foldAfter = seqs.every((seq) => notes.has(seq)) ? 0 : Date.now() + DESCRIBE_RETRY_MS;
    const images: ImageNotes[] = [...notes].map(([seq, n]) => ({ seq, notes: n }));
    if (plan) {
        const lines = notes.size ? capTranscript(flattenForSummary(plan.prefix, pictures, notes)) : plan.lines;
        const summary = await summarize(call, lines, db);
        if (summary !== null) return { payload: { summary, covers: plan.covers, ...(images.length ? { images } : {}) }, plan };
    }
    return { payload: images.length ? { images } : null, plan };
}

/** Auto-fold's mechanical summary: the fold tools' own traffic named, with no model call. */
export function toolTrafficSummary(
    entries: readonly FoldedEntry[],
    fromSeq: number,
    toSeq: number,
): string {
    const names: string[] = [];
    let count = 0;
    for (const e of entries) {
        if (e.span < fromSeq || e.span > toSeq) continue;
        for (const c of e.message.tool_calls ?? []) {
            count++;
            if (!names.includes(c.name)) names.push(c.name);
        }
    }
    const shown = names.slice(0, 3);
    if (names.length > shown.length) shown.push("…");
    return `${count} tool call${count === 1 ? "" : "s"}: ${shown.join(", ")}`;
}

/** `done`: fold the tool traffic of the range the current turn just wrote, nothing before it. */
export function planSessionClose(
    entries: readonly FoldedEntry[],
    fromSeq: number,
    toSeq: number,
): CompactionPlan | null {
    if (toSeq < fromSeq) return null;
    const inRange = entries.filter((e) => e.span >= fromSeq && e.span <= toSeq);
    if (!inRange.length) return null;
    return {
        covers: [fromSeq, toSeq],
        prefix: inRange,
        lines: capTranscript(flattenForSummary(inRange)),
        prefixMessages: inRange.length,
        prefixTokens: Math.round(
            inRange.reduce((n, e) => n + messageChars(e.message) / CHARS_PER_TOKEN, 0),
        ),
    };
}
