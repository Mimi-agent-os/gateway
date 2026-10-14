import { projectMessage, truncateCut } from "@mimi-os/protocol";
import type {
    EventBody,
    MessageMeta,
    SessionSummary,
    StoredEvent,
} from "@mimi-os/protocol";

import type { GatewayCore } from "../core.ts";
import type { CacheEntry } from "../turn/sessions.ts";
import { normalizeTitle } from "../turn/autotitle.ts";
import { compactSession } from "../turn/compact-now.ts";
import { isoStamp, json, pageOf, readBody, type Router } from "./router.ts";

interface HistoryMessageWire {
    id: number;
    role: string;
    content: string;
    /** How many images the message carries: their pixels come from …/messages/:id/images. */
    images?: number | undefined;
    thinking?: string | undefined;
    toolCalls?: { id: string; name: string; arguments: string }[] | undefined;
    toolCallId?: string | undefined;
    summary?: true;
    /** Verbatim from the hashed payload; absent on events agents append themselves — which means
     *  unknown, and is never filled in from the role, the text or the timestamp. */
    meta?: MessageMeta | undefined;
    at: string;
}

/** A payload the agent wrote past the SDK reaches here unvalidated — no field is read before the
 *  same `projectMessage` the model path uses has narrowed it. */
function toHistoryMessage(ev: StoredEvent, entry: CacheEntry): HistoryMessageWire | null {
    const raw = ev.payload as { summary?: unknown; thinking?: unknown; meta?: unknown } | null | undefined;
    if (ev.type === "compaction") {
        const summary = raw?.summary;
        if (typeof summary !== "string") return null;
        return {
            id: ev.seq,
            role: "assistant",
            content: summary,
            summary: true,
            at: isoStamp(ev.createdAt),
        };
    }
    const message = projectMessage(ev.payload);
    if (!message) return null;
    // the pult renders these fields straight into its tree, where a non-string throws mid-render and
    // blanks the page: every field MessageMeta declares is narrowed, anything else stays unknown
    const rawMeta = raw?.meta;
    const fields = (typeof rawMeta === "object" && rawMeta !== null ? rawMeta : {}) as Record<string, unknown>;
    const rawActor = fields["actor"];
    const actor = (typeof rawActor === "object" && rawActor !== null ? rawActor : {}) as Record<string, unknown>;
    const meta: MessageMeta = {};
    if (typeof fields["callId"] === "string") meta.callId = fields["callId"];
    if (typeof fields["registryModel"] === "string") meta.registryModel = fields["registryModel"];
    const kind = actor["kind"];
    if (kind === "human" || kind === "agent" || kind === "system") {
        meta.actor = { kind };
        if (typeof actor["agent"] === "string") meta.actor.agent = actor["agent"];
    }
    return {
        id: ev.seq,
        role: message.role,
        content: message.content ?? "",
        images: entry.images.get(ev.seq),
        thinking: typeof raw?.thinking === "string" ? raw.thinking : undefined,
        toolCalls: message.tool_calls,
        toolCallId: message.tool_call_id,
        meta: Object.keys(meta).length > 0 ? meta : undefined,
        at: isoStamp(ev.createdAt),
    };
}

