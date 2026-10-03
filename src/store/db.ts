/** Gateway's own SQLite (mimi/gateway.db): models, settings, llm_calls + the usage_daily rollup,
 *  registry, agent apps, pauses, pins, inbox, interactions, rooms, paired devices and their push tokens. */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { GENESIS_HASH, chainHash, readPerms } from "@mimi-os/protocol";
import type { AgentAppPage, AvatarType, NotifyTarget, PinPerms, PinStatus } from "@mimi-os/protocol";

import { localDay } from "./day.ts";
import { ensureDir, gatewayDbFile } from "./home.ts";

// ── column readers: NULL reads null, a hand-edited JSON cell reads as absent
const textCol = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numCol = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const jsonCol = (v: unknown): unknown => {
    try {
        return typeof v === "string" && v ? (JSON.parse(v) as unknown) : undefined;
    } catch {
        return undefined;
    }
};

// provider-reported token counts are untrusted JSON: NaN would bind as NULL against a NOT NULL
// column and lose the call, Infinity would poison the day cell and lock the model out of its limit
const tokenCount = (v: number): number => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), Number.MAX_SAFE_INTEGER) : 0;
};

/** A model's daily cap across every agent: prompt + completion tokens, or dollars at its current price. */
export interface ModelLimit {
    unit: "tokens" | "usd";
    value: number;
}

/** What the owner pays per 1M tokens and may spend a day — kept off the model's base settings. */
export interface ModelPricing {
    priceInPerM: number;
    priceOutPerM: number;
    limit: ModelLimit | null;
}

/** Dollars for these tokens at these prices; cost is never stored, always read at the current price.
 *  The one cost formula: SQL calls this same function as token_cost(). */
export const tokenCost = (promptTokens: number, completionTokens: number, p: Omit<ModelPricing, "limit">): number =>
    (promptTokens * p.priceInPerM + completionTokens * p.priceOutPerM) / 1e6;

export interface ModelRow extends ModelPricing {
    name: string;
    provider: string;
    endpoint: string;
    modelId: string | null;
    contextTokens: number;
    /** Stored 0/1; the model accepts images (data-URIs) alongside text. */
    vision: boolean;
    params: Record<string, unknown>;
    /** Minted once, immutable, opaque: the alias can be renamed, this is what usage is keyed by. */
    modelUid: string;
    createdAt: string;
}

export interface NewLlmCall {
    agent: string;
    conversationId?: number | null;
    /** The room a turn ran in; a room turn has no conversation, and the two are never both set. */
    room?: string | null;
    scope: string;
    callId?: string | null;
    callKind?: string | null;
    model?: string | null;
    modelUid?: string | null;
    registryModel?: string | null;
    reportedModel?: string | null;
    attempt?: number | null;
    parentCallId?: string | null;
    turnSeq?: number | null;
    finishReason?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    cachedTokens?: number | null;
    /** Provider-reported only, and a subset of completionTokens: it enters no total, ever. */
    reasoningTokens?: number | null;
    /** The usage is the gateway's own chars/4 estimate: the call was stopped or failed after the provider had it. */
    usageEstimated?: boolean;
    /** The gateway adapter this call ran through, frozen at call time — never the downstream host. */
    provider?: string | null;
    durationMs?: number | null;
    /** Call start (queue included) to the first nonempty text/thinking/tool_calls event. */
    firstOutputMs?: number | null;
    tokensPerSec?: number | null;
    raw: unknown;
}

export interface LlmCallRow {
    id: number;
    agent: string;
    conversationId: number | null;
    room: string | null;
    scope: string;
    /** Opaque, minted per model call. */
    callId: string | null;
    callKind: string | null;
    model: string | null;
    modelUid: string | null;
    registryModel: string | null;
    reportedModel: string | null;
    attempt: number | null;
    parentCallId: string | null;
    turnSeq: number | null;
    /** The assistant/tool event seqs the round of this call appended, from the append acks. */
    messageSeqs: number[] | null;
    finishReason: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    cachedTokens: number | null;
    reasoningTokens: number | null;
    usageEstimated: boolean;
    /** Dollars at the model's CURRENT price; 0 for a model no registry row prices. */
    cost: number;
    /** The adapter kind frozen at call time. */
    provider: string | null;
    durationMs: number | null;
    /** null when nothing measured it: an error before any output. */
    firstOutputMs: number | null;
    tokensPerSec: number | null;
    raw: string;
    createdAt: string;
}

export interface CallPerfRow {
    model: string | null;
    modelUid: string | null;
    registryModel: string | null;
    provider: string | null;
    completionTokens: number | null;
    durationMs: number | null;
    firstOutputMs: number | null;
}

/** Every rollup read: `totalTokens` is prompt + completion, `cost` those tokens at each model's CURRENT price. */
export interface UsageTotals {
    calls: number;
    /** Calls whose usage is the gateway's estimate (stopped or failed mid-stream). */
    estimatedCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
}

/** One cell of the agent×model rollup. `model` is "" when the call never named one. */
export interface UsageRow extends UsageTotals {
    agent: string;
    model: string;
    registryModel: string | null;
}

export interface UsageDayRow extends UsageTotals {
    day: string;
    model: string;
    registryModel: string | null;
}

/** The same rollup keyed by registry identity instead of provider model id; `modelUid` null is
 *  a call no registry row chose (a ping of an unsaved model). */
export interface RegistryUsageRow extends UsageTotals {
    modelUid: string | null;
    registryModel: string | null;
}

export interface AgentRegistryRow {
    name: string;
    describe: unknown;
    lastSeen: string;
    /** The stored avatar's SHA-256, null with none. */
    avatar: string | null;
}

function toAgentRegistryRow(r: Record<string, unknown>): AgentRegistryRow {
    return {
        name: String(r["name"]),
        describe: JSON.parse(String(r["describe"])) as unknown,
        lastSeen: String(r["last_seen"]),
        avatar: textCol(r["avatar_sha256"]),
    };
}

export interface AgentAvatarRow {
    type: AvatarType;
    sha256: string;
    bytes: Uint8Array;
}

// the blob stays out of the roster reads: only the avatar route loads it
const REGISTRY_COLUMNS = "name, describe, last_seen, avatar_sha256";

export interface PauseRow {
    agent: string;
    paused: boolean;
}

/** An agent's own HTTP server as `describe` last declared it. It OUTLIVES the connection: an
 *  offline agent stays in the catalog, which is the whole point of storing it. */
export interface AgentAppRow {
    agent: string;
    appId: string;
    title: string;
    entry?: string | undefined;
    pages?: AgentAppPage[] | undefined;
    upstream: string;
    /** Bumped only when the declared block actually changes — a reconnect alone moves nothing. */
    revision: number;
    lastSeenAt: string;
}

function toAgentAppRow(r: Record<string, unknown>): AgentAppRow {
    const pages = jsonCol(r["pages"]);
    return {
        agent: String(r["agent"]),
        appId: String(r["app_id"]),
        title: String(r["title"]),
        entry: textCol(r["entry"]) ?? undefined,
        pages: Array.isArray(pages) ? (pages as AgentAppPage[]) : undefined,
        upstream: String(r["upstream"]),
        revision: Number(r["revision"]),
        lastSeenAt: String(r["last_seen_at"]),
    };
}

/** One cookie in the server-side jar for an app, keyed by (agent, appId) — shared by both front
 *  doors that reach it. `expiresAt` null = a session cookie, kept until the jar is cleared. */
export interface AppCookieRow {
    name: string;
    value: string;
    path: string;
    expiresAt: number | null;
}

export interface PinRow {
    name: string;
    pubkey: string;
    fingerprint: string;
    status: PinStatus;
    perms: PinPerms;
    pinnedAt: string;
    lastSeen: string | null;
    lastFrom: string | null;
}

/** Per-agent model policy. A null policy is the TIGHTEST grant: the default model, nothing else. */
export interface ModelsPolicy {
    primary?: string;
    fallback?: string;
    /** absent = the default model alone; a list (empty included) = exactly those names. */
    allowed?: string[];
}

/** Untrusted JSON (hand-edited rows included) down to the policy contract; empty → null. */
export function readModelsPolicy(raw: unknown): ModelsPolicy | null {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const p = raw as Record<string, unknown>;
    const out: ModelsPolicy = {};
    if (typeof p["primary"] === "string" && p["primary"]) out.primary = p["primary"];
    if (typeof p["fallback"] === "string" && p["fallback"]) out.fallback = p["fallback"];
    if (Array.isArray(p["allowed"])) {
        out.allowed = p["allowed"].filter((v): v is string => typeof v === "string" && v !== "");
    }
    return Object.keys(out).length ? out : null;
}

/** How many rows keep their raw payload after an insert. Rows themselves are never deleted:
 *  the numeric columns are the durable performance record, only `raw` is the bounded tail. */
export const LLM_CALLS_KEEP = 1000;

/** How many cookies one (agent, app) jar keeps; the oldest rows go first. */
const APP_COOKIES_KEEP = 100;

/** How many unread inbox items one sender keeps — read items have their own, larger cap. */
const INBOX_UNREAD_KEEP = 500;

