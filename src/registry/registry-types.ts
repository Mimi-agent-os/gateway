/** Registry-facing shapes: inbound frames, request options, hooks, and the agent info card. */

import type {
    A2aCallOkPayload,
    A2aCallPayload,
    AgentManifest,
    AskApproveOkPayload,
    AskApprovePayload,
    ChatOkPayload,
    ChatPayload,
    HealthOkPayload,
    NotifyPayload,
    PinPerms,
    PinStatus,
    SessionHead,
    ToolSchema,
} from "@mimi-os/protocol";

import type { AgentPeer } from "./peer.ts";

export interface IncomingRequest {
    id: string;
    type: string;
    payload: unknown;
}

export interface RequestOptions {
    /** Relative ms budget put on the wire; the peer counts it from receipt. */
    deadline?: number;
    /** How long to wait for the reply here: by default the deadline plus a grace, else 30 s. null
     *  sets no timer at all — only the reply, `signal` or the socket closing settles the request. */
    timeoutMs?: number | null;
    /** Stops waiting locally. The protocol has no remote cancellation frame. */
    signal?: AbortSignal | undefined;
}

export interface PeerHooks {
    chat(peer: AgentPeer, id: string, p: ChatPayload): Promise<ChatOkPayload>;
    askApprove(peer: AgentPeer, p: AskApprovePayload): Promise<AskApproveOkPayload>;
    a2aCall(peer: AgentPeer, p: A2aCallPayload): Promise<A2aCallOkPayload>;
    changed(peer: AgentPeer, head: SessionHead): void;
    /** A notice, like `changed`: the agent is told nothing, and never learns it was dropped. */
    notify(peer: AgentPeer, p: NotifyPayload): void;
}

/** Something an agent's describe carried that the gateway left out or cut, and why. */
export interface DescribeDrop {
    kind: "manifest" | "tool" | "prompt" | "a2a" | "app" | "avatar";
    name?: string | undefined;
    reason: string;
}

export interface AgentInfo {
    name: string;
    connected: boolean;
    /** Admission: anything but "approved" spends no tokens and reaches no other agent; null = no pin. */
    status: PinStatus | null;
    perms: PinPerms;
    fingerprint: string | null;
    paused: boolean;
    lastSeen: number;
    connectedAt: number | null;
    manifest: AgentManifest | null;
    tools: ToolSchema[];
    /** The stored avatar's SHA-256, null with none; it outlives the connection. */
    avatar: string | null;
    health: HealthOkPayload | null;
    healthError: string | null;
}
