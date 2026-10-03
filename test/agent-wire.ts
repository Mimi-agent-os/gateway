/** A raw agent channel session: the real handshake and hello/describe, with frames on streams > 0 kept instead of served. */
import assert from "node:assert/strict";

import { ClientSession, FLAG_DATA, FLAG_END, PROTOCOL_VERSION, type ChannelStreamFrame } from "@mimi-os/protocol";
import { createFakeAgentCore, fakeIdentity, type AgentIdentity } from "@mimi-os/sdk/testing";
import WebSocket from "ws";

import { waitFor, type Env } from "./harness-env.ts";

export interface RawAgent {
    identity: AgentIdentity;
    /** Every frame the gateway sent on a stream > 0, in arrival order. */
    inbox: ChannelStreamFrame[];
    closed: boolean;
    send(frame: ChannelStreamFrame): void;
    /** ws, not the global client: stopping the read is what puts the gateway's own queue under pressure. */
    pause(): void;
    close(): void;
}

const utf8 = new TextEncoder();

export async function connectRawAgent(
    env: Env,
    opts: { name: string; identity?: AgentIdentity; app?: { title: string; entry?: string; upstream: string } },
): Promise<RawAgent> {
    const identity = opts.identity ?? fakeIdentity();
    env.pin(opts.name, identity.pubkey);
    const core = createFakeAgentCore({ name: opts.name, app: opts.app });
    const session = new ClientSession({ s: identity.secret, gatewayPub: env.core.devices.gatewayPub, protocol: PROTOCOL_VERSION });
    const ws = new WebSocket(`${env.ws}/channel`);
    const agent: RawAgent = {
        identity,
        inbox: [],
        closed: false,
        send: (frame) => {
            for (const chunk of session.send(frame)) ws.send(chunk);
        },
        pause: () => ws.pause(),
        close: () => ws.close(),
    };
    const wire = {
        send: (text: string): void => agent.send({ stream: 0, flags: FLAG_END, payload: utf8.encode(text) }),
        close: (): void => ws.close(),
    };

    let ready = false;
    let pieces: Buffer[] = [];
    ws.on("close", () => {
        agent.closed = true;
    });
    ws.on("message", (data: Buffer) => {
        const r = session.feed(new Uint8Array(data));
        for (const chunk of r.out) ws.send(chunk);
        for (const ev of r.events) {
            if (ev.type === "ready") ready = true;
            if (ev.type !== "frame") continue;
            if (ev.frame.stream !== 0) {
                agent.inbox.push(ev.frame);
                continue;
            }
            pieces.push(Buffer.from(ev.frame.payload));
            if (ev.frame.flags !== FLAG_END) continue;
            const text = Buffer.concat(pieces).toString("utf8");
            pieces = [];
            void core.receive(text, wire);
        }
    });
    await new Promise<void>((open, fail) => {
        ws.on("open", () => open());
        ws.on("error", () => fail(new Error(`the agent socket for ${opts.name} failed`)));
    });
    for (const chunk of session.start()) ws.send(chunk);
    await waitFor(() => ready, 4000, "the agent session is ready");
    await core.handshake(wire);
    await waitFor(() => env.core.registry.get(opts.name) !== undefined, 4000, `${opts.name} is registered`);
    return agent;
}

/** The next frame the agent received on `stream`, removed from its inbox. */
export async function nextFrame(agent: RawAgent, stream: number, ms = 3000): Promise<ChannelStreamFrame> {
    await waitFor(() => agent.inbox.some((f) => f.stream === stream), ms, `a frame on stream ${stream}`);
    const at = agent.inbox.findIndex((f) => f.stream === stream);
    const frame = agent.inbox[at];
    assert.ok(frame);
    agent.inbox.splice(at, 1);
    return frame;
}

/** The next request the gateway opened a stream with, and the id to answer it on. The END that
 *  closes a bodyless request and a credit frame are both empty: only a payload carries the header. */
export async function nextRequest(agent: RawAgent, ms = 3000): Promise<{ stream: number; header: Record<string, unknown> }> {
    await waitFor(() => agent.inbox.some((f) => f.payload.length > 0), ms, "a gateway-opened stream");
    const at = agent.inbox.findIndex((f) => f.payload.length > 0);
    const frame = agent.inbox[at];
    assert.ok(frame);
    agent.inbox.splice(at, 1);
    const header = JSON.parse(Buffer.from(frame.payload).toString("utf8")) as Record<string, unknown>;
    assert.equal(header["t"], "req");
    return { stream: frame.stream, header };
}

/** A JSON reply frame — {t:"head"} or {t:"error"} — encoded as the SDK executor encodes its own. */
export const replyFrame = (stream: number, reply: unknown): ChannelStreamFrame => ({
    stream,
    flags: FLAG_DATA,
    payload: utf8.encode(JSON.stringify(reply)),
});
