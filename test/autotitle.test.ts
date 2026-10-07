/** What a chat's title is made from: the opening message's words, its pasted texts by name and start, never their raw tags. */
import "./pq-home.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { buildPasted } from "@mimi-os/protocol";

import { autoTitle } from "../src/turn/autotitle.ts";
import { boot, textTurn, waitFor, type Env } from "./harness-env.ts";

const LOG = "npm ERR! code ELIFECYCLE\nnpm ERR!   errno 1\nnpm ERR! build failed\n";

/** Titles a new chat from `seed` with the model answering `answers`: the opening the titler read, and the title that landed, if any. */
async function titleOf(env: Env, seed: string, answers: string[], reply?: string): Promise<{ opening: string; title: string | null }> {
    const h = await env.connect({ name: "toto", tools: [], handlers: {} });
    await waitFor(() => env.core.registry.get("toto") !== undefined, 4000, "toto registered");
    const sid = h.createSession();
    for (const answer of answers) env.model.nextTurn(textTurn(answer));
    const landed = await autoTitle({ agent: "toto", session: sid, peer: env.core.registry.get("toto")!, seed, reply, model: "fake", db: env.db });
    const title = h.sessions.get(sid)!.title;
    assert.equal(landed, title !== null);
    const sent = env.model.requests[0]?.["messages"] as { content: string }[];
    return { opening: sent[1]!.content.slice(sent[1]!.content.indexOf("\n\nuser: ") + 2), title };
}

test("typed words and a paste: the words, then the paste by name and line count, then its start", async () => {
    const env = await boot();
    try {
        const seed = buildPasted([{ title: "build.log", text: LOG }], "Why does  the build\nfail?");
        const { opening, title } = await titleOf(env, seed, ['{"title":"Failing build"}']);
        assert.equal(opening, "user: Why does the build fail?\n[pasted: build.log, 3 lines] npm ERR! code ELIFECYCLE npm ERR! errno 1 npm ERR! build failed");
        assert.equal(title, "Failing build");
    } finally {
        await env.stop();
    }
});

test("long pastes share what room the words and names leave, each keeping its line", async () => {
    const env = await boot();
    try {
        const pastes = [
            { title: "a.txt", text: "alpha ".repeat(400) },
            { title: "Pasted text 1", text: "one line" },
            { title: "b.txt", text: "beta ".repeat(400) },
        ];
        const { opening } = await titleOf(env, buildPasted(pastes, "compare these"), ['{"title":"Three texts"}']);
        const lines = opening.slice("user: ".length).split("\n");
        assert.equal(lines.length, 4);
        assert.equal(lines[0], "compare these");
        assert.match(lines[1]!, /^\[pasted: a\.txt, 1 line\] alpha alpha/);
        assert.equal(lines[2], "[pasted: Pasted text 1, 1 line] one line");
        assert.match(lines[3]!, /^\[pasted: b\.txt, 1 line\] beta beta/);
        assert.equal(lines.join("\n").length, 600, "the seed stays within SEED_CHARS");
    } finally {
        await env.stop();
    }
});

test("a message of pastes alone opens with the first paste's line", async () => {
    const env = await boot();
    try {
        const seed = buildPasted([{ title: "query.sql", text: "SELECT *\nFROM users\nWHERE id = 1;" }], "");
        const { opening } = await titleOf(env, seed, ['{"title":"User lookup"}']);
        assert.equal(opening, "user: [pasted: query.sql, 3 lines] SELECT * FROM users WHERE id = 1;");
    } finally {
        await env.stop();
    }
});

test("plain text reads as before, prose about the tag included", async () => {
    const env = await boot();
    try {
        const prose = 'How do I parse <pasted_text title="a" lines="1">\nblocks   in Go?';
        const { opening } = await titleOf(env, prose, ['{"title":"Parsing tags"}']);
        assert.equal(opening, 'user: How do I parse <pasted_text title="a" lines="1"> blocks in Go?');
    } finally {
        await env.stop();
    }
});

test("with no title from the model, the chat is named by the words, or by the first paste when nothing was typed", async () => {
    for (const [seed, expected] of [
        [buildPasted([{ title: "build.log", text: LOG }], "Why does the build fail on the release branch but never on main, any idea?"), "Why does the build fail on the release branch but never on m"],
        [buildPasted([{ title: "build.log", text: LOG }, { title: "Pasted text 1", text: "x" }], ""), "build.log"],
        ["just  a plain\nquestion", "just a plain question"],
    ] as const) {
        const env = await boot();
        try {
            const { title } = await titleOf(env, seed, ["no json here", "still none"]);
            assert.equal(title, expected);
        } finally {
            await env.stop();
        }
    }
});

test("past SEED_CHARS the pastes are counted, not named", async () => {
    let env = await boot();
    try {
        const many = Array.from({ length: 100 }, (_, i) => ({ title: `Pasted text ${i + 1}`, text: "x" }));
        const lines = (await titleOf(env, buildPasted(many, ""), ['{"title":"Many texts"}'])).opening.slice("user: ".length).split("\n");
        const count = /^\[\+(\d+) more pasted texts\]$/.exec(lines.pop()!);
        assert.ok(count, "the last line counts the unnamed pastes");
        assert.ok(lines.length > 0 && lines.join("\n").length <= 600, "the named ones stay within SEED_CHARS");
        lines.forEach((line, i) => assert.ok(line.startsWith(`[pasted: Pasted text ${i + 1}, 1 line]`), line));
        assert.equal(lines.length + Number(count[1]), 100);
    } finally {
        await env.stop();
    }
    env = await boot();
    try {
        const { opening } = await titleOf(env, buildPasted([{ title: "build.log", text: LOG }], "why ".repeat(200)), ['{"title":"Why"}']);
        assert.equal(opening, `user: ${"why ".repeat(150)}\n[+1 more pasted text]`);
    } finally {
        await env.stop();
    }
});

test("a fallback title comes from the message, never empty and never the reply while the message has text", async () => {
    const untitled = '<pasted_text title="" lines="1">\nhello  there\n</pasted_text>';
    for (const [seed, reply, expected] of [
        [untitled, undefined, "hello there"],
        [untitled, "Here is my long answer about hello", "hello there"],
        [buildPasted([{ title: "", text: "" }, { title: "", text: "second" }], ""), "an answer", "second"],
        [buildPasted([{ title: "", text: "" }], ""), "an answer", null],
    ] as const) {
        const env = await boot();
        try {
            assert.equal((await titleOf(env, seed, ["no json here", "still none"], reply)).title, expected);
        } finally {
            await env.stop();
        }
    }
});
