/** Per-listener route surfaces. The loopback listener serves the /mini-app door, the
 *  health probe and the /local routes (status, device and agent invites, block/unblock) over plain
 *  HTTP, plus the two channel upgrades; an optional --lan listener carries only those two upgrades.
 *  The /api router itself sits behind neither — it is reachable only through the tunnel (registry/tunnel.ts). */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener } from "node:http";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import { join } from "node:path";

import { AGENT_NAME_SOURCE } from "@mimi-os/protocol";

import type { GatewayCore } from "../core.ts";
import { isLoopbackHost, urlHost } from "../flags.ts";
import { CHANNEL_PATH, PAIR_PATH } from "../registry/devices.ts";
import { home, writeAtomic } from "../store/home.ts";
import { healthPayload } from "./index.ts";
import { doorOrigin, MINI_APP_PREFIX, serveMiniApp } from "./mini-app.ts";
import { isoStamp, json, readBody } from "./router.ts";

export const localTokenFile = (): string => join(home, ".local-token");

/** The sockets this gateway listens on: the loopback one this handler serves, and the optional --lan one. */
export interface Listeners {
    host: string;
    port: number;
    lan?: string | undefined;
    /** MIMI_PUBLIC_URL: the origin the app dials when it reaches this box through a domain, a proxy or a forwarded port. */
    publicUrl?: string | undefined;
}

export interface ReachableAddress {
    /** An http(s) origin, the form a pairing link carries. */
    url: string;
    kind: "public" | "tailscale" | "lan" | "loopback";
}

/** Where a client can dial this gateway: the owner's MIMI_PUBLIC_URL, then each address the --lan listener
 *  binds (a wildcard stands for every interface of the host, Tailscale's 100.x included), then the loopback listener. */
export function reachableAddresses({ host, port, lan, publicUrl }: Listeners): ReachableAddress[] {
    const wildcard = lan === "0.0.0.0" || lan === "::";
    const interfaces = Object.values(networkInterfaces()).flatMap((list) => list ?? []);
    // a "::" socket is dual-stack; link-local IPv6 needs a zone no URL can carry
    const lanIps = !wildcard
        ? (lan === undefined ? [] : [lan])
        : interfaces
              .filter((i) => !i.internal && (i.family === "IPv4" || (lan === "::" && !i.address.toLowerCase().startsWith("fe80:"))))
              .map((i) => i.address);
    const out: ReachableAddress[] = lanIps.map((ip) => {
        const [a, b = 0] = ip.split(".").map(Number);
        const tailscale = (a === 100 && b >= 64 && b < 128) || ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
        return { url: `http://${urlHost(ip)}:${port}`, kind: tailscale ? "tailscale" : isLoopbackHost(ip) ? "loopback" : "lan" };
    });
    out.push({ url: `http://${urlHost(host)}:${port}`, kind: "loopback" });
    // the canonical origin a pairing link carries: a named host lowercased, port 80 dropped
    const listening = out.flatMap((a) => {
        const origin = URL.parse(a.url)?.origin;
        return origin === undefined ? [] : [{ url: origin, kind: a.kind }];
    });
    return publicUrl === undefined ? listening : [{ url: publicUrl, kind: "public" }, ...listening];
}

let localToken = "";

/** Written fresh at every boot, mode 0600 — `mimi pair|block|unblock` and the /local routes share this secret. */
export function writeLocalToken(): string {
    localToken = randomBytes(32).toString("hex");
    writeAtomic(localTokenFile(), `${localToken}\n`, 0o600);
    return localToken;
}

function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers["authorization"];
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const presented = Buffer.from(header.slice(7), "utf8");
    const want = Buffer.from(localToken, "utf8");
    return want.length > 0 && presented.length === want.length && timingSafeEqual(presented, want);
}

/** The one 404 shape every plain-HTTP path outside the loopback surface answers: the
 *  loopback listener's own catch-all, and the whole of the --lan / non-loopback listener (main.ts). */
export const notFound: RequestListener = (req, res) => {
    req.resume();
    res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store", "content-length": "9" });
    res.end("Not Found");
};

const LOCAL_PIN = new RegExp(`^/local/pins/(${AGENT_NAME_SOURCE})/(block|unblock)$`);
const LOCAL_AGENT_INVITE = new RegExp(`^/local/agent-invites/(${AGENT_NAME_SOURCE})$`);

/** /mini-app/*, GET /api/health, GET /local/status, POST /local/invite, POST /local/agent-invites/:agent,
 *  POST /local/pins/:agent/block|unblock — nothing else, and no /api router. A /local request without
 *  this boot's token is the one 404. */
