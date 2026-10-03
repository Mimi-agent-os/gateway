/** Config for VllmProvider (vLLM's OpenAI-compatible /v1/chat/completions). */
import type { ParamsMatch } from "../../base/index.ts";

export interface VllmParams {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    repetition_penalty?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    seed?: number;
    max_tokens?: number;
    stop?: string[];
    response_format?: Record<string, unknown>;
    reasoning_effort?: string;
    chat_template_kwargs?: Record<string, unknown>;
}

export interface VllmProviderConfig {
    /** Registry-normalised: scheme + authority + path, never a trailing slash (llm/models.ts). */
    endpointUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
    maxRetries?: number;
    retryDelayMs?: number;
    params?: VllmParams;
}

export const VLLM_PARAM_INFO = [
    { key: "temperature", type: "number", hint: "lower = more predictable" },
    { key: "top_p", type: "number", hint: "nucleus" },
    { key: "top_k", type: "number", hint: "0 = off" },
    { key: "min_p", type: "number", hint: "0 = off" },
    { key: "repetition_penalty", type: "number", hint: "1 = off" },
    { key: "presence_penalty", type: "number", hint: "default 0" },
    { key: "frequency_penalty", type: "number", hint: "default 0" },
    { key: "seed", type: "number", hint: "reproducibility" },
    { key: "max_tokens", type: "number", hint: "generation cap" },
    { key: "stop", type: "json", hint: "array of stop sequences" },
    { key: "response_format", type: "json", hint: '{ "type": "json_object" }' },
    { key: "reasoning_effort", type: "string", hint: 'e.g. "high" — model-dependent' },
    { key: "chat_template_kwargs", type: "json", hint: 'e.g. { "enable_thinking": true }' },
] as const;

true satisfies ParamsMatch<VllmParams, (typeof VLLM_PARAM_INFO)[number]["key"]>;
