import "./pq-home.ts";

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

import type { StreamEvent } from "@mimi-os/protocol";
import { checkEnv, secret, setEnv, unsetEnv } from "../src/store/env.ts";
import { gatewayDb } from "../src/store/db.ts";
import * as models from "../src/llm/models.ts";
import type { ProviderDone, ProviderEvent } from "../src/llm/base/base-types.ts";
import { LlamaProvider } from "../src/llm/providers/llama-cpp/index.ts";
import { OpenRouterProvider } from "../src/llm/providers/openrouter/index.ts";
import { parseSSE, postSSE, toWireMessages } from "../src/llm/providers/shared/openai-sse.ts";
import type { WireChunk } from "../src/llm/providers/shared/openai-sse.ts";
import { enqueueCall, QueueFullError } from "../src/llm/queue.ts";

checkEnv();

const tmpDbRoot = mkdtempSync(join(tmpdir(), "mimi-gw-db-"));
const dbPath = (name: string): string => join(tmpDbRoot, `${name}.db`);

// ── SSE normalization: llama.cpp and openrouter dialects → identical StreamEvents ──────────

function sse(lines: string[]): string {
    return lines.map((l) => `data: ${l}`).join("\n\n") + "\n\ndata: [DONE]\n\n";
}

const LLAMA_SSE = sse([
    JSON.stringify({ choices: [{ delta: { reasoning_content: "Thinking" }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { content: "Hello " }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { content: "world" }, finish_reason: null }] }),
    JSON.stringify({
        choices: [
            {
                delta: {
                    tool_calls: [{ index: 0, id: "call_1", function: { name: "get_time", arguments: '{"a":' } }],
                },
                finish_reason: null,
            },
        ],
    }),
    JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: null }],
    }),
    JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } },
        timings: {
            prompt_n: 10,
            prompt_ms: 100,
            prompt_per_second: 100,
            predicted_n: 5,
            predicted_ms: 50,
            predicted_per_second: 100,
            cache_n: 2,
        },
    }),
]);

const OPENROUTER_SSE = sse([
    JSON.stringify({ choices: [{ delta: { reasoning: "Thinking" }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { content: "Hello " }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { content: "world" }, finish_reason: null }] }),
    JSON.stringify({
        choices: [
            {
                delta: {
                    tool_calls: [{ index: 0, id: "call_1", function: { name: "get_time", arguments: '{"a":' } }],
                },
                finish_reason: null,
            },
        ],
    }),
    JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: null }],
    }),
    JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } },
    }),
]);

async function collect(gen: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
    const out: ProviderEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
}

const doneOf = (events: ProviderEvent[]): ProviderDone | undefined => {
    const last = events.at(-1);
    return last && last.type === "done" ? last : undefined;
};

/** Drops the always-present provider extras (llama-only timings, the served model) — both ride `done` as
 *  plain keys whose value is undefined when unreported, and each has its own test below. */
function withoutExtras(events: ProviderEvent[]): StreamEvent[] {
    return events.map((e) => {
        if (e.type !== "done") return e;
        const { meta: _meta, model: _model, ...rest } = e;
        return rest as StreamEvent;
    });
}

async function withStubbedFetch<T>(body: string, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    try {
        return await run();
    } finally {
        globalThis.fetch = original;
    }
}

