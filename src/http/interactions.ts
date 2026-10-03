import { isAgentName } from "@mimi-os/protocol";

import type { GatewayCore } from "../core.ts";
import type { InteractionKind, InteractionQuery } from "../store/db.ts";
import { json, type Router } from "./router.ts";

export function registerInteractions(router: Router, core: GatewayCore): void {
    router.get("/api/interactions", (ctx) => {
        const q = ctx.url.searchParams;
        const query: InteractionQuery = {};

        const agent = q.get("agent");
        if (agent !== null) {
            if (!isAgentName(agent)) return json(ctx.res, 400, { error: `"${agent}" is not an agent name` });
            query.agent = agent;
        }

        const conversation = q.get("conversation");
        if (conversation !== null) {
            const id = Number(conversation);
            if (!Number.isSafeInteger(id) || id < 1) {
                return json(ctx.res, 400, { error: "conversation must be a conversation id" });
            }
            query.conversation = id;
        }

        const kind = q.get("kind");
        if (kind !== null) {
            if (kind !== "delegate" && kind !== "a2a") {
                return json(ctx.res, 400, { error: 'kind must be "delegate" or "a2a"' });
            }
            query.kind = kind satisfies InteractionKind;
        }

        const limit = q.get("limit");
        if (limit !== null) {
            const n = Number(limit);
            if (!Number.isSafeInteger(n) || n < 1) {
                return json(ctx.res, 400, { error: "limit must be a positive integer" });
            }
            query.limit = n;
        }

        const before = q.get("before");
        if (before !== null) {
            // an unknown cursor would read as "the end": say so instead of serving an empty page
            if (!core.db.getInteraction(before)) return json(ctx.res, 404, { error: "no such interaction" });
            query.before = before;
        }

        return json(ctx.res, 200, core.db.listInteractions(query));
    });

    router.get("/api/interactions/:interaction", (ctx) => {
        const row = core.db.getInteraction(ctx.param("interaction"));
        return row ? json(ctx.res, 200, row) : json(ctx.res, 404, { error: "no such interaction" });
    });
}
