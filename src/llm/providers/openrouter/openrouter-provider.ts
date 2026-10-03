/** OpenRouterProvider — wire plumbing shared with llama.cpp via ../shared/openai-sse.ts. */
import type { Message, Tool } from "@mimi-os/protocol";

import { BaseProvider, type ProviderStream } from "../../base/index.ts";
import { postSSE, readChatStream, toWireMessages } from "../shared/openai-sse.ts";
import type { OpenRouterProviderConfig } from "./openrouter-config.ts";

export class OpenRouterProvider extends BaseProvider {
    private readonly config: OpenRouterProviderConfig;

    constructor(config: OpenRouterProviderConfig) {
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
                Authorization: `Bearer ${this.config.apiKey}`,
                "X-Title": "mimi-os",
            },
            body: {
                ...this.config.params,
                model: this.config.model,
                messages: toWireMessages(messages),
                ...(tools && tools.length ? { tools } : {}),
                stream: true,
                usage: { include: true },
            },
            label: "openrouter",
            timeoutMs: this.config.timeoutMs,
            maxRetries: this.config.maxRetries,
            retryDelayMs: this.config.retryDelayMs,
            signal,
        });

        yield* readChatStream(
            response,
            "openrouter",
            (delta) => delta.reasoning ?? delta.reasoning_content,
        );
    }
}