/** Every statement is IF NOT EXISTS, so the whole block re-runs on every open. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
    name           TEXT PRIMARY KEY,
    provider       TEXT NOT NULL,
    endpoint       TEXT NOT NULL,
    model_id       TEXT,
    context_tokens INTEGER NOT NULL,
    vision         INTEGER NOT NULL DEFAULT 0,
    params         TEXT NOT NULL,
    model_uid      TEXT NOT NULL UNIQUE,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    price_in_per_m  REAL NOT NULL DEFAULT 0,
    price_out_per_m REAL NOT NULL DEFAULT 0,
    -- both null = no daily limit
    limit_unit      TEXT CHECK (limit_unit IN ('tokens', 'usd')),
    limit_value     REAL
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    agent             TEXT NOT NULL,
    conversation_id   INTEGER,
    room              TEXT,
    scope             TEXT NOT NULL,
    call_id           TEXT,
    call_kind         TEXT,
    model             TEXT,
    model_uid         TEXT,
    registry_model    TEXT,
    reported_model    TEXT,
    attempt           INTEGER,
    parent_call_id    TEXT,
    turn_seq          INTEGER,
    message_seqs      TEXT,
    finish_reason     TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER,
    cached_tokens     INTEGER,
    reasoning_tokens  INTEGER,
    usage_estimated   INTEGER NOT NULL DEFAULT 0,
    provider          TEXT,
    duration_ms       INTEGER,
    first_output_ms   INTEGER,
    tokens_per_sec    REAL,
    raw               TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_day   ON llm_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_calls_agent ON llm_calls(agent, id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_conv  ON llm_calls(agent, conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_call  ON llm_calls(call_id) WHERE call_id IS NOT NULL;
-- the raw prune walks only rows it has not blanked yet
CREATE INDEX IF NOT EXISTS idx_llm_calls_raw   ON llm_calls(id) WHERE raw <> '';
-- day is the owner's calendar day in MIMI_TZ; model_uid '' is a call no registry row chose;
-- last_write orders the cells' writes, so the newest alias names a group
CREATE TABLE IF NOT EXISTS usage_daily (
    day               TEXT NOT NULL,
    agent             TEXT NOT NULL,
    model             TEXT NOT NULL,
    model_uid         TEXT NOT NULL,
    registry_model    TEXT,
    last_write        INTEGER NOT NULL,
    calls             INTEGER NOT NULL,
    estimated_calls   INTEGER NOT NULL,
    prompt_tokens     INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    PRIMARY KEY (day, agent, model, model_uid)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_write ON usage_daily(last_write);
CREATE TABLE IF NOT EXISTS agents_registry (
    name          TEXT PRIMARY KEY,
    describe      TEXT NOT NULL,
    last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
    avatar_type   TEXT,
    avatar_sha256 TEXT,
    avatar        BLOB
);
CREATE TABLE IF NOT EXISTS agent_apps (
    agent        TEXT NOT NULL,
    app_id       TEXT NOT NULL,
    title        TEXT NOT NULL,
    entry        TEXT,
    pages        TEXT,
    upstream     TEXT NOT NULL,
    revision     INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (agent, app_id)
);
CREATE TABLE IF NOT EXISTS pauses (
    agent  TEXT PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pins (
    name        TEXT PRIMARY KEY,
    pubkey      TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status      TEXT NOT NULL,
    perms       TEXT NOT NULL,
    pinned_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT,
    last_from   TEXT,
    models      TEXT
);
CREATE TABLE IF NOT EXISTS inbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL,              -- 'agent' | 'system'
    agent      TEXT,                       -- set when source = 'agent'
    title      TEXT NOT NULL,              -- <= 200 chars
    body       TEXT NOT NULL DEFAULT '',   -- Markdown, <= 65536 chars
    level      TEXT NOT NULL,              -- 'info' | 'warn' | 'action'
    target     TEXT,                       -- JSON NotifyTarget or NULL
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbox_read ON inbox(read_at, id);
CREATE TABLE IF NOT EXISTS interactions (
    id                  TEXT PRIMARY KEY,
    kind                TEXT NOT NULL,
    from_agent          TEXT NOT NULL,
    to_agent            TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    origin_conversation INTEGER,
    origin_call_id      TEXT,
    target_conversation INTEGER,
    gate                TEXT,
    status              TEXT NOT NULL,
    status_changed_at   TEXT NOT NULL DEFAULT (datetime('now')),
    command             TEXT,              -- a2a only
    args                TEXT,              -- a2a only, JSON capped at 256 KiB
    result              TEXT,              -- a2a only, JSON capped at 256 KiB
    duration_ms         INTEGER            -- a2a only
);
CREATE INDEX IF NOT EXISTS idx_interactions_from ON interactions(from_agent);
CREATE INDEX IF NOT EXISTS idx_interactions_to   ON interactions(to_agent);
CREATE TABLE IF NOT EXISTS rooms (
    id         TEXT PRIMARY KEY,
    title      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS room_participants (
    room     TEXT NOT NULL,
    agent    TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room, agent)
);
CREATE TABLE IF NOT EXISTS room_events (
    room         TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    hash         TEXT NOT NULL,
    author_kind  TEXT NOT NULL,
    author_agent TEXT,
    text         TEXT NOT NULL,
    meta         TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room, seq)
);
CREATE TABLE IF NOT EXISTS devices (
    id           TEXT PRIMARY KEY,
    pubkey       TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    status       TEXT NOT NULL,
    sas          TEXT NOT NULL,
    epoch        TEXT,
    max_seq      INTEGER NOT NULL DEFAULT 0,
    enrolled_at  TEXT NOT NULL DEFAULT (datetime('now')),
    activated_at TEXT,
    last_seen    TEXT
);
CREATE TABLE IF NOT EXISTS device_ops (
    device     TEXT NOT NULL,
    epoch      TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    args_hash  TEXT NOT NULL,
    result     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(device, epoch, seq)
);
CREATE INDEX IF NOT EXISTS idx_device_ops_device ON device_ops(device);
-- the cascade relies on node:sqlite turning foreign keys on by default
CREATE TABLE IF NOT EXISTS device_push (
    device_id  TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    token      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS device_app_grants (
    device          TEXT NOT NULL,
    app_id          TEXT NOT NULL,
    credential_hash TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(device, app_id)
);
CREATE TABLE IF NOT EXISTS app_cookies (
    agent      TEXT NOT NULL,
    app_id     TEXT NOT NULL,
    name       TEXT NOT NULL,
    value      TEXT NOT NULL,
    path       TEXT NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (agent, app_id, name, path)
);
`;

/** The alias LAST recorded for a group, not the alphabetically greatest: a rename must read as the
 *  new name, even when the old one still names another agent's cell of the same day. */
const LAST_ALIAS = `MAX(printf('%015d', last_write) || registry_model)`;
const lastAlias = (v: unknown): string | null => textCol(v)?.slice(15) ?? null;
/** The usage window every rollup read shares; a null `:agent` means every agent. */
const USAGE_WINDOW = `day >= :since AND (:agent IS NULL OR agent = :agent)`;
/** usage_daily priced at each model's CURRENT price; a cell no registry row prices costs 0. */
const PRICED_USAGE = `(SELECT u.*, token_cost(u.prompt_tokens, u.completion_tokens, m.price_in_per_m, m.price_out_per_m) AS cost
    FROM usage_daily u LEFT JOIN models m ON m.model_uid = u.model_uid)`;
const ROLLUP_SUMS = `SUM(calls) AS calls, SUM(estimated_calls) AS estimated_calls, SUM(prompt_tokens) AS prompt,
    SUM(completion_tokens) AS completion, SUM(cost) AS cost`;
const toTotals = (row: Record<string, unknown>): UsageTotals => ({
    calls: Number(row["calls"]),
    estimatedCalls: Number(row["estimated_calls"]),
    promptTokens: Number(row["prompt"]),
    completionTokens: Number(row["completion"]),
    totalTokens: Number(row["prompt"]) + Number(row["completion"]),
    cost: Number(row["cost"]),
});
/** llm_calls with each row's cost at its model's current price, read the same way as the rollup. */
const PRICED_CALLS = `SELECT c.*, token_cost(c.prompt_tokens, c.completion_tokens, m.price_in_per_m, m.price_out_per_m) AS cost
    FROM llm_calls c LEFT JOIN models m ON m.model_uid = c.model_uid`;

function toModelRow(r: Record<string, unknown>): ModelRow {
    const unit = r["limit_unit"];
    return {
        name: String(r["name"]),
        provider: String(r["provider"]),
        endpoint: String(r["endpoint"]),
        modelId: textCol(r["model_id"]),
        contextTokens: Number(r["context_tokens"]),
        vision: Number(r["vision"]) !== 0,
        params: JSON.parse(String(r["params"])) as Record<string, unknown>,
        modelUid: String(r["model_uid"]),
        createdAt: String(r["created_at"]),
        priceInPerM: Number(r["price_in_per_m"]),
        priceOutPerM: Number(r["price_out_per_m"]),
        limit: unit === "tokens" || unit === "usd" ? { unit, value: Number(r["limit_value"]) } : null,
    };
}

