/** Config for LlamaProvider (a wrapper over llama.cpp llama-server). */
import type { ParamsMatch } from "../../base/index.ts";

type ResponseFormat =
    | { type: "json_object" }
    | { type: "json_schema"; schema: Record<string, unknown> };

export interface LlamaParams {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    repeat_penalty?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    max_tokens?: number;
    stop?: string[];
    response_format?: ResponseFormat;
    reasoning_format?: string;
    reasoning_budget?: number;
    thinking_forced_open?: boolean;
    chat_template_kwargs?: Record<string, unknown>;
}

export interface LlamaProviderConfig {
    /** Registry-normalised: scheme + authority + path, never a trailing slash (llm/models.ts). */
    endpointUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
    maxRetries?: number;
    retryDelayMs?: number;
    params?: LlamaParams;
}

export const LLAMA_PARAM_INFO = [
    { key: "temperature", type: "number", hint: "0.8 default; lower = more predictable" },
    { key: "top_p", type: "number", hint: "nucleus, default 0.95" },
    { key: "top_k", type: "number", hint: "default 40; 0 = off" },
    { key: "min_p", type: "number", hint: "default 0.05; 0 = off" },
    { key: "repeat_penalty", type: "number", hint: "default 1.1" },
    { key: "presence_penalty", type: "number", hint: "large values hurt tool calling" },
    { key: "frequency_penalty", type: "number", hint: "default 0" },
    { key: "max_tokens", type: "number", hint: "generation cap; -1 = no limit" },
    { key: "stop", type: "json", hint: "array of stop sequences" },
    { key: "response_format", type: "json", hint: "guaranteed JSON / json_schema" },
    { key: "reasoning_format", type: "string", hint: "e.g. deepseek" },
    { key: "reasoning_budget", type: "number", hint: "-1 = no limit, 0 = off" },
    { key: "thinking_forced_open", type: "boolean", hint: "model-specific" },
    { key: "chat_template_kwargs", type: "json", hint: 'e.g. { "enable_thinking": true }' },
] as const;

true satisfies ParamsMatch<LlamaParams, (typeof LLAMA_PARAM_INFO)[number]["key"]>;
