/** Composes every /api route into one Router. Reachable only through the tunnel
 *  (registry/tunnel.ts) — no HTTP listener attaches this router directly (see http/listeners.ts). */

import type { GatewayCore } from "../core.ts";
import { registerAgents } from "./agents.ts";
import { registerApprovals } from "./approvals.ts";
import { registerApps } from "./apps.ts";
import { registerChats } from "./chats.ts";
import { registerDevices } from "./devices.ts";
import { registerEvents } from "./events.ts";
import { registerInbox } from "./inbox.ts";
import { registerInteractions } from "./interactions.ts";
import { registerLimits } from "./limits.ts";
import { registerModels } from "./models.ts";
import { registerModelsPolicy } from "./models-policy.ts";
import { registerPins } from "./pins.ts";
import { registerRooms } from "./rooms.ts";
import { json, Router } from "./router.ts";
import { registerStats } from "./stats.ts";
import { registerTurns } from "./turns.ts";

export function healthPayload(core: GatewayCore): Record<string, unknown> {
    return { ok: true, pid: process.pid, uptimeSec: Math.round(process.uptime()), channelId: core.devices.channelId };
}

export function buildRouter(core: GatewayCore): Router {
    const router = new Router();
    router.get("/api/health", (ctx) => json(ctx.res, 200, healthPayload(core)));
    registerModels(router, core.db);
    registerStats(router, core.db);
    registerLimits(router, core);
    registerAgents(router, core);
    registerApprovals(router, core);
    registerModelsPolicy(router, core);
    registerPins(router, core);
    registerEvents(router, core);
    registerInbox(router, core);
    registerInteractions(router, core);
    registerChats(router, core);
    registerTurns(router, core);
    registerRooms(router, core);
    registerApps(router, core);
    registerDevices(router, core);
    return router;
}
