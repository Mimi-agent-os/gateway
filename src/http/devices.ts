/** The paired-device plane over REST: invites (device + agent), the device list, approve / reject
 *  / revoke, approve mode, a device's own push token. Reachable only through an ACTIVE device's tunnel. */

import { isAgentName } from "@mimi-os/protocol";

import type { GatewayCore } from "../core.ts";
import type { DeviceDecision } from "../registry/devices.ts";
import { isoStamp, json, readBody, type Ctx, type Router } from "./router.ts";

/** What an FCM registration token is made of, with room to spare over today's ~160 chars. */
const FCM_TOKEN = /^[\w:-]{1,1024}$/;

const answer = (ctx: Ctx, d: DeviceDecision): void =>
    d.ok ? json(ctx.res, 200, { ok: true }) : json(ctx.res, d.status, { error: d.error });

export function registerDevices(router: Router, core: GatewayCore): void {
    router.post("/api/devices/invite", (ctx) => {
        const invite = core.devices.createDeviceInvite();
        json(ctx.res, 200, { uri: invite.uri, id: invite.id, expiresAt: isoStamp(invite.expiresAt) });
    });

    router.post("/api/agent-invites", async (ctx) => {
        const body = await readBody(ctx.req);
        const name = body["name"];
        if (typeof name !== "string" || !isAgentName(name)) {
            return json(ctx.res, 400, { error: "name must be a valid agent name" });
        }
        const invite = core.devices.createAgentInvite(name);
        json(ctx.res, 200, { uri: invite.uri, id: invite.id, name, expiresAt: isoStamp(invite.expiresAt) });
    });

    router.get("/api/agent-invites", (ctx) =>
        json(ctx.res, 200, {
            invites: core.devices.listAgentInvites().map((i) => ({ name: i.name, id: i.id, expiresAt: isoStamp(i.expiresAt) })),
        }),
    );

    router.delete("/api/agent-invites/:invite", (ctx) => {
        const ok = core.devices.cancelAgentInvite(ctx.param("invite"));
        if (!ok) return json(ctx.res, 404, { error: "no such agent invite" });
        json(ctx.res, 200, { ok: true });
    });

    router.get("/api/devices", (ctx) => json(ctx.res, 200, { devices: core.devices.list() }));

    router.get("/api/devices/settings", (ctx) => json(ctx.res, 200, { approveMode: core.devices.approveMode() }));

    router.post("/api/devices/settings", async (ctx) => {
        const body = await readBody(ctx.req);
        const mode = body["approveMode"];
        if (mode !== "tap" && mode !== "code") return json(ctx.res, 400, { error: 'approveMode must be "tap" or "code"' });
        core.devices.setApproveMode(mode);
        json(ctx.res, 200, { approveMode: core.devices.approveMode() });
    });

    router.post("/api/devices/:device/approve", async (ctx) => {
        const body = await readBody(ctx.req);
        const code = body["code"];
        if (code !== undefined && typeof code !== "string") return json(ctx.res, 409, { error: "the code must be a string" });
        answer(ctx, core.devices.approve(ctx.param("device"), code));
    });

    router.post("/api/devices/:device/reject", (ctx) => answer(ctx, core.devices.reject(ctx.param("device"))));

    router.post("/api/devices/:device/revoke", (ctx) => answer(ctx, core.devices.revoke(ctx.param("device"))));

    router.put("/api/devices/me/push", async (ctx) => {
        if (!ctx.device) return json(ctx.res, 403, { error: "only a paired device has a push token" });
        const token = (await readBody(ctx.req))["token"];
        if (typeof token !== "string" || !FCM_TOKEN.test(token)) {
            return json(ctx.res, 400, { error: "token must be an FCM registration token" });
        }
        core.db.setDevicePush(ctx.device, token);
        json(ctx.res, 200, { ok: true });
    });

    router.delete("/api/devices/me/push", (ctx) => {
        if (!ctx.device) return json(ctx.res, 403, { error: "only a paired device has a push token" });
        core.db.deleteDevicePush(ctx.device);
        json(ctx.res, 200, { ok: true });
    });
}
