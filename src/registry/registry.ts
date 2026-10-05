import { createHash } from "node:crypto";

import { A2A_PREFIX, AGENT_DESCRIPTION_MAX, AVATAR_MAX_BYTES, avatarType, isAgentDescription, noPerms } from "@mimi-os/protocol";
import type {
    A2aCallPayload,
    AgentApp,
    AgentAppPage,
    AgentManifest,
    AskApprovePayload,
    ChatPayload,
    DescribeOkPayload,
    DescribePayload,
    HealthOkPayload,
    HelloOkPayload,
    HelloPayload,
    ModelGrant,
    NotifyPayload,
    PackDisabled,
    PinPerms,
    PinStatus,
    PromptPart,
    SessionHead,
    ToolSchema,
} from "@mimi-os/protocol";

import { Admissions, type PinCard } from "./admission.ts";
import type { EventHub } from "../events.ts";
import { isLoopbackHost, normalizeHost } from "../flags.ts";
import { gatewayDb, type AgentAvatarRow, type GatewayDb } from "../store/db.ts";
import { modelGrantsFor } from "../llm/policy.ts";
import { AgentPeer, PeerError, type AgentSocket } from "./peer.ts";
import type { AgentInfo, DescribeDrop, IncomingRequest, PeerHooks } from "./registry-types.ts";

export interface RegistryOptions {
    db?: GatewayDb;
    log?: (msg: string) => void;
    events: EventHub;
    healthIntervalMs?: number | undefined;
    /** How long past a request's deadline the gateway still waits for the agent's reply. */
    deadlineGraceMs?: number | undefined;
    /** How long a request with neither a deadline nor a timeout of its own waits for the reply. */
    defaultTimeoutMs?: number | undefined;
    grants?: (agent: string) => ModelGrant[];
}

const HELLO_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const HEALTH_INTERVAL_MS = 60_000;
const HEALTH_TIMEOUT_MS = 10_000;
const APP_TEXT_MAX = 200;
const APP_PAGES_MAX = 50;
const TOOLS_MAX = 128;
const A2A_COMMANDS_MAX = 128;
const TOOL_NAME_MAX = 128;
const TOOL_TEXT_MAX = 4_000;
const MODEL_MAX = 200;
const POLICY_TOOLS_MAX = 256;
const PROMPT_PARTS_MAX = 64;
const PACKS_MAX = 64;
const REDESCRIBES_PER_MIN = 20;

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const bool = (v: unknown): boolean => v === true;

function payloadObject(type: string, raw: unknown): Record<string, unknown> {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new PeerError(`${type}: payload must be an object`, "error");
    }
    return raw as Record<string, unknown>;
}

function chatPayload(raw: unknown): ChatPayload {
    const p = payloadObject("chat", raw);
    if (!Array.isArray(p["messages"])) throw new PeerError("chat: messages must be an array", "error");
    return p as unknown as ChatPayload;
}

function askApprovePayload(raw: unknown): AskApprovePayload {
    const p = payloadObject("ask_approve", raw);
    if (typeof p["label"] !== "string") throw new PeerError("ask_approve: label must be a string", "error");
    return p as unknown as AskApprovePayload;
}

function notifyPayload(raw: unknown): NotifyPayload {
    const p = payloadObject("notify", raw);
    const target = p["target"];
    if (target !== undefined && (target === null || typeof target !== "object" || Array.isArray(target))) {
        throw new PeerError("notify: target must be an object", "error");
    }
    return p as unknown as NotifyPayload;
}

/** An agent publishes only its OWN server: a loopback upstream when its channel connection came
 *  from this machine, otherwise exactly the address that connection came from. */
function agentOwnsHost(upstream: string, from: string | null): boolean {
    if (from === null || isLoopbackHost(from)) return isLoopbackHost(upstream);
    const [host, agent] = [upstream, from].map((h) =>
        (normalizeHost(h) ?? "").toLowerCase().replace(/^::ffff:/, ""),
    );
    return host !== "" && host === agent;
}

