/** VllmProvider — vLLM's OpenAI-compatible /v1/chat/completions. Kept apart from llama.cpp on
 *  purpose: vLLM streams reasoning in `reasoning` (llama.cpp uses `reasoning_content`) and takes
 *  none of llama.cpp's own body fields. The shared SSE plumbing lives in ../shared/openai-sse.ts. */
import type { Message, Tool } from "@mimi-os/protocol";

import { BaseProvider, type ProviderStream } from "../../base/index.ts";
import { postSSE, readChatStream, toWireMessages } from "../shared/openai-sse.ts";
import type { VllmProviderConfig } from "./vllm-config.ts";

export class VllmProvider extends BaseProvider {
    private readonly config: VllmProviderConfig;

    constructor(config: VllmProviderConfig) {
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
                ...this.config.params,
                model: this.config.model,
                messages: toWireMessages(messages),
                ...(tools && tools.length ? { tools } : {}),
                stream: true,
                stream_options: { include_usage: true },
            },
            label: "vllm",
            timeoutMs: this.config.timeoutMs,
            maxRetries: this.config.maxRetries,
            retryDelayMs: this.config.retryDelayMs,
            signal,
        });

        // vLLM's field is `reasoning`; `reasoning_content` stays as a fallback for other builds.
        yield* readChatStream(response, "vllm", (delta) => delta.reasoning ?? delta.reasoning_content);
    }
}
