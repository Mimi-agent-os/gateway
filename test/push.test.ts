/** Phone push: the FCM key at boot, the JWT bearer flow, the request FCM receives, who gets one and how
 *  often, dead tokens, the device's own token routes, and the events that wake it, a question included. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pairDevice } from "../src/device-client.ts";
import { buildRouter } from "../src/http/index.ts";
import { fcmAccount, Push } from "../src/push.ts";
import { GatewayDb } from "../src/store/db.ts";
import { activeDevice, boot, callTurn, textTurn, waitFor } from "./harness-env.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://fcm.googleapis.com/v1/projects/mimi-test-1/messages:send";
const CLIENT_EMAIL = "push@mimi-test-1.iam.gserviceaccount.com";

const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
});
const KEY_JSON = JSON.stringify({
    type: "service_account",
    project_id: "mimi-test-1",
    private_key_id: "0123abcd",
    private_key: keys.privateKey,
    client_email: CLIENT_EMAIL,
    token_uri: TOKEN_URL,
});
const account = fcmAccount(KEY_JSON)!;

type Reply = [status: number, body: unknown];

/** Google's two endpoints: every token request mints access-<n>; sends answer `replies` in order, then 200. */
function google(replies: Reply[] = []) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let minted = 0;
    const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        calls.push({ url: String(input), init: init ?? {} });
        if (String(input) === TOKEN_URL) {
            minted += 1;
            return Response.json({ access_token: `access-${minted}`, expires_in: 3600, token_type: "Bearer" });
        }
        const [status, body] = replies.shift() ?? [200, { name: "projects/mimi-test-1/messages/1" }];
        return Response.json(body, { status });
    };
    return {
        fetch: fake as typeof fetch,
        mints: () => calls.filter((c) => c.url === TOKEN_URL),
        sends: () => calls.filter((c) => c.url !== TOKEN_URL),
    };
}

const sentTo = (call: { init: RequestInit }): string => (JSON.parse(String(call.init.body)) as { message: { token: string } }).message.token;

/** A fresh gateway.db with these active devices, each holding the token named after it. */
function withDevices(ids: string[]): { db: GatewayDb; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "mimi-push-"));
    const db = new GatewayDb(join(dir, "gateway.db"));
    for (const id of ids) {
        db.createDevice({ id, pubkey: `PK-${id}`, name: id, sas: "123456" });
        db.activateDevice(id);
        db.setDevicePush(id, `token-${id}`);
    }
    return {
        db,
        cleanup: () => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

test("FCM_SERVICE_ACCOUNT_KEY: unset is off, a key file parses, and every malformed key is refused without being quoted", () => {
    assert.equal(fcmAccount(undefined), undefined);
    assert.equal(fcmAccount("  "), undefined);
    assert.equal(account.projectId, "mimi-test-1");
    assert.equal(account.clientEmail, CLIENT_EMAIL);
    assert.equal(account.privateKey.asymmetricKeyType, "rsa");

    const parsed = JSON.parse(KEY_JSON) as Record<string, unknown>;
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
    const cases: Array<[string, RegExp]> = [
        [`{"private_key": "${"S3CR3T".repeat(4)}"`, /is not a JSON object/],
        ['["S3CR3T"]', /is not a JSON object/],
        [JSON.stringify({ ...parsed, project_id: "../S3CR3T" }), /no valid project_id/],
        [JSON.stringify({ ...parsed, client_email: undefined }), /no valid client_email/],
        [JSON.stringify({ ...parsed, private_key: "-----BEGIN PRIVATE KEY-----\nS3CR3T\n-----END PRIVATE KEY-----\n" }), /no RSA private_key in PEM/],
        [JSON.stringify({ ...parsed, private_key: ec }), /no RSA private_key in PEM/],
    ];
    for (const [raw, why] of cases) {
        assert.throws(() => fcmAccount(raw), (e: Error) => {
            assert.match(e.message, why);
            assert.match(e.message, /remove it to turn push off/);
            assert.doesNotMatch(e.message, /S3CR3T|BEGIN/);
            assert.equal(e.cause, undefined);
            return true;
        });
    }
});

test("the JWT: RS256 over Google's claims, verifying with the account's public key", async () => {
    const { db, cleanup } = withDevices(["phone"]);
    try {
        const g = google();
        const now = 1_800_000_000_500;
        await new Push(db, () => undefined, () => false, { account, fetch: g.fetch, now: () => now }).wake();
        const mint = g.mints()[0]!;
        assert.equal(mint.init.method, "POST");
        assert.deepEqual(mint.init.headers, { "content-type": "application/x-www-form-urlencoded" });
        const form = mint.init.body as URLSearchParams;
        assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
        const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
        assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
        assert.deepEqual(JSON.parse(Buffer.from(claims!, "base64url").toString()), {
            iss: CLIENT_EMAIL,
            scope: "https://www.googleapis.com/auth/firebase.messaging",
            aud: TOKEN_URL,
            iat: 1_800_000_000,
            exp: 1_800_003_600,
        });
        assert.equal(verify("sha256", Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature!, "base64url")), true);
        const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
        assert.equal(verify("sha256", Buffer.from(`${header}.${claims}`), other, Buffer.from(signature!, "base64url")), false);
    } finally {
        cleanup();
    }
});

