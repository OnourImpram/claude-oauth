import { describe, it } from "node:test";
import { ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAntigravityHeadless } from "../src/antigravity/headless-bridge.js";
import { RouterError } from "../src/domain/errors.js";

// Measured 2026-09-07. A delegation to the Google lane came back with nothing and the
// router said only "Antigravity did not complete the request." The child had in fact
// written the whole reason to stderr -- a tool required a permission headless mode
// cannot prompt for, so it was auto-denied -- and the bridge collected that text and
// then dropped it at the throw. A second shape was worse: the terminal event said
// SUCCESS while the response was empty, so an entirely empty run was reported as a
// healthy one.
//
// These tests hold both halves: the child's own explanation must survive the throw,
// and an empty success must not be called a success. The redaction arm is here because
// stderr comes from a child whose environment carries credentials; a diagnostic channel
// that leaks a secret is a worse defect than the one it was opened to fix.

function terminalEvent(status: string, response: string): string {
    return `${JSON.stringify({ event: "result", result: { status, response } })}\n`;
}

async function bridgeFailure(output: { exitCode: number; stdout: string; stderr: string }): Promise<RouterError> {
    const home = mkdtempSync(join(tmpdir(), "agy-detail-"));
    try {
        await runAntigravityHeadless({
            binary: "agy.exe",
            cwd: home,
            home,
            prompt: "Reply with exactly: OK",
            model: "gemini-3.8-flash-high",
            environment: { PATH: "C:\\Windows", USERPROFILE: home },
            processRunner: async () => output,
        });
    }
    catch (error) {
        if (error instanceof RouterError)
            return error;
        throw error;
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
    throw new Error("the bridge returned instead of throwing");
}

describe("antigravity failure detail", () => {
    it("the child's own stderr reaches the thrown message", async () => {
        const reason = "a tool required the \"command\" permission that headless mode cannot prompt for";
        const error = await bridgeFailure({
            exitCode: 1,
            stdout: terminalEvent("failure", ""),
            stderr: `jetski: no output produced -- ${reason}`,
        });
        strictEqual(error.code, "upstream_protocol_error");
        ok(error.message.includes(reason), `the reason did not survive the throw: ${error.message}`);
        ok(error.message.includes("exit 1"), "the exit code is not in the message");
    });

    it("a secret-shaped value in stderr is redacted before it travels", async () => {
        // Composed at runtime on purpose: a literal secret-shaped string in this file
        // would be a true finding for scripts/secret-scan.mjs, and a test must not
        // punch a hole in a gate to prove a point.
        const canary = ["sk", "A".repeat(24)].join("-");
        const error = await bridgeFailure({
            exitCode: 1,
            stdout: terminalEvent("failure", ""),
            stderr: `auth failed for ${canary} while starting the tool`,
        });
        ok(!error.message.includes(canary), "the secret-shaped value left through the diagnostic channel");
        ok(error.message.includes("[REDACTED]"), "the redaction never fired");
    });

    it("an oversized stderr is bounded and says how much was dropped", async () => {
        const error = await bridgeFailure({
            exitCode: 1,
            stdout: terminalEvent("failure", ""),
            // Words, not one long run: a 2,000-character run of letters is itself
            // secret-shaped, so redaction collapses it to a single token and the
            // truncation never gets exercised. The first version of this test made
            // exactly that mistake and passed for the wrong reason.
            stderr: `head marker ${"noise ".repeat(400)}`,
        });
        ok(error.message.includes("head marker"), "the beginning of stderr was lost");
        ok(/more bytes\]/u.test(error.message), "the truncation is silent");
        ok(error.message.length < 1_200, `the message is unbounded: ${error.message.length} characters`);
    });

    it("SUCCESS with an empty response is a failure, named by the child's evidence", async () => {
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: terminalEvent("success", "   "),
            stderr: "jetski: no output produced -- the permission was auto-denied in headless mode",
        });
        strictEqual(error.code, "provider_tool_permission_denied");
        ok(error.message.includes("ONARIM:"), "an actionable code shipped without its remedy");
    });

    it("negative arm: an empty response WITHOUT that evidence is not called a permission denial", async () => {
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: terminalEvent("success", ""),
            stderr: "",
        });
        strictEqual(error.code, "upstream_protocol_error");
        ok(error.message.includes("child wrote nothing to stderr"), "the empty stderr is not stated");
    });

    it("negative arm: a non-empty response still succeeds", async () => {
        const home = mkdtempSync(join(tmpdir(), "agy-detail-ok-"));
        try {
            const result = await runAntigravityHeadless({
                binary: "agy.exe",
                cwd: home,
                home,
                prompt: "Reply with exactly: OK",
                model: "gemini-3.8-flash-high",
                environment: { PATH: "C:\\Windows", USERPROFILE: home },
                processRunner: async () => ({ exitCode: 0, stdout: terminalEvent("success", "OK"), stderr: "warning: noise" }),
            });
            strictEqual(result.response, "OK");
        }
        finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});
