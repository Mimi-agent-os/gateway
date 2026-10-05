/** Name a chat after what it is ABOUT: one cheap call, then a session_update to the agent. */

import type { SessionId } from "@mimi-os/protocol";

import { estimateUsage, newCallId, recordLlmCall } from "../store/accounting.ts";
import { gatewayDb, type GatewayDb } from "../store/db.ts";
import { NotSentError, type ProviderResponse } from "../llm/base/index.ts";
import { createProvider, getDefaultModel, getModel } from "../llm/models.ts";
import { admitAtDequeue } from "../llm/policy.ts";
import { enqueueCall } from "../llm/queue.ts";
import { PeerError, type AgentPeer } from "../registry/peer.ts";

interface AutoTitleOptions {
    agent: string;
    session: SessionId;
    peer: AgentPeer;
    /** The message that opened the thread — a topic is set by the question, not by the answer. */
    seed: string;
    model?: string | undefined;
    /** The user event that opened the turn this title belongs to, when the caller knows it. */
    turnSeq?: number | null;
    db?: GatewayDb;
    log?: (msg: string) => void;
    signal?: AbortSignal | undefined;
}

const TITLE_MAX = 120;
const TITLE_TIMEOUT_MS = 20_000;
const SEED_CHARS = 600;

/** Whitespace collapsed, capped at TITLE_MAX; shared with http/router.ts's title validation. */
export const normalizeTitle = (raw: string): string => raw.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);

/** `{"title":"…"}` out of a model answer; fences and prose around it are tolerated. */
function parseTitle(text: string): string | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        const parsed: unknown = JSON.parse(text.slice(start, end + 1));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        const raw = (parsed as Record<string, unknown>)["title"];
        if (typeof raw !== "string") return null;
        return normalizeTitle(raw) || null;
    } catch {
        return null;
    }
}

/** A human rename wins forever: the write omits `titleByUser`, so even a race loses to a person. True once a title landed. */
export async function autoTitle(opts: AutoTitleOptions): Promise<boolean> {
    const { agent, session, peer } = opts;
    const db = opts.db ?? gatewayDb();
    const log = opts.log ?? ((): void => undefined);
    const seed = opts.seed.replace(/\s+/g, " ").trim();
    if (!seed) return false;
    try {
        opts.signal?.throwIfAborted();
        const listed = await peer.request(
            "session_list",
            { includeArchived: true },
            { signal: opts.signal },
        );
        opts.signal?.throwIfAborted();
        const info = listed.sessions.find((s) => s.session === session);
        if (!info || info.title !== null || info.titleByUser) return false;

        const cfg = opts.model === undefined ? getDefaultModel(db) : getModel(opts.model, db);
        if (!cfg) throw new Error(`Unknown model "${opts.model}".`);
        const provider = createProvider(cfg.name, db);
        const request = [
            {
                role: "system" as const,
                content:
                    "You name chat threads. Answer with ONE line of JSON and nothing else: " +
                    '{"title":"…"}',
            },
            {
                role: "user" as const,
                content:
                    "Give this conversation a short title (max 8 words) naming its TOPIC — not " +
                    "a quote of the opening line. Answer in the language the conversation is " +
                    `in.\n\nuser: ${seed.slice(0, SEED_CHARS)}`,
            },
        ];

        let parentCallId: string | null = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            const t0 = performance.now();
            const callId = newCallId();
            // filled as it streams: a call that throws keeps what the provider already sent
            const got: ProviderResponse = { thinking: "", text: "", toolCalls: [], finishReason: "error" };
            // the signal the call ran with, set at dequeue: null means it never left the queue
            let sent = null as AbortSignal | null;
            let failed: unknown = null;
            try {
                // the same per-endpoint queue as every turn: a one-slot server never sees two calls
                await enqueueCall(
                    cfg.endpointUrl,
                    () => {
                        // the same gate as every other call of this agent, at dequeue: pause, grant, daily limit
                        admitAtDequeue(agent, cfg, db);
                        const timeout = AbortSignal.timeout(TITLE_TIMEOUT_MS);
                        sent = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
                        return provider.complete(request, [], sent, got);
                    },
                    "background",
                    opts.signal,
                );
            } catch (e) {
                failed = e;
                log(`[title] ${agent}#${session}: ${(e as Error).message}\n`);
            }
            // as a turn: a call the provider had but never reported is estimated, never free
            const estimate =
                got.usage === undefined &&
                sent !== null &&
                !(failed instanceof NotSentError) &&
                (got.accepted === true || sent.aborted)
                    ? estimateUsage(request, [], got.thinking + got.text)
                    : undefined;
            recordLlmCall(
                {
                    agent,
                    scope: `${agent}:title`,
                    callId,
                    callKind: "title",
                    session,
                    model: provider.model ?? null,
                    provider: cfg.provider,
                    registryModel: cfg.name,
                    modelUid: cfg.modelUid,
                    reportedModel: got.model ?? null,
                    attempt,
                    parentCallId,
                    turnSeq: opts.turnSeq ?? null,
                    finishReason: failed ? "error" : got.finishReason,
                    usage: got.usage ?? estimate,
                    usageEstimated: estimate !== undefined,
                    dispatched: sent !== null,
                    durationMs: Math.round(performance.now() - t0),
                    raw: failed ? { error: String(failed) } : { text: got.text, finishReason: got.finishReason },
                },
                db,
            );
            if (opts.signal?.aborted) return false;
            if (failed instanceof PeerError) break;
            parentCallId = callId;
            const title = !failed && parseTitle(got.text);
            if (title) {
                return (await peer.request("session_update", { session, title }, { signal: opts.signal })).applied;
            }
        }
        if (opts.signal?.aborted) return false;
        const flat = { session, title: seed.slice(0, 60) };
        return (await peer.request("session_update", flat, { signal: opts.signal })).applied;
    } catch (e) {
        // a title failure that failed a turn would be an absurd trade
        log(`[title] ${agent}#${session}: ${(e as Error).message}\n`);
        return false;
    }
}
