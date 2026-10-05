import assert from "node:assert/strict";
import test from "node:test";

import { Gates } from "../src/gates/gates.ts";

test("a throwing approval observer cannot strand its gate", async () => {
    const stderr = process.stderr;
    const write = stderr.write;
    const diagnostics: string[] = [];
    stderr.write = ((chunk: unknown) => {
        diagnostics.push(String(chunk));
        return true;
    }) as typeof stderr.write;
    const gates = new Gates({
        log: () => {
            throw new Error("broken logger");
        },
        onPark: () => {
            throw new Error("disconnected device");
        },
        onResolve: () => {
            throw new Error("disconnected device");
        },
    });
    try {
        const result = gates.ask(
            {
                agent: "toto",
                session: null,
                emit: () => {
                    throw new Error("disconnected listener");
                },
            },
            [{ id: "call-1", tool: "write", args: {} }],
        );

        const gate = gates.pending()[0];
        assert.ok(gate);
        assert.equal(gates.answer(gate.gate, { "call-1": true }), true);
        assert.equal(gates.answer(gate.gate, { "call-1": true }), false, "a gate settles exactly once");
        assert.deepEqual(await result, { decisions: { "call-1": true }, outcome: "approved" });
        assert.deepEqual(gates.pending(), []);
        assert.ok(diagnostics.some((line) => line.includes("logger failed: broken logger")));
    } finally {
        stderr.write = write;
    }
});

test("an expiring gate writes no agent-chosen control characters into the log", async () => {
    const lines: string[] = [];
    const gates = new Gates({ log: (msg) => void lines.push(msg) });
    // a ctx deadline already past expires the gate at once — the same ceiling a mid-invoke ask gets
    const result = gates.ask({ agent: "toto", session: null, deadline: Date.now() - 1 }, [
        { id: "a1", tool: "pay\u001b[2J\n[registry] finance: ready", args: {} },
    ]);
    assert.deepEqual(await result, { decisions: { a1: false }, outcome: "expired" });
    const line = lines.find((l) => l.includes("expired"));
    assert.ok(line, "the expiry was logged");
    assert.equal(/[\p{Cc}\p{Cf}]/u.test(line.slice(0, -1)), false, "no ESC, CR or LF travels with the label");
    assert.match(line, /pay \[2J \[registry\]/);
});

test("the chat's approval_resolved says how the gate ended: an expiry or a cancel never reads as a Deny", async () => {
    const resolved: Array<{ outcome: string; actions: number }> = [];
    const gates = new Gates({ onResolve: (g) => void resolved.push({ outcome: g.outcome, actions: g.actions }) });
    const ended = async (settle: (gate: string) => void, deadline?: number): Promise<Record<string, unknown> | undefined> => {
        const emitted: Record<string, unknown>[] = [];
        const verdict = gates.ask({ agent: "toto", session: 3, deadline, emit: (ev) => void emitted.push(ev) }, [
            { id: "w1", tool: "add_event", args: {} },
            { id: "w2", tool: "add_event", args: {} },
        ]);
        const gate = gates.pending()[0]?.gate;
        if (gate) settle(gate);
        assert.equal((await verdict).outcome, emitted.at(-1)?.["outcome"], "the model and the page hear the same ending");
        return emitted.at(-1);
    };

    const expired = await ended(() => undefined, Date.now() - 1);
    assert.deepEqual(expired, { type: "approval_resolved", gate: expired?.["gate"], outcome: "expired", decisions: { w1: false, w2: false } });
    assert.equal((await ended(() => gates.cancel("toto")))?.["outcome"], "gone");
    assert.equal((await ended((g) => gates.answer(g, {})))?.["outcome"], "denied");
    const partial = await ended((g) => gates.answer(g, { w1: true }));
    assert.equal(partial?.["outcome"], "approved");
    assert.deepEqual(partial?.["decisions"], { w1: true, w2: false });
    assert.deepEqual(resolved, [
        { outcome: "expired", actions: 2 },
        { outcome: "gone", actions: 2 },
        { outcome: "denied", actions: 2 },
        { outcome: "approved", actions: 2 },
    ]);
});
