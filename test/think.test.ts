import "./pq-home.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProviderEvent, ProviderStream } from "../src/llm/base/index.ts";
import { splitThinkTags } from "../src/llm/providers/shared/openai-sse.ts";

async function* feed(chunks: string[]): ProviderStream {
    for (const text of chunks) yield { type: "text", text };
    yield { type: "done", finishReason: "stop" };
}

async function drain(stream: ProviderStream): Promise<{ thinking: string; text: string; events: ProviderEvent[] }> {
    let thinking = "";
    let text = "";
    const events: ProviderEvent[] = [];
    for await (const ev of stream) {
        events.push(ev);
        if (ev.type === "thinking") thinking += ev.text;
        if (ev.type === "text") text += ev.text;
    }
    return { thinking, text, events };
}

test("a tag split across token boundaries still divides thinking from answer", async () => {
    const r = await drain(splitThinkTags(feed(["<th", "ink>pla", "n the reply</th", "ink>Hi ", "there"])));
    assert.equal(r.thinking, "plan the reply");
    assert.equal(r.text, "Hi there");
});

test("no opening tag at the start means nothing is ever reinterpreted", async () => {
    const r = await drain(splitThinkTags(feed(["Plain answer with a later <think>literal</think> tag"])));
    assert.equal(r.thinking, "");
    assert.equal(r.text, "Plain answer with a later <think>literal</think> tag");
});

test("a backtick-quoted close marker stays inside the thinking", async () => {
    const r = await drain(
        splitThinkTags(feed(["<think>the model emits `</think>` blocks. So plan.</think>Answer."])),
    );
    assert.equal(r.thinking, "the model emits `</think>` blocks. So plan.");
    assert.equal(r.text, "Answer.");
});

test("an unclosed block is all thinking, never answer text", async () => {
    const r = await drain(splitThinkTags(feed(["<think>never stopped thinking"])));
    assert.equal(r.thinking, "never stopped thinking");
    assert.equal(r.text, "");
});

test("leading whitespace before the opening tag is tolerated", async () => {
    const r = await drain(splitThinkTags(feed(["  \n<think>a</think>b"])));
    assert.equal(r.thinking, "a");
    assert.equal(r.text, "b");
});

test("the close marker as the very last bytes still closes at done", async () => {
    const r = await drain(splitThinkTags(feed(["<think>only thought</think>"])));
    assert.equal(r.thinking, "only thought");
    assert.equal(r.text, "");
});

test("provider-native thinking events and done fields pass through untouched", async () => {
    async function* mixed(): ProviderStream {
        yield { type: "thinking", text: "native" };
        yield { type: "text", text: "plain" };
        yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, cachedTokens: 0 } };
    }
    const r = await drain(splitThinkTags(mixed()));
    assert.equal(r.thinking, "native");
    assert.equal(r.text, "plain");
    const done = r.events.at(-1);
    assert.equal(done?.type, "done");
    assert.equal((done as { usage?: { totalTokens: number } }).usage?.totalTokens, 3);
});
