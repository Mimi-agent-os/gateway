/** The turn surface: POST …/messages (ndjson), GET …/stream (re-attach), stop. Gates are answered at /api/approvals. */

import { isImageDataUri, MAX_IMAGE_BYTES, MAX_IMAGES } from "@mimi-os/protocol";

import type { GatewayCore } from "../core.ts";
import type { TurnOutcome, TurnRequest } from "../turn/loop-types.ts";
import type { TurnRun } from "../turn/run.ts";
import { json, readBody, type Ctx, type Router } from "./router.ts";

const NDJSON = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" };

/** A message's words, in UTF-8 bytes. */
const MAX_TEXT_BYTES = 1_000_000;
/** 32 images of 480 000 chars, the text and the JSON around them: the stored event stays under MAX_EVENT_BYTES. */
const MAX_BODY_BYTES = 16_400_000;
/** Turn bodies read at once across the gateway: each holds about four copies of itself while it parses. */
const MAX_UPLOADS = 2;
let uploads = 0;
/** A phone gone off the network leaves its stream open: an upload silent this long gives its slot back. */
const UPLOAD_IDLE_MS = 30_000;

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
        // all before the body: nothing may await ahead of readBody, or the tunnel resets an unread upload at 256 KiB
        if (core.turns.get(agent, session)) return json(ctx.res, 409, { error: "a turn is already running in this chat" });
        if (uploads >= MAX_UPLOADS) return json(ctx.res, 429, { error: "two other messages are still uploading; send this one again in a moment" });
        uploads++;
        let body: Record<string, unknown>;
        try {
            body = await readBody(ctx.req, MAX_BODY_BYTES, UPLOAD_IDLE_MS);
        } finally {
            uploads--;
        }
        const rawText = body["text"];
        if (typeof rawText === "string" && Buffer.byteLength(rawText, "utf8") > MAX_TEXT_BYTES) {
            return json(ctx.res, 400, { error: `the text of one message must be at most ${MAX_TEXT_BYTES} bytes` });
        }
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
            if (rawImages.some((u: string) => u.length > MAX_IMAGE_BYTES)) {
                return json(ctx.res, 400, { error: `each image must be at most ${MAX_IMAGE_BYTES} bytes` });
            }
            images = rawImages;
        }
        // images alone are a message (the model gets image parts only); neither words nor images is not
        if (!text && !images?.length) return json(ctx.res, 400, { error: "pass { text } or { images }" });
        // a turn may have started while this body was read
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
