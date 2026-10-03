/** Agent avatars end to end and under attack: a fixture agent's files through a real SDK agent, the channel and the avatar route. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgent } from "@mimi-os/sdk";
import { fakeAgentSocket, fakeIdentity } from "@mimi-os/sdk/testing";

import type { HubEvent } from "../src/events.ts";
import { boot, waitFor, type Env } from "./harness-env.ts";

const FIXTURE = new URL("fixtures/avatar-agent/", import.meta.url);
const PNG = readFileSync(new URL("avatar.png", FIXTURE));
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A copy of the fixture agent (agent.json, prompt.md, avatar.png) running as a real SDK agent against `env`. */
async function startScout(env: Env, name = "scout") {
    const dir = mkdtempSync(join(tmpdir(), "mimi-avatar-e2e-"));
    const manifest = JSON.parse(readFileSync(new URL("agent.json", FIXTURE), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ ...manifest, name }));
    copyFileSync(new URL("prompt.md", FIXTURE), join(dir, "prompt.md"));
    copyFileSync(new URL("avatar.png", FIXTURE), join(dir, "avatar.png"));
    const identity = fakeIdentity();
    env.pin(name, identity.pubkey);
    const logs: string[] = [];
    const agent = await runAgent({
        dir,
        url: `${env.ws}/channel`,
        socket: (url) => fakeAgentSocket(url, identity, env.core.devices.gatewayPub),
        log: (line) => void logs.push(line),
    });
    await waitFor(() => env.core.agent(name).connected && agent.client.connected, 4000, `${name} registered`);
    const seen: HubEvent[] = [];
    env.core.events.subscribe((ev) => void seen.push(ev));
    const changed = (): number => seen.filter((ev) => ev.type === "agent_changed" && ev["name"] === name).length;
    const replace = (bytes: Uint8Array, file = "avatar.png"): void => {
        writeFileSync(join(dir, `${file}.tmp`), bytes);
        renameSync(join(dir, `${file}.tmp`), join(dir, file));
    };
    const cleanup = async (): Promise<void> => {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    };
    return { dir, agent, logs, changed, replace, cleanup };
}

test("avatar e2e: the fixture's avatar reaches the roster and the route; replaced, rewritten unchanged, deleted", async () => {
    const env = await boot();
    const p = await startScout(env);
    try {
        const roster = await env.api<Array<{ name: string; avatar: string | null }>>("GET", "/api/agents");
        assert.equal(roster.json.find((a) => a.name === "scout")?.avatar, sha(PNG));
        const served = await env.api("GET", `/api/agents/scout/avatar?v=${sha(PNG)}`);
        assert.equal(served.status, 200);
        assert.equal(served.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(served.bytes), PNG);

        const next = Buffer.concat([PNG, Buffer.from("v2")]);
        p.replace(next);
        await waitFor(() => env.core.agent("scout").avatar === sha(next), 3000, "the new hash");
        await settle();
        assert.equal(p.changed(), 1);
        assert.deepEqual(Buffer.from((await env.api("GET", `/api/agents/scout/avatar?v=${sha(next)}`)).bytes), next);

        writeFileSync(join(p.dir, "avatar.png"), next);
        await settle();
        assert.equal(p.changed(), 1, "the same bytes again announce nothing");

        unlinkSync(join(p.dir, "avatar.png"));
        await waitFor(() => env.core.agent("scout").avatar === null, 3000, "the avatar cleared");
        await settle();
        assert.equal(p.changed(), 2);
        assert.equal((await env.api("GET", "/api/agents/scout/avatar")).status, 404);
    } finally {
        await p.cleanup();
        await env.stop();
    }
});

test("avatar e2e: a burst of edits is debounced into one describe that carries the last file", async () => {
    const env = await boot();
    const p = await startScout(env);
    try {
        let last = PNG;
        for (let i = 0; i < 30; i++) {
            last = Buffer.concat([PNG, Buffer.from(`burst ${i}`)]);
            p.replace(last);
            await settle(10);
        }
        await waitFor(() => env.core.agent("scout").avatar === sha(last), 3000, "the last hash");
        await settle();
        assert.equal(p.changed(), 1);
    } finally {
        await p.cleanup();
        await env.stop();
    }
});

test("avatar e2e: hostile files", async () => {
    const env = await boot();
    const p = await startScout(env);
    const rows = (): string | null => env.core.agent("scout").avatar;
    try {
        // a PNG under the .jpg name is a PNG
        unlinkSync(join(p.dir, "avatar.png"));
        await waitFor(() => rows() === null, 3000, "cleared");
        p.replace(PNG, "avatar.jpg");
        await waitFor(() => rows() === sha(PNG), 3000, "png as jpg");
        assert.equal((await env.api("GET", "/api/agents/scout/avatar")).headers.get("content-type"), "image/png");
        unlinkSync(join(p.dir, "avatar.jpg"));
        await waitFor(() => rows() === null, 3000, "cleared");

        // an SVG named .png is refused
        p.replace(PNG);
        await waitFor(() => rows() === sha(PNG), 3000, "png back");
        p.replace(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`));
        await waitFor(() => rows() === null, 3000, "svg refused");

        // 64 KiB + 1
        p.replace(PNG);
        await waitFor(() => rows() === sha(PNG), 3000, "png back");
        p.replace(Buffer.concat([PNG, Buffer.alloc(64 * 1024 + 1 - PNG.length)]));
        await waitFor(() => rows() === null, 3000, "oversize refused");

        // a polyglot: PNG magic, HTML body; served only as image/png with nosniff
        const polyglot = Buffer.concat([PNG.subarray(0, 8), Buffer.from("<html><script>alert(document.domain)</script></html>")]);
        p.replace(polyglot);
        await waitFor(() => rows() === sha(polyglot), 3000, "polyglot stored");
        const served = await env.api("GET", "/api/agents/scout/avatar");
        assert.equal(served.headers.get("content-type"), "image/png");
        assert.equal(served.headers.get("x-content-type-options"), "nosniff");
        assert.deepEqual(Buffer.from(served.bytes), polyglot);

        // a symlink out of the agent folder is never read: the agent sends none, so the stored one is cleared
        const outside = mkdtempSync(join(tmpdir(), "mimi-avatar-outside-"));
        writeFileSync(join(outside, "private.png"), Buffer.concat([PNG, Buffer.from("outside")]));
        symlinkSync(join(outside, "private.png"), join(p.dir, ".avatar.tmp"));
        renameSync(join(p.dir, ".avatar.tmp"), join(p.dir, "avatar.png"));
        await waitFor(() => rows() === null, 3000, "the outside file refused");
        assert.match(p.logs.join(""), /resolves to .*private\.png, outside the agent folder/);
        rmSync(outside, { recursive: true, force: true });
    } finally {
        await p.cleanup();
        await env.stop();
    }
});

test("avatar e2e: two agents with the same image", async () => {
    const env = await boot();
    const a = await startScout(env, "one");
    const b = await startScout(env, "two");
    try {
        assert.equal(env.core.agent("one").avatar, sha(PNG));
        assert.equal(env.core.agent("two").avatar, sha(PNG));
        unlinkSync(join(a.dir, "avatar.png"));
        await waitFor(() => env.core.agent("one").avatar === null, 3000, "one cleared");
        assert.equal(env.core.agent("two").avatar, sha(PNG));
        assert.deepEqual(Buffer.from((await env.api("GET", "/api/agents/two/avatar")).bytes), PNG);
    } finally {
        await a.cleanup();
        await b.cleanup();
        await env.stop();
    }
});
