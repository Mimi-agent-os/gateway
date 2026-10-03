/** The header policy and server-side cookie jar shared by the browser door (http/mini-app.ts) and
 *  the tunnel door (registry/tunnel.ts), both of which reach an app through apps/bridge.ts. */

import type { AppCookieRow, GatewayDb } from "../store/db.ts";

export type Headers = Record<string, string | string[]>;

const HOP_BY_HOP = new Set(["connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
/** Everything a header value may hold — no CR and no LF, which is what keeps a value that is
 *  written verbatim onto a socket from framing a header of its own. */
export const VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Names lower-cased; hop-by-hop, every header the Connection header names, `proxy-*`, invalid
 *  names/values and `drop` are left out — the one policy for requests and responses alike. */
export function cleanHeaders(raw: unknown, drop: (name: string) => boolean = () => false): Headers {
    // null-prototype: a peer's own `__proto__` header is a legal TOKEN, and on a plain object it
    // would land on Object.prototype's setter instead of becoming a header
    const out: Headers = Object.create(null) as Headers;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
    const entries = Object.entries(raw).map(([name, value]): [string, unknown] => [name.toLowerCase(), value]);
    const named = new Set(
        entries
            .filter(([key]) => key === "connection")
            .flatMap(([, value]) => [value].flat())
            .flatMap((value) => (typeof value === "string" ? value.split(",") : []))
            .map((name) => name.trim().toLowerCase()),
    );
    for (const [key, value] of entries) {
        if (!TOKEN.test(key) || HOP_BY_HOP.has(key) || named.has(key) || key.startsWith("proxy-") || drop(key)) continue;
        if (typeof value === "number") out[key] = String(value);
        else if (typeof value === "string" && VALUE.test(value)) out[key] = value;
        else if (Array.isArray(value) && value.every((v) => typeof v === "string" && VALUE.test(v))) out[key] = value as string[];
    }
    return out;
}

/** Every Set-Cookie line lands in the jar: name=value (malformed lines skipped); Max-Age (seconds)
 *  wins over Expires, and an expiry already past deletes; Path defaults to "/"; Domain, Secure,
 *  HttpOnly, SameSite and Partitioned are ignored — one upstream, and the jar is server-side. */
export function storeSetCookies(db: GatewayDb, agent: string, appId: string, lines: readonly string[]): void {
    const now = Date.now();
    for (const line of lines) {
        const [pair = "", ...attributes] = line.split(";");
        const eq = pair.indexOf("=");
        const cookie: AppCookieRow = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), path: "/", expiresAt: null };
        if (eq < 0 || !TOKEN.test(cookie.name) || !VALUE.test(cookie.value)) continue;
        let maxAge: number | null = null;
        for (const attribute of attributes) {
            const [key = "", ...rest] = attribute.split("=");
            const value = rest.join("=").trim();
            switch (key.trim().toLowerCase()) {
                case "path":
                    cookie.path = value.startsWith("/") ? value : "/";
                    break;
                case "max-age":
                    maxAge = /^-?\d+$/.test(value) ? Number(value) : maxAge;
                    break;
                case "expires":
                    cookie.expiresAt = Number.isNaN(Date.parse(value)) ? cookie.expiresAt : Date.parse(value);
                    break;
            }
        }
        cookie.expiresAt = maxAge === null ? cookie.expiresAt : now + maxAge * 1000;
        if (cookie.expiresAt !== null && cookie.expiresAt <= now) db.deleteAppCookie(agent, appId, cookie.name, cookie.path);
        else db.setAppCookie(agent, appId, cookie);
    }
}