test("llama.cpp and openrouter SSE dialects normalize to identical StreamEvent sequences", async () => {
    const llamaProvider = new LlamaProvider({ endpointUrl: "http://x", model: "m" });
    const llamaEvents = await withStubbedFetch(LLAMA_SSE, () =>
        collect(llamaProvider.stream([{ role: "user", content: "hi" }])),
    );

    const orProvider = new OpenRouterProvider({ endpointUrl: "http://x", model: "m", apiKey: "k" });
    const orEvents = await withStubbedFetch(OPENROUTER_SSE, () =>
        collect(orProvider.stream([{ role: "user", content: "hi" }])),
    );

    assert.deepEqual(withoutExtras(llamaEvents), withoutExtras(orEvents));

    // shape sanity + tool-call argument fragments assembled across two delta events
    assert.deepEqual(withoutExtras(llamaEvents), [
        { type: "thinking", text: "Thinking" },
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
        { type: "tool_calls", calls: [{ id: "call_1", name: "get_time", arguments: '{"a":1}' }] },
        {
            type: "done",
            finishReason: "tool_calls",
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 2 },
        },
    ]);

    // llama's own dialect extra: timings land in `meta`, openrouter never sets it
    const llamaDone = llamaEvents.at(-1);
    const orDone = orEvents.at(-1);
    assert.ok(llamaDone && llamaDone.type === "done" && llamaDone.meta !== undefined);
    assert.ok(orDone && orDone.type === "done" && orDone.meta === undefined);
});

test("the model an endpoint names in its own chunks rides `done`; a silent dialect names none", async () => {
    const named = sse([
        JSON.stringify({ model: "vendor/served-7b", choices: [{ delta: { content: "hi" }, finish_reason: null }] }),
        JSON.stringify({ model: "vendor/served-7b", choices: [{ delta: {}, finish_reason: "stop" }] }),
    ]);
    const llama = new LlamaProvider({ endpointUrl: "http://x", model: "asked-for" });
    const or = new OpenRouterProvider({ endpointUrl: "http://x", model: "asked-for", apiKey: "k" });

    const llamaDone = doneOf(
        await withStubbedFetch(named, () => collect(llama.stream([{ role: "user", content: "hi" }]))),
    );
    const orDone = doneOf(
        await withStubbedFetch(named, () => collect(or.stream([{ role: "user", content: "hi" }]))),
    );
    assert.equal(llamaDone?.model, "vendor/served-7b");
    assert.equal(orDone?.model, "vendor/served-7b");
    // the configured id is what we ASKED for — the reported one is whatever answered
    assert.equal(llama.model, "asked-for");

    const silent = doneOf(
        await withStubbedFetch(LLAMA_SSE, () => collect(llama.stream([{ role: "user", content: "hi" }]))),
    );
    assert.equal(silent?.model, undefined, "no model on the wire means no reported model");

    // complete() carries it through to the collected response the same way
    const drained = await withStubbedFetch(named, () => llama.complete([{ role: "user", content: "hi" }]));
    assert.equal(drained.model, "vendor/served-7b");
});

test("a reported reasoning_tokens rides usage on both dialects; silence reports none", async () => {
    const usageSSE = (details?: Record<string, number>): string =>
        sse([
            JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: null }] }),
            JSON.stringify({
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 40,
                    total_tokens: 50,
                    // JSON.stringify drops an undefined value: silence sends no key at all
                    completion_tokens_details: details,
                },
            }),
        ]);

    const providers = [
        new LlamaProvider({ endpointUrl: "http://x", model: "m" }),
        new OpenRouterProvider({ endpointUrl: "http://x", model: "m", apiKey: "k" }),
    ];
    for (const provider of providers) {
        const ask = (body: string): Promise<ProviderEvent[]> =>
            withStubbedFetch(body, () => collect(provider.stream([{ role: "user", content: "hi" }])));

        const reported = doneOf(await ask(usageSSE({ reasoning_tokens: 32 })))?.usage;
        assert.equal(reported?.reasoningTokens, 32);
        // a subset of the completion count: neither it nor the total grows by it
        assert.equal(reported?.completionTokens, 40);
        assert.equal(reported?.totalTokens, 50);

        const zero = doneOf(await ask(usageSSE({ reasoning_tokens: 0 })))?.usage;
        assert.equal(zero?.reasoningTokens, 0, "an explicit zero is a real report");

        const silent = doneOf(await ask(usageSSE()))?.usage;
        assert.equal(silent?.reasoningTokens, undefined);
        assert.equal("reasoningTokens" in (silent as object), false, "unreported stays absent");
    }
});

