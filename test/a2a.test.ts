/** runA2a driven directly against a stub peer: permission, connectivity and command checks, the write gate, the record. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { allPerms } from "@mimi-os/protocol";
import type { PinPerms, ResultPayload, ToolSchema } from "@mimi-os/protocol";

import { Admissions } from "../src/registry/admission.ts";
import { PeerError, type AgentPeer } from "../src/registry/peer.ts";
import { Registry } from "../src/registry/registry.ts";
import { EventHub } from "../src/events.ts";
import { Gates } from "../src/gates/gates.ts";
import { GatewayDb, type InteractionRow } from "../src/store/db.ts";
import { runA2a, type A2aRequest } from "../src/turn/a2a.ts";
import { TRUNCATION_MARKER } from "../src/turn/chain.ts";
import type { LoopDeps } from "../src/turn/loop-types.ts";

const CALLER = "boss";
const TARGET = "mate";

interface StubPeer {
    describe: { manifest: { a2a?: { commands: string[] } }; tools: ToolSchema[] };
    request: <T>(type: string, payload: unknown, opts?: { deadline?: number }) => Promise<T>;
}

function setup(): {
    deps: LoopDeps;
    db: GatewayDb;
    setTarget: (peer: StubPeer | null) => void;
    cleanup: () => void;
} {
    const dir = mkdtempSync(join(tmpdir(), "mimi-a2a-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    const admission = new Admissions(db);
    const events = new EventHub();
    const gates = new Gates();
    let target: StubPeer | null = null;
    const registry = {
        pin: (name: string) => admission.get(name),
        get: (name: string) => (name === TARGET && target ? (target as unknown as AgentPeer) : undefined),
        isPaused: (name: string) => db.isPaused(name),
    } as unknown as Registry;
    const deps: LoopDeps = {
        registry,
        sessions: {} as unknown as LoopDeps["sessions"],
        gates,
        db,
        events,
        log: () => undefined,
        startTurn: () => Promise.reject(new Error("no turn runs on this path")),
    };
    return {
        deps,
        db,
        setTarget: (p) => {
            target = p;
        },
        cleanup: () => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

const pin = (db: GatewayDb, name: string, perms: PinPerms): void => {
    db.createPin({ name, pubkey: `key-${name}`, fingerprint: `fp-${name}`, status: "approved", perms });
};

const request: A2aRequest["gateCtx"] = { agent: CALLER, session: null };

const call = (over: Partial<A2aRequest> = {}): A2aRequest => ({
    from: CALLER,
    target: TARGET,
    command: "read_thing",
    args: { q: "hi" },
    gateCtx: request,
    ...over,
});

const readTool: ToolSchema = {
    name: "read_thing",
    description: "Read something.",
    parameters: { type: "object", properties: { q: { type: "string" } } },
    writes: false,
};
const writeTool: ToolSchema = {
    name: "write_thing",
    description: "Write something.",
    parameters: { type: "object", properties: { v: { type: "string" } } },
    writes: true,
};

/** Full rows: the list leaves args and result to the detail read. */
function rowsOf(db: GatewayDb): InteractionRow[] {
    return db.listInteractions({ agent: CALLER, kind: "a2a" }).interactions.map((row) => db.getInteraction(row.id)!);
}

test("permission denial: caller has no pin at all", async () => {
    const { deps, cleanup } = setup();
    try {
        await assert.rejects(runA2a(deps, call()), (e: unknown) => {
            assert.ok(e instanceof PeerError);
            assert.equal(e.status, "denied");
            assert.match(e.message, /not approved/);
            return true;
        });
    } finally {
        cleanup();
    }
});

test("permission denial: caller approved but no delegate permission", async () => {
    const { deps, db, cleanup } = setup();
    try {
        pin(db, CALLER, { delegate: false, discoverable: true });
        await assert.rejects(runA2a(deps, call()), (e: unknown) => {
            assert.ok(e instanceof PeerError);
            assert.equal(e.status, "denied");
            assert.match(e.message, /delegate permission/);
            return true;
        });
    } finally {
        cleanup();
    }
});

test("permission denial: target not discoverable", async () => {
    const { deps, db, cleanup } = setup();
    try {
        pin(db, CALLER, allPerms());
        pin(db, TARGET, { delegate: true, discoverable: false });
        await assert.rejects(runA2a(deps, call()), (e: unknown) => {
            assert.ok(e instanceof PeerError);
            assert.equal(e.status, "denied");
            assert.match(e.message, /not discoverable/);
            return true;
        });
        assert.equal(rowsOf(db).length, 0, "a bare permission denial records nothing");
    } finally {
        cleanup();
    }
});

