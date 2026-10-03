import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const daemon = resolve(import.meta.dirname, "../src/daemon.ts");

interface GatewayProcess {
    child: ChildProcess;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    output: () => string;
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no address");
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    return address.port;
}

// freePort's port can be taken by a parallel test file before the child binds it, so a collision retries on a new one
async function onFreePort(start: (port: number) => GatewayProcess): Promise<{ proc: GatewayProcess; port: number }> {
    for (let attempt = 1; ; attempt++) {
        const port = await freePort();
        const proc = start(port);
        const settled = (): boolean => /mimi gateway —|is already taken/.test(proc.output()) || proc.child.exitCode !== null || proc.child.signalCode !== null;
        while (!settled()) await delay(10);
        if (!proc.output().includes("is already taken") || attempt === 5) return { proc, port };
        await outcome(proc);
    }
}

function track(child: ChildProcess): GatewayProcess {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += String(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => (output += String(chunk)));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    return { child, exited, output: () => output };
}

function launch(home: string, port: number, extra: string[] = [], nodeArgs: string[] = []): GatewayProcess {
    return track(
        spawn(
            process.execPath,
            ["--disable-warning=ExperimentalWarning", ...nodeArgs, daemon, "--host", "127.0.0.1", "--port", String(port), ...extra],
            {
                env: { ...process.env, MIMI_HOME: home },
                stdio: ["ignore", "pipe", "pipe"],
            },
        ),
    );
}

async function outcome(proc: GatewayProcess, timeoutMs = 5000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const timedOut = Symbol("timed out");
    const timeout = new Promise<typeof timedOut>((resolveTimeout) => {
        setTimeout(() => resolveTimeout(timedOut), timeoutMs).unref();
    });
    const result = await Promise.race([proc.exited, timeout]);
    assert.notEqual(result, timedOut, `gateway did not exit:\n${proc.output()}`);
    return result as { code: number | null; signal: NodeJS.Signals | null };
}

async function stop(proc: GatewayProcess): Promise<void> {
    if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill("SIGTERM");
    await outcome(proc);
}

async function ready(port: number): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200) return;
        } catch {
            // The socket is not bound yet.
        }
        await delay(20);
    }
    throw new Error(`gateway did not become ready on port ${port}`);
}

test("the daemon boots when a supervisor's wrapper imports it, the way pm2's fork container does", { timeout: 15_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-main-pm2-"));
    // pm2 fork mode spawns `node ProcessContainerFork.js <args>`, which import()s the app: argv[1] is the wrapper
    const wrapper = join(home, "ProcessContainerFork.cjs");
    writeFileSync(wrapper, `import(require("node:url").pathToFileURL(process.env.pm_exec_path));\n`);
    const { proc, port } = await onFreePort((p) =>
        track(
            spawn(process.execPath, ["--disable-warning=ExperimentalWarning", wrapper, "--host", "127.0.0.1", "--port", String(p)], {
                env: { ...process.env, MIMI_HOME: home, pm_exec_path: daemon },
                stdio: ["ignore", "pipe", "pipe"],
            }),
        ),
    );
    try {
        await ready(port);
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
        assert.equal(proc.child.exitCode, null, proc.output());
    } finally {
        await stop(proc);
        rmSync(home, { recursive: true, force: true });
    }
});

test("a failed second start cannot replace the live gateway's local token", { timeout: 15_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-main-token-"));
    const { proc: first, port } = await onFreePort((p) => launch(home, p));
    let second: GatewayProcess | null = null;
    try {
        await ready(port);
        const tokenFile = join(home, ".local-token");
        assert.equal(existsSync(tokenFile), true);
        const token = readFileSync(tokenFile, "utf8");

        second = launch(home, port);
        assert.notEqual((await outcome(second)).code, 0, second.output());
        assert.equal(readFileSync(tokenFile, "utf8"), token);

        const invite = await fetch(`http://127.0.0.1:${port}/local/invite`, {
            method: "POST",
            headers: { authorization: `Bearer ${token.trim()}` },
        });
        assert.equal(invite.status, 200);
    } finally {
        if (second && second.child.exitCode === null && second.child.signalCode === null) await stop(second);
        await stop(first);
        rmSync(home, { recursive: true, force: true });
    }
});

test("a failed LAN bind stops the gateway and writes no token", { timeout: 15_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-main-lan-"));
    const port = await freePort();
    const proc = launch(home, port, ["--lan", "127.0.0.1"]);
    try {
        assert.notEqual((await outcome(proc)).code, 0, proc.output());
        assert.match(proc.output(), /already taken/);
        assert.equal(existsSync(join(home, ".local-token")), false);
    } finally {
        if (proc.child.exitCode === null && proc.child.signalCode === null) await stop(proc);
        rmSync(home, { recursive: true, force: true });
    }
});

