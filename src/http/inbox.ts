import type { GatewayCore } from "../core.ts";
import type { InboxItemRow } from "../store/db.ts";
import { json, pageOf, type Ctx, type Router } from "./router.ts";

const PREVIEW_MAX = 280;

const toPreview = (body: string): string =>
    body
        .replace(/^ {0,3}(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
        .replace(/`+|\*\*|~~/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, PREVIEW_MAX);

const toCard = (row: InboxItemRow): Record<string, unknown> => ({
    id: row.id,
    source: row.source,
    agent: row.agent,
    title: row.title,
    preview: toPreview(row.body),
    level: row.level,
    target: row.target ?? null,
    createdAt: row.createdAt,
    readAt: row.readAt,
});

const notFound = (ctx: Ctx): void => json(ctx.res, 404, { error: "no such inbox item" });

export function registerInbox(router: Router, core: GatewayCore): void {
    const discussions = new Map<number, Promise<number>>();

    router.get("/api/inbox", (ctx: Ctx) => {
        const paging = pageOf(ctx.url.searchParams, 50);
        if (typeof paging === "string") return json(ctx.res, 400, { error: paging });
        const { items, hasMore } = core.db.listInbox({
            limit: paging.limit,
            before: paging.before,
            unread: ctx.url.searchParams.get("unread") === "1",
        });
        return json(ctx.res, 200, { items: items.map(toCard), unread: core.db.countUnread(), hasMore });
    });

    router.get("/api/inbox/:item", (ctx: Ctx) => {
        const row = core.db.getInboxItem(Number(ctx.param("item")));
        return row ? json(ctx.res, 200, { ...toCard(row), body: row.body }) : notFound(ctx);
    });

    router.post("/api/inbox/:item/read", (ctx: Ctx) => {
        if (!core.db.markInboxRead(Number(ctx.param("item")))) return notFound(ctx);
        core.events.emit({ type: "inbox_changed", unread: core.db.countUnread() });
        return json(ctx.res, 200, { ok: true });
    });

    router.post("/api/inbox/read-all", (ctx: Ctx) => {
        const marked = core.db.markAllInboxRead();
        core.events.emit({ type: "inbox_changed", unread: core.db.countUnread() });
        return json(ctx.res, 200, { ok: true, marked });
    });

    router.delete("/api/inbox/:item", (ctx: Ctx) => {
        if (!core.db.deleteInboxItem(Number(ctx.param("item")))) return notFound(ctx);
        core.events.emit({ type: "inbox_changed", unread: core.db.countUnread() });
        return json(ctx.res, 200, { ok: true });
    });

    router.post("/api/inbox/:item/discuss", async (ctx: Ctx) => {
        const id = Number(ctx.param("item"));
        const row = core.db.getInboxItem(id);
        if (!row) return notFound(ctx);
        if (!row.agent) return json(ctx.res, 409, { error: "this item has no agent to discuss with" });
        const agent = row.agent;
        if (row.target?.kind === "chat" && row.target.session !== undefined) {
            return json(ctx.res, 200, { agent, conversation: row.target.session });
        }
        const peer = core.registry.get(agent);
        if (!peer) return json(ctx.res, 409, { error: `agent "${agent}" is not connected` });
        let discussion = discussions.get(id);
        if (!discussion) {
            discussion = (async () => {
                const head = await core.session.create(agent, { title: row.title, titleByUser: true });
                await peer.request("append", {
                    session: head.session,
                    events: [
                        {
                            type: "message",
                            payload: {
                                role: "assistant",
                                content: row.body,
                                meta: { actor: { kind: "agent", agent } },
                            },
                        },
                    ],
                });
                core.db.setInboxTarget(id, { kind: "chat", agent, session: head.session });
                core.db.markInboxRead(id);
                core.events.emit({ type: "chat_changed", agent, session: head.session });
                core.events.emit({ type: "inbox_changed", unread: core.db.countUnread() });
                return head.session;
            })().finally(() => discussions.delete(id));
            discussions.set(id, discussion);
        }
        try {
            const conversation = await discussion;
            return json(ctx.res, 200, { agent, conversation });
        } catch (e) {
            return json(ctx.res, 409, { error: (e as Error).message });
        }
    });
}
