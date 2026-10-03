import "./pq-home.ts";

/** src/http/listeners.ts: the loopback surface (mini-app door, health, local bootstrap) and the channel upgrade gate both listeners share. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { networkInterfaces } from "node:os";

import { noPerms, parseInviteUri } from "@mimi-os/protocol";

import { channelUpgradeHandler, notFound, reachableAddresses } from "../src/http/listeners.ts";
import { home } from "../src/store/home.ts";
import { boot, waitFor } from "./harness-env.ts";

/** A source module as an import specifier a child process can evaluate. */
const quotedHref = (rel: string): string => JSON.stringify(pathToFileURL(resolve(import.meta.dirname, rel)).href);

const REFUSED_UPGRADE = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found";

function raw(port: number, text: string): Promise<string> {
    return new Promise((done, fail) => {
        const socket = connect(port, "127.0.0.1");
        let got = "";
        socket.on("connect", () => socket.write(text));
        socket.on("data", (c: Buffer) => (got += String(c)));
        socket.on("close", () => done(got));
        socket.on("error", fail);
        setTimeout(() => socket.destroy(), 1500).unref();
    });
}

const upgrade = (target: string, extra = ""): string =>
    `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;

interface Rig {
    port: number;
    seen: string[];
    close: () => Promise<void>;
}

/** channelUpgradeHandler needs no GatewayCore — a bare accept/refuse callback is enough to test
 *  its own gating (path, origin, and a declining handler) in isolation. */
async function rig(accept: (req: IncomingMessage, duplex: Duplex, head: Buffer) => boolean): Promise<Rig> {
    const seen: string[] = [];
    const server: Server = createServer((_req, res) => {
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const port = (server.address() as AddressInfo).port;
    server.on(
        "upgrade",
        channelUpgradeHandler((req, duplex, head) => {
            seen.push(req.url ?? "");
            return accept(req, duplex, head);
        }),
    );
    return {
        port,
        seen,
        close: () =>
            new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => done());
            }),
    };
}

const respondOk = (_req: IncomingMessage, duplex: Duplex): boolean => {
    duplex.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    return true;
};

interface Child {
    port: number;
    exited: Promise<{ code: number | null; out: string }>;
    kill: () => void;
}

/** An isolated process is the only honest way to assert that a rude peer does not take the server
 *  down: `body` must print its listening port on stdout as the first line. */
async function childServer(body: string, cwd: string): Promise<Child> {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", body], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let head = "";
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
        head += String(c);
        out += String(c);
    });
    child.stderr?.on("data", (c: Buffer) => (out += String(c)));
    const exited = new Promise<{ code: number | null; out: string }>((done) => {
        child.once("exit", (code) => done({ code, out }));
    });
    const port = await new Promise<number>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`the child never reported a port: ${out}`)), 10_000).unref();
        child.stdout?.on("data", () => {
            const first = /^(\d+)\n/.exec(head);
            if (first === null) return;
            clearTimeout(timer);
            done(Number(first[1]));
        });
        child.once("exit", () => fail(new Error(`the child exited before listening: ${out}`)));
    });
    return { port, exited, kill: () => void child.kill("SIGKILL") };
}

test("notFound: the one 404 shape a refused plain-HTTP path answers", async () => {
    const server = createServer(notFound);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    try {
        const port = (server.address() as AddressInfo).port;
        const body = await raw(port, "GET /anything HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        assert.match(body, /^HTTP\/1\.1 404 Not Found\r\n/);
        assert.match(body, /content-type: text\/plain/i);
        assert.match(body, /cache-control: no-store/i);
        assert.ok(body.endsWith("Not Found"));
    } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
    }
});

test("channelUpgradeHandler: only /channel and /channel/pair are delegated, byte-identical refusal otherwise", async () => {
    const r = await rig(respondOk);
    try {
        for (const target of ["/agent", "/", "/channelx", "/channel/pair/extra", "/channel/x"]) {
            assert.equal(await raw(r.port, upgrade(target)), REFUSED_UPGRADE, target);
        }
        assert.deepEqual(r.seen, []);

        assert.match(await raw(r.port, upgrade("/channel")), /^HTTP\/1\.1 101 /);
        assert.match(await raw(r.port, upgrade("/channel/pair?invite=x")), /^HTTP\/1\.1 101 /);
        assert.deepEqual(r.seen, ["/channel", "/channel/pair?invite=x"]);
    } finally {
        await r.close();
    }
});

test("channelUpgradeHandler: the channel is not origin-gated — Noise is the gate", async () => {
    const r = await rig(respondOk);
    try {
        // any Origin (or none) reaches the handler: authentication is the enrolled key or the
        // invite secret inside the Noise handshake, and pre-auth slots are bounded per address
        for (const extra of ["", `Origin: http://evil.example\r\n`, `Origin: http://127.0.0.1:${r.port}\r\n`]) {
            assert.match(await raw(r.port, upgrade("/channel", extra)), /^HTTP\/1\.1 101 /);
            assert.match(await raw(r.port, upgrade("/channel/pair", extra)), /^HTTP\/1\.1 101 /);
        }
        assert.equal(r.seen.length, 6);
    } finally {
        await r.close();
    }
});

