/** Which upgrade paths each listener carries. main.ts builds the /mini-app branch only where the
 *  loopback HTTP handler is, so a listener that 404s every miniapp REQUEST must refuse the
 *  upgrade too — that split is this file's whole subject, and no booted core is needed to see it. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { PassThrough, type Duplex } from "node:stream";
import test from "node:test";

import { channelUpgradeHandler } from "../src/http/listeners.ts";

const NOT_FOUND_UPGRADE = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found";
const EMPTY = Buffer.alloc(0);

const request = (url: string, headers: Record<string, string> = {}): IncomingMessage =>
    ({ url, method: "GET", headers }) as unknown as IncomingMessage;

/** A duplex that keeps whatever was written onto it, so a refusal can be read back byte for byte. */
function fake(): { duplex: Duplex; written(): Promise<string> } {
    const duplex = new PassThrough();
    let out = "";
    duplex.on("data", (c: Buffer) => (out += c.toString("utf8")));
    return {
        duplex,
        written: async () => {
            await new Promise((settled) => setImmediate(settled));
            return out;
        },
    };
}

test("a /mini-app upgrade reaches the branch it was given, and is a bare 404 without one", async () => {
    const channel: string[] = [];
    const handler = (req: IncomingMessage): boolean => {
        channel.push(req.url ?? "");
        return true;
    };

    // the --lan and non-loopback listeners build no branch: a miniapp upgrade is as unknown there
    // as any other path, which is exactly what makes main.ts's `loopback ? … : undefined` load-bearing
    const bare = channelUpgradeHandler(handler);
    const refused = fake();
    bare(request("/mini-app/board/ws"), refused.duplex, EMPTY);
    assert.equal(await refused.written(), NOT_FOUND_UPGRADE);
    assert.deepEqual(channel, []);

    const taken: string[] = [];
    const door = channelUpgradeHandler(handler, (req) => {
        taken.push(req.url ?? "");
        return true;
    });
    const dispatched = fake();
    door(request("/mini-app/board/ws?room=1"), dispatched.duplex, EMPTY);
    assert.deepEqual(taken, ["/mini-app/board/ws?room=1"], "query and all");
    assert.equal(await dispatched.written(), "", "the branch owns the socket from then on");

    // the branch runs before the channel paths are considered at all
    const foreign = fake();
    door(request("/mini-app/board/ws", { origin: "http://evil.example" }), foreign.duplex, EMPTY);
    assert.deepEqual(taken.length, 2);
    assert.equal(await foreign.written(), "");

    // a branch that does not take the socket falls back to the one refusal shape
    const passed = fake();
    const passing = channelUpgradeHandler(handler, () => false);
    passing(request("/mini-app/board/ws"), passed.duplex, EMPTY);
    assert.equal(await passed.written(), NOT_FOUND_UPGRADE);

    // /mini-app without a trailing slash names no app, so it is not the branch's business
    const prefix = fake();
    door(request("/mini-app"), prefix.duplex, EMPTY);
    assert.equal(await prefix.written(), NOT_FOUND_UPGRADE);
    assert.equal(taken.length, 2);
});

test("the two channel upgrades are unaffected by the miniapp branch", async () => {
    const seen: string[] = [];
    const door = channelUpgradeHandler(
        (req) => {
            seen.push(req.url ?? "");
            return true;
        },
        () => {
            throw new Error("the miniapp branch must not see a channel upgrade");
        },
    );
    for (const path of ["/channel", "/channel/pair?invite=x"]) door(request(path), fake().duplex, EMPTY);
    assert.deepEqual(seen, ["/channel", "/channel/pair?invite=x"]);

    // the channel is not origin-gated: any Origin reaches the handler, which answers with Noise
    door(request("/channel", { origin: "http://evil.example" }), fake().duplex, EMPTY);
    assert.deepEqual(seen, ["/channel", "/channel/pair?invite=x", "/channel"]);

    // a path that is neither channel nor miniapp is still the one refusal shape
    const other = fake();
    door(request("/api/health"), other.duplex, EMPTY);
    assert.equal(await other.written(), NOT_FOUND_UPGRADE);
});
