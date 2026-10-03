import assert from "node:assert/strict";
import test from "node:test";

import { cap, TRUNCATION_MARKER } from "../src/turn/chain.ts";

test("cap includes its truncation marker inside the requested limit", () => {
    const max = TRUNCATION_MARKER.length + 3;
    const capped = cap("x".repeat(max + 1), max);

    assert.equal(capped.length, max);
    assert.equal(capped, `xxx${TRUNCATION_MARKER}`);
    assert.equal(cap("long", 3).length, 3);
    assert.equal(cap("😀".repeat(20), TRUNCATION_MARKER.length + 1), TRUNCATION_MARKER);
});
