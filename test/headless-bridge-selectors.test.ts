import { describe, it } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { activeCustomSelectors, blockingCustomSelectors } from "../src/antigravity/headless-bridge.js";

describe("antigravity secicileri", () => {
    it("ANTHROPIC_BASE_URL raporlanir ama engellemez (ic ice launcher oturumu)", () => {
        const env = { ANTHROPIC_BASE_URL: "http://127.0.0.1:8791", PATH: "/usr/bin" };
        deepStrictEqual(activeCustomSelectors(env), ["ANTHROPIC_BASE_URL"]);
        deepStrictEqual(blockingCustomSelectors(env), []);
    });
    it("GEMINI_API_KEY ve ANTIGRAVITY_BASE_URL engeller (negatif kol)", () => {
        const env = { GEMINI_API_KEY: "x", ANTIGRAVITY_BASE_URL: "https://ornek", ANTHROPIC_BASE_URL: "http://127.0.0.1:8791" };
        deepStrictEqual(blockingCustomSelectors(env), ["ANTIGRAVITY_BASE_URL", "GEMINI_API_KEY"]);
    });
    it("bos deger secici sayilmaz", () => {
        deepStrictEqual(blockingCustomSelectors({ GEMINI_API_KEY: "  " }), []);
    });
});