test("channelUpgradeHandler: a handler that declines an allowed path gets the same refusal", async () => {
    const r = await rig(() => false);
    try {
        assert.equal(await raw(r.port, upgrade("/channel")), REFUSED_UPGRADE);
        assert.deepEqual(r.seen, ["/channel"]);
    } finally {
        await r.close();
    }
});

test("channelUpgradeHandler: non-origin-form request targets are refused identically", async () => {
    const r = await rig(respondOk);
    try {
        for (const target of ["http://127.0.0.1/channel", "*", "//channel"]) {
            assert.equal(await raw(r.port, upgrade(target)), REFUSED_UPGRADE, target);
        }
        // node's own parser 400s a bare path before any listener runs
        for (const target of ["channel", "?/channel"]) {
            assert.doesNotMatch(await raw(r.port, upgrade(target)), /^HTTP\/1\.1 101 /);
        }
        assert.deepEqual(r.seen, []);
    } finally {
        await r.close();
    }
});

test("channelUpgradeHandler: a peer that resets the connection during the refusal does not kill the process", async () => {
    const child = await childServer(
        `import { createServer } from "node:http";
         import { channelUpgradeHandler } from ${quotedHref("../src/http/listeners.ts")};
         const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
         const refuse = channelUpgradeHandler(() => false);
         server.on("upgrade", (req, socket, head) => {
             socket.on("close", () => { server.closeAllConnections(); server.close(); });
             refuse(req, socket, head);
         });
         server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));`,
        process.cwd(),
    );
    const socket = connect(child.port, "127.0.0.1", () => {
        socket.write(upgrade("/nope"));
        socket.resetAndDestroy();
    });
    socket.on("error", () => undefined);
    const { code, out } = await child.exited;
    assert.equal(code, 0, out);
});

test("loopbackHandler: a request target http accepts but `new URL` rejects is the one 404, not a crash", async () => {
    const env = await boot();
    try {
        const res = await fetch(`${env.base}//%`);
        assert.equal(res.status, 404);
        assert.equal(await res.text(), "Not Found");
        assert.equal((await fetch(`${env.base}/api/health`)).status, 200);
    } finally {
        await env.stop();
    }
});

test("loopbackHandler: GET /api/health answers, everything else is the one 404", async () => {
    const env = await boot();
    try {
        // the gateway serves no web UI: "/" and "/app/" are refused like any other path
        assert.equal((await fetch(`${env.base}/`, { redirect: "manual" })).status, 404);
        assert.equal((await fetch(`${env.base}/app/`)).status, 404);

        const health = await fetch(`${env.base}/api/health`);
        assert.equal(health.status, 200);
        assert.equal(((await health.json()) as { ok: boolean }).ok, true);

        for (const path of ["/api/agents", "/local/invite", "/app-not-real", "/channel"]) {
            assert.equal((await fetch(`${env.base}${path}`)).status, 404, path);
        }
    } finally {
        await env.stop();
    }
});

