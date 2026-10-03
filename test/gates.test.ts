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
        assert.deepEqual(await result, { "call-1": true });
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
    assert.deepEqual(await result, { a1: false });
    const line = lines.find((l) => l.includes("expired"));
    assert.ok(line, "the expiry was logged");
    assert.equal(/[\p{Cc}\p{Cf}]/u.test(line.slice(0, -1)), false, "no ESC, CR or LF travels with the label");
    assert.match(line, /pay \[2J \[registry\]/);
});
