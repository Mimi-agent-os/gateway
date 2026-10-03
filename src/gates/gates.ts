/** Gates: an approval per tool batch (deny-by-default) or a question gate per ask_owner call, answered by gate id. */

import { randomBytes } from "node:crypto";

import type { OwnerAnswer, OwnerQuestion, SessionId } from "@mimi-os/protocol";

import type {
    GateAction,
    GateCard,
    GateContext,
    GateEnding,
    GateKind,
    GateOutcome,
    GateReply,
    GateSummary,
    PendingGate,
} from "./gate-types.ts";
import { ASK_OWNER } from "./questions.ts";

interface GateParked {
    gate: string;
    kind: GateKind;
    agent: string;
    session: SessionId | null;
    room: string | null;
    tool: string;
}

interface GateResolved {
    gate: string;
    agent: string;
    session: SessionId | null;
    outcome: GateOutcome;
}

interface GateClosed {
    outcome: GateOutcome;
    event: Record<string, unknown>;
}

/** An unanswered gate denies EVERY action after five minutes. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** A question holds its turn this long before the agent hears that nobody answered. */
const QUESTION_TIMEOUT_MS = 12 * 60 * 60_000;

export class Gates {
    private readonly open = new Map<string, PendingGate>();
    private readonly log: (msg: string) => void;
    private readonly onPark: (ev: GateParked) => void;
    private readonly onResolve: (ev: GateResolved) => void;
    private readonly questionMs: number;

    constructor(opts?: {
        log?: (msg: string) => void;
        onPark?: (ev: GateParked) => void;
        onResolve?: (ev: GateResolved) => void;
        questionTimeoutMs?: number | undefined;
    }) {
        this.log = opts?.log ?? ((): void => undefined);
        this.onPark = opts?.onPark ?? ((): void => undefined);
        this.onResolve = opts?.onResolve ?? ((): void => undefined);
        this.questionMs = opts?.questionTimeoutMs ?? QUESTION_TIMEOUT_MS;
    }