test("loopbackHandler: a request addressed to any other Host is the one 404 (DNS rebinding)", async () => {
    const env = await boot();
    try {
        const request = (method: string, path: string, host: string, extra = ""): Promise<string> =>
            raw(env.port, `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
        for (const host of [`127.0.0.1:${env.port}`, `localhost:${env.port}`, `[::1]:${env.port}`]) {
            assert.match(await request("GET", "/api/health", host), /^HTTP\/1\.1 200/, host);
        }
        const bearer = `Authorization: Bearer ${env.localToken}\r\n`;
        for (const host of [`rebind.evil.example:${env.port}`, `127.0.0.1:${env.port + 1}`, "127.0.0.1", ""]) {
            const health = await request("GET", "/api/health", host);
            assert.match(health, /^HTTP\/1\.1 404/, host);
            assert.ok(health.endsWith("Not Found"), host);
            assert.doesNotMatch(health, /channelId/, host);
            assert.match(await request("POST", "/local/invite", host, bearer), /^HTTP\/1\.1 404/, host);
        }
        // an absolute-form target names its own origin, whatever the Host says
        const here = `127.0.0.1:${env.port}`;
        assert.match(await request("GET", `http://rebind.evil.example:${env.port}/api/health`, here), /^HTTP\/1\.1 404/);
        assert.match(await request("POST", `http://rebind.evil.example:${env.port}/local/invite`, here, bearer), /^HTTP\/1\.1 404/);
        assert.match(await request("GET", `http://${here}/api/health`, here), /^HTTP\/1\.1 200/);
        assert.match(await request("POST", "/local/invite", `localhost:${env.port}`, bearer), /^HTTP\/1\.1 200/);
    } finally {
        await env.stop();
    }
});

test("loopbackHandler: POST /local/invite needs the boot's bearer token, and mints a device invite", async () => {
    const env = await boot();
    try {
        assert.equal((await fetch(`${env.base}/local/invite`, { method: "POST" })).status, 404);
        assert.equal(
            (await fetch(`${env.base}/local/invite`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status,
            404,
        );

        const res = await fetch(`${env.base}/local/invite`, {
            method: "POST",
            headers: { authorization: `Bearer ${env.localToken}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { uri: string };
        assert.match(body.uri, /^mimi:\/\/pair\/v2\?/);
    } finally {
        await env.stop();
    }
});

test("loopbackHandler: POST /local/pins/:agent/block|unblock is the kill switch no pult is needed for, behind the same token", async () => {
    const env = await boot();
    try {
        const h = await env.connect({ name: "toto" });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");
        const post = (path: string, token = env.localToken): Promise<Response> =>
            fetch(`${env.base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });

        assert.equal((await post("/local/pins/toto/block", "wrong")).status, 404);
        assert.equal((await post("/local/pins/Not%20A%20Name/block")).status, 404);
        assert.equal(env.db.getPin("toto")?.status, "approved", "a refused call changes nothing");

        const blocked = await post("/local/pins/toto/block");
        assert.equal(blocked.status, 200);
        assert.deepEqual(await blocked.json(), { name: "toto", status: "blocked", closed: 1 });
        await waitFor(() => !h.socketOpen(), 4000, "the agent's socket dropped");
        assert.equal(env.db.getPin("toto")?.status, "blocked");
        assert.equal((await post("/local/pins/nobody/block")).status, 404);

        const unblocked = await post("/local/pins/toto/unblock");
        assert.equal(unblocked.status, 200);
        assert.deepEqual(await unblocked.json(), { name: "toto", status: "approved" });
        assert.deepEqual(env.db.getPin("toto")?.perms, noPerms(), "back in, granted nothing");
        assert.equal((await post("/local/pins/toto/unblock")).status, 409);
    } finally {
        await env.stop();
    }
});

test("reachableAddresses: the LAN listener's addresses, Tailscale named as such, then loopback", () => {
    const at = (lan?: string) => reachableAddresses({ host: "127.0.0.1", port: 46464, lan });
    const loopback = { url: "http://127.0.0.1:46464", kind: "loopback" };
    assert.deepEqual(at(), [loopback]);
    assert.deepEqual(at("100.101.1.2"), [{ url: "http://100.101.1.2:46464", kind: "tailscale" }, loopback]);
    assert.deepEqual(at("100.128.0.1"), [{ url: "http://100.128.0.1:46464", kind: "lan" }, loopback]);
    assert.deepEqual(at("192.168.1.5"), [{ url: "http://192.168.1.5:46464", kind: "lan" }, loopback]);
    assert.deepEqual(at("fd7a:115c:a1e0::5"), [{ url: "http://[fd7a:115c:a1e0::5]:46464", kind: "tailscale" }, loopback]);
    // a zoned link-local address has no URL form a link could carry
    assert.deepEqual(at("fe80::1%en0"), [loopback]);
    assert.deepEqual(reachableAddresses({ host: "::1", port: 7, lan: undefined }), [{ url: "http://[::1]:7", kind: "loopback" }]);
    // the link carries the canonical origin, so a named host or port 80 is rewritten, never dropped
    assert.deepEqual(at("Box.Local"), [{ url: "http://box.local:46464", kind: "lan" }, loopback]);
    assert.deepEqual(reachableAddresses({ host: "127.0.0.1", port: 80, lan: "192.168.1.5" }), [
        { url: "http://192.168.1.5", kind: "lan" },
        { url: "http://127.0.0.1", kind: "loopback" },
    ]);
    // the owner's MIMI_PUBLIC_URL leads: the address the app dials from elsewhere
    assert.deepEqual(reachableAddresses({ host: "127.0.0.1", port: 46464, publicUrl: "https://mimi.example.com:8443" }), [
        { url: "https://mimi.example.com:8443", kind: "public" },
        loopback,
    ]);

    const v4 = Object.values(networkInterfaces()).flatMap((l) => l ?? []).filter((i) => !i.internal && i.family === "IPv4");
    assert.deepEqual(at("0.0.0.0").map((a) => a.url), [...v4.map((i) => `http://${i.address}:46464`), loopback.url]);
});

test("GET /local/status: pid, home, listeners and addresses, behind the boot's token", async () => {
    const env = await boot();
    try {
        assert.equal((await fetch(`${env.base}/local/status`)).status, 404);
        assert.equal((await fetch(`${env.base}/local/status`, { headers: { authorization: "Bearer wrong" } })).status, 404);
        const res = await fetch(`${env.base}/local/status`, { headers: { authorization: `Bearer ${env.localToken}` } });
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body["pid"], process.pid);
        assert.equal(body["home"], home);
        assert.deepEqual(body["listeners"], [{ url: env.base, serves: "channel + local api" }]);
        assert.deepEqual(body["addresses"], [{ url: env.base, kind: "loopback" }]);
    } finally {
        await env.stop();
    }
});

test("POST /local/invite puts the given address in the link, and refuses one a link cannot carry", async () => {
    const env = await boot();
    try {
        const mint = (body: unknown): Promise<Response> =>
            fetch(`${env.base}/local/invite`, { method: "POST", headers: { authorization: `Bearer ${env.localToken}` }, body: JSON.stringify(body) });
        const res = await mint({ address: "http://100.101.1.2:46464" });
        assert.equal(res.status, 200);
        const { uri, address } = (await res.json()) as { uri: string; address: string };
        assert.equal(address, "http://100.101.1.2:46464");
        assert.equal(parseInviteUri(uri).address, "http://100.101.1.2:46464");

        for (const [body, error] of [
            [{ address: "ws://100.101.1.2:46464/channel" }, /malformed invite address/],
            [{ address: 5 }, /address must be a string/],
        ] as const) {
            const refused = await mint(body);
            assert.equal(refused.status, 400);
            assert.match(((await refused.json()) as { error: string }).error, error);
        }
    } finally {
        await env.stop();
    }
});

test("POST /local/agent-invites/:agent mints the agent invite the pult lists, behind the same token", async () => {
    const env = await boot();
    try {
        const post = (path: string, token = env.localToken): Promise<Response> =>
            fetch(`${env.base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
        assert.equal((await post("/local/agent-invites/toto", "wrong")).status, 404);
        assert.equal((await post("/local/agent-invites/Toto")).status, 404);
        assert.deepEqual(env.core.devices.listAgentInvites(), [], "a refused call mints nothing");

        const res = await post("/local/agent-invites/toto");
        assert.equal(res.status, 200);
        const body = (await res.json()) as { uri: string; name: string };
        assert.equal(body.name, "toto");
        const { id, address } = parseInviteUri(body.uri);
        assert.equal(address, undefined);
        const listed = await env.api<{ invites: Array<{ name: string; id: string }> }>("GET", "/api/agent-invites");
        assert.deepEqual(listed.json.invites.map((i) => [i.name, i.id]), [["toto", id]]);
    } finally {
        await env.stop();
    }
});
