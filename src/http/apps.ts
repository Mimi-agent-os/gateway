/** The app catalog and its launches: a ticket opens a session and answers the iframe's entry link. */

import type { PinStatus } from "@mimi-os/protocol";

import { APP_TICKET_PARAM } from "../apps/tickets.ts";
import type { GatewayCore } from "../core.ts";
import type { AgentAppRow } from "../store/db.ts";
import { MINI_APP_PREFIX } from "./mini-app.ts";
import { json, readBody, type Router } from "./router.ts";

/** The catalog row: everything but `available` and `status` is what the agent last declared, and survives it. */
function card(row: AgentAppRow, available: boolean, status: PinStatus | null): Record<string, unknown> {
    return {
        agent: row.agent,
        appId: row.appId,
        title: row.title,
        entry: row.entry,
        pages: row.pages,
        available,
        status,
        revision: row.revision,
        lastSeenAt: row.lastSeenAt,
    };
}

/** A launch route is a bare absolute path: no scheme, no host, nothing that leaves this app. */
const badRoute = (route: string): boolean => {
    if (!route.startsWith("/")) return true;
    try {
        return new URL(route, "http://app.invalid").host !== "app.invalid";
    } catch {
        return true;
    }
};

export function registerApps(router: Router, core: GatewayCore): void {
    router.get("/api/apps", (ctx) =>
        json(ctx.res, 200, {
            apps: core.db
                .listAgentApps()
                .map((row) => card(row, core.registry.get(row.agent) !== undefined, core.registry.statusOf(row.agent))),
        }),
    );

    router.post("/api/apps/:agent/ticket", async (ctx) => {
        const agent = ctx.param("agent");
        const body = await readBody(ctx.req);
        const requestedApp = body["appId"];
        if (requestedApp !== undefined && (typeof requestedApp !== "string" || !requestedApp)) {
            return json(ctx.res, 400, { error: "appId must be a non-empty string" });
        }
        const appId = requestedApp ?? agent;
        const row = core.db.getAgentApp(agent, appId);
        if (!row) return json(ctx.res, 404, { error: `no app "${appId}" for agent "${agent}"` });
        const raw = body["route"];
        if (raw !== undefined && raw !== null && (typeof raw !== "string" || badRoute(raw))) {
            return json(ctx.res, 400, { error: "route must be an absolute path, e.g. \"/orders/7\"" });
        }
        // an app is only ever as admitted as its agent: a pending or blocked pin launches nothing
        if (core.registry.statusOf(agent) !== "approved") return json(ctx.res, 403, { error: "agent not approved" });
        // the ticket gates the LAUNCH, and a launch of a server nobody is running is a 409
        if (!core.registry.get(agent)) return json(ctx.res, 409, { error: "agent offline" });
        const launch = core.appTickets.open(agent, row.appId, row.upstream, ctx.device);
        const route = typeof raw === "string" ? raw : (row.entry ?? "/");
        // a URL, not concatenation: `route` may carry its own query, which must not become a second "?"
        const url = new URL(`${MINI_APP_PREFIX}/${row.appId}${route}`, "http://app.invalid");
        url.searchParams.set(APP_TICKET_PARAM, launch.ticket);
        return json(ctx.res, 200, {
            // root-relative: the pult and the Tauri webview both load from the gateway's own origin
            url: `${url.pathname}${url.search}`,
            session: launch.id,
            expiresAt: launch.expiresAt,
        });
    });

    router.post("/api/apps/sessions/:appsession/renew", (ctx) => {
        const session = core.appTickets.renew(ctx.param("appsession"), ctx.device);
        if (!session) return json(ctx.res, 404, { error: "no such app session" });
        return json(ctx.res, 200, { expiresAt: session.expiresAt });
    });
}
