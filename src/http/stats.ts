import type { CallPerfRow, GatewayDb } from "../store/db.ts";
import { dayInfo, dayStart, localDay, shiftDay } from "../store/day.ts";
import { isoStamp, json, type Router } from "./router.ts";

/** One measured distribution: `samples` says how many of the bucket's calls carried the number. */
interface Timing {
    samples: number;
    mean: number | null;
    p50: number | null;
    p95: number | null;
}

interface Aggregate {
    calls: number;
    latencyMs: Timing;
    firstOutputMs: Timing;
    /** Full-call throughput — SUM/SUM over the rows that carried BOTH numbers, never a mean of
     *  per-call rates, and never decode speed: the gateway queue is inside `durationMs`. */
    throughput: {
        samples: number;
        completionTokens: number;
        durationMs: number;
        tokensPerSec: number | null;
    };
}

interface Bucket {
    calls: number;
    latency: number[];
    firstOutput: number[];
    tokenRows: number;
    tokens: number;
    tokenMs: number;
}

const MAX_DAYS = 365;

/** `min` is 0 where 0 means «all history» and 1 where a bounded window is the whole point. */
const days = (raw: string | null, fallback: number, min: number): number => {
    const n = Number(raw);
    if (raw === null || raw === "" || !Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(MAX_DAYS, Math.floor(n)));
};

/** The window includes the owner's today, so days=1 is today alone; days=0 uses "" as the lower bound, which sorts before every date. */
const since = (n: number): string => (n === 0 ? "" : shiftDay(localDay(), -(n - 1)));

const bucket = (): Bucket => ({
    calls: 0,
    latency: [],
    firstOutput: [],
    tokenRows: 0,
    tokens: 0,
    tokenMs: 0,
});

const fold = (b: Bucket, r: CallPerfRow): void => {
    b.calls += 1;
    const ms = r.durationMs !== null && r.durationMs > 0 ? r.durationMs : null;
    if (ms !== null) b.latency.push(ms);
    if (r.firstOutputMs !== null && r.firstOutputMs >= 0) b.firstOutput.push(r.firstOutputMs);
    if (ms !== null && r.completionTokens !== null) {
        b.tokenRows += 1;
        b.tokens += r.completionTokens;
        b.tokenMs += ms;
    }
};

/** Nearest-rank percentiles over calls in the requested window. */
const timing = (values: readonly number[]): Timing => {
    if (!values.length) return { samples: 0, mean: null, p50: null, p95: null };
    const sorted = [...values].sort((a, b) => a - b);
    const rank = (q: number): number =>
        sorted[Math.ceil(q * sorted.length) - 1]!;
    const sum = sorted.reduce((n, v) => n + v, 0);
    return {
        samples: sorted.length,
        mean: Math.round(sum / sorted.length),
        p50: rank(0.5),
        p95: rank(0.95),
    };
};

const aggregate = (b: Bucket): Aggregate => ({
    calls: b.calls,
    latencyMs: timing(b.latency),
    firstOutputMs: timing(b.firstOutput),
    throughput: {
        samples: b.tokenRows,
        completionTokens: b.tokens,
        durationMs: b.tokenMs,
        tokensPerSec: b.tokenMs > 0 ? Number((b.tokens / (b.tokenMs / 1000)).toFixed(2)) : null,
    },
});