/** Down to exactly the DescribePayload contract — an agent's manifest is untrusted input; `dropped` names what was left out or cut. */
function validateDescribe(
    name: string,
    raw: unknown,
    from: string | null,
): { described: DescribePayload; avatar: AgentAvatarRow | null; dropped: DescribeDrop[]; bytes: number } {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new PeerError("describe: payload must be an object", "error");
    }
    const p = raw as Record<string, unknown>;
    const m = p["manifest"];
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
        throw new PeerError("describe: manifest must be an object", "error");
    }
    const raws = m as Record<string, unknown>;
    if (str(raws["name"]) !== name) {
        throw new PeerError(
            `describe: manifest names "${str(raws["name"])}", not "${name}"`,
            "denied",
        );
    }
    const model = str(raws["model"]);
    if (model.length > MODEL_MAX) throw new PeerError(`describe: manifest.model is over ${MODEL_MAX} chars`, "error");
    const dropped: DescribeDrop[] = [];
    const manifest: AgentManifest = { name, chain: bool(raws["chain"]) };
    if (model) manifest.model = model;
    // an orchestrator will route by this line: anything but one line within the cap is dropped, never cut
    const description = str(raws["description"]).trim();
    if (isAgentDescription(description)) manifest.description = description;
    else if (description) {
        dropped.push({ kind: "manifest", name: "description", reason: `not one line of at most ${AGENT_DESCRIPTION_MAX} chars` });
    }
    const policy = raws["policy"];
    if (policy !== null && typeof policy === "object" && !Array.isArray(policy)) {
        const pol = policy as Record<string, unknown>;
        const allowed = Array.isArray(pol["allowedTools"]) ? pol["allowedTools"].map(str).filter(Boolean) : undefined;
        const budgetsRaw = pol["budgets"];
        const budgets: Record<string, number> = {};
        if (budgetsRaw !== null && typeof budgetsRaw === "object" && !Array.isArray(budgetsRaw)) {
            for (const [k, v] of Object.entries(budgetsRaw as Record<string, unknown>)) {
                if (typeof v === "number" && Number.isFinite(v)) budgets[k] = v;
            }
        }
        // both lists ride every /api/agents card a device refetches
        for (const [field, names] of [["allowedTools", allowed ?? []], ["budgets", Object.keys(budgets)]] as const) {
            if (names.length > POLICY_TOOLS_MAX || names.some((t) => t.length > TOOL_NAME_MAX)) {
                throw new PeerError(
                    `describe: policy.${field} takes at most ${POLICY_TOOLS_MAX} tool names of at most ${TOOL_NAME_MAX} chars`,
                    "error",
                );
            }
        }
        manifest.policy = {};
        if (allowed) manifest.policy.allowedTools = allowed;
        if (Object.keys(budgets).length) manifest.policy.budgets = budgets;
    }

    // the a2a filter below matches commands against these names, and the frame itself is bounded
    // only by the ~1 MiB stream-0 cap: the counts are what keeps that pairing cheap
    const tools: ToolSchema[] = [];
    const rawTools = asArray(p["tools"]);
    if (rawTools.length > TOOLS_MAX) {
        dropped.push({ kind: "tool", reason: `${rawTools.length - TOOLS_MAX} tool(s) past the ${TOOLS_MAX}-tool limit` });
    }
    for (const t of rawTools.slice(0, TOOLS_MAX)) {
        const row = t !== null && typeof t === "object" ? (t as Record<string, unknown>) : {};
        const tn = str(row["name"]);
        if (!tn || tn.length > TOOL_NAME_MAX) {
            dropped.push({ kind: "tool", name: tn.slice(0, TOOL_NAME_MAX) || undefined, reason: tn ? `name over ${TOOL_NAME_MAX} chars` : "no name" });
            continue;
        }
        const tool: ToolSchema = { name: tn, writes: bool(row["writes"]) };
        if (bool(row["fold"])) tool.fold = true;
        const description = str(row["description"]);
        if (description.length > TOOL_TEXT_MAX) {
            dropped.push({ kind: "tool", name: tn, reason: `description cut to ${TOOL_TEXT_MAX} chars` });
        }
        if (description) tool.description = description.slice(0, TOOL_TEXT_MAX);
        const params = row["parameters"];
        if (params !== null && typeof params === "object" && !Array.isArray(params)) {
            tool.parameters = params as Record<string, unknown>;
        } else if (params !== undefined) {
            dropped.push({ kind: "tool", name: tn, reason: "parameters is not an object, so the tool takes none" });
        }
        tools.push(tool);
    }
    // a2a commands are matched against these tools for `writes`, so a command naming no described
    // tool is dropped rather than carried as an ungateable name; the prefix is the SDK's alone
    const a2a = raws["a2a"];
    if (a2a !== null && typeof a2a === "object" && !Array.isArray(a2a)) {
        const named = new Set(tools.map((t) => t.name));
        const rawCommands = asArray((a2a as Record<string, unknown>)["commands"]);
        if (rawCommands.length > A2A_COMMANDS_MAX) {
            dropped.push({ kind: "a2a", reason: `${rawCommands.length - A2A_COMMANDS_MAX} command(s) past the ${A2A_COMMANDS_MAX}-command limit` });
        }
        const commands = rawCommands.slice(0, A2A_COMMANDS_MAX).map(str).filter((c) => {
            if (c && !c.startsWith(A2A_PREFIX) && named.has(c)) return true;
            const reason = c.startsWith(A2A_PREFIX) ? `the "${A2A_PREFIX}" prefix is reserved` : "names no described tool";
            dropped.push({ kind: "a2a", name: c.slice(0, TOOL_NAME_MAX) || undefined, reason });
            return false;
        });
        if (commands.length) manifest.a2a = { commands };
    }

    const rawPrompt = asArray(p["prompt"]);
    if (rawPrompt.length > PROMPT_PARTS_MAX) {
        throw new PeerError(`describe: at most ${PROMPT_PARTS_MAX} prompt parts`, "error");
    }
    const prompt: PromptPart[] = rawPrompt.flatMap((x) => {
        const row = x !== null && typeof x === "object" ? (x as Record<string, unknown>) : {};
        const partName = str(row["name"]) || "part";
        const text = str(row["text"]);
        if (text) return [{ name: partName, text }];
        dropped.push({ kind: "prompt", name: partName.slice(0, TOOL_NAME_MAX), reason: "no text" });
        return [];
    });
    // an app that does not name a title and an http(s) upstream the agent itself owns is dropped,
    // like a bad notify target: the agent still describes, it simply registers no app
    let app: AgentApp | undefined;
    const rawApp = p["app"];
    if (rawApp !== null && typeof rawApp === "object" && !Array.isArray(rawApp)) {
        const a = rawApp as Record<string, unknown>;
        const title = str(a["title"]).trim().slice(0, APP_TEXT_MAX);
        const upstream = str(a["upstream"]).trim();
        const parsed = URL.parse(upstream);
        if (
            title &&
            parsed &&
            (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            agentOwnsHost(parsed.hostname, from)
        ) {
            const entry = str(a["entry"]);
            const pages = asArray(a["pages"]).flatMap((x) => {
                if (x === null || typeof x !== "object") return [];
                const row = x as Record<string, unknown>;
                const page: AgentAppPage = { id: str(row["id"]).slice(0, APP_TEXT_MAX), title: str(row["title"]).slice(0, APP_TEXT_MAX) };
                if (!page.id || !page.title) return [];
                const path = str(row["path"]).slice(0, APP_TEXT_MAX);
                if (path.startsWith("/")) page.path = path;
                return [page];
            });
            app = { title, upstream: parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname) };
            if (entry.startsWith("/")) app.entry = entry.slice(0, APP_TEXT_MAX);
            if (pages.length) app.pages = pages.slice(0, APP_PAGES_MAX);
        } else {
            const reason = !title
                ? "no title"
                : parsed?.protocol === "http:" || parsed?.protocol === "https:"
                  ? `upstream host ${parsed.hostname} is not the address this agent connected from`
                  : "upstream is not an http(s) URL";
            dropped.push({ kind: "app", name: title || undefined, reason });
        }
    }
    const packsDisabled: PackDisabled[] = asArray(p["packsDisabled"]).slice(0, PACKS_MAX).flatMap((x) => {
        const row = x !== null && typeof x === "object" ? (x as Record<string, unknown>) : {};
        const pack = str(row["name"]).slice(0, TOOL_NAME_MAX);
        const missing = asArray(row["missing"]).slice(0, PACKS_MAX).map((k) => str(k).slice(0, TOOL_NAME_MAX)).filter(Boolean);
        return pack ? [{ name: pack, missing }] : [];
    });
    // the sent type and sha256 are ignored: both are re-derived from the bytes; a bad avatar counts as none
    let avatar: AgentAvatarRow | null = null;
    const rawAvatar = p["avatar"];
    if (rawAvatar !== undefined && rawAvatar !== null) {
        const data = typeof rawAvatar === "object" ? str((rawAvatar as Record<string, unknown>)["data"]) : "";
        const bytes = Buffer.from(data, "base64");
        const type = avatarType(bytes);
        if (!data) dropped.push({ kind: "avatar", reason: "no base64 data" });
        else if (bytes.toString("base64") !== data) dropped.push({ kind: "avatar", reason: "data is not standard base64" });
        else if (bytes.length > AVATAR_MAX_BYTES) {
            dropped.push({ kind: "avatar", reason: `${bytes.length} bytes, over the ${AVATAR_MAX_BYTES}-byte limit` });
        } else if (!type) dropped.push({ kind: "avatar", reason: "not a PNG, WebP or JPEG image" });
        else avatar = { type, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
    }
    const described: DescribePayload = { manifest, prompt, tools };
    if (app) described.app = app;
    if (packsDisabled.length) described.packsDisabled = packsDisabled;
    return { described, avatar, dropped, bytes: Buffer.byteLength(JSON.stringify(raw), "utf8") };
}

