/** The shared transcript: how one agent sees a room, and the one way a message enters it. */

import type { Message } from "@mimi-os/protocol";

import type { EventHub } from "../events.ts";
import type { GatewayDb, RoomAuthor, RoomEventRow } from "../store/db.ts";

/** The author line the projection adds and the transcript never stores — it is what keeps agent
 *  A's statements from reaching agent B's model as B's own prior answers. An agent is always
 *  quoted, so an agent NAMED `human` or `system` can never render a participant's line. */
const fromLine = (author: RoomAuthor): string =>
    author.kind === "agent" && author.agent
        ? `[from: agent "${author.agent}"]`
        : `[from: ${author.kind}]`;

/**
 * The room as ONE agent sees it: its own published messages are its own assistant turns, every
 * other author's are user turns carrying the author line. Private instructions, internal calls
 * and tool traffic are not in here because they never enter the transcript in the first place.
 */
export function roomProjection(db: GatewayDb, room: string, agent: string): Message[] {
    return db.roomEvents(room).map((ev) => {
        // only the gateway writes an author line: anywhere a body could read as one is escaped,
        // since indentation or an invisible character reads as a header to a model just the same
        const text = ev.text.replaceAll("[from:", "\\[from:");
        return ev.author.kind === "agent" && ev.author.agent === agent
            ? { role: "assistant", content: text }
            : { role: "user", content: `${fromLine(ev.author)}\n${text}` };
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
