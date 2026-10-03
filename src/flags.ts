/** The `[--host <ip>] [--port <n>] [--lan <host>]` flags both `mimi` and the daemon it spawns read. */

import { isIP } from "node:net";
import { parseArgs } from "node:util";

export interface GatewayOptions {
    host?: string | undefined;
    port?: number | undefined;
    /** A second listener carrying only the channel upgrades — no mini-app door, no bootstrap. */
    lan?: string | undefined;
}

/** Host form accepted by socket APIs. URL-style brackets are valid only around an IPv6 literal. */
export function normalizeHost(host: string): string | null {
    if (host.length === 0 || /\s/.test(host)) return null;
    const opens = host.startsWith("[");
    const closes = host.endsWith("]");
    if (!opens && !closes) return host;
    if (!opens || !closes) return null;
    const inner = host.slice(1, -1);
    return isIP(inner) === 6 ? inner : null;
}

/** Throws on a flag it cannot use; each entry point prints the message and exits 1. */
export function gatewayFlags(args: string[]): GatewayOptions {
    const { host, port, lan } = parseArgs({
        args,
        options: { host: { type: "string" }, port: { type: "string" }, lan: { type: "string" } },
        strict: true,
    }).values;
    const n = Number(port);
    if (port !== undefined && !(Number.isInteger(n) && n >= 1 && n <= 65535)) throw new Error(`bad --port "${port}"`);
    const bindHost = host === undefined ? undefined : normalizeHost(host);
    if (bindHost === null) throw new Error(`bad --host "${host}"`);
    const lanHost = lan === undefined ? undefined : normalizeHost(lan);
    if (lanHost === null) throw new Error(`bad --lan "${lan}"`);
    return { host: bindHost, port: port === undefined ? undefined : n, lan: lanHost };
}

/** A host only this machine reaches: localhost, 127.0.0.0/8, ::1 — bracketed, zoned or v4-mapped.
 *  "0.0.0.0", "::" and every real interface deliberately do not count. */
export function isLoopbackHost(host: string): boolean {
    const normalized = normalizeHost(host);
    if (normalized === null) return false;
    const lower = normalized.toLowerCase();
    const bare = lower.includes(":") ? (lower.split("%")[0] ?? "") : lower;
    const v4 = bare.startsWith("::ffff:") ? bare.slice("::ffff:".length) : bare;
    const octets = v4.split(".");
    return (
        bare === "localhost" ||
        bare === "::1" ||
        bare === "0:0:0:0:0:0:0:1" ||
        (octets.length === 4 &&
            octets[0] === "127" &&
            octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255))
    );
}

/** Dev only: under the app's `pnpm dev` the browser pult lives on vite's loopback port, so the
 *  miniapp CSRF check accepts the origin MIMI_DEV_UI names besides the listener's own. 0 = none. */
export function devUiPort(): number {
    const dev = URL.parse(process.env["MIMI_DEV_UI"] ?? "");
    return dev === null || !isLoopbackHost(dev.hostname) ? 0 : Number(dev.port || 80);
}

/** A host as it appears in a URL authority: IPv6 literals are bracketed. */
export const urlHost = (host: string): string => {
    const normalized = normalizeHost(host) ?? host;
    return normalized.includes(":") ? `[${normalized}]` : normalized;
};

/** MIMI_PUBLIC_URL as the origin the app dials, undefined when unset; throws when it is no http(s) origin.
 *  The boot and `mimi public-url` both apply exactly this rule. */
export function publicOrigin(raw: string | undefined): string | undefined {
    const text = raw?.trim() || undefined;
    if (text === undefined) return undefined;
    const url = URL.parse(text);
    if (url === null || !/^https?:$/.test(url.protocol) || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
        throw new Error(`MIMI_PUBLIC_URL="${text}" is not an address the app can dial — give an http(s) origin like https://mimi.example.com:8443`);
    }
    return url.origin;
}
