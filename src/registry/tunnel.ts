/** Channel streams > 0 as tunnels: in-process API requests, per-(device, app) grants, and app
 *  requests handed to apps/bridge.ts, which carries them to the agent over its own channel. */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { IncomingMessage, ServerResponse, type IncomingHttpHeaders } from "node:http";
import { Socket } from "node:net";

import { APP_CHUNK, APP_STALL_MS, DEVICE_CREDIT, DEVICE_WINDOW, FLAG_DATA, FLAG_END, FLAG_RESET } from "@mimi-os/protocol";

import { cleanHeaders, type Headers } from "../apps/headers.ts";
import type { GatewayCore } from "../core.ts";
import { buildRouter } from "../http/index.ts";
import { json, type Router } from "../http/router.ts";
import type { AppStreamContext } from "./devices.ts";

const MAX_BUFFERED = 256 * 1024;
const EMPTY = new Uint8Array(0);
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };
/** Every refusal this door can render, from one table — the body is the reason phrase itself. */
const REASON: Record<number, string> = {
    403: "Forbidden",
    404: "Not Found",
    414: "URI Too Long",
    431: "Request Header Fields Too Large",
    501: "Not Implemented",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
};

interface Tunnel {
    clientEnded: boolean;
    serverEnded: boolean;
    body(chunk: Buffer): void;
    end(): void;
    abort(): void;
    /** The device took DEVICE_CREDIT more reply bytes (app streams; a no-op elsewhere). */
    credit(): void;
}

