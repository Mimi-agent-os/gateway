/** Device registry storage: enrollment uniqueness, sweeps, and the idempotent-mutation ladder of runDeviceOp. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GatewayDb } from "../src/store/db.ts";
import type { DeviceOpOutcome } from "../src/store/db.ts";

function openDb(): { db: GatewayDb; stop: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "mimi-devreg-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    return {
        db,
        stop: () => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

const FUTURE = Date.now() + 3_600_000;

test("enrollment: pubkey is unique forever, revoked included", () => {
    const { db, stop } = openDb();
    try {
        assert.equal(db.createDevice({ id: "d1", pubkey: "PK1", name: "phone", sas: "123456" }), true);
        const row = db.getDevice("d1");
        assert.ok(row);
        assert.equal(row.status, "inactive");
        assert.equal(row.maxSeq, 0);
        assert.equal(row.epoch, null);
        assert.equal(row.activatedAt, null);
        assert.equal(row.lastSeen, null);
        assert.equal(db.deviceByPubkey("PK1")?.id, "d1");

        assert.equal(db.createDevice({ id: "d2", pubkey: "PK1", name: "thief", sas: "654321" }), false);
        assert.equal(db.getDevice("d2"), null);

        assert.equal(db.revokeDevice("d1"), true);
        assert.equal(db.createDevice({ id: "d3", pubkey: "PK1", name: "again", sas: "111111" }), false);
        assert.equal(db.getDevice("d3"), null);

        assert.equal(db.createDevice({ id: "d4", pubkey: "PK2", name: "tablet", sas: "222222" }), true);
        assert.deepEqual(
            db.listDevices().map((d) => d.id),
            ["d4", "d1"],
        );
    } finally {
        stop();
    }
});

test("sweep deletes only stale inactive rows and returns their ids", () => {
    const { db, stop } = openDb();
    try {
        db.createDevice({ id: "stale", pubkey: "PK1", name: "a", sas: "111111" });
        db.createDevice({ id: "approved", pubkey: "PK2", name: "b", sas: "222222" });
        db.activateDevice("approved");
        db.createDevice({ id: "denied", pubkey: "PK3", name: "c", sas: "333333" });
        db.revokeDevice("denied");

        assert.deepEqual(db.sweepInactiveDevices(7_200_000, FUTURE), []);
        assert.deepEqual(db.sweepInactiveDevices(1_000, FUTURE), ["stale"]);
        assert.equal(db.getDevice("stale"), null);
        assert.equal(db.getDevice("approved")?.status, "active");
        assert.equal(db.getDevice("denied")?.status, "revoked");
        assert.deepEqual(db.sweepInactiveDevices(0, FUTURE), []);
    } finally {
        stop();
    }
});

test("runDeviceOp: the full ladder", () => {
    const { db, stop } = openDb();
    try {
        db.createDevice({ id: "d1", pubkey: "PK1", name: "phone", sas: "123456" });
        db.setDeviceEpoch("d1", "e1");
        let runs = 0;
        const exec = (): Record<string, unknown> => {
            runs += 1;
            return { created: "room-42" };
        };

        const first = db.runDeviceOp("d1", "e1", 1, "room_create", "h1", exec);
        assert.deepEqual(first, { status: "executed", result: { created: "room-42" } });
        assert.equal(runs, 1);
        assert.equal(db.getDevice("d1")?.maxSeq, 1);

        const replay = db.runDeviceOp("d1", "e1", 1, "room_create", "h1", exec);
        assert.deepEqual(replay, { status: "replay", result: { created: "room-42" } });
        assert.equal(runs, 1);

        assert.deepEqual(db.runDeviceOp("d1", "e1", 1, "room_create", "OTHER", exec), {
            status: "conflict",
        });
        assert.deepEqual(db.runDeviceOp("d1", "e1", 3, "room_create", "h3", exec), {
            status: "out_of_order",
        });
        assert.deepEqual(db.runDeviceOp("d1", "eX", 2, "room_create", "h2", exec), {
            status: "wrong_epoch",
        });
        assert.equal(runs, 1);
        assert.equal(db.getDevice("d1")?.maxSeq, 1);
    } finally {
        stop();
    }
});

test("runDeviceOp: swept outcome replays as expired_executed", () => {
    const { db, stop } = openDb();
    try {
        db.createDevice({ id: "d1", pubkey: "PK1", name: "phone", sas: "123456" });
        db.setDeviceEpoch("d1", "e1");
        db.runDeviceOp("d1", "e1", 1, "op", "h1", () => ({ ok: true }));

        assert.equal(db.sweepDeviceOps(7_200_000, FUTURE), 0);
        assert.equal(db.sweepDeviceOps(1_000, FUTURE), 1);
        const out = db.runDeviceOp("d1", "e1", 1, "op", "h1", () => ({ ok: true }));
        assert.deepEqual(out, { status: "expired_executed" });
        assert.equal(db.getDevice("d1")?.maxSeq, 1);
    } finally {
        stop();
    }
});

test("runDeviceOp: a throwing exec rolls everything back", () => {
    const { db, stop } = openDb();
    try {
        db.createDevice({ id: "d1", pubkey: "PK1", name: "phone", sas: "123456" });
        db.setDeviceEpoch("d1", "e1");
        db.runDeviceOp("d1", "e1", 1, "op", "h1", () => ({ ok: true }));

        assert.throws(
            () =>
                db.runDeviceOp("d1", "e1", 2, "op", "h2", () => {
                    throw new Error("boom");
                }),
            /boom/,
        );
        assert.equal(db.getDevice("d1")?.maxSeq, 1);

        // no op row survived the rollback: seq 2 executes fresh, even under another hash
        const retry: DeviceOpOutcome = db.runDeviceOp("d1", "e1", 2, "op", "h2b", () => ({ ok: 2 }));
        assert.deepEqual(retry, { status: "executed", result: { ok: 2 } });
        assert.equal(db.getDevice("d1")?.maxSeq, 2);
    } finally {
        stop();
    }
});

test("runDeviceOp: two devices count independently", () => {
    const { db, stop } = openDb();
    try {
        db.createDevice({ id: "a", pubkey: "PKA", name: "a", sas: "111111" });
        db.createDevice({ id: "b", pubkey: "PKB", name: "b", sas: "222222" });
        db.setDeviceEpoch("a", "ea");
        db.setDeviceEpoch("b", "eb");

        assert.equal(db.runDeviceOp("a", "ea", 1, "op", "h1", () => ({ d: "a" })).status, "executed");
        assert.equal(db.runDeviceOp("b", "eb", 1, "op", "h1", () => ({ d: "b" })).status, "executed");
        assert.equal(db.runDeviceOp("a", "ea", 2, "op", "h2", () => ({ d: "a" })).status, "executed");
        assert.equal(db.getDevice("a")?.maxSeq, 2);
        assert.equal(db.getDevice("b")?.maxSeq, 1);

        const replay = db.runDeviceOp("b", "eb", 1, "op", "h1", () => ({ d: "never" }));
        assert.deepEqual(replay, { status: "replay", result: { d: "b" } });
    } finally {
        stop();
    }
});
