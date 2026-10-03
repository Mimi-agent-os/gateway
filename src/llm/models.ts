/** Model registry over gateway.db: validation, CRUD, provider construction. */
import { gatewayDb, type GatewayDb, type ModelPricing, type ModelRow, type ModelsPolicy } from "../store/db.ts";
import { hasSecret, secret, setEnv, unsetEnv } from "../store/env.ts";
import type { Message, Tool } from "@mimi-os/protocol";

import { BaseProvider, type ProviderStream } from "./base/index.ts";
import { splitThinkTags } from "./providers/shared/openai-sse.ts";
import { LlamaProvider, LLAMA_PARAM_INFO, type LlamaParams } from "./providers/llama-cpp/index.ts";
import { VllmProvider, VLLM_PARAM_INFO, type VllmParams } from "./providers/vllm/index.ts";
import {
    OpenRouterProvider,
    OPENROUTER_PARAM_INFO,
    type OpenRouterParams,
} from "./providers/openrouter/index.ts";

export interface ModelConfig extends ModelPricing {
    name: string;
    /** Immutable registry identity: survives a rename, a fresh one on recreation. */
    modelUid: string;
    provider: string;
    endpointUrl: string;
    modelId?: string | undefined;
    params: Record<string, unknown>;
    contextTokens: number;
    /** Model-level capability: the single multimodal model accepts images (data-URIs) alongside text. */
    vision: boolean;
    isDefault: boolean;
}

/** What parseEntry validates: the base settings, never the identity, the default flag or the pricing. */
type ModelFields = Omit<ModelConfig, "isDefault" | "modelUid" | keyof ModelPricing>;

/** One knob an adapter accepts — the pult generates its params editor from these. */
interface ParamField {
    key: string;
    type: "number" | "boolean" | "string" | "json";
    hint?: string;
}

/** Whether the provider refuses to run without an API key, or merely accepts one. */
type KeyRequirement = "required" | "optional";

interface ProviderInfo {
    kind: string;
    keyRequirement?: KeyRequirement | undefined;
    defaultEndpoint?: string | undefined;
    keyEnv?: string | undefined;
    needsModelId?: boolean | undefined;
    endpointHint?: string | undefined;
    modelIdHint?: string | undefined;
    params: ParamField[];
    openParams?: boolean | undefined;
    keySet?: boolean | undefined;
}

interface ModelInfo {
    name: string;
    modelUid: string;
    provider: string;
    endpoint: string;
    modelId?: string | undefined;
    contextTokens: number;
    vision: boolean;
    isDefault: boolean;
    params: Record<string, unknown>;
    keyEnv: string;
    keySet: boolean;
}

interface ModelPatch {
    endpoint?: string;
    modelId?: string;
    contextTokens?: number;
    vision?: boolean | undefined;
    params?: Record<string, unknown>;
}

interface Adapter {
    build: (model: ModelConfig) => BaseProvider;
    params: readonly ParamField[];
    keyRequirement: KeyRequirement;
    defaultEndpoint?: string;
    keyEnv?: string;
    needsModelId?: boolean;
    openParams?: boolean;
    endpointHint?: string;
    modelIdHint?: string;
}

