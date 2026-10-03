/** Recorded generation performance: the frozen provider, the first-output clock, and the route that aggregates them. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { newCallId, recordLlmCall, type LlmCallRecord } from "../src/store/accounting.ts";
import { localDay } from "../src/store/day.ts";
import type { GatewayDb } from "../src/store/db.ts";
import { boot, textTurn, waitFor, type Env } from "./harness-env.ts";

interface Timing {
    samples: number;
    mean: number | null;
    p50: number | null;
    p95: number | null;
}

interface Metrics {
    calls: number;
    latencyMs: Timing;
    firstOutputMs: Timing;
    throughput: {
        samples: number;
        completionTokens: number;
        durationMs: number;
        tokensPerSec: number | null;
    };
}

interface ModelPerfRow extends Metrics {
    modelUid: string | null;
    registryModel: string | null;
    model: string | null;
    provider: string | null;
}

interface PerfBody {
    days: number;
    sinceDay: string;
    agent: string | null;
    model: string | null;
    coverage: { since: string | null; complete: boolean };
    totals: Metrics;
    modelRows: ModelPerfRow[];
    providerRows: Array<Metrics & { provider: string | null }>;
}

const perf = async (env: Env, query: string): Promise<PerfBody> =>
    (await env.api<PerfBody>("GET", `/api/stats/performance${query}`)).json;

interface Measured {
    agent?: string;
    model?: string;
    provider?: string;
    registry?: { uid: string; alias: string };
    completion?: number;
    durationMs?: number;
    firstOutputMs?: number;
}

/** A call the way every writer records one: identity frozen, both clocks filled in. */
function measured(db: GatewayDb, m: Measured): void {
    const record: LlmCallRecord = {
        agent: m.agent ?? "alfa",
        scope: m.agent ?? "alfa",
        callId: newCallId(),
        callKind: "turn",
        model: m.model ?? null,
        provider: m.provider ?? null,
        modelUid: m.registry?.uid ?? null,
        registryModel: m.registry?.alias ?? null,
        usage:
            m.completion === undefined
                ? undefined
                : { promptTokens: 10, completionTokens: m.completion, totalTokens: 10 + m.completion, cachedTokens: 0 },
        firstOutputMs: m.firstOutputMs ?? null,
        raw: { ok: 1 },
    };
    if (m.durationMs !== undefined) record.durationMs = m.durationMs;
    recordLlmCall(record, db, localDay());
}

const modelRow = (body: PerfBody, model: string | null, provider: string | null): ModelPerfRow => {
    const row = body.modelRows.find((r) => r.model === model && r.provider === provider);
    assert.ok(row, `no model row for ${model}/${provider}`);
    return row;
};

test("a real turn freezes the adapter kind and measures its first output", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const h = await env.connect({ name: "toto" });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        const sid = h.createSession();
        env.model.nextTurn(textTurn("answered"));
        const out = await env.core.runTurn({ agent: "toto", session: sid, text: "go", title: false });
        assert.equal(out.text, "answered");

        const row = env.db.listLlmCalls(5, "toto")[0];
        assert.ok(row);
        assert.equal(row.provider, "llamacpp", "the adapter kind at call time, not today's settings");
        assert.equal(row.registryModel, "fake");
        assert.notEqual(row.modelUid, null);
        assert.ok(row.firstOutputMs !== null, "the first text event stamped the clock");
        assert.ok(row.durationMs !== null);
        assert.ok(
            row.firstOutputMs <= row.durationMs,
            `first output ${row.firstOutputMs}ms must precede the end ${row.durationMs}ms`,
        );

        const body = await perf(env, "?days=1");
        assert.equal(body.totals.calls, 1);
        assert.equal(body.totals.firstOutputMs.samples, 1);
        assert.equal(body.totals.firstOutputMs.p50, row.firstOutputMs);
        assert.equal(body.totals.latencyMs.p50, row.durationMs);
        assert.deepEqual(
            body.modelRows.map((r) => [r.model, r.provider, r.registryModel]),
            [["fake", "llamacpp", "fake"]],
        );
        assert.deepEqual(
            body.providerRows.map((r) => [r.provider, r.calls]),
            [["llamacpp", 1]],
        );
    } finally {
        await env.stop();
    }
});

