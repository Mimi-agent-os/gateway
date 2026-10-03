#!/usr/bin/env node
/** cli/mimi.ts — the `mimi` command: run/start/stop/restart/status/logs for the gateway daemon, `mimi pair`
 *  for the one link that pairs the app, `mimi invite <agent>` for an agent's .env lines, and
 *  `mimi block|unblock <agent>`, the agent kill switch that needs no open app, and `mimi public-url`, the
 *  MIMI_PUBLIC_URL line of the home's .env. */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, openSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GATEWAY_PORT, isAgentName } from "@mimi-os/protocol";

import { gatewayFlags, isLoopbackHost, normalizeHost, publicOrigin, urlHost } from "../flags.ts";
import type { ReachableAddress } from "../http/listeners.ts";
import { ensureDir, envFile, home, writeAtomic } from "../store/home.ts";

const USAGE =
    "run|start|stop|restart|status|logs [n] [-f]|pair [--address <url>]|invite <agent> [--write <.env>] [--address <url>]|" +
    "block <agent>|unblock <agent>|public-url [<url>|--clear], each with [--host <ip>] [--port <n>] [--lan <host>]";

const gatewayPidFile = join(home, "gateway.pid");
const gatewayLogFile = join(home, "gateway.log");
const localTokenFile = join(home, ".local-token");
/** dist/cli/mimi.js → dist/daemon.js, resolved from THIS module so a global install works from any cwd. */
const gatewayEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "daemon.js");

const out = (s: string): void => void process.stdout.write(`${s}\n`);
function fail(s: string, code = 1): never {
    process.stderr.write(`${s}\n`);
    process.exit(code);
}

// ── arguments: the CLI's own come out, the gateway flags are forwarded as written ──
function parseCli(args: string[]) {
    const { values, positionals, tokens } = parseArgs({
        args,
        options: {
            f: { type: "boolean" },
            clear: { type: "boolean" },
            write: { type: "string" },
            address: { type: "string" },
            host: { type: "string" },
            port: { type: "string" },
            lan: { type: "string" },
        },
        allowPositionals: true,
        tokens: true,
    });
    const own = new Set<number>();
    for (const t of tokens) {
        if (t.kind === "positional") own.add(t.index);
        if (t.kind === "option" && (t.name === "f" || t.name === "clear" || t.name === "write" || t.name === "address")) {
            own.add(t.index);
            if (t.value !== undefined && t.inlineValue === false) own.add(t.index + 1);
        }
    }
    return { gateway: args.filter((_, i) => !own.has(i)), positionals, follow: values.f === true, clear: values.clear === true, write: values.write, address: values.address };
}

const cmd = process.argv[2] ?? "status";
let parsed: ReturnType<typeof parseCli>;
let flags: ReturnType<typeof gatewayFlags>;
try {
    parsed = parseCli(process.argv.slice(3));
    flags = gatewayFlags(parsed.gateway);
} catch (e) {
    fail((e as Error).message);
}
const named = cmd === "block" || cmd === "unblock" || cmd === "invite";
const agent = named ? (parsed.positionals[0] ?? "") : "";
if (named && (agent === "" || parsed.positionals.length > 1)) fail(`usage: mimi ${cmd} <agent>${cmd === "invite" ? " [--write <.env>] [--address <url>]" : ""} [--host <ip>] [--port <n>]`);
if (named && !isAgentName(agent)) fail(`bad agent name "${agent}" — a lowercase slug, [a-z][a-z0-9_-]*, at most 64 characters`);
if (cmd === "public-url" && (parsed.positionals.length > 1 || (parsed.clear && parsed.positionals.length > 0))) {
    fail("usage: mimi public-url [<url> | --clear] [--host <ip>] [--port <n>]", 2);
}
if (!named && cmd !== "logs" && cmd !== "public-url" && parsed.positionals.length > 0) fail(`mimi ${cmd} takes no argument "${parsed.positionals[0]}"`);
if (cmd === "logs" && parsed.positionals.length > 1) fail("logs accepts only one line count");
if (parsed.follow && cmd !== "logs") fail("-f belongs to mimi logs");
if (parsed.clear && cmd !== "public-url") fail("--clear belongs to mimi public-url");
if (parsed.write !== undefined && cmd !== "invite") fail("--write belongs to mimi invite");
if (parsed.address !== undefined && cmd !== "pair" && cmd !== "invite") fail("--address belongs to mimi pair and mimi invite");
// the owner may type 100.64.1.2:46464 or a trailing slash: the link carries the bare origin
const addressFlag = parsed.address === undefined ? undefined : URL.parse(parsed.address.includes("://") ? parsed.address : `http://${parsed.address}`)?.origin;
if (parsed.address !== undefined && !/^https?:\/\//.test(addressFlag ?? "")) {
    fail(`bad --address "${parsed.address}" — give the gateway's http(s) address, e.g. http://100.64.1.2:${GATEWAY_PORT}`);
}
const HOST = flags.host ?? "127.0.0.1";
const PORT = flags.port ?? GATEWAY_PORT;