export class Registry {
    hooks: PeerHooks | null = null;
    /** Everything this agent has in flight must end: its socket is gone (disconnected, replaced by a
     *  reconnect) or the owner blocked, revoked or paused it. Core stops its turns, gates and one-shot calls. */
    onStopped: ((name: string, why: "owner" | "gone") => void) | null = null;
    readonly admission: Admissions;

    private readonly opts: RegistryOptions;
    private readonly db: GatewayDb;
    private readonly log: (msg: string) => void;
    private readonly events: EventHub;
    private readonly peers = new Map<string, AgentPeer>();
    private readonly health = new Map<
        string,
        { at: number; ok: HealthOkPayload | null; error: string | null }
    >();
    /** Per agent name, not per socket: a reconnect does not refill the budget. */
    private readonly redescribes = new Map<string, number[]>();
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(opts: RegistryOptions) {
        this.opts = opts;
        this.db = opts.db ?? gatewayDb();
        this.log = opts.log ?? ((): void => undefined);
        this.events = opts.events;
        this.admission = new Admissions(this.db);
    }

    /** Wrap a fresh channel adapter; nothing is registered until hello AND describe have both
     *  passed. `pinName` is the agent name the /channel handshake's lookup already bound this
     *  key to — hello must repeat it exactly. */
    accept(socket: AgentSocket, pinName: string, from: string | null = null): AgentPeer {
        const { deadlineGraceMs, defaultTimeoutMs } = this.opts;
        const peer = new AgentPeer(socket, pinName, this.log, from, deadlineGraceMs, defaultTimeoutMs);
        peer.onRequest = (frame, p) => this.serve(frame, p);
        peer.onClosed = (p) => this.forget(p);
        // hello is one small frame; describe can near 1 MiB on a thin uplink, so it keeps the longer wait
        setTimeout(() => {
            if (peer.stage === "new" && peer.socket.open) peer.close(1002, "no hello in time");
        }, HELLO_TIMEOUT_MS).unref();
        setTimeout(() => {
            if (peer.stage !== "ready" && peer.socket.open) peer.close(1002, "handshake not completed");
        }, HANDSHAKE_TIMEOUT_MS).unref();
        return peer;
    }