function toLlmCallRow(r: Record<string, unknown>): LlmCallRow {
    const seqs = jsonCol(r["message_seqs"]);
    return {
        id: Number(r["id"]),
        agent: String(r["agent"]),
        conversationId: numCol(r["conversation_id"]),
        room: textCol(r["room"]),
        scope: String(r["scope"]),
        callId: textCol(r["call_id"]),
        callKind: textCol(r["call_kind"]),
        model: textCol(r["model"]),
        modelUid: textCol(r["model_uid"]),
        registryModel: textCol(r["registry_model"]),
        reportedModel: textCol(r["reported_model"]),
        attempt: numCol(r["attempt"]),
        parentCallId: textCol(r["parent_call_id"]),
        turnSeq: numCol(r["turn_seq"]),
        messageSeqs: Array.isArray(seqs) ? seqs.map(Number) : null,
        finishReason: textCol(r["finish_reason"]),
        promptTokens: numCol(r["prompt_tokens"]),
        completionTokens: numCol(r["completion_tokens"]),
        totalTokens: numCol(r["total_tokens"]),
        cachedTokens: numCol(r["cached_tokens"]),
        reasoningTokens: numCol(r["reasoning_tokens"]),
        usageEstimated: Number(r["usage_estimated"]) === 1,
        cost: Number(r["cost"]),
        provider: textCol(r["provider"]),
        durationMs: numCol(r["duration_ms"]),
        firstOutputMs: numCol(r["first_output_ms"]),
        tokensPerSec: numCol(r["tokens_per_sec"]),
        raw: String(r["raw"]),
        createdAt: String(r["created_at"]),
    };
}

export type InboxSource = "agent" | "system";
export type InboxLevel = "info" | "warn" | "action";

/** One item in the owner's Inbox: an agent's `notify()` report, or a system event (a device
 *  awaiting approval). `agent` is null for a system item. */
export interface InboxItemRow {
    id: number;
    source: InboxSource;
    agent: string | null;
    title: string;
    body: string;
    level: InboxLevel;
    /** Absent on every row written without one — the field never reads `null` on the wire. */
    target?: NotifyTarget | undefined;
    createdAt: string;
    readAt: string | null;
}

export interface NewInboxItem {
    source: InboxSource;
    agent?: string | null;
    title: string;
    body?: string;
    level?: InboxLevel;
    target?: NotifyTarget | null;
}

const INBOX_LEVELS: readonly string[] = ["info", "warn", "action"];

function toInboxItemRow(r: Record<string, unknown>): InboxItemRow {
    const level = String(r["level"]);
    return {
        id: Number(r["id"]),
        source: String(r["source"]) === "system" ? "system" : "agent",
        agent: textCol(r["agent"]),
        title: String(r["title"]),
        body: String(r["body"] ?? ""),
        level: (INBOX_LEVELS.includes(level) ? level : "info") as InboxLevel,
        target: jsonCol(r["target"]) as NotifyTarget | undefined,
        createdAt: String(r["created_at"]),
        readAt: textCol(r["read_at"]),
    };
}

/** What one cross-agent operation was: a delegated turn (ask_<agent>), or a direct a2a command. */
export type InteractionKind = "delegate" | "a2a";

/** Deliberately thin, and never a judgement of the work. `denied` is a2a-only: the write gate
 *  refused before the command ever reached the target. */
export type InteractionStatus = "sent" | "answered" | "failed" | "denied";

/** One recorded operation, written where it happens. Every reference is real: a conversation id
 *  the sender's chat can open, the approval gate the report rode. `command`/`args`/`result`/
 *  `durationMs` are a2a-only — a delegate row leaves them unset. */
export interface InteractionRow {
    id: string;
    kind: InteractionKind;
    from: string;
    to: string;
    createdAt: string;
    originConversation?: number | undefined;
    /** The sender's model call that made the tool call — joins to `/api/agents/:agent/calls`. */
    originCallId?: string | undefined;
    targetConversation?: number | undefined;
    gate?: string | undefined;
    status: InteractionStatus;
    statusChangedAt: string;
    command?: string | undefined;
    /** Raw JSON text, capped at 256 KiB with a truncation marker — never re-parsed by the gateway. */
    args?: string | undefined;
    result?: string | undefined;
    durationMs?: number | undefined;
}

/** A list row: an a2a exchange's args and result run to 256 KiB each, so only the detail route carries them. */
export type InteractionSummary = Omit<InteractionRow, "args" | "result">;

export interface NewInteraction {
    kind: InteractionKind;
    from: string;
    to: string;
    status: InteractionStatus;
    originConversation?: number | null;
    originCallId?: string | null;
    targetConversation?: number | null;
    gate?: string | null;
    command?: string | null;
    args?: string | null;
}

/** What a running operation may still learn: its target, the gate it parked on, its ending. */
export interface InteractionPatch {
    status?: InteractionStatus;
    targetConversation?: number;
    gate?: string;
    result?: string;
    durationMs?: number;
}

export interface InteractionQuery {
    /** Either end of the operation — a filter by agent is "everything it sent or received". */
    agent?: string;
    conversation?: number;
    kind?: InteractionKind;
    limit?: number;
    /** The opaque id of the last row of the previous page. */
    before?: string;
}

function toInteractionRow(r: Record<string, unknown>): InteractionRow {
    return {
        id: String(r["id"]),
        kind: String(r["kind"]) as InteractionKind,
        from: String(r["from_agent"]),
        to: String(r["to_agent"]),
        createdAt: String(r["created_at"]),
        originConversation: numCol(r["origin_conversation"]) ?? undefined,
        originCallId: textCol(r["origin_call_id"]) ?? undefined,
        targetConversation: numCol(r["target_conversation"]) ?? undefined,
        gate: textCol(r["gate"]) ?? undefined,
        status: String(r["status"]) as InteractionStatus,
        statusChangedAt: String(r["status_changed_at"]),
        // a2a columns are written only on a2a rows, so a delegate row carries none of these keys
        ...(r["kind"] === "a2a"
            ? {
                  command: textCol(r["command"]) ?? undefined,
                  args: textCol(r["args"]) ?? undefined,
                  result: textCol(r["result"]) ?? undefined,
                  durationMs: numCol(r["duration_ms"]) ?? undefined,
              }
            : {}),
    };
}

/** A shared conversation the gateway owns: participants, and one ordered published transcript. */
export interface RoomRow {
    id: string;
    title: string | null;
    participants: string[];
    createdAt: string;
    updatedAt: string;
}

/** Who authored one published message; `agent` is set for kind "agent" and for nothing else. */
export interface RoomAuthor {
    kind: "human" | "agent" | "system";
    agent?: string;
}

/** One published message. `meta` is the reply's provenance (`{ callId, registryModel }`) — the
 *  room never carries internal calls or tool traffic, so nothing else ever has one. */
export interface RoomEventRow {
    seq: number;
    hash: string;
    author: RoomAuthor;
    text: string;
    meta?: Record<string, unknown>;
    createdAt: string;
}

function toRoomRow(r: Record<string, unknown>, participants: string[]): RoomRow {
    return {
        id: String(r["id"]),
        title: textCol(r["title"]),
        participants,
        createdAt: String(r["created_at"]),
        updatedAt: String(r["updated_at"]),
    };
}

function toRoomEventRow(r: Record<string, unknown>): RoomEventRow {
    const agent = r["author_agent"];
    const meta = jsonCol(r["meta"]) as Record<string, unknown> | undefined;
    return {
        seq: Number(r["seq"]),
        hash: String(r["hash"]),
        author: {
            kind: String(r["author_kind"]) as RoomAuthor["kind"],
            ...(agent === null || agent === undefined ? {} : { agent: String(agent) }),
        },
        text: String(r["text"]),
        ...(meta ? { meta } : {}),
        createdAt: String(r["created_at"]),
    };
}

function toPinRow(r: Record<string, unknown>): PinRow {
    return {
        name: String(r["name"]),
        pubkey: String(r["pubkey"]),
        fingerprint: String(r["fingerprint"]),
        // a hand-edited status fails closed
        status: String(r["status"]) === "approved" ? "approved" : "blocked",
        perms: readPerms(jsonCol(r["perms"])),
        pinnedAt: String(r["pinned_at"]),
        lastSeen: textCol(r["last_seen"]),
        lastFrom: textCol(r["last_from"]),
    };
}

/** One paired device on the secure channel. A revoked row is terminal and never deleted:
 *  its pubkey staying UNIQUE in the table is the deny-list. */
export interface DeviceRow {
    id: string;
    pubkey: string;
    name: string;
    status: "inactive" | "active" | "revoked";
    sas: string;
    epoch: string | null;
    maxSeq: number;
    enrolledAt: string;
    activatedAt: string | null;
    lastSeen: string | null;
}

export type DeviceOpOutcome =
    | { status: "executed" | "replay"; result: Record<string, unknown> }
    | { status: "conflict" | "expired_executed" | "out_of_order" | "wrong_epoch" };

