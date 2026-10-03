import type { GatewayCore } from "../core.ts";
import { defaultModelName, modelNames } from "../llm/policy.ts";
import type { ModelsPolicy } from "../store/db.ts";
import { json, readBody, type Router } from "./router.ts";

type Merged = { error: string } | { policy: ModelsPolicy | null };

const POLICY_FIELDS = new Set(["primary", "fallback", "allowed"]);

/** `allowed: null` is the tightest grant, not the widest — `default` is what it actually grants. */
const view = (policy: ModelsPolicy | null, available: string[], def: string): Record<string, unknown> => ({
    primary: policy?.primary ?? null,
    fallback: policy?.fallback ?? null,
    allowed: policy?.allowed ?? null,
    available,
    default: def,
});

/** A PATCH names the fields it changes: absent keeps, null clears, a value must be a real model. */
function merge(
    current: ModelsPolicy | null,
    body: Record<string, unknown>,
    known: readonly string[],
    def: string,
): Merged {
    const fields = Object.keys(body);
    if (fields.length === 0 || fields.some((key) => !POLICY_FIELDS.has(key))) {
        return { error: "pass at least one recognized policy field" };
    }
    const out: ModelsPolicy = { ...(current ?? {}) };
    if (current?.allowed) out.allowed = [...current.allowed];

    for (const key of ["primary", "fallback"] as const) {
        if (!(key in body)) continue;
        const raw = body[key];
        if (raw === null) {
            delete out[key];
            continue;
        }
        if (typeof raw !== "string" || !raw) return { error: `${key} must be a model name or null` };
        if (!known.includes(raw)) return { error: `unknown model "${raw}"` };
        out[key] = raw;
    }

    if ("allowed" in body) {
        const raw = body["allowed"];
        if (raw === null) delete out.allowed;
        else if (!Array.isArray(raw)) {
            return { error: "allowed must be an array of model names or null" };
        } else {
            const list: string[] = [];
            for (const v of raw as unknown[]) {
                if (typeof v !== "string" || !v) return { error: "allowed must hold model names" };
                if (!known.includes(v)) return { error: `unknown model "${v}"` };
                if (!list.includes(v)) list.push(v);
            }
            out.allowed = list;
        }
    }

    // grantsFor()'s whitelist applies here too: a policy the gateway would refuse every turn under can't be stored
    const granted = out.allowed ?? (def ? [def] : []);
    for (const key of ["primary", "fallback"] as const) {
        const v = out[key];
        if (v === undefined || granted.includes(v)) continue;
        return {
            error: out.allowed
                ? `${key} "${v}" is not in the allowed list`
                : `${key} "${v}" is not granted — with no allowed list an agent may use only the ` +
                  `default model, so put "${v}" on its allowed list first`,
        };
    }
    return { policy: Object.keys(out).length ? out : null };
}

export function registerModelsPolicy(router: Router, core: GatewayCore): void {
    // the pin row holds the policy; before the first connection an open agent invite carries it to that row
    const current = (name: string): { pinned: boolean; policy: ModelsPolicy | null } => {
        const pinned = core.db.getPin(name) !== null;
        return { pinned, policy: pinned ? core.db.getModelsPolicy(name) : (core.devices.agentInvitePolicy(name) ?? null) };
    };

    router.get("/api/agents/:agent/models", (ctx) => {
        const def = defaultModelName(core.db);
        return json(ctx.res, 200, view(current(ctx.param("agent")).policy, modelNames(core.db), def));
    });

    router.patch("/api/agents/:agent/models", async (ctx) => {
        const name = ctx.param("agent");
        const known = modelNames(core.db);
        const def = defaultModelName(core.db);
        const { pinned, policy } = current(name);
        const merged = merge(policy, await readBody(ctx.req), known, def);
        if ("error" in merged) return json(ctx.res, 400, { error: merged.error });
        const stored = pinned
            ? core.db.setModelsPolicy(name, merged.policy)
            : core.devices.setAgentInvitePolicy(name, merged.policy);
        if (!stored) {
            return json(ctx.res, 404, { error: `no agent "${name}" — no pin and no open agent invite` });
        }
        return json(ctx.res, 200, view(merged.policy, known, def));
    });
}
