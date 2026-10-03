/** Agent avatars: the gateway re-derives type and hash from the bytes, stores only a real change, serves it, and keeps it until revoke. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgent } from "@mimi-os/sdk";
import { fakeAgentSocket, fakeIdentity } from "@mimi-os/sdk/testing";

import type { HubEvent } from "../src/events.ts";
import { boot, waitFor, type Env } from "./harness-env.ts";

const PNG = readFileSync(new URL("fixtures/avatar-agent/avatar.png", import.meta.url));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

interface Card {
    name: string;
    avatar: string | null;
}

const rosterAvatar = async (env: Env, name: string): Promise<string | null | undefined> =>
    (await env.api<Card[]>("GET", "/api/agents")).json.find((a) => a.name === name)?.avatar;

/** A raw agent past its first describe, and a describe sender that waits for the reply. */
async function rawAgent(env: Env, name: string) {
    const h = await env.connect({ name });
    await waitFor(() => env.core.agent(name).connected, 4000, `${name} ready`);
    let n = 0;
    const describe = async (avatar?: unknown): Promise<void> => {
        const id = `av${n++}`;
        h.send({ id, type: "describe", payload: { manifest: { name }, prompt: [], tools: [], avatar } });
        await waitFor(() => h.frames().some((f) => f["id"] === id), 4000, `the reply to ${id}`);
    };
    await describe();
    return { h, describe };
}

function changes(env: Env, name: string): () => number {
    const seen: HubEvent[] = [];
    env.core.events.subscribe((ev) => void seen.push(ev));
    return () => seen.filter((ev) => ev.type === "agent_changed" && ev["name"] === name).length;
}