export const apiKeyEnv = (model: string): string =>
    `${model.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;

const adapters: Record<string, Adapter> = {
    llamacpp: {
        build: (model) => {
            const apiKey = secret(apiKeyEnv(model.name));
            return new LlamaProvider({
                endpointUrl: model.endpointUrl,
                model: model.name,
                params: model.params as LlamaParams,
                ...(apiKey ? { apiKey } : {}),
            });
        },
        params: LLAMA_PARAM_INFO,
        keyRequirement: "optional",
    },
    openrouter: {
        openParams: true,
        build: (model) => {
            const apiKey = secret(apiKeyEnv(model.name)) ?? secret("OPENROUTER_API_KEY");
            if (!apiKey) {
                throw new Error(
                    `Model "${model.name}": set OPENROUTER_API_KEY (or ${apiKeyEnv(model.name)}) ` +
                        `in mimi/.env.`,
                );
            }
            return new OpenRouterProvider({
                endpointUrl: model.endpointUrl,
                model: model.modelId ?? model.name,
                apiKey,
                params: model.params as OpenRouterParams,
            });
        },
        params: OPENROUTER_PARAM_INFO,
        keyRequirement: "required",
        defaultEndpoint: "https://openrouter.ai/api",
        keyEnv: "OPENROUTER_API_KEY",
        needsModelId: true,
        endpointHint: "endpoint (https://openrouter.ai/api)",
        modelIdHint: "model id (anthropic/claude-sonnet-4.5)",
    },
    vllm: {
        openParams: true,
        build: (model) => {
            const apiKey = secret(apiKeyEnv(model.name)) ?? secret("VLLM_API_KEY");
            return new VllmProvider({
                endpointUrl: model.endpointUrl,
                model: model.modelId ?? model.name,
                params: model.params as VllmParams,
                ...(apiKey ? { apiKey } : {}),
            });
        },
        params: VLLM_PARAM_INFO,
        keyRequirement: "optional",
        keyEnv: "VLLM_API_KEY",
        needsModelId: true,
        endpointHint: "endpoint (http://host:8000)",
        modelIdHint: "served model (meta-llama/Llama-3.1-8B-Instruct)",
    },
};

const kinds = Object.keys(adapters);
const DEFAULT_KEY = "default_model";
/** Shared with http/router.ts's `:model` route segment — the one definition of this charset. */
export const MODEL_NAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9_.:-]*";
const MODEL_NAME = new RegExp(`^${MODEL_NAME_PATTERN}$`);
const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

export function describeProviders(): ProviderInfo[] {
    return Object.entries(adapters).map(([kind, a]) => ({
        kind,
        keyRequirement: a.keyRequirement,
        defaultEndpoint: a.defaultEndpoint,
        keyEnv: a.keyEnv,
        keySet: a.keyEnv ? hasSecret(a.keyEnv) : undefined,
        needsModelId: a.needsModelId,
        endpointHint: a.endpointHint,
        modelIdHint: a.modelIdHint,
        openParams: a.openParams,
        params: [...a.params],
    }));
}

export function providerKeyEnv(kind: string): string | undefined {
    return adapters[kind]?.keyEnv;
}

function parseEntry(raw: unknown): ModelFields {
    if (typeof raw !== "object" || raw === null) {
        throw new Error("models: a model entry must be an object.");
    }
    const m = raw as Record<string, unknown>;
    const str = (k: string): string => {
        const v = m[k];
        if (typeof v !== "string" || !v) throw new Error(`models: a model needs "${k}".`);
        return v;
    };
    const name = str("name");
    if (!MODEL_NAME.test(name)) {
        throw new Error(
            `models: "${name}" is not a valid model name — letters, digits, "_.:-", ` +
                `starting with a letter or digit.`,
        );
    }
    const provider = str("provider");
    const adapter = adapters[provider];
    if (!adapter) {
        throw new Error(
            `models: model "${name}" has unknown provider "${provider}". Known: ${kinds.join(", ")}.`,
        );
    }
    const ctx = m["contextTokens"];
    if (typeof ctx !== "number" || !Number.isSafeInteger(ctx) || ctx < 1) {
        throw new Error(`models: model "${name}" needs a positive safe integer "contextTokens".`);
    }
    const visionRaw = m["vision"];
    if (visionRaw !== undefined && typeof visionRaw !== "boolean") {
        throw new Error(`models: model "${name}" — "vision" must be a boolean.`);
    }
    const vision = visionRaw === true;
    const rawParams = m["params"];
    if (rawParams !== undefined && (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams))) {
        throw new Error(`models: model "${name}" — "params" must be an object.`);
    }
    const params = (rawParams as Record<string, unknown>) ?? {};
    // "think" is a gateway-recognized param for every provider — it splits literal <think>…</think>
    // tags out of content into thinking, and never reaches the provider body. On by default; set
    // "off" for a model that streams reasoning some other way (reasoning_content) or emits none.
    if (params["think"] !== undefined && params["think"] !== "tags" && params["think"] !== "off") {
        throw new Error(`models: model "${name}" — "params.think" must be "tags" or "off".`);
    }
    const allowed = new Set<string>(adapter.params.map((p) => p.key));
    const bad = adapter.openParams
        ? []
        : Object.keys(params).filter((k) => k !== "think" && !allowed.has(k));
    if (bad.length) {
        throw new Error(
            `models: model "${name}" has params not supported by "${provider}": ${bad.join(", ")}`,
        );
    }
    const rawEndpoint = m["endpoint"];
    if (rawEndpoint !== undefined && typeof rawEndpoint !== "string") {
        throw new Error(`models: model "${name}" — "endpoint" must be a string.`);
    }
    const given = rawEndpoint || adapter.defaultEndpoint;
    if (!given) throw new Error(`models: model "${name}" needs "endpoint".`);
    const url = URL.parse(given);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
        throw new Error(`models: model "${name}" endpoint "${given}" is not an absolute http(s) URL.`);
    }
    // a provider that refuses to run without a key sends that key as a bearer token on every call
    if (adapter.keyRequirement === "required" && url.protocol === "http:" && !LOOPBACK.test(url.hostname)) {
        throw new Error(
            `models: model "${name}" (${provider}) needs an https endpoint — "${given}" would send ` +
                `its API key in cleartext.`,
        );
    }
    // one spelling per server: the stored value, the request URL and the queue key are this string;
    // every adapter appends /v1/chat/completions, so a pasted ".../v1" base loses its /v1
    const endpoint = url.origin + url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
    const modelId = m["modelId"];
    if (modelId !== undefined && (typeof modelId !== "string" || !modelId)) {
        throw new Error(`models: model "${name}" — "modelId" must be a non-empty string.`);
    }
    if (adapter.needsModelId && modelId === undefined) {
        throw new Error(
            `models: model "${name}" (${provider}) needs "modelId" — the remote model id, ` +
                `e.g. "anthropic/claude-sonnet-4.5".`,
        );
    }
    return {
        name,
        provider,
        endpointUrl: endpoint,
        modelId: modelId as string | undefined,
        contextTokens: ctx,
        vision,
        params,
    };
}

function defaultName(db: GatewayDb): string | null {
    const explicit = db.getSetting(DEFAULT_KEY);
    if (explicit) return explicit;
    return db.listModels()[0]?.name ?? null;
}

function rowToConfig(row: ModelRow, def: string | null): ModelConfig {
    return {
        name: row.name,
        modelUid: row.modelUid,
        provider: row.provider,
        endpointUrl: row.endpoint,
        modelId: row.modelId ?? undefined,
        params: row.params,
        contextTokens: row.contextTokens,
        vision: row.vision,
        isDefault: row.name === def,
        priceInPerM: row.priceInPerM,
        priceOutPerM: row.priceOutPerM,
        limit: row.limit,
    };
}

export function listModels(db: GatewayDb = gatewayDb()): ModelConfig[] {
    const def = defaultName(db);
    return db.listModels().map((r) => rowToConfig(r, def));
}

export function getModel(name: string, db: GatewayDb = gatewayDb()): ModelConfig | null {
    const row = db.getModel(name);
    return row ? rowToConfig(row, defaultName(db)) : null;
}

export function getDefaultModel(db: GatewayDb = gatewayDb()): ModelConfig {
    const def = defaultName(db);
    if (!def) throw new Error("gateway.db: no models configured.");
    const row = db.getModel(def);
    if (!row) throw new Error(`gateway.db: default model "${def}" is not among the models.`);
    return rowToConfig(row, def);
}

export function describeModels(db: GatewayDb = gatewayDb()): ModelInfo[] {
    return listModels(db).map((m) => {
        const perModelKey = apiKeyEnv(m.name);
        const provKey = providerKeyEnv(m.provider);
        const keyEnv = hasSecret(perModelKey) ? perModelKey : (provKey ?? perModelKey);
        const keySet = hasSecret(perModelKey) || (provKey ? hasSecret(provKey) : false);
        return {
            name: m.name,
            modelUid: m.modelUid,
            provider: m.provider,
            endpoint: m.endpointUrl,
            modelId: m.modelId,
            contextTokens: m.contextTokens,
            vision: m.vision,
            isDefault: m.isDefault,
            params: m.params,
            keyEnv,
            keySet,
        };
    });
}

const PRICING_FIELDS = new Set(["priceInPerM", "priceOutPerM", "limit"]);

/** The one validator of prices ($ per 1M tokens) and the daily limit: absent keeps, `limit: null` clears. */
export function setModelPricing(name: string, body: Record<string, unknown>, db: GatewayDb = gatewayDb()): ModelPricing {
    const row = db.getModel(name);
    if (!row) throw new Error(`gateway.db: no model "${name}".`);
    const fields = Object.keys(body);
    if (fields.length === 0 || fields.some((key) => !PRICING_FIELDS.has(key))) {
        throw new Error("pass at least one of priceInPerM, priceOutPerM, limit — and nothing else");
    }
    const next: ModelPricing = { priceInPerM: row.priceInPerM, priceOutPerM: row.priceOutPerM, limit: row.limit };
    for (const key of ["priceInPerM", "priceOutPerM"] as const) {
        if (!(key in body)) continue;
        const v = body[key];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${key} must be a number of dollars per 1M tokens, 0 or more`);
        next[key] = v;
    }
    if ("limit" in body) {
        const raw = body["limit"];
        if (raw === null) next.limit = null;
        else {
            const l = (typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
            const { unit, value } = l;
            const keysOk = Object.keys(l).every((k) => k === "unit" || k === "value");
            if (!keysOk || (unit !== "tokens" && unit !== "usd") || typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
                throw new Error('limit must be null or { unit: "tokens" | "usd", value: a number above 0 }');
            }
            if (unit === "tokens" && !Number.isSafeInteger(value)) throw new Error("a tokens limit must be a whole number of tokens");
            next.limit = { unit, value };
        }
    }
    db.setModelPricing(name, next);
    return next;
}