    get(name: string): AgentPeer | undefined {
        const peer = this.peers.get(name);
        return peer && peer.connected ? peer : undefined;
    }

    list(): AgentInfo[] {
        const rows = new Map(this.db.listAgentsRegistry().map((r) => [r.name, r]));
        const pins = new Map(this.admission.list().map((p) => [p.name, p]));
        const pauses = new Map(this.db.listPauses().map((p) => [p.agent, p.paused]));
        return [...new Set([...this.peers.keys(), ...rows.keys(), ...pins.keys()])]
            .sort()
            .map((name) => this.info(name, rows.get(name) ?? null, pins.get(name) ?? null, pauses.get(name) ?? false));
    }

    /** list() supplies the rows it already loaded to avoid per-agent reads. */
    info(
        name: string,
        row = this.db.getAgentRegistry(name),
        pin = this.admission.get(name),
        paused = this.db.isPaused(name),
    ): AgentInfo {
        const peer = this.peers.get(name);
        const stored = peer?.describe ?? (row?.describe as Pick<DescribePayload, "manifest" | "tools"> | undefined);
        const h = this.health.get(name);
        // the db stamps last_seen as UTC "YYYY-MM-DD HH:MM:SS", which Date.parse needs told
        const storedSeen = row ? Date.parse(`${row.lastSeen.replace(" ", "T")}Z`) : NaN;
        return {
            name,
            connected: peer?.connected === true,
            status: pin?.status ?? null,
            perms: pin?.perms ?? noPerms(),
            fingerprint: pin?.fingerprint ?? null,
            paused,
            lastSeen: peer?.lastSeen ?? (Number.isNaN(storedSeen) ? 0 : storedSeen),
            connectedAt: peer ? peer.connectedAt : null,
            manifest: stored?.manifest ?? null,
            tools: stored?.tools ?? [],
            avatar: row?.avatar ?? null,
            health: h?.ok ?? null,
            healthError: h?.error ?? null,
        };
    }

