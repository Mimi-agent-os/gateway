import type { TurnOutcome, TurnRequest } from "./loop-types.ts";

export type CompleteTurn = (outcome: TurnOutcome, signal: AbortSignal) => Record<string, unknown>;

type Emit = (event: Record<string, unknown>) => void;

/** A stop nobody asked for: the agent's socket closed or was replaced while the turn ran. */
export class AgentGone extends Error {
    constructor() {
        super("the agent disconnected");
    }
}

export class TurnRun {
    readonly agent: string;
    readonly session: number | null;
    readonly room: string | null;
    readonly startedAt = Date.now();
    readonly signal: AbortSignal;
    readonly result: Promise<TurnOutcome>;
    readonly finished: Promise<void>;
    private readonly abort = new AbortController();
    private readonly observer: Emit | undefined;
    private log: Record<string, unknown>[] | null = [];
    /** Every page on this chat: two devices on one turn both get each gate. */
    private readonly sinks = new Set<Emit>();
    /** Tool calls running now: an ask that names no chat can only be this turn's while one is. */
    private readonly calling = new Set<unknown>();

    constructor(
        request: TurnRequest,
        shutdown: AbortSignal,
        execute: (signal: AbortSignal, emit: Emit) => Promise<TurnOutcome>,
        cancelGates: () => void,
    ) {
        this.agent = request.agent;
        this.session = request.session;
        this.room = request.room?.room ?? null;
        this.observer = request.emit;
        this.signal = AbortSignal.any([this.abort.signal, shutdown, ...(request.signal ? [request.signal] : [])]);
        this.signal.addEventListener("abort", cancelGates, { once: true });
        // Core publishes this run before execution can emit events or request an approval.
        this.result = Promise.resolve().then(() => execute(this.signal, this.emit)).finally(() => {
            this.signal.removeEventListener("abort", cancelGates);
            this.log = null;
            this.sinks.clear();
        });
        this.finished = this.result.then(() => undefined, () => undefined);
    }

    stop(why: "owner" | "gone" = "owner"): void {
        this.abort.abort(why === "gone" ? new AgentGone() : new Error("stopped by user"));
    }

    get inTool(): boolean {
        return this.calling.size > 0;
    }

    get activeTurnSeq(): number | undefined {
        const event = this.log?.findLast((entry) => entry["type"] === "turn_started");
        return typeof event?.["turnSeq"] === "number" ? event["turnSeq"] : undefined;
    }

    attach(send: Emit): () => void {
        for (const event of this.log ?? []) send(event);
        if (this.log !== null) this.sinks.add(send);
        return () => {
            this.sinks.delete(send);
        };
    }

    readonly emit: Emit = (event) => {
        if (this.log === null) return;
        const type = event["type"];
        if (type === "tool_call") this.calling.add(event["id"]);
        else if (type === "tool_result") this.calling.delete(event["id"]);
        const previous = this.log.at(-1);
        // Provider chunk boundaries do not matter to reconnect replay.
        if ((type === "text" || type === "thinking") && previous?.["type"] === type &&
            typeof previous["text"] === "string" && typeof event["text"] === "string") {
            previous["text"] += event["text"];
        } else {
            this.log.push({ ...event });
        }
        this.observer?.(event);
        for (const send of this.sinks) send(event);
    };
}