    private writeLog(message: string): void {
        try {
            this.log(message);
        } catch (error) {
            // An injected logger is an observer too; never let it control a gate's cleanup.
            process.stderr.write(
                `[gate] logger failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
        }
    }

    /** Observer failures cannot control an approval or leave its promise parked forever. */
    private notify(where: string, fn: () => void): void {
        try {
            fn();
        } catch (error) {
            this.writeLog(
                `[gate] ${where} listener failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
        }
    }

    /** Keyed by a process-unique id, never a chat slot; `close` runs once however the gate ends. */
    private park(
        ctx: GateContext,
        body: Pick<PendingGate, "kind" | "actions" | "questions">,
        timeoutMs: number,
        unanswered: string,
        close: (id: string, reply: GateReply, ending: GateEnding) => GateClosed,
        onPark?: (gate: string) => void,
    ): void {
        const at = Date.now();
        const deadline = Math.min(at + timeoutMs, ctx.deadline ?? Infinity);
        // opaque and unique across process lifetimes: a stale id can never address a new gate
        const id = randomBytes(16).toString("hex");
        const settle = (reply: GateReply, ending: GateEnding): void => {
            if (!this.open.has(id)) return;
            clearTimeout(timer);
            this.open.delete(id);
            const { outcome, event } = close(id, reply, ending);
            this.notify(`${id} resolution`, () => ctx.emit?.(event));
            this.notify(`${id} resolution`, () =>
                this.onResolve({ gate: id, agent: ctx.agent, session: ctx.session, outcome }),
            );
        };
        const timer = setTimeout(() => {
            this.writeLog(`[gate] ${id} expired in ${ctx.agent} — ${unanswered}\n`);
            this.notify(`${id} expiry`, () =>
                ctx.emit?.({ type: "log", text: `⏱ ${body.kind} ${id} expired — ${unanswered}` }),
            );
            settle(null, "expired");
        }, Math.max(0, deadline - at));
        timer.unref();
        const room = ctx.room ?? null;
        // the slot goes up BEFORE the event: a page attaching in the same tick must never
        // see an ask nothing here would accept an answer for
        this.open.set(id, { id, ...body, agent: ctx.agent, session: ctx.session, room, at, deadline, settle });
        // the caller's own handle on this gate: a record that rides it can point at the id
        this.notify(`${id} park`, () => onPark?.(id));
        this.notify(`${id} park`, () =>
            ctx.emit?.(
                body.kind === "approval"
                    ? { type: "approval_required", gate: id, actions: body.actions, deadline }
                    : { type: "question_required", gate: id, questions: body.questions, deadline },
            ),
        );
        // the chat sink reaches one page; this reaches every device that is listening
        const tool = body.kind === "approval" ? (body.actions[0]?.tool ?? "") : ASK_OWNER;
        this.notify(`${id} park`, () =>
            this.onPark({ gate: id, kind: body.kind, agent: ctx.agent, session: ctx.session, room, tool }),
        );
    }

    /** Park a tool batch on ONE approval gate — any action with no decision comes back DENIED. */
    ask(
        ctx: GateContext,
        actions: readonly GateAction[],
        onPark?: (gate: string) => void,
    ): Promise<Record<string, boolean>> {
        // an action name is agent-chosen text and lands in gateway.log, which an owner reads in
        // a terminal: no ESC, CR or LF may travel with it
        const tools = actions.map((a) => a.tool.replace(/[\p{Cc}\p{Cf}]/gu, " ")).join(", ");
        return new Promise((resolve) => {
            const close = (id: string, reply: GateReply, ending: GateEnding): GateClosed => {
                const decisions = reply !== null && "decisions" in reply ? reply.decisions : {};
                const out: Record<string, boolean> = {};
                for (const a of actions) out[a.id] = decisions[a.id] === true;
                resolve(out);
                const allowed = Object.values(out).some((v) => v);
                return {
                    outcome: ending !== "answered" ? ending : allowed ? "approved" : "denied",
                    event: { type: "approval_resolved", gate: id, decisions: out },
                };
            };
            const body = { kind: "approval" as const, actions: [...actions], questions: [] };
            this.park(ctx, body, APPROVAL_TIMEOUT_MS, `denied: ${tools}`, close, onPark);
        });
    }

    /** The nested gate — a single question asked from inside a running tool (RETURN gates). */
    async askOne(
        ctx: GateContext,
        label: string,
        detail?: Record<string, unknown>,
        onPark?: (gate: string) => void,
    ): Promise<boolean> {
        const answers = await this.ask(ctx, [{ id: "a1", tool: label, args: detail ?? {} }], onPark);
        return answers["a1"] === true;
    }

    /** ask_owner's gate: the owner's answers, or null once they dismissed it or it expired or went away. */
    askOwner(ctx: GateContext, questions: readonly OwnerQuestion[]): Promise<OwnerAnswer[] | null> {
        return new Promise((resolve) => {
            const close = (id: string, reply: GateReply, ending: GateEnding): GateClosed => {
                const answers = reply !== null && "answers" in reply ? reply.answers : null;
                resolve(answers);
                return { outcome: ending, event: { type: "question_resolved", gate: id, outcome: ending, answers } };
            };
            const body = { kind: "question" as const, actions: [], questions: [...questions] };
            this.park(ctx, body, this.questionMs, "the owner did not answer", close);
        });
    }

    answer(gate: string, decisions: Record<string, boolean>): boolean {
        const pending = this.open.get(gate);
        if (pending?.kind !== "approval") return false;
        pending.settle({ decisions }, "answered");
        return true;
    }

    /** A question gate's answers, already checked against its questions (gates/questions.ts); null dismisses it. */
    reply(gate: string, answers: OwnerAnswer[] | null): boolean {
        const pending = this.open.get(gate);
        if (pending?.kind !== "question") return false;
        pending.settle(answers === null ? null : { answers }, answers === null ? "dismissed" : "answered");
        return true;
    }

    /** Tool names and timing only — the args can be the body of an email and stay in here. */
    pending(): GateSummary[] {
        return [...this.open.values()].map((g) => {
            const head = g.actions[0]?.tool ?? "?";
            const rest = g.actions.length - 1;
            return {
                gate: g.id,
                kind: g.kind,
                agent: g.agent,
                session: g.session,
                room: g.room,
                tool: g.kind === "question" ? ASK_OWNER : rest > 0 ? `${head} +${rest}` : head,
                actions: g.actions.length,
                since: g.at,
                deadline: g.deadline,
            };
        });
    }

    /** The full card of one gate, args and questions included — served to the chat that parked it. */
    describe(gate: string): GateCard | null {
        const g = this.open.get(gate);
        if (!g) return null;
        return {
            gate: g.id,
            kind: g.kind,
            agent: g.agent,
            session: g.session,
            room: g.room,
            actions: g.actions,
            questions: g.questions,
            deadline: g.deadline,
        };
    }

    /** Deny everything parked for an agent (or one of its sessions) — a stop, a restart. */
    cancel(agent: string, session?: SessionId): void {
        for (const g of [...this.open.values()]) {
            if (g.agent !== agent) continue;
            if (session !== undefined && g.session !== session) continue;
            g.settle(null, "gone");
        }
    }

    /** The same for a room: a room stop denies what its own turn parked and nothing else. */
    cancelRoom(room: string): void {
        for (const g of [...this.open.values()]) {
            if (g.room === room) g.settle(null, "gone");
        }
    }

    stop(): void {
        for (const g of [...this.open.values()]) g.settle(null, "gone");
    }
}
