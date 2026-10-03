import { isAgentName } from "@mimi-os/protocol";

import type { GatewayCore } from "../core.ts";
import type { RoomRow } from "../store/db.ts";
import { normalizeTitle } from "../turn/autotitle.ts";
import { publishRoomMessage, roomProjection } from "../turn/rooms.ts";
import { reattach, streamTurn } from "./turns.ts";
import { isoStamp, json, pageOf, readBody, type Ctx, type Router } from "./router.ts";

/** The room as every read serves it: `busy` is the live turn, and only a live turn has one. */
function card(core: GatewayCore, row: RoomRow): Record<string, unknown> {
    const run = core.turns.room(row.id);
    return {
        id: row.id,
        title: row.title,
        participants: row.participants,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        busy: run ? { agent: run.agent, since: isoStamp(run.startedAt) } : undefined,
    };
}

export function registerRooms(router: Router, core: GatewayCore): void {
    const serve = (ctx: Ctx, room: string): void => {
        const row = core.db.getRoom(room);
        if (!row) return json(ctx.res, 404, { error: "no such room" });
        return json(ctx.res, 200, { room: card(core, row) });
    };

    router.post("/api/rooms", async (ctx) => {
        const body = await readBody(ctx.req);
        const rawTitle = body["title"];
        if (rawTitle !== undefined && typeof rawTitle !== "string") {
            return json(ctx.res, 400, { error: "title must be a string" });
        }
        const title = normalizeTitle(rawTitle ?? "");
        const row = core.db.createRoom(title || null);
        core.events.emit({ type: "room_changed", room: row.id });
        return json(ctx.res, 201, { room: card(core, row) });
    });

    router.get("/api/rooms", (ctx) => json(ctx.res, 200, { rooms: core.db.listRooms().map((row) => card(core, row)) }));

    router.get("/api/rooms/:room", (ctx) => serve(ctx, ctx.param("room")));

    // membership is explicit and grants exactly this room's published history — nothing else
    router.post("/api/rooms/:room/participants", async (ctx) => {
        const room = ctx.param("room");
        if (!core.db.hasRoom(room)) return json(ctx.res, 404, { error: "no such room" });
        const body = await readBody(ctx.req);
        const agent = body["agent"];
        if (typeof agent !== "string" || !isAgentName(agent)) {
            return json(ctx.res, 400, { error: "pass { agent }" });
        }
        if (core.registry.statusOf(agent) !== "approved") {
            return json(ctx.res, 403, { error: `agent "${agent}" is not approved` });
        }
        if (core.db.addRoomParticipant(room, agent)) core.events.emit({ type: "room_changed", room });
        return serve(ctx, room);
    });

    router.delete("/api/rooms/:room/participants/:agent", (ctx) => {
        const room = ctx.param("room");
        if (!core.db.hasRoom(room)) return json(ctx.res, 404, { error: "no such room" });
        if (core.db.removeRoomParticipant(room, ctx.param("agent"))) core.events.emit({ type: "room_changed", room });
        return serve(ctx, room);
    });

    router.get("/api/rooms/:room/messages", (ctx) => {
        const room = ctx.param("room");
        if (!core.db.hasRoom(room)) return json(ctx.res, 404, { error: "no such room" });
        const paging = pageOf(ctx.url.searchParams, 60);
        if (typeof paging === "string") return json(ctx.res, 400, { error: paging });
        const { limit, before } = paging;
        const rows = core.db.listRoomEvents(room, limit, before);
        return json(ctx.res, 200, {
            messages: rows.messages.map((m) => ({
                seq: m.seq,
                author: m.author,
                text: m.text,
                createdAt: m.createdAt,
                meta: m.meta,
            })),
            hasMore: rows.hasMore,
        });
    });

    // `to` is the ONE router: a literal "@name" in the text invokes nobody
    router.post("/api/rooms/:room/messages", async (ctx) => {
        const room = ctx.param("room");
        if (!core.db.hasRoom(room)) return json(ctx.res, 404, { error: "no such room" });
        const body = await readBody(ctx.req);
        const rawText = body["text"];
        const text = typeof rawText === "string" ? rawText.trim() : "";
        if (!text) return json(ctx.res, 400, { error: "pass { text }" });
        const rawTo = body["to"];
        if (rawTo !== undefined && rawTo !== null && typeof rawTo !== "string") {
            return json(ctx.res, 400, { error: '"to" must be an agent name or null' });
        }
        const to = rawTo ?? null;
        if (to === null) {
            const human = publishRoomMessage(core.db, core.events, room, { kind: "human" }, text);
            return json(ctx.res, 200, { seq: human.seq });
        }
        if (!core.db.hasRoomParticipant(room, to)) {
            return json(ctx.res, 400, { error: `agent "${to}" is not a participant of this room` });
        }
        const run = core.turns.room(room);
        // one live turn per room: an explicit conflict, never a second turn on the same transcript
        if (run) {
            return json(ctx.res, 409, { error: "a turn is already running in this room", busy: { agent: run.agent, since: isoStamp(run.startedAt) } });
        }
        // refused BEFORE the append: a routed send that cannot run leaves no message behind
        if (!core.registry.get(to)) return json(ctx.res, 409, { error: `agent "${to}" is not connected` });

        // published first, and only then is the room busy: a write that fails strands no turn
        publishRoomMessage(core.db, core.events, room, { kind: "human" }, text);
        await streamTurn(
            ctx,
            core,
            // the projection already carries this line, under the author the append vouched for
            { agent: to, session: null, room: { room, history: () => roomProjection(core.db, room, to) }, text, attended: true },
            (outcome, signal) => {
                const answer = outcome.text.trim();
                // ONE deliberate append per turn — and a stopped turn publishes nothing at all
                if (!answer || signal.aborted) return {};
                const meta = outcome.metrics
                    ? { callId: outcome.metrics.finalCallId, registryModel: outcome.metrics.registryModel }
                    : null;
                return { seq: publishRoomMessage(core.db, core.events, room, { kind: "agent", agent: to }, answer, meta).seq };
            },
        );
    });

    router.get("/api/rooms/:room/stream", (ctx) => {
        const run = core.turns.room(ctx.param("room"));
        if (!run) return json(ctx.res, 409, { error: "this room is not generating" });
        reattach(ctx, run);
    });

    router.post("/api/rooms/:room/stop", (ctx) => {
        const room = ctx.param("room");
        const run = core.turns.room(room);
        if (!run) return json(ctx.res, 200, { ok: true, stopped: false });
        run.stop();
        return json(ctx.res, 200, { ok: true, stopped: true });
    });
}
