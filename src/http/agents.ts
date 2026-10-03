import type { GatewayCore } from "../core.ts";
import { defaultModelName, resolveModelFor } from "../llm/policy.ts";
import type { AgentInfo } from "../registry/registry-types.ts";
import type { LlmCallRow, ModelsPolicy } from "../store/db.ts";
import { dayInfo } from "../store/day.ts";
import { gatewayToolNames } from "../turn/gateway-tools.ts";
import { isoStamp, json, type Router } from "./router.ts";

/** The roster card: the manifest's choice over the default, and a summary of the policy —
 *  the full one lives at /api/agents/:name/models. */
const agentCard = (a: AgentInfo, def: string, mp: ModelsPolicy | null): Record<string, unknown> => {
    const policy = a.manifest?.policy;
    const allowedTools = policy?.allowedTools?.length ? policy.allowedTools : undefined;
    const budgets = policy?.budgets && Object.keys(policy.budgets).length ? policy.budgets : undefined;
    return {
        name: a.name,
        description: a.manifest?.description,
        avatar: a.avatar,
        model: a.manifest?.model ?? def,
        inherited: a.manifest?.model === undefined,
        paused: a.paused,
        connected: a.connected,
        status: a.status,
        perms: a.perms,
        lastSeen: a.lastSeen ? isoStamp(a.lastSeen) : null,
        models: mp ? { primary: mp.primary, fallback: mp.fallback } : null,
        policy: allowedTools || budgets ? { allowedTools, budgets } : undefined,
    };
};

/** Health reflects connection + admission only — services, schedule and packs are the agent's own business. */
const dashboardRow = (a: AgentInfo, today: { tokens: number; cost: number } | undefined): Record<string, unknown> => ({
    name: a.name,
    description: a.manifest?.description,
    avatar: a.avatar,
    health: !a.connected || a.healthError ? "down" : (a.status !== "approved" ? "degraded" : "ok"),
    connected: a.connected,
    status: a.status,
    why:
        a.status === "approved"
            ? (a.healthError ?? (!a.connected ? "not connected" : ""))
            : a.status === "blocked"
              ? `blocked — run "mimi unblock ${a.name}" on the gateway's machine, or revoke its pin and pair it again`
              : "no pin — pair it with an agent invite",
    lastActivity: a.lastSeen ? isoStamp(a.lastSeen) : null,
    tokensToday: today?.tokens ?? 0,
    costToday: today?.cost ?? 0,
    paused: a.paused,
});

/** The llm_calls row as /api/agents/:agent/calls serves it — the wire names a client keys on, so
 *  one mapper owns the whole projection. */
const toCallWire = (r: LlmCallRow): Record<string, unknown> => ({
    id: r.id,
    conversationId: r.conversationId,
    room: r.room,
    scope: r.scope,
    callId: r.callId,
    callKind: r.callKind,
    model: r.model,
    modelUid: r.modelUid,
    registryModel: r.registryModel,
    provider: r.provider,
    requestedModel: r.model,
    reportedModel: r.reportedModel,
    attempt: r.attempt,
    parentCallId: r.parentCallId,
    turnSeq: r.turnSeq,
    messageSeqs: r.messageSeqs,
    finishReason: r.finishReason,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    cachedTokens: r.cachedTokens,
    reasoningTokens: r.reasoningTokens,
    usageEstimated: r.usageEstimated,
    cost: r.cost,
    durationMs: r.durationMs,
    firstOutputMs: r.firstOutputMs,
    tokensPerSec: r.tokensPerSec,
    createdAt: r.createdAt,
});

const DESCRIBE_HEALTH_MS = 5_000;

