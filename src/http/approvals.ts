import type { GatewayCore } from "../core.ts";
import type { GateCard, GateKind, GateSummary } from "../gates/gate-types.ts";
import { parseAnswers } from "../gates/questions.ts";
import { isoStamp, json, readBody, type Ctx, type Router } from "./router.ts";

interface ApprovalRow {
    gate: string;
    kind: GateKind;
    agent: string;
    conversation?: number | undefined;
    /** A gate raised in a shared conversation carries the room instead — never both. */
    room?: string | undefined;
    tool: string;
    label: string;
    actions: Array<{ id: string; label: string; detail?: Record<string, unknown> }>;
    since: string;
    deadline: number;
}

export function registerApprovals(router: Router, core: GatewayCore): void {
    // tools and timing, never the arguments: a listing must not be enough to approve blindly,
    // so `detail` and a question's text are added by the per-gate route below and nowhere else
    const row = (summary: GateSummary, card: GateCard): ApprovalRow => {
        const head = card.actions[0]?.tool ?? "?";
        const rest = card.actions.length - 1;
        const asks = card.questions.length;
        return {
            gate: summary.gate,
            kind: card.kind,
            agent: summary.agent,
            conversation: summary.session ?? undefined,
            room: summary.room ?? undefined,
            tool: card.kind === "question" ? summary.tool : head,
            label:
                card.kind === "question"
                    ? `${summary.agent} asks you ${asks === 1 ? "a question" : `${asks} questions`}`
                    : rest > 0
                      ? `${summary.agent} wants to run ${head} and ${rest} more`
                      : `${summary.agent} wants to run ${head}`,
            actions: card.actions.map((a) => ({ id: a.id, label: a.tool })),
            since: isoStamp(summary.since),
            deadline: card.deadline,
        };
    };

    router.get("/api/approvals", (ctx: Ctx) => {
        const approvals: ApprovalRow[] = [];
        for (const summary of core.approvals.pending()) {
            const card = core.approvals.describe(summary.gate);
            if (card) approvals.push(row(summary, card));
        }
        return json(ctx.res, 200, { approvals });
    });

    router.get("/api/approvals/:gate", (ctx: Ctx) => {
        const gate = ctx.param("gate");
        const summary = core.approvals.pending().find((g) => g.gate === gate);
        const card = core.approvals.describe(gate);
        // a gate id is opaque and never reused, so an id this process does not hold is simply gone
        if (!summary || !card) return json(ctx.res, 404, { error: "no such gate", gate, outcome: "gone" });
        return json(ctx.res, 200, {
            ...row(summary, card),
            actions: card.actions.map((a) => ({ id: a.id, label: a.tool, detail: a.args })),
            questions: card.questions,
        });
    });

    // the global answer: the gate id alone is the authority, so room and chat-less gates resolve
    // here without inventing a conversation for the path
    router.post("/api/approvals/:gate/answer", async (ctx: Ctx) => {
        const gate = ctx.param("gate");
        const body = await readBody(ctx.req);
        // action id → whether it was ticked
        const decisions = body["decisions"];
        const valid = typeof decisions === "object" && decisions !== null && !Array.isArray(decisions)
            && Object.values(decisions).every((v) => typeof v === "boolean");
        if (!valid) return json(ctx.res, 400, { error: "pass { decisions }" });
        if (core.approvals.describe(gate)?.kind === "question") {
            return json(ctx.res, 409, { error: "that gate is a question: POST its answers to /reply", gate });
        }
        if (!core.approvals.answer(gate, decisions as Record<string, boolean>)) {
            return json(ctx.res, 409, { error: "that gate is no longer open", gate, outcome: "gone" });
        }
        return json(ctx.res, 200, { ok: true });
    });

    // only a paired device speaks for the owner, never a request off the tunnel
    router.post("/api/approvals/:gate/reply", async (ctx: Ctx) => {
        if (!ctx.device) return json(ctx.res, 403, { error: "only a paired device answers for the owner" });
        const gate = ctx.param("gate");
        const body = await readBody(ctx.req);
        const dismiss = body["dismiss"];
        if (dismiss !== undefined && (dismiss !== true || body["answers"] !== undefined)) {
            return json(ctx.res, 400, { error: "pass { answers } or { dismiss: true }" });
        }
        const card = core.approvals.describe(gate);
        if (!card) return json(ctx.res, 409, { error: "that gate is no longer open", gate, outcome: "gone" });
        if (card.kind !== "question") return json(ctx.res, 409, { error: "that gate is an approval: POST { decisions } to /answer", gate });
        const answers = dismiss === true ? null : parseAnswers(card.questions, body["answers"]);
        if (typeof answers === "string") return json(ctx.res, 400, { error: answers });
        if (!core.approvals.reply(gate, answers)) {
            return json(ctx.res, 409, { error: "that gate is no longer open", gate, outcome: "gone" });
        }
        return json(ctx.res, 200, { ok: true });
    });
}
