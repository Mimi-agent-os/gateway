/** Gateway's global secrets — mimi/.env singleton (dotenvx-encrypted), scaffolded on first run. */
import { chmodSync, existsSync, readFileSync } from "node:fs";

import { config as dotenvxConfig, set as dotenvxSet, type SetOptions } from "@dotenvx/dotenvx";

import { ensureDir, envFile, home, keysFile, writeAtomic } from "./home.ts";

export interface EnvLoad {
    loaded: number;
    error?: string;
}

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const ENV_TEMPLATE =
    "# mimi/.env — provider keys (KEY=VALUE per line).\n" +
    "# Real environment variables take precedence over values set here.\n";

let secrets: Readonly<Record<string, string>> = Object.freeze({});

/** Every mutation (and startup check) leaves the gateway's secret files owner-readable only:
 *  .env holds hand-written keys, .env.keys the private key that decrypts the encrypted ones. */
function privateEnvFile(): string {
    for (const path of [envFile(), keysFile()]) if (existsSync(path)) chmodSync(path, 0o600);
    return envFile();
}

function quietSet(path: string, key: string, value: string): void {
    const result = dotenvxSet(key, value, { path, quiet: true } as SetOptions) as {
        processedEnvs?: Array<{ error?: Error }>;
    };
    const failed = result.processedEnvs?.find((p) => p.error);
    if (failed?.error) throw failed.error;
    // dotenvx (re)creates .env.keys itself, at the umask default
    privateEnvFile();
}

// falls back to a real env var the file never defined — `export FOO=…` still works
export function secret(key: string): string | undefined {
    return secrets[key] ?? process.env[key];
}

export function hasSecret(key: string): boolean {
    return secret(key) !== undefined;
}

export function checkEnv(): { created: boolean } {
    const file = privateEnvFile();
    if (existsSync(file)) return { created: false };
    ensureDir(home);
    writeAtomic(file, ENV_TEMPLATE, 0o600);
    // a throwaway seed makes dotenvx generate + write the keypair, then the seed line is dropped
    quietSet(file, "MIMI_SEED", "1");
    const keyed = readFileSync(file, "utf8").replace(/^MIMI_SEED=.*\r?\n?/m, "");
    writeAtomic(file, keyed);
    return { created: true };
}

export function loadEnv(override = false): EnvLoad {
    const throwaway: Record<string, string> = {};
    const result = dotenvxConfig({ path: envFile(), quiet: true, processEnv: throwaway });
    const parsed = result.parsed ?? {};
    // dotenvx's own keypair lines are infrastructure, not secrets anyone asked for
    const keys = Object.keys(parsed).filter(
        (k) => !k.startsWith("DOTENV_PUBLIC_KEY") && !k.startsWith("DOTENV_PRIVATE_KEY"),
    );
    const loaded = keys.length;
    if (result.error) return { loaded, error: result.error.message };

    if (Object.values(parsed).some((v) => v.startsWith("encrypted:"))) {
        return {
            loaded,
            error: "encrypted .env but DOTENV_PRIVATE_KEY/.env.keys missing — values not decrypted",
        };
    }
    const next: Record<string, string> = {};
    for (const key of keys) {
        const value = parsed[key];
        if (value === undefined) continue;
        const real = process.env[key];
        next[key] = !override && real !== undefined ? real : value;
    }
    secrets = Object.freeze(next);
    return { loaded };
}

export function setEnv(key: string, value: string): { ok: boolean; error?: string } {
    try {
        quietSet(privateEnvFile(), key, value);
        secrets = Object.freeze({ ...secrets, [key]: value });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

export function unsetEnv(key: string): boolean {
    if (!ENV_KEY.test(key)) return false;
    const file = privateEnvFile();
    if (!existsSync(file)) return false;
    const text = readFileSync(file, "utf8");
    const re = new RegExp(`^(?:export\\s+)?${key}=.*\\r?\\n?`, "m");
    if (!re.test(text)) return false;
    writeAtomic(file, text.replace(re, ""));
    const { [key]: _gone, ...rest } = secrets;
    secrets = Object.freeze(rest);
    return true;
}
