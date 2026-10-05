/** The abstract provider contract: stream() is the primitive, complete() drains it. */
import type { Message, Tool } from "@mimi-os/protocol";

import type { ProviderResponse, ProviderStream } from "./base-types.ts";

/** A stop that landed before the request left (every earlier attempt was refused or answered
 *  429/5xx): no model holds the call, so nothing is spent. */
export class NotSentError extends Error {}

export abstract class BaseProvider {
    abstract stream(messages: Message[], tools?: Tool[], signal?: AbortSignal): ProviderStream;

    get model(): string | undefined {
        return undefined;
    }

    /** `result` fills as the stream runs, so a caller that holds it keeps the partial when this throws. */
    async complete(
        messages: Message[],
        tools?: Tool[],
        signal?: AbortSignal,
        result: ProviderResponse = { thinking: "", text: "", toolCalls: [], finishReason: "error" },
    ): Promise<ProviderResponse> {
        for await (const ev of this.stream(messages, tools, signal)) {
            switch (ev.type) {
                case "accepted":
                    result.accepted = true;
                    break;
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
