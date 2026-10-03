import "./pq-home.ts";

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { config as dotenvxConfig, set as dotenvxSet, type SetOptions } from "@dotenvx/dotenvx";
import { GATEWAY_PORT, parseInviteUri } from "@mimi-os/protocol";

import { gatewayFlags, isLoopbackHost, normalizeHost, urlHost } from "../src/flags.ts";
import { pairDevice } from "../src/device-client.ts";
import { boot, waitFor } from "./harness-env.ts";

const CLI = resolve(import.meta.dirname, "../src/cli/mimi.ts");
const PACKAGE_HOME = resolve(import.meta.dirname, "..", "mimi");
const DEAD_PID = 2_147_483_647;

interface CliResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

/** `home` null runs with no MIMI_HOME at all; the cwd is never the package's own. */
function runCli(home: string | null, args: string[], cwd = tmpdir(), extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
    return new Promise((resolveRun, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, MIMI_PUBLIC_URL: undefined, ...extraEnv, MIMI_HOME: home ?? undefined };
        if (env["MIMI_PUBLIC_URL"] === undefined) delete env["MIMI_PUBLIC_URL"];
        for (const key of ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"]) delete env[key];
        if (home === null) delete env["MIMI_HOME"];
        const child = spawn(
            process.execPath,
            ["--disable-warning=ExperimentalWarning", "--conditions=development", CLI, ...args],
            { env, cwd, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
        child.once("error", reject);
        child.once("close", (code) => resolveRun({ code, stdout, stderr }));
    });
}

async function listen(
    host: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; close(): Promise<void> }> {
    const server = createServer(handler);
    await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, host, resolveListen);
    });
    const address = server.address() as AddressInfo;
    return {
        port: address.port,
        close: () =>
            new Promise<void>((resolveClose) => {
                server.closeAllConnections();
                server.close(() => resolveClose());
            }),
    };
}

test("gateway flags: bracketed IPv6 normalizes for sockets, loopback forms are recognized, bad values are refused", () => {
    assert.deepEqual(gatewayFlags(["--host", "[::1]", "--port", "65535", "--lan=[fe80::1%en0]"]), {
        host: "::1",
        port: 65535,
        lan: "fe80::1%en0",
    });
    assert.equal(normalizeHost("[localhost]"), null);
    for (const yes of ["localhost", "127.0.0.1", "127.9.9.9", "::1", "[::1]", "::ffff:127.0.0.1"]) assert.equal(isLoopbackHost(yes), true, yes);
    for (const no of ["0.0.0.0", "::", "192.168.1.2", "127.256.1.1", "localhost%fake", "evil.example", "[localhost]", ""]) {
        assert.equal(isLoopbackHost(no), false, no);
    }
    assert.equal(urlHost("::1"), "[::1]");
    assert.equal(urlHost("[::1]"), "[::1]");

    const refused: Array<{ args: string[]; error: RegExp }> = [
        { args: ["--host"], error: /--host <value>.*missing/ },
        { args: ["--port"], error: /--port <value>.*missing/ },
        { args: ["--lan"], error: /--lan <value>.*missing/ },
        { args: ["--host="], error: /bad --host/ },
        { args: ["--host=[localhost]"], error: /bad --host/ },
        { args: ["--unknown"], error: /Unknown option/ },
    ];
    for (const { args, error } of refused) assert.throws(() => gatewayFlags(args), error, args.join(" "));
});

