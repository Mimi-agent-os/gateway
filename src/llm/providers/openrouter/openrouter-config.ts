/** Config for OpenRouterProvider (https://openrouter.ai). */
import type { ParamsMatch } from "../../base/index.ts";

export interface OpenRouterParams {
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
    response_format?: { type: "json_object" } | Record<string, unknown>;
    reasoning?: Record<string, unknown>;
    provider?: Record<string, unknown>;
    models?: string[];
    transforms?: string[];
}

export interface OpenRouterProviderConfig {
    /** Registry-normalised: scheme + authority + path, never a trailing slash (llm/models.ts). */
    endpointUrl: string;
    model: string;
    apiKey: string;
    timeoutMs?: number;
    maxRetries?: number;
    retryDelayMs?: number;
    params?: OpenRouterParams;
}

export const OPENROUTER_PARAM_INFO = [
    { key: "temperature", type: "number", hint: "depends on the model" },
    { key: "top_p", type: "number", hint: "nucleus" },
    { key: "top_k", type: "number", hint: "0 = off" },
    { key: "min_p", type: "number", hint: "0 = off" },
    { key: "repetition_penalty", type: "number", hint: "1 = off" },
    { key: "presence_penalty", type: "number", hint: "default 0" },
    { key: "frequency_penalty", type: "number", hint: "default 0" },
    { key: "seed", type: "number", hint: "reproducibility, where supported" },
    { key: "max_tokens", type: "number", hint: "generation cap" },
    { key: "stop", type: "json", hint: "array of stop sequences" },
    { key: "response_format", type: "json", hint: '{ "type": "json_object" }' },
    { key: "reasoning", type: "json", hint: '{ "effort": "high" } or { "max_tokens": 2000 }' },
    { key: "provider", type: "json", hint: "routing: order, allow_fallbacks…" },
    { key: "models", type: "json", hint: "fallback models in order" },
    { key: "transforms", type: "json", hint: 'e.g. ["middle-out"]' },
] as const;

true satisfies ParamsMatch<OpenRouterParams, (typeof OPENROUTER_PARAM_INFO)[number]["key"]>;
