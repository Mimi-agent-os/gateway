/** The turn engine: HEAD-check, prompt, tool batch, gate, invoke, append — the gateway's loop. */

import { projectMessage, sanitizeHistory } from "@mimi-os/protocol";
import type {
    EventBody,
    FinishReason,
    InvokePayload,
    Message,
    MessageMeta,
    Tool,
    ToolCall,
    Usage,
} from "@mimi-os/protocol";

import { estimateUsage, newCallId, recordLlmCall } from "../store/accounting.ts";
import { autoTitle } from "./autotitle.ts";
import {
    planCompaction,
    planSessionClose,
    shouldCompact,
    summarize,
    thresholdsFor,
    toolTrafficSummary,
} from "./compaction.ts";
import { cap } from "./chain.ts";
import type { GateAction, GateContext } from "../gates/gate-types.ts";
import { buildGatewayTools, type GatewayToolCtx } from "./gateway-tools.ts";
import { systemPrompt, visibleTo } from "./prompt.ts";
import { createProvider } from "../llm/models.ts";
import { admitAtDequeue, LimitReached, resolveModelFor } from "../llm/policy.ts";
import { enqueueCall, type CallPriority } from "../llm/queue.ts";
import {
    INVOKE_DEADLINE_MS,
    MAX_TOOL_TURNS,
    TOOL_OUTPUT_MAX,
    type LoopDeps,
    type PlannedCall,
    type RuntimeTool,
    type ToolResult,
    type TurnMetrics,
    type TurnOutcome,
    type TurnRequest,
} from "./loop-types.ts";
import { PeerError } from "../registry/peer.ts";

const DENIED =
    "The user DENIED this tool call (or no interactive approval is available in this run). " +
    "Do not retry it; report the denial in your answer.";

/** A line the gateway itself wrote — no agent said it, and no model call produced it. */
const SYSTEM_NOTE: MessageMeta = { actor: { kind: "system" } };

const ABNORMAL_FINISH_NOTES: Partial<Record<FinishReason, string>> = {
    length: "[response cut off by the token limit]",
    content_filter: "[response blocked by the provider's content filter]",
    error: "[response ended abnormally — treat it as incomplete]",
};

/** One user turn: throws only on a provider failure — an agent that dies mid-batch drops the
 *  turn (`dropped`) and the SDK repairs its own parity at its next boot. */
