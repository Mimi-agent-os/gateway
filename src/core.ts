/** Composition: channel upgrade → device plane → registry → the turn loop; HTTP routing lives in src/http. */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type {
    A2aCallOkPayload,
    AskApprovePayload,
    ChatOkPayload,
    ChatPayload,
    FinishReason,
    NotifyPayload,
    NotifyTarget,
    OwnerAnswer,
    SessionHead,
    SessionId,
    SessionSummary,
    ToolCall,
    Usage,
} from "@mimi-os/protocol";

import { isAgentName } from "@mimi-os/protocol";

import { createAppBridge, type AppBridge } from "./apps/bridge.ts";
import { AppTickets } from "./apps/tickets.ts";
import { EventHub, type HubEvent } from "./events.ts";
import { estimateUsage, newCallId, recordLlmCall, setUsageRecordedHook } from "./store/accounting.ts";
import { gatewayDb, type GatewayDb } from "./store/db.ts";
import type { GateCard, GateContext, GateSummary } from "./gates/gate-types.ts";
import { Gates } from "./gates/gates.ts";
import { NotSentError } from "./llm/base/index.ts";
import { createProvider } from "./llm/models.ts";
import { admitAtDequeue, LimitReached, resolveModelFor } from "./llm/policy.ts";
import { enqueueCall } from "./llm/queue.ts";
import { runA2a } from "./turn/a2a.ts";
import { TRUNCATION_MARKER } from "./turn/chain.ts";
import { runTurn } from "./turn/loop.ts";
import { systemPrompt, visibleTo } from "./turn/prompt.ts";
import { TurnRun, type CompleteTurn } from "./turn/run.ts";
import type { LoopDeps, TurnOutcome, TurnRequest } from "./turn/loop-types.ts";
import { Push, type PushOptions } from "./push.ts";
import { PeerError, type AgentPeer } from "./registry/peer.ts";
import { Registry } from "./registry/registry.ts";
import type { AgentInfo } from "./registry/registry-types.ts";
import { isSessionId, SessionCache } from "./turn/sessions.ts";
import { DeviceService, type DeviceServiceOptions } from "./registry/devices.ts";
import { createTunnels } from "./registry/tunnel.ts";

export interface GatewayCoreOptions {
    db?: GatewayDb;
    log?: (msg: string) => void;
    healthIntervalMs?: number | undefined;
    cache?: { maxBytes?: number | undefined; ttlMs?: number | undefined };
    /** Tests only: the window an agent's own chat notices fold in. */
    changedWindowMs?: number | undefined;
    /** Tests only: how long past a request's deadline the gateway still waits for the agent. */
    deadlineGraceMs?: number | undefined;
    /** Tests only: how long a request with neither a deadline nor a timeout of its own waits (30 s). */
    defaultTimeoutMs?: number | undefined;
    /** Tests only: how long an ask_owner question waits for the owner. */
    questionTimeoutMs?: number | undefined;
    /** Tests only: how long an approval waits for the owner (5 min). */
    approvalTimeoutMs?: number | undefined;
    /** Tests only: when an open gate asks push again for a phone that froze as it parked (61 s). */
    gateRewakeMs?: number | undefined;
    /** Tests only: the launch-session lifetime, and the bridge's reply deadlines. */
    apps?: { ttlMs?: number | undefined; headMs?: number | undefined; stallMs?: number | undefined };
    /** Tests only: device-plane clocks, sweeps and pre-auth bounds. */
    devices?: DeviceServiceOptions;
    /** The FCM account the boot read, none = push off; tests add a fake fetch and clock. */
    push?: PushOptions;
}