export function registerAgents(router: Router, core: GatewayCore): void {
    router.get("/api/agents", (ctx) => {
        const def = defaultModelName(core.db);
        const policies = core.db.listModelsPolicies();
        return json(ctx.res, 200, core.listAgents().map((a) => agentCard(a, def, policies.get(a.name) ?? null)));
    });

    router.get("/api/dashboard", (ctx) => {
        const approvals = core.approvals.pending();
        const spend = core.db.spendByAgent();
        return json(ctx.res, 200, {
            at: isoStamp(Date.now()),
            day: dayInfo(),
            waiting: { approvals: approvals.length },
            agents: core.listAgents().map((a) => dashboardRow(a, spend.get(a.name))),
            // as /api/approvals: a chat gate names its conversation, a room gate its room, never both
            approvals: approvals.map((g) => ({
                agent: g.agent,
                conversation: g.session ?? undefined,
                room: g.room ?? undefined,
                tool: g.tool,
                since: isoStamp(g.since),
            })),
        });
    });

    // what the gateway made of the agent's describe; prompt, app, bytes and packsDisabled are the live socket's, so empty offline
    router.get("/api/agents/:agent/describe", async (ctx) => {
        const agent = ctx.param("agent");
        const info = core.registry.info(agent);
        if (!info.manifest) return json(ctx.res, 404, { error: `agent "${agent}" has never described itself` });
        const peer = core.registry.get(agent);
        let lastError: string | null = null;
        if (peer) {
            try {
                lastError = (await peer.request("health", {}, { timeoutMs: DESCRIBE_HEALTH_MS })).lastError ?? null;
            } catch (e) {
                lastError = `health: ${(e as Error).message}`;
            }
        }
        const gatewayTools = new Set(gatewayToolNames(core.registry, agent, info.manifest.chain));
        const shadowed = info.tools
            .filter((t) => gatewayTools.has(t.name))
            .map((t) => ({ kind: "tool", name: t.name, reason: "a gateway tool of the same name takes its place" }));
        const model = resolveModelFor(agent, undefined, info.manifest.model, core.db);
        return json(ctx.res, 200, {
            connected: info.connected,
            manifest: info.manifest,
            tools: info.tools,
            prompt: peer?.describe?.prompt ?? null,
            app: peer?.describe?.app ?? null,
            bytes: peer?.describeBytes ?? null,
            dropped: [...(peer?.dropped ?? []), ...shadowed],
            gatewayTools: [...gatewayTools],
            lastError,
            packsDisabled: peer?.describe?.packsDisabled ?? [],
            model: {
                asked: info.manifest.model ?? null,
                runsOn: model.ok ? model.cfg.name : null,
                ok: model.ok,
                reason: model.ok ? undefined : model.reason,
            },
        });
    });

    router.get("/api/agents/:agent/avatar", (ctx) => {
        const avatar = core.db.getAgentAvatar(ctx.param("agent"));
        if (!avatar) return json(ctx.res, 404, { error: "no avatar" });
        const etag = `"${avatar.sha256}"`;
        // ?v=<sha256> names exactly these bytes, so that URL can be cached for good
        const pinned = ctx.url.searchParams.get("v") === avatar.sha256;
        const headers = {
            etag,
            "x-content-type-options": "nosniff",
            "cache-control": pinned ? "private, max-age=31536000, immutable" : "private, no-cache",
        };
        if (ctx.req.headers["if-none-match"] === etag) {
            ctx.res.writeHead(304, headers);
            ctx.res.end();
            return;
        }
        ctx.res.writeHead(200, { ...headers, "content-type": avatar.type, "content-length": avatar.bytes.length });
        ctx.res.end(avatar.bytes);
    });

    router.post("/api/agents/:agent/stop", (ctx) => {
        const agent = ctx.param("agent");
        // pausing is what stops the work: the registry settles this agent's turns, gates and model calls
        const running = core.turns.forAgent(agent).length;
        core.setPaused(agent, true);
        return json(ctx.res, 200, { ok: true, turns: running, paused: true });
    });

    router.post("/api/agents/:agent/resume", (ctx) => {
        const agent = ctx.param("agent");
        core.setPaused(agent, false);
        return json(ctx.res, 200, { ok: true, paused: false });
    });

    router.post("/api/agents/:agent/clear-cache", (ctx) => {
        const agent = ctx.param("agent");
        // drops the gateway's RAM cache of this agent's sessions; the next turn reads them fresh.
        // it does NOT restart the agent — the agent is its own process and reconnects on its own.
        const held = core.sessions.held(agent).length;
        core.sessions.drop(agent);
        return json(ctx.res, 200, { ok: true, cleared: held });
    });

    router.get("/api/agents/:agent/calls", (ctx) => {
        const agent = ctx.param("agent");
        const rawLimit = ctx.url.searchParams.get("limit");
        const limit = rawLimit === null ? 50 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1) {
            return json(ctx.res, 400, { error: "limit must be a positive integer" });
        }
        const rawConversation = ctx.url.searchParams.get("conversation");
        const conversation = rawConversation === null ? undefined : Number(rawConversation);
        if (conversation !== undefined && (!Number.isSafeInteger(conversation) || conversation < 1)) {
            return json(ctx.res, 400, { error: "conversation must be a chat id" });
        }
        return json(ctx.res, 200, core.db.listLlmCalls(limit, agent, conversation).map(toCallWire));
    });

    router.get("/api/agents/:agent/calls/:id", (ctx) => {
        const agent = ctx.param("agent");
        const row = core.db.getLlmCall(Number(ctx.param("id")));
        if (!row || row.agent !== agent) return json(ctx.res, 404, { error: "no such call" });
        if (row.raw === "") return json(ctx.res, 404, { error: "raw payload pruned" });
        ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        ctx.res.end(row.raw); // already JSON — re-encoding would just double the work
    });

}