test("parseSSE reassembles a data: line split across network chunk boundaries", async () => {
    const full = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const mid = Math.floor(full.length / 2);
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(full.slice(0, mid)));
            controller.enqueue(new TextEncoder().encode(full.slice(mid)));
            controller.close();
        },
    });
    const chunks: WireChunk[] = [];
    for await (const c of parseSSE(new Response(stream), "test")) chunks.push(c);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.choices?.[0]?.delta?.content, "hi");
});

test("parseSSE stops at [DONE] and never yields anything after it", async () => {
    const text =
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
        "data: [DONE]\n\n" +
        'data: {"choices":[{"delta":{"content":"never"}}]}\n\n';
    const chunks: WireChunk[] = [];
    for await (const c of parseSSE(new Response(text), "test")) chunks.push(c);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.choices?.[0]?.delta?.content, "a");
});

test("parseSSE keeps a final data event when the response ends without a newline", async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"tail"}}]}');
    const chunks: WireChunk[] = [];
    for await (const chunk of parseSSE(response, "test")) chunks.push(chunk);
    assert.deepEqual(chunks, [{ choices: [{ delta: { content: "tail" } }] }]);
});

test("a tool-call delta whose index is not a real slot is dropped, not turned into one", async () => {
    const hostile = sse([
        JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "ok", arguments: "{}" } }] } }],
        }),
        // an index used as an array slot would size the accumulator to it and freeze the event loop
        JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 1e9, id: "flood", function: { name: "x", arguments: "{}" } }] } }],
        }),
        JSON.stringify({
            choices: [
                {
                    delta: {
                        tool_calls: [
                            { index: -1, id: "negative" },
                            { index: 1.5, id: "fractional" },
                            { index: "0" as unknown as number, id: "stringy" },
                        ],
                    },
                },
            ],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    const provider = new LlamaProvider({ endpointUrl: "http://x", model: "m" });
    const events = await withStubbedFetch(hostile, () =>
        collect(provider.stream([{ role: "user", content: "hi" }])),
    );
    assert.deepEqual(
        events.find((e) => e.type === "tool_calls"),
        { type: "tool_calls", calls: [{ id: "call_1", name: "ok", arguments: "{}" }] },
    );
    assert.equal(doneOf(events)?.finishReason, "tool_calls");
});

test("a mid-stream error chunk fails the call instead of ending it as a clean stop", async () => {
    const body = sse([
        JSON.stringify({ choices: [{ delta: { content: "half an ans" }, finish_reason: null }] }),
        JSON.stringify({
            error: { code: 502, message: "Provider disconnected" },
            choices: [{ delta: { content: "" }, finish_reason: "error" }],
        }),
    ]);
    const provider = new OpenRouterProvider({ endpointUrl: "http://x", model: "m", apiKey: "k" });
    await assert.rejects(
        withStubbedFetch(body, () => provider.complete([{ role: "user", content: "hi" }])),
        /Provider disconnected/,
    );
});

test("the wire's error/abort finish is an error; an unknown finish still reads as stop", async () => {
    const finishOf = async (reason: string): Promise<string | undefined> => {
        const body = sse([JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: reason }] })]);
        const provider = new LlamaProvider({ endpointUrl: "http://x", model: "m" });
        return (await withStubbedFetch(body, () => provider.complete([{ role: "user", content: "hi" }]))).finishReason;
    };
    assert.equal(await finishOf("error"), "error");
    assert.equal(await finishOf("abort"), "error");
    assert.equal(await finishOf("length"), "length");
    assert.equal(await finishOf("eos"), "stop");
    assert.equal(await finishOf("aborted"), "stop", "the gateway's own user-stop state is never spoofed by the wire");
});

// lets the pending fetch/read register while node:test's fake setTimeout holds every deadline
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

