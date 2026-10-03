/** One serialized FIFO queue per model endpoint; interactive jobs jump ahead of background ones. */

export type CallPriority = "interactive" | "background";

/** Rejection from a saturated endpoint queue — the call never ran, so it spent nothing. */
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
    private running = false;

    get waiting(): number {
        return this.interactive.length + this.background.length;
    }

    enqueue<T>(run: () => Promise<T>, priority: CallPriority, signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) return Promise.reject(signal.reason);
        const pending = priority === "interactive" ? this.interactive : this.background;
        if (pending.length >= MAX_WAITING) {
            return Promise.reject(
                new QueueFullError(
                    `model endpoint busy: ${MAX_WAITING} ${priority} calls already waiting`,
                ),
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

    private drain(): void {
        if (this.running) return;
        const job = this.interactive.shift() ?? this.background.shift();
        if (!job) return;
        this.running = true;
        job.removeAbort?.();
        Promise.resolve()
            .then(() => {
                job.signal?.throwIfAborted();
                return job.run();
            })
            .then(
            (v) => {
                job.resolve(v);
                this.running = false;
                this.drain();
            },
            (e: unknown) => {
                job.reject(e);
                this.running = false;
                this.drain();
            },
        );
    }
}

const queues = new Map<string, ModelQueue>();

/** Run `call` serialized against every other call queued for the same endpoint. */
export function enqueueCall<T>(
    endpoint: string,
    call: () => Promise<T>,
    priority: CallPriority = "background",
    signal?: AbortSignal,
): Promise<T> {
    let queue = queues.get(endpoint);
    if (!queue) {
        queue = new ModelQueue();
        queues.set(endpoint, queue);
    }
    return queue.enqueue(call, priority, signal);
}

/** Calls queued for `endpoint` that have not started yet. */
export const waitingCalls = (endpoint: string): number => queues.get(endpoint)?.waiting ?? 0;
