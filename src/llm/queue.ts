/** One queue per model: up to its parallel-call limit run at once, the rest wait with interactive jobs ahead of background ones. */
import type { GatewayDb } from "../store/db.ts";
import type { ModelConfig } from "./models.ts";

export type CallPriority = "interactive" | "background";

/** Rejection from a model's full queue — the call never ran, so it spent nothing. */
export class QueueFullError extends Error {}

/** Each waiting job pins the payload its caller sent — an agent loop must not queue them without end. */
const MAX_WAITING = 64;

interface QueuedJob<T> {
    run: () => Promise<T>;
    resolve: (v: T) => void;
    reject: (e: unknown) => void;
    signal?: AbortSignal | undefined;
    removeAbort?: () => void;
}

class ModelQueue {
    private readonly interactive: QueuedJob<unknown>[] = [];
    private readonly background: QueuedJob<unknown>[] = [];
    private running = 0;
    private readonly modelUid: string;
    private readonly db: GatewayDb;

    constructor(modelUid: string, db: GatewayDb) {
        this.modelUid = modelUid;
        this.db = db;
    }

    get waiting(): number {
        return this.interactive.length + this.background.length;
    }

    enqueue<T>(model: string, run: () => Promise<T>, priority: CallPriority, signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) return Promise.reject(signal.reason);
        const pending = priority === "interactive" ? this.interactive : this.background;
        if (pending.length >= MAX_WAITING) {
            return Promise.reject(
                new QueueFullError(`model "${model}" busy: ${MAX_WAITING} ${priority} calls already waiting`),
            );
        }
        return new Promise<T>((resolve, reject) => {
            const job: QueuedJob<unknown> = {
                run: run as () => Promise<unknown>,
                resolve: resolve as (v: unknown) => void,
                reject,
                signal,
            };
            const abort = (): void => {
                const index = pending.indexOf(job);
                if (index < 0) return;
                pending.splice(index, 1);
                job.removeAbort?.();
                reject(signal?.reason);
            };
            if (signal) job.removeAbort = () => signal.removeEventListener("abort", abort);
            signal?.addEventListener("abort", abort, { once: true });
            pending.push(job);
            this.drain();
        });
    }

    drain(): void {
        // the limit is read at every drain: a change applies from the next start and never stops a running call
        let limit = Infinity;
        try {
            limit = this.db.maxParallel(this.modelUid) ?? Infinity;
        } catch {
            // a database closed at shutdown must not throw out of a settled call's finally
        }
        while (this.waiting > 0 && this.running < limit) {
            const job = this.interactive.shift() ?? this.background.shift();
            if (!job) break;
            this.running++;
            job.removeAbort?.();
            Promise.resolve()
                .then(() => {
                    job.signal?.throwIfAborted();
                    return job.run();
                })
                .then(job.resolve, job.reject)
                .finally(() => {
                    this.running--;
                    this.drain();
                });
        }
        if (this.running === 0 && this.waiting === 0) queues.delete(this.modelUid);
    }
}

const queues = new Map<string, ModelQueue>();

/** Run `call` within the model's parallel-call limit; with no limit it starts at once. */
export function enqueueCall<T>(
    model: ModelConfig,
    db: GatewayDb,
    call: () => Promise<T>,
    priority: CallPriority,
    signal?: AbortSignal,
): Promise<T> {
    let queue = queues.get(model.modelUid);
    if (!queue) {
        queue = new ModelQueue(model.modelUid, db);
        queues.set(model.modelUid, queue);
    }
    return queue.enqueue(model.name, call, priority, signal);
}

/** A raised limit starts the calls it now lets through without waiting for a running one to end. */
export const parallelLimitChanged = (modelUid: string): void => queues.get(modelUid)?.drain();

/** Calls queued for the model that have not started yet. */
export const waitingCalls = (modelUid: string): number => queues.get(modelUid)?.waiting ?? 0;
