/** Import this FIRST, before any gateway module — store/home.ts resolves `home` once at import time, and without this a test drops `.local-token` into the repo's own ./mimi. It also pins the owner's day. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setTimeZone } from "../src/store/day.ts";

process.env["MIMI_HOME"] = mkdtempSync(join(tmpdir(), "mimi-home-"));

// the owner's day is a fixed-offset zone where it is about noon now, so no test that reads "today" runs across a midnight
const offset = 12 - new Date().getUTCHours();
setTimeZone(offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`);
