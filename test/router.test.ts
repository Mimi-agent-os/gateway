/** The path-template router: what a `:segment` accepts, what it binds, and what it refuses. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import { Router } from "../src/http/router.ts";

interface Answer {
    matched: boolean;
    status: number;
    body: string;
}

async function hit(router: Router, method: string, path: string, device?: string): Promise<Answer> {
    let status = 0;
    let body = "";
    const res = {
        writeHead: (code: number) => void (status = code),
        end: (chunk?: unknown) => void (body = typeof chunk === "string" ? chunk : body),
    } as unknown as ServerResponse;
    const req = { method, url: path } as unknown as IncomingMessage;
    const matched = await router.dispatch(req, res, device);
    return { matched, status, body };
}

const echo = (router: Router, template: string, ...names: string[]): Router =>
    router.get(template, (ctx) => {
        ctx.res.writeHead(200);
        ctx.res.end(names.map((n) => ctx.param(n)).join("|"));
    });

test("a template binds its named segments, in order, by name", async () => {
    const router = echo(new Router(), "/api/agents/:agent/inbox/:id", "agent", "id");
    const hit1 = await hit(router, "GET", "/api/agents/wren_2/inbox/17");
    assert.equal(hit1.matched, true);
    assert.equal(hit1.body, "wren_2|17");
    // the query string is not part of the path
    assert.equal((await hit(router, "GET", "/api/agents/wren/inbox/1?all=1")).body, "wren|1");
});

test(":agent takes the agent charset — a lowercase slug with dashes, nothing else", async () => {
    const router = echo(new Router(), "/api/agents/:agent/stop", "agent");
    for (const bad of ["Device-1", "2wren", "", "wren/x", "WREN", "-wren"]) {
        assert.equal((await hit(router, "GET", `/api/agents/${bad}/stop`)).matched, false, bad);
    }
    for (const ok of ["wren", "wren-2", "night-owl"]) {
        assert.equal((await hit(router, "GET", `/api/agents/${ok}/stop`)).matched, true, ok);
    }
});

test(":id and :session take digits only", async () => {
    const router = echo(new Router(), "/api/agents/:agent/conversations/:session", "session");
    assert.equal((await hit(router, "GET", "/api/agents/wren/conversations/abc")).matched, false);
    assert.equal((await hit(router, "GET", "/api/agents/wren/conversations/-1")).matched, false);
    assert.equal((await hit(router, "GET", "/api/agents/wren/conversations/12")).body, "12");
    const unsafe = await hit(router, "GET", "/api/agents/wren/conversations/9007199254740992");
    assert.equal(unsafe.matched, true);
    assert.equal(unsafe.status, 400);
});

test("an unknown :segment is a registration error, not a route that never matches", () => {
    assert.throws(() => new Router().get("/api/agents/:agnet/stop", () => undefined), /unknown segment ":agnet"/);
    assert.throws(() => new Router().get("api/agents", () => undefined), /must start with "\//);
});

test("a bound param arrives URL-decoded", async () => {
    const router = echo(new Router(), "/api/secrets/:key", "key");
    assert.equal((await hit(router, "GET", "/api/secrets/OPENROUTER%20KEY")).body, "OPENROUTER KEY");
    assert.equal((await hit(router, "GET", "/api/secrets/a%2Fb")).body, "a/b");
});

test("asking for a name the template does not carry is a programming error", async () => {
    const router = new Router().get("/api/agents/:agent/stop", (ctx) => {
        assert.throws(() => ctx.param("session"), /has no ":session"/);
        ctx.res.writeHead(200);
        ctx.res.end("");
    });
    assert.equal((await hit(router, "GET", "/api/agents/wren/stop")).matched, true);
});

test("a matched path with the wrong method is 405, an unmatched path is nobody's", async () => {
    const router = echo(new Router(), "/api/agents/:agent/calls", "agent");
    const wrong = await hit(router, "POST", "/api/agents/wren/calls");
    assert.equal(wrong.matched, true);
    assert.equal(wrong.status, 405);
    assert.equal((await hit(router, "GET", "/api/nope")).matched, false);
});

test("only a request the tunnel carried names a device; every other caller sees null", async () => {
    const seen: Array<string | null> = [];
    const router = new Router().get("/api/apps", (ctx) => {
        seen.push(ctx.device);
        ctx.res.writeHead(200);
        ctx.res.end("");
    });
    await hit(router, "GET", "/api/apps");
    await hit(router, "GET", "/api/apps", "0123456789abcdef");
    assert.deepEqual(seen, [null, "0123456789abcdef"]);
});

test("a path the URL parser would rewrite is refused whole, before it can match a route it never named", async () => {
    const hits: string[] = [];
    const router = new Router()
        .delete("/api/pins/:pin", (ctx) => {
            hits.push(ctx.param("pin"));
            ctx.res.writeHead(200);
            ctx.res.end("");
        })
        .delete("/api/agents/:agent/conversations/:session", (ctx) => {
            ctx.res.writeHead(200);
            ctx.res.end("");
        });
    for (const path of [
        "/api/agents/evil/conversations/../../../pins/victim",
        "/api/agents/evil/conversations/%2e%2e/%2E%2e/.%2E/pins/victim",
        "/api/agents/evil/conversations/..\\..\\..\\pins\\victim",
        "/api/agents/evil/./conversations/1",
        "//evil/api/pins/victim",
    ]) {
        const refused = await hit(router, "DELETE", path);
        assert.equal(refused.matched, true, path);
        assert.equal(refused.status, 400, path);
        assert.match(refused.body, /normal form/);
    }
    assert.deepEqual(hits, []);
    // a query string may carry anything: only the path itself must be in normal form
    assert.equal((await hit(router, "DELETE", "/api/agents/evil/conversations/1?next=../../pins/x")).status, 200);
    assert.equal((await hit(router, "DELETE", "/api/pins/victim")).status, 200);
});
