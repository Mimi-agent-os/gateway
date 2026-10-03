/** What a model is shown: the agent's own system prompt, and a history cut down to what that model can read. */

import type { Message } from "@mimi-os/protocol";

import type { AgentPeer } from "../registry/peer.ts";

const DEFAULT_SYSTEM_PROMPT = "You are a concise and helpful assistant.";
const IMAGE_OMITTED = "[image omitted: this model cannot see images]";

export const nowStamp = (): string => {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** The one builder a turn and a `withPrompt` one-shot share: persona and pack parts as the agent described them, then the date. */
export function systemPrompt(peer: AgentPeer): Message {
    const parts = (peer.describe?.prompt ?? []).map((p) => p.text.trim()).filter(Boolean);
    const persona = parts.length ? parts.join("\n\n") : DEFAULT_SYSTEM_PROMPT;
    return { role: "system", content: `${persona}\n\nCurrent date/time: ${nowStamp()}` };
}

/** Decided per attempted model: one without vision reads a marker where each message's images were, never multipart it cannot parse. */
export function visibleTo(vision: boolean, messages: Message[]): Message[] {
    if (vision) return messages;
    return messages.map(({ images, ...m }) =>
        images?.length ? { ...m, content: m.content ? `${m.content}\n${IMAGE_OMITTED}` : IMAGE_OMITTED } : m,
    );
}
