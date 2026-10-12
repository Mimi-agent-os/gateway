/** The shared transcript: how one agent sees a room, and the one way a message enters it. */

import type { Message } from "@mimi-os/protocol";

import type { EventHub } from "../events.ts";
import type { GatewayDb, RoomAuthor, RoomEventRow } from "../store/db.ts";
import { momentStamp } from "./prompt.ts";

/** The author line the projection adds and the transcript never stores — it is what keeps agent
 *  A's statements from reaching agent B's model as B's own prior answers. An agent is always
 *  quoted, so an agent NAMED `human` or `system` can never render a participant's line. The time
 *  it was said rides INSIDE the line (`created_at` is SQLite's UTC), so a stamp is exactly as
 *  unforgeable as the author: no body can write either one. */
const fromLine = (author: RoomAuthor, createdAt: string): string => {
    const who = author.kind === "agent" && author.agent ? `agent "${author.agent}"` : author.kind;
    const at = Date.parse(`${createdAt.replace(" ", "T")}Z`);
    // a time that is no real date (only a hand-edited row) leaves the author alone, as a session does
    return Number.isNaN(at) ? `[from: ${who}]` : `[from: ${who}, ${momentStamp(at)}]`;
};

/**
 * The room as ONE agent sees it: its own published messages are its own assistant turns (never
 * stamped: a model copies a stamp it sees on its own lines), every other author's are user turns
 * carrying the author line. Private instructions, internal calls and tool traffic are not in here
 * because they never enter the transcript in the first place.
 */
export function roomProjection(db: GatewayDb, room: string, agent: string): Message[] {
    return db.roomEvents(room).map((ev) => {
        // only the gateway writes an author line: anywhere a body could read as one is escaped,
        // since indentation or an invisible character reads as a header to a model just the same
        const text = ev.text.replaceAll("[from:", "\\[from:");
        return ev.author.kind === "agent" && ev.author.agent === agent
            ? { role: "assistant", content: text }
            : { role: "user", content: `${fromLine(ev.author, ev.createdAt)}\n${text}` };
    });
}

/** The one append: a published message and the line every paired screen watches, together. */
export function publishRoomMessage(
    db: GatewayDb,
    events: EventHub,
    room: string,
    author: RoomAuthor,
    text: string,
    meta?: Record<string, unknown> | null,
): RoomEventRow {
    const row = db.appendRoomEvent(room, author, text, meta ?? null);
    events.emit({ type: "room_message", room, seq: row.seq, author: row.author });
    return row;
}