// ── the daemon's pidfile: `<pid> <port> <host>` ──
function pidParts(): string[] | null {
    if (!existsSync(gatewayPidFile)) return null;
    return readFileSync(gatewayPidFile, "utf8").trim().split(/\s+/);
}

/** A pid, but only if that process is alive, so a stale pidfile reads as "not running". */
function livePid(): number | null {
    const pid = Number(pidParts()?.[0]);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        process.kill(pid, 0); // signal 0 = existence check
        return pid;
    } catch {
        return null;
    }
}

/** --port wins; otherwise the daemon's own recorded port; otherwise the baked-in default. */
function askPort(): number {
    if (flags.port !== undefined) return PORT;
    const n = Number(pidParts()?.[1]);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : PORT;
}

/** --host wins; otherwise the daemon's own recorded host. */
function askHost(): string {
    if (flags.host !== undefined) return HOST;
    return normalizeHost(pidParts()?.[2] ?? "") ?? HOST;
}

const gatewayAddress = (host: string, port: number): string =>
    isLoopbackHost(host) ? `http://${urlHost(host)}:${port}` : `ws://${urlHost(host)}:${port}/channel`;

const notRunning = (where: string): string =>
    `the gateway is not running — nothing answers at ${where}\n  home: ${home}\n  start it: mimi start${flags.port === undefined ? "" : ` --port ${PORT}`}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function health(host: string, port: number): Promise<{ ok: boolean; detail: string }> {
    try {
        const res = await fetch(`http://${urlHost(host)}:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
        return { ok: res.status === 200, detail: (await res.text()).slice(0, 200) };
    } catch (e) {
        const error = e as Error;
        return { ok: false, detail: error.cause instanceof Error ? error.cause.message : error.message };
    }
}

const channelReady = (host: string, port: number): Promise<boolean> =>
    new Promise((done) => {
        const socket = connect({ host, port });
        let settled = false;
        const finish = (ready: boolean): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            done(ready);
        };
        socket.setTimeout(500);
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.once("timeout", () => finish(false));
    });

// ── the loopback /local routes, authorised by the token this home's gateway wrote at boot ──
interface LocalReply {
    status: number;
    json: Record<string, unknown>;
}