export function registerChats(router: Router, core: GatewayCore): void {
    router.get("/api/agents/:agent/conversations", async (ctx) => {
        const agent = ctx.param("agent");
        const includeArchived = ctx.url.searchParams.get("all") === "1";
        let sessions: Omit<SessionSummary, "head">[];
        try {
            sessions = await core.session.list(agent, includeArchived);
        } catch (e) {
            return json(ctx.res, 503, { error: (e as Error).message });
        }
        const gated = new Set(
            core.gates
                .pending()
                .filter((g) => g.agent === agent)
                .map((g) => g.session),
        );
        return json(
            ctx.res,
            200,
            sessions.map((s) => ({
                id: s.session,
                title: s.title,
                titleByUser: s.titleByUser,
                archived: s.archived,
                pinned: s.pinned,
                createdAt: isoStamp(s.createdAt),
                updatedAt: isoStamp(s.updatedAt),
                messages: s.events,
                busy: core.turns.get(agent, s.session) !== undefined,
                awaitingApproval: gated.has(s.session),
                activeTurnSeq: core.turns.get(agent, s.session)?.activeTurnSeq,
            })),
        );
    });

    router.post("/api/agents/:agent/conversations", async (ctx) => {
        const agent = ctx.param("agent");
        try {
            const head = await core.session.create(agent);
            return json(ctx.res, 201, { id: head.session });
        } catch (e) {
            return json(ctx.res, 503, { error: (e as Error).message });
        }
    });

    router.patch("/api/agents/:agent/conversations/:session", async (ctx) => {
        const agent = ctx.param("agent");
        const session = Number(ctx.param("session"));
        const body = await readBody(ctx.req);
        const patch: { session: number; title?: string; titleByUser?: boolean; archived?: boolean; pinned?: boolean } = {
            session,
        };
        const rawTitle = body["title"];
        if (rawTitle !== undefined) {
            if (typeof rawTitle !== "string") return json(ctx.res, 400, { error: "title must be a string" });
            const title = normalizeTitle(rawTitle);
            if (!title) return json(ctx.res, 400, { error: "title must not be empty" });
            patch.title = title;
            patch.titleByUser = true; // a human naming their chat is final — the guard the SDK enforces
        }
        const archived = body["archived"];
        if (archived !== undefined) {
            if (typeof archived !== "boolean") return json(ctx.res, 400, { error: "archived must be a boolean" });
            patch.archived = archived;
        }
        const pinned = body["pinned"];
        if (pinned !== undefined) {
            if (typeof pinned !== "boolean") return json(ctx.res, 400, { error: "pinned must be a boolean" });
            patch.pinned = pinned;
        }
        if (Object.keys(patch).length === 1) return json(ctx.res, 400, { error: "nothing to change" });
        try {
            const applied = await core.session.update(agent, patch);
            return json(ctx.res, 200, { ok: applied });
        } catch (e) {
            return json(ctx.res, 503, { error: (e as Error).message });
        }
    });

    router.delete("/api/agents/:agent/conversations/:session", async (ctx) => {
        const agent = ctx.param("agent");
        const session = Number(ctx.param("session"));
        try {
            await core.session.remove(agent, session);
            return json(ctx.res, 200, { ok: true });
        } catch (e) {
            return json(ctx.res, 503, { error: (e as Error).message });
        }
    });

    router.get("/api/agents/:agent/conversations/:session/messages", async (ctx) => {
        const agent = ctx.param("agent");
        const session = Number(ctx.param("session"));
        const paging = pageOf(ctx.url.searchParams, 60);
        if (typeof paging === "string") return json(ctx.res, 400, { error: paging });
        const { limit, before } = paging;
        let entry: CacheEntry;
        try {
            entry = await core.sessions.ensure(agent, session);
        } catch (e) {
            return json(ctx.res, 503, { error: (e as Error).message });
        }
        // the same truncate cuts protocol's foldEvents applies
        const cuts = entry.events.flatMap((e) => truncateCut(e) ?? []);
        // compaction-archived raw rows are still served unflagged; a pass that only described images shows nothing
        const rows = entry.events.filter(
            (e) =>
                (e.type === "message" || (e.type === "compaction" && typeof (e.payload as { summary?: unknown } | null)?.summary === "string")) &&
                !cuts.some((c) => e.seq >= c.from && e.seq < c.at),
        );
        const upper = before === undefined ? rows : rows.filter((r) => r.seq < before);
        const page = upper.slice(Math.max(0, upper.length - limit));
        return json(ctx.res, 200, {
            items: page.flatMap((e) => toHistoryMessage(e, entry) ?? []),
            hasMore: upper.length > page.length,
        });
    });

    router.get("/api/agents/:agent/conversations/:session/messages/:id/images", async (ctx) => {
        const agent = ctx.param("agent");
        const session = Number(ctx.param("session"));
        const seq = Number(ctx.param("id"));
        // a reader that leaves gives up its place among the agent reads the cache lets through
        const left = new AbortController();
        ctx.res.once("close", () => left.abort(new Error("the reader left")));
        let entry: CacheEntry;
        try {
            entry = await core.sessions.ensure(agent, session, left.signal);
        } catch (e) {
            if (!left.signal.aborted) json(ctx.res, 503, { error: (e as Error).message });
            return;
        }
        if (!entry.images.get(seq)) return json(ctx.res, 404, { error: "this message has no images" });
        let images: string[];
        try {
            images = await core.sessions.images(entry, seq, left.signal);
        } catch (e) {
            if (!left.signal.aborted) json(ctx.res, 503, { error: (e as Error).message });
            return;
        }
        // one data-URI per write: a single 15 MB end() would sit queued past the channel's stall deadline on a slow device
        ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        ctx.res.write('{"images":[');
        for (const [i, uri] of images.entries()) {
            if (left.signal.aborted) return;
            if (ctx.res.write(`${i ? "," : ""}${JSON.stringify(uri)}`)) continue;
            await new Promise<void>((on) => {
                const go = (): void => {
                    ctx.res.off("drain", go);
                    ctx.res.off("close", go);
                    on();
                };
                ctx.res.on("drain", go);
                ctx.res.on("close", go);
            });
        }
        if (!left.signal.aborted) ctx.res.end("]}");
    });

    router.post("/api/agents/:agent/conversations/:session/truncate", async (ctx) => {
        const agent = ctx.param("agent");
        const session = Number(ctx.param("session"));
        const body = await readBody(ctx.req);
        const messageId = body["messageId"];
        if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId < 1) {
            return json(ctx.res, 400, { error: "pass { messageId }" });
        }
        if (core.turns.get(agent, session)) return json(ctx.res, 409, { error: "a turn is running in this chat" });
        const peer = core.registry.get(agent);
        if (!peer) return json(ctx.res, 503, { error: `agent "${agent}" is not connected` });
        const event: EventBody = { type: "truncate", payload: { fromSeq: messageId } };
        try {
            const ok = await peer.request("append", { session, events: [event] });
            // append-only: nothing is deleted, the cut point just stops being read; replayed, never reloaded
            core.sessions.applyAppend(agent, session, [event], ok.head);
        } catch (e) {
            return json(ctx.res, 502, { error: (e as Error).message });
        }
        core.events.emit({ type: "chat_changed", agent, session });
        return json(ctx.res, 200, { ok: true });
    });

    router.post("/api/agents/:agent/conversations/:session/compact", async (ctx) => {
        const agent = ctx.param("agent");
        const session = Number(ctx.param("session"));
        if (!Number.isSafeInteger(session) || session < 1) return json(ctx.res, 400, { error: "bad session" });
        if (core.turns.get(agent, session)) return json(ctx.res, 409, { error: "a turn is running in this chat" });
        if (!core.registry.get(agent)) return json(ctx.res, 503, { error: `agent "${agent}" is not connected` });
        try {
            const result = await compactSession(core, agent, session);
            return json(ctx.res, 200, result);
        } catch (e) {
            return json(ctx.res, 502, { error: (e as Error).message });
        }
    });
}
