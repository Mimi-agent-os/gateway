/** Manual compaction: fold this conversation's earlier part NOW, on the owner's command, instead
 *  of waiting for the automatic prompt-token threshold. Same shape a turn writes — a summary that
 *  replaces the prefix in what the model sees, appended to the agent's chain. */

import type { SessionId } from "@mimi-os/protocol";

import type { GatewayCore } from "../core.ts";
import { resolveModelFor } from "../llm/policy.ts";
import { planCompaction, summarize, thresholdsFor } from "./compaction.ts";

const TIMEOUT_MS = 60_000;

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

    const entry = await core.sessions.ensure(agent, session);
    const plan = planCompaction(core.sessions.folded(entry), entry.events[0]?.seq ?? 0, thresholds);
    if (!plan) return { compacted: false, reason: "not enough earlier history to compact yet" };

    const call = { agent, session, cfg, turnSeq: null, signal: AbortSignal.timeout(TIMEOUT_MS) };
    const summary = await summarize(call, plan.lines, core.db);
    if (summary === null) return { compacted: false, reason: "the model did not return a complete summary" };

    const peer = core.registry.get(agent);
    if (!peer) return { compacted: false, reason: `agent "${agent}" is not connected` };
    await peer.request("append", { session, events: [{ type: "compaction", payload: { summary, covers: plan.covers } }] });
    core.sessions.drop(agent, session);
    core.events.emit({ type: "chat_changed", agent, session });
    return { compacted: true, covers: plan.covers };
}
