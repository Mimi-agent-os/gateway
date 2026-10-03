/** One turn's request/outcome shapes, gateway deps, and the runtime tool table. */

import type { Message, MessageActor, SessionId, ToolCall, ToolSchema } from "@mimi-os/protocol";

import type { EventHub } from "../events.ts";
import type { GatewayDb } from "../store/db.ts";
import type { Gates } from "../gates/gates.ts";
import type { CallPriority } from "../llm/queue.ts";
import type { Registry } from "../registry/registry.ts";
import type { SessionCache } from "./sessions.ts";

export interface LoopDeps {
    registry: Registry;
    sessions: SessionCache;
    gates: Gates;
    db: GatewayDb;
    /** Where an interaction record announces itself to every listening device. */
    events: EventHub;
    log: (msg: string) => void;
    /** The ONE way a turn starts: the registry every Stop route, `busy` and the one-turn-per-chat
     *  guard read — a delegate turn is registered exactly like a typed one. */
    startTurn: (req: TurnRequest) => Promise<TurnOutcome>;
}

/** A turn whose transcript is a shared room instead of the agent's own chain: the gateway reads
 *  the history and publishes the one reply, so the agent's log is never written at all. */
interface RoomTurn {
    room: string;
    /** The room as THIS agent sees it — re-read before every model call, author lines included. */
    history: () => Message[];
}

interface TurnOptions {
    agent: string;
    text: string;
    /** Data-URI images on the opening user message; capped and gated in http/turns and the loop. */
    images?: string[] | undefined;
    /** Stamped as `meta.actor` on the opening user message — only the caller knows who authored it. */
    actor?: MessageActor | undefined;
    model?: string | undefined;
    scope?: string | undefined;
    priority?: CallPriority | undefined;
    /** Deny-by-default: false (the default) means nobody is there and every write is refused. */
    attended?: boolean | undefined;
    emit?: ((ev: Record<string, unknown>) => void) | undefined;
    signal?: AbortSignal | undefined;
    /** Recursion guard for ask_<agent>; a delegate turn runs at depth 1 and delegates nothing. */
    depth?: number | undefined;
    title?: boolean | undefined;
    invokeDeadlineMs?: number | undefined;
}

export type TurnRequest = TurnOptions & (
    | { session: SessionId; room?: undefined }
    | { session: null; room: RoomTurn }
);

/** What the turn's `done` event carries beside the answer. The final call is named, never
 *  guessed from position; a turn that made no model call has no metrics at all. */
export interface TurnMetrics {
    finalCallId: string;
    registryModel: string;
    requestedModel?: string | undefined;
    reportedModel?: string | undefined;
    completionTokens?: number | undefined;
    callDurationMs: number;
    turnDurationMs: number;
    rounds: number;
}

export interface TurnOutcome {
    text: string;
    rounds: number;
    /** The agent died before its own history could be written: the turn is gone, not replayed. */
    dropped: boolean;
    /** Resolves true once the chat's new title landed. */
    titling: Promise<boolean> | null;
    /** null until a model call completes — a stopped turn carries whatever did complete. */
    metrics: TurnMetrics | null;
}

export interface ToolResult {
    text: string;
    data?: unknown;
}

export interface RuntimeTool {
    schema: ToolSchema;
    kind: "agent" | "gateway";
    run?: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface PlannedCall {
    call: ToolCall;
    args: Record<string, unknown> | null;
    argsError: string;
}

export const MAX_TOOL_TURNS = 25;
/** Where a tool result crosses into history — every path goes through this one ceiling. */
export const TOOL_OUTPUT_MAX = 20_000;
export const INVOKE_DEADLINE_MS = 120_000;