    /** Gateway-side only: the agent is never told, because the gate that enforces it is here. */
    setPaused(name: string, paused: boolean): void {
        this.db.setPaused(name, paused);
        if (paused) this.onStopped?.(name, "owner");
        this.events.emit({ type: "agent_changed", name });
    }

    isPaused(name: string): boolean {
        return this.db.isPaused(name);
    }

    startHealth(intervalMs = this.opts.healthIntervalMs ?? HEALTH_INTERVAL_MS): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.poll(), intervalMs);
        this.timer.unref();
    }

    async poll(): Promise<void> {
        await Promise.all(
            [...this.peers.values()].map(async (peer) => {
                if (!peer.connected) return;
                const before = this.health.get(peer.name)?.error ?? null;
                let ok: HealthOkPayload | null = null;
                let error: string | null = null;
                try {
                    ok = await peer.request(
                        "health",
                        {},
                        { timeoutMs: HEALTH_TIMEOUT_MS },
                    );
                } catch (e) {
                    error = (e as Error).message;
                }
                if (this.peers.get(peer.name) !== peer) return;
                this.health.set(peer.name, { at: Date.now(), ok, error });
                // the dashboard's health is derived from the error, so only a changed error on the live peer is news
                if (error !== before) {
                    this.events.emit({ type: "agent_changed", name: peer.name });
                }
            }),
        );
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        for (const peer of [...this.peers.values()]) peer.close(1001, "gateway stopping");
        this.peers.clear();
    }

    private async serve(frame: IncomingRequest, peer: AgentPeer): Promise<unknown> {
        if (frame.type === "hello") return this.hello(frame.payload, peer);
        if (frame.type === "describe") return this.described(frame.payload, peer);
        if (peer.stage !== "ready") throw new PeerError("handshake not complete", "error");
        const hooks = this.hooks;
        if (!hooks) throw new PeerError("gateway is not wired", "error");
        switch (frame.type) {
            case "chat":
                return hooks.chat(peer, frame.id, chatPayload(frame.payload));
            case "ask_approve":
                return hooks.askApprove(peer, askApprovePayload(frame.payload));
            case "a2a_call":
                return hooks.a2aCall(
                    peer,
                    payloadObject("a2a_call", frame.payload) as unknown as A2aCallPayload,
                );
            case "session_changed":
                hooks.changed(
                    peer,
                    payloadObject("session_changed", frame.payload) as unknown as SessionHead,
                );
                return {};
            case "notify":
                hooks.notify(peer, notifyPayload(frame.payload));
                return {};
            default:
                throw new PeerError(`unknown frame type "${frame.type}"`, "error");
        }
    }

    /** The socket is closed a beat later so the refusal reply is on the wire before the close. */
    private refusal(peer: AgentPeer, reason: string, code = 1008): PeerError {
        // the close frame holds 123 BYTES, not characters, and this reason carries agent-sent text
        const short = Buffer.from(reason, "utf8").subarray(0, 100).toString("utf8");
        setTimeout(() => {
            try {
                peer.close(code, short);
            } catch (e) {
                // a throw here is uncaught — it would end the gateway, and the refusal reply is already out
                this.log(`[registry] ${peer.pinName}: refusal close failed — ${(e as Error).message}\n`);
            }
        }, 10).unref();
        return new PeerError(reason, "denied");
    }

    /** Identity is already decided by the /channel handshake's lookup (registry/devices.ts); hello
     *  only has to repeat the name that handshake pinned this key to. */
    private hello(raw: unknown, peer: AgentPeer): HelloOkPayload {
        // one hello per socket: a second one would rename a peer the map already holds
        if (peer.stage !== "new") throw new PeerError("hello: this socket already greeted", "error");
        const p = (raw ?? {}) as Partial<HelloPayload>;
        const name = typeof p.agent === "string" ? p.agent : "";
        if (name !== peer.pinName) {
            throw this.refusal(peer, `hello: agent name "${name}" does not match the pinned identity`);
        }
        peer.name = name;
        this.admission.seen(name, peer.from);
        peer.stage = "helloed";
        return {};
    }

    /** The first describe registers the peer; a later one refreshes it, since a pack's prompt text can change. */
    private described(raw: unknown, peer: AgentPeer): DescribeOkPayload {
        if (peer.stage === "new") throw new PeerError("describe before hello", "error");
        const refresh = peer.stage === "ready";
        if (refresh && this.peers.get(peer.name) !== peer) {
            throw new PeerError("describe: this connection was replaced", "error");
        }
        const { described, avatar, dropped, bytes } = validateDescribe(peer.name, raw, peer.from);
        peer.dropped = dropped;
        peer.describeBytes = bytes;
        peer.avatar = avatar;
        const status = this.admission.status(peer.name);
        const models = status === "approved" ? this.grants(peer.name) : [];
        // the SDK re-sends its avatar on every file event, so only a new hash is written and announced
        const avatarChanged = (avatar?.sha256 ?? null) !== (this.db.getAgentRegistry(peer.name)?.avatar ?? null);
        if (refresh) {
            // the prompt is read live off the peer; only the catalog (manifest, tools, app, avatar) is stored and announced
            const before = peer.describe;
            peer.describe = described;
            if (
                !avatarChanged &&
                JSON.stringify([described.manifest, described.tools, described.app]) === JSON.stringify([before?.manifest, before?.tools, before?.app])
            ) {
                return { models };
            }
            const now = Date.now();
            const recent = (this.redescribes.get(peer.name) ?? []).filter((t) => now - t < 60_000);
            // over budget the db and the devices catch up at a later refresh or at disconnect
            if (recent.length >= REDESCRIBES_PER_MIN) return { models };
            recent.push(now);
            this.redescribes.set(peer.name, recent);
        }
        this.db.upsertAgentRegistry(peer.name, { manifest: described.manifest, tools: described.tools });
        if (avatarChanged) this.db.setAgentAvatar(peer.name, avatar);
        // persisted, so the app survives this socket: an offline agent stays in /api/apps
        if (described.app) {
            this.db.upsertAgentApp({
                agent: peer.name,
                appId: peer.name,
                title: described.app.title,
                entry: described.app.entry,
                pages: described.app.pages,
                upstream: described.app.upstream,
            });
        } else this.db.deleteAgentApp(peer.name, peer.name);
        if (refresh) {
            this.events.emit({ type: "agent_changed", name: peer.name });
            return { models };
        }
        peer.describe = described;
        peer.stage = "ready";

        const old = this.peers.get(peer.name);
        if (old && old !== peer) {
            // drop the map entry FIRST: the old socket's close handler must not evict the new one
            this.peers.delete(peer.name);
            old.close(1000, "replaced by a newer connection");
            // the old socket's forget() sees the map entry already gone, so it is silent — this is
            // where the work that socket parked is settled, before the successor is registered
            this.onStopped?.(peer.name, "gone");
            this.log(`[registry] ${peer.name}: reconnected — the previous socket was closed\n`);
        }
        this.peers.set(peer.name, peer);
        this.events.emit({ type: "agent_changed", name: peer.name });
        this.log(
            `[registry] ${peer.name}: ready (${described.tools.length} tool(s))` +
                `${status === "approved" ? "" : ` — ${status === "blocked" ? "blocked" : "no pin"}, no model grants`}\n`,
        );
        return { models };
    }

    /** The agent's own copy, refreshed on reconnect; the gateway re-reads the policy live. */
    private grants(name: string): ModelGrant[] {
        if (this.opts.grants) return this.opts.grants(name);
        return modelGrantsFor(name, this.db);
    }

    /** null = no pin for that name. */
    statusOf(name: string): PinStatus | null {
        return this.admission.status(name);
    }

    pins(): PinCard[] {
        return this.admission.list();
    }

    pin(name: string): PinCard | null {
        return this.admission.get(name);
    }

    /** Enforcement is gateway-side: an approval takes effect on the live socket at once. */
    approve(name: string): PinCard | null {
        const card = this.admission.approve(name);
        if (card) this.events.emit({ type: "agent_changed", name });
        return card;
    }

    block(name: string): PinCard | null {
        const card = this.admission.block(name);
        if (card) {
            this.disconnect(name, 1008, "blocked");
            this.events.emit({ type: "agent_changed", name });
        }
        return card;
    }

    setPerms(name: string, perms: PinPerms): PinCard | null {
        const card = this.admission.setPerms(name, perms);
        if (card) this.events.emit({ type: "agent_changed", name });
        return card;
    }

    /** Revoke = the pin is gone; the live channel session goes with it. */
    revoke(name: string): boolean {
        const gone = this.admission.revoke(name);
        if (gone) {
            this.disconnect(name, 1008, "pin revoked");
            this.events.emit({ type: "agent_changed", name });
        }
        return gone;
    }

    private disconnect(name: string, code: number, reason: string): void {
        // an offline agent can still hold a parked gate or a queued model call, so this comes first
        this.onStopped?.(name, "owner");
        const peer = this.peers.get(name);
        if (!peer) return;
        this.peers.delete(name);
        this.health.delete(name);
        peer.close(code, reason);
    }

    private forget(peer: AgentPeer): void {
        // identity check: a socket replaced on reconnect closes AFTER its successor registered,
        // so an unguarded delete here would evict the live connection
        if (this.peers.get(peer.name) !== peer) return;
        if (peer.describe) {
            this.db.upsertAgentRegistry(peer.name, { manifest: peer.describe.manifest, tools: peer.describe.tools });
            if ((peer.avatar?.sha256 ?? null) !== this.db.getAgentRegistry(peer.name)?.avatar) this.db.setAgentAvatar(peer.name, peer.avatar);
        }
        this.peers.delete(peer.name);
        this.health.delete(peer.name);
        this.onStopped?.(peer.name, "gone");
        this.log(`[registry] ${peer.name}: disconnected\n`);
        this.events.emit({ type: "agent_changed", name: peer.name });
    }
}