export function loopbackHandler(core: GatewayCore, listeners: Listeners): RequestListener {
    const { port } = listeners;
    return (req, res) => {
        // the request target is whatever the peer sent: "//%" parses as HTTP yet is not a URL
        const url = URL.parse(req.url ?? "/", "http://localhost");
        if (url === null) {
            notFound(req, res);
            return;
        }
        const method = req.method ?? "GET";
        // a worker registered from ANY script of this origin outlives the session that fetched it,
        // so the whole surface refuses one
        if (req.headers["sec-fetch-dest"] === "serviceworker") {
            req.resume();
            res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store", "content-length": "9" });
            res.end("Forbidden");
            return;
        }
        if (url.pathname === MINI_APP_PREFIX || url.pathname.startsWith(`${MINI_APP_PREFIX}/`)) {
            serveMiniApp(core, req, res, url, method, port);
            return;
        }
        // DNS rebinding: only a request addressed to this very listener is served (the door above checks its own)
        if (doorOrigin(req, port) === null) {
            notFound(req, res);
            return;
        }
        if (method === "GET" && url.pathname === "/api/health") {
            json(res, 200, healthPayload(core));
            return;
        }
        if (url.pathname.startsWith("/local/") && !bearerOk(req)) {
            notFound(req, res);
            return;
        }
        if (method === "GET" && url.pathname === "/local/status") {
            const serving = [{ url: `http://${urlHost(listeners.host)}:${port}`, serves: "channel + local api" }];
            if (listeners.lan !== undefined) serving.push({ url: `ws://${urlHost(listeners.lan)}:${port}/channel`, serves: "channel only" });
            json(res, 200, {
                pid: process.pid,
                home,
                uptimeSec: Math.round(process.uptime()),
                listeners: serving,
                addresses: reachableAddresses(listeners),
            });
            return;
        }
        if (method === "POST" && url.pathname === "/local/invite") {
            // `address`: the origin the pairing link tells the app to dial
            readBody(req)
                .then((body) => {
                    const address = body["address"];
                    if (address !== undefined && typeof address !== "string") return json(res, 400, { error: "address must be a string" });
                    const invite = core.devices.createLocalInvite(address);
                    json(res, 200, { uri: invite.uri, address, expiresAt: isoStamp(invite.expiresAt) });
                })
                .catch((e: unknown) => json(res, 400, { error: (e as Error).message }));
            return;
        }
        const agentInvite = method === "POST" ? LOCAL_AGENT_INVITE.exec(url.pathname) : null;
        if (agentInvite) {
            req.resume();
            const name = agentInvite[1] ?? "";
            const invite = core.devices.createAgentInvite(name);
            json(res, 200, { uri: invite.uri, name, expiresAt: isoStamp(invite.expiresAt) });
            return;
        }
        const pinAction = method === "POST" ? LOCAL_PIN.exec(url.pathname) : null;
        if (pinAction) {
            req.resume();
            const [, name = "", action] = pinAction;
            const pin = core.registry.pin(name);
            if (!pin) {
                json(res, 404, { error: `no pin for "${name}"` });
                return;
            }
            if (action === "block") {
                core.registry.block(name);
                const closed = core.devices.closeAgent(name);
                core.appTickets.closeAgent(name);
                json(res, 200, { name, status: "blocked", closed });
                return;
            }
            if (pin.status !== "blocked") {
                json(res, 409, { error: `"${name}" is not blocked` });
                return;
            }
            core.registry.approve(name);
            json(res, 200, { name, status: "approved" });
            return;
        }
        notFound(req, res);
    };
}

const NOT_FOUND_UPGRADE = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found";

/** Both listeners accept the two channel upgrades, and the loopback one also the `/mini-app` branch
 *  `miniApp` carries — everything else gets a bare 404. The channel is not origin-gated: a peer
 *  proves an enrolled key through Noise IK, or an invite secret through IKpsk2, and an unauthenticated
 *  arrival only ever holds a pre-auth slot that `registry/devices.ts` already bounds per address. */
export function channelUpgradeHandler(
    handler: (req: IncomingMessage, duplex: Duplex, head: Buffer) => boolean,
    miniApp?: (req: IncomingMessage, duplex: Duplex, head: Buffer) => boolean,
): (req: IncomingMessage, duplex: Duplex, head: Buffer) => void {
    return (req, duplex, head) => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        if (miniApp !== undefined && path.startsWith(`${MINI_APP_PREFIX}/`) && miniApp(req, duplex, head)) return;
        const pass = (path === CHANNEL_PATH || path === PAIR_PATH) && handler(req, duplex, head);
        if (pass) return;
        // node hands the upgrade socket over with no 'error' listener: a peer RST during this write would be fatal
        duplex.on("error", () => duplex.destroy());
        duplex.end(NOT_FOUND_UPGRADE, () => duplex.destroy());
    };
}
