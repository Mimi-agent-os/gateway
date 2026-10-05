/** Gateway-only provider shapes not in @mimi-os/protocol: the streaming/collected response types. */
import type { CompletionInfo, StreamEvent, ToolCall } from "@mimi-os/protocol";

/** The wire `done`, plus the model the provider's own response named — accounting, not vocabulary. */
export type ProviderDone = { type: "done" } & CompletionInfo & { model?: string | undefined };

/** `accepted` (a 2xx head: the provider has the request) and `tool_args` (a tool call's name and
 *  argument text as it streams) are the gateway's own accounting, never forwarded. */
export type ProviderEvent =
    | Exclude<StreamEvent, { type: "done" }>
    | ProviderDone
    | { type: "accepted" }
    | { type: "tool_args"; text: string };

export type ProviderStream = AsyncGenerator<ProviderEvent>;

export interface ProviderResponse extends CompletionInfo {
    thinking: string;
    text: string;
    toolCalls: ToolCall[];
    model?: string;
    accepted?: boolean;
}

/** `true` only when a provider's param-info list names exactly the keys of its params interface. */
export type ParamsMatch<Params, Key extends PropertyKey> = [
    Exclude<keyof Params, Key> | Exclude<Key, keyof Params>,
] extends [never]
    ? true
    : false;