test("the CLI prints a bad flag and exits 1", async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-cli-flags-"));
    try {
        const result = await runCli(home, ["status", "--port=65536"]);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /bad --port/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("logs returns exactly the requested final lines with or without a trailing newline", async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-cli-logs-"));
    try {
        const file = join(home, "gateway.log");
        for (const text of ["one\ntwo\nthree", "one\ntwo\nthree\n"]) {
            writeFileSync(file, text);
            const result = await runCli(home, ["logs", "--host", "127.0.0.1", "2"]);
            assert.equal(result.code, 0);
            assert.equal(result.stderr, "");
            assert.equal(result.stdout, "two\nthree\n");
        }
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("logs rejects a non-positive line count", async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-cli-log-count-"));
    try {
        const result = await runCli(home, ["logs", "0"]);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /bad log line count/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("status and pair use the host recorded in the pidfile", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "mimi-cli-record-"));
    const seen: string[] = [];
    const authorization: Array<string | undefined> = [];
    const bodies: string[] = [];
    let server: Awaited<ReturnType<typeof listen>>;
    try {
        server = await listen("::1", (req, res) => {
            seen.push(`${req.method ?? ""} ${req.url ?? ""}`);
            authorization.push(req.headers.authorization);
            let body = "";
            req.on("data", (c: Buffer) => (body += String(c)));
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                if (req.url === "/local/status") {
                    const url = `http://[::1]:${server.port}`;
                    res.end(JSON.stringify({ pid: 4242, home: "/elsewhere", uptimeSec: 9, listeners: [{ url, serves: "channel + local api" }], addresses: [{ url, kind: "loopback" }] }));
                    return;
                }
                bodies.push(body);
                res.end(JSON.stringify({ uri: "mimi://pair/v2?gw=g&id=i&s=s&at=x" }));
            });
        });
    } catch (error) {
        rmSync(home, { recursive: true, force: true });
        t.skip(`IPv6 loopback unavailable: ${String(error)}`);
        return;
    }
    try {
        writeFileSync(join(home, "gateway.pid"), `${DEAD_PID} ${server.port} ::1\n`);
        writeFileSync(join(home, ".local-token"), "local-secret\n");
        const url = `http://[::1]:${server.port}`;

        const status = await runCli(home, ["status"]);
        assert.equal(status.code, 0);
        assert.equal(
            status.stdout,
            `running — pid 4242 · up 9s\nhome: /elsewhere\nlisteners: ${url} (channel + local api)\naddresses: ${url} (loopback)\n`,
        );

        const pair = await runCli(home, ["pair"]);
        assert.equal(pair.code, 0, pair.stderr);
        assert.equal(pair.stdout.split("\n")[0], "mimi://pair/v2?gw=g&id=i&s=s&at=x");
        assert.deepEqual(seen, ["GET /local/status", "GET /local/status", "POST /local/invite"]);
        assert.deepEqual(bodies, [JSON.stringify({ address: url })]);
        assert.deepEqual(authorization, Array(3).fill("Bearer local-secret"));
    } finally {
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
});

test("start reports the recorded host, and a corrupt stored port falls back", async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-cli-pidfile-"));
    try {
        const file = join(home, "gateway.pid");

        writeFileSync(file, `${process.pid} 43210 ::1\n`);
        const recorded = await runCli(home, ["start"]);
        assert.equal(recorded.code, 0);
        assert.match(recorded.stdout, /http:\/\/\[::1\]:43210/);

        writeFileSync(file, `${process.pid} 70000 ::1\n`);
        const bounded = await runCli(home, ["start"]);
        assert.equal(bounded.code, 0);
        assert.match(bounded.stdout, new RegExp(`http://\\[::1\\]:${GATEWAY_PORT}`));
        assert.doesNotMatch(bounded.stdout, /:70000/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("status probes a recorded channel-only host over TCP", async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-cli-channel-status-"));
    const server = await listen("0.0.0.0", (_req, res) => res.writeHead(404).end());
    try {
        writeFileSync(join(home, "gateway.pid"), `${process.pid} ${server.port} 0.0.0.0\n`);
        const result = await runCli(home, ["status"]);
        assert.equal(result.code, 0);
        assert.match(result.stdout, new RegExp(`running .* ws://0\\.0\\.0\\.0:${server.port}/channel .* channel only`));
    } finally {
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
});

test("status can use a bracketed IPv6 flag as a socket host", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "mimi-cli-ipv6-"));
    let server: Awaited<ReturnType<typeof listen>>;
    try {
        server = await listen("::1", (_req, res) => res.writeHead(200).end("ok"));
    } catch (error) {
        rmSync(home, { recursive: true, force: true });
        t.skip(`IPv6 loopback unavailable: ${String(error)}`);
        return;
    }
    try {
        const result = await runCli(home, ["status", "--host", "[::1]", "--port", String(server.port)]);
        assert.equal(result.code, 0);
        assert.match(result.stdout, /answers/);
    } finally {
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
});

test("mimi block drops a live agent and blocks its pin; unblock of a pin not blocked fails with the gateway's reason", async () => {
    const env = await boot();
    // the harness wrote this boot's local token into the test process's own MIMI_HOME
    const home = process.env["MIMI_HOME"] ?? "";
    const port = ["--port", String(env.port)];
    try {
        const h = await env.connect({ name: "toto" });
        await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "registration");

        const notBlocked = await runCli(home, ["unblock", "toto", ...port]);
        assert.equal(notBlocked.code, 1);
        assert.equal(notBlocked.stderr, 'unblock failed — "toto" is not blocked\n');

        const blocked = await runCli(home, ["block", "toto", ...port]);
        assert.equal(blocked.code, 0, blocked.stderr);
        assert.equal(blocked.stdout, "blocked toto — 1 channel session(s) dropped\n");
        await waitFor(() => !h.socketOpen(), 4000, "the agent's socket dropped");
        assert.equal(env.db.getPin("toto")?.status, "blocked");

        assert.match((await runCli(home, ["block"])).stderr, /^usage: mimi block <agent>/);
    } finally {
        await env.stop();
    }
});

test("with no MIMI_HOME the CLI and the daemon both resolve <gateway>/mimi, from any cwd", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "mimi-cli-elsewhere-"));
    try {
        const server = await listen("127.0.0.1", (_req, res) => res.writeHead(404).end());
        const port = server.port;
        await server.close();
        const status = await runCli(null, ["status", "--port", String(port)], elsewhere);
        assert.equal(status.code, 1);
        assert.match(status.stdout, new RegExp(`^the gateway is not running — nothing answers at http://127\\.0\\.0\\.1:${port}\n`));
        assert.ok(status.stdout.includes(`  home: ${PACKAGE_HOME}\n`), status.stdout);
        assert.ok(status.stdout.includes(`  start it: mimi start --port ${port}\n`), status.stdout);

        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env["MIMI_HOME"];
        const daemonHome = await new Promise<string>((done, reject) => {
            const child = spawn(
                process.execPath,
                ["--input-type=module", "-e", `const m = await import(${JSON.stringify(resolve(import.meta.dirname, "../src/store/home.ts"))}); process.stdout.write(m.home);`],
                { env, cwd: elsewhere, stdio: ["ignore", "pipe", "inherit"] },
            );
            let text = "";
            child.stdout.on("data", (c: Buffer) => (text += String(c)));
            child.once("error", reject);
            child.once("close", () => done(text));
        });
        assert.equal(daemonHome, PACKAGE_HOME);
    } finally {
        rmSync(elsewhere, { recursive: true, force: true });
    }
});

