// agent_changed, usage_changed, room_changed and the sweep's device_revoked, without a live agent socket
import "./pq-home.ts";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { allPerms, noPerms } from "@mimi-os/protocol";

import { createGatewayCore } from "../src/core.ts";
import { EventHub, type HubEvent } from "../src/events.ts";
import { buildRouter } from "../src/http/index.ts";
import { DeviceService } from "../src/registry/devices.ts";
import { Registry } from "../src/registry/registry.ts";
import { newCallId, recordLlmCall, setUsageRecordedHook } from "../src/store/accounting.ts";
import { GatewayDb } from "../src/store/db.ts";

function freshDb(): { db: GatewayDb; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "mimi-events-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    return {
        db,
        cleanup: () => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

const approvedPin = (db: GatewayDb, name: string, perms = allPerms()): void => {
    db.createPin({ name, pubkey: `key-${name}`, fingerprint: `fp-${name}`, status: "approved", perms });
};

test("blocking a pin emits agent_changed once; a no-op block emits nothing", () => {
    const { db, cleanup } = freshDb();
    try {
        const events = new EventHub();
        const registry = new Registry({ db, events });
        approvedPin(db, "dana");

        const seen: HubEvent[] = [];
        events.subscribe((ev) => void seen.push(ev));

        assert.equal(registry.block("ghost"), null); // no such pin: no card, no event
        const card = registry.block("dana");
        assert.equal(card?.status, "blocked");

        assert.deepEqual(seen, [{ type: "agent_changed", name: "dana" }]);
    } finally {
        cleanup();
    }
});

test("changing a pin's perms emits agent_changed", () => {
    const { db, cleanup } = freshDb();
    try {
        const events = new EventHub();
        const registry = new Registry({ db, events });
        approvedPin(db, "dana", noPerms());

        const seen: HubEvent[] = [];
        events.subscribe((ev) => void seen.push(ev));

        const card = registry.setPerms("dana", allPerms());
        assert.deepEqual(card?.perms, allPerms());
        assert.deepEqual(seen, [{ type: "agent_changed", name: "dana" }]);
    } finally {
        cleanup();
    }
});

test("approving a blocked pin and revoking it each emit agent_changed", () => {
    const { db, cleanup } = freshDb();
    try {
        const events = new EventHub();
        const registry = new Registry({ db, events });
        db.createPin({ name: "dana", pubkey: "key-dana", fingerprint: "fp-dana", status: "blocked", perms: noPerms() });

        const seen: HubEvent[] = [];
        events.subscribe((ev) => void seen.push(ev));

        assert.ok(registry.approve("dana"));
        assert.ok(registry.revoke("dana"));

        assert.deepEqual(seen, [
            { type: "agent_changed", name: "dana" },
            { type: "agent_changed", name: "dana" },
        ]);
    } finally {
        cleanup();
    }
});

test("pausing and resuming an agent emits agent_changed", () => {
    const { db, cleanup } = freshDb();
    try {
        const events = new EventHub();
        const registry = new Registry({ db, events });

        const seen: HubEvent[] = [];
        events.subscribe((ev) => void seen.push(ev));

        registry.setPaused("dana", true);
        registry.setPaused("dana", false);

        assert.deepEqual(seen, [
            { type: "agent_changed", name: "dana" },
            { type: "agent_changed", name: "dana" },
        ]);
    } finally {
        cleanup();
    }
});

test("recording an LLM call emits usage_changed for its agent, from the one chokepoint", () => {
    const { db, cleanup } = freshDb();
    try {
        const events = new EventHub();
        setUsageRecordedHook(db, (agent) => events.emit({ type: "usage_changed", agent }));
        const seen: HubEvent[] = [];
        events.subscribe((ev) => void seen.push(ev));

        recordLlmCall({ agent: "dana", scope: "dana:chat", callId: newCallId(), callKind: "oneshot", raw: {} }, db);
        recordLlmCall({ agent: "rex", scope: "rex:chat", callId: newCallId(), callKind: "turn", raw: {} }, db);

        assert.deepEqual(seen, [
            { type: "usage_changed", agent: "dana" },
            { type: "usage_changed", agent: "rex" },
        ]);
    } finally {
        setUsageRecordedHook(db, null);
        cleanup();
    }
});

test("joining and leaving a room's participants each emit room_changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mimi-events-room-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    const core = createGatewayCore({ db, log: () => undefined });
    const router = buildRouter(core);
    const server = createServer((req, res) => void router.dispatch(req, res).catch(() => res.destroy()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${addr.port}`;

    try {
        approvedPin(db, "dana");

        const created = await fetch(`${base}/api/rooms`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        });
        assert.equal(created.status, 201);
        const room = ((await created.json()) as { room: { id: string } }).room.id;

        const seen: HubEvent[] = [];
        const off = core.events.subscribe((ev) => void seen.push(ev));
        assert.ok(off);

        const joined = await fetch(`${base}/api/rooms/${room}/participants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "dana" }),
        });
        assert.equal(joined.status, 200);

        // joining twice is not a change: no second event
        const rejoined = await fetch(`${base}/api/rooms/${room}/participants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "dana" }),
        });
        assert.equal(rejoined.status, 200);

        const left = await fetch(`${base}/api/rooms/${room}/participants/dana`, { method: "DELETE" });
        assert.equal(left.status, 200);
        off();

        assert.deepEqual(seen, [
            { type: "room_changed", room },
            { type: "room_changed", room },
        ]);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await core.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("sweeping a never-approved enrollment emits device_revoked for it", () => {
    const { db, cleanup } = freshDb();
    const events = new EventHub();
    const devices = new DeviceService(db, events, () => undefined, { inactiveTtlMs: 0, now: () => Date.now() + 5_000 });
    try {
        assert.ok(db.createDevice({ id: "0123456789abcdef", pubkey: "cHVi", name: "phone", sas: "123456" }));
        const seen: HubEvent[] = [];
        events.subscribe((ev) => void seen.push(ev));

        devices.sweep();

        assert.equal(db.getDevice("0123456789abcdef"), null);
        assert.deepEqual(seen, [{ type: "device_revoked", id: "0123456789abcdef" }]);
    } finally {
        devices.stop();
        cleanup();
    }
});