test("avatar: a real SDK agent's file reaches the roster and the route, a replaced file swaps it, and it outlives the agent", async () => {
    const env = await boot();
    const dir = mkdtempSync(join(tmpdir(), "mimi-avatar-"));
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "notes" }));
    writeFileSync(join(dir, "avatar.png"), PNG);
    const identity = fakeIdentity();
    env.pin("notes", identity.pubkey);
    const agent = await runAgent({
        dir,
        url: `${env.ws}/channel`,
        socket: (url) => fakeAgentSocket(url, identity, env.core.devices.gatewayPub),
        log: () => undefined,
    });
    try {
        await waitFor(() => env.core.agent("notes").connected && agent.client.connected, 4000, "the agent registered");
        assert.equal(await rosterAvatar(env, "notes"), sha(PNG));
        const dashboard = await env.api<{ agents: Card[] }>("GET", "/api/dashboard");
        assert.equal(dashboard.json.agents.find((a) => a.name === "notes")?.avatar, sha(PNG));

        const served = await env.api("GET", `/api/agents/notes/avatar?v=${sha(PNG)}`);
        assert.equal(served.status, 200);
        assert.equal(served.headers.get("content-type"), "image/png");
        assert.equal(served.headers.get("x-content-type-options"), "nosniff");
        assert.equal(served.headers.get("cache-control"), "private, max-age=31536000, immutable");
        assert.deepEqual(Buffer.from(served.bytes), PNG);

        const changed = changes(env, "notes");
        const next = Buffer.concat([PNG, Buffer.from("edited")]);
        writeFileSync(join(dir, "avatar.png.tmp"), next);
        renameSync(join(dir, "avatar.png.tmp"), join(dir, "avatar.png"));
        await waitFor(() => env.core.agent("notes").avatar === sha(next), 4000, "the new hash");
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(changed(), 1, "one agent_changed for one new avatar");
        const stale = await env.api("GET", `/api/agents/notes/avatar?v=${sha(PNG)}`);
        assert.equal(stale.headers.get("cache-control"), "private, no-cache", "an old ?v= is not cached for good");
        assert.deepEqual(Buffer.from(stale.bytes), next);

        await agent.stop();
        await waitFor(() => !env.core.agent("notes").connected, 4000, "the agent gone");
        assert.equal(await rosterAvatar(env, "notes"), sha(next));
        assert.deepEqual(Buffer.from((await env.api("GET", "/api/agents/notes/avatar")).bytes), next);
    } finally {
        await agent.stop();
        await env.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("avatar: the same one twice is one write and one event, a change is a new hash, and a removed one is cleared", async (t) => {
    const env = await boot();
    try {
        const { describe } = await rawAgent(env, "raw");
        const writes = t.mock.method(env.db, "setAgentAvatar");
        const changed = changes(env, "raw");

        // the sent type and sha256 are lies: the gateway sniffs and hashes the bytes itself
        const lying = { type: "image/webp", sha256: "0".repeat(64), data: PNG.toString("base64") };
        await describe(lying);
        await describe(lying);
        assert.equal(writes.mock.callCount(), 1);
        assert.equal(changed(), 1);
        assert.equal(await rosterAvatar(env, "raw"), sha(PNG));
        const png = await env.api("GET", "/api/agents/raw/avatar");
        assert.equal(png.headers.get("content-type"), "image/png");
        assert.equal(png.headers.get("etag"), `"${sha(PNG)}"`);
        assert.equal((await env.api("GET", "/api/agents/raw/avatar", undefined, { "if-none-match": `"${sha(PNG)}"` })).status, 304);

        await describe({ type: "image/jpeg", sha256: sha(JPEG), data: JPEG.toString("base64") });
        assert.equal(writes.mock.callCount(), 2);
        assert.equal(changed(), 2);
        assert.equal(await rosterAvatar(env, "raw"), sha(JPEG));
        const jpeg = await env.api("GET", "/api/agents/raw/avatar");
        assert.equal(jpeg.headers.get("content-type"), "image/jpeg");
        assert.deepEqual(Buffer.from(jpeg.bytes), JPEG);

        await describe();
        assert.equal(writes.mock.callCount(), 3);
        assert.equal(changed(), 3);
        assert.equal(await rosterAvatar(env, "raw"), null);
        assert.equal((await env.api("GET", "/api/agents/raw/avatar")).status, 404);
        await describe();
        assert.equal(writes.mock.callCount(), 3, "no avatar twice writes nothing");
        assert.equal(changed(), 3);

        assert.equal((await env.api("GET", "/api/agents/ghost/avatar")).status, 404);
    } finally {
        await env.stop();
    }
});

test("avatar: an invalid one is dropped with its reason, never stored, and leaves the agent with none", async () => {
    const env = await boot();
    try {
        const { describe } = await rawAgent(env, "raw");
        const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(64 * 1024)]);
        // most of a 1 MiB frame, so the whole describe still arrives
        const huge = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(700 * 1024)]);
        const cases: Array<[unknown, string]> = [
            [{ data: Buffer.from("<svg onload='x()'/>").toString("base64") }, "not a PNG, WebP or JPEG image"],
            [{ data: Buffer.from("GIF89a....").toString("base64") }, "not a PNG, WebP or JPEG image"],
            [{ data: big.toString("base64") }, `${big.length} bytes, over the 65536-byte limit`],
            [{ data: huge.toString("base64") }, `${huge.length} bytes, over the 65536-byte limit`],
            [{ data: "iVBORw0K!!!" }, "data is not standard base64"],
            [{ type: "image/png" }, "no base64 data"],
            ["iVBORw0KGgo=", "no base64 data"],
        ];
        for (const [avatar, reason] of cases) {
            await describe({ data: PNG.toString("base64") });
            assert.equal(await rosterAvatar(env, "raw"), sha(PNG));
            await describe(avatar);
            const described = await env.api<{ dropped: Array<{ kind: string; reason: string }> }>("GET", "/api/agents/raw/describe");
            assert.deepEqual(described.json.dropped.filter((d) => d.kind === "avatar"), [{ kind: "avatar", reason }]);
            assert.equal(await rosterAvatar(env, "raw"), null, reason);
            assert.equal(env.db.getAgentAvatar("raw"), null);
        }
    } finally {
        await env.stop();
    }
});

test("avatar: revoking the pin takes the stored avatar with it", async () => {
    const env = await boot();
    try {
        const { describe } = await rawAgent(env, "raw");
        await describe({ data: PNG.toString("base64") });
        assert.equal((await env.api("GET", "/api/agents/raw/avatar")).status, 200);
        assert.equal((await env.api("DELETE", "/api/pins/raw")).status, 200);
        await waitFor(() => !env.core.agent("raw").connected, 4000, "the agent gone");
        assert.equal(env.db.getAgentAvatar("raw"), null);
        assert.equal((await env.api("GET", "/api/agents/raw/avatar")).status, 404);
        assert.equal(await rosterAvatar(env, "raw"), undefined);
    } finally {
        await env.stop();
    }
});

test("avatar: a change the re-describe rate limit held back is stored when the agent disconnects", async () => {
    const env = await boot();
    try {
        const { h, describe } = await rawAgent(env, "raw");
        const png = (n: number): Buffer => Buffer.concat([PNG, Buffer.from(`edit ${n}`)]);
        for (let n = 0; n < 25; n++) await describe({ data: png(n).toString("base64") });
        assert.notEqual(await rosterAvatar(env, "raw"), sha(png(24)), "past 20 a minute the db waits");
        h.close();
        await waitFor(() => !env.core.agent("raw").connected, 4000, "the agent gone");
        assert.equal(await rosterAvatar(env, "raw"), sha(png(24)));
        assert.deepEqual(Buffer.from((await env.api("GET", "/api/agents/raw/avatar")).bytes), png(24));
    } finally {
        await env.stop();
    }
});
