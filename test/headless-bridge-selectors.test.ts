import { describe, it } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { activeCustomSelectors, blockingCustomSelectors } from "../src/antigravity/headless-bridge.js";

describe("antigravity selectors", () => {
    it("ANTHROPIC_BASE_URL is reported but does not block (nested launcher session)", () => {
        const env = { ANTHROPIC_BASE_URL: "http://127.0.0.1:8791", PATH: "/usr/bin" };
        deepStrictEqual(activeCustomSelectors(env), ["ANTHROPIC_BASE_URL"]);
        deepStrictEqual(blockingCustomSelectors(env), []);
    });
    it("GEMINI_API_KEY and ANTIGRAVITY_BASE_URL block (negative arm)", () => {
        const env = { GEMINI_API_KEY: "x", ANTIGRAVITY_BASE_URL: "https://example", ANTHROPIC_BASE_URL: "http://127.0.0.1:8791" };
        deepStrictEqual(blockingCustomSelectors(env), ["ANTIGRAVITY_BASE_URL", "GEMINI_API_KEY"]);
    });
    it("an empty value does not count as a selector", () => {
        deepStrictEqual(blockingCustomSelectors({ GEMINI_API_KEY: "  " }), []);
    });
});
