/** The OpenAI-compatible SSE wire dialect, shared by llama.cpp and OpenRouter. */
import { isImageDataUri } from "@mimi-os/protocol";
import type { FinishReason, Message, ToolCall, Usage } from "@mimi-os/protocol";

import type { ProviderStream } from "../../base/index.ts";

interface WireDelta {
    content?: string;
    reasoning_content?: string; // llama.cpp's split-out thinking stream
    reasoning?: string; // OpenRouter's normalized thinking stream
    tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
    }>;
}

export interface WireChunk {
    /** What the endpoint says it actually served — not every dialect sends it. */
    model?: string;
    /** A mid-stream failure (OpenRouter sends it after the 200 head): what came before is not an answer. */
    error?: { message?: string; code?: number | string } | string;
    choices?: Array<{
        delta?: WireDelta;
        finish_reason?: string | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
    };
}

interface PostSSEOptions {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    label: string;
    timeoutMs?: number | undefined;
    maxRetries?: number | undefined;
    retryDelayMs?: number | undefined;
    signal?: AbortSignal | undefined;
}

const WIRE_FINISH_REASONS = ["stop", "length", "tool_calls", "content_filter"] as const;
/** An endpoint that takes the request and answers nothing stalls the call for good: the wait for
 *  the response head, and then for every read of its body, is bounded. */
const REQUEST_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 120_000;
/** A tool-call `index` past this is not a slot a model filled, it is a length an accumulator would
 *  be sized to — the wire chooses it, so it is bounded here. */
const MAX_TOOL_CALL_SLOTS = 128;
const OPEN = "<think>";
const CLOSE = "</think>";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason as Error);
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason as Error);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export function toWireMessages(messages: Message[]): unknown[] {
    return messages.map((m) => {
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
            return {
                role: "assistant",
                content: m.content,
                tool_calls: m.tool_calls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: { name: c.name, arguments: c.arguments },
                })),
            };
        }
        // only inline data: a URL here is fetched by the model host, from wherever it runs
        const { images, ...rest } = m;
        const inline = Array.isArray(images) ? images.filter((u) => typeof u === "string" && isImageDataUri(u)) : [];
        if (inline.length > 0) {
            return {
                role: m.role,
                content: [
                    ...(m.content ? [{ type: "text", text: m.content }] : []),
                    ...inline.map((url) => ({ type: "image_url", image_url: { url } })),
                ],
            };
        }
        return rest;
    });
}

export async function postSSE(opts: PostSSEOptions): Promise<Response> {
    const maxRetries = opts.maxRetries ?? 2;
    const baseDelay = opts.retryDelayMs ?? 1000;
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    let lastError: unknown = new Error(`${opts.label}: request failed`);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) await sleep(baseDelay * attempt, opts.signal);
        opts.signal?.throwIfAborted(); // an external abort is never retried

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const fetchSignal = opts.signal
            ? AbortSignal.any([controller.signal, opts.signal])
            : controller.signal;

        let response: Response;
        try {
            response = await fetch(opts.url, {
                method: "POST",
                headers: opts.headers,
                body: JSON.stringify(opts.body),
                signal: fetchSignal,
            });
        } catch (e) {
            clearTimeout(timer);
            if (opts.signal?.aborted) throw e;
            // an endpoint that took the request and answered nothing would stall the retry the same way
            if (controller.signal.aborted) {
                throw new Error(`${opts.label}: no response headers in ${timeoutMs}ms`);
            }
            // fetch says only "fetch failed"; its cause names the refused or unknown address
            const cause = (e as Error).cause;
            lastError = new Error(`${opts.label}: ${(e as Error).message}${cause instanceof Error ? ` (${cause.message})` : ""}`, { cause: e });
            continue;
        }

        if (response.ok) {
            clearTimeout(timer);
            return response;
        }

        let detail = "";
        try {
            // the request timer stays armed across the error body: an endpoint that sends a status
            // and never ends the body would hold this endpoint's one call slot for good
            detail = (await response.text()).slice(0, 300);
        } catch {
            // status alone diagnoses a body that failed to drain
        } finally {
            clearTimeout(timer);
        }
        const error = new Error(`${opts.label} ${response.status}: ${detail}`);
        if (response.status < 500 && response.status !== 429) throw error;
        lastError = error;
    }

    throw lastError;
}

export async function* parseSSE<T extends WireChunk = WireChunk>(
    response: Response,
    label: string,
): AsyncGenerator<T> {
    if (!response.body) throw new Error(`${label}: empty response body`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let stalled: Error | null = null;

    try {
        while (true) {
            const deadline = setTimeout(() => {
                stalled = new Error(`${label}: no data for ${IDLE_TIMEOUT_MS}ms`);
                // cancelling an already-errored body rejects; the stall is what the caller is told
                void reader.cancel(stalled).catch(() => undefined);
            }, IDLE_TIMEOUT_MS);
            // a cancelled read RESOLVES with done, so the flag is what says the body stalled
            const { done, value } = await reader.read().finally(() => clearTimeout(deadline));
            if (stalled) throw stalled;
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = done ? "" : (lines.pop() ?? "");

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;

                const data = trimmed.slice(5).trim();
                if (data === "[DONE]") return;

                let chunk: T;
                try {
                    chunk = JSON.parse(data) as T;
                } catch {
                    continue;
                }
                yield chunk;
            }
            if (done) break;
        }
    } finally {
        try {
            await reader.cancel();
        } catch {
            // already closed/aborted
        }
    }
}

