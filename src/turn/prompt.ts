/** What a model is shown: the agent's own system prompt, and a history cut down to what that model can read. */

import type { Message } from "@mimi-os/protocol";

import type { AgentPeer } from "../registry/peer.ts";
import { timeZone, wallMs } from "../store/day.ts";

const DEFAULT_SYSTEM_PROMPT = "You are a concise and helpful assistant.";
const IMAGE_OMITTED = "[image omitted: this model cannot see images]";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** One moment as every model reads it, in the owner's zone (MIMI_TZ, else the host's: the zone every
 *  "today" is counted in): "Monday 2026-10-12 10:04". The weekday is spelled out because a model
 *  works it out from a date badly. */
export const momentStamp = (ms: number): string => {
    const wall = new Date(wallMs(ms));
    return `${WEEKDAYS[wall.getUTCDay()]} ${wall.toISOString().slice(0, 16).replace("T", " ")}`;
};

/** The zone every stamp is read in and its offset at `at`: "Europe/Kyiv, UTC+03:00" (DST moves it). */
const zoneAt = (at: number): string => {
    // wallMs drops the milliseconds: rounding to the minute takes them back out
    const offset = Math.round((wallMs(at) - at) / 60_000);
    const hhmm = new Date(Math.abs(offset) * 60_000).toISOString().slice(11, 16);
    return `${timeZone()}, UTC${offset < 0 ? "-" : "+"}${hhmm}`;
};

/** Now, as get_time answers it: the moment, then the zone it is read in. */
export const nowStamp = (): string => {
    const now = Date.now();
    return `${momentStamp(now)} (${zoneAt(now)})`;
};

/** The one builder a turn and a `withPrompt` one-shot share: persona and pack parts as the agent described them, then what a stamp is. No clock: "now" is the newest stamp (a one-shot's caller writes its own), so the prompt stays byte-identical and the provider's prompt cache holds. */
export function systemPrompt(peer: AgentPeer): Message {
    const parts = (peer.describe?.prompt ?? []).map((p) => p.text.trim()).filter(Boolean);
    const persona = parts.length ? parts.join("\n\n") : DEFAULT_SYSTEM_PROMPT;
    // unexplained, a stamp reads as part of the conversation, and a model then opens its own replies with one
    const note =
        "A bracketed line opening a user message is added automatically: when it was sent (in a room, " +
        `also by whom), in the owner's time zone (${zoneAt(Date.now())}). The newest one is the time now: ` +
        "count today, tomorrow and every other relative date from it. Never write one yourself.";
    return { role: "system", content: `${persona}\n\n${note}` };
}

/** Decided per attempted model: one without vision reads a marker where each message's images were, never multipart it cannot parse. */
export function visibleTo(vision: boolean, messages: Message[]): Message[] {
    if (vision) return messages;
    return messages.map(({ images, ...m }) =>
        images?.length ? { ...m, content: m.content ? `${m.content}\n${IMAGE_OMITTED}` : IMAGE_OMITTED } : m,
    );
}
