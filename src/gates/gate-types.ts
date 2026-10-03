/** Gate shapes: approval actions, ask_owner questions, ask context, and the cards/summaries served out. */

import type { OwnerAnswer, OwnerQuestion, SessionId } from "@mimi-os/protocol";

export interface GateAction {
    /** The loop's own call id — what the answer names, so a batch is allowed row by row. */
    id: string;
    tool: string;
    args: Record<string, unknown>;
}

export interface GateContext {
    agent: string;
    session: SessionId | null;
    /** The shared conversation the turn runs in, instead of a session — never both. */
    room?: string | undefined;
    /** The turn's event sink; a gate parks even with nobody attached. */
    emit?: ((ev: Record<string, unknown>) => void) | undefined;
    /** Epoch ms this ask may live to at the latest — a mid-invoke gate dies with its invoke. */
    deadline?: number | undefined;
}

/** An approval asks to run a tool batch; a question (ask_owner) asks the owner to pick. */
export type GateKind = "approval" | "question";

/** How a gate ended: `gone` = cancelled without an answer (a stop, a restart, an unknown id). */
export type GateOutcome = "approved" | "denied" | "answered" | "dismissed" | "expired" | "gone";

export type GateEnding = "answered" | "dismissed" | "expired" | "gone";

/** An approval's decisions or a question's answers; null ends a gate unanswered. */
export type GateReply = { decisions: Record<string, boolean> } | { answers: OwnerAnswer[] } | null;

export interface GateSummary {
    gate: string;
    kind: GateKind;
    agent: string;
    session: number | null;
    room: string | null;
    tool: string;
    actions: number;
    /** Epoch ms, like `deadline`. */
    since: number;
    deadline: number;
}

export interface GateCard {
    gate: string;
    kind: GateKind;
    agent: string;
    session: SessionId | null;
    room: string | null;
    /** Empty on a question. */
    actions: GateAction[];
    /** Empty on an approval. */
    questions: OwnerQuestion[];
    deadline: number;
}

export interface PendingGate {
    id: string;
    kind: GateKind;
    agent: string;
    session: SessionId | null;
    room: string | null;
    actions: GateAction[];
    questions: OwnerQuestion[];
    at: number;
    deadline: number;
    settle: (reply: GateReply, ending: GateEnding) => void;
}