export function registerStats(router: Router, db: GatewayDb): void {
    router.get("/api/stats/usage", (ctx) => {
        const n = days(ctx.url.searchParams.get("days"), 7, 0);
        const sinceDay = since(n);
        // exact-name scope, echoed back as sent
        const agent = ctx.url.searchParams.get("agent") || null;
        const rows = db.usageMatrix(sinceDay, agent ?? undefined);
        const totals = { calls: 0, estimatedCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
        for (const r of rows) {
            totals.calls += r.calls;
            totals.estimatedCalls += r.estimatedCalls;
            totals.promptTokens += r.promptTokens;
            totals.completionTokens += r.completionTokens;
            totals.totalTokens += r.totalTokens;
            totals.cost += r.cost;
        }
        const registry = ctx.url.searchParams.get("group") === "registry";
        return json(ctx.res, 200, {
            sinceDay,
            days: n,
            agent,
            day: dayInfo(),
            rows,
            totals,
            registryRows: registry ? db.usageByRegistry(sinceDay, agent ?? undefined) : undefined,
        });
    });

    // the bars stay bounded — a strip has one slot per day, and «all history» is not a strip
    router.get("/api/stats/daily", (ctx) => {
        const n = days(ctx.url.searchParams.get("days"), 30, 1);
        const sinceDay = since(n);
        const agent = ctx.url.searchParams.get("agent") || null;
        const registry = ctx.url.searchParams.get("group") === "registry";
        return json(ctx.res, 200, {
            agent,
            sinceDay,
            day: dayInfo(),
            rows: db.usageSeries(sinceDay, agent ?? undefined),
            registryRows: registry ? db.usageByRegistry(sinceDay, agent ?? undefined) : undefined,
        });
    });

    router.get("/api/stats/performance", (ctx) => {
        const n = days(ctx.url.searchParams.get("days"), 7, 0);
        const sinceDay = since(n);
        const agent = ctx.url.searchParams.get("agent") || null;
        // a PRESENT but empty model is a filter of its own — the calls that named no model
        const model = ctx.url.searchParams.get("model");
        // the rows carry UTC stamps: the owner's day starts at its own local midnight
        const sinceStamp = sinceDay === "" ? "" : isoStamp(dayStart(sinceDay));
        const rows = db.perfCalls(sinceStamp, { agent, model });

        type Identity = Omit<CallPerfRow, "completionTokens" | "durationMs" | "firstOutputMs">;
        const totals = bucket();
        const byModel = new Map<string, { identity: Identity; b: Bucket }>();
        const byProvider = new Map<string | null, Bucket>();
        for (const r of rows) {
            fold(totals, r);
            // the frozen identity IS the key: two providers behind one model id never merge
            const key = JSON.stringify([r.modelUid, r.model, r.provider]);
            let m = byModel.get(key);
            if (!m) {
                m = {
                    identity: {
                        modelUid: r.modelUid,
                        registryModel: r.registryModel,
                        model: r.model,
                        provider: r.provider,
                    },
                    b: bucket(),
                };
                byModel.set(key, m);
            }
            // rows arrive oldest first, so a model gone from the registry reads as the LAST alias the group recorded
            if (r.registryModel !== null) m.identity.registryModel = r.registryModel;
            fold(m.b, r);
            let provider = byProvider.get(r.provider);
            if (!provider) {
                provider = bucket();
                byProvider.set(r.provider, provider);
            }
            fold(provider, r);
        }

        // a model still in the registry reads as its name now, whatever alias its calls recorded
        const names = new Map(db.listModels().map((m) => [m.modelUid, m.name]));

        // nothing recorded claims nothing; otherwise the rows must reach PAST the window and be timed throughout
        const coverage = db.callCoverage(sinceStamp);
        // the db stamps UTC "YYYY-MM-DD HH:MM:SS"; the window is in the owner's days
        const oldestDay = coverage.oldest === null ? null : localDay(Date.parse(`${coverage.oldest.replace(" ", "T")}Z`));
        return json(ctx.res, 200, {
            days: n,
            sinceDay,
            agent,
            model,
            coverage: {
                since: oldestDay,
                complete: oldestDay === null || (oldestDay <= sinceDay && coverage.unmeasured === 0),
            },
            totals: aggregate(totals),
            modelRows: [...byModel.values()]
                .map((m) => ({ ...m.identity, registryModel: names.get(m.identity.modelUid ?? "") ?? m.identity.registryModel, ...aggregate(m.b) }))
                .sort((a, b) => b.calls - a.calls || (a.model ?? "").localeCompare(b.model ?? "")),
            providerRows: [...byProvider]
                .map(([provider, totals]) => ({ provider, ...aggregate(totals) }))
                .sort((a, b) => b.calls - a.calls || (a.provider ?? "").localeCompare(b.provider ?? "")),
        });
    });
}
