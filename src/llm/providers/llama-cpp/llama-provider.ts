/** LlamaProvider: a concrete BaseProvider over llama.cpp's OpenAI-compatible /v1/chat/completions. */
import type { Message, Tool } from "@mimi-os/protocol";

import { BaseProvider, type ProviderStream } from "../../base/index.ts";
import { postSSE, readChatStream, toWireMessages, type WireChunk } from "../shared/openai-sse.ts";
import type { LlamaProviderConfig } from "./llama-config.ts";
import type { LlamaMeta } from "./llama-types.ts";

/** llama.cpp hangs its own per-token timings off the OpenAI-compatible chunk. */
interface RawChunk extends WireChunk {
    timings?: {
        prompt_n?: number;
        prompt_ms?: number;
        prompt_per_second?: number;
        predicted_n?: number;
        predicted_ms?: number;
        predicted_per_second?: number;
        cache_n?: number;
    };
}

export class LlamaProvider extends BaseProvider {
    private readonly config: LlamaProviderConfig;

    constructor(config: LlamaProviderConfig) {
        super();
        this.config = config;
    }

    override get model(): string | undefined {
        return this.config.model;
    }

    async *stream(messages: Message[], tools?: Tool[], signal?: AbortSignal): ProviderStream {
        const response = await postSSE({
            url: `${this.config.endpointUrl}/v1/chat/completions`,
            headers: {
                "Content-Type": "application/json",
                ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
            },
            body: {
                parse_tool_calls: true,
                timings_per_token: true,
                ...this.config.params,
                model: this.config.model,
                messages: toWireMessages(messages),
                ...(tools && tools.length ? { tools } : {}),
                stream: true,
                stream_options: { include_usage: true },
            },
            label: "llama.cpp",
            timeoutMs: this.config.timeoutMs,
            maxRetries: this.config.maxRetries,
            retryDelayMs: this.config.retryDelayMs,
            signal,
        });

        yield* readChatStream<RawChunk>(
            response,
            "llama.cpp",
            (delta) => delta.reasoning_content,
            ({ timings: t }) =>
                t && {
                    timings: {
                        promptN: t.prompt_n ?? 0,
                        promptMs: t.prompt_ms ?? 0,
                        promptPerSecond: t.prompt_per_second ?? 0,
                        predictedN: t.predicted_n ?? 0,
                        predictedMs: t.predicted_ms ?? 0,
                        predictedPerSecond: t.predicted_per_second ?? 0,
                        cacheN: t.cache_n ?? 0,
                    },
                } satisfies LlamaMeta,
        );
    }
}