/** `mimi run` in the foreground from its own cwd, on a free port; retried when a parallel file takes it first. */
async function runGateway(home: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ child: ChildProcess; port: number; output: () => string }> {
    for (let attempt = 1; ; attempt++) {
        const probe = await listen("127.0.0.1", (_req, res) => res.end());
        const port = probe.port;
        await probe.close();
        const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, MIMI_HOME: home };
        const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--conditions=development", CLI, "run", "--port", String(port)], {
            env,
            cwd: tmpdir(),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (c: Buffer) => (output += String(c)));
        child.stderr.on("data", (c: Buffer) => (output += String(c)));
        await waitFor(() => /mimi gateway —|already taken/.test(output) || child.exitCode !== null, 8000, "the gateway booted");
        if (/mimi gateway —/.test(output)) return { child, port, output: () => output };
        if (attempt === 5) throw new Error(output);
        await new Promise((done) => child.once("close", done));
    }
}

test("a real gateway, driven from other directories: status, one pair link, invite --write, and every error", { timeout: 30_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-cli-real-"));
    const otherHome = mkdtempSync(join(tmpdir(), "mimi-cli-other-"));
    const gateway = await runGateway(home);
    const { port } = gateway;
    const base = `http://127.0.0.1:${port}`;
    const at = ["--port", String(port)];
    try {
        const status = await runCli(home, ["status", ...at]);
        assert.equal(status.code, 0, status.stderr);
        assert.deepEqual(status.stdout.split("\n").slice(1), [
            `home: ${home}`,
            `listeners: ${base} (channel + local api)`,
            `addresses: ${base} (loopback)`,
            "",
        ]);
        assert.match(status.stdout, new RegExp(`^running — pid ${gateway.child.pid} · up \\d+s\n`));

        // one link, carrying the address; the app redeems it with nothing else typed
        const pair = await runCli(home, ["pair", ...at]);
        assert.equal(pair.code, 0, pair.stderr);
        const [link = "", address, hint, note] = pair.stdout.split("\n");
        assert.equal(address, `address: ${base}`);
        assert.match(hint ?? "", /paste the link into the app/);
        assert.equal(note, `note: ${base} works only on this machine — for the app elsewhere set MIMI_PUBLIC_URL in ${join(home, ".env")} and restart the gateway, or pass --address <url>`);
        const parsed = parseInviteUri(link);
        assert.equal(parsed.address, base);
        const s = crypto.getRandomValues(new Uint8Array(32));
        const enrolled = await pairDevice(parsed.address.replace(/^http/, "ws"), link, s, "laptop");
        assert.deepEqual(enrolled.gatewayPub, parsed.gwPub);

        const chosen = await runCli(home, ["pair", ...at, "--address", "100.101.1.2:46464/"]);
        assert.equal(parseInviteUri(chosen.stdout.split("\n")[0] ?? "").address, "http://100.101.1.2:46464");

        // an agent invite, as the lines the agent's .env takes
        const printed = await runCli(home, ["invite", "toto", ...at]);
        assert.equal(printed.code, 0, printed.stderr);
        const [inviteLine = "", urlLine, comment] = printed.stdout.split("\n");
        assert.match(inviteLine, /^MIMI_INVITE=mimi:\/\/pair\/v2\?/);
        assert.equal(urlLine, `MIMI_GATEWAY_URL=ws://127.0.0.1:${port}/channel`);
        assert.match(comment ?? "", /^# put these in toto's \.env/);

        const dotenv = join(otherHome, ".env");
        writeFileSync(dotenv, "SHOP_API_KEY=encrypted:abc\n# a note\nMIMI_INVITE=mimi://pair/v2?old\nexport MIMI_INVITE=duplicate\nOTHER=1", { mode: 0o640 });
        const written = await runCli(home, ["invite", "toto", "--write", dotenv, ...at]);
        assert.equal(written.code, 0, written.stderr);
        assert.match(written.stdout, new RegExp(`^wrote MIMI_INVITE and MIMI_GATEWAY_URL to ${dotenv}`));
        const lines = readFileSync(dotenv, "utf8").split("\n");
        assert.deepEqual([lines[0], lines[1], lines[3], lines[4], lines[5]], [
            "SHOP_API_KEY=encrypted:abc",
            "# a note",
            "OTHER=1",
            `MIMI_GATEWAY_URL=ws://127.0.0.1:${port}/channel`,
            "",
        ]);
        assert.equal(lines.length, 6);
        const agentLink = (lines[2] ?? "").slice("MIMI_INVITE=".length);
        assert.equal(statSync(dotenv).mode & 0o777, 0o640, "the file keeps its mode");
        await pairDevice(`ws://127.0.0.1:${port}`, agentLink, crypto.getRandomValues(new Uint8Array(32)), "toto");

        const fresh = join(otherHome, "fresh.env");
        assert.equal((await runCli(home, ["invite", "rex", "--write", fresh, ...at])).code, 0);
        assert.match(readFileSync(fresh, "utf8"), /^MIMI_INVITE=mimi:\/\/pair\/v2\?.*\nMIMI_GATEWAY_URL=ws:\/\/127\.0\.0\.1:\d+\/channel\n$/);
        assert.equal(statSync(fresh).mode & 0o777, 0o600);

        // a bad --write target is refused before minting, so the agent's open invite still redeems
        const kept = join(otherHome, "kept.env");
        assert.equal((await runCli(home, ["invite", "kip", "--write", kept, ...at])).code, 0);
        for (const bad of [join(otherHome, "missing", ".env"), otherHome]) {
            const refused = await runCli(home, ["invite", "kip", "--write", bad, ...at]);
            assert.equal(refused.code, 1);
            assert.ok(refused.stderr.startsWith(`cannot write ${bad} — `) && refused.stderr.split("\n").length === 2, refused.stderr);
        }
        const keptLink = (readFileSync(kept, "utf8").split("\n")[0] ?? "").slice("MIMI_INVITE=".length);
        await pairDevice(`ws://127.0.0.1:${port}`, keptLink, crypto.getRandomValues(new Uint8Array(32)), "kip");

        // a refused pair, a bad name, a bad address
        const refused = await runCli(home, ["pair", ...at, "--address", `http://${"a".repeat(200)}.example`]);
        assert.equal(refused.code, 1);
        assert.equal(refused.stderr, "pairing refused — malformed invite address\n");
        assert.match((await runCli(home, ["invite", "Toto", ...at])).stderr, /^bad agent name "Toto"/);
        assert.match((await runCli(home, ["pair", ...at, "--address", "ftp://x"])).stderr, /^bad --address "ftp:\/\/x"/);
        assert.match((await runCli(home, ["pair", "--write", "x"])).stderr, /^--write belongs to mimi invite/);

        // another home: never started, then one with a stale token
        const never = await runCli(otherHome, ["pair", ...at]);
        assert.equal(never.code, 1);
        assert.equal(
            never.stderr,
            `no gateway has started from this home — it has no .local-token\n  home: ${otherHome}\n  start one: mimi start — or point MIMI_HOME at the home your gateway runs from\n`,
        );
        writeFileSync(join(otherHome, ".local-token"), "stale\n");
        const wrongHome = await runCli(otherHome, ["invite", "toto", ...at]);
        assert.equal(wrongHome.code, 1);
        assert.match(wrongHome.stderr, /^the gateway at http:\/\/127\.0\.0\.1:\d+ refused the local token of this home/);
        assert.ok(wrongHome.stderr.includes(`  home: ${otherHome}\n`), wrongHome.stderr);
        assert.match((await runCli(otherHome, ["status", ...at])).stdout, /^no daemon of this home, but 127\.0\.0\.1:\d+ answers/);

        // the port is taken: by this home's own gateway, by another home's, then by something else
        const again = await runCli(home, ["start", ...at]);
        assert.equal(again.code, 0, again.stderr);
        assert.equal(again.stdout, `already running — pid ${gateway.child.pid} (${base}), not started by mimi start\n`);
        const stop = await runCli(home, ["stop", ...at]);
        assert.equal(stop.code, 1);
        assert.equal(
            stop.stderr,
            `the gateway of this home runs as pid ${gateway.child.pid}, not started by mimi start — stop it where it was started (pm2, or Ctrl-C on mimi run)\n`,
        );
        const busy = await runCli(otherHome, ["start", ...at]);
        assert.equal(busy.code, 1);
        assert.equal(
            busy.stderr,
            `port ${port} on 127.0.0.1 is busy — a gateway of another home answers there\n  home: ${otherHome}\n  stop it, or start this one on another port: mimi start --port <n>\n`,
        );
    } finally {
        gateway.child.kill("SIGTERM");
        await new Promise((done) => (gateway.child.exitCode === null ? gateway.child.once("close", done) : done(null)));
        rmSync(home, { recursive: true, force: true });
        rmSync(otherHome, { recursive: true, force: true });
    }

    // the same home once its gateway is gone
    const down = mkdtempSync(join(tmpdir(), "mimi-cli-down-"));
    const plain = await listen("127.0.0.1", (_req, res) => res.writeHead(404).end());
    try {
        writeFileSync(join(down, ".local-token"), "t\n");
        const gone = await runCli(down, ["invite", "toto", ...at]);
        assert.equal(gone.code, 1);
        assert.equal(gone.stderr, `the gateway is not running — nothing answers at ${base}\n  home: ${down}\n  start it: mimi start --port ${port}\n`);
        // a program that is no gateway still answers: not "not running"
        const held = await runCli(down, ["status", "--port", String(plain.port)]);
        assert.match(held.stdout, new RegExp(`^no daemon of this home, but 127\\.0\\.0\\.1:${plain.port} answers`));
        const other = await runCli(down, ["start", "--port", String(plain.port)]);
        assert.equal(other.code, 1);
        assert.match(other.stderr, new RegExp(`^port ${plain.port} on 127\\.0\\.0\\.1 is busy — another program holds it\n`));
        // a dev server answering 200 to every path is not this home's gateway, whatever its /local/status says
        const spa = await listen("127.0.0.1", (_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html>"));
        try {
            const taken = await runCli(down, ["start", "--port", String(spa.port)]);
            assert.equal(taken.code, 1);
            assert.match(taken.stderr, new RegExp(`^port ${spa.port} on 127\\.0\\.0\\.1 is busy — `));
            const seen = await runCli(down, ["status", "--port", String(spa.port)]);
            assert.match(seen.stdout, new RegExp(`^no daemon of this home, but 127\\.0\\.0\\.1:${spa.port} answers`));
        } finally {
            await spa.close();
        }
    } finally {
        await plain.close();
        rmSync(down, { recursive: true, force: true });
    }
});

test("MIMI_PUBLIC_URL leads the pairing link and mimi status; a malformed one stops the boot", { timeout: 30_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-cli-public-"));
    const gateway = await runGateway(home, { MIMI_PUBLIC_URL: "https://Mimi.Example.com:8443/" });
    const at = ["--port", String(gateway.port)];
    try {
        const status = await runCli(home, ["status", ...at]);
        assert.match(status.stdout, /\naddresses: https:\/\/mimi\.example\.com:8443 \(public\) · http:\/\/127\.0\.0\.1:\d+ \(loopback\)\n/);
        const pair = await runCli(home, ["pair", ...at]);
        assert.equal(pair.code, 0, pair.stderr);
        const [link = "", address, , note] = pair.stdout.split("\n");
        assert.equal(address, "address: https://mimi.example.com:8443");
        assert.equal(parseInviteUri(link).address, "https://mimi.example.com:8443");
        assert.equal(note, "", "no loopback note when the link names a public address");
    } finally {
        gateway.child.kill("SIGINT");
        await new Promise((done) => gateway.child.once("close", done));
        rmSync(home, { recursive: true, force: true });
    }

    const bad = mkdtempSync(join(tmpdir(), "mimi-cli-public-bad-"));
    try {
        const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "run", "--port", "1"], {
            env: { ...process.env, MIMI_HOME: bad, MIMI_PUBLIC_URL: "mimi.example.com/path" },
            cwd: tmpdir(),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (c: Buffer) => (output += String(c)));
        child.stderr.on("data", (c: Buffer) => (output += String(c)));
        const code = await new Promise<number | null>((done) => child.once("close", done));
        assert.notEqual(code, 0);
        assert.match(output, /MIMI_PUBLIC_URL="mimi\.example\.com\/path" is not an address the app can dial/);
    } finally {
        rmSync(bad, { recursive: true, force: true });
    }
});

test("mimi public-url: shows, sets with the boot's own rule, clears, and a running gateway picks it up at restart", { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "mimi-cli-public-url-"));
    const home = join(root, "home");
    const env = join(home, ".env");
    const idle = "the gateway is not running, nothing to restart";
    try {
        assert.deepEqual(await runCli(home, ["public-url"]), { code: 0, stdout: "public URL: not set\n", stderr: "" });
        assert.deepEqual(await runCli(home, ["public-url", "--clear"]), { code: 0, stdout: "public URL: not set\n", stderr: "" });

        // the first write creates the home (0700) and the .env (0600) and names the canonical origin
        const set = await runCli(home, ["public-url", "https://Mimi.Example.com:8443/"]);
        assert.deepEqual(set, { code: 0, stdout: `public URL: https://mimi.example.com:8443 — ${idle}\n`, stderr: "" });
        assert.equal(readFileSync(env, "utf8"), "MIMI_PUBLIC_URL=https://mimi.example.com:8443\n");
        assert.equal(statSync(home).mode & 0o777, 0o700);
        assert.equal(statSync(env).mode & 0o777, 0o600);
        assert.equal((await runCli(home, ["public-url"])).stdout, "public URL: https://mimi.example.com:8443\n");

        // a replacement keeps every other line, encrypted ones included, and drops a later duplicate
        const others = ['DOTENV_PUBLIC_KEY="02ab"', "# a comment", 'OPENROUTER_API_KEY="encrypted:BD9x+/="', "MIMI_TZ=Europe/Helsinki"];
        writeFileSync(env, [others[0], "export MIMI_PUBLIC_URL=http://old.example", ...others.slice(1), "MIMI_PUBLIC_URL=http://dup.example"].join("\n"));
        chmodSync(env, 0o640);
        const replaced = await runCli(home, ["public-url", "http://100.64.1.2:46464"]);
        assert.equal(replaced.stdout, `public URL: http://100.64.1.2:46464 — ${idle}\n`);
        assert.equal(readFileSync(env, "utf8"), [others[0], "MIMI_PUBLIC_URL=http://100.64.1.2:46464", ...others.slice(1), ""].join("\n"));
        assert.equal(statSync(env).mode & 0o777, 0o640, "an existing .env keeps its mode");

        // bad input: exit 2, the boot's own message, the file untouched
        const before = readFileSync(env, "utf8");
        for (const bad of ["mimi.example.com/path", "https://mimi.example.com/app", "ftp://mimi.example.com", "https://user:pw@mimi.example.com", "http://a b"]) {
            const refused = await runCli(home, ["public-url", bad]);
            assert.equal(refused.code, 2, bad);
            assert.equal(refused.stdout, "");
            assert.equal(refused.stderr, `MIMI_PUBLIC_URL="${bad}" is not an address the app can dial — give an http(s) origin like https://mimi.example.com:8443\n`);
        }
        for (const args of [["public-url", ""], ["public-url", "--clear", "https://x.example"], ["public-url", "https://a.example", "https://b.example"]]) {
            assert.equal((await runCli(home, args)).code, 2, args.join(" "));
        }
        assert.equal(readFileSync(env, "utf8"), before);
        assert.equal((await runCli(home, ["status", "--clear"])).code, 1);

        // ciphertext without its .env.keys reads as the boot reads it: no value, and why
        const undecrypted = await runCli(home, ["public-url"]);
        assert.equal(undecrypted.stdout, "public URL: not set\n");
        assert.match(undecrypted.stderr, /note: \[MISSING_PRIVATE_KEY\] could not decrypt/);
        assert.deepEqual(await runCli(home, ["public-url", "--clear"]), { code: 0, stdout: `public URL: not set — ${idle}\n`, stderr: "" });
        assert.equal(readFileSync(env, "utf8"), [...others, ""].join("\n"));
        assert.deepEqual(await runCli(home, ["public-url", "--clear"]), { code: 0, stdout: "public URL: not set\n", stderr: "" });

        // a dotenvx-encrypted value is decrypted, and a rewrite keeps the other ciphertext decryptable
        rmSync(home, { recursive: true, force: true });
        mkdirSync(home);
        writeFileSync(env, "# kept\n");
        dotenvxSet("MIMI_PUBLIC_URL", "https://sealed.example", { path: env, quiet: true } as SetOptions);
        dotenvxSet("OPENROUTER_API_KEY", "sk-sealed", { path: env, quiet: true } as SetOptions);
        writeFileSync(env, `${readFileSync(env, "utf8")}MIMI_TZ=UTC`);
        assert.match(readFileSync(env, "utf8"), /^MIMI_PUBLIC_URL="encrypted:/m);
        assert.deepEqual(await runCli(home, ["public-url"]), { code: 0, stdout: "public URL: https://sealed.example\n", stderr: "" });
        const sealedBefore = readFileSync(env, "utf8").split("\n");
        assert.equal((await runCli(home, ["public-url", "https://open.example"])).code, 0);
        assert.deepEqual(
            readFileSync(env, "utf8").split("\n"),
            [...sealedBefore.map((line) => (line.startsWith("MIMI_PUBLIC_URL=") ? "MIMI_PUBLIC_URL=https://open.example" : line)), ""],
        );
        const reread = dotenvxConfig({ path: env, quiet: true, processEnv: {} }).parsed ?? {};
        assert.deepEqual([reread["MIMI_PUBLIC_URL"], reread["OPENROUTER_API_KEY"], reread["MIMI_TZ"]], ["https://open.example", "sk-sealed", "UTC"]);

        // the real environment wins over the file at boot: the CLI says so
        const shadowed = await runCli(home, ["public-url"], tmpdir(), { MIMI_PUBLIC_URL: "https://env.example" });
        assert.equal(shadowed.stdout, "public URL: https://open.example\n");
        assert.equal(shadowed.stderr, `note: MIMI_PUBLIC_URL="https://env.example" in the environment wins over ${env}\n`);

        const cleared = await runCli(home, ["public-url", "--clear"]);
        assert.deepEqual(cleared, { code: 0, stdout: `public URL: not set — ${idle}\n`, stderr: "" });
        assert.doesNotMatch(readFileSync(env, "utf8"), /MIMI_PUBLIC_URL/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }

    // against a running gateway: the CLI asks for a restart, and the restarted gateway dials what it wrote
    const live = mkdtempSync(join(tmpdir(), "mimi-cli-public-url-live-"));
    let gateway = await runGateway(live);
    try {
        const at = ["--port", String(gateway.port)];
        const set = await runCli(live, ["public-url", "https://Live.Example.com", ...at]);
        assert.deepEqual(set, { code: 0, stdout: "public URL: https://live.example.com — restart the gateway to use it\n", stderr: "" });
        gateway.child.kill("SIGINT");
        await new Promise((done) => gateway.child.once("close", done));
        gateway = await runGateway(live);
        const status = await runCli(live, ["status", "--port", String(gateway.port)]);
        assert.match(status.stdout, /\naddresses: https:\/\/live\.example\.com \(public\) · http:\/\/127\.0\.0\.1:\d+ \(loopback\)\n/);
        const cleared = await runCli(live, ["public-url", "--clear", "--port", String(gateway.port)]);
        assert.equal(cleared.stdout, "public URL: not set — restart the gateway to drop it\n");
    } finally {
        gateway.child.kill("SIGINT");
        await new Promise((done) => gateway.child.once("close", done));
        rmSync(live, { recursive: true, force: true });
    }
});
