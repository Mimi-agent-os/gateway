/** Tiny method+path dispatcher over node:http, and the response/body helpers every route uses. */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AGENT_NAME_SOURCE, INVITE_ID_SOURCE } from "@mimi-os/protocol";

import { MODEL_NAME_PATTERN } from "../llm/models.ts";

export interface Ctx {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    method: string;
    /** The device whose channel carried this request, or null off the tunnel (the loopback surface). */
    device: string | null;
    /** A `:name` segment of the matched template, URL-decoded. Throws if the template has no such name. */
    param: (name: string) => string;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

/** Every `:name` a route template may use, and the ONE place each charset is written down. */
const SEGMENTS = {
    agent: AGENT_NAME_SOURCE,
    pin: "[a-z][a-z0-9_-]*",
    gate: "[0-9a-f]{8,64}",
    room: "[0-9a-f]{8,64}",
    request: "[0-9a-f]{8,64}",
    interaction: "[0-9a-f]{8,64}",
    appsession: "[0-9a-f]{8,64}",
    device: "[0-9a-v]{16}",
    invite: INVITE_ID_SOURCE,
    model: MODEL_NAME_PATTERN,
    id: "\\d+",
    session: "\\d+",
    item: "\\d+",
    key: "[^/]+",
} as const satisfies Record<string, string>;

const NUMERIC_SEGMENTS = new Set(["id", "session", "item"]);

function compile(template: string): { pattern: RegExp; names: string[] } {
    if (!template.startsWith("/")) throw new Error(`route "${template}" must start with "/"`);
    const names: string[] = [];
    const body = template
        .slice(1)
        .split("/")
        .map((seg) => {
            if (!seg.startsWith(":")) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const name = seg.slice(1);
            const charset = (SEGMENTS as Record<string, string | undefined>)[name];
            if (charset === undefined) throw new Error(`route "${template}": unknown segment ":${name}"`);
            if (names.includes(name)) throw new Error(`route "${template}": ":${name}" twice`);
            names.push(name);
            return `(${charset})`;
        })
        .join("\\/");
    return { pattern: new RegExp(`^\\/${body}$`), names };
}

const decode = (raw: string): string => {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
};

interface Route {
    method: string;
    template: string;
    pattern: RegExp;
    names: string[];
    handler: Handler;
}

export class Router {
    private readonly routes: Route[] = [];

    private add(method: string, template: string, handler: Handler): this {
        this.routes.push({ method, template, ...compile(template), handler });
        return this;
    }

    get(template: string, handler: Handler): this {
        return this.add("GET", template, handler);
    }
    post(template: string, handler: Handler): this {
        return this.add("POST", template, handler);
    }
    put(template: string, handler: Handler): this {
        return this.add("PUT", template, handler);
    }
    patch(template: string, handler: Handler): this {
        return this.add("PATCH", template, handler);
    }
    delete(template: string, handler: Handler): this {
        return this.add("DELETE", template, handler);
    }

    /** true = a route matched the path (handled, or answered 405); false = try the next layer. */
    async dispatch(req: IncomingMessage, res: ServerResponse, device: string | null = null): Promise<boolean> {
        const url = new URL(req.url ?? "/", "http://localhost");
        // a path the parser rewrites (dot-segments, "\", "//") would match a route it never named: refused, never resolved
        if (((req.url ?? "/").split(/[?#]/, 1)[0] ?? "") !== url.pathname) {
            json(res, 400, { error: "the path must be in normal form: no dot-segments" });
            return true;
        }
        const method = req.method ?? "GET";
        let pathMatched = false;
        for (const r of this.routes) {
            const m = r.pattern.exec(url.pathname);
            if (!m) continue;
            pathMatched = true;
            if (r.method !== method) continue;
            const bound = new Map(r.names.map((name, i) => [name, decode(m[i + 1] ?? "")]));
            const unsafe = r.names.find((name) => NUMERIC_SEGMENTS.has(name) && !Number.isSafeInteger(Number(bound.get(name))));
            if (unsafe !== undefined) {
                json(res, 400, { error: `:${unsafe} is outside the safe integer range` });
                return true;
            }
            const param = (name: string): string => {
                const v = bound.get(name);
                if (v === undefined) throw new Error(`route "${r.template}" has no ":${name}"`);
                return v;
            };
            try {
                await r.handler({ req, res, url, method, device, param });
            } catch (e) {
                if (!(e instanceof BodyError) || res.headersSent) throw e;
                json(res, 400, { error: e.message });
            }
            return true;
        }
        if (pathMatched) {
            json(res, 405, { error: "method not allowed" });
            return true;
        }
        return false;
    }
}

/** For the handlers that never see a path parameter — the static ones, wired outside the router. */
export const noParams = (name: string): never => {
    throw new Error(`":${name}" is not available here`);
};

export function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

const BODY_MAX = 1_000_000;

/** A body the client got wrong — the dispatcher answers it 400 for every route that reads one. */
class BodyError extends Error {}

/** `max` overrides the 1 MB default for the few routes that carry bulk (image data-URIs on a turn). */
export function readBody(req: IncomingMessage, max = BODY_MAX): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > max) {
                reject(new BodyError("body too large"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            try {
                const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                    throw new Error("body must be a JSON object");
                }
                resolve(parsed as Record<string, unknown>);
            } catch (e) {
                reject(new BodyError((e as Error).message));
            }
        });
        req.on("error", reject);
    });
}

/** UTC "YYYY-MM-DD HH:MM:SS" — the stamp convention every other gateway timestamp already uses. */
export const isoStamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** limit/before paging as the message routes read it: both optional, both validated in ONE place. */
export type Page = { limit: number; before?: number };

export const pageOf = (q: URLSearchParams, defaultLimit: number): Page | string => {
    const limit = Number(q.get("limit") ?? String(defaultLimit));
    if (!Number.isSafeInteger(limit) || limit < 1) return "limit must be a positive integer";
    const rawBefore = q.get("before");
    if (rawBefore === null) return { limit };
    const before = Number(rawBefore);
    if (!Number.isSafeInteger(before) || before < 1) return "before must be a message id";
    return { limit, before };
};
