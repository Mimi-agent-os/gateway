/** The one gateway↔agent app bridge: both doors hand a request here and it is carried to the agent
 *  as one stream on that agent's own /channel session. */

import {
    APP_CHUNK,
    APP_CREDIT,
    APP_HEADER_COUNT,
    APP_HEADER_MAX,
    APP_HEAD_MS,
    APP_PATH_MAX,
    APP_STALL_MS,
    APP_WINDOW,
    FLAG_DATA,
    FLAG_END,
    FLAG_RESET,
    decodeAppReply,
    type AppStreamError,
    type AppStreamPort,
    type ChannelStreamFrame,
} from "@mimi-os/protocol";

import type { EventHub } from "../events.ts";
import type { Registry } from "../registry/registry.ts";
import type { GatewayDb } from "../store/db.ts";
import { cleanHeaders, storeSetCookies, VALUE, type Headers } from "./headers.ts";

export interface AppSink {
    /** Exactly once, before any data(). */
    head(status: number, headers: Headers): void;
    /** false = the consumer is behind; the bridge withholds credit until onDrain fires. */
    data(chunk: Uint8Array): boolean;
    end(): void;
    /** No head was sent and none will be: the door renders `status`. `code` is for the log. */
    fail(status: number, code: string): void;
    /** The exchange died after head(): destroy whatever is consuming it. */
    abort(): void;
    /** Registers what the sink calls once it can take more after data() returned false. */
    onDrain(resume: () => void): void;
}

export interface AppExchange {
    /** Request body in. Slices to APP_CHUNK and returns the readiness of the last slice:
     *  false = this stream's window is empty or the agent connection is behind. */
    write(chunk: Uint8Array): boolean;
    end(): void;
    reset(): void;
    onDrain(resume: () => void): void;
}

export interface AppBridgeRequest {
    appId: string;
    method: string;
    /** Path inside the app, query included — the door has already stripped its prefix. */
    path: string;
    headers: unknown;
    mode: "http" | "upgrade";
    /** The public prefix this app is reachable under on THIS door, no trailing slash:
     *  "/mini-app/board" for the browser door, "" for the native tunnel. */
    publicBase: string;
    /** The upstream the caller's session was minted against; a catalog row that no longer matches
     *  is 403. The tunnel door passes nothing. */
    upstreamPin?: string | undefined;
    /** false: `cookie` and `set-cookie` pass untouched (the tunnel's client keeps its own jar); left out, the gateway's jar handles both. */
    jar?: boolean | undefined;
}

export interface AppBridge {
    /** null = refused before any frame; sink.fail() has already been called, possibly synchronously. */
    open(req: AppBridgeRequest, sink: AppSink): AppExchange | null;
    stop(): void;
}

/** Why an exchange ended from the gateway's side, and what a client with no head yet is told.
 *  "client" is the door cancelling: nothing is rendered. */
type ResetReason = "peer" | "gone" | "forbidden" | "deadline" | "client";

const RESET_STATUS: Record<Exclude<ResetReason, "client">, number> = {
    peer: 502,
    gone: 503,
    forbidden: 403,
    deadline: 504,
};

/** The codes the wire can carry, and the status each renders as. */
const ERROR_STATUS: Record<AppStreamError, number> = {
    no_app: 404,
    unreachable: 502,
    upstream_timeout: 504,
    bad_upstream: 502,
    refused_upgrade: 501,
};

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

interface Live {
    agent: string;
    reset(reason: ResetReason): void;
}