test("the exact request FCM receives: the fixed words, the collapse key, the tag, high priority, no content", async () => {
    const { db, cleanup } = withDevices(["phone"]);
    try {
        const g = google();
        await new Push(db, () => undefined, () => false, { account, fetch: g.fetch }).wake();
        const [send] = g.sends();
        assert.equal(send?.url, SEND_URL);
        assert.equal(send.init.method, "POST");
        assert.deepEqual(send.init.headers, { authorization: "Bearer access-1", "content-type": "application/json" });
        assert.ok(send.init.signal instanceof AbortSignal);
        assert.deepEqual(JSON.parse(String(send.init.body)), {
            message: {
                token: "token-phone",
                notification: { title: "mimi", body: "Something needs you. Open the app for more." },
                android: { collapse_key: "mimi", priority: "high", notification: { tag: "mimi" } },
            },
        });
    } finally {
        cleanup();
    }
});

test("the access token is reused until five minutes before it expires, and a 401 drops it for a fresh one", async () => {
    const { db, cleanup } = withDevices(["phone"]);
    try {
        db.createDevice({ id: "tablet", pubkey: "PK-tablet", name: "tablet", sas: "123456" });
        db.activateDevice("tablet");
        const g = google([[200, {}], [200, {}], [200, {}], [401, { error: { code: 401, status: "UNAUTHENTICATED" } }]]);
        let now = 1_800_000_000_000;
        const push = new Push(db, () => undefined, () => false, { account, fetch: g.fetch, now: () => now });
        await push.wake();
        now += 3600_000 - 5 * 60_000 - 1;
        await push.wake();
        assert.equal(g.mints().length, 1, "five minutes and a millisecond to go");
        // the phone is inside its 30 s window, so only the tablet sends at the margin
        db.setDevicePush("tablet", "token-tablet");
        now += 1;
        await push.wake();
        assert.equal(g.mints().length, 2, "minted again at the margin");
        db.deleteDevicePush("tablet");
        now += 30_000;
        await push.wake();
        assert.equal(g.mints().length, 3);
        assert.deepEqual(
            g.sends().map((c) => (c.init.headers as Record<string, string>)["authorization"]),
            ["Bearer access-1", "Bearer access-1", "Bearer access-2", "Bearer access-2", "Bearer access-3"],
        );
        assert.deepEqual(g.sends().map(sentTo), ["token-phone", "token-phone", "token-tablet", "token-phone", "token-phone"]);
    } finally {
        cleanup();
    }
});

test("only a device with a token and no live session gets a push, and two sends share one mint", async () => {
    const { db, cleanup } = withDevices(["laptop", "phone", "tablet"]);
    try {
        db.createDevice({ id: "watch", pubkey: "PK-watch", name: "watch", sas: "123456" });
        db.activateDevice("watch");
        const g = google();
        await new Push(db, () => undefined, (id) => id === "laptop", { account, fetch: g.fetch }).wake();
        assert.deepEqual(g.sends().map(sentTo).sort(), ["token-phone", "token-tablet"]);
        assert.equal(g.mints().length, 1);
    } finally {
        cleanup();
    }
});

test("one push per device per 30 seconds", async () => {
    const { db, cleanup } = withDevices(["phone"]);
    try {
        const g = google();
        let now = 1_800_000_000_000;
        const push = new Push(db, () => undefined, () => false, { account, fetch: g.fetch, now: () => now });
        await Promise.all([push.wake(), push.wake()]);
        now += 29_999;
        await push.wake();
        assert.equal(g.sends().length, 1);
        now += 1;
        await push.wake();
        assert.equal(g.sends().length, 2);
    } finally {
        cleanup();
    }
});