test("an endpoint that takes the request and never answers fails on the default request timeout", async () => {
    const provider = new LlamaProvider({ endpointUrl: "http://x", model: "m" });
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch;
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const call = collect(provider.stream([{ role: "user", content: "hi" }]));
        await settle();
        mock.timers.tick(120_000);
        await assert.rejects(call, /llama\.cpp: no response headers in 120000ms/);
    } finally {
        mock.timers.reset();
        globalThis.fetch = original;
    }
});

test("an endpoint that answers an error status and never ends its body fails on the request timeout", async (t) => {
    const original = globalThis.fetch;
    // 500 with a body only the request's own abort can cut off: what a wedged endpoint does, and
    // what must not hold this endpoint's one call slot for the life of the process
    globalThis.fetch = ((_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
            },
        });
        return Promise.resolve(new Response(body, { status: 500 }));
    }) as unknown as typeof fetch;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const call = postSSE({ url: "http://x", headers: {}, body: {}, label: "test", maxRetries: 0 });
        await settle();
        t.mock.timers.tick(120_000);
        await assert.rejects(call, /test 500/);
    } finally {
        t.mock.timers.reset();
        globalThis.fetch = original;
    }
});

test("postSSE names why an endpoint could not be reached, not only that fetch failed", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    await new Promise((done) => server.close(done));
    const call = postSSE({ url: `http://127.0.0.1:${port}/v1/chat/completions`, headers: {}, body: {}, label: "vllm", maxRetries: 0 });
    await assert.rejects(call, new RegExp(`^Error: vllm: fetch failed \\(connect ECONNREFUSED 127\\.0\\.0\\.1:${port}\\)$`));
});

test("parseSSE gives up on a body that stops sending, keeping what already arrived", async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            body = controller;
        },
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const chunks: WireChunk[] = [];
        const drain = (async () => {
            for await (const c of parseSSE(new Response(stream), "test")) chunks.push(c);
        })();
        body.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        await settle();
        mock.timers.tick(120_000);
        await assert.rejects(drain, /test: no data for 120000ms/);
        assert.equal(chunks.length, 1);
    } finally {
        mock.timers.reset();
    }
});

test("a synchronous queued failure does not wedge the endpoint for the next call", async () => {
    const endpoint = `queue-test-${Date.now()}-${Math.random()}`;
    await assert.rejects(enqueueCall(endpoint, () => {
        throw new Error("broken job");
    }), /broken job/);
    assert.equal(await enqueueCall(endpoint, async () => "next"), "next");
});

test("an aborted queued call is removed without releasing the running endpoint slot", async () => {
    const endpoint = `queue-abort-${Date.now()}-${Math.random()}`;
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const running = enqueueCall(endpoint, async () => {
        started.resolve();
        await release.promise;
        return "first";
    });
    await started.promise;

    const abort = new AbortController();
    let ran = false;
    const cancelled = enqueueCall(
        endpoint,
        async () => {
            ran = true;
            return "cancelled";
        },
        "interactive",
        abort.signal,
    );
    abort.abort(new Error("turn stopped"));
    await assert.rejects(cancelled, /turn stopped/);

    let nextRan = false;
    const next = enqueueCall(endpoint, async () => {
        nextRan = true;
        return "next";
    });
    await Promise.resolve();
    assert.equal(nextRan, false, "the running call keeps the endpoint slot");
    release.resolve();
    assert.equal(await running, "first");
    assert.equal(ran, false);
    assert.equal(await next, "next");
});

