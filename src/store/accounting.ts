import { randomBytes } from "node:crypto";

import type { Message, SessionId, Tool, Usage } from "@mimi-os/protocol";

import { localDay } from "./day.ts";
import { gatewayDb, type GatewayDb } from "./db.ts";

export type CallKind = "turn" | "oneshot" | "title" | "compaction" | "ping";

/** Pings are the owner's, not an agent's: this name can never be an agent's. */
export const PING_AGENT = "(gateway)";

export interface LlmCallRecord {
    agent: string;
    /** "<agent>", "<agent>:compaction", "<agent>:title", "<agent>:<ask scope>" — the Calls list label. */
    scope: string;
    /** This call's own opaque id: what `done`, a fallback child and the message seqs point at. */
    callId: string;
    callKind: CallKind;
    session?: SessionId | null;
    /** The room a turn ran in — a room turn has no conversation, and never both. */
    room?: string | null;
    /** The provider's own model id — what went on the wire. */
    model?: string | null;
    /** The gateway adapter the call ran through (vllm/llamacpp/openrouter), frozen at call time. */
    provider?: string | null;
    /** The registry row that chose it: its immutable uid, and its alias as it read at call time. */
    modelUid?: string | null;
    registryModel?: string | null;
    /** The model the provider's own response named, when it named one. */
    reportedModel?: string | null;
    /** 1 for the first try of a call; a fallback/retry is 2 and names its predecessor. */
    attempt?: number;
    parentCallId?: string | null;
    /** The seq of the user message event that opened the turn this call belongs to. */
    turnSeq?: number | null;
    finishReason?: string | null;
    usage?: Usage | undefined;
    /** `usage` is estimateUsage()'s guess, not the provider's report. */
    usageEstimated?: boolean | undefined;
    /** false: the call never left the gateway (stopped or refused in the queue, no provider built) —
     *  a trace row, never a model call. */
    dispatched?: boolean | undefined;
    durationMs?: number;
    /** Queue included: call start to the first nonempty output event; null when never measured. */
    firstOutputMs?: number | null;
    raw: unknown;
}

const usageRecordedHooks = new WeakMap<GatewayDb, (agent: string) => void>();
const CHARS_PER_TOKEN = 4;

export const newCallId = (): string => randomBytes(16).toString("hex");

export function setUsageRecordedHook(db: GatewayDb, fn: ((agent: string) => void) | null): void {
    if (fn) usageRecordedHooks.set(db, fn);
    else usageRecordedHooks.delete(db);
}

/** chars/4 of what was sent (images left out) and of what streamed back, for a call the provider
 *  had but never reported: stopped, failed, or a server that sends no usage. */
export function estimateUsage(messages: readonly Message[], tools: readonly Tool[], output: string): Usage {
    const sent = JSON.stringify({ messages: messages.map(({ images: _images, ...m }) => m), tools });
    const promptTokens = Math.ceil(sent.length / CHARS_PER_TOKEN);
    const completionTokens = Math.ceil(output.length / CHARS_PER_TOKEN);
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedTokens: 0 };
}

/** Never throws: accounting must not be able to fail a turn. The rollup is written FIRST — a raw
 *  payload that refuses to serialize must not also cost the number. `day` is for tests. */
export function recordLlmCall(
    record: LlmCallRecord,
    db: GatewayDb = gatewayDb(),
    day: string = localDay(),
): void {
    const u = record.usage;
    try {
        if (record.dispatched !== false) {
            db.bumpUsageDaily(day, {
                agent: record.agent,
                model: record.model ?? "",
                modelUid: record.modelUid ?? null,
                registryModel: record.registryModel ?? null,
                promptTokens: u?.promptTokens ?? 0,
                completionTokens: u?.completionTokens ?? 0,
                estimated: record.usageEstimated === true,
            });
        }
    } catch (error) {
        process.stderr.write(`[accounting] ${record.agent} call ${record.callId}: usage write failed — ${String(error)}\n`);
    }
    try {
        const ms = record.durationMs ?? 0;
        const perSec = u && ms > 0 && !record.usageEstimated ? Number((u.completionTokens / (ms / 1000)).toFixed(2)) : null;
        db.insertLlmCall({
            agent: record.agent,
            conversationId: record.session ?? null,
            room: record.room ?? null,
            scope: record.scope,
            callId: record.callId,
            callKind: record.callKind,
            model: record.model ?? null,
            provider: record.dispatched === false ? null : (record.provider ?? null),
            modelUid: record.modelUid ?? null,
            registryModel: record.registryModel ?? null,
            reportedModel: record.reportedModel ?? null,
            attempt: record.attempt ?? null,
            parentCallId: record.parentCallId ?? null,
            turnSeq: record.turnSeq ?? null,
            finishReason: record.finishReason ?? null,
            promptTokens: u?.promptTokens ?? null,
            completionTokens: u?.completionTokens ?? null,
            totalTokens: u?.totalTokens ?? null,
            cachedTokens: u?.cachedTokens ?? null,
            reasoningTokens: u?.reasoningTokens ?? null,
            usageEstimated: record.usageEstimated === true,
            durationMs: ms || null,
            firstOutputMs: record.firstOutputMs ?? null,
            tokensPerSec: perSec,
            raw: record.raw,
        });
    } catch (error) {
        process.stderr.write(`[accounting] ${record.agent} call ${record.callId}: trace write failed — ${String(error)}\n`);
    }
    usageRecordedHooks.get(db)?.(record.agent);
}