export function createTunnels(core: GatewayCore): (ctx: AppStreamContext) => void {
    const sessions = new WeakMap<object, Map<number, Tunnel>>();
    let router: Router | null = null;

    return (ctx) => {
        let streams = sessions.get(ctx.session);
        if (!streams) {
            streams = new Map();
            sessions.set(ctx.session, streams);
        }
        const { stream, frame } = ctx;
        const live = streams.get(stream);
        if (live) {
            if (frame.flags === FLAG_RESET) {
                streams.delete(stream);
                live.abort();
                return;
            }
            if (frame.flags === FLAG_DATA && frame.payload.length === 0) {
                live.credit();
                return;
            }
            if (frame.payload.length > 0) live.body(Buffer.from(frame.payload));
            if (frame.flags === FLAG_END && !live.clientEnded) {
                live.clientEnded = true;
                live.end();
                if (live.serverEnded && streams.get(stream) === live) streams.delete(stream);
            }
            return;
        }
        if (frame.flags !== FLAG_DATA) {
            if (frame.flags === FLAG_END) ctx.close();
            return;
        }

        let header: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload));
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            header = parsed as Record<string, unknown>;
        } catch {
            ctx.close();
            return;
        }
        const kind = header["t"];
        const method = header["method"];
        const path = header["path"];
        const raw = header["headers"];
        const request = kind === "api" || kind === "app";
        const upgradeHeader = raw !== null && typeof raw === "object" && Object.keys(raw).some((k) => k.toLowerCase() === "upgrade");
        // `upgrade: true` is how an app stream asks for a raw socket, and it must carry the header it names
        const upgrade = header["upgrade"] === true;
        if (
            (kind !== "app_grant" && !request) ||
            (request && (typeof method !== "string" || !/^[A-Z]{1,16}$/.test(method))) ||
            (request && (typeof path !== "string" || !path.startsWith("/"))) ||
            (header["upgrade"] !== undefined && (!upgrade || kind !== "app" || !upgradeHeader))
        ) {
            ctx.close();
            return;
        }

        const own = streams;
        const t: Tunnel = {
            clientEnded: false,
            serverEnded: false,
            body: () => undefined,
            end: () => undefined,
            abort: () => undefined,
            credit: () => undefined,
        };
        own.set(stream, t);
        /** false once the device's stream is over its queued-bytes watermark — pause what produced it. */
        const data = (bytes: Uint8Array): boolean => {
            let ready = true;
            for (let i = 0; i < bytes.length; i += APP_CHUNK) {
                ready = ctx.send({ stream, flags: FLAG_DATA, payload: bytes.subarray(i, i + APP_CHUNK) });
            }
            return ready;
        };
        const head = (status: number, headers: Headers): void => {
            ctx.send({
                stream,
                flags: FLAG_DATA,
                payload: Buffer.from(JSON.stringify({ t: "head", status, headers }), "utf8"),
            });
        };
        const finish = (): void => {
            if (t.serverEnded) return;
            t.serverEnded = true;
            ctx.send({ stream, flags: FLAG_END, payload: new Uint8Array(0) });
            if (t.clientEnded && own.get(stream) === t) own.delete(stream);
        };
        const reset = (): void => {
            if (own.get(stream) === t) own.delete(stream);
            t.abort();
            ctx.close();
        };
        const answer = (status: number, headers: Headers, body: Uint8Array): void => {
            head(status, headers);
            data(body);
            finish();
        };
        const refuse = (status: number): void => {
            const text = Buffer.from(REASON[status] ?? "Error", "utf8");
            answer(status, { "content-type": "text/plain; charset=utf-8", "content-length": String(text.length), ...NO_STORE }, text);
        };
        if (request && upgradeHeader && !upgrade) {
            answer(501, { "content-type": "text/plain; charset=utf-8", ...NO_STORE }, Buffer.from("Not Implemented"));
            return;
        }
        // ── app_grant: a reply like any other, a JSON body under a 200 head ─────
        if (kind === "app_grant") {
            const row = typeof header["appId"] === "string" ? core.db.getAgentAppById(header["appId"]) : null;
            // the catalog row outlives the pin, so admission is checked here, not at describe time
            if (!row || core.registry.statusOf(row.agent) !== "approved") return refuse(403);
            const credential = randomBytes(32);
            core.db.setDeviceAppGrant(ctx.deviceId, row.appId, createHash("sha256").update(credential).digest("hex"));
            const body = Buffer.from(JSON.stringify({ appId: row.appId, credential: credential.toString("base64") }), "utf8");
            credential.fill(0);
            answer(200, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), ...NO_STORE }, body);
            return;
        }
        const target = path as string;

        // ── api: the gateway's own router, in-process ─────────────────────
        if (kind === "api") {
            let pathname: string;
            try {
                pathname = new URL(target, "http://localhost").pathname;
            } catch {
                pathname = "";
            }
            // an ACTIVE device session only — the channel core itself refuses a stream > 0 on a
            // pending device or on an agent role (see registry/devices.ts), so nothing else gates it here
            if (!pathname.startsWith("/api/")) {
                const body = Buffer.from(JSON.stringify({ error: "not available over the channel" }), "utf8");
                answer(403, { "content-type": "application/json; charset=utf-8" }, body);
                return;
            }
            const req = new IncomingMessage(new Socket());
            req.method = method as string;
            req.url = target;
            req.httpVersion = "1.1";
            req.httpVersionMajor = 1;
            req.httpVersionMinor = 1;
            req.headers = cleanHeaders(raw, (k) => k.startsWith("x-mimi-")) as IncomingHttpHeaders;
            const res = new ServerResponse(req);
            let done = false;
            const rawWriteHead = res.writeHead.bind(res);
            const after = (cb: unknown): void => {
                if (typeof cb === "function") process.nextTick(cb as () => void);
            };
            res.writeHead = ((status: number, ...rest: unknown[]) => {
                const hdrs = typeof rest[0] === "string" ? rest[1] : rest[0];
                if (typeof rest[0] === "string") res.statusMessage = rest[0];
                if (hdrs !== null && typeof hdrs === "object" && !Array.isArray(hdrs)) {
                    for (const [k, v] of Object.entries(hdrs)) {
                        if (v !== undefined) res.setHeader(k, v as string | number | string[]);
                    }
                }
                rawWriteHead(status);
                const out: Headers = {};
                for (const [k, v] of Object.entries(res.getHeaders())) {
                    if (v !== undefined) out[k] = Array.isArray(v) ? v : String(v);
                }
                if (!done) head(status, out);
                return res;
            }) as ServerResponse["writeHead"];
            const chunkOf = (chunk: unknown, enc: unknown): Buffer =>
                typeof chunk === "string"
                    ? Buffer.from(chunk, typeof enc === "string" ? (enc as BufferEncoding) : "utf8")
                    : Buffer.from(chunk as Uint8Array);
            res.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
                if (done) return false;
                if (!res.headersSent) res.writeHead(res.statusCode);
                const ready = data(chunkOf(chunk, enc));
                after(typeof enc === "function" ? enc : cb);
                if (!ready) ctx.onDrain(() => res.emit("drain"));
                return ready;
            }) as ServerResponse["write"];
            res.end = ((chunk?: unknown, enc?: unknown, cb?: unknown) => {
                if (done) return res;
                if (!res.headersSent) res.writeHead(res.statusCode);
                if (chunk !== undefined && chunk !== null && typeof chunk !== "function") data(chunkOf(chunk, enc));
                done = true;
                finish();
                after(typeof chunk === "function" ? chunk : typeof enc === "function" ? enc : cb);
                process.nextTick(() => {
                    res.emit("finish");
                    res.emit("close");
                });
                return res;
            }) as ServerResponse["end"];
            t.body = (chunk) => {
                req.push(chunk);
                if (req.readableLength > MAX_BUFFERED) reset();
            };
            t.end = () => {
                req.complete = true;
                req.push(null);
            };
            t.abort = () => {
                if (done) return;
                done = true;
                res.emit("close");
                if (req.listenerCount("error") > 0) req.destroy(new Error("aborted"));
                else req.destroy();
            };
            router ??= buildRouter(core);
            const dispatching = router.dispatch(req, res, ctx.deviceId);
            dispatching
                .then((handled) => {
                    if (!handled && !done) json(res, 404, { error: "not found" });
                })
                .catch((e: unknown) => {
                    if (done) return;
                    if (!res.headersSent) json(res, 500, { error: (e as Error).message });
                    else res.end();
                });
            return;
        }

        // ── app: the grant names the app, the bridge carries it to the agent ─────
        const grant = typeof header["appId"] === "string" ? core.db.getDeviceAppGrant(ctx.deviceId, header["appId"]) : null;
        const presented = typeof header["credential"] === "string" ? Buffer.from(header["credential"], "base64") : Buffer.alloc(0);
        const got = createHash("sha256").update(presented).digest();
        const want = grant && /^[0-9a-f]{64}$/.test(grant.credentialHash) ? Buffer.from(grant.credentialHash, "hex") : Buffer.alloc(32);
        const matched = timingSafeEqual(got, want) && grant !== null;
        const row = matched ? core.db.getAgentAppById(grant.appId) : null;
        // a grant minted before the pin was blocked or revoked forwards nothing, and an app this
        // door does not know is 403 here rather than the bridge's 404 — a grant names no other app
        if (!row || core.registry.statusOf(row.agent) !== "approved") return refuse(403);

        // reply direction: held while the device has no window or the connection is over its watermark
        const held: Uint8Array[] = [];
        let unacked = 0;
        let congested = false;
        let resume: (() => void) | null = null;
        let headSeen = false;
        let ending = false;
        /** The agent reset after its END: the reply is whole, so what is held still goes out, then the RESET. */
        let aborted = false;
        /** Held bytes that stop moving reset the stream: the agent may be done, and its bridge's stall with it. */
        let stall: NodeJS.Timeout | null = null;
        const flush = (): void => {
            let moved = false;
            while (held.length > 0 && unacked < DEVICE_WINDOW && !congested) {
                const next = held[0] as Uint8Array;
                const slice = next.subarray(0, APP_CHUNK);
                if (slice.length === next.length) held.shift();
                else held[0] = next.subarray(APP_CHUNK);
                unacked += slice.length;
                moved = true;
                if (!ctx.send({ stream, flags: FLAG_DATA, payload: slice })) {
                    congested = true;
                    ctx.onDrain(() => {
                        congested = false;
                        flush();
                        wake();
                    });
                }
            }
            if (held.length === 0) {
                if (stall) clearTimeout(stall);
                stall = null;
            } else if (!stall) stall = setTimeout(reset, APP_STALL_MS).unref();
            else if (moved) stall.refresh();
            if (!ending || held.length > 0) return;
            finish();
            if (aborted) reset();
        };
        /** The bridge resumes its agent only once nothing is held and more could go out. */
        const wake = (): void => {
            if (congested || held.length > 0 || unacked >= DEVICE_WINDOW || !resume) return;
            const next = resume;
            resume = null;
            next();
        };
        t.credit = () => {
            unacked = Math.max(0, unacked - DEVICE_CREDIT);
            flush();
            wake();
        };

        const exchange = core.appBridge.open(
            {
                appId: row.appId,
                method: method as string,
                path: target,
                headers: raw,
                mode: upgrade ? "upgrade" : "http",
                publicBase: "",
                jar: false,
            },
            {
                head: (status, headers) => {
                    headSeen = true;
                    head(status, { ...headers, ...NO_STORE });
                },
                data: (bytes) => {
                    held.push(bytes);
                    flush();
                    return !congested && held.length === 0 && unacked < DEVICE_WINDOW;
                },
                end: () => {
                    ending = true;
                    flush();
                },
                // on this door an app the caller may not reach is Forbidden, as it has always been
                fail: (status, code) => refuse(code === "no_app" ? 403 : status),
                // an upstream that hangs up right after its last bytes (a closing WebSocket) resets after its END
                abort: () => {
                    if (!ending) return reset();
                    aborted = true;
                    flush();
                },
                onDrain: (next) => {
                    resume = next;
                },
            },
        );
        if (!exchange) return;

        // request direction: queued for the agent's window; the device gets one credit per DEVICE_CREDIT handed on
        const pending: Buffer[] = [];
        let received = 0;
        let taken = 0;
        let credited = 0;
        let blocked = false;
        const pump = (): void => {
            while (pending.length > 0 && !blocked) {
                const next = pending[0] as Buffer;
                const slice = next.subarray(0, APP_CHUNK);
                if (slice.length === next.length) pending.shift();
                else pending[0] = next.subarray(APP_CHUNK);
                taken += slice.length;
                blocked = !exchange.write(slice);
            }
            while (!t.clientEnded && taken - credited >= DEVICE_CREDIT) {
                credited += DEVICE_CREDIT;
                ctx.send({ stream, flags: FLAG_DATA, payload: EMPTY });
            }
            if (t.clientEnded && pending.length === 0) exchange.end();
        };
        exchange.onDrain(() => {
            blocked = false;
            pump();
        });
        t.body = (chunk) => {
            received += chunk.length;
            // a handshake carries no body before its 101, and a device past its window ignored it
            if ((upgrade && !headSeen) || received - credited > DEVICE_WINDOW + APP_CHUNK) return reset();
            pending.push(chunk);
            pump();
        };
        t.end = () => (upgrade && !headSeen ? reset() : pump());
        t.abort = () => {
            if (stall) clearTimeout(stall);
            exchange.reset();
        };
    };
}
