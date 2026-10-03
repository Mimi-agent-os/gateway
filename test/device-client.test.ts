/** The Node device client devkit and these tests share: a request after the socket dropped fails at once. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { dialChannel } from "../src/device-client.ts";
import { activeDevice, boot, waitFor } from "./harness-env.ts";

test("device client: once the gateway drops the socket, closed is true and every request rejects at once", async () => {
    const env = await boot();
    try {
        const { s, id } = await activeDevice(env, "devkit");
        const conn = dialChannel(`${env.ws}/channel`, s, env.core.devices.gatewayPub);
        await conn.ready;
        assert.equal(conn.closed, false);
        assert.equal((await conn.api("GET", "/api/health")).status, 200);

        const events = await conn.stream("GET", "/api/events");
        const revoked = await env.api("POST", `/api/devices/${id}/revoke`);
        assert.equal(revoked.status, 200);
        await waitFor(() => conn.closed, 4000, "the dropped socket");
        await assert.rejects(events.done, /the channel closed/);

        const t0 = Date.now();
        await assert.rejects(conn.api("GET", "/api/health"), /the channel closed/);
        await assert.rejects(conn.stream("GET", "/api/events"), /the channel closed/);
        assert.ok(Date.now() - t0 < 100, "no request waits on a socket that is gone");
    } finally {
        await env.stop();
    }
});

test("device client: a request on a channel that never became ready rejects", async () => {
    const env = await boot();
    try {
        const conn = dialChannel(`${env.ws}/channel`, crypto.getRandomValues(new Uint8Array(32)), env.core.devices.gatewayPub);
        await assert.rejects(conn.ready);
        assert.equal(conn.closed, true);
        await assert.rejects(conn.api("GET", "/api/health"));
    } finally {
        await env.stop();
    }
});
