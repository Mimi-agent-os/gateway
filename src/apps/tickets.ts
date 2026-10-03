/** Launch sessions for the browser door: a one-time ticket in the entry URL is spent for an
 *  HttpOnly cookie scoped to /mini-app/<appId>/, in memory, dying with the gateway. */

import { randomBytes, timingSafeEqual } from "node:crypto";

import type { EventHub } from "../events.ts";

export interface AppSession {
    id: string;
    agent: string;
    appId: string;
    /** The catalog upstream this session was minted against — the bridge's `upstreamPin`. */
    upstream: string;
    /** The device whose channel minted the ticket; null when no device identity was available. */
    device: string | null;
    /** The cookie's value: the door writes it into Set-Cookie and nothing else ever renders it. */
    secret: string;
    expiresAt: number;
}

/** What a ticket hands the launcher: the session, plus the one-time token its entry URL carries. */
export interface AppLaunch extends AppSession {
    ticket: string;
}

/** The query param the entry URL carries the one-time ticket token in. */
export const APP_TICKET_PARAM = "mimi_ticket";
/** One cookie name per session: a shared name would let one app overwrite another's, or shadow it
 *  with a deeper Path, and break every other app's requests. */
export const APP_COOKIE_PREFIX = "mimi_app_";
export const appCookieName = (session: string): string => `${APP_COOKIE_PREFIX}${session}`;

/** 30 minutes, SLIDING — every admitted request and every renew pushes it out again. */
const TTL_MS = 30 * 60_000;
/** The iframe walks the entry link immediately; a token that sits around is a leaked URL. */
const TICKET_TTL_MS = 120_000;

interface Entry {
    session: AppSession;
    /** The unspent token of the last ticket, and when it was minted. */
    ticket: string | null;
    ticketAt: number;
    holds: Set<() => void>;
}

const matches = (presented: string, want: string): boolean =>
    presented.length === want.length && timingSafeEqual(Buffer.from(presented), Buffer.from(want));

/** Every `mimi_app_<id>=<value>` pair on a Cookie header, in the order the browser sent them. */
function presented(cookieHeader: string | undefined): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const one of (cookieHeader ?? "").split(";")) {
        const pair = one.trim();
        const eq = pair.indexOf("=");
        if (eq <= APP_COOKIE_PREFIX.length || !pair.startsWith(APP_COOKIE_PREFIX)) continue;
        out.push([pair.slice(APP_COOKIE_PREFIX.length, eq), pair.slice(eq + 1)]);
    }
    return out;
}

export class AppTickets {
    private readonly live = new Map<string, Entry>();
    private readonly ttlMs: number;
    private readonly unsubscribe: (() => void) | null;

    constructor(opts: { events: EventHub; ttlMs?: number | undefined }) {
        this.ttlMs = opts.ttlMs ?? TTL_MS;
        // a browser cookie inherits nothing from the channel that minted it: a revoked device's
        // sessions are dropped here, not by the device plane
        this.unsubscribe = opts.events.subscribe((ev) => {
            const id = ev.type === "device_revoked" && typeof ev["id"] === "string" ? ev["id"] : "";
            if (id) this.closeDevice(id);
        });
    }

    /** A live session for the same (device, agent, appId) is REUSED: it slides, takes a fresh
     *  one-time ticket, and its cookie stays the one the browser already holds. A launch against
     *  another upstream mints a new session — the old one's credentials do not carry over. */
    open(agent: string, appId: string, upstream: string, device: string | null): AppLaunch {
        const ticket = randomBytes(16).toString("hex");
        for (const entry of [...this.live.values()]) {
            const s = entry.session;
            if (!this.alive(entry) || s.agent !== agent || s.appId !== appId || s.device !== device) continue;
            if (s.upstream !== upstream) {
                this.drop(entry);
                continue;
            }
            entry.ticket = ticket;
            entry.ticketAt = Date.now();
            return { ...this.slide(entry), ticket };
        }
        const entry: Entry = {
            session: {
                id: randomBytes(16).toString("hex"),
                agent,
                appId,
                upstream,
                device,
                secret: randomBytes(32).toString("hex"),
                expiresAt: 0,
            },
            ticket,
            ticketAt: Date.now(),
            holds: new Set(),
        };
        this.live.set(entry.session.id, entry);
        return { ...this.slide(entry), ticket };
    }

    /** One-time, constant-time compare; slides the session. */
    redeem(appId: string, ticket: string): AppSession | null {
        for (const entry of this.live.values()) {
            if (entry.session.appId !== appId || entry.ticket === null || !this.alive(entry)) continue;
            if (Date.now() - entry.ticketAt > TICKET_TTL_MS || !matches(ticket, entry.ticket)) continue;
            entry.ticket = null;
            return this.slide(entry);
        }
        return null;
    }

    /** The live session of this app whose secret matches a presented cookie; slides it. Every
     *  candidate is scanned, so a same-origin page's forged `mimi_app_x=junk` is harmless. */
    match(appId: string, cookieHeader: string | undefined): AppSession | null {
        for (const [id, value] of presented(cookieHeader)) {
            const entry = this.live.get(id);
            if (!entry || entry.session.appId !== appId || !this.alive(entry)) continue;
            if (matches(value, entry.session.secret)) return this.slide(entry);
        }
        return null;
    }

    /** The ids of every presented cookie that names no live session — expired in the entry 302, so
     *  cookies left by an earlier gateway process do not pile up on the pult's origin. */
    stale(cookieHeader: string | undefined): string[] {
        return presented(cookieHeader)
            .filter(([id]) => {
                const entry = this.live.get(id);
                return !entry || !this.alive(entry);
            })
            .map(([id]) => id);
    }

    /** Only the device whose channel minted the session may slide it; a session opened with no
     *  device identity behind it is renewable by whoever holds its id. */
    renew(sessionId: string, device: string | null): AppSession | null {
        const entry = this.live.get(sessionId);
        if (!entry || !this.alive(entry)) return null;
        if (entry.session.device !== null && entry.session.device !== device) return null;
        return this.slide(entry);
    }

    /** Runs `cancel` when this session ends; the returned function unregisters it. */
    hold(sessionId: string, cancel: () => void): () => void {
        const entry = this.live.get(sessionId);
        entry?.holds.add(cancel);
        return () => void entry?.holds.delete(cancel);
    }

    /** A blocked or revoked agent keeps no session a cookie could still open. */
    closeAgent(agent: string): void {
        for (const entry of [...this.live.values()]) if (entry.session.agent === agent) this.drop(entry);
    }

    closeDevice(device: string): void {
        for (const entry of [...this.live.values()]) if (entry.session.device === device) this.drop(entry);
    }

    stop(): void {
        this.unsubscribe?.();
        for (const entry of [...this.live.values()]) this.drop(entry);
    }

    /** An expired session is gone to every caller; nothing sweeps on a timer, since a dead session
     *  answers 403 and the next launch for the same tuple replaces it. Expiry only FORGETS — a
     *  request admitted while the session was live finishes, so its hold is dropped, not run. */
    private alive(entry: Entry): boolean {
        if (entry.session.expiresAt > Date.now()) return true;
        this.live.delete(entry.session.id);
        entry.holds.clear();
        return false;
    }

    private drop(entry: Entry): void {
        this.live.delete(entry.session.id);
        const holds = [...entry.holds];
        entry.holds.clear();
        for (const cancel of holds) cancel();
    }

    private slide(entry: Entry): AppSession {
        entry.session.expiresAt = Date.now() + this.ttlMs;
        return { ...entry.session };
    }
}
