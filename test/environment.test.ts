import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNoApiKeySelectors, presentApiKeySelectors, sanitizedClaudeEnvironment, sanitizedWorkerEnvironment } from "../src/security/environment.js";

// This system is OAuth-only: there is NO API-key fallback for any provider. If a key
// selector is left in the environment, the user can be billed silently against the key
// while believing they are on OAuth. That is why selector detection is both REPORTED and
// STRIPPED from the environment handed to worker threads -- two separate checks.

describe("presentApiKeySelectors", () => {
    it("reports nothing in a clean environment", () => {
        deepStrictEqual(presentApiKeySelectors({ PATH: "/usr/bin", HOME: "/home/x" }), []);
    });

    it("detects provider keys", () => {
        const found = presentApiKeySelectors({ ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" });
        strictEqual(found.includes("ANTHROPIC_API_KEY"), true);
        strictEqual(found.includes("OPENAI_API_KEY"), true);
    });

    it("does not count EMPTY or whitespace-only values as selectors", () => {
        deepStrictEqual(presentApiKeySelectors({ ANTHROPIC_API_KEY: "" }), []);
        deepStrictEqual(presentApiKeySelectors({ ANTHROPIC_API_KEY: "   " }), []);
    });

    it("sorts the result without duplicates", () => {
        const found = presentApiKeySelectors({ OPENAI_API_KEY: "y", ANTHROPIC_API_KEY: "x" });
        deepStrictEqual([...found], [...found].sort());
        strictEqual(new Set(found).size, found.length);
    });
});

describe("assertNoApiKeySelectors", () => {
    it("accepts a clean environment silently", () => {
        assertNoApiKeySelectors({ PATH: "/usr/bin" });
    });

    it("throws when a selector is present and reports its NAME, not its VALUE", () => {
        throws(
            () => { assertNoApiKeySelectors({ ANTHROPIC_API_KEY: "sk-secret-value-here" }); },
            (error: unknown) => {
                const message = (error as Error).message;
                strictEqual(message.includes("ANTHROPIC_API_KEY"), true);
                strictEqual(message.includes("sk-secret-value-here"), false);
                return true;
            },
        );
    });
});

describe("sanitizedWorkerEnvironment", () => {
    it("strips GEMINI_MODEL (so the operator environment cannot choose agy's default model)", () => {
        const cleaned = sanitizedWorkerEnvironment("gemini", { GEMINI_MODEL: "gemini-3.7-flash", PATH: "/usr/bin" });
        strictEqual(cleaned["GEMINI_MODEL"], undefined);
        strictEqual(cleaned["PATH"], "/usr/bin");
    });
    it("strips ANTHROPIC_BASE_URL", () => {
        // This variable REALLY caused trouble in this session: it was inherited from Claude
        // Code's own process and dropped the antigravity probe at the OAuth-only check.
        const cleaned = sanitizedWorkerEnvironment("openai", { ANTHROPIC_BASE_URL: "https://example", PATH: "/usr/bin" });
        strictEqual(cleaned["ANTHROPIC_BASE_URL"], undefined);
        strictEqual(cleaned["PATH"], "/usr/bin");
    });

    it("strips provider keys", () => {
        const cleaned = sanitizedWorkerEnvironment("openai", { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y", PATH: "/usr/bin" });
        deepStrictEqual(presentApiKeySelectors(cleaned), []);
    });

    it("NO selector REMAINS in the output environment (the sanitizer checks itself)", () => {
        const dirty: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b", PATH: "/usr/bin" };
        for (const provider of ["anthropic", "openai", "xai", "google", "gemini"] as const) {
            deepStrictEqual(presentApiKeySelectors(sanitizedWorkerEnvironment(provider, dirty)), [], provider);
        }
    });

    it("DOES NOT CHANGE the source environment (works on a copy)", () => {
        const source: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "x" };
        sanitizedWorkerEnvironment("openai", source);
        strictEqual(source["ANTHROPIC_API_KEY"], "x");
    });

    // Three new overrides that arrived with clodex 2.11.1 (measured 2026-09-05: 0
    // occurrences in the 2.8.2 bundle, 1 each in 2.11.1). If they are not added to the
    // strip list alongside the new version, they are silently inherited from the work
    // session, and the "hygienic environment" claim is left without a measurement.
    it("strips the new CLODEX_* overrides from clodex 2.11.1", () => {
        const cleaned = sanitizedWorkerEnvironment("openai", {
            CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: "1",
            CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: "2",
            CLODEX_WS_MAX_NEW_CONNECTIONS_PER_MIN: "3",
            CLODEX_UPSTREAM_MAX_RETRIES: "4",
            PATH: "/usr/bin",
        });
        strictEqual(cleaned["CLODEX_UPSTREAM_IDLE_TIMEOUT_MS"], undefined);
        strictEqual(cleaned["CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS"], undefined);
        strictEqual(cleaned["CLODEX_WS_MAX_NEW_CONNECTIONS_PER_MIN"], undefined);
        strictEqual(cleaned["CLODEX_UPSTREAM_MAX_RETRIES"], undefined);
        // NEGATIVE ARM: the sanitizer is not "strip anything starting with CLODEX_" --
        // CLODEX_HOME is REQUIRED for the capsule to run, and stripping it means the
        // provider never comes up at all.
        strictEqual(cleaned["PATH"], "/usr/bin");
    });

    it("does not strip CLODEX_HOME (the capsule cannot run without it)", () => {
        const cleaned = sanitizedWorkerEnvironment("openai", { CLODEX_HOME: "C:/home", PATH: "/usr/bin" });
        strictEqual(cleaned["CLODEX_HOME"], "C:/home");
    });

    it("does not leak launcher metadata variables into the child process", () => {
        const cleaned = sanitizedWorkerEnvironment("openai", {
            HEZARFEN_CLAUDE_OAUTH_RELEASE_ID: "router-v3-AAAAAAAAAAAA-BBBBBBBBBBBB",
            HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE: "embedded-release",
        });
        strictEqual(cleaned["HEZARFEN_CLAUDE_OAUTH_RELEASE_ID"], undefined);
        strictEqual(cleaned["HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE"], undefined);
    });
});

describe("sanitizedClaudeEnvironment", () => {
    it("does not pass selectors to the Claude child process either", () => {
        deepStrictEqual(presentApiKeySelectors(sanitizedClaudeEnvironment({ ANTHROPIC_API_KEY: "x", PATH: "/usr/bin" })), []);
    });
});
