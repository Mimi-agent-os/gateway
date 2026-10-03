/** Usage statistics: the daily rollup, its two routes, and the raw tail that gets pruned under it. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import test from "node:test";

import type { Usage } from "@mimi-os/protocol";

import { getModel, setModelPricing } from "../src/llm/models.ts";
import { newCallId, recordLlmCall } from "../src/store/accounting.ts";
import { localDay, shiftDay } from "../src/store/day.ts";
import { LLM_CALLS_KEEP, type GatewayDb } from "../src/store/db.ts";
import { boot } from "./harness-env.ts";

interface UsageCell {
    agent: string;
    model: string;
    registryModel: string | null;
    calls: number;
    estimatedCalls: number;
    promptTokens: number;
    cost: number;
    completionTokens: number;
    totalTokens: number;
}

interface RegistryCell {
    modelUid: string | null;
    registryModel: string | null;
    calls: number;
    estimatedCalls: number;
    promptTokens: number;
    cost: number;
    completionTokens: number;
    totalTokens: number;
}

interface UsageBody {
    sinceDay: string;
    days: number;
    agent: string | null;
    rows: UsageCell[];
    totals: { calls: number; estimatedCalls: number; promptTokens: number; completionTokens: number; totalTokens: number; cost: number };
    registryRows?: RegistryCell[];
}

interface DailyBody {
    agent: string | null;
    sinceDay: string;
    day: { today: string; timeZone: string; resetsAt: string };
    rows: Array<{ day: string; model: string; registryModel: string | null; calls: number; totalTokens: number; cost: number }>;
    registryRows?: RegistryCell[];
}

const usage = (prompt: number, completion: number): Usage => ({
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    cachedTokens: 0,
});

/** The day is injected rather than waited for; without `registry` no registry row chose the model (a ping of an unsaved one). */
const call = (
    db: GatewayDb,
    day: string,
    agent: string,
    model: string,
    prompt: number,
    completion: number,
    registry?: { uid: string; alias: string },
): void =>
    recordLlmCall(
        {
            agent,
            scope: agent,
            callId: newCallId(),
            callKind: "turn",
            model,
            modelUid: registry?.uid ?? null,
            registryModel: registry?.alias ?? null,
            usage: usage(prompt, completion),
            raw: { ok: 1 },
        },
        db,
        day,
    );

const daysAgo = (n: number): string => shiftDay(localDay(), -n);

const cell = (rows: readonly UsageCell[], agent: string, model: string): UsageCell | undefined =>
    rows.find((r) => r.agent === agent && r.model === model);

test("rollup: two agents, two models, two days fold into agent×model and day×model", async () => {
    const env = await boot();
    try {
        const now = localDay();
        const before = daysAgo(1);
        call(env.db, now, "alfa", "gpt", 10, 5);
        call(env.db, now, "alfa", "gpt", 20, 10);
        call(env.db, now, "alfa", "local", 100, 50);
        call(env.db, now, "beta", "gpt", 1, 2);
        call(env.db, before, "beta", "gpt", 7, 3);

        const wide = env.db.usageMatrix(before);
        assert.equal(wide.length, 3);
        const alfaGpt = cell(wide, "alfa", "gpt");
        assert.deepEqual(alfaGpt, {
            agent: "alfa",
            model: "gpt",
            registryModel: null,
            calls: 2,
            estimatedCalls: 0,
            promptTokens: 30,
            cost: 0,
            completionTokens: 15,
            totalTokens: 45,
        });
        // the heaviest cell leads the table
        assert.equal(wide[0]?.model, "local");
        assert.equal(cell(wide, "beta", "gpt")?.calls, 2);

        const narrow = env.db.usageMatrix(now);
        assert.equal(cell(narrow, "beta", "gpt")?.totalTokens, 3, "yesterday is outside the window");

        const series = env.db.usageSeries(before);
        assert.deepEqual(
            series.map((r) => [r.day, r.model, r.calls, r.totalTokens]),
            [
                [before, "gpt", 1, 10],
                [now, "gpt", 3, 48],
                [now, "local", 1, 150],
            ],
        );

        // the dashboard reads the SAME rollup: prompt + completion, what providers bill
        assert.equal(env.db.spendByAgent(now).get("alfa")?.tokens, 195);
        assert.equal(env.db.spendByAgent(now).get("beta")?.tokens, 3);
    } finally {
        await env.stop();
    }
});