test("target not connected", async () => {
    const { deps, db, cleanup } = setup();
    try {
        pin(db, CALLER, allPerms());
        pin(db, TARGET, allPerms());
        // setTarget is never called: registry.get(TARGET) stays undefined
        await assert.rejects(runA2a(deps, call()), (e: unknown) => {
            assert.ok(e instanceof PeerError);
            assert.equal(e.status, "error");
            assert.match(e.message, /not connected/);
            return true;
        });
        assert.equal(rowsOf(db).length, 0);
    } finally {
        cleanup();
    }
});

test("unlisted command", async () => {
    const { deps, db, setTarget, cleanup } = setup();
    try {
        pin(db, CALLER, allPerms());
        pin(db, TARGET, allPerms());
        setTarget({
            describe: { manifest: { a2a: { commands: ["read_thing"] } }, tools: [readTool] },
            request: () => Promise.reject(new Error("must not be called")),
        });
        await assert.rejects(runA2a(deps, call({ command: "no_such_command" })), (e: unknown) => {
            assert.ok(e instanceof PeerError);
            assert.equal(e.status, "error");
            assert.match(e.message, /does not list an a2a command/);
            return true;
        });
        assert.equal(rowsOf(db).length, 0, "an unlisted command records nothing either");
    } finally {
        cleanup();
    }
});

test("a read command records sent → answered, args and a big result both capped at 256 KiB", async () => {
    const { deps, db, setTarget, cleanup } = setup();
    try {
        pin(db, CALLER, allPerms());
        pin(db, TARGET, allPerms());
        const bigArg = "x".repeat(300_000);
        const bigResult: ResultPayload = { text: "y".repeat(300_000) };
        setTarget({
            describe: { manifest: { a2a: { commands: ["read_thing"] } }, tools: [readTool] },
            request: (<T>() => Promise.resolve({ result: bigResult } as T)) as StubPeer["request"],
        });
        const result = await runA2a(deps, call({ args: { q: bigArg } }));
        assert.deepEqual(result, bigResult);

        const rows = rowsOf(db);
        assert.equal(rows.length, 1);
        const row = rows[0]!;
        assert.equal(row.command, "read_thing");
        assert.equal(row.status, "answered");
        assert.equal(typeof row.durationMs, "number");
        assert.ok(row.args, "args recorded");
        assert.ok(row.result, "result recorded");
        // the marker the app strips before pretty-printing — one constant, both ends
        assert.ok(row.args!.endsWith(TRUNCATION_MARKER), "args truncated");
        assert.ok(row.result!.endsWith(TRUNCATION_MARKER), "result truncated");
        assert.ok(Buffer.byteLength(row.args!, "utf8") <= 262_144);
        assert.ok(Buffer.byteLength(row.result!, "utf8") <= 262_144);
    } finally {
        cleanup();
    }
});

test("a capped a2a record never splits a four-byte UTF-8 code point", async () => {
    const { deps, db, setTarget, cleanup } = setup();
    try {
        pin(db, CALLER, allPerms());
        pin(db, TARGET, allPerms());
        const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
        const jsonPrefix = Buffer.byteLength('{"q":"', "utf8");
        const filler = "x".repeat(262_144 - markerBytes - jsonPrefix - 3);
        setTarget({
            describe: { manifest: { a2a: { commands: ["read_thing"] } }, tools: [readTool] },
            request: (<T>() => Promise.resolve({ result: { text: "ok" } } as T)) as StubPeer["request"],
        });

        await runA2a(deps, call({ args: { q: `${filler}😀${"more".repeat(10)}` } }));
        const row = rowsOf(db)[0]!;
        assert.ok(row.args!.endsWith(TRUNCATION_MARKER));
        assert.equal(row.args!.includes("\uFFFD"), false);
        assert.ok(Buffer.byteLength(row.args!, "utf8") <= 262_144);
    } finally {
        cleanup();
    }
});

test("a write command asks first: approved runs the invoke and ends answered", async () => {
    const { deps, db, setTarget, cleanup } = setup();
    try {
        pin(db, CALLER, allPerms());
        pin(db, TARGET, allPerms());
        setTarget({
            describe: { manifest: { a2a: { commands: ["write_thing"] } }, tools: [writeTool] },
            request: (<T>() => Promise.resolve({ result: { text: "done" } } as T)) as StubPeer["request"],
        });
        const pending = runA2a(deps, call({ command: "write_thing", args: { v: "1" } }));

        // the gate parks synchronously (the executor inside Gates.ask runs before the first await)
        const parked = deps.gates.pending();
        assert.equal(parked.length, 1);
        assert.equal(deps.gates.answer(parked[0]!.gate, { a1: true }), true);

        const result = await pending;
        assert.deepEqual(result, { text: "done" });
        const row = rowsOf(db)[0]!;
        assert.equal(row.status, "answered");
        assert.ok(row.gate);
    } finally {
        cleanup();
    }
});

