/** The secure channel: the gateway identity, invites (device / local / agent), /channel sessions
 *  and /channel/pair enrollments over binary WebSockets, device decisions, the stream-0 control
 *  ops (devices) and stream-0 message hand-off to the registry (agents). */

import { createHash, createPrivateKey, createPublicKey, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fchmodSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";

import {
    CLOSE_NOT_PAIRED,
    fingerprint,
    FLAG_DATA,
    FLAG_END,
    FLAG_RESET,
    PairingResponder,
    ServerSession,
    gatewayId,
    makeInviteUri,
    newInvite,
    noPerms,
    PROTOCOL_VERSION,
    type Invite,
    type ChannelStreamFrame,
} from "@mimi-os/protocol";

import type { EventHub } from "../events.ts";
import { isLoopbackHost } from "../flags.ts";
import type { GatewayDb, ModelsPolicy } from "../store/db.ts";
import { ensureDir, home } from "../store/home.ts";
import { acceptWebSocket, type WsSocket } from "../transport/ws.ts";
import type { AgentSocket } from "./peer.ts";

export type ApproveMode = "tap" | "code";

export interface AppStreamContext {
    deviceId: string;
    /** Identity of the carrying session: stream numbers are only unique within it. */
    session: object;
    stream: number;
    frame: ChannelStreamFrame;
    /** false once the CONNECTION holds more than MAX_STREAM_QUEUED unsent bytes: pause the producer
     *  and register `onDrain` in the same tick, or the socket goes once the wait gets long. */
    send(frame: ChannelStreamFrame): boolean;
    onDrain(resume: () => void): void;
    close(): void;
}

export interface DeviceServiceOptions {
    now?: () => number;
    inactiveTtlMs?: number;
    opsTtlMs?: number;
    sweepIntervalMs?: number;
    /** Pre-auth bounds: not-yet-ready connections, globally and per client address. */
    maxPreauth?: number;
    maxPreauthPerIp?: number;
    /** Every channel connection at any stage, and the sessions one device key may hold at once. */
    maxSessions?: number;
    maxDeviceSessions?: number;
    /** Accept to ready/enrollment, and the same ceiling for one half-sent stream-0 message. */
    preauthDeadlineMs?: number;
    /** How long a connection may stay over its queued-bytes watermark before the socket is dropped. */
    streamStallMs?: number;
    keyFile?: string;
}

export interface DeviceView {
    id: string;
    name: string;
    status: "inactive" | "active" | "revoked";
    sas: string;
    enrolledAt: string;
    activatedAt: string | null;
    lastSeen: string | null;
    connected: boolean;
}

export type DeviceDecision = { ok: true } | { ok: false; status: 404 | 409; error: string };

export const CHANNEL_PATH = "/channel";
export const PAIR_PATH = "/channel/pair";

const MAX_APP_STREAMS = 64;
/** Unsent bytes one CONNECTION may hold across its streams > 0 before the producers
 *  are told to pause. Counted per connection, not per stream: a stream reset frees its accounting
 *  but not the bytes the socket still holds. */
const MAX_STREAM_QUEUED = 256 * 1024;
const EPOCH_EVERY_MS = 60_000;
const APPROVE_MODE_KEY = "device_approve_mode";
const OP_KINDS = new Set(["devices.list", "devices.approve", "devices.reject", "devices.revoke"]);
/** One or more DATA frames per stream-0 message, the assembled ceiling. */
const MAX_STREAM0_BYTES = 1_048_576;
/** Every frame of a message costs at least this much of that ceiling, so a trickle of empty frames
 *  cannot grow the reassembly for free. */
const STREAM0_FRAME_COST = 64;
/** What the SDK's own channel socket chunks at — matched for every gateway→client stream-0 message. */
const MESSAGE_CHUNK = 16 * 1024;
// PKCS#8 DER prefix of a raw 32-byte X25519 private key
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const REFUSED_UPGRADE = "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
/** Channel slots agents can never take, so no number of agent sessions locks the owner's devices out. */
const DEVICE_SLOTS = 16;
/** One reason for a wrong gateway key and an unknown or revoked device alike: the close says no more. */
const NOT_PAIRED = "not paired with this gateway";

type InviteKind = "device" | "local" | "agent";

const INVITE_TTL_MS: Record<InviteKind, number> = { device: 120_000, local: 120_000, agent: 24 * 3_600_000 };

interface OpenInvite {
    id: string;
    kind: InviteKind;
    /** Agent invites only: the name a redeeming `pair_confirm` must repeat exactly. */
    name?: string | undefined;
    /** Agent invites only: the model policy set before the first connection, stored on the pin it creates. */
    policy: ModelsPolicy | null;
    invite: Invite;
    responder: PairingResponder;
    conns: Set<Conn>;
    timer: NodeJS.Timeout;
    /** Runs the responder's own pending-confirm deadline: it only expires when someone asks. */
    poll: NodeJS.Timeout | null;
}

interface Stream {
    /** Ends by direction, not by role: the gateway opens streams on agent sessions, so on those
     *  `in` is the reply and `out` is the request. */
    inEnded: boolean;
    outEnded: boolean;
    /** The producer paused while the connection is over its queued-bytes watermark. */
    resume: (() => void) | null;
    /** Set for a gateway-opened stream; null for a device-opened one, which goes to onAppStream. */
    onFrame: ((frame: ChannelStreamFrame) => void) | null;
}

interface Conn {
    sock: WsSocket;
    /** The socket's peer, an agent's `from`: through a tunnel its upstream is still its own loopback. */
    ip: string;
    /** Whose pre-auth slots this connection holds: the X-Real-IP of a proxy on this host, else `ip`. */
    client: string;
    invite: OpenInvite | null;
    session: ServerSession | null;
    role: "device" | "agent" | null;
    deviceId: string | null;
    agentName: string | null;
    pending: boolean;
    ready: boolean;
    /** msg1 decrypted: the client sealed it to this gateway's key. */
    hello: boolean;
    /** The lookup turned the client's key away as unknown or revoked, not for capacity. */
    unpaired: boolean;
    heardAt: number;
    streams: Map<number, Stream>;
    /** Agent sessions only: the next id openAppStream hands out — only the gateway opens here. */
    nextStream: number;
    /** Bytes handed to the socket that it has not written out yet, and the deadline the peer has
     *  to get under the watermark before the socket goes. */
    queued: number;
    stall: NodeJS.Timeout | null;
    /** Stream-0 message reassembly, shared by device control and the agent adapter. */
    msgPieces: Buffer[];
    /** What the message in flight has charged against MAX_STREAM0_BYTES, not its byte length. */
    msgBytes: number;
    msgTimer: NodeJS.Timeout | null;
    agentAdapter: AgentSocket | null;
}

export class DeviceService {
    /** Called for every frame on a stream > 0 of a ready, active DEVICE session. */
    onAppStream: (ctx: AppStreamContext) => void = (ctx) => {
        if (ctx.frame.flags !== FLAG_RESET) ctx.close();
    };
    /** Called once an AGENT-role session is ready, with a stream-0 message adapter for the
     *  registry — see AgentSocket. Wired by core.ts to `registry.accept`. */
    onAgentSession: (adapter: AgentSocket, pinName: string, from: string | null) => void = (adapter) =>
        adapter.close(1011, "gateway not wired");

    readonly #db: GatewayDb;
    readonly #events: EventHub;
    readonly #log: (msg: string) => void;
    readonly #now: () => number;
    readonly #inactiveTtlMs: number;
    readonly #opsTtlMs: number;
    readonly #maxPreauth: number;
    readonly #maxPreauthPerIp: number;
    readonly #maxSessions: number;
    readonly #maxDeviceSessions: number;
    readonly #deadlineMs: number;
    readonly #streamStallMs: number;
    readonly #keyFile: string;
    #identity: { priv: Uint8Array; pub: Uint8Array; id: string } | null = null;
    readonly #invites = new Map<string, OpenInvite>();
    readonly #all = new Set<Conn>();
    readonly #preauth = new Set<Conn>();
    readonly #live = new Map<string, Set<Conn>>();
    readonly #epochAt = new Map<string, number>();
    readonly #sweep: NodeJS.Timeout;

    constructor(db: GatewayDb, events: EventHub, log: (msg: string) => void, opts: DeviceServiceOptions = {}) {
        this.#db = db;
        this.#events = events;
        this.#log = log;
        this.#now = opts.now ?? Date.now;
        this.#inactiveTtlMs = opts.inactiveTtlMs ?? 24 * 3_600_000;
        this.#opsTtlMs = opts.opsTtlMs ?? 24 * 3_600_000;
        this.#maxPreauth = opts.maxPreauth ?? 64;
        this.#maxPreauthPerIp = opts.maxPreauthPerIp ?? 8;
        this.#maxSessions = opts.maxSessions ?? 256;
        // a key that may hold no session at all could never connect: one is the floor
        this.#maxDeviceSessions = Math.max(1, opts.maxDeviceSessions ?? 8);
        this.#deadlineMs = opts.preauthDeadlineMs ?? 5_000;
        this.#streamStallMs = opts.streamStallMs ?? 30_000;
        this.#keyFile = opts.keyFile ?? join(home, ".channel.key");
        this.#sweep = setInterval(() => this.sweep(), opts.sweepIntervalMs ?? 60_000);
        this.#sweep.unref();
    }

    // ── identity ──────────────────────────────────────────────────────────
    #key(): { priv: Uint8Array; pub: Uint8Array; id: string } {
        if (this.#identity) return this.#identity;
        ensureDir(dirname(this.#keyFile));
        try {
            writeFileSync(this.#keyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        const stat = lstatSync(this.#keyFile);
        if (!stat.isFile()) throw new Error(`${this.#keyFile}: expected a regular file`);
        // O_NOFOLLOW closes the lstat/open race; a key restored or copied with a wider mode is repaired
        const fd = openSync(this.#keyFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let priv: Buffer;
        try {
            if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
            priv = readFileSync(fd);
        } finally {
            closeSync(fd);
        }
        if (priv.length !== 32) throw new Error(`${this.#keyFile}: expected 32 raw bytes`);
        const jwk = createPublicKey(
            createPrivateKey({ key: Buffer.concat([X25519_PKCS8, priv]), format: "der", type: "pkcs8" }),
        ).export({ format: "jwk" });
        const pub = new Uint8Array(Buffer.from(jwk.x ?? "", "base64url"));
        this.#identity = { priv: new Uint8Array(priv), pub, id: gatewayId(pub) };
        priv.fill(0);
        return this.#identity;
    }

    get gatewayPub(): Uint8Array {
        return this.#key().pub.slice();
    }

    get channelId(): string {
        return this.#key().id;
    }

    // ── invites ───────────────────────────────────────────────────────────
    #mint(kind: InviteKind, name?: string, address?: string): { uri: string; id: string; expiresAt: number } {
        const { priv, pub } = this.#key();
        const now = this.#now();
        const invite = { ...newInvite(now), expiresAt: now + INVITE_TTL_MS[kind] };
        // first: a bad address throws before anything is left open
        const uri = makeInviteUri(pub, invite, address);
        const open: OpenInvite = {
            id: invite.id,
            kind,
            name,
            policy: null,
            invite,
            responder: new PairingResponder({ s: priv, invite, now: this.#now }),
            conns: new Set(),
            timer: setTimeout(() => this.#burn(invite.id), Math.max(0, invite.expiresAt - this.#now())),
            poll: null,
        };
        open.timer.unref();
        this.#invites.set(invite.id, open);
        return { uri, id: invite.id, expiresAt: invite.expiresAt };
    }

    #burn(id: string, keep: Conn | null = null): void {
        const open = this.#invites.get(id);
        if (!open) return;
        this.#invites.delete(id);
        clearTimeout(open.timer);
        if (open.poll) clearInterval(open.poll);
        open.invite.secret.fill(0);
        // the responder holds its own copies of the gateway key and the invite secret
        open.responder.destroy();
        for (const c of [...open.conns]) if (c !== keep) c.sock.close(1000);
    }

    /** 120 s, single use, one open at a time. */
    createDeviceInvite(): { uri: string; id: string; expiresAt: number } {
        for (const [id, o] of this.#invites) if (o.kind === "device") this.#burn(id);
        return this.#mint("device");
    }

    /** 120 s, single use — minted only from the loopback listener, with the local token; `address` rides the link. */
    createLocalInvite(address?: string): { uri: string; id: string; expiresAt: number } {
        return this.#mint("local", undefined, address);
    }

    /** 24 h, single use, one open per name. */
    createAgentInvite(name: string): { uri: string; id: string; expiresAt: number } {
        for (const [id, o] of this.#invites) if (o.kind === "agent" && o.name === name) this.#burn(id);
        return this.#mint("agent", name);
    }

    /** The agent invites still open — the ones an owner can hand out or cancel. */
    listAgentInvites(): { name: string; id: string; expiresAt: number }[] {
        const out: { name: string; id: string; expiresAt: number }[] = [];
        for (const o of this.#invites.values()) {
            if (o.kind === "agent" && o.name !== undefined) out.push({ name: o.name, id: o.id, expiresAt: o.invite.expiresAt });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Cancel an outstanding agent invite by id. Returns false when there was none. */
    cancelAgentInvite(id: string): boolean {
        const open = this.#invites.get(id);
        if (!open || open.kind !== "agent") return false;
        this.#burn(id);
        return true;
    }

    /** The policy an open agent invite carries; undefined when no invite is open for that name. */
    agentInvitePolicy(name: string): ModelsPolicy | null | undefined {
        return [...this.#invites.values()].find((o) => o.kind === "agent" && o.name === name)?.policy;
    }

    /** False when no agent invite is open for that name. */
    setAgentInvitePolicy(name: string, policy: ModelsPolicy | null): boolean {
        const open = [...this.#invites.values()].find((o) => o.kind === "agent" && o.name === name);
        if (!open) return false;
        open.policy = policy;
        return true;
    }

    // ── decisions ─────────────────────────────────────────────────────────
    approveMode(): ApproveMode {
        return this.#db.getSetting(APPROVE_MODE_KEY) === "code" ? "code" : "tap";
    }

    setApproveMode(mode: ApproveMode): void {
        this.#db.setSetting(APPROVE_MODE_KEY, mode);
    }

    list(): DeviceView[] {
        const tap = this.approveMode() === "tap";
        return this.#db.listDevices().map((d) => ({
            id: d.id,
            name: d.name,
            status: d.status,
            sas: tap ? d.sas : "",
            enrolledAt: d.enrolledAt,
            activatedAt: d.activatedAt,
            lastSeen: d.lastSeen,
            connected: this.connected(d.id),
        }));
    }

    /** true while the device holds a ready channel session that was heard from within `heardWithinMs`. */
    connected(id: string, heardWithinMs = Infinity): boolean {
        const now = this.#now();
        return [...(this.#live.get(id) ?? [])].some((c) => c.ready && now - c.heardAt < heardWithinMs);
    }

    approve(id: string, code?: string): DeviceDecision {
        const d = this.#decide("approve", id, code);
        d.effects?.();
        return d.ok ? { ok: true } : { ok: false, status: d.status, error: d.error };
    }

    reject(id: string): DeviceDecision {
        const d = this.#decide("reject", id);
        d.effects?.();
        return d.ok ? { ok: true } : { ok: false, status: d.status, error: d.error };
    }

    revoke(id: string): DeviceDecision {
        const d = this.#decide("revoke", id);
        d.effects?.();
        return d.ok ? { ok: true } : { ok: false, status: d.status, error: d.error };
    }

    /** sqlite writes only; everything that leaves the database is returned as `effects`, run post-commit. */
    #decide(
        action: "approve" | "reject" | "revoke",
        id: string,
        code?: string,
    ): DeviceDecision & { effects?: () => void } {
        const row = this.#db.getDevice(id);
        if (action === "approve") {
            if (!row || row.status !== "inactive") return { ok: false, status: 404, error: "no such pending device" };
            if (this.approveMode() === "code" || code !== undefined) {
                const want = Buffer.from(row.sas, "utf8");
                const got = Buffer.from(typeof code === "string" && /^\d{6}$/.test(code) ? code : "", "utf8");
                if (got.length !== want.length || !timingSafeEqual(got, want)) {
                    return { ok: false, status: 409, error: "the code does not match the one on the new device" };
                }
            }
            if (!this.#db.activateDevice(id)) return { ok: false, status: 404, error: "no such pending device" };
            return {
                ok: true,
                effects: () => {
                    for (const c of [...(this.#live.get(id) ?? [])]) {
                        if (!c.pending || !c.session) continue;
                        c.pending = false;
                        try {
                            for (const out of c.session.activate()) c.sock.sendBinary(out);
                        } catch {
                            c.sock.close(1000);
                        }
                    }
                    this.#events.emit({ type: "device_activated", id });
                },
            };
        }
        if (!row || row.status === "revoked" || (action === "reject" && row.status !== "inactive")) {
            return { ok: false, status: 404, error: action === "reject" ? "no such pending device" : "no such device" };
        }
        this.#db.revokeDevice(id);
        this.#epochAt.delete(id);
        return {
            ok: true,
            effects: () => {
                for (const c of [...(this.#live.get(id) ?? [])]) c.sock.close(1000);
                this.#events.emit({ type: "device_revoked", id });
            },
        };
    }

    /** Every agent-role session bound to this pin name, at any handshake stage, ends now; returns how many. */
    closeAgent(name: string): number {
        let closed = 0;
        for (const c of [...this.#all]) {
            if (c.role !== "agent" || c.agentName !== name) continue;
            c.sock.close(1008);
            closed++;
        }
        return closed;
    }

    sweep(): void {
        try {
            for (const id of this.#db.sweepInactiveDevices(this.#inactiveTtlMs, this.#now())) {
                this.#epochAt.delete(id);
                for (const c of [...(this.#live.get(id) ?? [])]) c.sock.close(1000);
                this.#events.emit({ type: "device_revoked", id });
            }
            this.#db.sweepDeviceOps(this.#opsTtlMs, this.#now());
        } catch (e) {
            this.#log(`[devices] sweep failed: ${(e as Error).message}\n`);
        }
    }

    // ── connections ───────────────────────────────────────────────────────
    /** true = the upgrade was ours (accepted or refused); false = not a channel path. */
    handleUpgrade(req: IncomingMessage, duplex: Duplex, head: Buffer): boolean {
        const url = req.url ?? "";
        const path = (url.split("?")[0] ?? "");
        if (path !== CHANNEL_PATH && path !== PAIR_PATH) return false;
        const ip = req.socket.remoteAddress ?? "";
        const realIp = req.headers["x-real-ip"];
        // only a proxy on this host may name its client; node joins a repeated header, so that fails isIP
        const client = isLoopbackHost(ip) && typeof realIp === "string" && isIP(realIp) !== 0 ? realIp : ip;
        const byClient = new Map<string, Conn[]>();
        for (const c of this.#preauth) {
            const held = byClient.get(c.client);
            if (held) held.push(c);
            else byClient.set(c.client, [c]);
        }
        const mine = byClient.get(client)?.length ?? 0;
        let refused = mine >= this.#maxPreauthPerIp;
        if (!refused && (this.#preauth.size >= this.#maxPreauth || this.#all.size >= this.#maxSessions)) {
            // Fair rather than first-come: the address holding the most handshakes gives its oldest
            // up, so anonymous arrivals evict each other instead of locking a known device out.
            let worst: Conn[] | null = null;
            for (const held of byClient.values()) if (held.length > (worst?.length ?? mine)) worst = held;
            if (worst === null) refused = true;
            else {
                const victim = worst[0]!;
                this.#preauth.delete(victim);
                this.#all.delete(victim);
                // terminate, not close: a peer that never answers the close frame would hold the slot for ws's 30 s
                victim.sock.terminate();
            }
        }
        if (refused) {
            // node hands the upgrade socket over with no 'error' listener: a peer RST mid-write would be fatal
            duplex.on("error", () => duplex.destroy());
            duplex.end(REFUSED_UPGRADE, () => duplex.destroy());
            return true;
        }
        const pairing = path === PAIR_PATH;
        const inviteId = pairing ? (new URLSearchParams(url.split("?")[1] ?? "").get("invite") ?? "") : "";
        const invite = pairing ? (this.#invites.get(inviteId) ?? null) : null;
        const sock = acceptWebSocket(req, duplex, head);
        if (!sock) return true;
        const conn: Conn = {
            sock,
            ip,
            client,
            invite,
            session: null,
            role: null,
            deviceId: null,
            agentName: null,
            pending: false,
            ready: false,
            hello: false,
            unpaired: false,
            heardAt: this.#now(),
            streams: new Map(),
            nextStream: 1,
            queued: 0,
            stall: null,
            msgPieces: [],
            msgBytes: 0,
            msgTimer: null,
            agentAdapter: null,
        };
        this.#all.add(conn);
        this.#preauth.add(conn);
        sock.onclose = () => this.#forget(conn);
        if (pairing && !invite) {
            // an unknown or expired invite: counted like any arrival, then dropped with no closing handshake to wait on
            sock.terminate();
            return true;
        }
        if (!pairing) {
            conn.session = new ServerSession({
                s: this.#key().priv,
                protocol: PROTOCOL_VERSION,
                lookup: (clientPub) => {
                    const pubkey = Buffer.from(clientPub).toString("base64");
                    const device = this.#db.deviceByPubkey(pubkey);
                    if (device) {
                        if (!sock.open) return "reject";
                        if (device.status === "revoked") {
                            conn.unpaired = true;
                            return "reject";
                        }
                        conn.role = "device";
                        conn.deviceId = device.id;
                        conn.pending = device.status === "inactive";
                        const set = this.#live.get(device.id) ?? new Set<Conn>();
                        // one key holds a bounded number of sessions: the oldest gives way, so a
                        // reconnect is never locked out by sockets the peer walked away from
                        while (set.size >= this.#maxDeviceSessions) {
                            const oldest = set.values().next().value!;
                            set.delete(oldest);
                            oldest.sock.close(1000);
                        }
                        set.add(conn);
                        this.#live.set(device.id, set);
                        return conn.pending ? "pending" : "active";
                    }
                    const pin = this.#db.pinByPubkey(pubkey);
                    if (!sock.open) return "reject";
                    if (!pin || pin.status !== "approved") {
                        conn.unpaired = true;
                        return "reject";
                    }
                    let others = 0;
                    for (const c of this.#all) if (c.role === "agent" && c.agentName !== pin.name) others++;
                    if (others >= this.#maxSessions - DEVICE_SLOTS) return "reject";
                    conn.role = "agent";
                    conn.agentName = pin.name;
                    return "active";
                },
            });
        }
        conn.invite?.conns.add(conn);
        setTimeout(() => {
            // a peer that sent no handshake in time gets no closing handshake either: the slot frees now
            if (this.#preauth.has(conn)) sock.terminate();
        }, this.#deadlineMs).unref();
        sock.onmessage = () => sock.close(1000);
        sock.onerror = () => undefined;
        sock.onbinary = (data) => {
            // one u16-framed chunk per message: a shared responder must never see two sockets' bytes interleave
            if (data.length < 2 || data.readUInt16BE(0) !== data.length - 2) {
                sock.close(1000);
                return;
            }
            if (pairing) this.#pairMessage(conn, new Uint8Array(data));
            else this.#sessionMessage(conn, new Uint8Array(data));
        };
        return true;
    }

    #forget(conn: Conn): void {
        if (conn.msgTimer) clearTimeout(conn.msgTimer);
        if (conn.stall) clearTimeout(conn.stall);
        this.#preauth.delete(conn);
        this.#all.delete(conn);
        conn.invite?.conns.delete(conn);
        if (conn.deviceId !== null) {
            const set = this.#live.get(conn.deviceId);
            set?.delete(conn);
            if (set?.size === 0) this.#live.delete(conn.deviceId);
        }
        if (conn.role === "agent") conn.agentAdapter?.onclose?.(1006, "channel closed");
        const streams = [...conn.streams.entries()];
        conn.streams.clear();
        for (const [stream, state] of streams) {
            const reset: ChannelStreamFrame = { stream, flags: FLAG_RESET, payload: new Uint8Array(0) };
            if (state.onFrame) this.#deliver(conn, state, reset);
            else this.#hook(conn, reset);
        }
    }

    #pairMessage(conn: Conn, bytes: Uint8Array): void {
        const open = conn.invite;
        if (!open || this.#invites.get(open.id) !== open) {
            conn.sock.close(1000);
            return;
        }
        let r: ReturnType<PairingResponder["feed"]>;
        try {
            r = open.responder.feed(bytes);
        } catch {
            conn.sock.close(1000);
            return;
        }
        for (const ev of r.events) {
            // not terminal: a stale pending slot is gone, the invite keeps serving this frame and the next
            if (ev.type === "pending_expired") continue;
            if (ev.type === "closed") {
                // "bad" ends this byte stream only; a timeout or spent debits end the invite for everyone
                if (ev.reason !== "bad") this.#burn(open.id);
                conn.sock.close(1000);
                return;
            }
            this.#preauth.delete(conn);
            try {
                if (open.kind === "agent") this.#enrollAgentPin(conn, open, ev, r.out);
                else this.#enrollDevice(conn, open, ev, r.out);
            } catch (e) {
                this.#log(`[devices] enrollment failed: ${(e as Error).message}\n`);
                conn.sock.close(1011);
            }
            return;
        }
        for (const out of r.out) conn.sock.sendBinary(out);
        // the responder runs its own pending-confirm deadline only when someone calls expire()
        open.poll ??= setInterval(() => {
            for (const ev of open.responder.expire()) if (ev.type === "closed") this.#burn(open.id);
        }, this.#deadlineMs).unref();
    }

    /** kind "device" | "local": a fresh devices row, active immediately for "local". The invite
     *  is single-use regardless of outcome — burned before the write is even attempted. */
    #enrollDevice(
        conn: Conn,
        open: OpenInvite,
        ev: { clientPub: Uint8Array; deviceName: string; sas: string },
        out: Uint8Array[],
    ): void {
        this.#burn(open.id, conn);
        const name = ev.deviceName.replace(/\p{Cc}/gu, "").trim().slice(0, 64) || "Unnamed device";
        const pubkey = Buffer.from(ev.clientPub).toString("base64");
        // a key belongs to exactly one identity plane: an agent's pin must never also become a device
        if (this.#db.pinByPubkey(pubkey)) {
            conn.sock.close(1000);
            return;
        }
        const id = BigInt(`0x${randomBytes(10).toString("hex")}`).toString(32).padStart(16, "0");
        const created = this.#db.createDevice({ id, pubkey, name, sas: ev.sas });
        if (!created) {
            conn.sock.close(1000);
            return;
        }
        if (open.kind === "local") this.#db.activateDevice(id);
        for (const o of out) conn.sock.sendBinary(o);
        conn.sock.close(1000);
        if (open.kind === "local") {
            this.#events.emit({ type: "device_activated", id });
            return;
        }
        // in "code" mode the approver must read the code off the new device, so the gateway never shows it
        const sas = this.approveMode() === "tap" ? ev.sas : "";
        const item = this.#db.insertInboxItem({
            source: "system",
            title: `New device awaiting approval: ${name}`,
            body: sas ? `Code: ${sas.slice(0, 3)}-${sas.slice(3)}` : "Type the 6-digit code shown on the new device to approve it.",
            level: "action",
        });
        this.#events.emit({
            type: "inbox_item",
            id: item.id,
            source: item.source,
            agent: item.agent,
            title: item.title,
            level: item.level,
        });
        this.#events.emit({ type: "device_enrolled", id, name, sas });
    }

    /** kind "agent": the redeemed `pair_confirm.name` must equal the invite's name, then the pins
     *  row is created, or only its pubkey replaced (owner-driven recovery: status and perms stay,
     *  every session of the old key ends). Enrollment admits the agent — you minted the invite —
     *  but starts it CLOSED (noPerms): the operator grants delegate/discoverable in the pult. The
     *  invite is single-use regardless of outcome — burned before the name check is even resolved. */
    #enrollAgentPin(
        conn: Conn,
        open: OpenInvite,
        ev: { clientPub: Uint8Array; deviceName: string; sas: string },
        out: Uint8Array[],
    ): void {
        this.#burn(open.id, conn);
        if (ev.deviceName !== open.name) {
            conn.sock.close(1000);
            return;
        }
        const name = open.name!;
        const pubkey = Buffer.from(ev.clientPub).toString("base64");
        // A key belongs to exactly one identity plane: pins carry no UNIQUE(pubkey) and the
        // channel lookup prefers devices, so an ambiguous key would authenticate as another party.
        const owner = this.#db.pinByPubkey(pubkey);
        if ((owner && owner.name !== name) || this.#db.deviceByPubkey(pubkey)) {
            conn.sock.close(1000);
            return;
        }
        const fp = fingerprint(pubkey);
        if (this.#db.getPin(name)) {
            this.#db.setPinKey(name, pubkey, fp);
            this.closeAgent(name);
        } else {
            this.#db.createPin({ name, pubkey, fingerprint: fp, status: "approved", perms: noPerms() });
        }
        if (open.policy) this.#db.setModelsPolicy(name, open.policy);
        this.#events.emit({ type: "agent_changed", name });
        this.#events.emit({ type: "agent_enrolled", agent: name });
        for (const o of out) conn.sock.sendBinary(o);
        conn.sock.close(1000);
    }

    #sessionMessage(conn: Conn, bytes: Uint8Array): void {
        const session = conn.session;
        if (!session) return;
        let r: ReturnType<ServerSession["feed"]>;
        try {
            r = session.feed(bytes);
        } catch {
            // a msg1 that does not decrypt was sealed to another gateway key
            if (conn.hello) conn.sock.close(1000);
            else conn.sock.close(CLOSE_NOT_PAIRED, NOT_PAIRED);
            return;
        }
        conn.heardAt = this.#now();
        for (const out of r.out) conn.sock.sendBinary(out);
        for (const ev of r.events) {
            if (!conn.sock.open) return;
            if (ev.type === "hello") conn.hello = true;
            if (ev.type === "close") {
                if (conn.unpaired) conn.sock.close(CLOSE_NOT_PAIRED, NOT_PAIRED);
                else conn.sock.close(1000);
                return;
            }
            if (ev.type === "ready") {
                conn.ready = true;
                this.#preauth.delete(conn);
                if (conn.role === "device") {
                    if (conn.deviceId !== null) this.#db.touchDevice(conn.deviceId);
                } else if (conn.role === "agent") {
                    // one session per agent key, replaced at ready rather than at lookup: a replayed msg1 never gets here
                    for (const c of this.#all) {
                        if (c === conn || !c.ready || c.role !== "agent" || c.agentName !== conn.agentName) continue;
                        // terminate, not close: a peer that never answers the close frame would keep its slot
                        this.#all.delete(c);
                        c.sock.terminate();
                        this.#log(`[channel] agent ${conn.agentName}: a newer connection replaced the previous one\n`);
                    }
                    this.#attachAgent(conn);
                }
            } else if (ev.type === "frame") {
                if (conn.role === "agent") {
                    if (ev.frame.stream !== 0) {
                        this.#agentFrame(conn, ev.frame);
                        continue;
                    }
                    this.#stream0(conn, ev.frame, (text) => conn.agentAdapter?.onmessage?.(text));
                } else if (ev.frame.stream === 0) {
                    this.#stream0(conn, ev.frame, (text) => this.#control(conn, text));
                } else {
                    this.#appFrame(conn, ev.frame);
                }
            }
        }
    }

    /** The channel adapter an agent-role session hands to the registry: send() frames one
     *  stream-0 message, onmessage fires per assembled message — see registry/peer.ts. */
    #attachAgent(conn: Conn): void {
        const adapter: AgentSocket = {
            get open(): boolean {
                return conn.sock.open && conn.ready;
            },
            send: (text) => this.#message(conn, text),
            close: (code, reason) => conn.sock.close(code, reason),
            openAppStream: (onFrame) => {
                if (!conn.sock.open || conn.streams.size >= MAX_APP_STREAMS) return null;
                if (conn.nextStream > 0xffffffff) {
                    // the codec's ceiling: this session is spent, the SDK reconnects on its backoff
                    conn.sock.close(1000, "stream ids exhausted");
                    return null;
                }
                const stream = conn.nextStream++;
                conn.streams.set(stream, { inEnded: false, outEnded: false, resume: null, onFrame });
                const send = this.#streamSend(conn, stream);
                return {
                    send: (frame) => send({ ...frame, stream }),
                    onDrain: (resume) => {
                        const state = conn.streams.get(stream);
                        if (state) state.resume = resume;
                    },
                    reset: () => {
                        send({ stream, flags: FLAG_RESET, payload: new Uint8Array(0) });
                    },
                };
            },
            onmessage: null,
            onclose: null,
            onerror: null,
        };
        conn.agentAdapter = adapter;
        this.onAgentSession(adapter, conn.agentName ?? "", conn.ip || null);
    }

    #send(conn: Conn, frame: ChannelStreamFrame, onSent?: () => void): void {
        if (!conn.sock.open || !conn.session) return;
        try {
            const out = conn.session.send(frame);
            for (const [i, record] of out.entries()) conn.sock.sendBinary(record, i === out.length - 1 ? onSent : undefined);
        } catch {
            conn.sock.close(1000);
        }
    }

    /** One stream-0 message: DATA chunks, the last one carrying FLAG_END. */
    #message(conn: Conn, text: string): void {
        const bytes = Buffer.from(text, "utf8");
        let offset = 0;
        do {
            const end = Math.min(offset + MESSAGE_CHUNK, bytes.length);
            const flags = end === bytes.length ? FLAG_END : FLAG_DATA;
            this.#send(conn, { stream: 0, flags, payload: bytes.subarray(offset, end) });
            offset = end;
        } while (offset < bytes.length);
    }

    #reply(conn: Conn, msg: Record<string, unknown>): void {
        this.#message(conn, JSON.stringify(msg));
    }

    /** Reassembles a stream-0 message: DATA frames accumulate, FLAG_END completes
     *  it. Overflow past 1 MiB closes the session. */
    #stream0(conn: Conn, frame: ChannelStreamFrame, onMessage: (text: string) => void): void {
        const forget = (): void => {
            if (conn.msgTimer) clearTimeout(conn.msgTimer);
            conn.msgTimer = null;
            conn.msgPieces = [];
            conn.msgBytes = 0;
        };
        if (frame.flags === FLAG_RESET) {
            forget();
            return;
        }
        conn.msgPieces.push(Buffer.from(frame.payload));
        conn.msgBytes += Math.max(frame.payload.length, STREAM0_FRAME_COST);
        if (conn.msgBytes > MAX_STREAM0_BYTES) {
            forget();
            conn.sock.close(1009, "message too large");
            return;
        }
        if (frame.flags !== FLAG_END) {
            // the deadline runs from the message's FIRST frame: a trickle of frames must not renew
            // it, or a half-sent message parks its buffers for the life of the connection
            conn.msgTimer ??= setTimeout(() => conn.sock.close(1009, "message stalled"), this.#deadlineMs).unref();
            return;
        }
        const joined = Buffer.concat(conn.msgPieces);
        forget();
        onMessage(joined.toString("utf8"));
    }

    // ── stream 0 control (devices only) ──────────────────────────────────
    #control(conn: Conn, text: string): void {
        const id = conn.deviceId;
        if (id === null) return;
        let msg: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(text);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            msg = parsed as Record<string, unknown>;
        } catch {
            this.#reply(conn, { t: "error", code: "bad_frame" });
            return;
        }
        const t = msg["t"];
        if (conn.pending && t !== "ping" && t !== "device_status") {
            this.#reply(conn, { t: "error", code: "pending_activation" });
            return;
        }
        switch (t) {
            case "ping":
                this.#reply(conn, { t: "pong" });
                return;
            case "device_status": {
                const row = this.#db.getDevice(id);
                this.#reply(conn, { t: "device_status", epoch: row?.epoch ?? null, maxSeq: row?.maxSeq ?? 0 });
                return;
            }
            case "epoch": {
                const epoch = msg["epoch"];
                const last = this.#epochAt.get(id);
                const now = this.#now();
                if (typeof epoch !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(epoch)) {
                    this.#reply(conn, { t: "error", code: "bad_epoch" });
                } else if (last !== undefined && now - last < EPOCH_EVERY_MS) {
                    this.#reply(conn, { t: "error", code: "rate_limited" });
                } else {
                    this.#epochAt.set(id, now);
                    this.#db.setDeviceEpoch(id, epoch);
                    this.#log(`[devices] ${id} adopted a new op epoch\n`);
                    this.#reply(conn, { t: "device_status", epoch, maxSeq: 0 });
                }
                return;
            }
            case "op":
                this.#op(conn, id, msg, Buffer.from(text, "utf8"));
                return;
            default:
                this.#reply(conn, { t: "error", code: "unknown_message" });
        }
    }

    #op(conn: Conn, id: string, msg: Record<string, unknown>, payload: Buffer): void {
        const seq = msg["seq"];
        const epoch = msg["epoch"];
        const kind = msg["kind"];
        const raw = msg["args"] ?? {};
        if (
            typeof seq !== "number" ||
            !Number.isSafeInteger(seq) ||
            seq < 1 ||
            typeof epoch !== "string" ||
            typeof kind !== "string" ||
            !OP_KINDS.has(kind) ||
            raw === null ||
            typeof raw !== "object" ||
            Array.isArray(raw)
        ) {
            this.#reply(conn, { t: "error", code: "bad_op", ...(typeof seq === "number" ? { seq } : {}) });
            return;
        }
        const args = raw as Record<string, unknown>;
        const argsHash = createHash("sha256").update(payload).digest("hex");
        const effects: Array<() => void> = [];
        let outcome: ReturnType<GatewayDb["runDeviceOp"]>;
        try {
            outcome = this.#db.runDeviceOp(id, epoch, seq, kind, argsHash, () => {
                if (kind === "devices.list") return { devices: this.list() };
                const target = typeof args["id"] === "string" ? args["id"] : "";
                const code = typeof args["code"] === "string" ? args["code"] : undefined;
                const action = kind === "devices.approve" ? "approve" : kind === "devices.reject" ? "reject" : "revoke";
                const d = this.#decide(action, target, code);
                if (d.effects) effects.push(d.effects);
                return d.ok ? { ok: true } : { ok: false, status: d.status, error: d.error };
            });
        } catch (e) {
            this.#log(`[devices] op failed: ${(e as Error).message}\n`);
            this.#reply(conn, { t: "error", code: "op_failed", seq });
            return;
        }
        this.#reply(conn, {
            t: "op_result",
            seq,
            status: outcome.status,
            ...("result" in outcome ? { result: outcome.result } : {}),
        });
        for (const run of effects) run();
    }

    // ── streams > 0 ──
    /** A device-opened stream: the peer is the requester, so its END ends the request side; credit may follow that END. */
    #appFrame(conn: Conn, frame: ChannelStreamFrame): void {
        const credit = frame.flags === FLAG_DATA && frame.payload.length === 0;
        let state = conn.streams.get(frame.stream);
        if (!state) {
            if (frame.flags === FLAG_RESET || credit) return;
            if (conn.streams.size >= MAX_APP_STREAMS) {
                this.#send(conn, { stream: frame.stream, flags: FLAG_RESET, payload: new Uint8Array(0) });
                return;
            }
            state = { inEnded: false, outEnded: false, resume: null, onFrame: null };
            conn.streams.set(frame.stream, state);
        }
        if (frame.flags === FLAG_RESET) conn.streams.delete(frame.stream);
        else if (state.inEnded && !credit) {
            conn.streams.delete(frame.stream);
            const reset = { stream: frame.stream, flags: FLAG_RESET, payload: new Uint8Array(0) };
            this.#send(conn, reset);
            this.#hook(conn, reset);
            return;
        } else if (frame.flags === FLAG_END) {
            state.inEnded = true;
            if (state.outEnded) conn.streams.delete(frame.stream);
        }
        this.#hook(conn, frame);
    }

    /** A gateway-opened stream on an agent session: the agent's END ends the reply side. An id the
     *  gateway does not hold is refused, except an inbound RESET (never ping-pong) and a late credit. */
    #agentFrame(conn: Conn, frame: ChannelStreamFrame): void {
        const credit = frame.flags === FLAG_DATA && frame.payload.length === 0;
        const state = conn.streams.get(frame.stream);
        if (!state?.onFrame) {
            if (frame.flags !== FLAG_RESET && !credit) {
                this.#send(conn, { stream: frame.stream, flags: FLAG_RESET, payload: new Uint8Array(0) });
            }
            return;
        }
        if (frame.flags === FLAG_RESET) conn.streams.delete(frame.stream);
        else if (state.inEnded && !credit) {
            conn.streams.delete(frame.stream);
            const reset = { stream: frame.stream, flags: FLAG_RESET, payload: new Uint8Array(0) };
            this.#send(conn, reset);
            this.#deliver(conn, state, reset);
            return;
        } else if (frame.flags === FLAG_END) {
            state.inEnded = true;
            if (state.outEnded) conn.streams.delete(frame.stream);
        }
        this.#deliver(conn, state, frame);
    }

    /** One frame to a gateway-opened stream's owner. What the bridge writes into — a ServerResponse
     *  or a raw duplex — may throw, and that loses the stream, never the connection. */
    #deliver(conn: Conn, state: Stream, frame: ChannelStreamFrame): void {
        try {
            state.onFrame?.(frame);
        } catch (e) {
            this.#log(`[devices] app stream frame failed: ${(e as Error).message}\n`);
            conn.streams.delete(frame.stream);
            if (frame.flags !== FLAG_RESET) {
                this.#send(conn, { stream: frame.stream, flags: FLAG_RESET, payload: new Uint8Array(0) });
            }
        }
    }

    /** The outbound half of one stream: per-connection queued-byte accounting, the watermark, the
     *  stall terminate and the resume fan-out. Shared by the device hook and openAppStream. */
    #streamSend(conn: Conn, stream: number): (f: ChannelStreamFrame) => boolean {
        return (f) => {
            if (f.stream !== stream) throw new Error(`stream ${stream} cannot send on ${f.stream}`);
            const state = conn.streams.get(stream);
            if (!state) return false;
            if (f.flags === FLAG_RESET) conn.streams.delete(stream);
            else if (f.flags === FLAG_END) {
                state.outEnded = true;
                if (state.inEnded) conn.streams.delete(stream);
            }
            const bytes = f.payload.length;
            conn.queued += bytes;
            this.#send(conn, f, () => {
                conn.queued -= bytes;
                if (conn.queued > MAX_STREAM_QUEUED) return;
                if (conn.stall) clearTimeout(conn.stall);
                conn.stall = null;
                for (const paused of conn.streams.values()) {
                    const resume = paused.resume;
                    paused.resume = null;
                    resume?.();
                }
            });
            if (conn.queued <= MAX_STREAM_QUEUED) return true;
            // the peer has proved it is not reading, and an ended or reset stream frees its
            // accounting but not the bytes the socket still holds: the connection goes, not a stream
            conn.stall ??= setTimeout(() => conn.sock.terminate(), this.#streamStallMs).unref();
            return false;
        };
    }

    #hook(conn: Conn, frame: ChannelStreamFrame): void {
        const stream = frame.stream;
        const send = this.#streamSend(conn, stream);
        try {
            this.onAppStream({
                deviceId: conn.deviceId ?? "",
                session: conn,
                stream,
                frame,
                send,
                onDrain: (resume) => {
                    const state = conn.streams.get(stream);
                    if (state) state.resume = resume;
                },
                close: () => send({ stream, flags: FLAG_RESET, payload: new Uint8Array(0) }),
            });
        } catch (e) {
            this.#log(`[devices] app stream hook failed: ${(e as Error).message}\n`);
            if (frame.flags !== FLAG_RESET) send({ stream, flags: FLAG_RESET, payload: new Uint8Array(0) });
        }
    }

    stop(): void {
        clearInterval(this.#sweep);
        for (const id of [...this.#invites.keys()]) this.#burn(id);
        for (const c of [...this.#all]) c.sock.close(1001);
        this.#all.clear();
        this.#preauth.clear();
        this.#live.clear();
        this.#epochAt.clear();
    }
}
