/** Agent-to-agent commands: one function, used by both the peer frame handler (core.ts) and the
 *  model tool (gateway-tools.ts) — permission, target + command, the write gate, the invoke, the
 *  record. No LLM turn on either side. */

import type { ResultPayload } from "@mimi-os/protocol";

import { TRUNCATION_MARKER } from "./chain.ts";
import type { GateContext } from "../gates/gate-types.ts";
import { PeerError } from "../registry/peer.ts";
import type { Registry } from "../registry/registry.ts";
import type { InteractionPatch, InteractionRow, NewInteraction } from "../store/db.ts";
import type { LoopDeps } from "./loop-types.ts";

export interface A2aRequest {
    from: string;
    target: string;
    command: string;
    args: Record<string, unknown>;
    /** The attended turn's own gate context, or a session-less one built the way `ask_approve` is
     *  when there is no chat — either way the write gate parks a real approval; it never auto-denies. */
    gateCtx: GateContext;
    originConversation?: number | null;
    originCallId?: string | null;
    signal?: AbortSignal | undefined;
}

const A2A_INVOKE_DEADLINE_MS = 60_000;
const A2A_RECORD_MAX_BYTES = 262_144;

/** JSON, capped at 256 KiB with a truncation marker — the interactions row is a record for a
 *  person to inspect, never re-parsed by the gateway itself. */
function capJson(value: unknown): string {
    const full = JSON.stringify(value) ?? "null";
    const buf = Buffer.from(full, "utf8");
    if (buf.length <= A2A_RECORD_MAX_BYTES) return full;
    const maxBodyBytes = A2A_RECORD_MAX_BYTES - Buffer.byteLength(TRUNCATION_MARKER, "utf8");
    let end = maxBodyBytes;
    // JSON's UTF-8 is valid. If the final code point is incomplete, cut back to its leading byte.
    let start = end - 1;
    while (start > 0 && (buf[start]! & 0b1100_0000) === 0b1000_0000) start--;
    const lead = buf[start] ?? 0;
    const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (end - start < width) end = start;
    return `${buf.subarray(0, end).toString("utf8")}${TRUNCATION_MARKER}`;
}

/** The caller's standing right to reach out: what lists ask_<agent>/a2a_<agent>, and gates each call. */
export function callerDenial(registry: Registry, caller: string): string | null {
    const pin = registry.pin(caller);
    if (pin?.status !== "approved") return `"${caller}" is not approved to reach other agents.`;
    if (!pin.perms.delegate) return `"${caller}" has no delegate permission.`;
    // a paused agent is stopped everywhere, not only on the two paths that call a model
    return registry.isPaused(caller) ? `"${caller}" is paused.` : null;
}

/** Standing permissions, checked on BOTH ends — the caller's right to reach out and the target's
 *  right to be reached; anything short of approved on either side is a flat no. */
export function crossAgentDenial(registry: Registry, caller: string, target: string): string | null {
    const denied = callerDenial(registry, caller);
    if (denied !== null) return denied;
    // the reach list is every OTHER approved agent (registry/peers.ts) — an agent runs its own tools itself
    if (target === caller) return `"${caller}" cannot reach itself.`;
    const pin = registry.pin(target);
    if (pin?.status !== "approved") return `"${target}" is not approved — nothing was sent.`;
    if (!pin.perms.discoverable) return `"${target}" is not discoverable — nothing was sent.`;
    return registry.isPaused(target) ? `"${target}" is paused — nothing was sent.` : null;
}

/** One write, one event: the row and the `interaction` line every device watches go out together. */
export function recordInteraction(deps: LoopDeps, n: NewInteraction): InteractionRow {
    const row = deps.db.insertInteraction(n);
    deps.events.emit({ type: "interaction", id: row.id, kind: row.kind, status: row.status });
    return row;
}

/** A reference learned later (the target, the gate, the result) changes no status and announces
 *  nothing — only a status change is news to the devices watching. */
export function advanceInteraction(deps: LoopDeps, id: string, patch: InteractionPatch): void {
    const row = deps.db.updateInteraction(id, patch);
    if (!row || patch.status === undefined) return;
    deps.events.emit({ type: "interaction", id: row.id, kind: row.kind, status: row.status });
}

/** Throws a PeerError (status "denied" for a permission or gate refusal, "error" for a routing
 *  failure, or whatever `peer.request` itself threw) on anything short of success. */
export async function runA2a(deps: LoopDeps, call: A2aRequest): Promise<ResultPayload> {
    const denial = crossAgentDenial(deps.registry, call.from, call.target);
    if (denial) throw new PeerError(denial, "denied");

    const peer = deps.registry.get(call.target);
    if (!peer) throw new PeerError(`the "${call.target}" agent is not connected right now.`, "error");
    const commands = peer.describe?.manifest.a2a?.commands ?? [];
    if (!commands.includes(call.command)) {
        throw new PeerError(`"${call.target}" does not list an a2a command "${call.command}".`, "error");
    }
    const writes = peer.describe?.tools.find((t) => t.name === call.command)?.writes === true;

    const t0 = Date.now();
    const record = recordInteraction(deps, {
        kind: "a2a",
        from: call.from,
        to: call.target,
        status: "sent",
        command: call.command,
        args: capJson(call.args),
        originConversation: call.originConversation ?? null,
        originCallId: call.originCallId ?? null,
    });

    if (writes) {
        const approved = await deps.gates.askOne(
            call.gateCtx,
            `a2a ${call.target}.${call.command}`,
            call.args,
            (gate) => advanceInteraction(deps, record.id, { gate }),
        );
        if (!approved) {
            advanceInteraction(deps, record.id, { status: "denied", durationMs: Date.now() - t0 });
            throw new PeerError(`the user denied "${call.target}.${call.command}".`, "denied");
        }
        // the card waited minutes: a pause or a narrowed permission in that time still stops it
        const stale = crossAgentDenial(deps.registry, call.from, call.target);
        if (stale !== null) {
            advanceInteraction(deps, record.id, { status: "denied", durationMs: Date.now() - t0 });
            throw new PeerError(stale, "denied");
        }
        // the owner said yes, so a target that left or reconnected meanwhile is a routing failure worth a retry
        const now = deps.registry.get(call.target);
        if (now !== peer) {
            advanceInteraction(deps, record.id, { status: "failed", durationMs: Date.now() - t0 });
            throw new PeerError(
                now === undefined
                    ? `the "${call.target}" agent is not connected right now.`
                    : `"${call.target}" reconnected while the approval waited — nothing was sent.`,
                "error",
            );
        }
    }

    try {
        const res = await peer.request(
            "a2a_invoke",
            { from: call.from, command: call.command, args: call.args },
            { deadline: A2A_INVOKE_DEADLINE_MS, signal: call.signal },
        );
        // the target's reply is untrusted like any other frame, so it is read the way an invoke result is
        const raw = (res?.result ?? {}) as Partial<ResultPayload>;
        const result: ResultPayload = { text: typeof raw.text === "string" ? raw.text : "" };
        if (raw.data !== undefined) result.data = raw.data;
        advanceInteraction(deps, record.id, {
            status: "answered",
            result: capJson(result),
            durationMs: Date.now() - t0,
        });
        return result;
    } catch (e) {
        advanceInteraction(deps, record.id, { status: "failed", durationMs: Date.now() - t0 });
        throw e;
    }
}