export interface GatewayCore {
    readonly registry: Registry;
    readonly gates: Gates;
    /** The device fanout every /api/events stream rides. */
    readonly events: EventHub;
    readonly sessions: SessionCache;
    /** The browser door's launch sessions, and the one bridge both app doors carry requests over. */
    readonly appTickets: AppTickets;
    readonly appBridge: AppBridge;
    /** The secure channel: /channel, /channel/pair, invites and the device decisions. */
    readonly devices: DeviceService;
    readonly db: GatewayDb;
    /** true = the upgrade was ours (accepted or refused); false = not our path. */
    handleUpgrade(req: IncomingMessage, duplex: Duplex, head: Buffer): boolean;
    runTurn(req: TurnRequest): Promise<TurnOutcome>;
    listAgents(): AgentInfo[];
    agent(name: string): AgentInfo;
    setPaused(name: string, paused: boolean): void;
    approvals: {
        pending(): GateSummary[];
        describe(gate: string): GateCard | null;
        answer(gate: string, decisions: Record<string, boolean>): boolean;
        /** A question gate's checked answers; null dismisses it. */
        reply(gate: string, answers: OwnerAnswer[] | null): boolean;
    };
    session: {
        create(agent: string, opts?: { title?: string; titleByUser?: boolean }): Promise<SessionHead>;
        /** Every row checked field by field; a row off the contract is dropped and logged. */
        list(agent: string, includeArchived?: boolean): Promise<Omit<SessionSummary, "head">[]>;
        update(
            agent: string,
            patch: { session: SessionId; title?: string; titleByUser?: boolean; archived?: boolean; pinned?: boolean },
        ): Promise<boolean>;
        remove(agent: string, session: SessionId): Promise<boolean>;
    };
    readonly turns: {
        start(req: TurnRequest, complete?: CompleteTurn): TurnRun;
        get(agent: string, session: SessionId | null): TurnRun | undefined;
        room(room: string): TurnRun | undefined;
        forAgent(agent: string): TurnRun[];
    };
    stop(): Promise<void>;
}

/** An agent may say six unprompted things a minute — past that it's a log, not a report. */
const NOTIFY_PER_MIN = 6;
const NOTIFY_TITLE_MAX = 200;
const NOTIFY_BODY_MAX = 65_536;
const NOTIFY_TARGET_MAX = 500;
/** A person answers approvals one at a time: an agent may not park more cards than one can read,
 *  ask faster than one can decide, or hold agent-sized payloads for the five minutes each waits. */
const ASK_PER_MIN = 12;
const ASK_OPEN_MAX = 8;
const ASK_LABEL_MAX = 200;
const ASK_DETAIL_MAX = 8_192;
/** One socket may not hold an unbounded queue of already-admitted model calls. */
const CHAT_IN_FLIGHT_MAX = 4;
/** An agent's own chat notices fold per window: one trailing chat_changed per chat, at most this many chats. */
const CHANGED_WINDOW_MS = 250;
const CHANGED_CHATS_MAX = 32;
/** Past push's 60 s "heard from" mark and its 30 s per-device window: a phone silent since the park is due by then. */
const GATE_REWAKE_MS = 61_000;