/** The reply, or why there is none: no token in this home, or nothing answering. */
async function localCall(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<LocalReply | string> {
    const host = askHost();
    if (!isLoopbackHost(host)) fail(`--host ${host} is not loopback — a gateway there serves the channel only, so run mimi ${cmd} against 127.0.0.1`);
    const base = `http://${urlHost(host)}:${askPort()}`;
    if (!existsSync(localTokenFile)) {
        return `no gateway has started from this home — it has no .local-token\n  home: ${home}\n  start one: mimi start — or point MIMI_HOME at the home your gateway runs from`;
    }
    const token = readFileSync(localTokenFile, "utf8").trim();
    try {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: body === undefined ? null : JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { status: res.status, json };
    } catch {
        return notRunning(base);
    }
}

/** For the commands that need an answer: no gateway, or a gateway of another home, ends the command. */
async function local(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<LocalReply> {
    const reply = await localCall(method, path, body);
    if (typeof reply === "string") fail(reply);
    // the uniform 404 carries no error: the gateway did not take this home's token
    if (reply.status === 404 && typeof reply.json["error"] !== "string") {
        fail(
            `the gateway at ${gatewayAddress(askHost(), askPort())} refused the local token of this home — it runs from another home, or predates this CLI\n` +
                `  home: ${home}\n  point MIMI_HOME at the home it runs from, or restart it: mimi restart`,
        );
    }
    return reply;
}

const reason = (reply: LocalReply): string => (typeof reply.json["error"] === "string" ? reply.json["error"] : `the gateway said ${reply.status}`);

interface LocalStatus {
    pid: number;
    home: string;
    uptimeSec: number;
    listeners: { url: string; serves: string }[];
    addresses: ReachableAddress[];
}

/** This home's gateway describing itself; a program that merely answers 200 on the port is not it. */
async function ownStatus(host: string): Promise<LocalStatus | null> {
    const own = isLoopbackHost(host) ? await localCall("GET", "/local/status") : null;
    return own !== null && typeof own !== "string" && own.status === 200 && typeof own.json["pid"] === "number" ? (own.json as unknown as LocalStatus) : null;
}

// ── commands ──
/** Each key replaces its first line and a later duplicate goes (null drops them all), a missing key is
 *  appended, every other line stays exactly as it was — encrypted values included. */
function setKeys(lines: string[], entries: Map<string, string | null>): string[] {
    const pending = new Map(entries);
    const kept = lines.flatMap((line) => {
        const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? "";
        if (!entries.has(key)) return [line];
        const value = pending.get(key);
        pending.delete(key);
        return value === undefined || value === null ? [] : [`${key}=${value}`];
    });
    for (const [key, value] of pending) if (value !== null) kept.push(`${key}=${value}`);
    return kept;
}

function tail(file: string, n: number): string {
    if (!existsSync(file)) return "(no log yet)";
    const lines = readFileSync(file, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

function logs(): void {
    const count = parsed.positionals[0] ?? "60";
    const n = Number(count);
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(n) || n < 1) fail(`bad log line count "${count}"`);
    out(tail(gatewayLogFile, n));
    if (!parsed.follow) return;
    let at = existsSync(gatewayLogFile) ? readFileSync(gatewayLogFile, "utf8").length : 0;
    watchFile(gatewayLogFile, { interval: 500 }, () => {
        const text = existsSync(gatewayLogFile) ? readFileSync(gatewayLogFile, "utf8") : "";
        if (text.length > at) process.stdout.write(text.slice(at));
        at = text.length;
    });
    process.on("SIGINT", () => {
        unwatchFile(gatewayLogFile);
        process.exit(0);
    });
}

async function startGateway(): Promise<void> {
    const pid = livePid();
    if (pid !== null) {
        out(`already running — pid ${pid} (${gatewayAddress(askHost(), askPort())})`);
        return;
    }
    rmSync(gatewayPidFile, { force: true });
    // a gateway of this home that `mimi start` did not spawn (pm2, `mimi run`) still owns the port
    const own = await ownStatus(HOST);
    if (own !== null) {
        out(`already running — pid ${own.pid} (${gatewayAddress(HOST, PORT)}), not started by mimi start`);
        return;
    }
    if (await channelReady(HOST, PORT)) {
        const other = isLoopbackHost(HOST) && (await health(HOST, PORT)).ok;
        fail(
            `port ${PORT} on ${HOST} is busy — ${other ? "a gateway of another home answers there" : "another program holds it"}\n` +
                `  home: ${home}\n  stop it, or start this one on another port: mimi start --port <n>`,
        );
    }
    if (!existsSync(gatewayEntry)) fail(`no gateway build at ${gatewayEntry} — run \`pnpm build\` first`);
    ensureDir(home);
    const log = openSync(gatewayLogFile, "a");
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", gatewayEntry, ...parsed.gateway], {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, MIMI_HOME: home },
        cwd: dirname(home),
    });
    child.unref();
    if (child.pid === undefined) fail("spawn failed — no pid");
    writeFileSync(gatewayPidFile, `${child.pid} ${PORT} ${HOST}\n`, "utf8");
    const loopback = isLoopbackHost(HOST);
    for (let i = 0; i < 50; i++) {
        const ready = loopback ? (await health(HOST, PORT)).ok : await channelReady(HOST, PORT);
        if (ready) {
            out(`started — pid ${child.pid} · ${gatewayAddress(HOST, PORT)} · home: ${home}`);
            return;
        }
        if (livePid() === null) {
            rmSync(gatewayPidFile, { force: true });
            fail(`the gateway exited during boot — last log lines:\n${tail(gatewayLogFile, 20)}`);
        }
        await sleep(200);
    }
    out(`started (pid ${child.pid}) but ${loopback ? "/api/health" : "the channel listener"} is not answering yet — check \`mimi logs\``);
}

async function stopGateway(): Promise<void> {
    const pid = livePid();
    if (pid === null) {
        rmSync(gatewayPidFile, { force: true });
        const own = await ownStatus(askHost());
        if (own !== null) {
            fail(`the gateway of this home runs as pid ${own.pid}, not started by mimi start — stop it where it was started (pm2, or Ctrl-C on mimi run)`);
        }
        out(`not running (home: ${home})`);
        return;
    }
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 75; i++) {
        if (livePid() === null) {
            rmSync(gatewayPidFile, { force: true });
            out(`stopped — pid ${pid}`);
            return;
        }
        await sleep(200);
    }
    fail(`pid ${pid} did not exit in 15s — \`kill -9 ${pid}\` if it is truly stuck`);
}

