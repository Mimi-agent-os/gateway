/** Gateway boot: env + db + local token, then the --host listener —
 *  /mini-app, health, the /local routes and channel upgrades on loopback, upgrades only on any other host —
 *  and an optional --lan listener (upgrades only). The /api router sits behind neither — only the
 *  tunnel reaches it. The process entry is daemon.ts. */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { GATEWAY_PORT } from "@mimi-os/protocol";
import { createGatewayCore } from "./core.ts";
import { isLoopbackHost, normalizeHost, publicOrigin, urlHost, type GatewayOptions } from "./flags.ts";
import { gatewayDb } from "./store/db.ts";
import { setTimeZone } from "./store/day.ts";
import { checkEnv, loadEnv, secret } from "./store/env.ts";
import { envFile, home } from "./store/home.ts";
import { channelUpgradeHandler, loopbackHandler, notFound, writeLocalToken } from "./http/listeners.ts";
import { miniAppUpgrade } from "./http/mini-app.ts";
import { fcmAccount } from "./push.ts";

const log = (msg: string): void => void process.stderr.write(msg);

const listen = (server: Server, port: number, host: string): Promise<void> =>
    new Promise((resolve, reject) => {
        const failed = (error: Error): void => {
            server.off("listening", ready);
            reject(error);
        };
        const ready = (): void => {
            server.off("error", failed);
            resolve();
        };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(port, host);
    });

const closing = (server: Server | null): Promise<void> => {
    if (!server?.listening) return Promise.resolve();
    return new Promise((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
    });
};

export async function startGateway(opts: GatewayOptions = {}): Promise<void> {
    const rawHost = opts.host ?? "127.0.0.1";
    const HOST = normalizeHost(rawHost);
    if (HOST === null) throw new Error(`bad host "${rawHost}"`);
    const LAN = opts.lan === undefined ? undefined : normalizeHost(opts.lan);
    if (LAN === null) throw new Error(`bad LAN host "${opts.lan}"`);
    const PORT = opts.port ?? GATEWAY_PORT;
    if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`bad port "${PORT}"`);
    if (checkEnv().created) log(`[env] created ${envFile()} — add model API keys there if needed\n`);
    const envError = loadEnv().error;
    if (envError) log(`[env] ${envError}\n`);
    // every "today" (usage days, model limits) is the owner's calendar day: refuse to boot on a bad zone
    log(`[day] days run in ${setTimeZone(secret("MIMI_TZ"))}\n`);
    const publicUrl = publicOrigin(secret("MIMI_PUBLIC_URL"));
    if (publicUrl !== undefined) log(`[pair] links name ${publicUrl}\n`);
    const fcm = fcmAccount(secret("FCM_SERVICE_ACCOUNT_KEY"));
    log(fcm === undefined ? "[push] off: FCM_SERVICE_ACCOUNT_KEY is not set\n" : `[push] phones are woken through FCM project ${fcm.projectId}\n`);
    const db = gatewayDb();
    let core: ReturnType<typeof createGatewayCore>;
    try {
        core = createGatewayCore({ db, log, push: { account: fcm } });
    } catch (e) {
        db.close();
        throw e;
    }
    const handle = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => core.handleUpgrade(req, socket, head);
    const loopback = isLoopbackHost(HOST);
    // the miniapp upgrade branch exists exactly where the miniapp HTTP handler does: on any other
    // host this listener answers 404 to every /mini-app request, so it must refuse the upgrade too
    const upgrades = channelUpgradeHandler(handle, loopback ? miniAppUpgrade(core, PORT) : undefined);
    const server = createServer(loopback ? loopbackHandler(core, { host: HOST, port: PORT, lan: LAN, publicUrl }) : notFound);
    server.on("upgrade", upgrades);
    const lan: Server | null = LAN === undefined ? null : createServer(notFound);
    lan?.on("upgrade", channelUpgradeHandler(handle));
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
        if (cleaned) return;
        cleaned = true;
        // Stop accepting first, close upgraded channel sockets through core, then await the listeners.
        const listeners = [closing(server), closing(lan)];
        try {
            await core.stop();
        } finally {
            await Promise.all(listeners);
            db.close();
        }
    };
    let binding = `${urlHost(HOST)}:${PORT}`;
    try {
        await listen(server, PORT, HOST);
        if (lan && LAN !== undefined) {
            binding = `${urlHost(LAN)}:${PORT}`;
            await listen(lan, PORT, LAN);
        }
    } catch (e) {
        const error = e as NodeJS.ErrnoException;
        await cleanup();
        throw new Error(
            error.code === "EADDRINUSE"
                ? `${binding} is already taken — another gateway or program holds the port: stop it, or pick another with --port <n>`
                : `listen failed on ${binding}: ${error.message}`,
            { cause: error },
        );
    }
    try {
        // A process that never owned its sockets must never replace the live process's token.
        writeLocalToken();
    } catch (e) {
        await cleanup();
        throw new Error(`cannot initialize the local token: ${(e as Error).message}`, { cause: e });
    }
    const base = `http://${urlHost(HOST)}:${PORT}`;
    log(`mimi gateway — ${base} — channel${loopback ? " + local api" : " only"} — home ${home}\n`);
    if (lan && LAN !== undefined) log(`[lan] ${urlHost(LAN)}:${PORT} — channel only\n`);
    let shuttingDown = false;
    function shutdown(signal: string): void {
        if (shuttingDown) {
            log(`\n[shutdown] ${signal} again — exiting now\n`);
            process.exit(130);
        }
        shuttingDown = true;
        void (async () => {
            try {
                await cleanup();
                process.exit(0);
            } catch (e) {
                log(`[fatal] shutdown failed: ${(e as Error).stack ?? (e as Error).message}\n`);
                process.exit(1);
            }
        })();
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => shutdown(signal));
}
