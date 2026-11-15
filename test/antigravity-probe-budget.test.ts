import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ANTIGRAVITY_PROBE_ABORT_MS, ANTIGRAVITY_PROBE_TIMEOUT_MS } from "../src/antigravity/probe-budget.js";

// Negative control: a revert to the old 60 s budget (Argon measured at 114-172 s) fails this file.
test("antigravity live-probe budget fits a slow model and the headless-bridge limits", () => {
    assert.ok(ANTIGRAVITY_PROBE_TIMEOUT_MS >= 240_000, "must cover Argon's measured 114-172 s with margin");
    assert.ok(ANTIGRAVITY_PROBE_TIMEOUT_MS <= 600_000, "headless-bridge maximum");
    assert.equal(ANTIGRAVITY_PROBE_TIMEOUT_MS % 1_000, 0, "headless-bridge needs whole seconds");
    assert.ok(ANTIGRAVITY_PROBE_ABORT_MS > ANTIGRAVITY_PROBE_TIMEOUT_MS, "outer abort outlives the child timeout");
});

test("probeAntigravityModel uses the shared budget, not a literal", () => {
    const source = readFileSync(fileURLToPath(new URL("../../src/cli.ts", import.meta.url)), "utf8");
    const start = source.indexOf("async function probeAntigravityModel");
    assert.ok(start >= 0, "probe function located");
    const body = source.slice(start, start + 3_000);
    assert.match(body, /timeoutMs: ANTIGRAVITY_PROBE_TIMEOUT_MS/u);
    assert.match(body, /AbortSignal\.timeout\(ANTIGRAVITY_PROBE_ABORT_MS\)/u);
    assert.doesNotMatch(body, /timeoutMs: 60_000|AbortSignal\.timeout\(65_000\)/u);
});