async function gatewayStatus(): Promise<void> {
    const port = askPort();
    const host = askHost();
    const loopback = isLoopbackHost(host);
    // this home's gateway describes itself, however it was started
    const s = await ownStatus(host);
    if (s !== null) {
        out(`running — pid ${s.pid} · up ${s.uptimeSec}s`);
        out(`home: ${s.home}`);
        out(`listeners: ${s.listeners.map((l) => `${l.url} (${l.serves})`).join(" · ")}`);
        out(`addresses: ${s.addresses.map((a) => `${a.url} (${a.kind})`).join(" · ")}`);
        return;
    }
    const pid = livePid();
    const h = loopback ? await health(host, port) : null;
    const ready = h?.ok ?? (await channelReady(host, port));
    // a program with no /api/health still answers: only a closed port is "not running"
    if (pid === null && !ready && !(await channelReady(host, port))) {
        out(notRunning(gatewayAddress(host, port)));
        process.exitCode = 1;
        return;
    }
    if (pid !== null && ready) {
        out(`running — pid ${pid} · ${gatewayAddress(host, port)} · ${loopback ? (h?.detail ?? "") : "channel only"}\nhome: ${home}`);
        return;
    }
    if (pid !== null) {
        out(
            loopback
                ? `process ${pid} is alive but /api/health says: ${h?.detail ?? "no response"} — it may still be booting`
                : `process ${pid} is alive but the channel listener at ${host}:${port} is not answering`,
        );
        return;
    }
    out(`no daemon of this home, but ${host}:${port} answers — likely a dev server or a gateway of another MIMI_HOME\n  home: ${home}`);
}

/** One link for the app: the invite, carrying the address the app should dial. */
async function pair(): Promise<void> {
    let address = addressFlag;
    let others: string[] = [];
    let loopbackOnly = false;
    if (address === undefined) {
        const status = await local("GET", "/local/status");
        if (status.status !== 200) fail(`pairing refused — ${reason(status)}`);
        const rank: ReachableAddress["kind"][] = ["public", "tailscale", "lan", "loopback"];
        const reachable = (status.json as unknown as LocalStatus).addresses.toSorted((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind));
        const chosen = reachable[0] ?? fail("pairing refused — the gateway named no address to dial");
        address = chosen.url;
        loopbackOnly = chosen.kind === "loopback";
        others = reachable.slice(1).map((a) => a.url);
    }
    const reply = await local("POST", "/local/invite", { address });
    if (reply.status !== 200) fail(`pairing refused — ${reason(reply)}`);
    out(typeof reply.json["uri"] === "string" ? reply.json["uri"] : fail("pairing refused — no invite in the response"));
    out(`address: ${address}`);
    out(
        `paste the link into the app's Connect screen; it works once, within 2 minutes` +
            (others.length > 0 ? ` — for another address: mimi pair --address ${others.join(" | ")}` : ""),
    );
    if (loopbackOnly) {
        out(`note: ${address} works only on this machine — for the app elsewhere set MIMI_PUBLIC_URL in ${join(home, ".env")} and restart the gateway, or pass --address <url>`);
    }
}