export function createAppBridge(deps: {
    db: GatewayDb;
    registry: Registry;
    events: EventHub;
    log: (msg: string) => void;
    headMs?: number | undefined;
    stallMs?: number | undefined;
}): AppBridge {
    const { db, registry, log } = deps;
    const headMs = deps.headMs ?? APP_HEAD_MS;
    const stallMs = deps.stallMs ?? APP_STALL_MS;
    const exchanges = new Set<Live>();

    // a pin blocked or revoked mid-answer: what a door already opened stops forwarding too
    const unsubscribe = deps.events.subscribe((ev) => {
        const name = ev.type === "agent_changed" && typeof ev["name"] === "string" ? ev["name"] : "";
        if (!name || registry.statusOf(name) === "approved") return;
        for (const e of [...exchanges]) if (e.agent === name) e.reset("forbidden");
    });

    function open(req: AppBridgeRequest, sink: AppSink): AppExchange | null {
        // the one owner of the path cap: both doors hand their raw path here and neither measures it
        if (Buffer.byteLength(req.path) > APP_PATH_MAX) {
            sink.fail(414, "path_too_long");
            return null;
        }
        const row = db.getAgentAppById(req.appId);
        if (!row) {
            sink.fail(404, "not_found");
            return null;
        }
        // the catalog row outlives the pin, so admission is checked per request, never cached on
        // the exchange; a session minted against another upstream does not carry over either
        if (registry.statusOf(row.agent) !== "approved" || (req.upstreamPin !== undefined && req.upstreamPin !== row.upstream)) {
            sink.fail(403, "forbidden");
            return null;
        }
        const peer = registry.get(row.agent);
        if (!peer) {
            sink.fail(503, "offline");
            return null;
        }

        // the address is read for its origin, host and path space only — nothing dials it here
        const base = new URL(row.upstream);
        const jarred = req.jar !== false;
        const { cookie, origin, referer, ...headers } = cleanHeaders(req.headers, (k) => k.startsWith("x-mimi-"));
        headers["host"] = base.host;
        if (!jarred && cookie !== undefined) headers["cookie"] = cookie;
        // the jar is keyed by the UPSTREAM's own path space, query excluded (RFC 6265 §5.1.4)
        const query = req.path.indexOf("?");
        const jarPath = base.pathname.replace(/\/+$/, "") + (query < 0 ? req.path : req.path.slice(0, query));
        const jar = jarred ? db.appCookiesFor(row.agent, row.appId, jarPath) : [];
        if (jar.length > 0) headers["cookie"] = jar.map((c) => `${c.name}=${c.value}`).join("; ");
        if (origin !== undefined) headers["origin"] = base.origin;
        const from = referer === undefined ? null : URL.parse(String(referer));
        if (from !== null) headers["referer"] = `${base.origin}${from.pathname}${from.search}`;
        // set after the x-mimi-* drop, so a client cannot forge the prefix the app publishes under
        headers["x-mimi-app-base"] = `${req.publicBase}/`;
        if (req.mode === "upgrade") {
            const raw = req.headers === null || typeof req.headers !== "object" ? {} : (req.headers as Record<string, unknown>);
            const sent = Object.entries(raw).find(([k]) => k.toLowerCase() === "upgrade")?.[1];
            headers["connection"] = "Upgrade";
            headers["upgrade"] = typeof sent === "string" ? sent : "websocket";
        }

        const header = encoder.encode(
            JSON.stringify({ t: "req", appId: row.appId, method: req.method, path: req.path, headers, mode: req.mode }),
        );
        if (header.length > APP_HEADER_MAX || Object.keys(headers).length > APP_HEADER_COUNT) {
            sink.fail(431, "header_too_large");
            return null;
        }

        let port: AppStreamPort | null = null;
        const entry: Live = { agent: row.agent, reset: (reason) => reset(reason) };

        let done = false;
        let headSeen = false;
        let inEnded = false;
        let outEnded = false;
        /** Request bytes the agent has not credited, and the reply bytes we have not credited, in APP_CREDIT quanta. */
        let unacked = 0;
        let sinceCredit = 0;
        let sinkReady = true;
        let paused = false;
        let drain: (() => void) | null = null;
        let headTimer: NodeJS.Timeout | null = null;
        // one stall deadline per direction: a stream moving both ways is never reset while the two take turns being blocked
        let writeStall: NodeJS.Timeout | null = null;
        let readStall: NodeJS.Timeout | null = null;

        const close = (): void => {
            done = true;
            exchanges.delete(entry);
            if (headTimer) clearTimeout(headTimer);
            if (writeStall) clearTimeout(writeStall);
            if (readStall) clearTimeout(readStall);
            headTimer = null;
            writeStall = null;
            readStall = null;
        };

        /** A refusal the agent reported, or a reply the gateway cannot read: no head went out, so
         *  the door renders `status` and the stream is dropped. */
        const failed = (status: number, code: string): void => {
            close();
            port?.reset();
            sink.fail(status, code);
        };

        function reset(reason: ResetReason): void {
            if (done) return;
            // out of the set before the sink is touched: the tunnel door's abort() calls back in
            close();
            port?.reset();
            if (reason === "client") return;
            if (headSeen) sink.abort();
            else sink.fail(RESET_STATUS[reason], reason);
        }

        const resumeWrite = (): void => {
            if (!paused || unacked >= APP_WINDOW) return;
            paused = false;
            if (writeStall) clearTimeout(writeStall);
            writeStall = null;
            drain?.();
        };

        /** The reply direction's half of the credit window: the agent may send another window once its bytes are
         *  out of the gateway and into the consumer. */
        const credit = (): void => {
            while (!done && sinkReady && sinceCredit >= APP_CREDIT) {
                sinceCredit -= APP_CREDIT;
                port?.send({ flags: FLAG_DATA, payload: EMPTY });
            }
        };

        const onFrame = (frame: ChannelStreamFrame): void => {
            if (done) return;
            if (frame.flags === FLAG_RESET) {
                // #forget replays a RESET for every live stream when the socket goes or is replaced,
                // and that is "gone" (503), not the agent refusing this one exchange (502)
                reset(registry.get(row.agent) === peer ? "peer" : "gone");
                return;
            }
            // a zero-payload DATA frame is never body: it is the agent crediting the request
            // direction, which it does as the upstream drains — long before any reply head
            if (frame.payload.length === 0 && frame.flags === FLAG_DATA) {
                unacked = Math.max(0, unacked - APP_CREDIT);
                resumeWrite();
                return;
            }
            if (frame.payload.length > 0 && !headSeen) {
                if (headTimer) clearTimeout(headTimer);
                headTimer = null;
                let reply;
                try {
                    reply = decodeAppReply(frame.payload);
                } catch (e) {
                    log(`[apps] ${row.appId}: bad reply — ${(e as Error).message}\n`);
                    failed(502, "bad_reply");
                    return;
                }
                if (reply.t === "error") {
                    log(`[apps] ${row.appId}: ${reply.code}${reply.detail === undefined ? "" : ` — ${reply.detail}`}\n`);
                    failed(ERROR_STATUS[reply.code], reply.code);
                    return;
                }
                // 101 belongs to an upgrade and nothing else: an informational head on the HTTP
                // door would hand the agent the framing of a keep-alive socket
                if (req.mode === "http" && reply.status < 200) {
                    log(`[apps] ${row.appId}: informational status ${reply.status} on an http exchange\n`);
                    failed(502, "bad_reply");
                    return;
                }
                // a Set-Cookie is the jar's unless the client keeps its own; a root-relative Location stays inside this door's prefix
                if (jarred) storeSetCookies(db, row.agent, row.appId, [reply.headers["set-cookie"] ?? []].flat());
                const out = cleanHeaders(reply.headers, (n) => jarred && n === "set-cookie");
                const location = out["location"];
                if (reply.status >= 300 && reply.status < 400 && typeof location === "string" && location.startsWith("/") && !location.startsWith("//")) {
                    out["location"] = req.publicBase + location;
                }
                if (req.mode === "upgrade" && reply.status === 101) {
                    // the policy strips both as hop-by-hop, so they are re-added — and this value is
                    // written verbatim onto a raw socket, so it goes through the charset check the
                    // policy would have run on it
                    const token = [reply.headers["upgrade"] ?? headers["upgrade"]].flat()[0];
                    out["connection"] = "Upgrade";
                    out["upgrade"] = typeof token === "string" && VALUE.test(token) ? token : "websocket";
                }
                headSeen = true;
                sink.head(reply.status, out);
            } else if (frame.payload.length > 0) {
                // after a head every non-empty frame is body, so a second head or a late
                // {t:"error"} is not looked for: it is bytes the agent could write into a body anyway
                sinceCredit += frame.payload.length;
                if (sinceCredit > APP_WINDOW + APP_CHUNK) {
                    reset("peer");
                    return;
                }
                // one registration per stall, not per frame: a sink's onDrain appends a listener
                if (sink.data(frame.payload)) credit();
                else if (sinkReady) {
                    sinkReady = false;
                    readStall ??= setTimeout(() => reset("deadline"), stallMs).unref();
                    sink.onDrain(() => {
                        sinkReady = true;
                        if (readStall) clearTimeout(readStall);
                        readStall = null;
                        credit();
                    });
                }
            }
            if (frame.flags !== FLAG_END) return;
            if (!headSeen) {
                // the agent ended its side without a head: nothing to render but a bad gateway
                failed(502, "bad_reply");
                return;
            }
            inEnded = true;
            sink.end();
            if (outEnded) close();
        };

        const opened = peer.socket.openAppStream(onFrame);
        if (!opened) {
            sink.fail(503, "offline");
            return null;
        }
        port = opened;
        opened.send({ flags: FLAG_DATA, payload: header });
        opened.onDrain(resumeWrite);
        headTimer = setTimeout(() => reset("deadline"), headMs);
        headTimer.unref();
        exchanges.add(entry);

        return {
            write: (chunk) => {
                if (done || outEnded) return false;
                // an upload still flowing is progress: the wait for a head is idle, not total
                headTimer?.refresh();
                let ready = true;
                for (let i = 0; i < chunk.length; i += APP_CHUNK) {
                    const slice = chunk.subarray(i, i + APP_CHUNK);
                    unacked += slice.length;
                    ready = opened.send({ flags: FLAG_DATA, payload: slice }) && unacked < APP_WINDOW;
                }
                if (ready) return true;
                paused = true;
                opened.onDrain(resumeWrite);
                writeStall ??= setTimeout(() => reset("deadline"), stallMs).unref();
                return false;
            },
            end: () => {
                if (done || outEnded) return;
                outEnded = true;
                opened.send({ flags: FLAG_END, payload: EMPTY });
                if (inEnded) close();
            },
            reset: () => reset("client"),
            onDrain: (resume) => {
                drain = resume;
            },
        };
    }

    return {
        open,
        stop: () => {
            unsubscribe?.();
            for (const e of [...exchanges]) e.reset("gone");
        },
    };
}