function toDeviceRow(r: Record<string, unknown>): DeviceRow {
    const status = String(r["status"]);
    return {
        id: String(r["id"]),
        pubkey: String(r["pubkey"]),
        name: String(r["name"]),
        // a hand-edited status must fail closed to the powerless state, never to active
        status: status === "active" || status === "revoked" ? status : "inactive",
        sas: String(r["sas"]),
        epoch: textCol(r["epoch"]),
        maxSeq: Number(r["max_seq"]),
        enrolledAt: String(r["enrolled_at"]),
        activatedAt: textCol(r["activated_at"]),
        lastSeen: textCol(r["last_seen"]),
    };
}

export class GatewayDb {
    private readonly db: DatabaseSync;
    private readonly path: string;

    constructor(path: string) {
        this.path = path;
        ensureDir(dirname(path));
        this.db = new DatabaseSync(path);
        try {
            this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
            // a NULL count or an unpriced model (no registry row) reads as 0
            this.db.function("token_cost", { deterministic: true }, (prompt, completion, priceIn, priceOut) =>
                tokenCost(Number(prompt), Number(completion), { priceInPerM: Number(priceIn), priceOutPerM: Number(priceOut) }),
            );
            this.db.exec(SCHEMA);
            // cookies, device SAS codes and whole conversations live here; WAL siblings hold the same
            for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
        } catch (e) {
            this.db.close(); // a failed open must not leave the file open behind it
            throw e;
        }
    }

    listModels(): ModelRow[] {
        return this.db
            .prepare(`SELECT * FROM models ORDER BY rowid`)
            .all()
            .map((r) => toModelRow(r as Record<string, unknown>));
    }

    getModel(name: string): ModelRow | null {
        const r = this.db.prepare(`SELECT * FROM models WHERE name = ?`).get(name) as
            | Record<string, unknown>
            | undefined;
        return r ? toModelRow(r) : null;
    }

    /** The uid is minted here, never taken from the caller: creation is the only time it is set. */
    insertModel(row: Omit<ModelRow, "modelUid" | "createdAt" | keyof ModelPricing>): void {
        this.db
            .prepare(
                `INSERT INTO models (name, provider, endpoint, model_id, context_tokens, vision, params, model_uid)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                row.name,
                row.provider,
                row.endpoint,
                row.modelId,
                row.contextTokens,
                row.vision ? 1 : 0,
                JSON.stringify(row.params),
                randomBytes(16).toString("hex"),
            );
    }

    updateModel(name: string, row: Omit<ModelRow, "name" | "modelUid" | "createdAt" | keyof ModelPricing>): void {
        const r = this.db
            .prepare(
                `UPDATE models SET provider = ?, endpoint = ?, model_id = ?, context_tokens = ?, vision = ?, params = ?
                 WHERE name = ?`,
            )
            .run(row.provider, row.endpoint, row.modelId, row.contextTokens, row.vision ? 1 : 0, JSON.stringify(row.params), name);
        if (Number(r.changes) === 0) throw new Error(`gateway.db: no model "${name}".`);
    }

    setModelPricing(name: string, p: ModelPricing): void {
        const r = this.db
            .prepare(
                `UPDATE models SET price_in_per_m = ?, price_out_per_m = ?, limit_unit = ?, limit_value = ?
                 WHERE name = ?`,
            )
            .run(p.priceInPerM, p.priceOutPerM, p.limit?.unit ?? null, p.limit?.value ?? null, name);
        if (Number(r.changes) === 0) throw new Error(`gateway.db: no model "${name}".`);
    }

    renameModel(from: string, to: string): void {
        this.db.prepare(`UPDATE models SET name = ? WHERE name = ?`).run(to, from);
    }

    deleteModel(name: string): void {
        this.db.prepare(`DELETE FROM models WHERE name = ?`).run(name);
    }

    countModels(): number {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM models`).get() as { n: number };
        return Number(row.n);
    }

    getSetting(key: string): string | null {
        const r = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
            | { value: string }
            | undefined;
        return r ? r.value : null;
    }

    setSetting(key: string, value: string): void {
        this.db
            .prepare(
                `INSERT INTO settings (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            )
            .run(key, value);
    }

    /** Rows are a log, raw payloads are a tail: the prune blanks `raw` past `keep` and deletes
     *  nothing, so the measured columns stay reconstructible for every call ever recorded. */
    insertLlmCall(call: NewLlmCall, keep = LLM_CALLS_KEEP): void {
        const r = this.db
            .prepare(
                `INSERT INTO llm_calls
                    (agent, conversation_id, room, scope, call_id, call_kind, model, model_uid,
                     registry_model, reported_model, attempt, parent_call_id, turn_seq, finish_reason,
                     prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens,
                     usage_estimated, provider, duration_ms, first_output_ms, tokens_per_sec, raw)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                call.agent,
                call.conversationId ?? null,
                call.room ?? null,
                call.scope,
                call.callId ?? null,
                call.callKind ?? null,
                call.model ?? null,
                call.modelUid ?? null,
                call.registryModel ?? null,
                call.reportedModel ?? null,
                call.attempt ?? null,
                call.parentCallId ?? null,
                call.turnSeq ?? null,
                call.finishReason ?? null,
                call.promptTokens ?? null,
                call.completionTokens ?? null,
                call.totalTokens ?? null,
                call.cachedTokens ?? null,
                call.reasoningTokens ?? null,
                call.usageEstimated ? 1 : 0,
                call.provider ?? null,
                call.durationMs ?? null,
                call.firstOutputMs ?? null,
                call.tokensPerSec ?? null,
                JSON.stringify(call.raw),
            );
        this.db
            .prepare(`UPDATE llm_calls SET raw = '' WHERE id <= ? AND raw <> ''`)
            .run(Number(r.lastInsertRowid) - Math.max(1, Math.floor(keep)));
    }

    /** The seqs a round appended are known only after its call row exists — hence the one update. */
    setLlmCallMessages(callId: string, seqs: readonly number[]): void {
        this.db
            .prepare(`UPDATE llm_calls SET message_seqs = ? WHERE call_id = ?`)
            .run(JSON.stringify([...seqs]), callId);
    }

    /** Newest first; `conversation` narrows to one chat's calls, whatever the agent did elsewhere. */
    listLlmCalls(limit = 50, agent?: string, conversation?: number): LlmCallRow[] {
        const n = Math.max(1, Math.min(500, Math.floor(limit)));
        return this.db
            .prepare(
                `${PRICED_CALLS}
                 WHERE (:agent IS NULL OR c.agent = :agent) AND (:conv IS NULL OR c.conversation_id = :conv)
                 ORDER BY c.id DESC LIMIT :n`,
            )
            .all({ agent: agent ?? null, conv: conversation ?? null, n })
            .map((r) => toLlmCallRow(r as Record<string, unknown>));
    }

    /** The retained tail's measured columns, oldest first — the numbers that outlive a raw prune.
     *  `since` is a UTC `YYYY-MM-DD HH:MM:SS` stamp; `model: ""` is the calls that named no model;
     *  an estimated completion is no measurement of speed, so it reads null. */
    perfCalls(since: string, filter: { agent?: string | null; model?: string | null } = {}): CallPerfRow[] {
        return this.db
            .prepare(
                `SELECT model, model_uid, registry_model, provider,
                        CASE WHEN usage_estimated = 0 THEN completion_tokens END AS completion_tokens,
                        duration_ms, first_output_ms
                 FROM llm_calls
                 WHERE created_at >= :since AND call_kind IS NOT 'ping'
                   AND (:agent IS NULL OR agent = :agent)
                   AND (:model IS NULL OR (:model = '' AND (model IS NULL OR model = '')) OR model = :model)
                 ORDER BY id`,
            )
            .all({ since, agent: filter.agent ?? null, model: filter.model ?? null })
            .map((row) => ({
                model: textCol(row["model"]),
                modelUid: textCol(row["model_uid"]),
                registryModel: textCol(row["registry_model"]),
                provider: textCol(row["provider"]),
                completionTokens: numCol(row["completion_tokens"]),
                durationMs: numCol(row["duration_ms"]),
                firstOutputMs: numCol(row["first_output_ms"]),
            }));
    }

    /** The oldest row's UTC stamp, and how many rows since `since` carry no duration. */
    callCoverage(since: string): { oldest: string | null; unmeasured: number } {
        const oldest = this.db.prepare(`SELECT MIN(created_at) AS at FROM llm_calls`).get() as {
            at: string | null;
        };
        const gaps = this.db
            .prepare(
                `SELECT COUNT(*) AS n FROM llm_calls WHERE created_at >= ? AND duration_ms IS NULL AND call_kind IS NOT 'ping'`,
            )
            .get(since) as { n: number };
        return { oldest: textCol(oldest.at), unmeasured: Number(gaps.n) };
    }

    getLlmCall(id: number): LlmCallRow | null {
        const r = this.db.prepare(`${PRICED_CALLS} WHERE c.id = ?`).get(id) as
            | Record<string, unknown>
            | undefined;
        return r ? toLlmCallRow(r) : null;
    }

    /** Each agent's spend on the owner's day: prompt + completion, and their cost at current prices. */
    spendByAgent(day: string = localDay()): Map<string, { tokens: number; cost: number }> {
        const rows = this.db
            .prepare(
                `SELECT agent, SUM(prompt_tokens + completion_tokens) AS tokens, SUM(cost) AS cost
                 FROM ${PRICED_USAGE} WHERE day = ? GROUP BY agent`,
            )
            .all(day);
        return new Map(rows.map((row) => [String(row["agent"]), { tokens: Number(row["tokens"]), cost: Number(row["cost"]) }]));
    }

