/** Provider-specific types carried in the `done` event's `meta`. */

interface LlamaTimings {
    promptN: number;
    promptMs: number;
    promptPerSecond: number;
    predictedN: number;
    predictedMs: number;
    predictedPerSecond: number;
    cacheN: number;
}

export interface LlamaMeta {
    timings?: LlamaTimings;
}
