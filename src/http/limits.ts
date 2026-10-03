import type { GatewayCore } from "../core.ts";
import { getModel, listModels, setModelPricing, type ModelConfig } from "../llm/models.ts";
import { tokenCost, type GatewayDb } from "../store/db.ts";
import { dayInfo } from "../store/day.ts";
import { json, readBody, type Router } from "./router.ts";

/** Prices and the limit live on the registry row, never in /api/models; `today` is all agents and pings, priced now. */
const limitRow = (m: ModelConfig, spent: ReturnType<GatewayDb["modelTokens"]>): Record<string, unknown> => {
    const { promptTokens, completionTokens } = spent.get(m.modelUid) ?? { promptTokens: 0, completionTokens: 0 };
    return {
        uid: m.modelUid,
        name: m.name,
        provider: m.provider,
        priceInPerM: m.priceInPerM,
        priceOutPerM: m.priceOutPerM,
        limit: m.limit,
        today: { tokens: promptTokens + completionTokens, promptTokens, completionTokens, cost: tokenCost(promptTokens, completionTokens, m) },
        day: dayInfo(),
    };
};

export function registerLimits(router: Router, core: GatewayCore): void {
    const { db } = core;
    router.get("/api/limits", (ctx) => {
        const spent = db.modelTokens();
        return json(ctx.res, 200, listModels(db).map((m) => limitRow(m, spent)));
    });

    router.patch("/api/limits/:model", async (ctx) => {
        const name = ctx.param("model");
        if (!getModel(name, db)) return json(ctx.res, 404, { error: `no model "${name}"` });
        try {
            setModelPricing(name, await readBody(ctx.req), db);
        } catch (e) {
            return json(ctx.res, 400, { error: (e as Error).message });
        }
        // a price reprices every cost on screen, past days included: every open device refetches
        core.events.emit({ type: "limits_changed", model: name });
        return json(ctx.res, 200, limitRow(getModel(name, db)!, db.modelTokens()));
    });
}
