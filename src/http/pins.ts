/** The pinned agent keys: list, block, patch perms, revoke. Pins are created by redeeming an
 *  agent invite (http/devices.ts); devices and their approvals live there too. */

import type { PinPerms } from "@mimi-os/protocol";

import type { GatewayCore } from "../core.ts";
import type { PinCard } from "../registry/admission.ts";
import { json, readBody, type Ctx, type Router } from "./router.ts";

/** A PATCH names the flags it changes; the ones it leaves out keep the value they had. */
function mergePerms(current: PinPerms, raw: unknown): PinPerms | null {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const p = raw as Record<string, unknown>;
    const keys = Object.keys(p);
    if (keys.length === 0 || keys.some((key) => key !== "delegate" && key !== "discoverable")) return null;
    const pick = (key: keyof PinPerms): boolean | null => {
        const v = p[key];
        return v === undefined ? current[key] : typeof v === "boolean" ? v : null;
    };
    const delegate = pick("delegate");
    const discoverable = pick("discoverable");
    if (delegate === null || discoverable === null) return null;
    return {
        delegate,
        discoverable,
    };
}

const withLive = (core: GatewayCore, card: PinCard): PinCard & { connected: boolean } => ({
    ...card,
    connected: core.registry.get(card.name) !== undefined,
});

const missing = (ctx: Ctx, name: string): void =>
    json(ctx.res, 404, { error: `no pin for "${name}"` });

export function registerPins(router: Router, core: GatewayCore): void {
    router.get("/api/pins", (ctx) => json(ctx.res, 200, core.registry.pins().map((p) => withLive(core, p))));

    // block: every channel session of the key and the agent's app sessions end with it
    router.post("/api/pins/:pin/block", (ctx) => {
        const name = ctx.param("pin");
        const card = core.registry.block(name);
        core.devices.closeAgent(name);
        core.appTickets.closeAgent(name);
        return card ? json(ctx.res, 200, withLive(core, card)) : missing(ctx, name);
    });

    router.patch("/api/pins/:pin", async (ctx) => {
        const name = ctx.param("pin");
        const current = core.registry.pin(name);
        if (!current) return missing(ctx, name);
        const body = await readBody(ctx.req);
        const perms = mergePerms(current.perms, body["perms"]);
        if (!perms) return json(ctx.res, 400, { error: "perms must contain boolean flags" });
        const card = core.registry.setPerms(name, perms);
        return card ? json(ctx.res, 200, withLive(core, card)) : missing(ctx, name);
    });

    // revoke: the pin goes, its sessions and app sessions with it, and the next connect is rejected
    router.delete("/api/pins/:pin", (ctx) => {
        const name = ctx.param("pin");
        if (!core.registry.revoke(name)) return missing(ctx, name);
        core.devices.closeAgent(name);
        core.appTickets.closeAgent(name);
        return json(ctx.res, 200, { ok: true, revoked: name });
    });
}
