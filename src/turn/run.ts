import type { TurnOutcome, TurnRequest } from "./loop-types.ts";

export type CompleteTurn = (outcome: TurnOutcome, signal: AbortSignal) => Record<string, unknown>;

type Emit = (event: Record<string, unknown>) => void;

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
    private sink: Emit | null = null;

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
            this.sink = null;
        });
        this.finished = this.result.then(() => undefined, () => undefined);
    }

    stop(): void {
        this.abort.abort(new Error("stopped by user"));
    }

    get activeTurnSeq(): number | undefined {
        const event = this.log?.findLast((entry) => entry["type"] === "turn_started");
        return typeof event?.["turnSeq"] === "number" ? event["turnSeq"] : undefined;
    }

    attach(send: Emit): () => void {
        for (const event of this.log ?? []) send(event);
        this.sink = send;
        return () => {
            if (this.sink === send) this.sink = null;
        };
    }

    readonly emit: Emit = (event) => {
        if (this.log === null) return;
        const type = event["type"];
        const previous = this.log.at(-1);
        // Provider chunk boundaries do not matter to reconnect replay.
        if ((type === "text" || type === "thinking") && previous?.["type"] === type &&
            typeof previous["text"] === "string" && typeof event["text"] === "string") {
            previous["text"] += event["text"];
        } else {
            this.log.push({ ...event });
        }
        this.observer?.(event);
        this.sink?.(event);
    };
}
