/** The store's own guarantees: owner-only files, a usage rollup that survives a lying provider, bounded jars and inbox, the revoke cascade. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { allPerms } from "@mimi-os/protocol";

import { newCallId, recordLlmCall } from "../src/store/accounting.ts";
import { gatewayDb, GatewayDb } from "../src/store/db.ts";
import { localDay } from "../src/store/day.ts";
import { checkEnv, setEnv, unsetEnv } from "../src/store/env.ts";
import { envFile, keysFile, writeAtomic } from "../src/store/home.ts";

const mode = (path: string): number => statSync(path).mode & 0o777;

function freshDb(): { db: GatewayDb; dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "mimi-store-"));
    const db = new GatewayDb(join(dir, "home", "gateway.db"));
    return {
        db,
        dir,
        cleanup: () => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

test("the home it creates is 0700 and gateway.db (with its WAL siblings) is 0600", () => {
    const { db, dir, cleanup } = freshDb();
    try {
        const file = join(dir, "home", "gateway.db");
        assert.equal(mode(dirname(file)), 0o700);
        for (const f of [file, `${file}-wal`, `${file}-shm`]) {
            if (existsSync(f)) assert.equal(mode(f), 0o600, f);
        }
        assert.ok(existsSync(`${file}-wal`), "WAL is on, so the sibling the owner never names exists");
        db.setSetting("k", "v");
        assert.equal(mode(file), 0o600);
    } finally {
        cleanup();
    }
});

test("writeAtomic writes owner-only by default, keeps an existing mode unless told one, and writes through a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "mimi-store-"));
    try {
        const fresh = join(dir, "secret");
        writeAtomic(fresh, "value\n");
        assert.equal(mode(fresh), 0o600);

        const kept = join(dir, "kept");
        writeFileSync(kept, "old\n");
        chmodSync(kept, 0o640);
        writeAtomic(kept, "new\n");
        assert.equal(mode(kept), 0o640);
        writeAtomic(kept, "newer\n", 0o600);
        assert.equal(mode(kept), 0o600);

        const target = join(dir, "secret-target");
        const link = join(dir, ".linked-token");
        writeFileSync(target, "old\n");
        symlinkSync(target, link);
        writeAtomic(link, "new\n", 0o600);
        assert.equal(lstatSync(link).isSymbolicLink(), true);
        assert.equal(readFileSync(target, "utf8"), "new\n");
        assert.equal(mode(target), 0o600);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test(".env and .env.keys stay owner-only through every write path", () => {
    rmSync(envFile(), { force: true });
    rmSync(keysFile(), { force: true });

    assert.deepEqual(checkEnv(), { created: true });
    assert.ok(existsSync(keysFile()), "dotenvx provisioned the keypair");
    assert.equal(mode(keysFile()), 0o600);
    assert.equal(mode(envFile()), 0o600);

    chmodSync(envFile(), 0o644);
    assert.deepEqual(checkEnv(), { created: false });
    assert.equal(mode(envFile()), 0o600);

    chmodSync(envFile(), 0o644);
    chmodSync(keysFile(), 0o644);
    assert.deepEqual(setEnv("STORE_TEST_KEY", "value"), { ok: true });
    assert.equal(mode(keysFile()), 0o600);
    assert.equal(mode(envFile()), 0o600);

    chmodSync(envFile(), 0o644);
    assert.equal(unsetEnv("STORE_TEST_KEY"), true);
    assert.equal(mode(envFile()), 0o600);
});

test("closing a cached database releases it so the path can be opened again", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "mimi-db-reopen-"));
    let reopened: GatewayDb | undefined;
    t.after(() => {
        reopened?.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, "gateway.db");
    const first = gatewayDb(path);
    first.setSetting("marker", "saved");
    first.close();
    reopened = gatewayDb(path);
    assert.notEqual(reopened, first);
    assert.equal(reopened.getSetting("marker"), "saved");
});

test("the daily rollup clamps provider-reported counts instead of losing or poisoning the day", () => {
    const { db, cleanup } = freshDb();
    const day = localDay();
    try {
        for (const [agent, prompt] of [
            ["nan", Number.NaN],
            ["text", "many" as unknown as number],
            ["huge", Number.POSITIVE_INFINITY],
            ["negative", -5],
        ] as const) {
            db.bumpUsageDaily(day, { agent, model: "m", modelUid: null, registryModel: null, promptTokens: prompt, completionTokens: 5, estimated: false });
            const [spent] = db.usageMatrix(day, agent);
            assert.equal(spent?.calls, 1, `${agent} was counted`);
            assert.equal(spent?.totalTokens, 5, `${agent} spent only what was readable`);
        }
        // a provider that reports numbers as strings still pays for them
        const stringly = "1500" as unknown as number;
        db.bumpUsageDaily(day, { agent: "stringly", model: "m", modelUid: null, registryModel: null, promptTokens: stringly, completionTokens: "20" as unknown as number, estimated: false });
        assert.equal(db.spendByAgent(day).get("stringly")?.tokens, 1520);
    } finally {
        cleanup();
    }
});

test("a call whose usage is not a number is still charged for the numbers that are", () => {
    const { db, cleanup } = freshDb();
    const day = localDay();
    try {
        recordLlmCall(
            {
                agent: "worker",
                scope: "worker",
                callId: newCallId(),
                callKind: "turn",
                usage: { promptTokens: Number.NaN, completionTokens: 5, totalTokens: Number.NaN, cachedTokens: 0 },
                raw: {},
            },
            db,
            day,
        );
        const [spent] = db.usageMatrix(day, "worker");
        assert.deepEqual([spent?.calls, spent?.totalTokens], [1, 5]);
    } finally {
        cleanup();
    }
});

test("prices and the daily limit persist on the model row, apart from its base settings", () => {
    const { db, dir, cleanup } = freshDb();
    try {
        db.insertModel({ name: "m", provider: "llamacpp", endpoint: "http://127.0.0.1:1", modelId: null, contextTokens: 1000, vision: false, params: {} });
        const fresh = db.getModel("m")!;
        assert.deepEqual([fresh.priceInPerM, fresh.priceOutPerM, fresh.limit], [0, 0, null], "free and unlimited until the owner says otherwise");

        db.setModelPricing("m", { priceInPerM: 0.5, priceOutPerM: 1.25, limit: { unit: "usd", value: 3 } });
        db.updateModel("m", { provider: "llamacpp", endpoint: "http://127.0.0.1:2", modelId: null, contextTokens: 2000, vision: false, params: {} });
        const reopened = new GatewayDb(join(dir, "home", "gateway.db"));
        try {
            const row = reopened.getModel("m")!;
            assert.deepEqual([row.priceInPerM, row.priceOutPerM, row.limit], [0.5, 1.25, { unit: "usd", value: 3 }], "a base-settings edit keeps the pricing");
            assert.equal(row.contextTokens, 2000);
        } finally {
            reopened.close();
        }
        db.setModelPricing("m", { priceInPerM: 0.5, priceOutPerM: 1.25, limit: null });
        assert.equal(db.getModel("m")!.limit, null);
        assert.throws(() => db.setModelPricing("gone", { priceInPerM: 0, priceOutPerM: 0, limit: null }), /no model "gone"/);
    } finally {
        cleanup();
    }
});

test("the call lookup behind message association runs on its index", (t) => {
    const { db, dir, cleanup } = freshDb();
    t.after(cleanup);
    db.insertLlmCall({ agent: "worker", scope: "worker", callId: "call-1", raw: {} });
    db.setLlmCallMessages("call-1", [1, 2]);
    assert.deepEqual(db.listLlmCalls()[0]?.messageSeqs, [1, 2]);
    const raw = new DatabaseSync(join(dir, "home", "gateway.db"), { readOnly: true });
    try {
        const plan = raw.prepare("EXPLAIN QUERY PLAN UPDATE llm_calls SET message_seqs = ? WHERE call_id = ?").all("[]", "call-1");
        assert.ok(plan.some((row) => String(row["detail"]).includes("idx_llm_calls_call")));
    } finally {
        raw.close();
    }
});

test("the app cookie jar keeps the newest rows per app and drops the rest", () => {
    const { db, cleanup } = freshDb();
    try {
        for (let n = 0; n < 15; n++) {
            db.setAppCookie("shop", "shop-app", { name: `c${n}`, value: "v", path: "/", expiresAt: null }, 10);
            db.setAppCookie("shop", "other-app", { name: `o${n}`, value: "v", path: "/", expiresAt: null }, 10);
        }
        const jar = db.appCookiesFor("shop", "shop-app", "/").map((c) => c.name);
        assert.equal(jar.length, 10);
        assert.deepEqual(
            jar.sort(),
            Array.from({ length: 10 }, (_, i) => `c${i + 5}`).sort(),
        );
        // the cap is per app, not per agent
        assert.equal(db.appCookiesFor("shop", "other-app", "/").length, 10);
    } finally {
        cleanup();
    }
});

test("unread inbox items are capped per sender, and one flood spares every other sender", () => {
    const { db, cleanup } = freshDb();
    try {
        const quiet = db.insertInboxItem({ source: "agent", agent: "quiet", title: "one" }, 1000, 3).id;
        const system = db.insertInboxItem({ source: "system", title: "device waiting" }, 1000, 3).id;
        const loud: number[] = [];
        for (let n = 0; n < 6; n++) {
            loud.push(db.insertInboxItem({ source: "agent", agent: "loud", title: `n${n}` }, 1000, 3).id);
        }
        assert.deepEqual(
            loud.filter((id) => db.getInboxItem(id) !== null),
            loud.slice(-3),
        );
        assert.ok(db.getInboxItem(quiet), "another agent's unread item survives the flood");
        assert.ok(db.getInboxItem(system), "a gateway item survives the flood");
    } finally {
        cleanup();
    }
});

test("the unread cap never evicts an action item, and action items do not use up the cap", () => {
    const { db, cleanup } = freshDb();
    try {
        const action = db.insertInboxItem({ source: "agent", agent: "loud", title: "approve the payout", level: "action" }, 1000, 3).id;
        const infos: number[] = [];
        for (let n = 0; n < 6; n++) {
            infos.push(db.insertInboxItem({ source: "agent", agent: "loud", title: `n${n}`, level: n % 2 ? "warn" : "info" }, 1000, 3).id);
        }
        const later = db.insertInboxItem({ source: "agent", agent: "loud", title: "sign here", level: "action" }, 1000, 3).id;
        infos.push(db.insertInboxItem({ source: "agent", agent: "loud", title: "n6" }, 1000, 3).id);

        assert.ok(db.getInboxItem(action), "the oldest unread item survives because it waits on the owner");
        assert.ok(db.getInboxItem(later));
        assert.deepEqual(
            infos.filter((id) => db.getInboxItem(id) !== null),
            infos.slice(-3),
            "the cap still holds three info/warn items besides the action ones",
        );
    } finally {
        cleanup();
    }
});

test("unread action items have a cap of their own: a sender's oldest go first, and nobody else's", () => {
    const { db, cleanup } = freshDb();
    try {
        const file = (agent: string | null, title: string, level: "info" | "action" = "action"): number =>
            db.insertInboxItem({ source: agent === null ? "system" : "agent", agent, title, level }, 1000, 3).id;
        const quiet = file("quiet", "another sender's");
        const system = file(null, "device waiting");
        const loud = ["a0", "a1", "a2", "a3", "a4"].map((t) => file("loud", t));
        const alive = (ids: number[]): number[] => ids.filter((id) => db.getInboxItem(id) !== null);
        assert.deepEqual(alive(loud), loud.slice(-3), "a flood of action items keeps only its newest three");

        for (let n = 0; n < 6; n++) file("loud", `n${n}`, "info");
        assert.deepEqual(alive(loud), loud.slice(-3), "an info flood evicts none of them");
        assert.equal(db.countUnread(), 3 + 3 + 2, "every sender stays bounded");
        assert.deepEqual(alive([quiet, system]), [quiet, system]);
    } finally {
        cleanup();
    }
});

test("revoking a pin takes the agent's registry row, its app, its cookie jar and its device grants with it", () => {
    const { db, cleanup } = freshDb();
    try {
        for (const agent of ["shop", "mall"]) {
            db.createPin({ name: agent, pubkey: `key-${agent}`, fingerprint: `fp-${agent}`, status: "approved", perms: allPerms() });
            db.upsertAgentApp({ agent, appId: `${agent}-app`, title: agent, upstream: "http://127.0.0.1:9/" });
            db.setAppCookie(agent, `${agent}-app`, { name: "sid", value: "secret", path: "/", expiresAt: null });
            db.setDeviceAppGrant("device-1", `${agent}-app`, "hash");
            db.upsertAgentRegistry(agent, { manifest: { name: agent }, tools: [] });
        }

        assert.equal(db.deletePin("shop"), true);
        assert.equal(db.getPin("shop"), null);
        assert.equal(db.getAgentRegistry("shop"), null, "no stored describe outlives the pin");
        assert.equal(db.getAgentAppById("shop-app"), null);
        assert.deepEqual(db.appCookiesFor("shop", "shop-app", "/"), []);
        assert.equal(db.getDeviceAppGrant("device-1", "shop-app"), null);

        assert.ok(db.getAgentRegistry("mall"));
        assert.ok(db.getAgentAppById("mall-app"), "the other agent's app is untouched");
        assert.equal(db.appCookiesFor("mall", "mall-app", "/").length, 1);
        assert.ok(db.getDeviceAppGrant("device-1", "mall-app"));
    } finally {
        cleanup();
    }
});
