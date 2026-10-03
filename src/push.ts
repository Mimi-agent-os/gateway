/** Phone push over FCM: the same content-free notification to every paired device that holds a
 *  token and no live channel session, so a closed app still learns that something waits. */

import { createPrivateKey, sign, type KeyObject } from "node:crypto";

import type { GatewayDb } from "./store/db.ts";

export interface FcmAccount {
    projectId: string;
    clientEmail: string;
    privateKey: KeyObject;
}

export interface PushOptions {
    /** None: push is off — the routes still store tokens, nothing is sent. */
    account?: FcmAccount | undefined;
    /** Tests only: what reaches Google, and the clock the throttle and the access token read. */
    fetch?: typeof fetch | undefined;
    now?: (() => number) | undefined;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const HTTP_TIMEOUT_MS = 10_000;
const TOKEN_MARGIN_MS = 5 * 60_000;
/** One push per device per window; the collapse key folds whatever else the phone still shows. */
const DEVICE_WINDOW_MS = 30_000;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,29}$/;
const HINT = " — put the service account JSON key file there on one line, in single quotes, or remove it to turn push off";

/** FCM_SERVICE_ACCOUNT_KEY as an account, undefined when unset; throws without ever quoting the value. */
export function fcmAccount(raw: string | undefined): FcmAccount | undefined {
    const text = raw?.trim() || undefined;
    if (text === undefined) return undefined;
    let key: Record<string, unknown> | null = null;
    try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) key = parsed as Record<string, unknown>;
    } catch {
        // JSON.parse quotes the text it failed on, so its message is dropped
    }
    if (key === null) throw new Error(`FCM_SERVICE_ACCOUNT_KEY is not a JSON object${HINT}`);
    const projectId = key["project_id"];
    if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) throw new Error(`FCM_SERVICE_ACCOUNT_KEY has no valid project_id${HINT}`);
    const clientEmail = key["client_email"];
    if (typeof clientEmail !== "string" || !/^[^\s@]+@[^\s@]+$/.test(clientEmail)) {
        throw new Error(`FCM_SERVICE_ACCOUNT_KEY has no valid client_email${HINT}`);
    }
    const pem = key["private_key"];
    let privateKey: KeyObject | null = null;
    try {
        if (typeof pem === "string") privateKey = createPrivateKey(pem);
    } catch {
        // the same: nothing about the key may reach the log
    }
    if (privateKey?.asymmetricKeyType !== "rsa") throw new Error(`FCM_SERVICE_ACCOUNT_KEY has no RSA private_key in PEM${HINT}`);
    return { projectId, clientEmail, privateKey };
}

export class Push {
    readonly #db: GatewayDb;
    readonly #log: (msg: string) => void;
    readonly #online: (device: string) => boolean;
    readonly #account: FcmAccount | undefined;
    readonly #fetch: typeof fetch;
    readonly #now: () => number;
    readonly #sentAt = new Map<string, number>();
    #access: { token: string; expiresAt: number } | null = null;
    #minting: Promise<string> | null = null;

    constructor(db: GatewayDb, log: (msg: string) => void, online: (device: string) => boolean, opts: PushOptions = {}) {
        this.#db = db;
        this.#log = log;
        this.#online = online;
        this.#account = opts.account;
        this.#fetch = opts.fetch ?? fetch;
        this.#now = opts.now ?? Date.now;
    }

    /** Never throws and never rejects, so the event that woke it goes on regardless; resolves once every send settled. */
    async wake(): Promise<void> {
        const account = this.#account;
        if (account === undefined) return;
        try {
            const now = this.#now();
            const due = this.#db
                .listDevicePush()
                .filter(({ device }) => !this.#online(device) && now - (this.#sentAt.get(device) ?? -Infinity) >= DEVICE_WINDOW_MS);
            for (const { device } of due) this.#sentAt.set(device, now);
            await Promise.all(
                due.map(({ device, token }) =>
                    this.#send(account, device, token).catch((e: unknown) => this.#log(`[push] device ${device}: ${(e as Error).message}\n`)),
                ),
            );
        } catch (e) {
            this.#log(`[push] ${(e as Error).message}\n`);
        }
    }

    async #send(account: FcmAccount, device: string, token: string): Promise<void> {
        const message = {
            token,
            notification: { title: "mimi", body: "Something needs you. Open the app for more." },
            android: { collapse_key: "mimi", priority: "high", notification: { tag: "mimi" } },
        };
        const post = async (): Promise<Response> =>
            this.#fetch(`https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`, {
                method: "POST",
                headers: { authorization: `Bearer ${await this.#accessToken(account)}`, "content-type": "application/json" },
                body: JSON.stringify({ message }),
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
            });
        let res = await post();
        if (res.status === 401) {
            await res.body?.cancel();
            this.#access = null;
            res = await post();
        }
        const text = await res.text();
        if (res.ok) return;
        let failure: { status?: unknown; details?: unknown } = {};
        try {
            failure = (JSON.parse(text) as { error?: typeof failure }).error ?? {};
        } catch {
            // not JSON (a proxy's page): the HTTP status alone decides
        }
        const details = Array.isArray(failure.details)
            ? (failure.details as Array<{ errorCode?: unknown; fieldViolations?: unknown } | null>)
            : [];
        // a bare 404 may be a wrong project_id: only FCM naming the token drops it
        const gone =
            details.some((d) => d?.errorCode === "UNREGISTERED") ||
            (failure.status === "INVALID_ARGUMENT" &&
                !details.some((d) => Array.isArray(d?.fieldViolations) && d.fieldViolations.some((v) => v?.field !== "message.token")));
        if (!gone) throw new Error(`FCM answered ${res.status}`);
        this.#db.deleteDevicePush(device, token);
        this.#log(`[push] device ${device}: FCM no longer takes its token, dropped\n`);
    }

    #accessToken(account: FcmAccount): Promise<string> {
        const cached = this.#access;
        if (cached !== null && this.#now() < cached.expiresAt - TOKEN_MARGIN_MS) return Promise.resolve(cached.token);
        this.#minting ??= (async () => {
            const now = this.#now();
            const iat = Math.floor(now / 1000);
            const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
            const claims = Buffer.from(
                JSON.stringify({ iss: account.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }),
            ).toString("base64url");
            const signature = sign("sha256", Buffer.from(`${header}.${claims}`), account.privateKey).toString("base64url");
            const res = await this.#fetch(TOKEN_URL, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    assertion: `${header}.${claims}.${signature}`,
                }),
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
            });
            const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
            if (!res.ok || typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
                throw new Error(`Google's token endpoint answered ${res.status} with no access token`);
            }
            this.#access = { token: body.access_token, expiresAt: now + body.expires_in * 1000 };
            return body.access_token;
        })().finally(() => {
            this.#minting = null;
        });
        return this.#minting;
    }
}