test("stats routes: window, totals and the day series over the tunnel", async () => {
    const env = await boot();
    try {
        const now = localDay();
        const before = daysAgo(1);
        call(env.db, now, "alfa", "gpt", 10, 5);
        call(env.db, before, "beta", "local", 100, 100);

        const usageAt = async (query: string): Promise<UsageBody> =>
            (await env.api<UsageBody>("GET", `/api/stats/usage${query}`)).json;

        const one = await usageAt("?days=1");
        assert.equal(one.days, 1);
        assert.equal(one.sinceDay, now);
        assert.equal(one.rows.length, 1);
        assert.deepEqual(one.totals, {
            calls: 1,
            estimatedCalls: 0,
            promptTokens: 10,
            cost: 0,
            completionTokens: 5,
            totalTokens: 15,
        });

        const two = await usageAt("?days=2");
        assert.equal(two.sinceDay, before);
        assert.equal(two.rows.length, 2);
        assert.deepEqual(two.totals, {
            calls: 2,
            estimatedCalls: 0,
            promptTokens: 110,
            cost: 0,
            completionTokens: 105,
            totalTokens: 215,
        });
        assert.equal(cell(two.rows, "beta", "local")?.totalTokens, 200);

        // days=0 is «all history»: no lower bound, and no sinceDay to state
        const all = await usageAt("?days=0");
        assert.equal(all.days, 0);
        assert.equal(all.sinceDay, "");
        assert.equal(all.rows.length, 2);
        assert.deepEqual(all.totals, two.totals, "the whole rollup is exactly both seeded days");

        // days is clamped, never trusted: 9999 → 365, negative → all, nonsense → the default
        assert.equal((await usageAt("?days=9999")).days, 365);
        assert.equal((await usageAt("?days=-5")).days, 0);
        assert.equal((await usageAt("?days=nope")).days, 7);
        assert.equal((await usageAt("")).days, 7);

        const daily = (await env.api<DailyBody>("GET", "/api/stats/daily?days=2")).json;
        assert.deepEqual(
            daily.rows.map((r) => [r.day, r.model, r.totalTokens]),
            [
                [before, "local", 200],
                [now, "gpt", 15],
            ],
        );
        const short = (await env.api<DailyBody>("GET", "/api/stats/daily?days=1")).json;
        assert.equal(short.rows.length, 1);
        // the series is a strip: unlike the table, it has no «all history» window
        const bounded = (await env.api<DailyBody>("GET", "/api/stats/daily?days=0")).json;
        assert.deepEqual(bounded.rows, short.rows);
    } finally {
        await env.stop();
    }
});

test("a call with no usage and no model still counts, as zero tokens under an empty model", async () => {
    const env = await boot();
    try {
        recordLlmCall(
            { agent: "alfa", scope: "alfa:title", callId: newCallId(), callKind: "title", raw: {} },
            env.db,
            localDay(),
        );
        const rows = env.db.usageMatrix(localDay());
        assert.deepEqual(rows, [
            {
                agent: "alfa",
                model: "",
                registryModel: null,
                calls: 1,
                estimatedCalls: 0,
                promptTokens: 0,
                cost: 0,
                completionTokens: 0,
                totalTokens: 0,
            },
        ]);
    } finally {
        await env.stop();
    }
});

test("a reported reasoning count is kept on the call row and added into no total", async () => {
    const env = await boot();
    try {
        const now = localDay();
        recordLlmCall(
            {
                agent: "alfa",
                scope: "alfa",
                callId: newCallId(),
                callKind: "turn",
                model: "gpt",
                usage: { ...usage(10, 40), reasoningTokens: 32 },
                raw: { ok: 1 },
            },
            env.db,
            now,
        );

        assert.equal(env.db.listLlmCalls(1)[0]?.reasoningTokens, 32);
        assert.deepEqual(cell(env.db.usageMatrix(now), "alfa", "gpt"), {
            agent: "alfa",
            model: "gpt",
            registryModel: null,
            calls: 1,
            estimatedCalls: 0,
            promptTokens: 10,
            cost: 0,
            completionTokens: 40,
            totalTokens: 50,
        });
        assert.equal(env.db.spendByAgent(now).get("alfa")?.tokens, 50, "reasoning tokens are a subset of the completion count");

        // a call whose provider reported none reads null, never a zero the provider never sent
        call(env.db, now, "beta", "gpt", 5, 5);
        assert.equal(env.db.listLlmCalls(1)[0]?.reasoningTokens, null);
    } finally {
        await env.stop();
    }
});

