/** Shared boot, wired like src/main.ts: a temp gateway.db, a fake model, fake agents and one paired device on 127.0.0.1:0. */
import "./pq-home.ts";

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allPerms, fingerprint, noPerms, type PinStatus } from "@mimi-os/protocol";
import {
    createFakeModel,
    fakeIdentity,
    type AgentIdentity,
    type FakeModel,
    type ScriptedTurn,
    type ToolTable,
} from "@mimi-os/sdk/testing";

import { createGatewayCore, type GatewayCore, type GatewayCoreOptions } from "../src/core.ts";
import { channelUpgradeHandler, loopbackHandler, writeLocalToken } from "../src/http/listeners.ts";
import { miniAppUpgrade } from "../src/http/mini-app.ts";
import { addModel, setDefaultModel } from "../src/llm/models.ts";
import { GatewayDb } from "../src/store/db.ts";
import { home } from "../src/store/home.ts";
import { createHarness, type Harness, type HarnessOptions } from "./agent-harness.ts";
import { dialChannel, pairDevice, type ApiReply, type ChannelConn, type NdjsonStream } from "../src/device-client.ts";

export type { ApiReply, NdjsonStream } from "../src/device-client.ts";

/** The name the harness's own local device pairs under — it shows up in /api/devices. */
export const HARNESS_DEVICE = "harness";