/** `entry` is raw JSON: parseEntry is the one validator of every model field. */
export function addModel(entry: Record<string, unknown>, db: GatewayDb = gatewayDb()): ModelFields {
    const parsed = parseEntry(entry);
    if (db.getModel(parsed.name)) {
        throw new Error(`gateway.db: model "${parsed.name}" already exists.`);
    }
    db.insertModel({
        name: parsed.name,
        provider: parsed.provider,
        endpoint: parsed.endpointUrl,
        modelId: parsed.modelId ?? null,
        contextTokens: parsed.contextTokens,
        vision: parsed.vision,
        params: parsed.params,
    });
    return parsed;
}

/** Every agent whose model policy names this model — renames must follow them, deletes must not orphan them. */
function policyRefs(name: string, db: GatewayDb): string[] {
    return db
        .listPins()
        .map((p) => p.name)
        .filter((agent) => {
            const policy = db.getModelsPolicy(agent);
            if (!policy) return false;
            return (
                policy.primary === name ||
                policy.fallback === name ||
                (policy.allowed?.includes(name) ?? false)
            );
        });
}

export function removeModel(name: string, db: GatewayDb = gatewayDb()): void {
    if (!db.getModel(name)) throw new Error(`gateway.db: no model "${name}".`);
    if (db.countModels() === 1) {
        throw new Error("gateway.db: refusing to remove the last model.");
    }
    if (defaultName(db) === name) {
        throw new Error(`gateway.db: "${name}" is the default — set another default first.`);
    }
    const used = policyRefs(name, db);
    if (used.length) {
        throw new Error(
            `gateway.db: "${name}" is named by the model policy of ${used.join(", ")} — ` +
                `clear it there first.`,
        );
    }
    db.deleteModel(name);
}