test("the route compares two providers, per model and in total", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const remote = { uid: "u-remote", alias: "remote" };
        const local = { uid: "u-local", alias: "local" };
        measured(env.db, {
            model: "openai/gpt",
            provider: "openrouter",
            registry: remote,
            completion: 100,
            durationMs: 2000,
            firstOutputMs: 300,
        });
        measured(env.db, {
            model: "openai/gpt",
            provider: "openrouter",
            registry: remote,
            completion: 300,
            durationMs: 2000,
            firstOutputMs: 100,
        });
        measured(env.db, {
            model: "qwen3",
            provider: "vllm",
            registry: local,
            completion: 50,
            durationMs: 500,
            firstOutputMs: 50,
        });

        const body = await perf(env, "?days=1");
        assert.equal(body.days, 1);
        assert.equal(body.sinceDay, localDay());
        assert.equal(body.agent, null);
        assert.equal(body.model, null);

        assert.equal(body.totals.calls, 3);
        assert.equal(body.totals.latencyMs.samples, 3);
        assert.equal(body.totals.firstOutputMs.samples, 3);
        assert.deepEqual(body.totals.firstOutputMs, { samples: 3, mean: 150, p50: 100, p95: 300 });
        assert.deepEqual(body.totals.throughput, {
            samples: 3,
            completionTokens: 450,
            durationMs: 4500,
            tokensPerSec: 100,
        });

        assert.equal(body.modelRows.length, 2);
        assert.equal(body.modelRows[0]?.calls, 2, "the busiest model leads");
        const openrouter = modelRow(body, "openai/gpt", "openrouter");
        assert.equal(openrouter.modelUid, "u-remote");
        assert.equal(openrouter.registryModel, "remote");
        assert.deepEqual(openrouter.latencyMs, { samples: 2, mean: 2000, p50: 2000, p95: 2000 });
        assert.equal(openrouter.throughput.tokensPerSec, 100);

        const vllm = modelRow(body, "qwen3", "vllm");
        assert.equal(vllm.calls, 1);
        assert.equal(vllm.throughput.completionTokens, 50);

        assert.deepEqual(
            body.providerRows.map((r) => [r.provider, r.calls]),
            [
                ["openrouter", 2],
                ["vllm", 1],
            ],
        );
        assert.equal(
            body.providerRows.reduce((n, r) => n + r.calls, 0),
            body.totals.calls,
            "every call lands in exactly one provider bucket",
        );
    } finally {
        await env.stop();
    }
});

test("throughput is SUM/SUM over the rows that carried both numbers, not a mean of rates", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const registry = { uid: "u1", alias: "one" };
        measured(env.db, {
            model: "m",
            provider: "vllm",
            registry,
            completion: 10,
            durationMs: 1000,
            firstOutputMs: 900,
        });
        measured(env.db, {
            model: "m",
            provider: "vllm",
            registry,
            completion: 900,
            durationMs: 2000,
            firstOutputMs: 20,
        });
        // measured, but not usable for a rate: one has no duration, the other no token count
        measured(env.db, { model: "m", provider: "vllm", registry, completion: 500 });
        measured(env.db, {
            model: "m",
            provider: "vllm",
            registry,
            durationMs: 4000,
            firstOutputMs: 10,
        });

        const body = await perf(env, "?days=1");
        const row = modelRow(body, "m", "vllm");
        assert.equal(row.calls, 4);
        assert.equal(row.latencyMs.samples, 3, "the duration-less row is no latency sample");
        assert.deepEqual(row.throughput, {
            samples: 2,
            completionTokens: 910,
            durationMs: 3000,
            tokensPerSec: 303.33,
        });
        const meanOfRates = (10 / 1 + 900 / 2) / 2;
        assert.notEqual(row.throughput.tokensPerSec, meanOfRates);
        assert.equal(
            row.throughput.tokensPerSec,
            Number(((910 / 3000) * 1000).toFixed(2)),
            "the same rows on both sides of the division",
        );
        assert.deepEqual(row.firstOutputMs, { samples: 3, mean: 310, p50: 20, p95: 900 });
    } finally {
        await env.stop();
    }
});