    /** Each registry model's tokens on the owner's day, all agents and pings, off the rollup that is never pruned. */
    modelTokens(day: string = localDay()): Map<string, { promptTokens: number; completionTokens: number }> {
        const rows = this.db
            .prepare(
                `SELECT model_uid, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion
                 FROM usage_daily WHERE day = ? AND model_uid <> '' GROUP BY model_uid`,
            )
            .all(day);
        return new Map(
            rows.map((row) => [
                String(row["model_uid"]),
                { promptTokens: Number(row["prompt"]), completionTokens: Number(row["completion"]) },
            ]),
        );
    }

    /** One call, folded into its (day, agent, provider model, registry uid) cell. The alias follows
     *  the newest call, so a rename during the day reads as the new name. */
    bumpUsageDaily(
        day: string,
        cell: {
            agent: string;
            model: string;
            modelUid: string | null;
            registryModel: string | null;
            promptTokens: number;
            completionTokens: number;
            estimated: boolean;
        },
    ): void {
        this.db
            .prepare(
                `INSERT INTO usage_daily
                    (day, agent, model, model_uid, registry_model, last_write, calls, estimated_calls,
                     prompt_tokens, completion_tokens)
                 VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(last_write), 0) + 1 FROM usage_daily), 1, ?, ?, ?)
                 ON CONFLICT(day, agent, model, model_uid) DO UPDATE SET
                     calls             = calls + 1,
                     estimated_calls   = estimated_calls + excluded.estimated_calls,
                     prompt_tokens     = prompt_tokens + excluded.prompt_tokens,
                     completion_tokens = completion_tokens + excluded.completion_tokens,
                     registry_model    = COALESCE(excluded.registry_model, registry_model),
                     last_write        = excluded.last_write`,
            )
            .run(
                day,
                cell.agent,
                cell.model,
                cell.modelUid ?? "",
                cell.registryModel,
                cell.estimated ? 1 : 0,
                tokenCount(cell.promptTokens),
                tokenCount(cell.completionTokens),
            );
    }

    usageMatrix(sinceDay: string, agent?: string): UsageRow[] {
        return this.db
            .prepare(
                `SELECT agent, model, ${LAST_ALIAS} AS registry_model, ${ROLLUP_SUMS}
                 FROM ${PRICED_USAGE} WHERE ${USAGE_WINDOW}
                 GROUP BY agent, model
                 ORDER BY SUM(prompt_tokens) + SUM(completion_tokens) DESC, agent, model`,
            )
            .all({ since: sinceDay, agent: agent ?? null })
            .map((row) => ({
                agent: String(row["agent"]),
                model: String(row["model"]),
                registryModel: lastAlias(row["registry_model"]),
                ...toTotals(row),
            }));
    }

    usageSeries(sinceDay: string, agent?: string): UsageDayRow[] {
        return this.db
            .prepare(
                `SELECT day, model, ${LAST_ALIAS} AS registry_model, ${ROLLUP_SUMS}
                 FROM ${PRICED_USAGE} WHERE ${USAGE_WINDOW}
                 GROUP BY day, model
                 ORDER BY day, model`,
            )
            .all({ since: sinceDay, agent: agent ?? null })
            .map((row) => ({
                day: String(row["day"]),
                model: String(row["model"]),
                registryModel: lastAlias(row["registry_model"]),
                ...toTotals(row),
            }));
    }

    /** The whole window again, bucketed by registry identity: same rows, same grand totals, other key. */
    usageByRegistry(sinceDay: string, agent?: string): RegistryUsageRow[] {
        return this.db
            .prepare(
                `SELECT model_uid, ${LAST_ALIAS} AS registry_model, ${ROLLUP_SUMS}
                 FROM ${PRICED_USAGE} WHERE ${USAGE_WINDOW}
                 GROUP BY model_uid
                 ORDER BY SUM(prompt_tokens) + SUM(completion_tokens) DESC, model_uid`,
            )
            .all({ since: sinceDay, agent: agent ?? null })
            .map((row) => ({
                modelUid: textCol(row["model_uid"]) || null,
                registryModel: lastAlias(row["registry_model"]),
                ...toTotals(row),
            }));
    }

    upsertAgentRegistry(name: string, describe: unknown): void {
        this.db
            .prepare(
                `INSERT INTO agents_registry (name, describe, last_seen) VALUES (?, ?, datetime('now'))
                 ON CONFLICT(name) DO UPDATE SET describe = excluded.describe, last_seen = excluded.last_seen`,
            )
            .run(name, JSON.stringify(describe));
    }

    getAgentRegistry(name: string): AgentRegistryRow | null {
        const r = this.db.prepare(`SELECT ${REGISTRY_COLUMNS} FROM agents_registry WHERE name = ?`).get(name) as
            | Record<string, unknown>
            | undefined;
        return r ? toAgentRegistryRow(r) : null;
    }

    listAgentsRegistry(): AgentRegistryRow[] {
        return this.db
            .prepare(`SELECT ${REGISTRY_COLUMNS} FROM agents_registry ORDER BY name`)
            .all()
            .map((r) => toAgentRegistryRow(r as Record<string, unknown>));
    }

    /** null clears it. The registry row must exist: the avatar lives on it, so a revoke takes it along. */
    setAgentAvatar(name: string, avatar: AgentAvatarRow | null): void {
        this.db
            .prepare(`UPDATE agents_registry SET avatar_type = ?, avatar_sha256 = ?, avatar = ? WHERE name = ?`)
            .run(avatar?.type ?? null, avatar?.sha256 ?? null, avatar?.bytes ?? null, name);
    }

    getAgentAvatar(name: string): AgentAvatarRow | null {
        const r = this.db
            .prepare(`SELECT avatar_type, avatar_sha256, avatar FROM agents_registry WHERE name = ? AND avatar IS NOT NULL`)
            .get(name) as Record<string, unknown> | undefined;
        if (!r) return null;
        return { type: String(r["avatar_type"]) as AvatarType, sha256: String(r["avatar_sha256"]), bytes: r["avatar"] as Uint8Array };
    }

    /** `revision` moves only when the block itself changed, so a client can cache by it. */
    upsertAgentApp(row: Omit<AgentAppRow, "revision" | "lastSeenAt">): AgentAppRow {
        const pages = row.pages ? JSON.stringify(row.pages) : null;
        const entry = row.entry ?? null;
        const before = this.getAgentApp(row.agent, row.appId);
        const changed =
            !before ||
            before.title !== row.title ||
            before.upstream !== row.upstream ||
            (before.entry ?? null) !== entry ||
            (before.pages ? JSON.stringify(before.pages) : null) !== pages;
        // a different upstream origin is a different server: the owner's app login does not carry over
        if (before && URL.parse(before.upstream)?.origin !== URL.parse(row.upstream)?.origin) this.clearAppCookies(row.agent, row.appId);
        const stored = this.db
            .prepare(
                `INSERT INTO agent_apps (agent, app_id, title, entry, pages, upstream, revision, last_seen_at)
                 VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))
                 ON CONFLICT(agent, app_id) DO UPDATE SET
                     title = excluded.title, entry = excluded.entry, pages = excluded.pages,
                     upstream = excluded.upstream, last_seen_at = excluded.last_seen_at,
                     revision = revision + ?
                 RETURNING *`,
            )
            .get(row.agent, row.appId, row.title, entry, pages, row.upstream, changed ? 1 : 0)!;
        return toAgentAppRow(stored);
    }

    getAgentApp(agent: string, appId: string): AgentAppRow | null {
        const r = this.db
            .prepare(`SELECT * FROM agent_apps WHERE agent = ? AND app_id = ?`)
            .get(agent, appId) as Record<string, unknown> | undefined;
        return r ? toAgentAppRow(r) : null;
    }

    /** A device names an app, never its agent; the gateway assigns every app its agent's name. */
    getAgentAppById(appId: string): AgentAppRow | null {
        const r = this.db.prepare(`SELECT * FROM agent_apps WHERE app_id = ?`).get(appId) as
            | Record<string, unknown>
            | undefined;
        return r ? toAgentAppRow(r) : null;
    }

    listAgentApps(): AgentAppRow[] {
        return this.db
            .prepare(`SELECT * FROM agent_apps ORDER BY agent, app_id`)
            .all()
            .map((r) => toAgentAppRow(r as Record<string, unknown>));
    }