/** A rename follows the default-model pointer and every policy naming the model, and moves the
 *  key env when it is this row's alone. null = the name did not change. */
export function patchModel(
    from: string,
    patch: ModelPatch & { name?: string | undefined },
    db: GatewayDb = gatewayDb(),
): { from: string; to: string } | null {
    const to = patch.name ?? from;
    if (!MODEL_NAME.test(to)) {
        throw new Error(
            `gateway.db: "${to}" is not a valid model name — letters, digits, "_.:-", ` +
                `starting with a letter or digit.`,
        );
    }
    const row = db.getModel(from);
    if (!row) throw new Error(`gateway.db: no model "${from}".`);
    if (to !== from && db.getModel(to)) throw new Error(`gateway.db: model "${to}" already exists.`);
    const changesFields =
        patch.endpoint !== undefined ||
        patch.modelId !== undefined ||
        patch.contextTokens !== undefined ||
        patch.vision !== undefined ||
        patch.params !== undefined;
    const parsed = changesFields
        ? parseEntry({
              name: row.name,
              provider: row.provider,
              endpoint: patch.endpoint ?? row.endpoint,
              modelId: patch.modelId ?? row.modelId ?? undefined,
              contextTokens: patch.contextTokens ?? row.contextTokens,
              vision: patch.vision ?? row.vision,
              params: patch.params ?? row.params,
          })
        : null;

    if (to !== from) {
        // apiKeyEnv is a lossy uppercasing, so another row or a provider-shared env can answer to the same name
        const shared = new Set(db.listModels().flatMap((r) => (r.name === from ? [] : [apiKeyEnv(r.name)])));
        for (const a of Object.values(adapters)) if (a.keyEnv) shared.add(a.keyEnv);
        const wasDefault = defaultName(db) === from;
        const referring = policyRefs(from, db);
        db.renameModel(from, to);
        if (wasDefault) db.setSetting(DEFAULT_KEY, to);
        // a policy left pointing at the old name would refuse every turn under it
        for (const agent of referring) {
            const policy = db.getModelsPolicy(agent);
            if (!policy) continue;
            const next: ModelsPolicy = { ...policy };
            if (next.primary === from) next.primary = to;
            if (next.fallback === from) next.fallback = to;
            if (next.allowed) next.allowed = next.allowed.map((m) => (m === from ? to : m));
            db.setModelsPolicy(agent, next);
        }
        const oldKey = apiKeyEnv(from);
        const newKey = apiKeyEnv(to);
        const value = secret(oldKey);
        // losing the key outright is worse than leaving it under the old name when the write fails
        if (oldKey !== newKey && value !== undefined && !shared.has(oldKey) && !shared.has(newKey) && setEnv(newKey, value).ok) {
            unsetEnv(oldKey);
        }
    }
    if (parsed) {
        db.updateModel(to, {
            provider: parsed.provider,
            endpoint: parsed.endpointUrl,
            modelId: parsed.modelId ?? null,
            contextTokens: parsed.contextTokens,
            vision: parsed.vision,
            params: parsed.params,
        });
    }
    return to === from ? null : { from, to };
}

