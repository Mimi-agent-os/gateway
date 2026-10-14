/** Manual compaction: fold this conversation's earlier part NOW, on the owner's command, instead
 *  of waiting for the automatic thresholds. The same pass a turn runs — a summary that replaces the
 *  prefix in what the model sees, and notes for the images past the window, in one event appended
 *  to the agent's chain. */

import type { SessionId } from "@mimi-os/protocol";

import type { GatewayCore } from "../core.ts";
import { resolveModelFor } from "../llm/policy.ts";
import { compactionPass, thresholdsFor } from "./compaction.ts";

// describing a chat's older images takes a call per eight of them
const TIMEOUT_MS = 180_000;

export interface CompactResult {
    compacted: boolean;
    reason?: string;
    covers?: [number, number];
}

export async function compactSession(core: GatewayCore, agent: string, session: SessionId): Promise<CompactResult> {
    // the agent's own model, through the same gate its turns pass: its window sets the thresholds
    const resolved = resolveModelFor(agent, undefined, core.registry.get(agent)?.describe?.manifest.model, core.db);
    if (!resolved.ok) return { compacted: false, reason: resolved.reason };
    const cfg = resolved.cfg;
    const thresholds = thresholdsFor(cfg, core.db);
    if (!thresholds) return { compacted: false, reason: "this model has no context window, so compaction is off" };

    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const entry = await core.sessions.ensure(agent, session, signal);
    const call = { agent, session, cfg, turnSeq: null, signal };
    const { payload, plan } = await compactionPass(call, core.sessions, entry, thresholds, { text: true, images: true }, core.db);
    if (payload) {
        const peer = core.registry.get(agent);
        if (!peer) return { compacted: false, reason: `agent "${agent}" is not connected` };
        const event = { type: "compaction" as const, payload };
        const ok = await peer.request("append", { session, events: [event] });
        // replayed onto the cache, not dropped: a reload would stream every image of the chat through again
        core.sessions.applyAppend(agent, session, [event], ok.head);
        core.events.emit({ type: "chat_changed", agent, session });
    }
    if (payload?.covers) return { compacted: true, covers: payload.covers };
    if (!plan) {
        return payload
            ? { compacted: true }
            : { compacted: false, reason: "not enough earlier history to compact yet" };
    }
    return { compacted: false, reason: "the model did not return a complete summary" };
}
