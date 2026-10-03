/** The Inbox: the store's insert, list, unread accounting, caps and target, and the discuss route. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NotifyTarget } from "@mimi-os/protocol";

import { GatewayDb } from "../src/store/db.ts";
import { boot, waitFor } from "./harness-env.ts";

function freshDb(): { db: GatewayDb; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "mimi-inbox-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    return {
        db,
        cleanup: () => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

test("insert stores every field, and reads it back unread", () => {
    const { db, cleanup } = freshDb();
    try {
        const target: NotifyTarget = { kind: "app", agent: "mate", route: "/status" };
        const row = db.insertInboxItem({
            source: "agent",
            agent: "mate",
            title: "Digest ready",
            body: "**bold** details",
            level: "warn",
            target,
        });
        assert.equal(row.source, "agent");
        assert.equal(row.agent, "mate");
        assert.equal(row.title, "Digest ready");
        assert.equal(row.body, "**bold** details");
        assert.equal(row.level, "warn");
        assert.deepEqual(row.target, target);
        assert.equal(row.readAt, null);

        const fetched = db.getInboxItem(row.id);
        assert.deepEqual(fetched, row);
        assert.equal(db.getInboxItem(row.id + 999), null);
    } finally {
        cleanup();
    }
});

test("a system item carries no agent, and defaults land as expected", () => {
    const { db, cleanup } = freshDb();
    try {
        const row = db.insertInboxItem({ source: "system", title: "New device awaiting approval: pad" });
        assert.equal(row.source, "system");
        assert.equal(row.agent, null);
        assert.equal(row.body, "");
        assert.equal(row.level, "info");
        assert.equal(row.target, undefined);
    } finally {
        cleanup();
    }
});

test("listing is newest first, and unread is counted independently of the page", () => {
    const { db, cleanup } = freshDb();
    try {
        const ids = [1, 2, 3].map(
            (n) => db.insertInboxItem({ source: "system", title: `item ${n}` }).id,
        );
        const { items, hasMore } = db.listInbox();
        assert.deepEqual(items.map((i) => i.id), [...ids].reverse());
        assert.equal(hasMore, false);
        assert.equal(db.countUnread(), 3);

        db.markInboxRead(ids[0]!);
        assert.equal(db.countUnread(), 2);
    } finally {
        cleanup();
    }
});

test("before pages backward by id, and unread=true filters to unread only", () => {
    const { db, cleanup } = freshDb();
    try {
        const ids = [1, 2, 3, 4, 5].map(
            (n) => db.insertInboxItem({ source: "system", title: `item ${n}` }).id,
        );
        const first = db.listInbox({ limit: 2 });
        assert.deepEqual(first.items.map((i) => i.id), [ids[4], ids[3]]);
        assert.equal(first.hasMore, true);

        const second = db.listInbox({ limit: 2, before: first.items[1]!.id });
        assert.deepEqual(second.items.map((i) => i.id), [ids[2], ids[1]]);
        assert.equal(second.hasMore, true);

        const third = db.listInbox({ limit: 2, before: second.items[1]!.id });
        assert.deepEqual(third.items.map((i) => i.id), [ids[0]]);
        assert.equal(third.hasMore, false);

        db.markInboxRead(ids[4]!);
        db.markInboxRead(ids[2]!);
        const unreadOnly = db.listInbox({ unread: true });
        assert.deepEqual(
            unreadOnly.items.map((i) => i.id).sort((a, b) => a - b),
            [ids[0]!, ids[1]!, ids[3]!].sort((a, b) => a - b),
        );
    } finally {
        cleanup();
    }
});

test("read is idempotent and 404-shaped for a missing item; read-all reports how many it marked", () => {
    const { db, cleanup } = freshDb();
    try {
        const a = db.insertInboxItem({ source: "system", title: "a" }).id;
        const b = db.insertInboxItem({ source: "system", title: "b" }).id;

        assert.equal(db.markInboxRead(a), true);
        assert.equal(db.getInboxItem(a)?.readAt !== null, true);
        assert.equal(db.markInboxRead(a), true); // already read — still true, not a re-stamp error
        assert.equal(db.markInboxRead(a + b + 999), false); // no such row

        const marked = db.markAllInboxRead();
        assert.equal(marked, 1); // only b was still unread
        assert.equal(db.countUnread(), 0);
        assert.equal(db.markAllInboxRead(), 0); // nothing left to mark
    } finally {
        cleanup();
    }
});

test("delete removes the row and answers false for one that is already gone", () => {
    const { db, cleanup } = freshDb();
    try {
        const id = db.insertInboxItem({ source: "system", title: "gone soon" }).id;
        assert.equal(db.deleteInboxItem(id), true);
        assert.equal(db.getInboxItem(id), null);
        assert.equal(db.deleteInboxItem(id), false);
    } finally {
        cleanup();
    }
});

test("the read-item cap trims only old READ items; unread items are never touched by it", () => {
    const { db, cleanup } = freshDb();
    try {
        const keep = 3;
        const readIds: number[] = [];
        const unreadIds: number[] = [];
        for (let n = 0; n < 6; n++) {
            const readItem = db.insertInboxItem({ source: "system", title: `r${n}` }, keep);
            db.markInboxRead(readItem.id);
            readIds.push(readItem.id);
            const unreadItem = db.insertInboxItem({ source: "system", title: `u${n}` }, keep);
            unreadIds.push(unreadItem.id);
        }
        // every unread item survives, regardless of the cap
        for (const id of unreadIds) assert.ok(db.getInboxItem(id), `unread ${id} should survive`);
        // only the newest `keep` read items survive
        const survivingRead = readIds.filter((id) => db.getInboxItem(id) !== null);
        assert.deepEqual(survivingRead, readIds.slice(-keep));
        for (const id of readIds.slice(0, -keep)) {
            assert.equal(db.getInboxItem(id), null, `old read ${id} should be trimmed`);
        }
    } finally {
        cleanup();
    }
});

test("setInboxTarget updates the stored target, including clearing it back to null", () => {
    const { db, cleanup } = freshDb();
    try {
        const id = db.insertInboxItem({ source: "agent", agent: "mate", title: "report" }).id;
        assert.equal(db.getInboxItem(id)?.target, undefined);

        const target: NotifyTarget = { kind: "chat", agent: "mate", session: 7 };
        assert.equal(db.setInboxTarget(id, target), true);
        assert.deepEqual(db.getInboxItem(id)?.target, target);

        assert.equal(db.setInboxTarget(id, null), true);
        assert.equal(db.getInboxItem(id)?.target, undefined);

        assert.equal(db.setInboxTarget(id + 999, target), false);
    } finally {
        cleanup();
    }
});

test("concurrent inbox discussions create and seed only one conversation", async (t) => {
    const env = await boot();
    t.after(() => env.stop());
    const agent = await env.connect({ name: "worker" });
    await waitFor(() => env.core.agent("worker").connected);
    const item = env.db.insertInboxItem({ source: "agent", agent: "worker", title: "Report", body: "Details" });
    const release = Promise.withResolvers<void>();
    const create = env.core.session.create;
    const calls = t.mock.method(env.core.session, "create", async (...args: Parameters<typeof create>) => {
        await release.promise;
        return create(...args);
    });
    const path = `/api/inbox/${item.id}/discuss`;
    const first = env.api<{ agent: string; conversation: number }>("POST", path);
    await waitFor(() => calls.mock.callCount() === 1);
    const second = env.api<{ agent: string; conversation: number }>("POST", path);
    await env.api("GET", `/api/inbox/${item.id}`);
    release.resolve();
    const replies = await Promise.all([first, second]);
    assert.deepEqual(replies.map((reply) => reply.status), [200, 200]);
    assert.deepEqual(replies[0]!.json, replies[1]!.json);
    assert.equal(calls.mock.callCount(), 1);
    assert.equal(agent.sessions.size, 1);
    assert.equal(agent.sessions.get(replies[0]!.json.conversation)?.events.length, 1);
    assert.equal(env.db.countUnread(), 0);
});

test("an inbox discussion can retry after conversation creation fails", async (t) => {
    const env = await boot();
    t.after(() => env.stop());
    await env.connect({ name: "worker" });
    await waitFor(() => env.core.agent("worker").connected);
    const item = env.db.insertInboxItem({ source: "agent", agent: "worker", title: "Report" });
    const create = env.core.session.create;
    const calls = t.mock.method(env.core.session, "create", () => Promise.reject(new Error("unavailable")));
    const path = `/api/inbox/${item.id}/discuss`;
    assert.equal((await env.api("POST", path)).status, 409);
    assert.equal(env.db.getInboxItem(item.id)?.target, undefined);
    calls.mock.mockImplementation(create);
    assert.equal((await env.api("POST", path)).status, 200);
});