test("the prune blanks raw payloads past the cap and deletes no rows", async () => {
    const env = await boot();
    try {
        const now = localDay();
        const n = LLM_CALLS_KEEP + 5;
        for (let i = 0; i < n; i++) call(env.db, now, "alfa", "gpt", 1, 1);

        assert.ok(env.db.getLlmCall(1), "the oldest row is still there");
        assert.equal(env.db.listLlmCalls(1)[0]?.id, n, "the newest row leads");
        const pruned = env.db.getLlmCall(n - LLM_CALLS_KEEP);
        assert.ok(pruned, "the oldest row outlived its payload");
        assert.equal(pruned.raw, "", "only its raw payload is gone");
        assert.equal(pruned.completionTokens, 1, "the measured columns survive the prune");
        assert.notEqual(env.db.getLlmCall(n - LLM_CALLS_KEEP + 1)?.raw, "", "the raw tail starts there");

        const rollup = env.db.usageMatrix(now);
        assert.deepEqual(rollup, [
            {
                agent: "alfa",
                model: "gpt",
                registryModel: null,
                calls: n,
                estimatedCalls: 0,
                promptTokens: n,
                cost: 0,
                completionTokens: n,
                totalTokens: n * 2,
            },
        ]);
    } finally {
        await env.stop();
    }
});

test("registry identity: rows carry the alias, ?group=registry buckets by uid, totals agree", async () => {
    const env = await boot();
    try {
        const now = localDay();
        const before = daysAgo(1);
        const fast = { uid: "uid-fast", alias: "fast" };
        const local = { uid: "uid-local", alias: "local-q4" };
        call(env.db, now, "alfa", "openai/gpt", 10, 5, fast);
        call(env.db, now, "beta", "openai/gpt", 1, 1, fast); // same model, another agent
        call(env.db, now, "alfa", "llama-3.1", 100, 50, local);
        call(env.db, before, "alfa", "unsaved", 7, 3); // no registry row chose it

        const usageAt = async (query: string): Promise<UsageBody> =>
            (await env.api<UsageBody>("GET", `/api/stats/usage${query}`)).json;

        const plain = await usageAt("?days=0");
        assert.equal(plain.registryRows, undefined, "registryRows is opt-in");
        assert.deepEqual(
            plain.rows.map((r) => [r.agent, r.model]),
            [
                ["alfa", "llama-3.1"],
                ["alfa", "openai/gpt"],
                ["alfa", "unsaved"],
                ["beta", "openai/gpt"],
            ],
            "the agent×model grouping and its order are untouched",
        );
        assert.equal(cell(plain.rows, "alfa", "openai/gpt")?.registryModel, "fast");
        assert.equal(cell(plain.rows, "alfa", "unsaved")?.registryModel, null);

        const grouped = await usageAt("?days=0&group=registry");
        assert.deepEqual(grouped.rows, plain.rows, "`rows` is the same either way");
        const registryRows = grouped.registryRows ?? [];
        assert.deepEqual(registryRows, [
            {
                modelUid: "uid-local",
                registryModel: "local-q4",
                calls: 1,
                estimatedCalls: 0,
                promptTokens: 100,
                cost: 0,
                completionTokens: 50,
                totalTokens: 150,
            },
            {
                modelUid: "uid-fast",
                registryModel: "fast",
                calls: 2,
                estimatedCalls: 0,
                promptTokens: 11,
                cost: 0,
                completionTokens: 6,
                totalTokens: 17,
            },
            {
                modelUid: null,
                registryModel: null,
                calls: 1,
                estimatedCalls: 0,
                promptTokens: 7,
                cost: 0,
                completionTokens: 3,
                totalTokens: 10,
            },
        ]);

        // the two groupings are the same numbers read two ways — never a double count
        const sum = (rows: readonly RegistryCell[], k: keyof RegistryCell): number =>
            rows.reduce((n, r) => n + (r[k] as number), 0);
        assert.equal(sum(registryRows, "calls"), grouped.totals.calls);
        assert.equal(sum(registryRows, "promptTokens"), grouped.totals.promptTokens);
        assert.equal(sum(registryRows, "completionTokens"), grouped.totals.completionTokens);
        assert.equal(sum(registryRows, "totalTokens"), grouped.totals.totalTokens);

        const daily = (await env.api<DailyBody>("GET", "/api/stats/daily?days=2&group=registry")).json;
        assert.deepEqual(
            daily.registryRows?.map((r) => [r.modelUid, r.registryModel, r.calls, r.totalTokens]),
            [
                ["uid-local", "local-q4", 1, 150],
                ["uid-fast", "fast", 2, 17],
                [null, null, 1, 10],
            ],
        );
        const barTokens = daily.rows.reduce((n, r) => n + r.totalTokens, 0);
        const uidTokens = (daily.registryRows ?? []).reduce((n, r) => n + r.totalTokens, 0);
        assert.equal(uidTokens, barTokens, "the strip and its registry buckets hold the same tokens");
        assert.equal(daily.rows.find((r) => r.model === "llama-3.1")?.registryModel, "local-q4");
    } finally {
        await env.stop();
    }
});