test("a token FCM no longer takes is deleted; any other failure keeps it and never reaches the event", async () => {
    const fcmError = (status: number, code: string, details: unknown[]): Reply => [status, { error: { code: status, status: code, details } }];
    const cases: Array<[Reply, boolean]> = [
        [fcmError(404, "NOT_FOUND", [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }]), true],
        [fcmError(400, "INVALID_ARGUMENT", [{ errorCode: "UNREGISTERED" }]), true],
        [
            fcmError(400, "INVALID_ARGUMENT", [
                { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" },
            ]),
            true,
        ],
        [
            fcmError(400, "INVALID_ARGUMENT", [
                { errorCode: "INVALID_ARGUMENT" },
                { fieldViolations: [{ field: "message.token", description: "Invalid registration token" }] },
            ]),
            true,
        ],
        [[404, "<html>not found</html>"], false],
        [fcmError(400, "INVALID_ARGUMENT", [{ fieldViolations: [{ field: "message.android.priority" }] }]), false],
        [fcmError(403, "PERMISSION_DENIED", [{ errorCode: "SENDER_ID_MISMATCH" }]), false],
        [[503, "<html>unavailable</html>"], false],
    ];
    for (const [reply, gone] of cases) {
        const { db, cleanup } = withDevices(["phone"]);
        try {
            const logs: string[] = [];
            const g = google([reply]);
            await new Push(db, (m) => void logs.push(m), () => false, { account, fetch: g.fetch }).wake();
            assert.deepEqual(db.listDevicePush(), gone ? [] : [{ device: "phone", token: "token-phone" }], JSON.stringify(reply));
            assert.equal(logs.length, 1);
            assert.match(logs[0]!, gone ? /\[push\] device phone: FCM no longer takes its token/ : /\[push\] device phone: FCM answered \d+/);
            assert.doesNotMatch(logs.join(""), /token-phone|access-1/);
        } finally {
            cleanup();
        }
    }

    const { db, cleanup } = withDevices(["phone"]);
    try {
        const logs: string[] = [];
        const down = (): Promise<Response> => Promise.reject(new TypeError("fetch failed"));
        await new Push(db, (m) => void logs.push(m), () => false, { account, fetch: down as typeof fetch }).wake();
        assert.deepEqual(logs, ["[push] device phone: fetch failed\n"]);
        assert.equal(db.listDevicePush().length, 1);
    } finally {
        cleanup();
    }
});

test("without an account push is off: nothing is sent", async () => {
    const { db, cleanup } = withDevices(["phone"]);
    try {
        const g = google();
        await new Push(db, () => undefined, () => false, { fetch: g.fetch }).wake();
        assert.equal(g.sends().length + g.mints().length, 0);
        assert.equal(db.listDevicePush().length, 1);
    } finally {
        cleanup();
    }
});

test("store: a revoked or removed device takes its token along, and a stale delete spares a newer token", () => {
    const { db, cleanup } = withDevices(["phone", "tablet"]);
    try {
        db.deleteDevicePush("phone", "token-old");
        assert.equal(db.listDevicePush().length, 2);
        db.revokeDevice("phone");
        assert.deepEqual(db.listDevicePush(), [{ device: "tablet", token: "token-tablet" }]);

        db.createDevice({ id: "pad", pubkey: "PK-pad", name: "pad", sas: "123456" });
        db.setDevicePush("pad", "token-pad");
        assert.deepEqual(db.sweepInactiveDevices(0, Date.now() + 2000), ["pad"]);
        assert.deepEqual(db.listDevicePush(), [{ device: "tablet", token: "token-tablet" }]);
        assert.throws(() => db.setDevicePush("ghost", "token-ghost"), /FOREIGN KEY/);
    } finally {
        cleanup();
    }
});

test("routes: a device stores, replaces and deletes its own token; a bad token is a 400; no device identity is a 403", async () => {
    const env = await boot();
    try {
        const { id } = await env.device();
        assert.deepEqual((await env.api("PUT", "/api/devices/me/push", { token: "abc:APA91b-x_1" })).json, { ok: true });
        assert.deepEqual(env.db.listDevicePush(), [{ device: id, token: "abc:APA91b-x_1" }]);
        assert.equal((await env.api("PUT", "/api/devices/me/push", { token: "def:APA91b" })).status, 200);
        assert.deepEqual(env.db.listDevicePush(), [{ device: id, token: "def:APA91b" }]);

        for (const token of [undefined, "", 42, "has space", "a/b", "x".repeat(1025)]) {
            const bad = await env.api<{ error: string }>("PUT", "/api/devices/me/push", { token });
            assert.equal(bad.status, 400, String(token));
            assert.equal(bad.json.error, "token must be an FCM registration token");
        }
        assert.equal(env.db.listDevicePush()[0]?.token, "def:APA91b");

        assert.deepEqual((await env.api("DELETE", "/api/devices/me/push")).json, { ok: true });
        assert.deepEqual(env.db.listDevicePush(), []);

        const phone = await activeDevice(env, "phone");
        env.db.setDevicePush(phone.id, "token-phone");
        assert.equal((await env.api("POST", `/api/devices/${phone.id}/revoke`)).status, 200);
        assert.deepEqual(env.db.listDevicePush(), []);

        const router = buildRouter(env.core);
        for (const method of ["PUT", "DELETE"]) {
            let status = 0;
            const res = { writeHead: (code: number) => void (status = code), end: () => undefined } as unknown as ServerResponse;
            const req = { method, url: "/api/devices/me/push" } as unknown as IncomingMessage;
            assert.equal(await router.dispatch(req, res, null), true);
            assert.equal(status, 403, method);
        }
    } finally {
        await env.stop();
    }
});