export function createGatewayCore(opts: GatewayCoreOptions = {}): GatewayCore {
    const db = opts.db ?? gatewayDb();
    const log = opts.log ?? ((msg: string): void => void process.stderr.write(msg));

    const events = new EventHub(log);
    const gates = new Gates({
        log,
        questionTimeoutMs: opts.questionTimeoutMs,
        approvalTimeoutMs: opts.approvalTimeoutMs,
        onPark: (g) => {
            events.emit({
                type: "approval",
                kind: g.kind,
                agent: g.agent,
                session: g.session,
                room: g.room ?? undefined,
                gate: g.gate,
                tool: g.tool,
                actions: g.actions,
            });
            // a phone that froze just before the park still counted as online then, and nothing else wakes it while the gate waits
            const again = setTimeout(() => {
                if (gates.pending().some((p) => p.gate === g.gate)) void push.wake();
            }, opts.gateRewakeMs ?? GATE_REWAKE_MS);
            again.unref();
        },
        onResolve: (g) => {
            // keyed by the gate id the device decided against, so a stale card can be retired everywhere
            events.emit({ type: "approval_resolved", gate: g.gate, outcome: g.outcome });
            if (g.kind !== "approval" || g.outcome !== "expired") return;
            // the one record that the owner never answered, not refused: the turn's card goes with the turn
            const row = db.insertInboxItem({
                source: "system",
                title: `An approval for ${g.agent} expired unanswered`,
                body: g.actions === 1
                    ? "Nobody answered in time, so the call did not run."
                    : `Nobody answered in time, so none of its ${g.actions} calls ran.`,
                level: "warn",
                target: g.session === null ? null : { kind: "chat", agent: g.agent, session: g.session },
            });
            events.emit({ type: "inbox_item", id: row.id, source: row.source, agent: row.agent, title: row.title, level: row.level });
        },
    });
    const registry = new Registry({
        db,
        log,
        events,
        healthIntervalMs: opts.healthIntervalMs,
        deadlineGraceMs: opts.deadlineGraceMs,
        defaultTimeoutMs: opts.defaultTimeoutMs,
    });
    setUsageRecordedHook(db, (agent) => events.emit({ type: "usage_changed", agent }));
    const sessions = new SessionCache({ registry, log, maxBytes: opts.cache?.maxBytes, ttlMs: opts.cache?.ttlMs });
    const appTickets = new AppTickets({ events, ttlMs: opts.apps?.ttlMs });
    const appBridge = createAppBridge({ db, registry, events, log, headMs: opts.apps?.headMs, stallMs: opts.apps?.stallMs });
    const devices = new DeviceService(db, events, log, opts.devices);
    // a frozen app keeps its socket open but stops its 25 s pings: two missed ones count as offline
    const push = new Push(db, log, (id) => devices.connected(id, 60_000), opts.push);
    const deps: LoopDeps = {
        registry,
        sessions,
        gates,
        db,
        events,
        log,
        startTurn: (req) => turns.start(req).result,
    };

    devices.onAgentSession = (adapter, pinName, from) => registry.accept(adapter, pinName, from);

    // news for a phone whose app is closed; a finished chat reply wakes it in turns.start
    events.subscribe((ev) => {
        if (ev.type === "approval" || ev.type === "inbox_item" || ev.type === "device_enrolled") void push.wake();
    });

    // a redeemed agent invite is news to the person
    events.subscribe((ev) => {
        if (ev.type !== "agent_enrolled" || typeof ev["agent"] !== "string") return;
        const agent = ev["agent"];
        // the hub drops a listener that throws: one failed write must not end this for every later enrolment
        try {
            const row = db.insertInboxItem({
                source: "system",
                title: `New agent connected: ${agent}`,
                body:
                    `An invite was just redeemed as "${agent}". Check its permissions and its model policy in the app. ` +
                    `An agent with no model policy of its own may use only the default model.`,
                level: "action",
            });
            events.emit({ type: "inbox_item", id: row.id, source: row.source, agent: row.agent, title: row.title, level: row.level });
        } catch (e) {
            log(`[registry] agent ${agent} enrolled, but its Inbox item failed: ${(e as Error).message}\n`);
        }
    });

    /** A sliding minute per agent and frame kind: what an agent starts by itself is never unbounded. */
    const rates = new Map<string, number[]>();
    const withinRate = (kind: string, agent: string, perMin: number): boolean => {
        const now = Date.now();
        const key = `${kind}:${agent}`;
        const hits = (rates.get(key) ?? []).filter((t) => now - t < 60_000);
        rates.set(key, hits);
        if (hits.length >= perMin) return false;
        hits.push(now);
        return true;
    };
    /** What one agent may park in front of the person, whichever frame parks it: `ask_approve` and
     *  the write gate an `a2a_call` parks share the cards, the payload budget and the rate. */
    const admitAsk = (agent: string, kind: string, detail: unknown): void => {
        // a card parked now would hold stop() for its five minutes, and nobody is left to answer it
        if (shutdown.signal.aborted) throw new PeerError(`${kind}: the gateway is stopping`, "denied");
        if (detail !== undefined && JSON.stringify(detail).length > ASK_DETAIL_MAX) {
            throw new PeerError(`${kind}: detail is over ${ASK_DETAIL_MAX} serialized chars`, "error");
        }
        const open = gates.pending().filter((g) => g.agent === agent).length;
        if (open >= ASK_OPEN_MAX) {
            throw new PeerError(`"${agent}" already has ${open} approvals waiting — answer one first`, "denied");
        }
        if (!withinRate("ask_approve", agent, ASK_PER_MIN)) {
            throw new PeerError(`${kind}: over ${ASK_PER_MIN}/min for "${agent}"`, "denied");
        }
    };

    /** The one-shot model calls each agent has admitted — queued ones included, so they can be dropped. */
    const chatCalls = new Map<string, Set<AbortController>>();
    /** Per agent: the chats its own notices named in the open window, and the timer that announces them. */
    const changedBursts = new Map<string, { chats: Set<number>; timer: NodeJS.Timeout }>();

    const runs = new Map<string, TurnRun>();
    /** Per chat: what its turns still have running, down to the title call a finished turn leaves behind. */
    const chatWork = new Map<string, Set<AbortController>>();
    const shutdown = new AbortController();
    const active = new Set<Promise<unknown>>();
    let stopping: Promise<void> | null = null;

    const track = <T>(work: Promise<T>): Promise<T> => {
        active.add(work);
        void work.then(
            () => active.delete(work),
            () => active.delete(work),
        );
        return work;
    };

    const turns: GatewayCore["turns"] = {
        start: (req, complete) => {
            if (stopping) throw new Error("gateway is stopping");
            const key = req.room ? `room#${req.room.room}` : `${req.agent}#${req.session}`;
            if (runs.has(key)) throw new Error("a turn is already running here");
            // announced as the turn starts and as it settles, so every screen's busy mark follows it
            const changed: HubEvent = req.room
                ? { type: "room_changed", room: req.room.room }
                : { type: "chat_changed", agent: req.agent, session: req.session };
            const run = new TurnRun(req, shutdown.signal, async (signal, emit) => {
                // deleting the chat aborts this: the turn, then the title call it leaves behind
                const work = new AbortController();
                const held = chatWork.get(key) ?? new Set<AbortController>();
                chatWork.set(key, held.add(work));
                let titling: Promise<unknown> = Promise.resolve();
                try {
                    const outcome = await runTurn(deps, { ...req, signal: AbortSignal.any([signal, work.signal]), emit });
                    if (!req.room && !req.depth && !outcome.dropped && !signal.aborted) void push.wake();
                    if (outcome.titling) {
                        titling = track(outcome.titling.then((titled) => {
                            if (titled) events.emit(changed);
                        }));
                    }
                    if (complete) emit(complete(outcome, signal));
                    return outcome;
                } catch (error) {
                    if (complete) emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
                    throw error;
                } finally {
                    runs.delete(key);
                    events.emit(changed);
                    void titling.finally(() => {
                        held.delete(work);
                        if (held.size === 0 && chatWork.get(key) === held) chatWork.delete(key);
                    });
                }
            }, () => {
                if (req.room) gates.cancelRoom(req.room.room);
                else gates.cancel(req.agent, req.session);
            });
            runs.set(key, run);
            events.emit(changed);
            return run;
        },
        get: (agent, session) => {
            if (session !== null) return runs.get(`${agent}#${session}`);
            // an ask that names no chat belongs to a room turn only while that turn runs a tool; a cron's is nobody's turn
            return [...runs.values()].findLast((run) => run.agent === agent && run.session === null && run.inTool);
        },
        room: (room) => runs.get(`room#${room}`),
        forAgent: (agent) => [...runs.values()].filter((run) => run.agent === agent),
    };

    const peerOf = (name: string): AgentPeer => {
        const peer = registry.get(name);
        if (!peer) throw new Error(`agent "${name}" is not connected`);
        return peer;
    };

    // a gate, a turn and a model call belong to the connection and the admission that started them:
    // the socket going away, a block, a revoke and a pause all settle them here
    registry.onStopped = (name, why) => {
        for (const run of turns.forAgent(name)) run.stop(why);
        gates.cancel(name);
        for (const call of chatCalls.get(name) ?? []) {
            call.abort(new PeerError(`"${name}" stopped — the call was cancelled`, "denied"));
        }
    };

    registry.hooks = {
        chat: (peer, id, p) => {
            const calls = chatCalls.get(peer.name) ?? new Set<AbortController>();
            if (calls.size >= CHAT_IN_FLIGHT_MAX) {
                throw new PeerError(
                    `"${peer.name}" already has ${calls.size} model calls in flight — wait for one to answer`,
                    "denied",
                );
            }
            const call = new AbortController();
            calls.add(call);
            chatCalls.set(peer.name, calls);
            return track(
                oneShot(peer, id, p, AbortSignal.any([shutdown.signal, call.signal])).finally(() => {
                    calls.delete(call);
                    if (calls.size === 0) chatCalls.delete(peer.name);
                }),
            );
        },
        askApprove: async (peer, p: AskApprovePayload) => {
            // a blocked or unknown name parks no cards in the pult
            const admission = registry.statusOf(peer.name);
            if (admission !== "approved") {
                throw new PeerError(`"${peer.name}" ${admission === "blocked" ? "is blocked" : "has no pin"} — it cannot ask for approvals`, "denied");
            }
            // a stopped agent asks for nothing: the owner just denied everything it had parked
            if (registry.isPaused(peer.name)) {
                throw new PeerError(`"${peer.name}" is paused — it cannot ask for approvals`, "denied");
            }
            const label = p.label.trim();
            if (!label || label.length > ASK_LABEL_MAX) {
                throw new PeerError(`ask_approve: label must be 1-${ASK_LABEL_MAX} chars`, "error");
            }
            const session = p.session ?? null;
            if (session !== null && !isSessionId(session)) {
                throw new PeerError("ask_approve: session must be a positive integer", "error");
            }
            const detail = p.detail;
            const shaped = detail === undefined ||
                (detail !== null && typeof detail === "object" && !Array.isArray(detail));
            if (!shaped) throw new PeerError("ask_approve: detail must be an object", "error");
            admitAsk(peer.name, "ask_approve", detail);
            const ctx: GateContext = {
                agent: peer.name,
                session,
                emit: turns.get(peer.name, session)?.emit,
                // asked from inside a request the gateway set a deadline on: the SDK stops listening when
                // that deadline passes, so the card dies with it. A chat's ask comes from a chat invoke, never an a2a one
                deadline: peer.deadlineAt(session === null ? undefined : "invoke"),
            };
            const outcome = await gates.askOne(ctx, label, detail);
            return outcome === "approved" ? { approved: true } : { approved: false, reason: outcome };
        },
        a2aCall: (peer, p) =>
            track(
                (async (): Promise<A2aCallOkPayload> => {
                    const target = typeof p.agent === "string" ? p.agent : "";
                    const command = typeof p.command === "string" ? p.command : "";
                    if (!target || !command) {
                        throw new PeerError("a2a_call: agent and command must be non-empty strings", "error");
                    }
                    const args =
                        p.args !== null && typeof p.args === "object" && !Array.isArray(p.args) ? p.args : {};
                    // a write command parks a card holding these args for five minutes: the same
                    // budget as ask_approve, charged before the call is routed anywhere
                    admitAsk(peer.name, "a2a_call", args);
                    // no running turn behind this frame: the same session-less slot ask_approve uses
                    const ctx: GateContext = {
                        agent: peer.name,
                        session: null,
                        emit: turns.get(peer.name, null)?.emit,
                        // as ask_approve: the card dies with the request this caller is serving
                        deadline: peer.deadlineAt(),
                    };
                    const result = await runA2a(deps, { from: peer.name, target, command, args, gateCtx: ctx });
                    return { result };
                })(),
            ),
        // the agent wrote to a chat on its own (a cron, a bridge); the head is its word, so only a real id fans out
        changed: (peer, head) => {
            // a window opened while stop() winds down would outlive it: its timer is never cleared
            if (!isSessionId(head.session) || shutdown.signal.aborted) return;
            const agent = peer.name;
            const open = changedBursts.get(agent);
            if (open) {
                if (open.chats.size < CHANGED_CHATS_MAX) open.chats.add(head.session);
                return;
            }
            const chats = new Set([head.session]);
            const timer = setTimeout(() => {
                changedBursts.delete(agent);
                if (registry.isPaused(agent)) return;
                for (const session of chats) events.emit({ type: "chat_changed", agent, session });
            }, opts.changedWindowMs ?? CHANGED_WINDOW_MS);
            changedBursts.set(agent, { chats, timer });
        },
        // the agent talking to the PERSON, filed as an Inbox item: conditions it cannot fix
        // (admission, rate) are a silent drop; bad data of its own making is a loud error instead
        notify: (peer, p: NotifyPayload) => {
            const status = registry.statusOf(peer.name);
            if (status !== "approved") {
                log(`[notify] ${peer.name} ${status === "blocked" ? "is blocked" : "has no pin"} — dropped\n`);
                return;
            }
            if (registry.isPaused(peer.name)) {
                log(`[notify] ${peer.name} is paused — dropped\n`);
                return;
            }
            const fullTitle = typeof p.title === "string" ? p.title.trim() : "";
            if (!fullTitle) throw new PeerError("notify: title must not be empty", "error");
            // clamped, never refused: a notice gets no reply, so a refusal would lose it without a word
            const title = fullTitle.length <= NOTIFY_TITLE_MAX
                ? fullTitle
                : `${fullTitle.slice(0, NOTIFY_TITLE_MAX - 1).toWellFormed()}…`;
            const fullBody = typeof p.body === "string" ? p.body : "";
            const body = fullBody.length <= NOTIFY_BODY_MAX
                ? fullBody
                : `${fullBody.slice(0, NOTIFY_BODY_MAX - TRUNCATION_MARKER.length).toWellFormed()}${TRUNCATION_MARKER}`;
            const level = p.level === "warn" || p.level === "action" ? p.level : "info";
            // carried verbatim to the devices: the gateway checks the shape and never reads `route`
            const t = p.target;
            let target: NotifyTarget | null = null;
            if (t !== undefined) {
                if (!isAgentName(t.agent) || t.agent !== peer.name) {
                    throw new PeerError(`notify: target.agent must be "${peer.name}"`, "error");
                }
                if (t.kind !== "chat" && t.kind !== "app") {
                    throw new PeerError('notify: target.kind must be "chat" or "app"', "error");
                }
                target = {
                    kind: t.kind,
                    agent: t.agent,
                    session: isSessionId(t.session) ? t.session : undefined,
                    route: typeof t.route === "string" ? t.route.slice(0, NOTIFY_TARGET_MAX) : undefined,
                };
            }
            if (!withinRate("notify", peer.name, NOTIFY_PER_MIN)) {
                log(`[notify] ${peer.name}: over ${NOTIFY_PER_MIN}/min — dropped\n`);
                return;
            }
            const row = db.insertInboxItem({ source: "agent", agent: peer.name, title, body, level, target });
            events.emit({ type: "inbox_item", id: row.id, source: row.source, agent: row.agent, title: row.title, level: row.level });
        },
    };

    /** A model call the agent makes for itself — same queue, same accounting, same limits. The
     *  signal ends it when the gateway stops, and when the agent behind it does. */
    async function oneShot(
        peer: AgentPeer,
        id: string,
        p: ChatPayload,
        signal: AbortSignal,
    ): Promise<ChatOkPayload> {
        signal.throwIfAborted();
        const agent = peer.name;
        // a blocked or unknown agent burns zero tokens: the refusal happens before a provider is even chosen
        const status = registry.statusOf(agent);
        if (status !== "approved") {
            throw new PeerError(`"${agent}" ${status === "blocked" ? "is blocked" : "has no pin"} — no model access`, "denied");
        }
        // pause is durable in gateway.db and enforced HERE — the agent is never told about it
        if (registry.isPaused(agent)) {
            throw new PeerError(`"${agent}" is paused — no model calls until it is resumed`, "denied");
        }
        // the same one gate the turn loop uses: resolution order, allowed-list, the model's daily limit
        const resolved = resolveModelFor(agent, p.model, peer.describe?.manifest.model, db);
        if (!resolved.ok) throw new PeerError(resolved.reason, resolved.denied ? "denied" : "error");
        // a text-only fallback standing in for a full primary must not answer blind what the primary could see
        if (resolved.replaces?.vision && !resolved.cfg.vision && p.messages.some((m) => m.images?.length)) {
            throw new LimitReached(resolved.replaces.name);
        }
        let cfg = resolved.cfg;
        let provider = createProvider(cfg.name, db);
        const messages = p.withPrompt === true ? [systemPrompt(peer), ...p.messages] : p.messages;
        const tools = p.tools ?? [];
        const scope = `${agent}:${p.scope ?? "chat"}`;
        const wantStream = p.stream === true;
        let thinking = "";
        let toolCalls: ToolCall[] = [];
        let text = "";
        let finishReason: FinishReason = "error";
        let usage: Usage | undefined;

        let lastCallId: string | null = null;
        const attempt = async (
            callScope: string,
            attemptNo: number,
            parentCallId: string | null,
        ): Promise<unknown> => {
            thinking = "";
            text = "";
            toolCalls = [];
            finishReason = "error";
            usage = undefined;
            let reported: string | undefined;
            let failed: unknown = null;
            const t0 = performance.now();
            const callId = newCallId();
            lastCallId = callId;
            let firstOutputMs: number | null = null;
            let dispatched = false;
            let accepted = false;
            let toolArgs = "";
            const sent = visibleTo(cfg.vision, messages);
            try {
                await enqueueCall(
                    cfg.endpointUrl,
                    async () => {
                        // the gate binds at DEQUEUE too: what ran ahead of this call may have spent
                        // the model's limit while this one waited in the queue
                        admitAtDequeue(agent, cfg, db);
                        dispatched = true;
                        for await (const ev of provider.stream(sent, tools, signal)) {
                            // same clock as a turn round: queue INCLUDED, an empty delta is not output
                            if (
                                firstOutputMs === null &&
                                (ev.type === "text" || ev.type === "thinking" || ev.type === "tool_args") &&
                                ev.text !== ""
                            ) {
                                firstOutputMs = Math.round(performance.now() - t0);
                            }
                            switch (ev.type) {
                                case "accepted":
                                    accepted = true;
                                    continue;
                                case "tool_args":
                                    toolArgs += ev.text;
                                    continue;
                                case "thinking":
                                    thinking += ev.text;
                                    break;
                                case "text":
                                    text += ev.text;
                                    break;
                                case "tool_calls":
                                    toolCalls.push(...ev.calls);
                                    break;
                                case "done":
                                    finishReason = ev.finishReason;
                                    usage = ev.usage;
                                    reported = ev.model;
                                    break;
                            }
                            if (wantStream) peer.stream(id, ev);
                        }
                    },
                    "background",
                    signal,
                );
            } catch (e) {
                failed = e;
            }
            // as a turn round: a call the provider had but never reported is estimated, never free
            const estimate =
                usage === undefined && dispatched && !(failed instanceof NotSentError) && (accepted || signal.aborted)
                    ? estimateUsage(sent, tools, thinking + text + toolArgs)
                    : undefined;
            recordLlmCall(
                {
                    agent,
                    scope: callScope,
                    callId,
                    callKind: "oneshot",
                    session: p.session ?? null,
                    model: provider.model ?? null,
                    provider: cfg.provider,
                    registryModel: cfg.name,
                    modelUid: cfg.modelUid,
                    reportedModel: reported ?? null,
                    attempt: attemptNo,
                    parentCallId,
                    finishReason: failed ? "error" : finishReason,
                    usage: usage ?? estimate,
                    usageEstimated: estimate !== undefined,
                    dispatched,
                    durationMs: Math.round(performance.now() - t0),
                    firstOutputMs,
                    raw: failed
                        ? { error: String(failed) }
                        : { thinking, text, toolCalls, finishReason, ...(usage ? { usage } : {}) },
                },
                db,
            );
            return failed;
        };

        let failure = await attempt(scope, 1, null);
        // a provider outage or a limit spent in the queue, exactly once — a finish_reason is an answer,
        // and any other policy refusal (the PeerError above) is not an outage either; a text-only
        // fallback must not answer blind what the primary could see
        const canSee = resolved.fallback?.vision === true || !resolved.cfg.vision || !messages.some((m) => m.images?.length);
        const outage = !!failure && (!(failure instanceof PeerError) || failure instanceof LimitReached);
        if (outage && resolved.fallback && canSee && !signal.aborted) {
            const primaryCallId = lastCallId;
            cfg = resolved.fallback;
            provider = createProvider(cfg.name, db);
            failure = await attempt(`${scope}:fallback`, 2, primaryCallId);
        }
        if (failure) {
            throw failure instanceof PeerError ? failure : new PeerError((failure as Error).message, "error");
        }
        return { text, thinking, toolCalls, finishReason, ...(usage ? { usage } : {}) };
    }

    registry.startHealth();

    const core: GatewayCore = {
        registry,
        gates,
        events,
        sessions,
        appTickets,
        appBridge,
        devices,
        db,
        handleUpgrade: (req, duplex, head) => devices.handleUpgrade(req, duplex, head),

        runTurn: async (req) => turns.start(req).result,
        turns,
        listAgents: () => registry.list(),
        agent: (name) => registry.info(name),

        setPaused: (name, paused) => registry.setPaused(name, paused),

        approvals: {
            pending: () => gates.pending(),
            describe: (gate) => gates.describe(gate),
            answer: (gate, decisions) => gates.answer(gate, decisions),
            reply: (gate, answers) => gates.reply(gate, answers),
        },

        session: {
            create: async (agent, o) => {
                const made = await peerOf(agent).request("session_create", o ?? {});
                if (!isSessionId(made.head?.session)) throw new Error(`agent "${agent}" answered without a real chat id`);
                events.emit({ type: "chat_changed", agent, session: made.head.session });
                return made.head;
            },
            list: async (agent, includeArchived = false) => {
                const { sessions } = await peerOf(agent).request("session_list", { includeArchived });
                if (!Array.isArray(sessions)) throw new Error(`agent "${agent}" answered session_list without a list`);
                const rows = sessions.flatMap((row: unknown) => {
                    const s = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
                    const { session, title, titleByUser, archived, pinned, events: count, createdAt, updatedAt } = s;
                    // isoStamp throws past the Date range: a stamp must be a real date, not merely a finite number
                    const ok =
                        isSessionId(session) &&
                        (title === null || typeof title === "string") &&
                        typeof titleByUser === "boolean" &&
                        typeof archived === "boolean" &&
                        typeof pinned === "boolean" &&
                        typeof count === "number" && Number.isSafeInteger(count) && count >= 0 &&
                        typeof createdAt === "number" && !Number.isNaN(new Date(createdAt).getTime()) &&
                        typeof updatedAt === "number" && !Number.isNaN(new Date(updatedAt).getTime());
                    return ok ? [{ session, title, titleByUser, archived, pinned, events: count, createdAt, updatedAt }] : [];
                });
                if (rows.length < sessions.length) {
                    log(`[chats] ${agent}: dropped ${sessions.length - rows.length} session_list row(s) off the contract\n`);
                }
                return rows;
            },
            update: async (agent, patch) => {
                const applied = (await peerOf(agent).request("session_update", patch)).applied;
                if (applied) events.emit({ type: "chat_changed", agent, session: patch.session });
                return applied;
            },
            remove: async (agent, session) => {
                // the chat's running turn is stopped and its closeout written first, and a pending
                // title call is cancelled: a model call must not keep spending for a chat that is gone
                for (const work of chatWork.get(`${agent}#${session}`) ?? []) work.abort(new Error("the chat was deleted"));
                const run = turns.get(agent, session);
                if (run) {
                    run.stop();
                    await run.finished;
                }
                const gone = (
                    await peerOf(agent).request("session_delete", { session })
                ).deleted;
                if (gone) {
                    sessions.drop(agent, session);
                    events.emit({ type: "chat_changed", agent, session });
                }
                return gone;
            },
        },

        stop: () => {
            if (stopping) return stopping;
            stopping = (async () => {
                shutdown.abort(new Error("gateway is stopping"));
                gates.stop();
                for (const { timer } of changedBursts.values()) clearTimeout(timer);
                changedBursts.clear();
                // Stopped turns can still be writing bounded history closeout through their agent.
                await Promise.allSettled([...runs.values()].map((run) => run.finished));
                // every exchange is reset while its socket is still open; #forget is the backstop
                appTickets.stop();
                appBridge.stop();
                devices.stop();
                registry.stop();
                // anything parked while the turns wound down would hold the drain below for its five minutes
                gates.stop();
                while (active.size) await Promise.allSettled([...active]);
                setUsageRecordedHook(db, null);
                sessions.clear();
                events.clear();
            })();
            return stopping;
        },
    };
    devices.onAppStream = createTunnels(core);
    return core;
}
