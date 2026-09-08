import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
    GEMINI_VALID_TELEMETRY_TARGETS,
    geminiWorkerEnvironment,
} from "../src/gemini/acp-bridge.js";

// CASE RECORD, measured 2026-09-01. The bridge set
// GEMINI_TELEMETRY_TARGET="none". gemini-cli 0.38.2 validates the target during
// startup, BEFORE it reads GEMINI_TELEMETRY_ENABLED and before the ACP
// handshake, and rejects anything outside local|gcp:
//
//   Invalid telemetry configuration: Invalid telemetry target: none.
//   Valid values are: local, gcp.
//   -> exit code 52, stdout empty, stderr one line
//
// So EVERY Gemini ACP session died before sending anything upstream. The
// operator saw "model is selected but no answer comes back", and no receipt was
// ever written because the request never reached a provider. Nothing in the
// suite could see it: the defect only existed in a spawned child process.
//
// These tests exist so the environment is checkable WITHOUT spawning gemini.

describe("gemini worker environment", () => {
    const env = (): NodeJS.ProcessEnv =>
        geminiWorkerEnvironment("C:/tmp/home", "C:/tmp/system-settings.json");

    it("does not set a telemetry target at all", () => {
        strictEqual("GEMINI_TELEMETRY_TARGET" in env(), false);
    });

    // The real invariant is not "unset" but "never invalid". If someone later
    // decides a target is needed, this arm still holds them to the CLI's set.
    it("if a target is ever set, it must be one the CLI accepts", () => {
        const value = env()["GEMINI_TELEMETRY_TARGET"];
        strictEqual(
            value === undefined || GEMINI_VALID_TELEMETRY_TARGETS.includes(value),
            true,
        );
    });

    it("telemetry stays disabled", () => {
        strictEqual(env()["GEMINI_TELEMETRY_ENABLED"], "false");
    });

    it("home and system settings still reach the child", () => {
        const environment = env();
        strictEqual(environment["GEMINI_CLI_HOME"], "C:/tmp/home");
        strictEqual(
            environment["GEMINI_CLI_SYSTEM_SETTINGS_PATH"],
            "C:/tmp/system-settings.json",
        );
    });

    // Guard the guard: an empty valid-set would make the arm above vacuously
    // true, which is how a control quietly stops measuring.
    it("the valid-target set is not empty", () => {
        strictEqual(GEMINI_VALID_TELEMETRY_TARGETS.length > 0, true);
    });

    // The sanitizer must still be in force -- this environment is handed to a
    // provider CLI, so a leaked Anthropic credential selector would cross lanes.
    it("carries no Anthropic credential selector", () => {
        const environment = env();
        for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
            strictEqual(name in environment, false);
        }
    });
});