test("a rename keeps one bucket: the uid is the key, the alias is only what it was called", async () => {
    const env = await boot();
    try {
        const now = localDay();
        const before = daysAgo(1);
        call(env.db, before, "alfa", "openai/gpt", 10, 0, { uid: "uid-fast", alias: "fast" });
        call(env.db, now, "alfa", "openai/gpt", 1, 0, { uid: "uid-fast", alias: "quick" });

        const buckets = env.db.usageByRegistry(before);
        assert.equal(buckets.length, 1, "a rename must not split the history in two");
        assert.equal(buckets[0]?.modelUid, "uid-fast");
        assert.equal(buckets[0]?.calls, 2);
        assert.equal(buckets[0]?.registryModel, "quick", "the LAST alias names the bucket");

        // recreation is a different model: a fresh uid opens a bucket of its own
        call(env.db, now, "alfa", "openai/gpt-2", 5, 0, { uid: "uid-fresh", alias: "quick" });
        assert.equal(env.db.usageByRegistry(before).length, 2);
    } finally {
        await env.stop();
    }
});

test("stats routes are unreachable off the tunnel, like every other /api route", async () => {
    const env = await boot();
    try {
        assert.equal((await fetch(`${env.base}/api/stats/usage`)).status, 404);
        assert.equal((await fetch(`${env.base}/api/stats/daily`)).status, 404);
    } finally {
        await env.stop();
    }
});

test("agent= scopes usage, daily and registryRows to that agent's recorded rows alone", async () => {
    const env = await boot();
    try {
        const today = localDay();
        call(env.db, today, "alfa", "m1", 100, 10, { uid: "u1", alias: "one" });
        call(env.db, today, "alfa", "m2", 50, 5, { uid: "u2", alias: "two" });
        call(env.db, today, "beta", "m1", 999, 99, { uid: "u1", alias: "one" });

        const scoped = (await env.api<UsageBody>("GET", "/api/stats/usage?days=1&group=registry&agent=alfa")).json;
        assert.equal(scoped.agent, "alfa");
        assert.ok(scoped.rows.every((r) => r.agent === "alfa"));
        assert.equal(scoped.totals.totalTokens, 165);
        assert.equal((scoped.registryRows ?? []).reduce((s, r) => s + r.calls, 0), 2);

        const all = (await env.api<UsageBody>("GET", "/api/stats/usage?days=1")).json;
        assert.equal(all.agent, null);
        assert.equal(all.totals.totalTokens, 165 + 1098);

        const daily = (await env.api<DailyBody>("GET", "/api/stats/daily?days=1&agent=beta")).json;
        assert.equal(daily.agent, "beta");
        assert.equal(daily.rows.reduce((s, r) => s + r.totalTokens, 0), 1098);

        // an unknown agent is an empty scope, never an error
        const ghost = (await env.api<UsageBody>("GET", "/api/stats/usage?days=1&agent=nobody")).json;
        assert.equal(ghost.agent, "nobody");
        assert.deepEqual(ghost.rows, []);
        assert.equal(ghost.totals.calls, 0);
    } finally {
        await env.stop();
    }
});