export function setDefaultModel(name: string, db: GatewayDb = gatewayDb()): void {
    if (!db.getModel(name)) throw new Error(`gateway.db: no model "${name}".`);
    db.setSetting(DEFAULT_KEY, name);
}

export function createProvider(model?: string, db: GatewayDb = gatewayDb()): BaseProvider {
    const cfg = model ? getModel(model, db) : getDefaultModel(db);
    if (!cfg) throw new Error(`Unknown model "${model}".`);
    const adapter = adapters[cfg.provider];
    if (!adapter) throw new Error(`Unknown provider "${cfg.provider}" for model "${cfg.name}".`);
    // On by default: a model that emits <think> tags (qwen, deepseek distills) surfaces thinking
    // with no per-model config; splitThinkTags is a no-op for content without a leading tag, so a
    // provider that streams reasoning_content instead is unaffected.
    const think = cfg.params["think"] !== "off";
    const { think: _drop, ...providerParams } = cfg.params;
    const built = adapter.build({ ...cfg, params: providerParams });
    return think ? new ThinkTagProvider(built) : built;
}

/** Wraps a provider whose model emits literal think tags in content — see splitThinkTags. */
class ThinkTagProvider extends BaseProvider {
    private readonly inner: BaseProvider;

    constructor(inner: BaseProvider) {
        super();
        this.inner = inner;
    }

    override get model(): string | undefined {
        return this.inner.model;
    }

    stream(messages: Message[], tools?: Tool[], signal?: AbortSignal): ProviderStream {
        return splitThinkTags(this.inner.stream(messages, tools, signal));
    }
}
