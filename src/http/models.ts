import {
    addModel,
    apiKeyEnv,
    createProvider,
    describeModels,
    describeProviders,
    getModel,
    patchModel,
    providerKeyEnv,
    removeModel,
    setDefaultModel,
} from "../llm/models.ts";
import type { ModelConfig } from "../llm/models.ts";
import type { ProviderResponse } from "../llm/base/index.ts";
import { newCallId, PING_AGENT, recordLlmCall } from "../store/accounting.ts";
import { hasSecret, secret, setEnv } from "../store/env.ts";
import type { GatewayDb } from "../store/db.ts";
import { json, readBody, type Router } from "./router.ts";

const effectiveKeyEnv = (mc: ModelConfig): string => {
    const own = apiKeyEnv(mc.name);
    const shared = providerKeyEnv(mc.provider);
    return hasSecret(own) ? own : (shared ?? own);
};

export function registerModels(router: Router, db: GatewayDb): void {
    router.get("/api/models", (ctx) => json(ctx.res, 200, describeModels(db)));

    router.post("/api/models", async (ctx) => {
        const body = await readBody(ctx.req);
        // addModel's parseEntry owns every model field; the key is the one field it never sees
        const rawApiKey = body["apiKey"];
        if (rawApiKey !== undefined && typeof rawApiKey !== "string") {
            return json(ctx.res, 400, { error: '"apiKey" must be a string' });
        }
        const rawName = body["name"];
        let added: ReturnType<typeof addModel>;
        try {
            added = addModel({ ...body, name: typeof rawName === "string" ? rawName.trim() : rawName }, db);
        } catch (e) {
            return json(ctx.res, 400, { error: (e as Error).message });
        }
        const apiKey = rawApiKey?.trim() ?? "";
        if (apiKey) {
            const keyEnv = providerKeyEnv(added.provider) ?? apiKeyEnv(added.name);
            const r = setEnv(keyEnv, apiKey);
            if (!r.ok) return json(ctx.res, 500, { error: `model added, but the key: ${r.error}` });
        }
        return json(ctx.res, 201, { ok: true });
    });

    router.delete("/api/models/:model", (ctx) => {
        const name = ctx.param("model");
        try {
            removeModel(name, db);
        } catch (e) {
            return json(ctx.res, 400, { error: (e as Error).message });
        }
        return json(ctx.res, 200, { ok: true });
    });

    router.patch("/api/models/:model", async (ctx) => {
        const body = await readBody(ctx.req);
        const name = ctx.param("model");
        let renamed: { from: string; to: string } | null = null;
        let renameTo: string | null = null;
        const rawName = body["name"];
        if (rawName !== undefined) {
            if (typeof rawName !== "string") {
                return json(ctx.res, 400, { error: '"name" must be a string' });
            }
            const next = rawName.trim();
            if (next !== name) renameTo = next;
        }
        const patch: { endpoint?: string; modelId?: string; contextTokens?: number; vision?: boolean; params?: Record<string, unknown> } = {};
        const endpoint = body["endpoint"];
        if (endpoint !== undefined) {
            if (typeof endpoint !== "string" || !endpoint.trim()) {
                return json(ctx.res, 400, { error: '"endpoint" must be a non-empty string' });
            }
            patch.endpoint = endpoint;
        }
        const modelId = body["modelId"];
        if (modelId !== undefined) {
            if (typeof modelId !== "string" || !modelId.trim()) {
                return json(ctx.res, 400, { error: '"modelId" must be a non-empty string' });
            }
            patch.modelId = modelId;
        }
        if (body["contextTokens"] !== undefined) {
            const contextTokens = body["contextTokens"];
            if (typeof contextTokens !== "number" || !Number.isSafeInteger(contextTokens) || contextTokens < 1) {
                return json(ctx.res, 400, { error: '"contextTokens" must be a positive safe integer' });
            }
            patch.contextTokens = contextTokens;
        }
        if (body["params"] !== undefined) {
            const params = body["params"];
            if (typeof params !== "object" || params === null || Array.isArray(params)) {
                return json(ctx.res, 400, { error: '"params" must be an object' });
            }
            patch.params = params as Record<string, unknown>;
        }
        if (body["vision"] !== undefined) {
            const vision = body["vision"];
            if (typeof vision !== "boolean") {
                return json(ctx.res, 400, { error: '"vision" must be a boolean' });
            }
            patch.vision = vision;
        }
        const rawApiKey = body["apiKey"];
        if (rawApiKey !== undefined && typeof rawApiKey !== "string") {
            return json(ctx.res, 400, { error: '"apiKey" must be a string' });
        }
        const apiKey = rawApiKey?.trim() ?? "";
        const hasPatch = Object.keys(patch).length > 0;
        if (!hasPatch && !apiKey && renameTo === null) {
            return json(ctx.res, 400, { error: "nothing to change" });
        }
        if (hasPatch || renameTo !== null) {
            try {
                renamed = patchModel(name, { ...patch, name: renameTo ?? undefined }, db);
            } catch (e) {
                return json(ctx.res, 400, { error: (e as Error).message });
            }
        }
        if (!apiKey) return json(ctx.res, 200, { ok: true, ...(renamed ? { renamed } : {}) });
        const targetName = renamed?.to ?? name;
        let target: ModelConfig | null;
        try {
            target = getModel(targetName, db);
        } catch (e) {
            return json(ctx.res, 400, { error: (e as Error).message });
        }
        if (!target) return json(ctx.res, 404, { error: `no model "${targetName}"` });
        const keyEnv = effectiveKeyEnv(target);
        const wrote = setEnv(keyEnv, apiKey);
        if (!wrote.ok) return json(ctx.res, 500, { error: `key: ${wrote.error}` });
        // createProvider runs fresh inside every runTurn, so a running turn picks up the new key on its next round
        return json(ctx.res, 200, { ok: true, keyEnv, ...(renamed ? { renamed } : {}) });
    });

    router.post("/api/models/:model/default", (ctx) => {
        try {
            setDefaultModel(ctx.param("model"), db);
        } catch (e) {
            return json(ctx.res, 400, { error: (e as Error).message });
        }
        return json(ctx.res, 200, { ok: true });
    });

    // a ping is a real (tiny) model call: recorded under the gateway's own name and kind "ping",
    // outside every agent's calls and dashboard row, yet on the model's daily tally; it skips the queue and the limit on purpose
    router.post("/api/models/:model/ping", async (ctx) => {
        const name = ctx.param("model");
        const t0 = performance.now();
        const mc = getModel(name, db);
        let r: ProviderResponse | null = null;
        let error: string | null = null;
        let model: string | null | undefined;
        try {
            const provider = createProvider(name, db);
            model = provider.model ?? null;
            r = await provider.complete(
                [{ role: "user", content: "Reply with the single word: pong" }],
                [],
                AbortSignal.timeout(15_000),
            );
        } catch (e) {
            error = (e as Error).message;
        }
        const ms = Math.round(performance.now() - t0);
        // a model the registry could not even build made no call
        if (model !== undefined) {
            recordLlmCall(
                {
                    agent: PING_AGENT,
                    scope: "ping",
                    callId: newCallId(),
                    callKind: "ping",
                    model,
                    provider: mc?.provider ?? null,
                    modelUid: mc?.modelUid ?? null,
                    registryModel: name,
                    reportedModel: r?.model ?? null,
                    finishReason: r?.finishReason ?? "error",
                    usage: r?.usage,
                    durationMs: ms,
                    raw: r ? { text: r.text, finishReason: r.finishReason } : { error },
                },
                db,
            );
        }
        if (!r) return json(ctx.res, 502, { ok: false, ms, error });
        if (r.finishReason !== "stop") return json(ctx.res, 502, { ok: false, ms, error: `finish: ${r.finishReason}` });
        return json(ctx.res, 200, { ok: true, ms, text: r.text.trim().slice(0, 80) });
    });

    router.post("/api/models/:model/key/reveal", (ctx) => {
        const name = ctx.param("model");
        const mc = getModel(name, db);
        if (!mc) return json(ctx.res, 404, { error: `no model "${name}"` });
        const keyEnv = effectiveKeyEnv(mc);
        const value = secret(keyEnv);
        if (value === undefined) return json(ctx.res, 404, { error: `${keyEnv} is not set` });
        return json(ctx.res, 200, { key: keyEnv, value });
    });

    router.get("/api/providers", (ctx) => json(ctx.res, 200, describeProviders()));
}