export interface Env {
    core: GatewayCore;
    db: GatewayDb;
    model: FakeModel;
    port: number;
    /** http://127.0.0.1:<port> — the loopback listener's plain-HTTP surface (/app, GET /api/health, POST /local/invite). */
    base: string;
    /** ws://127.0.0.1:<port> — append /channel or /channel/pair?invite=<id>. */
    ws: string;
    dir: string;
    /** This boot's local token (POST /local/invite bearer). */
    localToken: string;
    /** Everything the gateway logged, in order. */
    logs: string[];
    /** `admit`: true (default) pins the agent's key approved with allPerms; a PinStatus pins it with that status
     *  (only "approved" passes the channel lookup); false writes no pin, so the handshake refuses the key. */
    connect(opts: HarnessOptions, admit?: boolean | PinStatus): Promise<Harness>;
    /** Seed a pin without connecting: omitting `pubkey` uses the name's harness key. */
    pin(name: string, pubkey?: string, status?: PinStatus): void;
    /** One tunnel request from the harness device; `body` is JSON-encoded unless it is a string or bytes. */
    api<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiReply<T>>;
    /** The same request, read as NDJSON lines as they arrive (/api/events, turn streams, re-attach). */
    stream(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<NdjsonStream>;
    /** The harness device's live session (paired on first use) and its devices row id. */
    device(): Promise<{ id: string; conn: ChannelConn }>;
    stop(): Promise<void>;
}

export async function waitFor(fn: () => boolean, ms = 4000, note = "condition"): Promise<void> {
    const t0 = Date.now();
    while (!fn()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${note}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

/** Say yes to every gate as it opens, for tests that are not about approvals. */
export function autoApprove(env: Env): () => void {
    const timer = setInterval(() => {
        for (const g of env.core.approvals.pending()) {
            const card = env.core.approvals.describe(g.gate);
            if (!card) continue;
            const decisions: Record<string, boolean> = {};
            for (const a of card.actions) decisions[a.id] = true;
            env.core.approvals.answer(g.gate, decisions);
        }
    }, 5);
    timer.unref();
    return () => clearInterval(timer);
}

/** An agent whose only job is its app: pinned, connected and registered, with the SDK's REAL
 *  executor behind it — a test that wants a miniapp spins its own node:http upstream and the
 *  agent dials it. `describe` is what registers the catalog row. */
export async function connectAppAgent(
    env: Env,
    name: string,
    upstream: string,
    opts: { idleMs?: number; handlers?: ToolTable; serves?: boolean } = {},
): Promise<Harness> {
    const h = await env.connect({ name, app: { title: name, upstream }, ...opts });
    await waitFor(() => env.core.registry.get(name) !== undefined, 4000, `${name} is registered`);
    return h;
}

/** Pairs a fresh device through the harness's own tunnel and approves it: its key and its devices row id. */
export async function activeDevice(env: Env, name: string): Promise<{ s: Uint8Array; id: string }> {
    const s = crypto.getRandomValues(new Uint8Array(32));
    const invite = await env.api<{ uri: string }>("POST", "/api/devices/invite");
    await pairDevice(env.ws, invite.json.uri, s, name);
    const id = env.db.listDevices().find((d) => d.name === name)?.id;
    if (id === undefined) throw new Error(`harness: ${name} left no devices row`);
    const approved = await env.api("POST", `/api/devices/${id}/approve`);
    if (approved.status !== 200) throw new Error(`harness: ${name} was not approved (${approved.status})`);
    return { s, id };
}

/** A notice gets no reply: a refused request sent after it answers only once every notice before it was handled. */
export async function drained(h: Harness, id: string): Promise<void> {
    h.send({ id, type: "ask_approve", payload: { label: "" } });
    await waitFor(() => h.frames().some((f) => f["id"] === id), 4000, `the ${id} reply`);
}

export interface BootOptions extends Omit<GatewayCoreOptions, "db" | "log"> {
    /** The fake default model's context window. */
    contextTokens?: number;
}

export async function boot({ contextTokens = 1000, devices, ...options }: BootOptions = {}): Promise<Env> {
    // a test file that reached store/home.ts before ./pq-home.ts would write this boot's token into the owner's real home
    if (home !== process.env["MIMI_HOME"]) throw new Error(`harness: home is ${home}, not the test home — import "./pq-home.ts" first`);
    const dir = mkdtempSync(join(tmpdir(), "mimi-gw-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    const model = createFakeModel();
    const endpoint = await model.listen();
    addModel({ name: "fake", provider: "llamacpp", endpoint, contextTokens }, db);
    setDefaultModel("fake", db);

    const logs: string[] = [];
    const localToken = writeLocalToken();
    const core = createGatewayCore({
        ...options,
        db,
        log: (msg) => void logs.push(msg),
        devices: { keyFile: join(dir, ".channel.key"), ...devices },
    });
    const server = createServer();
    const sockets = new Set<Socket>();
    server.on("connection", (s: Socket) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("harness: no address");
    const port = addr.port;
    // wired the way main.ts wires the loopback listener: without the third argument no booted test
    // core would have a /mini-app upgrade branch at all
    server.on(
        "upgrade",
        channelUpgradeHandler((req, duplex, head) => core.handleUpgrade(req, duplex, head), miniAppUpgrade(core, port)),
    );
    server.on("request", loopbackHandler(core, { host: "127.0.0.1", port }));
    const ws = `ws://127.0.0.1:${port}`;

    const open: Harness[] = [];
    /** One key per NAME, like one identity.key per agent folder — so a reconnect is the same agent. */
    const keys = new Map<string, AgentIdentity>();
    const identityOf = (name: string): AgentIdentity => {
        const known = keys.get(name) ?? fakeIdentity();
        keys.set(name, known);
        return known;
    };

    const pin = (name: string, pubkey = identityOf(name).pubkey, status: PinStatus = "approved"): void => {
        db.createPin({
            name,
            pubkey,
            fingerprint: fingerprint(pubkey),
            status,
            perms: status === "approved" ? allPerms() : noPerms(),
        });
    };

    let paired: Promise<{ id: string; conn: ChannelConn }> | null = null;
    const device = (): Promise<{ id: string; conn: ChannelConn }> => {
        paired ??= (async () => {
            const s = crypto.getRandomValues(new Uint8Array(32));
            const { gatewayPub } = await pairDevice(ws, core.devices.createLocalInvite().uri, s, HARNESS_DEVICE);
            const conn = dialChannel(`${ws}/channel`, s, gatewayPub);
            const info = await conn.ready;
            if (info.activation === "pending") throw new Error("harness: the local device came up pending");
            const row = db.listDevices().find((d) => d.name === HARNESS_DEVICE);
            if (!row) throw new Error("harness: the local device left no devices row");
            return { id: row.id, conn };
        })();
        return paired;
    };

    return {
        core,
        db,
        model,
        port,
        base: `http://127.0.0.1:${port}`,
        ws,
        dir,
        localToken,
        logs,
        pin,
        device,
        api: async (method, path, body, headers) => (await device()).conn.api(method, path, body, headers),
        stream: async (method, path, body, headers) => (await device()).conn.stream(method, path, body, headers),
        connect: async (opts, admit = true) => {
            const identity = opts.identity ?? identityOf(opts.name);
            keys.set(opts.name, identity);
            if (admit !== false) pin(opts.name, identity.pubkey, admit === true ? "approved" : admit);
            const h = createHarness({ ...opts, identity }, core.devices.gatewayPub);
            open.push(h);
            await h.connect(`${ws}/channel`);
            return h;
        },
        stop: async () => {
            for (const h of open) h.close();
            (await paired?.catch(() => null))?.conn.close();
            await core.stop();
            const closed = new Promise<void>((done) => server.close(() => done()));
            server.closeAllConnections();
            const deadline = setTimeout(() => {
                for (const s of sockets) s.destroy();
            }, 1000);
            await closed;
            clearTimeout(deadline);
            // ws emits its close a tick after the TCP socket goes: the registry writes the db from that handler
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setTimeout(r, 0));
            await model.close();
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

export const textTurn = (text: string, promptTokens = 10): ScriptedTurn => ({
    events: [
        { kind: "text", text },
        { kind: "finish", reason: "stop" },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: 5 },
});

export const callTurn = (
    calls: ReadonlyArray<{ id: string; name: string; args?: string }>,
    promptTokens = 10,
): ScriptedTurn => ({
    events: [
        ...calls.map((c, i) => ({
            kind: "tool_call" as const,
            index: i,
            id: c.id,
            name: c.name,
            arguments: c.args ?? "{}",
        })),
        { kind: "finish" as const, reason: "tool_calls" },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: 5 },
});