/** Chunks → provider events: tool-call deltas merge by index, and `done` always closes the stream. */
export async function* readChatStream<T extends WireChunk>(
    response: Response,
    label: string,
    thinkingOf: (delta: WireDelta) => string | undefined,
    metaOf?: (chunk: T) => unknown,
): ProviderStream {
    const toolCalls: ToolCall[] = [];
    let finishReason: FinishReason = "error";
    let usage: Usage | undefined;
    let meta: unknown;
    let model: string | undefined;

    for await (const chunk of parseSSE<T>(response, label)) {
        if (chunk.error) {
            const detail = typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? JSON.stringify(chunk.error));
            throw new Error(`${label}: the stream failed mid-answer — ${detail.slice(0, 300)}`);
        }
        if (chunk.usage) usage = mapUsage(chunk.usage);
        if (chunk.model) model = chunk.model;
        meta = metaOf?.(chunk) ?? meta;

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        const thinking = thinkingOf(delta);
        if (thinking) yield { type: "thinking", text: thinking };
        if (delta.content) yield { type: "text", text: delta.content };
        for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const slot = tc.index ?? 0;
            if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_TOOL_CALL_SLOTS) continue;
            const acc = (toolCalls[slot] ??= { id: "", name: "", arguments: "" });
            acc.id += tc.id ?? "";
            acc.name += tc.function?.name ?? "";
            acc.arguments += tc.function?.arguments ?? "";
        }
        if (choice.finish_reason) finishReason = normalizeFinish(choice.finish_reason);
    }

    const calls = toolCalls.filter(Boolean);
    if (calls.length > 0) yield { type: "tool_calls", calls };
    yield { type: "done", finishReason, ...(usage ? { usage } : {}), meta, model };
}

// the wire's own error/abort ends an incomplete answer; "aborted" stays ours (a user stop), and any other unknown reason reads as "stop"
export function normalizeFinish(reason: string): FinishReason {
    if (reason === "error" || reason === "abort") return "error";
    return (WIRE_FINISH_REASONS as readonly string[]).includes(reason)
        ? (reason as FinishReason)
        : "stop";
}

export function mapUsage(u: NonNullable<WireChunk["usage"]>): Usage {
    const reasoning = u.completion_tokens_details?.reasoning_tokens;
    return {
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
        totalTokens: u.total_tokens ?? 0,
        cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
        // unreported stays ABSENT — a 0 default would fake a report the provider never made
        ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
    };
}

// ─── literal <think> tags ──────────────────────────────────────────────────

/** Opt-in (`params.think = "tags"`): re-split text events whose model emits literal think tags.
 *  Recognized only when <think> is the very first non-whitespace of the answer; the close marker
 *  is ignored when a backtick touches it (a quoted example, not a marker); an unclosed block is
 *  all thinking. Safe across any token split. */
export async function* splitThinkTags(stream: ProviderStream): ProviderStream {
    let mode: "start" | "thinking" | "verbatim" = "start";
    let buf = "";
    for await (const ev of stream) {
        if (ev.type !== "text" && ev.type !== "done") {
            yield ev;
            continue;
        }
        if (ev.type === "text") {
            if (mode === "verbatim") {
                yield ev;
                continue;
            }
            buf += ev.text;
            if (mode === "start") {
                const lead = buf.match(/^\s*/)?.[0] ?? "";
                const head = buf.slice(lead.length);
                if (head.length < OPEN.length) {
                    if (OPEN.startsWith(head)) continue; // could still become the opening tag
                    mode = "verbatim";
                    if (buf) yield { type: "text", text: buf };
                    buf = "";
                    continue;
                }
                if (head.startsWith(OPEN)) {
                    mode = "thinking";
                    buf = head.slice(OPEN.length);
                } else {
                    mode = "verbatim";
                    if (buf) yield { type: "text", text: buf };
                    buf = "";
                    continue;
                }
            }
            // thinking: hunt a decidable close marker (one lookahead char for the backtick guard)
            for (;;) {
                const at = buf.indexOf(CLOSE);
                if (at < 0) break;
                const end = at + CLOSE.length;
                if (end >= buf.length) break; // wait for the lookahead char (or the stream's end)
                const quoted = buf[at - 1] === "`" || buf[end] === "`";
                if (quoted) {
                    yield { type: "thinking", text: buf.slice(0, end) };
                    buf = buf.slice(end);
                    continue;
                }
                if (at > 0) yield { type: "thinking", text: buf.slice(0, at) };
                mode = "verbatim";
                const rest = buf.slice(end);
                buf = "";
                if (rest) yield { type: "text", text: rest };
                break;
            }
            if (mode === "thinking") {
                // emit what can no longer be part of a marker or its guard
                const hold = CLOSE.length + 1;
                if (buf.length > hold) {
                    yield { type: "thinking", text: buf.slice(0, buf.length - hold) };
                    buf = buf.slice(buf.length - hold);
                }
            }
            continue;
        }
        // done: settle the buffer — an undecided start is answer text, an unclosed block is thinking
        if (buf) {
            if (mode === "thinking") {
                const at = buf.indexOf(CLOSE);
                const quoted = at > 0 && buf[at - 1] === "`";
                if (at >= 0 && !quoted) {
                    if (at > 0) yield { type: "thinking", text: buf.slice(0, at) };
                    const rest = buf.slice(at + CLOSE.length);
                    if (rest) yield { type: "text", text: rest };
                } else {
                    yield { type: "thinking", text: buf };
                }
            } else {
                yield { type: "text", text: buf };
            }
            buf = "";
        }
        yield ev;
    }
}
