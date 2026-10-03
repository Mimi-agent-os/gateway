/** The Limits & prices surface: one row per registry model, its own PATCH, kept apart from the base model settings. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { addModel, getModel } from "../src/llm/models.ts";
import { newCallId, recordLlmCall } from "../src/store/accounting.ts";
import { dayInfo, localDay } from "../src/store/day.ts";
import { tokenCost } from "../src/store/db.ts";
import { boot, waitFor } from "./harness-env.ts";

interface LimitRow {
    uid: string;
    name: string;
    provider: string;
    priceInPerM: number;
    priceOutPerM: number;
    limit: { unit: "tokens" | "usd"; value: number } | null;
    today: { tokens: number; promptTokens: number; completionTokens: number; cost: number };
    day: { today: string; timeZone: string; resetsAt: string };
}

test("GET /api/limits lists every model with its prices, limit and today's spend across all agents", async () => {
    const env = await boot();
    try {
        addModel({ name: "spare", provider: "llamacpp", endpoint: "http://127.0.0.1:1", contextTokens: 1000 }, env.db);
        const uid = getModel("fake", env.db)!.modelUid;
        for (const [agent, prompt, completion] of [["alfa", 300, 20], ["beta", 100, 80]] as const) {
            recordLlmCall(
                { agent, scope: agent, callId: newCallId(), callKind: "turn", modelUid: uid, registryModel: "fake", usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, cachedTokens: 0 }, raw: {} },
                env.db,
            );
        }

        const listed = await env.api<LimitRow[]>("GET", "/api/limits");
        assert.equal(listed.status, 200);
        assert.deepEqual(listed.json, [
            {
                uid,
                name: "fake",
                provider: "llamacpp",
                priceInPerM: 0,
                priceOutPerM: 0,
                limit: null,
                today: { tokens: 500, promptTokens: 400, completionTokens: 100, cost: 0 },
                day: dayInfo(),
            },
            {
                uid: getModel("spare", env.db)!.modelUid,
                name: "spare",
                provider: "llamacpp",
                priceInPerM: 0,
                priceOutPerM: 0,
                limit: null,
                today: { tokens: 0, promptTokens: 0, completionTokens: 0, cost: 0 },
                day: dayInfo(),
            },
        ]);

        // pricing stays out of the base model settings
        const models = (await env.api<Array<Record<string, unknown>>>("GET", "/api/models")).json;
        for (const key of ["priceInPerM", "priceOutPerM", "limit"]) assert.equal(key in models[0]!, false, key);
    } finally {
        await env.stop();
    }
});

test("PATCH /api/limits/:model sets prices and a limit, keeps what it does not name, and validates", async () => {
    const env = await boot();
    try {
        const uid = getModel("fake", env.db)!.modelUid;
        recordLlmCall(
            { agent: "alfa", scope: "alfa", callId: newCallId(), callKind: "turn", modelUid: uid, usage: { promptTokens: 2_000_000, completionTokens: 500_000, totalTokens: 2_500_000, cachedTokens: 0 }, raw: {} },
            env.db,
        );
        const patch = (body: unknown, model = "fake") => env.api<LimitRow & { error?: string }>("PATCH", `/api/limits/${model}`, body);

        const priced = await patch({ priceInPerM: 3, priceOutPerM: 15 });
        assert.equal(priced.status, 200);
        assert.deepEqual([priced.json.priceInPerM, priced.json.priceOutPerM, priced.json.limit], [3, 15, null]);
        assert.equal(priced.json.today.cost, 2 * 3 + 0.5 * 15, "today is re-priced at once");

        const limited = await patch({ limit: { unit: "usd", value: 20 } });
        assert.deepEqual([limited.json.priceInPerM, limited.json.limit], [3, { unit: "usd", value: 20 }], "an absent price is kept");
        const tokens = await patch({ limit: { unit: "tokens", value: 1_000_000 } });
        assert.deepEqual(tokens.json.limit, { unit: "tokens", value: 1_000_000 });
        assert.deepEqual(getModel("fake", env.db)!.limit, { unit: "tokens", value: 1_000_000 });
        const cleared = await patch({ limit: null, priceOutPerM: 0 });
        assert.deepEqual([cleared.json.priceInPerM, cleared.json.priceOutPerM, cleared.json.limit], [3, 0, null]);

        for (const bad of [
            {},
            { temperature: 0.2 },
            { priceInPerM: -1 },
            { priceInPerM: "3" },
            { priceOutPerM: null },
            { limit: 5 },
            { limit: { unit: "calls", value: 5 } },
            { limit: { unit: "usd", value: 0 } },
            { limit: { unit: "tokens", value: 10.5 } },
            { limit: { unit: "usd", value: 5, per: "week" } },
        ]) {
            const r = await patch(bad);
            assert.equal(r.status, 400, JSON.stringify(bad));
            assert.equal(typeof r.json.error, "string");
        }
        assert.equal((await patch({ priceInPerM: 1 }, "nope")).status, 404);
        assert.deepEqual([getModel("fake", env.db)!.priceInPerM, getModel("fake", env.db)!.limit], [3, null], "a refused patch writes nothing");
    } finally {
        await env.stop();
    }
});

test("a rename keeps the model's prices, limit and today's tally: they follow its uid", async () => {
    const env = await boot();
    try {
        const uid = getModel("fake", env.db)!.modelUid;
        await env.api("PATCH", "/api/limits/fake", { priceInPerM: 1, limit: { unit: "tokens", value: 50 } });
        recordLlmCall(
            { agent: "alfa", scope: "alfa", callId: newCallId(), callKind: "turn", modelUid: uid, usage: { promptTokens: 30, completionTokens: 0, totalTokens: 30, cachedTokens: 0 }, raw: {} },
            env.db,
        );
        assert.equal((await env.api("PATCH", "/api/models/fake", { name: "renamed" })).status, 200);
        const [row] = (await env.api<LimitRow[]>("GET", "/api/limits")).json;
        assert.deepEqual([row?.uid, row?.name, row?.priceInPerM, row?.limit, row?.today.tokens], [uid, "renamed", 1, { unit: "tokens", value: 50 }, 30]);
    } finally {
        await env.stop();
    }
});

test("a saved price or limit reaches every open device as limits_changed; a refused one is silent", async () => {
    const env = await boot();
    try {
        const events = await env.stream("GET", "/api/events");
        await waitFor(() => events.lines.some((e) => e["type"] === "ready"), 4000, "the stream opened");
        const changed = (): Array<Record<string, unknown>> => events.lines.filter((e) => e["type"] === "limits_changed");

        assert.equal((await env.api("PATCH", "/api/limits/fake", { priceInPerM: -1 })).status, 400);
        assert.equal((await env.api("PATCH", "/api/limits/nope", { priceInPerM: 1 })).status, 404);
        assert.equal((await env.api("PATCH", "/api/limits/fake", { priceInPerM: 2 })).status, 200);
        assert.equal((await env.api("PATCH", "/api/limits/fake", { limit: { unit: "usd", value: 5 } })).status, 200);

        await waitFor(() => changed().length === 2, 4000, "two limits_changed lines");
        assert.deepEqual(changed(), [{ type: "limits_changed", model: "fake" }, { type: "limits_changed", model: "fake" }]);
        events.close();
    } finally {
        await env.stop();
    }
});

test("every cost reads the one formula: the day rollup, the call trace and the limit row all equal tokenCost", async () => {
    const env = await boot();
    try {
        const uid = getModel("fake", env.db)!.modelUid;
        await env.api("PATCH", "/api/limits/fake", { priceInPerM: 3, priceOutPerM: 15 });
        recordLlmCall(
            { agent: "alfa", scope: "alfa", callId: newCallId(), callKind: "turn", modelUid: uid, usage: { promptTokens: 1234, completionTokens: 567, totalTokens: 1801, cachedTokens: 0 }, raw: {} },
            env.db,
        );
        // no counts and no registry row: both read as 0
        recordLlmCall({ agent: "alfa", scope: "alfa", callId: newCallId(), callKind: "turn", modelUid: "gone", raw: {} }, env.db);
        const want = tokenCost(1234, 567, { priceInPerM: 3, priceOutPerM: 15 });
        assert.equal(want, (1234 * 3 + 567 * 15) / 1e6);

        assert.equal(env.db.spendByAgent(localDay()).get("alfa")?.cost, want);
        assert.deepEqual(env.db.listLlmCalls(10, "alfa").map((c) => c.cost).sort(), [0, want]);
        const [row] = (await env.api<LimitRow[]>("GET", "/api/limits")).json;
        assert.equal(row?.today.cost, want);
    } finally {
        await env.stop();
    }
});
