/** The gateway decides compaction (it sees prompt_tokens); the agent just writes the append event. */

import type { FoldedEntry, Message, SessionId } from "@mimi-os/protocol";

import { NotSentError, type ProviderResponse } from "../llm/base/index.ts";
import { createProvider, type ModelConfig } from "../llm/models.ts";
import { admitAtDequeue } from "../llm/policy.ts";
import { enqueueCall } from "../llm/queue.ts";
import { estimateUsage, newCallId, recordLlmCall } from "../store/accounting.ts";
import { gatewayDb, type GatewayDb } from "../store/db.ts";

export interface Thresholds {
    at: number;
    keepTailTokens: number;
    minPrefixTokens: number;
}

interface CompactionPlan {
    covers: [number, number];
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

const KEEP_TAIL_FLOOR_TOKENS = 500;
const MIN_PREFIX_FLOOR_TOKENS = 250;
const MIN_PREFIX_MESSAGES = 3;

const SUMMARY_MSG_MAX = 600;
const SUMMARY_TRANSCRIPT_MAX = 20_000;

const BASE_INSTRUCTION =
    "Compactly summarize this EARLIER PART of a long conversation so the summary can replace " +
    "it: durable facts, decisions, results, open threads. 3-6 sentences, no preamble.";

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
    const { agent, session, cfg, signal } = call;
    const request: Message[] = [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: `${BASE_INSTRUCTION}\n\n${lines.join("\n")}` },
    ];
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
    return !failed && got.finishReason === "stop" ? got.text.trim() || null : null;
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

/** History slice → "role: capped body" transcript lines for the summarizer. */
function flattenForSummary(messages: readonly Message[]): string[] {
    const lines: string[] = [];
    for (const m of messages) {
        const text =
            typeof m.content === "string" && m.content
                ? m.content
                : (m.tool_calls?.map((c) => `${c.name}(${c.arguments})`).join("; ") ?? "");
        // images sent without words still happened: the reply to them must not read as answering nothing
        const pictures = m.images?.length ?? 0;
        const body = pictures ? `[${pictures} image${pictures === 1 ? "" : "s"}]${text ? ` ${text}` : ""}` : text;
        if (!body) continue;
        lines.push(
            `${m.role}: ${body.length > SUMMARY_MSG_MAX ? `${body.slice(0, SUMMARY_MSG_MAX)}…` : body}`,
        );
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
    const prefixTokens = prefix.reduce((n, e) => n + messageChars(e.message) / CHARS_PER_TOKEN, 0);
    if (prefixTokens < t.minPrefixTokens) return null;
    // a summary entry stands for the compaction event that WROTE it, which can sit past the kept
    // tail: covering up to its span would hide tail messages this summary never described
    const firstKept = entries[boundary];
    const reach = prefix.reduce((n, e) => Math.max(n, e.span), 0);
    const coversEnd = firstKept === undefined ? reach : Math.min(reach, firstKept.seq - 1);
    if (coversEnd < firstSeq) return null;
    return {
        covers: [firstSeq, coversEnd],
        lines: capTranscript(flattenForSummary(prefix.map((e) => e.message))),
        prefixMessages: prefix.length,
        prefixTokens: Math.round(prefixTokens),
    };
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
        lines: capTranscript(flattenForSummary(inRange.map((e) => e.message))),
        prefixMessages: inRange.length,
        prefixTokens: Math.round(
            inRange.reduce((n, e) => n + messageChars(e.message) / CHARS_PER_TOKEN, 0),
        ),
    };
}