test("agent= and model= scope the window; an unknown filter is empty, never an error", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        measured(env.db, {
            agent: "alfa",
            model: "m-a",
            provider: "openrouter",
            completion: 100,
            durationMs: 1000,
            firstOutputMs: 10,
        });
        measured(env.db, {
            agent: "beta",
            model: "m-b",
            provider: "vllm",
            completion: 200,
            durationMs: 1000,
            firstOutputMs: 20,
        });
        // a call that named no model at all — what `model=` asks for
        measured(env.db, {
            agent: "beta",
            provider: "vllm",
            completion: 5,
            durationMs: 500,
            firstOutputMs: 5,
        });

        const scoped = await perf(env, "?days=1&agent=alfa");
        assert.equal(scoped.agent, "alfa");
        assert.equal(scoped.totals.calls, 1);
        assert.equal(scoped.totals.throughput.completionTokens, 100);

        const byModel = await perf(env, "?days=1&model=m-b");
        assert.equal(byModel.model, "m-b");
        assert.equal(byModel.totals.calls, 1);
        assert.deepEqual(
            byModel.modelRows.map((r) => [r.model, r.provider]),
            [["m-b", "vllm"]],
        );

        const noModel = await perf(env, "?days=1&model=");
        assert.equal(noModel.model, "", "a present but empty model is the unknown-model bucket");
        assert.equal(noModel.totals.calls, 1);
        assert.equal(noModel.modelRows[0]?.model, null);

        const both = await perf(env, "?days=1&agent=beta&model=m-b");
        assert.equal(both.totals.calls, 1);
        assert.equal(both.agent, "beta");

        const nothing = [
            "?days=1&agent=nobody",
            "?days=1&model=ghost",
            "?days=1&agent=alfa&model=m-b",
        ];
        for (const query of nothing) {
            const empty = await perf(env, query);
            assert.equal(empty.totals.calls, 0, query);
            assert.deepEqual(empty.modelRows, [], query);
            assert.deepEqual(empty.providerRows, [], query);
            assert.deepEqual(empty.totals.latencyMs, { samples: 0, mean: null, p50: null, p95: null });
            assert.deepEqual(empty.totals.firstOutputMs, { samples: 0, mean: null, p50: null, p95: null });
            assert.equal(empty.totals.throughput.tokensPerSec, null);
        }
    } finally {
        await env.stop();
    }
});

test("coverage says what the retained tail can back: a window that starts before it is never claimed whole", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        const empty = await perf(env, "?days=7");
        assert.deepEqual(
            empty.coverage,
            { since: null, complete: true },
            "nothing recorded, nothing missing",
        );

        measured(env.db, {
            model: "m",
            provider: "vllm",
            completion: 10,
            durationMs: 100,
            firstOutputMs: 10,
        });
        const today = await perf(env, "?days=1");
        assert.deepEqual(today.coverage, { since: localDay(), complete: true });

        // the tail starts INSIDE a wider window: everything before it may simply be gone
        const week = await perf(env, "?days=7");
        assert.equal(week.coverage.since, localDay());
        assert.equal(week.coverage.complete, false);
        assert.equal((await perf(env, "?days=0")).coverage.complete, false, "all-history is never claimed whole");

        // a filter narrows the numbers, never the honesty about the history behind them
        assert.deepEqual((await perf(env, "?days=7&agent=nobody")).coverage, week.coverage);
    } finally {
        await env.stop();
    }
});

test("a same-day flood past the raw cap loses no measurement and never fakes completeness", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        // six calls against a raw tail of three: twice the cap, all inside one day
        for (let i = 0; i < 6; i++) {
            env.db.insertLlmCall(
                {
                    agent: "alfa",
                    scope: "alfa",
                    callId: newCallId(),
                    callKind: "turn",
                    model: "m",
                    provider: "vllm",
                    completionTokens: 10,
                    durationMs: 100,
                    firstOutputMs: 10,
                    raw: { i },
                },
                3,
            );
        }

        assert.ok(env.db.getLlmCall(1), "no row was deleted");
        assert.equal(env.db.getLlmCall(3)?.raw, "", "the oldest payloads are blanked");
        assert.notEqual(env.db.getLlmCall(4)?.raw, "", "the raw tail keeps the newest three");

        const body = await perf(env, "?days=1");
        assert.equal(body.totals.calls, 6, "every measurement outlived the raw prune");
        assert.equal(body.totals.latencyMs.samples, 6);
        assert.deepEqual(
            body.coverage,
            { since: localDay(), complete: true },
            "nothing was lost, so the flood does not read as a partial day",
        );

        const pruned = await env.api("GET", "/api/agents/alfa/calls/1");
        assert.equal(pruned.status, 404);
        assert.deepEqual(pruned.json, { error: "raw payload pruned" });
        assert.equal((await env.api("GET", "/api/agents/alfa/calls/5")).status, 200);
    } finally {
        await env.stop();
    }
});

test("the performance route is unreachable off the tunnel, like every other /api route", async () => {
    const env = await boot({ contextTokens: 4000 });
    try {
        assert.equal((await fetch(`${env.base}/api/stats/performance`)).status, 404);
    } finally {
        await env.stop();
    }
});
