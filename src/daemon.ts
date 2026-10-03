/** The gateway process: `mimi start` spawns it, `mimi run` imports it, pm2 runs it — unconditional, since pm2 imports it through a wrapper. */

import { gatewayFlags } from "./flags.ts";
import { startGateway } from "./main.ts";

const log = (msg: string): void => void process.stderr.write(msg);

// a stray socket error must not end the daemon, a broken promise still must
process.on("uncaughtException", (e: Error) => log(`[uncaught] ${e.stack ?? e.message}\n`));
process.on("unhandledRejection", (reason: unknown) => {
    log(`[fatal] unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
    process.exit(1);
});

let flags: ReturnType<typeof gatewayFlags>;
try {
    flags = gatewayFlags(process.argv.slice(2));
} catch (e) {
    log(`${(e as Error).message}\n`);
    process.exit(1);
}
await startGateway(flags).catch((e: unknown) => {
    log(`[fatal] ${(e as Error).message}\n`);
    process.exitCode = 1;
});