test("a full endpoint queue refuses new background calls instead of pinning their payloads", async () => {
    const endpoint = `http://queue-cap-${Date.now()}`;
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const running = enqueueCall(endpoint, async () => {
        started.resolve();
        await release.promise;
        return "first";
    });
    await started.promise;

    const flood = Array.from({ length: 500 }, () => enqueueCall(endpoint, async () => "queued"));
    // the interactive lane keeps its own room: an agent's flood never refuses an owner turn
    const interactive = enqueueCall(endpoint, async () => "interactive", "interactive");
    release.resolve();

    const settled = await Promise.allSettled(flood);
    const refused = settled.filter((r) => r.status === "rejected");
    assert.ok(refused.length > 0, "the queue is bounded");
    assert.ok(settled.length - refused.length < 500, "the calls past the cap never queued");
    assert.ok(refused.every((r) => r.reason instanceof QueueFullError));
    assert.equal(await interactive, "interactive");
    assert.equal(await running, "first");
});

// ── toWireMessages: images become OpenAI multipart content ─────────────────────────────────

test("toWireMessages emits multipart content only for messages that carry images", () => {
    const wire = toWireMessages([
        { role: "user", content: "what is this?", images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"] },
        { role: "user", content: "", images: ["data:image/png;base64,CCC"] },
        { role: "user", content: "plain text only" },
        { role: "assistant", content: "sure" },
    ]);
    assert.deepEqual(wire[0], {
        role: "user",
        content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
            { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
        ],
    });
    // no text part when content is empty
    assert.deepEqual(wire[1], {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,CCC" } }],
    });
    // a message without images stays a plain string content, unchanged
    assert.deepEqual(wire[2], { role: "user", content: "plain text only" });
    assert.deepEqual(wire[3], { role: "assistant", content: "sure" });
});

// ── parseEntry validation (through addModel — parseEntry itself stays private) ─────────────

test("addModel rejects an unknown provider", () => {
    const db = gatewayDb(dbPath("validate-provider"));
    assert.throws(
        () => models.addModel({ name: "x", provider: "bogus", endpoint: "http://h", contextTokens: 1000 }, db),
        /unknown provider/,
    );
});

test("addModel rejects params the adapter does not support", () => {
    const db = gatewayDb(dbPath("validate-params"));
    assert.throws(
        () =>
            models.addModel(
                {
                    name: "x",
                    provider: "llamacpp",
                    endpoint: "http://h",
                    contextTokens: 1000,
                    params: { bogus_param: 1 },
                },
                db,
            ),
        /not supported/,
    );
});

test("addModel requires modelId for providers that need it", () => {
    const db = gatewayDb(dbPath("validate-modelid"));
    assert.throws(
        () => models.addModel({ name: "x", provider: "openrouter", contextTokens: 1000 }, db),
        /needs "modelId"/,
    );
});

test("a model endpoint must be an absolute http(s) URL; a keyed provider needs https off loopback", () => {
    const db = gatewayDb(dbPath("validate-endpoint"));
    const or = { provider: "openrouter", modelId: "v/m", contextTokens: 1000 };
    assert.throws(
        () => models.addModel({ ...or, name: "relative", endpoint: "openrouter.ai/api" }, db),
        /absolute http\(s\) URL/,
    );
    assert.throws(
        () => models.addModel({ ...or, name: "ftp", endpoint: "ftp://host/api" }, db),
        /absolute http\(s\) URL/,
    );
    // the API key rides every request as a bearer token: plain http would put it on the wire
    assert.throws(
        () => models.addModel({ ...or, name: "lan", endpoint: "http://proxy.example:8080" }, db),
        /needs an https endpoint/,
    );
    models.addModel({ ...or, name: "tls", endpoint: "https://proxy.example:8080" }, db);
    models.addModel({ ...or, name: "loopback", endpoint: "http://127.0.0.1:8080" }, db);
    models.addModel({ ...or, name: "adapter-default" }, db);
    models.addModel({ name: "local", provider: "llamacpp", endpoint: "http://box:8000", contextTokens: 1000 }, db);
    assert.deepEqual(
        models.listModels(db).map((m) => m.name).sort(),
        ["adapter-default", "local", "loopback", "tls"],
    );
});

test("endpoint spellings that name one server are stored as one string", () => {
    const db = gatewayDb(dbPath("normalize-endpoint"));
    const base = { provider: "llamacpp", contextTokens: 1000 };
    models.addModel({ ...base, name: "plain", endpoint: "http://box:8000" }, db);
    models.addModel({ ...base, name: "slashed", endpoint: "HTTP://BOX:8000///" }, db);
    // one string means one per-endpoint queue: the single-slot server never sees two calls
    assert.equal(models.getModel("plain", db)?.endpointUrl, "http://box:8000");
    assert.equal(models.getModel("slashed", db)?.endpointUrl, "http://box:8000");

    // every adapter appends /v1/chat/completions, so the pasted OpenAI-style base loses its /v1
    models.patchModel("plain", { endpoint: "http://box:8000/v1/" }, db);
    assert.equal(models.getModel("plain", db)?.endpointUrl, "http://box:8000");
    models.patchModel("plain", { endpoint: "http://box:8000/proxy/v1" }, db);
    assert.equal(models.getModel("plain", db)?.endpointUrl, "http://box:8000/proxy");
    models.patchModel("plain", { endpoint: "http://box:8000/v1beta" }, db);
    assert.equal(models.getModel("plain", db)?.endpointUrl, "http://box:8000/v1beta");
    models.addModel({ name: "routed", provider: "openrouter", modelId: "vendor/x", endpoint: "https://openrouter.ai/api/v1", contextTokens: 1000 }, db);
    assert.equal(models.getModel("routed", db)?.endpointUrl, "https://openrouter.ai/api");
});

// ── models CRUD + rename + default over a temp db file ─────────────────────────────────────

test("models CRUD + rename + default", () => {
    const db = gatewayDb(dbPath("crud"));
    models.addModel({ name: "alpha", provider: "llamacpp", endpoint: "http://h1", contextTokens: 4096 }, db);
    models.addModel(
        { name: "beta", provider: "openrouter", modelId: "vendor/beta", contextTokens: 8192 },
        db,
    );

    assert.equal(models.listModels(db).length, 2);
    assert.equal(models.getDefaultModel(db).name, "alpha"); // first inserted, no explicit default yet

    models.setDefaultModel("beta", db);
    assert.equal(models.getDefaultModel(db).name, "beta");
    assert.equal(models.getModel("alpha", db)?.isDefault, false);
    assert.equal(models.getModel("beta", db)?.isDefault, true);

    models.patchModel("alpha", { contextTokens: 16384 }, db);
    assert.equal(models.getModel("alpha", db)?.contextTokens, 16384);

    models.patchModel("alpha", { name: "gamma" }, db);
    assert.equal(models.getModel("alpha", db), null);
    assert.equal(models.getModel("gamma", db)?.contextTokens, 16384);
    assert.equal(models.getModel("gamma", db)?.provider, "llamacpp");

    assert.throws(() => models.removeModel("beta", db), /is the default/);
    models.setDefaultModel("gamma", db);
    models.removeModel("beta", db);
    assert.equal(models.listModels(db).length, 1);
    assert.throws(() => models.removeModel("gamma", db), /refusing to remove the last model/);
});

test("a rename moves the default pointer and the per-model key env, params intact", () => {
    const db = gatewayDb(dbPath("rename-follow"));
    models.addModel(
        { name: "orig", provider: "llamacpp", endpoint: "http://h", contextTokens: 4096, params: { temperature: 0.5 } },
        db,
    );
    models.setDefaultModel("orig", db);
    setEnv(models.apiKeyEnv("orig"), "secret-value");

    models.patchModel("orig", { name: "renamed" }, db);

    assert.equal(models.getDefaultModel(db).name, "renamed");
    assert.equal(models.getModel("renamed", db)?.params["temperature"], 0.5);
    assert.equal(unsetEnv(models.apiKeyEnv("orig")), false); // moved away, nothing left to unset
    assert.equal(models.describeModels(db).find((m) => m.name === "renamed")?.keySet, true);
    unsetEnv(models.apiKeyEnv("renamed"));
});

test("a rename never moves a key env another model or its provider answers to", () => {
    const db = gatewayDb(dbPath("rename-shared-key"));
    const or = { provider: "openrouter", contextTokens: 1000 };
    models.addModel({ ...or, name: "openrouter", modelId: "v/a" }, db);
    models.addModel({ ...or, name: "sonnet", modelId: "v/b" }, db);
    setEnv("OPENROUTER_API_KEY", "sk-shared");

    models.patchModel("openrouter", { name: "haiku" }, db);

    assert.equal(secret("OPENROUTER_API_KEY"), "sk-shared", "the provider key is not this row's own");
    assert.equal(secret("HAIKU_API_KEY"), undefined);
    assert.equal(models.describeModels(db).find((m) => m.name === "sonnet")?.keySet, true);

    // apiKeyEnv is lossy: "mover" -> "gpt.4o" would land on the env "gpt-4o" already uses
    models.addModel({ ...or, name: "gpt-4o", modelId: "v/c" }, db);
    models.addModel({ ...or, name: "mover", modelId: "v/d" }, db);
    setEnv(models.apiKeyEnv("gpt-4o"), "sk-4o");
    setEnv(models.apiKeyEnv("mover"), "sk-mover");

    models.patchModel("mover", { name: "gpt.4o" }, db);

    assert.equal(secret("GPT_4O_API_KEY"), "sk-4o");
    assert.equal(secret("MOVER_API_KEY"), "sk-mover");
    unsetEnv("OPENROUTER_API_KEY");
    unsetEnv("GPT_4O_API_KEY");
    unsetEnv("MOVER_API_KEY");
});

test("a rename whose key write fails keeps the key under the old name", () => {
    const db = gatewayDb(dbPath("rename-key-write-fails"));
    models.addModel({ name: "keeper", provider: "llamacpp", endpoint: "http://h", contextTokens: 1000 }, db);
    setEnv(models.apiKeyEnv("keeper"), "keep-me");

    const env = join(process.env["MIMI_HOME"] as string, ".env");
    const saved = readFileSync(env, "utf8");
    rmSync(env);
    mkdirSync(env); // every write to mimi/.env now fails
    try {
        models.patchModel("keeper", { name: "kept" }, db);
    } finally {
        rmSync(env, { recursive: true });
        writeFileSync(env, saved, { mode: 0o600 });
    }

    assert.equal(secret(models.apiKeyEnv("keeper")), "keep-me");
    assert.equal(secret(models.apiKeyEnv("kept")), undefined);
    assert.equal(models.getModel("kept", db)?.name, "kept");
    unsetEnv(models.apiKeyEnv("keeper"));
});

// ── keyEnv/keySet derivation ─────────────────────────────────────────────────────────────

test("keyEnv/keySet: per-model override beats provider key; unset key -> keySet false", () => {
    const db = gatewayDb(dbPath("keys"));
    models.addModel({ name: "orkey", provider: "openrouter", modelId: "v/m", contextTokens: 1000 }, db);

    let info = models.describeModels(db).find((m) => m.name === "orkey");
    assert.equal(info?.keySet, false);

    setEnv("OPENROUTER_API_KEY", "provider-key");
    info = models.describeModels(db).find((m) => m.name === "orkey");
    assert.equal(info?.keyEnv, "OPENROUTER_API_KEY");
    assert.equal(info?.keySet, true);

    setEnv(models.apiKeyEnv("orkey"), "per-model-key");
    info = models.describeModels(db).find((m) => m.name === "orkey");
    assert.equal(info?.keyEnv, models.apiKeyEnv("orkey"));
    assert.equal(info?.keySet, true);

    unsetEnv(models.apiKeyEnv("orkey"));
    unsetEnv("OPENROUTER_API_KEY");
    info = models.describeModels(db).find((m) => m.name === "orkey");
    assert.equal(info?.keySet, false);
});
