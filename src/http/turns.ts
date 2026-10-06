/** The turn surface: POST …/messages (ndjson), GET …/stream (re-attach), stop. Gates are answered at /api/approvals. */

import { isImageDataUri } from "@mimi-os/protocol";

import type { GatewayCore } from "../core.ts";
import type { TurnOutcome, TurnRequest } from "../turn/loop-types.ts";
import type { TurnRun } from "../turn/run.ts";
import { json, readBody, type Ctx, type Router } from "./router.ts";

const NDJSON = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" };

/** Wire contract: 4 inline images and 750 000 data-URI bytes per message, read in the 1 MB body default, so the append fits one 1 MiB channel frame. */
const MAX_IMAGES = 4;
const MAX_IMAGES_BYTES = 750_000;

export async function streamTurn(
    ctx: Ctx,
    core: GatewayCore,
    request: TurnRequest,
    extra?: (outcome: TurnOutcome, signal: AbortSignal) => Record<string, unknown>,
): Promise<void> {
    const run = core.turns.start(request, (outcome, signal) => ({
        type: "done", answer: outcome.text, ...extra?.(outcome, signal), ...outcome.metrics,
    }));
    reattach(ctx, run);
    await run.finished;
}

export function reattach(ctx: Ctx, run: TurnRun): void {
    ctx.res.writeHead(200, NDJSON);
    const detach = run.attach((event) => { ctx.res.write(`${JSON.stringify(event)}\n`); });
    ctx.res.on("close", detach);
    void run.finished.then(() => ctx.res.end());
}

export function registerTurns(router: Router, core: GatewayCore): void {
    router.post("/api/agents/:agent/conversations/:session/messages", async (ctx) => {
        const agent = ctx.param("agent");
        const session = Number(ctx.param("session"));
        if (!core.registry.get(agent)) return json(ctx.res, 503, { error: `agent "${agent}" is not connected` });
        const body = await readBody(ctx.req);
        const rawText = body["text"];
        const text = typeof rawText === "string" ? rawText.trim() : "";

        const rawImages = body["images"];
        let images: string[] | undefined;
        if (rawImages !== undefined) {
            if (!Array.isArray(rawImages) || rawImages.some((u) => typeof u !== "string" || !isImageDataUri(u))) {
                return json(ctx.res, 400, { error: '"images" must be an array of base64 png/jpeg/gif/webp data URIs' });
            }
            if (rawImages.length > MAX_IMAGES) {
                return json(ctx.res, 400, { error: `at most ${MAX_IMAGES} images per message` });
            }
            // a data URI is ASCII, so its length is its byte count
            if (rawImages.reduce((n: number, u: string) => n + u.length, 0) > MAX_IMAGES_BYTES) {
                return json(ctx.res, 400, { error: `the images of one message must total at most ${MAX_IMAGES_BYTES} bytes` });
            }
            images = rawImages;
        }
        // images alone are a message (the model gets image parts only); neither words nor images is not
        if (!text && !images?.length) return json(ctx.res, 400, { error: "pass { text } or { images }" });

        if (core.turns.get(agent, session)) return json(ctx.res, 409, { error: "a turn is already running in this chat" });
        // the one route a person types into: only it can vouch that a human authored this
        await streamTurn(ctx, core, { agent, session, text, images, actor: { kind: "human" }, attended: true });
    });

    router.get("/api/agents/:agent/conversations/:session/stream", (ctx) => {
        const run = core.turns.get(ctx.param("agent"), Number(ctx.param("session")));
        if (!run) return json(ctx.res, 409, { error: "this chat is not generating" });
        reattach(ctx, run);
    });

    router.post("/api/agents/:agent/conversations/:session/stop", (ctx) => {
        const agent = ctx.param("agent");
        const session = Number(ctx.param("session"));
        const run = core.turns.get(agent, session);
        if (!run) return json(ctx.res, 200, { ok: true, stopped: false });
        run.stop();
        return json(ctx.res, 200, { ok: true, stopped: true });
    });
}