test("spent counts the whole re-sent context of every call, as a provider bills it", async () => {
    const env = await boot();
    try {
        const now = localDay();
        const rec = (prompt: number, completion: number, session: number | null): void =>
            recordLlmCall(
                {
                    agent: "alfa",
                    scope: "alfa",
                    callId: newCallId(),
                    callKind: session === null ? "oneshot" : "turn",
                    session,
                    model: "gpt",
                    usage: usage(prompt, completion),
                    raw: {},
                },
                env.db,
                now,
            );
        // one conversation whose prompt grows as the whole context is re-sent each turn, and a oneshot
        rec(100, 50, 1);
        rec(170, 60, 1);
        rec(260, 40, 1);
        rec(80, 10, null);

        const c = cell(env.db.usageMatrix(now), "alfa", "gpt")!;
        assert.equal(c.calls, 4);
        assert.equal(c.promptTokens, 610, "every prompt counts whole");
        assert.equal(c.completionTokens, 160);
        assert.equal(c.totalTokens, 770);
        assert.equal("freshInput" in c, false);
        assert.deepEqual(env.db.listLlmCalls(4).map((x) => x.promptTokens), [80, 260, 170, 100]);
    } finally {
        await env.stop();
    }
});

test("cost is each registry model's tokens at its CURRENT price, on every rollup", async () => {
    const env = await boot();
    try {
        const now = localDay();
        const before = daysAgo(1);
        const fake = { uid: getModel("fake", env.db)!.modelUid, alias: "fake" };
        call(env.db, now, "alfa", "fake-id", 1_000_000, 100_000, fake);
        call(env.db, before, "beta", "fake-id", 500_000, 0, fake);
        call(env.db, now, "alfa", "unsaved", 7, 3); // no registry row prices it
        const read = async (): Promise<UsageBody> => (await env.api<UsageBody>("GET", "/api/stats/usage?days=2&group=registry")).json;

        assert.equal((await read()).totals.cost, 0, "a model with no price costs nothing");

        setModelPricing("fake", { priceInPerM: 2, priceOutPerM: 10 }, env.db);
        const priced = await read();
        assert.equal(cell(priced.rows, "alfa", "fake-id")?.cost, 2 + 1);
        assert.equal(cell(priced.rows, "beta", "fake-id")?.cost, 1);
        assert.equal(cell(priced.rows, "alfa", "unsaved")?.cost, 0);
        assert.equal(priced.totals.cost, 4);
        assert.deepEqual(priced.registryRows?.map((r) => [r.modelUid, r.cost]), [[fake.uid, 4], [null, 0]]);
        const daily = (await env.api<DailyBody>("GET", "/api/stats/daily?days=2")).json;
        assert.deepEqual(daily.rows.map((r) => [r.day, r.model, r.cost]), [
            [before, "fake-id", 1],
            [now, "fake-id", 3],
            [now, "unsaved", 0],
        ]);

        // a new price re-prices all history at once
        setModelPricing("fake", { priceInPerM: 1 }, env.db);
        assert.equal((await read()).totals.cost, 1.5 + 1);
    } finally {
        await env.stop();
    }
});

test("roster and dashboard batch per-agent state and sum today's tokens per agent", async (t) => {
    const env = await boot();
    t.after(() => env.stop());
    for (const name of ["worker", "helper"]) env.pin(name);
    env.db.setPaused("worker", true);
    env.db.setModelsPolicy("worker", { primary: "fake" });
    const today = (model: string, promptTokens: number, completionTokens: number) =>
        ({ agent: "worker", model, modelUid: null, registryModel: null, promptTokens, completionTokens, estimated: false });
    env.db.bumpUsageDaily(localDay(), today("model-a", 2, 3));
    env.db.bumpUsageDaily(localDay(), today("model-b", 7, 11));
    env.db.bumpUsageDaily("9999-01-01", today("future", 100, 100));
    const pauses = t.mock.method(env.db, "isPaused");
    const policies = t.mock.method(env.db, "getModelsPolicy");
    const spend = t.mock.method(env.db, "spendByAgent");

    const roster = await env.api<Array<{ name: string; paused: boolean; models: { primary?: string } | null }>>("GET", "/api/agents");
    assert.equal(roster.status, 200);
    assert.equal(roster.json.find((row) => row.name === "worker")?.paused, true);
    assert.equal(roster.json.find((row) => row.name === "worker")?.models?.primary, "fake");
    assert.equal(roster.json.find((row) => row.name === "helper")?.models, null);
    const dashboard = await env.api<{ agents: Array<{ name: string; tokensToday: number }> }>("GET", "/api/dashboard");
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.json.agents.find((row) => row.name === "worker")?.tokensToday, 23);
    assert.equal(dashboard.json.agents.find((row) => row.name === "helper")?.tokensToday, 0);
    assert.equal(pauses.mock.callCount(), 0, "one batched read, never one per agent");
    assert.equal(policies.mock.callCount(), 0);
    assert.equal(spend.mock.callCount(), 1);
});