export async function runTurn(deps: LoopDeps, req: TurnRequest): Promise<TurnOutcome> {
    req.signal?.throwIfAborted();
    const turnStart = performance.now();
    const agent = req.agent;
    const room = req.room ?? null;
    // a room turn appends nothing to the agent: the shared transcript is the gateway's own
    const session = req.session;
    const where = room === null ? `${agent}#${session}` : `${agent}@${room.room}`;
    const scope = req.scope ?? agent;
    const emit = req.emit;
    const depth = req.depth ?? 0;
    const found = deps.registry.get(agent);
    if (!found) throw new Error(`agent "${agent}" is not connected`);
    // before anything is spent: a blocked agent, or one with no pin, gets no turn at all
    const admission = deps.registry.statusOf(agent);
    if (admission !== "approved") throw new Error(`agent "${agent}" ${admission === "blocked" ? "is blocked" : "has no pin"} — no turn runs`);
    // pause is durable in gateway.db, and it binds a delegated turn exactly like a typed one
    if (deps.registry.isPaused(agent)) {
        throw new Error(`agent "${agent}" is paused — resume it before running a turn`);
    }
    const peer = found; // re-bound after the guard so hoisted closures see the narrowed type
    const gateCtx: GateContext = { agent, session, room: room?.room, emit };

    // resolution, allowed-list and the model's daily limit in one gate, before a provider exists
    const resolved = resolveModelFor(agent, req.model, peer.describe?.manifest.model, deps.db);
    if (!resolved.ok) throw new Error(resolved.reason);
    const fallbackCfg = resolved.fallback;
    let cfg = resolved.cfg;
    // this turn's own images must reach a model that sees them; older ones are cut per attempt (visibleTo)
    if (req.images && req.images.length > 0 && !cfg.vision) {
        throw resolved.replaces ? new LimitReached(resolved.replaces.name) : new Error(`model "${cfg.name}" has no image support`);
    }
    let provider = createProvider(cfg.name, deps.db);
    let thresholds = thresholdsFor(cfg, deps.db);
    let queueKey = cfg.endpointUrl;
    let usedFallback = false;
    const priority: CallPriority = req.priority ?? "interactive";
    const deadlineMs = req.invokeDeadlineMs ?? INVOKE_DEADLINE_MS;

    const policy = peer.describe?.manifest.policy;
    const allowed = policy?.allowedTools ? new Set(policy.allowedTools) : null;
    const budgets = policy?.budgets;
    const spent = new Map<string, number>();

    let answer = "";
    /** A room turn's own rounds: assistant lines and tool results the model needs next round and
     *  the shared transcript must never see — only the published reply goes back to the room. */
    const working: Message[] = [];
    let rounds = 0;
    let dropped = false;
    let lastPromptTokens = 0;
    let compactedThisTurn = false;
    let pendingClose: string | null = null;
    // the tool run a fold may cover: [firstToolSeq, lastResultSeq], never across a compaction event
    let firstToolSeq: number | null = null;
    let lastResultSeq: number | null = null;
    // accumulate across the run's rounds: auto-fold fires only when the tool traffic since
    // firstToolSeq was ENTIRELY foldable, so a non-fold result is never folded away
    let usedFoldTool = false;
    let usedNonFoldTool = false;
    let turnSeq: number | null = null;
    /** The model call this round is writing for, and the event seqs already tied to it. */
    let roundCallId: string | null = null;
    let roundSeqs: number[] = [];
    let lastCall: Omit<TurnMetrics, "turnDurationMs" | "rounds"> | null = null;
    /** The round's tool table: what the model was offered is what its calls and chain steps run. */
    let tools = new Map<string, RuntimeTool>();

    /** The gateway persists `thinking` alongside; the projection strips it back to Message on read.
     *  `meta` is the authorship/provenance stamp — hashed with the payload, so it exists on new
     *  events only: an assistant line is the agent's and names the call that produced it, the user
     *  message carries whatever author the caller vouched for, a tool result carries none. */
    const messageEvent = (m: Message, thinking?: string, meta?: MessageMeta): EventBody => {
        const payload: Message & { thinking?: string } = { ...m };
        if (thinking) payload.thinking = thinking;
        if (meta) payload.meta = meta;
        else if (m.role === "assistant") {
            payload.meta = {
                ...(roundCallId !== null ? { callId: roundCallId } : {}),
                registryModel: cfg.name,
                actor: { kind: "agent", agent },
            };
        } else if (m.role === "user" && req.actor) payload.meta = { actor: req.actor };
        return { type: "message", payload };
    };

    const metricsNow = (): TurnMetrics | null =>
        lastCall === null
            ? null
            : { ...lastCall, turnDurationMs: Math.round(performance.now() - turnStart), rounds };

    /** The appended seqs, or null when the write was lost (and the turn with it). */
    async function append(bodies: readonly EventBody[], signal = req.signal): Promise<number[] | null> {
        if (!bodies.length) return [];
        if (session === null) {
            // down to the neutral Message contract: `thinking` and the authorship stamp are
            // display data, and a room turn's rounds are never stored anywhere at all
            for (const b of bodies) {
                const m = b.type === "message" ? projectMessage(b.payload) : null;
                if (m) working.push(m);
            }
            return [];
        }
        try {
            const ok = await peer.request("append", {
                session,
                events: [...bodies],
            }, { signal });
            deps.sessions.applyAppend(agent, session, bodies, ok.head);
            // an agent that answers without `seqs` loses the association, never the turn
            const seqs = Array.isArray(ok.seqs) ? ok.seqs : [];
            if (roundCallId !== null) {
                const mine = bodies.flatMap((b, i) => {
                    if (b.type !== "message") return [];
                    const role = (b.payload as Message).role;
                    const seq = seqs[i];
                    return (role === "assistant" || role === "tool") && seq !== undefined ? [seq] : [];
                });
                if (mine.length) {
                    roundSeqs.push(...mine);
                    try {
                        deps.db.setLlmCallMessages(roundCallId, roundSeqs);
                    } catch {
                        /* the association is a trace, never worth the turn */
                    }
                }
            }
            return [...seqs];
        } catch (e) {
            deps.log(
                `[loop] ${where}: append lost — ${(e as Error).message}; ` +
                    `the turn is dropped\n`,
            );
            deps.sessions.drop(agent, session);
            dropped = true;
            return null;
        }
    }

    /** Only at a paired point, and only on real usage — never on an estimate. A room transcript
     *  is published history and is never folded: only an agent's own chain compacts. */
    async function maybeCompact(): Promise<void> {
        if (session === null || !thresholds || compactedThisTurn || dropped) return;
        if (!shouldCompact(thresholds, cfg.contextTokens, lastPromptTokens)) return;
        const cur = await deps.sessions.ensure(agent, session, req.signal).catch(() => null);
        if (!cur) return;
        const plan = planCompaction(deps.sessions.folded(cur), cur.events[0]?.seq ?? 0, thresholds);
        if (!plan) return;
        const summary = await summarize({ agent, session, cfg, turnSeq, signal: req.signal }, plan.lines, deps.db);
        if (summary === null) return; // no summary → NO compaction; real history is never stubbed
        compactedThisTurn = true;
        if ((await append([{ type: "compaction", payload: { summary, covers: plan.covers } }])) === null) return;
        // a fold over this event would drop its summary for good: the next tool run starts after it
        firstToolSeq = null;
        usedFoldTool = false;
        usedNonFoldTool = false;
        deps.log(
            `[loop] ${where}: compacted ${plan.prefixMessages} ` +
                `messages (~${plan.prefixTokens} tokens) at ${lastPromptTokens}\n`,
        );
        emit?.({ type: "compacted", covers: plan.covers, messages: plan.prefixMessages });
    }

    /** `done` folds the run under the model's own summary; a run of only fold tools gets a mechanical one at the turn's end. */
    async function foldRun(summary: string | null): Promise<void> {
        const from = firstToolSeq;
        const to = lastResultSeq;
        firstToolSeq = null;
        usedFoldTool = false;
        usedNonFoldTool = false;
        if (dropped || session === null || from === null || to === null) return;
        const cur = await deps.sessions.ensure(agent, session, req.signal).catch(() => null);
        if (!cur) return;
        const folded = deps.sessions.folded(cur);
        const plan = planSessionClose(folded, from, to);
        if (!plan) return;
        const body = summary ?? toolTrafficSummary(folded, from, to);
        await append([{ type: "compaction", payload: { summary: `[work folded] ${body}`, covers: plan.covers } }]);
    }

    async function stopped(results: EventBody[] = []): Promise<TurnOutcome> {
        // Persist tool-call closeout even after stop; a dead peer must not hold shutdown indefinitely.
        await append([
            ...results,
            messageEvent({ role: "assistant", content: "[stopped by user]" }, undefined, SYSTEM_NOTE),
        ], AbortSignal.timeout(5_000));
        return { text: "Stopped by user before completion.", rounds, dropped, titling: null, metrics: metricsNow() };
    }

    const overBudget = (name: string): boolean => {
        const capN = budgets?.[name];
        return capN !== undefined && (spent.get(name) ?? 0) >= capN;
    };

    /** A chain step is a tool call like any other: the run's plan and budgets bind it too. */
    async function callByName(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        req.signal?.throwIfAborted();
        const tool = tools.get(name);
        if (!tool) throw new Error(`unknown tool "${name}"`);
        if (allowed && !allowed.has(name)) throw new Error(`"${name}" is not in this run's plan`);
        if (overBudget(name)) throw new Error(`the call budget for "${name}" in this run is exhausted`);
        if (tool.schema.writes) {
            const ok = req.attended === true ? await deps.gates.askOne(gateCtx, name, args) : false;
            if (!ok) throw new Error(`the user denied "${name}"`);
        }
        spent.set(name, (spent.get(name) ?? 0) + 1);
        return execute(tool, name, args);
    }

    async function execute(tool: RuntimeTool, name: string, args: Record<string, unknown>): Promise<ToolResult> {
        if (tool.kind === "gateway") {
            const run = tool.run;
            if (!run) throw new Error(`tool "${name}" has no implementation`);
            return run(args);
        }
        const invoke: InvokePayload = { tool: name, args };
        // a room turn names no session: the agent has no conversation behind this call
        if (session !== null) invoke.session = session;
        const r = await peer.request("invoke", invoke, { deadline: deadlineMs, signal: req.signal });
        return { text: typeof r.text === "string" ? r.text : "", data: r.data };
    }

    const toolCtx: GatewayToolCtx = {
        deps,
        req,
        peer,
        gateCtx,
        depth,
        roundCallId: () => roundCallId,
        table: () => tools,
        callByName,
        setPendingClose: (s) => {
            pendingClose = s;
        },
    };

    /** Rebuilt every round: a re-describe between rounds changes the toolset for the next one. */
    function table(): Map<string, RuntimeTool> {
        const out = new Map<string, RuntimeTool>();
        for (const t of peer.describe?.tools ?? []) out.set(t.name, { schema: t, kind: "agent" });
        for (const t of buildGatewayTools(toolCtx)) out.set(t.schema.name, t);
        return out;
    }

    // a room turn opens on a message the route already published: the projection carries it with
    // its author line, so appending it again would say it twice
    if (session !== null) {
        await deps.sessions.ensure(agent, session, req.signal);
        const user: Message = { role: "user", content: req.text };
        if (req.images && req.images.length > 0) user.images = req.images;
        const opened = await append([messageEvent(user)]);
        if (opened === null) {
            return { text: "", rounds: 0, dropped: true, titling: null, metrics: null };
        }
        turnSeq = opened[0] ?? null;
        // the replay boundary: everything this turn persists comes after this seq — emitted only
        // when the append really named one, never invented
        if (turnSeq !== null) req.emit?.({ type: "turn_started", turnSeq });
    }

    for (let round = 0; round < MAX_TOOL_TURNS; round++) {
        rounds = round + 1;
        if (req.signal?.aborted) return stopped();
        const past: Message[] = [];
        if (session !== null) {
            // HEAD-check before EVERY model call: the agent may have written since the last round
            past.push(...deps.sessions.history(await deps.sessions.ensure(agent, session, req.signal)));
        } else if (room !== null) {
            // the shared transcript as THIS agent sees it, then what this turn has produced
            past.push(...sanitizeHistory([...room.history(), ...working]));
        }
        const history: Message[] = [systemPrompt(peer), ...past];
        tools = table();
        const schemas: Tool[] = [...tools.values()].map((t) => {
            const fn: Tool["function"] = { name: t.schema.name };
            if (t.schema.description !== undefined) fn.description = t.schema.description;
            if (t.schema.parameters !== undefined) fn.parameters = t.schema.parameters;
            return { type: "function", function: fn };
        });

        let thinking = "";
        let text = "";
        let calls: ToolCall[] = [];
        // `as` defeats literal narrowing: the real value is assigned inside the stream closure
        let finishReason = "error" as FinishReason;
        let usage: Usage | undefined;

        /** One model call, accounted whatever happens; returns the thrown provider failure. */
        const attempt = async (
            callScope: string,
            attemptNo: number,
            parentCallId: string | null,
        ): Promise<unknown> => {
            thinking = "";
            text = "";
            calls = [];
            finishReason = "error" as FinishReason;
            usage = undefined as Usage | undefined;
            let reported: string | undefined;
            let failed: unknown = null;
            const t0 = performance.now();
            const callId = newCallId();
            roundCallId = callId;
            roundSeqs = [];
            let firstOutputMs: number | null = null;
            let dispatched = false;
            const sent = visibleTo(cfg.vision, history);
            try {
                await enqueueCall(
                    queueKey,
                    async () => {
                        // the gate binds at DEQUEUE too: what ran ahead of this call may have spent
                        // the model's limit while this one waited in the queue
                        admitAtDequeue(agent, cfg, deps.db);
                        dispatched = true;
                        for await (const ev of provider.stream(sent, schemas, req.signal)) {
                            // queue INCLUDED (t0 precedes enqueueCall); an empty delta is not output
                            if (
                                firstOutputMs === null &&
                                (ev.type === "text" || ev.type === "thinking"
                                    ? ev.text !== ""
                                    : ev.type === "tool_calls" && ev.calls.length > 0)
                            ) {
                                firstOutputMs = Math.round(performance.now() - t0);
                            }
                            switch (ev.type) {
                                case "thinking":
                                    thinking += ev.text;
                                    break;
                                case "text":
                                    text += ev.text;
                                    break;
                                case "tool_calls":
                                    calls.push(...ev.calls);
                                    break;
                                case "done":
                                    finishReason = ev.finishReason;
                                    usage = ev.usage;
                                    reported = ev.model;
                                    // stays INSIDE the loop: this is the ROUND's done, and the
                                    // client reads a `done` as the TURN's — forwarding it ends a
                                    // re-attach at round 1 and marks a broken turn clean
                                    continue;
                            }
                            emit?.(ev as unknown as Record<string, unknown>);
                        }
                    },
                    priority,
                    req.signal,
                );
            } catch (e) {
                failed = e;
            }
            // account EVERY model call — failures included, or tokens go dark; one the provider had
            // but never reported (stopped, or failed mid-stream) still spent, so it is estimated
            const durationMs = Math.round(performance.now() - t0);
            const estimate =
                usage === undefined && dispatched && (firstOutputMs !== null || req.signal?.aborted === true)
                    ? estimateUsage(sent, schemas, thinking + text + calls.map((c) => c.name + c.arguments).join(""))
                    : undefined;
            recordLlmCall(
                {
                    agent,
                    scope: callScope,
                    callId,
                    callKind: "turn",
                    session,
                    room: room?.room ?? null,
                    model: provider.model ?? null,
                    provider: cfg.provider,
                    registryModel: cfg.name,
                    modelUid: cfg.modelUid,
                    reportedModel: reported ?? null,
                    attempt: attemptNo,
                    parentCallId,
                    turnSeq,
                    finishReason: failed ? "error" : finishReason,
                    usage: usage ?? estimate,
                    usageEstimated: estimate !== undefined,
                    durationMs,
                    firstOutputMs,
                    raw: failed
                        ? { thinking, text, toolCalls: calls, error: String(failed) }
                        : { thinking, text, toolCalls: calls, finishReason, usage },
                },
                deps.db,
            );
            lastCall = {
                finalCallId: callId,
                registryModel: cfg.name,
                reportedModel: reported ?? undefined,
                completionTokens: usage?.completionTokens,
                requestedModel: provider.model,
                callDurationMs: durationMs,
            };
            if (usage) lastPromptTokens = usage.promptTokens;
            return failed;
        };

        let failure = await attempt(scope, 1, null);
        const primaryCallId = roundCallId;
        // ONLY a thrown provider failure or a spent daily limit earns the fallback, and only once per
        // turn: a finish_reason of "length"/"content_filter" is a real answer, and any other policy
        // refusal (the PeerError above) is not an outage either
        const outage = !!failure && (!(failure instanceof PeerError) || failure instanceof LimitReached);
        // a text-only fallback would answer this turn's images blind
        const canSee = !req.images?.length || fallbackCfg?.vision === true;
        if (outage && fallbackCfg && canSee && !usedFallback && req.signal?.aborted !== true) {
            usedFallback = true;
            deps.log(
                `[loop] ${where}: ${cfg.name} failed ` +
                    `(${(failure as Error).message}) — retrying once on "${fallbackCfg.name}"\n`,
            );
            cfg = fallbackCfg;
            provider = createProvider(cfg.name, deps.db);
            thresholds = thresholdsFor(cfg, deps.db);
            queueKey = cfg.endpointUrl;
            // the dead attempt's text/thinking already reached the client: this says drop them,
            // because what follows is a replacement answer, not a continuation
            emit?.({ type: "restart", reason: "fallback", model: cfg.name });
            failure = await attempt(`${scope}:fallback`, 2, primaryCallId);
        }

        if (req.signal?.aborted) return stopped();

        if (failure) {
            const ending =
                failure instanceof PeerError
                    ? `[stopped — ${failure.message}]`
                    : "[provider error — the response did not complete]";
            await append([
                messageEvent({ role: "assistant", content: `${text ? `${text}\n` : ""}${ending}` }, thinking),
            ]);
            throw failure as Error;
        }

        const note = ABNORMAL_FINISH_NOTES[finishReason];
        if (note) {
            await append([
                messageEvent({ role: "assistant", content: text ? `${text}\n${note}` : note }, thinking),
            ]);
            answer = text.trim() || note;
            break;
        }

        if (calls.length === 0) {
            answer = text.trim() || `No answer produced by the "${scope}" agent.`;
            // store the fallback too, not an empty string: a model that ends its turn with no text
            // (e.g. after a run of tool calls) must leave a visible line, never a blank bubble
            await append([messageEvent({ role: "assistant", content: text.trim() ? text : answer }, thinking)]);
            break;
        }

        // an approval key must name exactly ONE call, and a tool result must pair with exactly one
        // tool_call: the model may repeat an id, send none, or name one the gateway would mint, so
        // every id is claimed here and a taken one is replaced by one nothing else holds
        const ids = new Set<string>();
        calls = calls.map((call, i) => {
            if (call.id && !ids.has(call.id)) {
                ids.add(call.id);
                return call;
            }
            let id = `call#${i}`;
            while (ids.has(id)) id += "x";
            ids.add(id);
            return { ...call, id };
        });

        const opening = messageEvent(
            { role: "assistant", content: text || null, tool_calls: calls },
            thinking,
        );
        const opened = await append([opening]);
        if (opened === null) {
            return { text: answer, rounds, dropped: true, titling: null, metrics: metricsNow() };
        }
        // `done` must never guess a range to fold: an append that names no seq starts no run
        firstToolSeq ??= opened[0] ?? null;

        const planned: PlannedCall[] = [];
        const gated: GateAction[] = [];
        for (const call of calls) {
            let args: Record<string, unknown> | null = null;
            let argsError = "";
            try {
                const parsed: unknown = call.arguments ? JSON.parse(call.arguments) : {};
                if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                    args = parsed as Record<string, unknown>;
                } else {
                    const got = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
                    argsError = `tool arguments must be a JSON object, got ${got}`;
                }
            } catch (e) {
                argsError = `tool arguments were not valid JSON (${(e as Error).message})`;
            }
            planned.push({ call, args, argsError });
            if (
                args !== null &&
                (!allowed || allowed.has(call.name)) &&
                !overBudget(call.name) &&
                tools.get(call.name)?.schema.writes === true
            ) {
                gated.push({ id: call.id, tool: call.name, args });
            }
        }

        const decisions = new Map<string, boolean>();
        if (gated.length) {
            if (req.attended === true && !req.signal?.aborted) {
                try {
                    const answers = await deps.gates.ask(gateCtx, gated);
                    for (const g of gated) decisions.set(g.id, answers[g.id] === true);
                } catch {
                    for (const g of gated) decisions.set(g.id, false);
                }
            } else {
                // nobody to ask (an unattended run, a delegation): deny-by-default IS the answer
                for (const g of gated) decisions.set(g.id, false);
            }
        }

        const results: EventBody[] = [];
        for (const { call, args, argsError } of planned) {
            // every planned call leaves a result in the fold range, so a non-fold (or unknown) call
            // blocks auto-fold; only a tool the agent marked `fold` is foldable traffic
            if (tools.get(call.name)?.schema.fold === true) usedFoldTool = true;
            else usedNonFoldTool = true;
            let out: string;
            if (req.signal?.aborted) {
                out = "Skipped: stopped by user.";
            } else if (args === null) {
                out = `Error: ${argsError}. Fix the arguments and call again.`;
            } else if (allowed && !allowed.has(call.name)) {
                out = `Denied: "${call.name}" is not in this run's plan. Do not retry it.`;
            } else if (overBudget(call.name)) {
                out = `Denied: the call budget for "${call.name}" in this run is exhausted.`;
            } else {
                const tool = tools.get(call.name);
                if (!tool) {
                    out = `Error: unknown tool "${call.name}".`;
                } else if (tool.schema.writes && decisions.get(call.id) !== true) {
                    // the invoke is NEVER SENT: a denied write tool does not leave the gateway
                    out = DENIED;
                } else {
                    spent.set(call.name, (spent.get(call.name) ?? 0) + 1);
                    emit?.({ type: "tool_call", id: call.id, name: call.name, args });
                    try {
                        out = (await execute(tool, call.name, args)).text;
                    } catch (e) {
                        const status = e instanceof PeerError ? e.status : "error";
                        out =
                            status === "timeout"
                                ? `Error: "${call.name}" did not answer within ${deadlineMs}ms — treat it as not done.`
                                : status === "denied"
                                  ? `Denied: the agent refused "${call.name}".`
                                  : `Error: ${(e as Error).message}`;
                    }
                }
            }
            out = cap(out, TOOL_OUTPUT_MAX);
            emit?.({ type: "tool_result", id: call.id, name: call.name, text: out });
            results.push(messageEvent({ role: "tool", tool_call_id: call.id, content: out }));
        }

        if (req.signal?.aborted) return stopped(results);

        const written = await append(results);
        if (written === null) {
            return { text: answer, rounds, dropped: true, titling: null, metrics: metricsNow() };
        }
        lastResultSeq = written.at(-1) ?? null;
        if (pendingClose !== null) {
            const summary = pendingClose;
            pendingClose = null;
            await foldRun(summary);
        }
        await maybeCompact();
    }

    if (!answer) {
        answer = `[tool loop limit of ${MAX_TOOL_TURNS} turns reached — stopping]`;
        await append([messageEvent({ role: "assistant", content: answer }, undefined, SYSTEM_NOTE)]);
    }
    // only now: folding between rounds would hide a result the model has not read yet
    if (usedFoldTool && !usedNonFoldTool) await foldRun(null);
    await maybeCompact();

    // a room has its own title and no agent-side chat to name
    const titling =
        req.title === false || dropped || session === null
            ? null
            : autoTitle({
                  agent,
                  session,
                  peer,
                  seed: req.text,
                  model: cfg.name,
                  turnSeq,
                  db: deps.db,
                  log: deps.log,
                  signal: req.signal,
              });
    return { text: answer, rounds, dropped, titling, metrics: metricsNow() };
}