test("the daemon logs a stray uncaught exception and keeps serving", { timeout: 15_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-main-uncaught-"));
    const stray = "data:text/javascript,setTimeout(()=>{throw new Error('stray probe')},300)";
    const { proc, port } = await onFreePort((p) => launch(home, p, [], ["--import", stray]));
    try {
        await ready(port);
        const deadline = Date.now() + 5000;
        while (!proc.output().includes("stray probe") && Date.now() < deadline) await delay(20);
        assert.match(proc.output(), /\[uncaught\][^\n]*stray probe/);
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
        assert.equal(proc.child.exitCode, null);
    } finally {
        await stop(proc);
        rmSync(home, { recursive: true, force: true });
    }
});

test("the daemon still dies on an unhandled rejection", { timeout: 15_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-main-daemon-fatal-"));
    const broken = "data:text/javascript,setTimeout(()=>{Promise.reject(new Error('rejected probe'))},300)";
    const { proc } = await onFreePort((p) => launch(home, p, [], ["--import", broken]));
    try {
        assert.notEqual((await outcome(proc, 10_000)).code, 0, proc.output());
        assert.match(proc.output(), /rejected probe/);
    } finally {
        if (proc.child.exitCode === null && proc.child.signalCode === null) await stop(proc);
        rmSync(home, { recursive: true, force: true });
    }
});

test("SIGTERM closes an upgraded channel socket before awaiting the listener", { timeout: 15_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-main-shutdown-"));
    const { proc, port } = await onFreePort((p) => launch(home, p));
    let socket: WebSocket | null = null;
    try {
        await ready(port);
        socket = new WebSocket(`ws://127.0.0.1:${port}/channel`);
        await new Promise<void>((resolveOpen, reject) => {
            socket!.onopen = () => resolveOpen();
            socket!.onerror = () => reject(new Error("channel socket failed to open"));
        });

        const closed = new Promise<void>((resolveClose) => socket!.addEventListener("close", () => resolveClose(), { once: true }));
        proc.child.kill("SIGTERM");
        assert.equal((await outcome(proc)).code, 0, proc.output());
        await closed;
        assert.equal(socket.readyState, WebSocket.CLOSED);
    } finally {
        socket?.close();
        if (proc.child.exitCode === null && proc.child.signalCode === null) await stop(proc);
        rmSync(home, { recursive: true, force: true });
    }
});

test("MIMI_TZ in the home .env sets the owner's day, and a zone that is not IANA refuses to boot", { timeout: 15_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-main-tz-"));
    try {
        writeFileSync(join(home, ".env"), "MIMI_TZ=Mars/Base\n", { mode: 0o600 });
        const bad = launch(home, await freePort());
        assert.notEqual((await outcome(bad)).code, 0, bad.output());
        assert.match(bad.output(), /MIMI_TZ="Mars\/Base" is not an IANA time zone/);
        assert.equal(existsSync(join(home, ".local-token")), false, "nothing started");

        writeFileSync(join(home, ".env"), "MIMI_TZ=Europe/Helsinki\n", { mode: 0o600 });
        const { proc, port } = await onFreePort((p) => launch(home, p));
        try {
            await ready(port);
            assert.match(proc.output(), /\[day\] days run in Europe\/Helsinki/);
        } finally {
            await stop(proc);
        }
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("FCM_SERVICE_ACCOUNT_KEY: a malformed key refuses to boot without quoting it, a key file on one line turns push on, none turns it off", { timeout: 15_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "mimi-main-fcm-"));
    const key = { project_id: "mimi-test-1", client_email: "push@mimi-test-1.iam.gserviceaccount.com", private_key: "S3CR3T" };
    try {
        writeFileSync(join(home, ".env"), `FCM_SERVICE_ACCOUNT_KEY='${JSON.stringify(key)}'\n`, { mode: 0o600 });
        const bad = launch(home, await freePort());
        assert.notEqual((await outcome(bad)).code, 0, bad.output());
        assert.match(bad.output(), /FCM_SERVICE_ACCOUNT_KEY has no RSA private_key in PEM/);
        assert.doesNotMatch(bad.output(), /S3CR3T/);
        assert.equal(existsSync(join(home, ".local-token")), false, "nothing started");

        const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
        writeFileSync(join(home, ".env"), `FCM_SERVICE_ACCOUNT_KEY='${JSON.stringify({ ...key, private_key: pem })}'\n`, { mode: 0o600 });
        const on = await onFreePort((p) => launch(home, p));
        try {
            await ready(on.port);
            assert.match(on.proc.output(), /\[push\] phones are woken through FCM project mimi-test-1\n/);
            assert.doesNotMatch(on.proc.output(), /PRIVATE KEY/);
        } finally {
            await stop(on.proc);
        }

        writeFileSync(join(home, ".env"), "", { mode: 0o600 });
        const off = await onFreePort((p) => launch(home, p));
        try {
            await ready(off.port);
            assert.deepEqual(off.proc.output().match(/\[push\].*\n/g), ["[push] off: FCM_SERVICE_ACCOUNT_KEY is not set\n"]);
        } finally {
            await stop(off.proc);
        }
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