test("a chat reply, an agent's notice, a gate and a device asking in each push only to the paired device that is offline", async () => {
    const g = google();
    let now = 1_800_000_000_000;
    const env = await boot({ push: { account, fetch: g.fetch, now: () => now } });
    try {
        assert.equal((await env.api("PUT", "/api/devices/me/push", { token: "token-online" })).status, 200);
        const phone = await activeDevice(env, "phone");
        env.db.setDevicePush(phone.id, "token-phone");
        const h = await env.connect({ name: "toto" });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");

        env.model.nextTurn(textTurn("done"));
        await env.core.runTurn({ agent: "toto", session: h.createSession(), text: "hello", title: false });
        await waitFor(() => g.sends().length === 1, 4000, "the reply's push");

        now += 30_000;
        h.send({ id: "n1", type: "notify", payload: { title: "Digest ready" } });
        await waitFor(() => g.sends().length === 2, 4000, "the notice's push");

        now += 30_000;
        h.send({ id: "k1", type: "ask_approve", payload: { label: "wire 40 EUR" } });
        await waitFor(() => g.sends().length === 3, 4000, "the gate's push");

        now += 30_000;
        const invite = await env.api<{ uri: string }>("POST", "/api/devices/invite");
        await pairDevice(env.ws, invite.json.uri, crypto.getRandomValues(new Uint8Array(32)), "tablet");
        await waitFor(() => g.sends().length === 4, 4000, "the new device's push");

        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(g.sends().map(sentTo), Array(4).fill("token-phone"), "one push per event, never to the live device");
    } finally {
        await env.stop();
    }
});

test("a question parked by ask_owner pushes to the offline phone like an approval does", async () => {
    const g = google();
    const env = await boot({ push: { account, fetch: g.fetch, now: () => 1_800_000_000_000 } });
    try {
        assert.equal((await env.api("PUT", "/api/devices/me/push", { token: "token-online" })).status, 200);
        const phone = await activeDevice(env, "phone");
        env.db.setDevicePush(phone.id, "token-phone");
        const h = await env.connect({ name: "toto" });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(g.sends().length, 0, "nothing waited on the owner yet");

        const args = JSON.stringify({ questions: [{ question: "Go?", options: [{ label: "Yes" }, { label: "No" }] }] });
        env.model.nextTurn(callTurn([{ id: "q1", name: "ask_owner", args }]));
        env.model.nextTurn(textTurn("went"));
        const turn = env.core.runTurn({ agent: "toto", session: h.createSession(), text: "ask me", attended: true, title: false });
        await waitFor(() => g.sends().length === 1, 4000, "the question's push");
        const waiting = env.core.approvals.pending()[0];
        assert.equal(waiting?.tool, "ask_owner", "pushed while the question waits");
        assert.deepEqual(g.sends().map(sentTo), ["token-phone"]);
        env.core.approvals.reply(waiting.gate, [{ selected: ["Yes"] }]);
        await turn;
    } finally {
        await env.stop();
    }
});

test("a ready session silent for a minute counts as offline: a frozen app still gets the push", async () => {
    const g = google();
    let now = Date.now();
    const env = await boot({ devices: { now: () => now }, push: { account, fetch: g.fetch, now: () => now } });
    try {
        assert.equal((await env.api("PUT", "/api/devices/me/push", { token: "token-quiet" })).status, 200);
        now += 59_999;
        env.core.events.emit({ type: "approval" });
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(g.sends().length, 0, "heard from a millisecond inside the minute");

        now += 1;
        env.core.events.emit({ type: "approval" });
        await waitFor(() => g.sends().length === 1, 4000, "the silent device's push");
        assert.equal(sentTo(g.sends()[0]!), "token-quiet");

        assert.equal((await env.api("GET", "/api/devices")).status, 200);
        now += 30_000;
        env.core.events.emit({ type: "approval" });
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(g.sends().length, 1, "heard again, so online again");
        assert.equal(env.core.devices.list().find((d) => d.name === "harness")?.connected, true);
    } finally {
        await env.stop();
    }
});
