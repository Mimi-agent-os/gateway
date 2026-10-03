/** Gateway's home paths: MIMI_HOME, else `mimi/` next to this package — never the cwd, so the CLI and the daemon agree wherever they run. */
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// src/store/home.ts and dist/store/home.js both sit two levels under the package root
export const home = process.env["MIMI_HOME"] ? resolve(process.env["MIMI_HOME"]) : join(import.meta.dirname, "..", "..", "mimi");

export const gatewayDbFile = (): string => join(home, "gateway.db");
export const envFile = (): string => join(home, ".env");
/** dotenvx keeps the private half of the .env keypair here, next to the ciphertext it decrypts. */
export const keysFile = (): string => join(home, ".env.keys");

let tmpSeq = 0;

// 0700: the home holds the db, the .env keypair and the channel key — no other local user's business
export function ensureDir(dir: string): string {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

// write-then-rename (atomic same-filesystem swap); the temp file is created with the mode the result
// must have — the given one, else the target's own, else 0600 — so a secret is never world-readable.
export function writeAtomic(path: string, text: string, mode?: number): void {
    // A configured secret/token file may be a symlink. Swap its resolved target so updating it
    // does not silently replace the link and detach the configuration from its shared secret.
    const target = existsSync(path) ? realpathSync(path) : path;
    const create = mode ?? (existsSync(target) ? statSync(target).mode & 0o777 : 0o600);
    const tmp = `${target}.${process.pid}.${(tmpSeq++).toString(36)}.tmp`;
    try {
        writeFileSync(tmp, text, { encoding: "utf8", mode: create });
        renameSync(tmp, target);
    } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}