/** An agent invite as the .env lines the agent reads: MIMI_INVITE, and MIMI_GATEWAY_URL to dial. */
async function invite(): Promise<void> {
    // the target is read before minting: a new invite burns the agent's open one, so a bad path must cost nothing
    const file = parsed.write === undefined ? undefined : resolve(parsed.write);
    let lines: string[] = [];
    if (file !== undefined) {
        try {
            accessSync(dirname(file), constants.W_OK);
            const text = existsSync(file) ? readFileSync(file, "utf8").replace(/\n$/, "") : "";
            lines = text === "" ? [] : text.split("\n");
        } catch (e) {
            fail(`cannot write ${file} — ${(e as Error).message}`);
        }
    }
    const reply = await local("POST", `/local/agent-invites/${agent}`);
    if (reply.status !== 200 || typeof reply.json["uri"] !== "string") fail(`invite refused — ${reason(reply)}`);
    // the agent most likely runs on this machine: loopback unless --address says otherwise
    const address = addressFlag ?? `http://${urlHost(askHost())}:${askPort()}`;
    const entries = new Map<string, string | null>([
        ["MIMI_INVITE", reply.json["uri"]],
        ["MIMI_GATEWAY_URL", `${address.replace(/^http/, "ws")}/channel`],
    ]);
    if (file === undefined) {
        for (const [key, value] of entries) out(`${key}=${value}`);
        out(`# put these in ${agent}'s .env, or rerun with --write <path/to/.env>; the invite works once, within 24 hours`);
        return;
    }
    try {
        writeAtomic(file, `${setKeys(lines, entries).join("\n")}\n`);
    } catch (e) {
        fail(`cannot write ${file} — ${(e as Error).message}`);
    }
    out(`wrote MIMI_INVITE and MIMI_GATEWAY_URL to ${file} — the agent picks the invite up within 30 s; it works once, within 24 hours`);
}

/** The MIMI_PUBLIC_URL line of this home's .env: shown, set to a checked origin, or cleared. */
async function publicUrl(): Promise<void> {
    const file = envFile();
    const arg = parsed.positionals[0];
    let origin: string | null = null;
    if (arg !== undefined) {
        try {
            origin = publicOrigin(arg) ?? fail("an empty public URL — to remove it: mimi public-url --clear", 2);
        } catch (e) {
            fail((e as Error).message, 2);
        }
    }
    const real = process.env["MIMI_PUBLIC_URL"];
    if (real !== undefined) process.stderr.write(`note: MIMI_PUBLIC_URL="${real}" in the environment wins over ${file}\n`);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (arg === undefined && !parsed.clear) {
        // the boot's own reader (dotenvx, loaded only here): an encrypted value is decrypted as the boot decrypts it
        const { loadEnv, secret } = await import("../store/env.ts");
        delete process.env["MIMI_PUBLIC_URL"];
        const envError = text === "" ? undefined : loadEnv().error;
        if (envError !== undefined) process.stderr.write(`note: ${envError}\n`);
        const stored = secret("MIMI_PUBLIC_URL")?.trim() || undefined;
        out(`public URL: ${stored ?? "not set"}`);
        try {
            publicOrigin(stored);
        } catch (e) {
            process.stderr.write(`note: ${(e as Error).message} — the gateway will not boot with it\n`);
        }
        return;
    }
    const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
    const next = setKeys(lines, new Map([["MIMI_PUBLIC_URL", origin]]));
    if (origin === null && next.length === lines.length) {
        out("public URL: not set");
        return;
    }
    try {
        ensureDir(home);
        writeAtomic(file, `${next.join("\n")}\n`);
    } catch (e) {
        fail(`cannot write ${file} — ${(e as Error).message}`);
    }
    const running = livePid() !== null || (await ownStatus(askHost())) !== null;
    const restart = origin === null ? "restart the gateway to drop it" : "restart the gateway to use it";
    out(`public URL: ${origin ?? "not set"} — ${running ? restart : "the gateway is not running, nothing to restart"}`);
}

async function pinAction(action: "block" | "unblock"): Promise<void> {
    const reply = await local("POST", `/local/pins/${agent}/${action}`);
    if (reply.status !== 200) fail(`${action} failed — ${reason(reply)}`);
    if (action === "unblock") out(`unblocked ${agent} — it may connect again, with no perms until you grant them in the app`);
    else out(`blocked ${agent} — ${reply.json["closed"] ? `${reply.json["closed"]} channel session(s) dropped` : "it had no live channel session"}`);
}

switch (cmd) {
    case "run":
        // the daemon entry reads its flags off argv: only the gateway flags stay
        process.argv.splice(2, process.argv.length, ...parsed.gateway);
        await import("../daemon.ts");
        break;
    case "start":
        await startGateway();
        break;
    case "stop":
        await stopGateway();
        break;
    case "restart":
        await stopGateway();
        await startGateway();
        break;
    case "status":
        await gatewayStatus();
        break;
    case "pair":
        await pair();
        break;
    case "invite":
        await invite();
        break;
    case "block":
    case "unblock":
        await pinAction(cmd);
        break;
    case "public-url":
        await publicUrl();
        break;
    case "logs":
        logs();
        break;
    default:
        fail(`unknown command "${cmd}" — ${USAGE}`);
}