    deleteAgentApp(agent: string, appId: string): void {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare(`DELETE FROM agent_apps WHERE agent = ? AND app_id = ?`).run(agent, appId);
            this.db.prepare(`DELETE FROM app_cookies WHERE agent = ? AND app_id = ?`).run(agent, appId);
            this.db.prepare(`DELETE FROM device_app_grants WHERE app_id = ?`).run(appId);
            this.db.exec("COMMIT");
        } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }

    /** The same (name, path) again replaces the value and expiry, keeping its place among equal paths.
     *  The jar is capped per app (RFC 6265 §6.1 asks for one): a cookie flood from the app's own
     *  server drops its oldest rows instead of growing gateway.db forever. */
    setAppCookie(agent: string, appId: string, cookie: AppCookieRow, keep = APP_COOKIES_KEEP): void {
        this.db
            .prepare(
                `INSERT INTO app_cookies (agent, app_id, name, value, path, expires_at) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(agent, app_id, name, path) DO UPDATE SET
                     value = excluded.value, expires_at = excluded.expires_at`,
            )
            .run(agent, appId, cookie.name, cookie.value, cookie.path, cookie.expiresAt);
        this.db
            .prepare(
                `DELETE FROM app_cookies WHERE agent = ? AND app_id = ? AND rowid NOT IN
                    (SELECT rowid FROM app_cookies WHERE agent = ? AND app_id = ? ORDER BY rowid DESC LIMIT ?)`,
            )
            .run(agent, appId, agent, appId, Math.max(1, Math.floor(keep)));
    }

    deleteAppCookie(agent: string, appId: string, name: string, path: string): void {
        this.db
            .prepare(`DELETE FROM app_cookies WHERE agent = ? AND app_id = ? AND name = ? AND path = ?`)
            .run(agent, appId, name, path);
    }

    /** Cookies that path-match `requestPath` per RFC 6265 §5.1.4, longest path first; expired rows
     *  are swept first, so nothing returned here is a cookie the jar would refuse to keep. */
    appCookiesFor(agent: string, appId: string, requestPath: string): AppCookieRow[] {
        this.db
            .prepare(`DELETE FROM app_cookies WHERE agent = ? AND app_id = ? AND expires_at IS NOT NULL AND expires_at <= ?`)
            .run(agent, appId, Date.now());
        return (
            this.db
                .prepare(`SELECT name, value, path, expires_at FROM app_cookies WHERE agent = ? AND app_id = ? ORDER BY length(path) DESC, rowid`)
                .all(agent, appId) as Array<Record<string, unknown>>
        )
            .map((r) => ({ name: String(r["name"]), value: String(r["value"]), path: String(r["path"]), expiresAt: numCol(r["expires_at"]) }))
            .filter((c) => requestPath === c.path || (requestPath.startsWith(c.path) && (c.path.endsWith("/") || requestPath[c.path.length] === "/")));
    }

    clearAppCookies(agent: string, appId: string): void {
        this.db.prepare(`DELETE FROM app_cookies WHERE agent = ? AND app_id = ?`).run(agent, appId);
    }

    /** Read items beyond the newest `keepRead` are trimmed. Unread items are the owner's to delete,
     *  so they are trimmed only past `keepUnread` of the SAME sender — one runaway notifier loses its
     *  own oldest items and no one else's. A sender's unread "action" items count apart from the rest,
     *  so a flood of notices never pushes out one that waits on the owner. */
    insertInboxItem(n: NewInboxItem, keepRead = 1000, keepUnread = INBOX_UNREAD_KEEP): InboxItemRow {
        const agent = n.agent ?? null;
        const level = n.level ?? "info";
        const r = this.db
            .prepare(
                `INSERT INTO inbox (source, agent, title, body, level, target)
                 VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
            )
            .get(n.source, agent, n.title, n.body ?? "", level, n.target ? JSON.stringify(n.target) : null)!;
        this.db
            .prepare(
                `DELETE FROM inbox WHERE read_at IS NOT NULL AND id NOT IN
                    (SELECT id FROM inbox WHERE read_at IS NOT NULL ORDER BY id DESC LIMIT ?)`,
            )
            .run(Math.max(0, Math.floor(keepRead)));
        const action = level === "action" ? 1 : 0;
        this.db
            .prepare(
                `DELETE FROM inbox WHERE read_at IS NULL AND agent IS ? AND (level = 'action') = ? AND id NOT IN
                    (SELECT id FROM inbox WHERE read_at IS NULL AND agent IS ? AND (level = 'action') = ?
                     ORDER BY id DESC LIMIT ?)`,
            )
            .run(agent, action, agent, action, Math.max(1, Math.floor(keepUnread)));
        return toInboxItemRow(r);
    }

    getInboxItem(id: number): InboxItemRow | null {
        const r = this.db.prepare(`SELECT * FROM inbox WHERE id = ?`).get(id) as
            | Record<string, unknown>
            | undefined;
        return r ? toInboxItemRow(r) : null;
    }

    /** Newest first; `before` pages by the id of the last item seen, `unread` filters to unread. */
    listInbox(q: { limit?: number; before?: number | undefined; unread?: boolean } = {}): {
        items: InboxItemRow[];
        hasMore: boolean;
    } {
        const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)));
        const where: string[] = [];
        const args: number[] = [];
        if (q.unread) where.push("read_at IS NULL");
        if (q.before !== undefined) {
            where.push("id < ?");
            args.push(q.before);
        }
        const rows = this.db
            .prepare(
                `SELECT * FROM inbox ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY id DESC LIMIT ?`,
            )
            .all(...args, limit + 1) as Array<Record<string, unknown>>;
        return { items: rows.slice(0, limit).map(toInboxItemRow), hasMore: rows.length > limit };
    }

    countUnread(): number {
        const r = this.db.prepare(`SELECT COUNT(*) AS n FROM inbox WHERE read_at IS NULL`).get() as {
            n: number;
        };
        return Number(r.n);
    }

    /** true = read (now, or already) — idempotent; false = no such item. */
    markInboxRead(id: number): boolean {
        const r = this.db
            .prepare(`UPDATE inbox SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ?`)
            .run(id);
        return Number(r.changes) > 0;
    }

    /** How many were unread and just got marked — not the new total. */
    markAllInboxRead(): number {
        const r = this.db.prepare(`UPDATE inbox SET read_at = datetime('now') WHERE read_at IS NULL`).run();
        return Number(r.changes);
    }

    deleteInboxItem(id: number): boolean {
        const r = this.db.prepare(`DELETE FROM inbox WHERE id = ?`).run(id);
        return Number(r.changes) > 0;
    }

    /** Set by "discuss": once an item names its chat, a second discuss just reuses it. */
    setInboxTarget(id: number, target: NotifyTarget | null): boolean {
        const r = this.db
            .prepare(`UPDATE inbox SET target = ? WHERE id = ?`)
            .run(target ? JSON.stringify(target) : null, id);
        return Number(r.changes) > 0;
    }

    /** The id is minted here, never taken from the caller: opaque, and unique across restarts. */
    insertInteraction(n: NewInteraction): InteractionRow {
        const id = randomBytes(16).toString("hex");
        const row = this.db
            .prepare(
                `INSERT INTO interactions
                    (id, kind, from_agent, to_agent, status, origin_conversation, origin_call_id,
                     target_conversation, gate, command, args)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            )
            .get(
                id,
                n.kind,
                n.from,
                n.to,
                n.status,
                n.originConversation ?? null,
                n.originCallId ?? null,
                n.targetConversation ?? null,
                n.gate ?? null,
                n.command ?? null,
                n.args ?? null,
            )!;
        return toInteractionRow(row);
    }

    /** null = no such row. A patch without `status` leaves `statusChangedAt` alone. */
    updateInteraction(id: string, patch: InteractionPatch): InteractionRow | null {
        const sets: string[] = [];
        const args: Array<string | number> = [];
        if (patch.status !== undefined) {
            sets.push("status = ?", "status_changed_at = datetime('now')");
            args.push(patch.status);
        }
        if (patch.targetConversation !== undefined) {
            sets.push("target_conversation = ?");
            args.push(patch.targetConversation);
        }
        if (patch.gate !== undefined) {
            sets.push("gate = ?");
            args.push(patch.gate);
        }
        if (patch.result !== undefined) {
            sets.push("result = ?");
            args.push(patch.result);
        }
        if (patch.durationMs !== undefined) {
            sets.push("duration_ms = ?");
            args.push(patch.durationMs);
        }
        if (!sets.length) return this.getInteraction(id);
        const row = this.db
            .prepare(`UPDATE interactions SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
            .get(...args, id);
        return row ? toInteractionRow(row) : null;
    }

    getInteraction(id: string): InteractionRow | null {
        const r = this.db.prepare(`SELECT * FROM interactions WHERE id = ?`).get(id) as
            | Record<string, unknown>
            | undefined;
        return r ? toInteractionRow(r) : null;
    }

    /** Newest first, paged by the opaque id of the last row seen — an unknown `before` is an
     *  empty page, so the route checks it and answers 404 rather than lie about the end. */
    listInteractions(q: InteractionQuery = {}): { interactions: InteractionSummary[]; hasMore: boolean } {
        const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)));
        const where: string[] = [];
        const args: Array<string | number> = [];
        if (q.agent !== undefined && q.conversation !== undefined) {
            where.push("((from_agent = ? AND origin_conversation = ?) OR (to_agent = ? AND target_conversation = ?))");
            args.push(q.agent, q.conversation, q.agent, q.conversation);
        } else if (q.agent !== undefined) {
            where.push("(from_agent = ? OR to_agent = ?)");
            args.push(q.agent, q.agent);
        } else if (q.conversation !== undefined) {
            where.push("(origin_conversation = ? OR target_conversation = ?)");
            args.push(q.conversation, q.conversation);
        }
        if (q.kind !== undefined) {
            where.push("kind = ?");
            args.push(q.kind);
        }
        if (q.before !== undefined) {
            where.push("rowid < (SELECT rowid FROM interactions WHERE id = ?)");
            args.push(q.before);
        }
        const rows = this.db
            .prepare(
                `SELECT id, kind, from_agent, to_agent, created_at, origin_conversation, origin_call_id,
                        target_conversation, gate, status, status_changed_at, command, duration_ms
                 FROM interactions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY rowid DESC LIMIT ?`,
            )
            .all(...args, limit + 1) as Array<Record<string, unknown>>;
        return {
            interactions: rows.slice(0, limit).map((r) => {
                const { args: _args, result: _result, ...summary } = toInteractionRow(r);
                return summary;
            }),
            hasMore: rows.length > limit,
        };
    }

    /** The id is minted here, never taken from the caller: opaque, and unique across restarts. */
    createRoom(title: string | null): RoomRow {
        const id = randomBytes(16).toString("hex");
        const row = this.db.prepare(`INSERT INTO rooms (id, title) VALUES (?, ?) RETURNING *`).get(id, title)!;
        return toRoomRow(row, []);
    }

    getRoom(id: string): RoomRow | null {
        const r = this.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id) as
            | Record<string, unknown>
            | undefined;
        if (!r) return null;
        const members = this.db
            .prepare(`SELECT agent FROM room_participants WHERE room = ? ORDER BY agent`)
            .all(id)
            .map((p) => String((p as Record<string, unknown>)["agent"]));
        return toRoomRow(r, members);
    }

    hasRoom(id: string): boolean {
        return this.db.prepare(`SELECT 1 FROM rooms WHERE id = ?`).get(id) !== undefined;
    }

    hasRoomParticipant(room: string, agent: string): boolean {
        return this.db.prepare(`SELECT 1 FROM room_participants WHERE room = ? AND agent = ?`).get(room, agent) !== undefined;
    }

    listRooms(): RoomRow[] {
        const members = new Map<string, string[]>();
        for (const p of this.db
            .prepare(`SELECT room, agent FROM room_participants ORDER BY agent`)
            .all()) {
            const row = p as Record<string, unknown>;
            const room = String(row["room"]);
            const participants = members.get(room);
            if (participants) participants.push(String(row["agent"]));
            else members.set(room, [String(row["agent"])]);
        }
        return this.db
            .prepare(`SELECT * FROM rooms ORDER BY updated_at DESC, id`)
            .all()
            .map((r) => {
                const row = r as Record<string, unknown>;
                return toRoomRow(row, members.get(String(row["id"])) ?? []);
            });
    }

    /** false = that agent was already in the room; joining twice is not an error. */
    addRoomParticipant(room: string, agent: string): boolean {
        const r = this.db
            .prepare(
                `INSERT INTO room_participants (room, agent) VALUES (?, ?)
                 ON CONFLICT(room, agent) DO NOTHING`,
            )
            .run(room, agent);
        return Number(r.changes) > 0;
    }

    removeRoomParticipant(room: string, agent: string): boolean {
        const r = this.db
            .prepare(`DELETE FROM room_participants WHERE room = ? AND agent = ?`)
            .run(room, agent);
        return Number(r.changes) > 0;
    }

    /** Append-only: seq counts per room and the hash chains onto the previous event, so a
     *  transcript can be verified line by line exactly like an agent's own log. */
    appendRoomEvent(
        room: string,
        author: RoomAuthor,
        text: string,
        meta?: Record<string, unknown> | null,
    ): RoomEventRow {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const last = this.db
                .prepare(`SELECT seq, hash FROM room_events WHERE room = ? ORDER BY seq DESC LIMIT 1`)
                .get(room) as { seq: number; hash: string } | undefined;
            const seq = last ? Number(last.seq) + 1 : 1;
            const payload = { text, author, ...(meta ? { meta } : {}) };
            const hash = chainHash(last ? String(last.hash) : GENESIS_HASH, {
                seq,
                type: "message",
                payload,
            });
            const row = this.db
                .prepare(
                    `INSERT INTO room_events (room, seq, hash, author_kind, author_agent, text, meta)
                     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
                )
                .get(room, seq, hash, author.kind, author.agent ?? null, text, meta ? JSON.stringify(meta) : null)!;
            const event = toRoomEventRow(row);
            this.db.prepare(`UPDATE rooms SET updated_at = datetime('now') WHERE id = ?`).run(room);
            this.db.exec("COMMIT");
            return event;
        } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }

    roomEvents(room: string): RoomEventRow[] {
        return this.db
            .prepare(`SELECT * FROM room_events WHERE room = ? ORDER BY seq`)
            .all(room)
            .map((r) => toRoomEventRow(r as Record<string, unknown>));
    }

    /** The newest page, oldest first inside it; page back with the `seq` of the first row seen. */
    listRoomEvents(
        room: string,
        limit = 60,
        before?: number,
    ): { messages: RoomEventRow[]; hasMore: boolean } {
        const n = Math.max(1, Math.min(500, Math.floor(limit)));
        const rows = (
            before === undefined
                ? this.db
                      .prepare(`SELECT * FROM room_events WHERE room = ? ORDER BY seq DESC LIMIT ?`)
                      .all(room, n + 1)
                : this.db
                      .prepare(
                          `SELECT * FROM room_events WHERE room = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
                      )
                      .all(room, before, n + 1)
        ) as Array<Record<string, unknown>>;
        return {
            messages: rows.slice(0, n).map(toRoomEventRow).reverse(),
            hasMore: rows.length > n,
        };
    }

    getPin(name: string): PinRow | null {
        const r = this.db.prepare(`SELECT * FROM pins WHERE name = ?`).get(name) as
            | Record<string, unknown>
            | undefined;
        return r ? toPinRow(r) : null;
    }

    /** The /channel handshake's lookup: an agent pin by its X25519 key. */
    pinByPubkey(pubkey: string): PinRow | null {
        const r = this.db.prepare(`SELECT * FROM pins WHERE pubkey = ?`).get(pubkey) as
            | Record<string, unknown>
            | undefined;
        return r ? toPinRow(r) : null;
    }

    listPins(): PinRow[] {
        return this.db
            .prepare(`SELECT * FROM pins ORDER BY name`)
            .all()
            .map((r) => toPinRow(r as Record<string, unknown>));
    }

    /** A redeemed agent invite's pin; a name that already has one keeps it (setPinKey replaces a key). */
    createPin(row: { name: string; pubkey: string; fingerprint: string; status: PinStatus; perms: PinPerms }): void {
        this.db
            .prepare(
                `INSERT INTO pins (name, pubkey, fingerprint, status, perms) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(name) DO NOTHING`,
            )
            .run(row.name, row.pubkey, row.fingerprint, row.status, JSON.stringify(row.perms));
    }

    /** Unconditional: a re-issued agent invite replaces whatever key the name held before —
     *  owner-driven recovery, never automatic. */
    setPinKey(name: string, pubkey: string, fingerprint: string): boolean {
        const r = this.db
            .prepare(`UPDATE pins SET pubkey = ?, fingerprint = ? WHERE name = ?`)
            .run(pubkey, fingerprint, name);
        return Number(r.changes) > 0;
    }

    setPinStatus(name: string, status: PinStatus, perms: PinPerms): boolean {
        const r = this.db
            .prepare(`UPDATE pins SET status = ?, perms = ? WHERE name = ?`)
            .run(status, JSON.stringify(perms), name);
        return Number(r.changes) > 0;
    }

    setPinPerms(name: string, perms: PinPerms): boolean {
        const r = this.db
            .prepare(`UPDATE pins SET perms = ? WHERE name = ?`)
            .run(JSON.stringify(perms), name);
        return Number(r.changes) > 0;
    }

    touchPin(name: string, from: string | null): void {
        this.db
            .prepare(`UPDATE pins SET last_seen = datetime('now'), last_from = ? WHERE name = ?`)
            .run(from, name);
    }

    /** Revoke takes the agent's apps and its stored describe with it: a surviving catalog row would
     *  keep the tunnel's app path, its device grants and the owner's stored app session alive. */
    deletePin(name: string): boolean {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const r = this.db.prepare(`DELETE FROM pins WHERE name = ?`).run(name);
            // no pin was revoked: a name with no pin has no catalog to wipe, and the route says 404
            if (Number(r.changes) === 0) {
                this.db.exec("COMMIT");
                return false;
            }
            this.db
                .prepare(`DELETE FROM device_app_grants WHERE app_id IN (SELECT app_id FROM agent_apps WHERE agent = ?)`)
                .run(name);
            this.db.prepare(`DELETE FROM app_cookies WHERE agent = ?`).run(name);
            this.db.prepare(`DELETE FROM agent_apps WHERE agent = ?`).run(name);
            this.db.prepare(`DELETE FROM agents_registry WHERE name = ?`).run(name);
            this.db.exec("COMMIT");
            return true;
        } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }

    /** false = that pubkey is already enrolled — a revoked row keeps its pubkey forever, so a
     *  spent key can never re-enroll. */
    createDevice(d: { id: string; pubkey: string; name: string; sas: string }): boolean {
        const r = this.db
            .prepare(
                `INSERT INTO devices (id, pubkey, name, status, sas) VALUES (?, ?, ?, 'inactive', ?)
                 ON CONFLICT DO NOTHING`,
            )
            .run(d.id, d.pubkey, d.name, d.sas);
        return Number(r.changes) > 0;
    }

    getDevice(id: string): DeviceRow | null {
        const r = this.db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as
            | Record<string, unknown>
            | undefined;
        return r ? toDeviceRow(r) : null;
    }

    deviceByPubkey(pubkey: string): DeviceRow | null {
        const r = this.db.prepare(`SELECT * FROM devices WHERE pubkey = ?`).get(pubkey) as
            | Record<string, unknown>
            | undefined;
        return r ? toDeviceRow(r) : null;
    }

    listDevices(): DeviceRow[] {
        return this.db
            .prepare(`SELECT * FROM devices ORDER BY rowid DESC`)
            .all()
            .map((r) => toDeviceRow(r as Record<string, unknown>));
    }

    /** false = not enrolled-inactive: activation is the one-way step out of that state only. */
    activateDevice(id: string): boolean {
        const r = this.db
            .prepare(
                `UPDATE devices SET status = 'active', activated_at = datetime('now')
                 WHERE id = ? AND status = 'inactive'`,
            )
            .run(id);
        return Number(r.changes) > 0;
    }

    /** Terminal from any state; the row stays as the deny-list entry for its pubkey. */
    revokeDevice(id: string): boolean {
        const r = this.db.prepare(`UPDATE devices SET status = 'revoked' WHERE id = ?`).run(id);
        this.db.prepare(`DELETE FROM device_app_grants WHERE device = ?`).run(id);
        this.db.prepare(`DELETE FROM device_push WHERE device_id = ?`).run(id);
        return Number(r.changes) > 0;
    }

    setDevicePush(device: string, token: string): void {
        this.db
            .prepare(
                `INSERT INTO device_push (device_id, token) VALUES (?, ?)
                 ON CONFLICT(device_id) DO UPDATE SET token = excluded.token, updated_at = datetime('now')`,
            )
            .run(device, token);
    }

    /** With `token`, only while the device still holds that one: a token it replaced meanwhile stays. */
    deleteDevicePush(device: string, token?: string): void {
        this.db.prepare(`DELETE FROM device_push WHERE device_id = ? AND token = COALESCE(?, token)`).run(device, token ?? null);
    }

    listDevicePush(): Array<{ device: string; token: string }> {
        return this.db
            .prepare(`SELECT device_id, token FROM device_push ORDER BY device_id`)
            .all()
            .map((r) => ({ device: String(r["device_id"]), token: String(r["token"]) }));
    }

    /** Minting again for the same (device, app) replaces the credential; only its SHA-256 is stored. */
    setDeviceAppGrant(device: string, appId: string, credentialHash: string): void {
        this.db
            .prepare(
                `INSERT INTO device_app_grants (device, app_id, credential_hash) VALUES (?, ?, ?)
                 ON CONFLICT(device, app_id) DO UPDATE SET
                     credential_hash = excluded.credential_hash, created_at = datetime('now')`,
            )
            .run(device, appId, credentialHash);
    }

    getDeviceAppGrant(device: string, appId: string): { appId: string; credentialHash: string; createdAt: string } | null {
        const r = this.db
            .prepare(`SELECT app_id, credential_hash, created_at FROM device_app_grants WHERE device = ? AND app_id = ?`)
            .get(device, appId) as Record<string, unknown> | undefined;
        return r
            ? { appId: String(r["app_id"]), credentialHash: String(r["credential_hash"]), createdAt: String(r["created_at"]) }
            : null;
    }

    touchDevice(id: string): void {
        this.db.prepare(`UPDATE devices SET last_seen = datetime('now') WHERE id = ?`).run(id);
    }

    /** Expired never-approved enrollments are DROPPED, not deny-listed; 'revoked' is never touched. */
    sweepInactiveDevices(maxAgeMs: number, now = Date.now()): string[] {
        const cutoff = new Date(now - Math.max(0, maxAgeMs)).toISOString().slice(0, 19).replace("T", " ");
        return this.db
            .prepare(`DELETE FROM devices WHERE status = 'inactive' AND enrolled_at < ? RETURNING id`)
            .all(cutoff)
            .map((row) => String(row["id"]));
    }

    /** Epoch adoption resets the contiguous counter in the same statement — never separately. */
    setDeviceEpoch(id: string, epoch: string): boolean {
        const r = this.db
            .prepare(`UPDATE devices SET epoch = ?, max_seq = 0 WHERE id = ?`)
            .run(epoch, id);
        return Number(r.changes) > 0;
    }

    /** One idempotent mutation, classified and executed under one BEGIN IMMEDIATE. `exec` is
     *  synchronous; effects beyond this sqlite file are the caller's post-commit concern. */
    runDeviceOp(
        id: string,
        epoch: string,
        seq: number,
        kind: string,
        argsHash: string,
        exec: () => Record<string, unknown>,
    ): DeviceOpOutcome {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const d = this.db.prepare(`SELECT epoch, max_seq FROM devices WHERE id = ?`).get(id) as
                | { epoch: string | null; max_seq: number }
                | undefined;
            if (!d) throw new Error(`gateway.db: no device "${id}".`);
            let out: DeviceOpOutcome;
            if (d.epoch !== epoch) {
                out = { status: "wrong_epoch" };
            } else if (seq === Number(d.max_seq) + 1) {
                const result = exec();
                this.db
                    .prepare(
                        `INSERT INTO device_ops (device, epoch, seq, kind, args_hash, result)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                    )
                    .run(id, epoch, seq, kind, argsHash, JSON.stringify(result));
                this.db.prepare(`UPDATE devices SET max_seq = ? WHERE id = ?`).run(seq, id);
                out = { status: "executed", result };
            } else if (seq > Number(d.max_seq) + 1) {
                out = { status: "out_of_order" };
            } else {
                // contiguity invariant: seq <= max_seq means this op WAS received before
                const stored = this.db
                    .prepare(`SELECT args_hash, result FROM device_ops WHERE device = ? AND epoch = ? AND seq = ?`)
                    .get(id, epoch, seq) as { args_hash: string; result: string } | undefined;
                out = !stored
                    ? { status: "expired_executed" }
                    : stored.args_hash === argsHash
                      ? { status: "replay", result: JSON.parse(stored.result) as Record<string, unknown> }
                      : { status: "conflict" };
            }
            this.db.exec("COMMIT");
            return out;
        } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }

    /** Stored outcomes age out; a later replay of a swept seq reads back `expired_executed`. */
    sweepDeviceOps(maxAgeMs: number, now = Date.now()): number {
        const cutoff = new Date(now - Math.max(0, maxAgeMs)).toISOString().slice(0, 19).replace("T", " ");
        return Number(this.db.prepare(`DELETE FROM device_ops WHERE created_at < ?`).run(cutoff).changes);
    }


    getModelsPolicy(name: string): ModelsPolicy | null {
        const r = this.db.prepare(`SELECT models FROM pins WHERE name = ?`).get(name) as
            | { models: string | null }
            | undefined;
        return readModelsPolicy(jsonCol(r?.models)); // unreadable = no policy: the default model alone
    }

    listModelsPolicies(): Map<string, ModelsPolicy | null> {
        const rows = this.db.prepare(`SELECT name, models FROM pins`).all();
        return new Map(rows.map((row) => [String(row["name"]), readModelsPolicy(jsonCol(row["models"]))]));
    }

    /** false = no pin for that name — a policy has nothing to hang on. null clears it. */
    setModelsPolicy(name: string, policy: ModelsPolicy | null): boolean {
        const r = this.db
            .prepare(`UPDATE pins SET models = ? WHERE name = ?`)
            .run(policy === null ? null : JSON.stringify(policy), name);
        return Number(r.changes) > 0;
    }

    setPaused(agent: string, paused: boolean): void {
        this.db
            .prepare(
                `INSERT INTO pauses (agent, paused) VALUES (?, ?)
                 ON CONFLICT(agent) DO UPDATE SET paused = excluded.paused`,
            )
            .run(agent, paused ? 1 : 0);
    }

    isPaused(agent: string): boolean {
        const r = this.db.prepare(`SELECT paused FROM pauses WHERE agent = ?`).get(agent) as
            | { paused: number }
            | undefined;
        return r ? Number(r.paused) === 1 : false;
    }

    listPauses(): PauseRow[] {
        return this.db
            .prepare(`SELECT agent, paused FROM pauses`)
            .all()
            .map((r) => {
                const row = r as Record<string, unknown>;
                return { agent: String(row["agent"]), paused: Number(row["paused"]) === 1 };
            });
    }

    close(): void {
        this.db.close();
        if (connections.get(this.path) === this) connections.delete(this.path);
    }
}

const connections = new Map<string, GatewayDb>();

export function gatewayDb(path: string = gatewayDbFile()): GatewayDb {
    let d = connections.get(path);
    if (!d) {
        d = new GatewayDb(path);
        connections.set(path, d);
    }
    return d;
}