test("writes → denied without approval: an error result, nothing invoked", async () => {
    const { deps, db, setTarget, cleanup } = setup();
    try {
        pin(db, CALLER, allPerms());
        pin(db, TARGET, allPerms());
        setTarget({
            describe: { manifest: { a2a: { commands: ["write_thing"] } }, tools: [writeTool] },
            request: () => Promise.reject(new Error("must not be invoked when denied")),
        });
        const pending = runA2a(deps, call({ command: "write_thing", args: { v: "1" } }));

        const parked = deps.gates.pending();
        assert.equal(parked.length, 1);
        assert.equal(deps.gates.answer(parked[0]!.gate, { a1: false }), true);

        await assert.rejects(pending, (e: unknown) => {
            assert.ok(e instanceof PeerError);
            assert.equal(e.status, "denied");
            assert.match(e.message, /denied/);
            return true;
        });

        const row = rowsOf(db)[0]!;
        assert.equal(row.status, "denied");
        assert.equal(typeof row.durationMs, "number");
        assert.equal(row.result, undefined);
    } finally {
        cleanup();
    }
});

test("the invoke itself failing is recorded failed, and the caller sees the underlying error", async () => {
    const { deps, db, setTarget, cleanup } = setup();
    try {
        pin(db, CALLER, allPerms());
        pin(db, TARGET, allPerms());
        setTarget({
            describe: { manifest: { a2a: { commands: ["read_thing"] } }, tools: [readTool] },
            request: () => Promise.reject(new Error("target blew up")),
        });
        await assert.rejects(runA2a(deps, call()), /target blew up/);
        const row = rowsOf(db)[0]!;
        assert.equal(row.status, "failed");
    } finally {
        cleanup();
    }
});

test("an agent cannot a2a itself — the reach list is every OTHER approved agent", async () => {
    const { deps, db, setTarget, cleanup } = setup();
    try {
        pin(db, CALLER, allPerms());
        setTarget({
            describe: { manifest: { a2a: { commands: ["read_thing"] } }, tools: [readTool] },
            request: () => Promise.reject(new Error("must not be called")),
        });
        await assert.rejects(runA2a(deps, call({ target: CALLER })), (e: unknown) => {
            assert.ok(e instanceof PeerError);
            assert.equal(e.status, "denied");
            assert.match(e.message, /cannot reach itself/);
            return true;
        });
    } finally {
        cleanup();
    }
});

test("a target answering a2a_invoke with a malformed result still records and returns a real result", async () => {
    const { deps, db, setTarget, cleanup } = setup();
    try {
        pin(db, CALLER, allPerms());
        pin(db, TARGET, allPerms());
        setTarget({
            describe: { manifest: { a2a: { commands: ["read_thing"] } }, tools: [readTool] },
            request: (<T>() => Promise.resolve({} as T)) as StubPeer["request"],
        });
        const result = await runA2a(deps, call());
        assert.deepEqual(result, { text: "" });
        const row = rowsOf(db)[0]!;
        assert.equal(row.status, "answered");
        assert.equal(row.result, '{"text":""}');
    } finally {
        cleanup();
    }
});

test("pause denies both ends: neither a paused caller nor a paused target runs a command", async () => {
    const { deps, db, setTarget, cleanup } = setup();
    try {
        pin(db, CALLER, allPerms());
        pin(db, TARGET, allPerms());
        setTarget({
            describe: { manifest: { a2a: { commands: ["read_thing"] } }, tools: [readTool] },
            request: () => Promise.reject(new Error("a paused end must never be reached")),
        });

        db.setPaused(TARGET, true);
        await assert.rejects(runA2a(deps, call()), (e: unknown) => {
            assert.ok(e instanceof PeerError);
            assert.equal(e.status, "denied");
            assert.match(e.message, /"mate" is paused/);
            return true;
        });

        db.setPaused(TARGET, false);
        db.setPaused(CALLER, true);
        await assert.rejects(runA2a(deps, call()), (e: unknown) => {
            assert.ok(e instanceof PeerError);
            assert.equal(e.status, "denied");
            assert.match(e.message, /"boss" is paused/);
            return true;
        });
        assert.equal(rowsOf(db).length, 0, "a paused end records nothing either");
    } finally {
        cleanup();
    }
});
