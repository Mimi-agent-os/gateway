import type { GatewayCore } from "../core.ts";
import type { HubEvent } from "../events.ts";
import { type Ctx, type Router } from "./router.ts";

/** Long enough not to be chatty, short enough to beat any idle proxy in between. */
const HEARTBEAT_MS = 25_000;

export function registerEvents(router: Router, core: GatewayCore): void {
    router.get("/api/events", (ctx: Ctx) => {
        ctx.res.writeHead(200, {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-cache",
        });
        const send = (ev: Record<string, unknown>): void => {
            ctx.res.write(`${JSON.stringify(ev)}\n`);
        };
        const off = core.events.subscribe((ev: HubEvent) => send(ev));
        if (!off) {
            send({ type: "error", message: "too many event streams are already open" });
            ctx.res.end();
            return;
        }
        // the first line goes out immediately: a client must not wait for news to know it is on
        send({ type: "ready" });
        const beat = setInterval(() => send({ type: "ping" }), HEARTBEAT_MS);
        beat.unref();
        ctx.res.on("close", () => {
            clearInterval(beat);
            off();
        });
    });
}
