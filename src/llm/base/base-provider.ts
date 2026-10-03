/** The abstract provider contract: stream() is the primitive, complete() drains it. */
import type { Message, Tool } from "@mimi-os/protocol";

import type { ProviderResponse, ProviderStream } from "./base-types.ts";

export abstract class BaseProvider {
    abstract stream(messages: Message[], tools?: Tool[], signal?: AbortSignal): ProviderStream;

    get model(): string | undefined {
        return undefined;
    }

    async complete(
        messages: Message[],
        tools?: Tool[],
        signal?: AbortSignal,
    ): Promise<ProviderResponse> {
        const result: ProviderResponse = {
            thinking: "",
            text: "",
            toolCalls: [],
            finishReason: "error",
        };

        for await (const ev of this.stream(messages, tools, signal)) {
            switch (ev.type) {
                case "thinking":
                    result.thinking += ev.text;
                    break;
                case "text":
                    result.text += ev.text;
                    break;
                case "tool_calls":
                    result.toolCalls.push(...ev.calls);
                    break;
                case "done":
                    result.finishReason = ev.finishReason;
                    if (ev.usage) result.usage = ev.usage;
                    if (ev.meta !== undefined) result.meta = ev.meta;
                    if (ev.model !== undefined) result.model = ev.model;
                    break;
            }
        }

        return result;
    }
}
