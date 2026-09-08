import { describe, it } from "node:test";
import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAntigravityHeadless } from "../src/antigravity/headless-bridge.js";
import { RouterError } from "../src/domain/errors.js";

// B07 (measured 2026-09-08 on the Agent inheritance arm): a headless permission denial left the
// bridge as HTTP 502, which Claude Code treats as transient and retries ten times with backoff,
// every retry meeting the same policy. A denial is terminal for the turn: 403, not retried.
// The negative arm keeps the empty-without-evidence case at 502 (a real upstream fault).
async function failure(stderr: string): Promise<RouterError> {
    const home = mkdtempSync(join(tmpdir(), "b07-"));
    try {
        await runAntigravityHeadless({
            binary: "agy.exe",
            cwd: home,
            home,
            prompt: "Reply with exactly: OK",
            model: "gemini-3.8-flash-high",
            environment: { PATH: "C:\\Windows", USERPROFILE: home },
            processRunner: async () => ({ exitCode: 0, stdout: `${JSON.stringify({ event: "result", result: { status: "success", response: "" } })}\n`, stderr }),
        });
        throw new Error("expected a RouterError");
    }
    catch (error) {
        if (error instanceof RouterError) return error;
        throw error;
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
}

describe("B07 headless permission denial status", () => {
    it("a permission denial is 403, a terminal answer for the turn", async () => {
        const error = await failure("jetski: no output produced -- the permission was auto-denied in headless mode");
        strictEqual(error.code, "provider_tool_permission_denied");
        strictEqual(error.status, 403);
    });
    it("negative arm: an empty response without denial evidence stays 502", async () => {
        const error = await failure("");
        strictEqual(error.code, "upstream_protocol_error");
        strictEqual(error.status, 502);
    });
});
