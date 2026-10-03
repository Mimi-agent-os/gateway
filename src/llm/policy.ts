/** Per-agent model policy: the grant whitelist and resolution order; and each model's daily limit. */

import type { ModelGrant } from "@mimi-os/protocol";

import { PeerError } from "../registry/peer.ts";
import { gatewayDb, tokenCost, type GatewayDb, type ModelsPolicy } from "../store/db.ts";
import { timeZone } from "../store/day.ts";
import { getDefaultModel, getModel, listModels, type ModelConfig } from "./models.ts";

/** A model past its daily limit when its call leaves the queue: the one refusal a fallback with room may answer. */
export class LimitReached extends PeerError {
    constructor(model: string) {
        super(`model ${model} reached its daily limit; resets at midnight ${timeZone()}`, "denied");
    }
}

/** Every agent and ping together on the owner's day; a usd limit compares today's tokens at the current price. */
function overLimit(cfg: ModelConfig, db: GatewayDb): boolean {
    if (!cfg.limit) return false;
    const today = db.modelTokens().get(cfg.modelUid) ?? { promptTokens: 0, completionTokens: 0 };
    const spent =
        cfg.limit.unit === "tokens"
            ? today.promptTokens + today.completionTokens
            : tokenCost(today.promptTokens, today.completionTokens, cfg);
    return spent >= cfg.limit.value;
}

type Resolution =
    | { ok: true; cfg: ModelConfig; fallback: ModelConfig | null; policy: ModelsPolicy | null; replaces?: ModelConfig | undefined }
    | { ok: false; reason: string; denied: boolean; limited?: boolean };

export function modelNames(db: GatewayDb = gatewayDb()): string[] {
    try {
        return listModels(db).map((m) => m.name);
    } catch {
        return [];
    }
}

/** The registry's default model, or "" when none is configured — what a no-policy agent gets. */
export function defaultModelName(db: GatewayDb = gatewayDb()): string {
    try {
        return getDefaultModel(db).name;
    } catch {
        return "";
    }
}

/** The ONE whitelist, read by every surface: an explicit allowed-list, or else just the registry's default model — no policy is the TIGHTEST grant, never the widest. */
export function grantsFor(agent: string, db: GatewayDb = gatewayDb()): string[] {
    const allowed = db.getModelsPolicy(agent)?.allowed;
    if (allowed) return [...allowed];
    const def = defaultModelName(db);
    return def ? [def] : []; // an empty registry grants nothing — there is no default to fall on
}

/** The same whitelist in the wire's shape: what `describe_ok.models` tells the agent it has. */
export function modelGrantsFor(agent: string, db: GatewayDb = gatewayDb()): ModelGrant[] {
    try {
        return grantsFor(agent, db).flatMap((name) => {
            const cfg = getModel(name, db);
            // a name the registry no longer holds grants nothing
            return cfg ? [{ id: cfg.name, contextTokens: cfg.contextTokens }] : [];
        });
    } catch {
        return [];
    }
}

/** The ONE gate every agent-scoped model call passes: pause, resolution order, grants, and the model's daily limit — past it the fallback takes the call when it has room. */
export function resolveModelFor(
    agent: string,
    wanted: string | undefined,
    manifestModel: string | undefined,
    db: GatewayDb = gatewayDb(),
): Resolution {
    if (db.isPaused(agent)) {
        return { ok: false, denied: true, reason: `agent "${agent}" is paused — no model calls until it is resumed` };
    }
    const policy = db.getModelsPolicy(agent);
    const granted = grantsFor(agent, db);
    const name = wanted ?? policy?.primary ?? manifestModel;
    let cfg: ModelConfig | null;
    try {
        cfg = name === undefined ? getDefaultModel(db) : getModel(name, db);
    } catch (e) {
        return { ok: false, reason: (e as Error).message, denied: false };
    }
    if (!cfg) return { ok: false, reason: `Unknown model "${name}".`, denied: false };
    // every source is checked the same way: a request, a primary and a manifest all pass here
    if (!granted.includes(cfg.name)) {
        return {
            ok: false,
            denied: true,
            reason:
                `model "${cfg.name}" is not granted to agent "${agent}" — granted: ` +
                `${granted.join(", ") || "(none)"} — add it to that agent's allowed models, or change ` +
                `its primary`,
        };
    }
    // an ungranted fallback, or one out of room, is dropped, not fatal: the outage path never widens the whitelist
    const fb = policy?.fallback;
    const grantedFallback = fb !== undefined && fb !== cfg.name && granted.includes(fb) ? getModel(fb, db) : null;
    const fallback = grantedFallback && !overLimit(grantedFallback, db) ? grantedFallback : null;
    if (!overLimit(cfg, db)) return { ok: true, cfg, fallback, policy };
    if (fallback) return { ok: true, cfg: fallback, fallback: null, policy, replaces: cfg };
    return { ok: false, denied: true, limited: true, reason: new LimitReached(cfg.name).message };
}

/** The gate again as a call leaves the queue, for the model it is about to reach: what ran ahead may have spent its limit. */
export function admitAtDequeue(agent: string, cfg: ModelConfig, db: GatewayDb): void {
    const admitted = resolveModelFor(agent, cfg.name, undefined, db);
    // refused for its limit, or handed on to the fallback: either way this model is out of room
    if (admitted.ok ? admitted.cfg.name !== cfg.name : admitted.limited) throw new LimitReached(cfg.name);
    if (!admitted.ok) throw new PeerError(admitted.reason, admitted.denied ? "denied" : "error");
}
