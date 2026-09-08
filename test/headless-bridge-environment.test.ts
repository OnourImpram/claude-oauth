import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAntigravityHeadless, type HeadlessProcessRequest } from "../src/antigravity/headless-bridge.js";

// The environment that goes to agy. 2026-09-05: agy updated itself in the background on
// every print launch and the pin (install-lock antigravity.sha256) dropped; the IsReadOnly
// flag does not stop the rename. The measured working countermeasure is
// AGY_CLI_DISABLE_AUTO_UPDATE="true" (the value "1" DOES NOT WORK -- in the experiment it
// still updated with "1"). This test checks that the variable reaches the agy process with
// its EXACT VALUE; negative arm: the test goes red when the variable carries the wrong
// value or is not set at all.
async function agyEnvironment(source: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const home = mkdtempSync(join(tmpdir(), "agy-env-"));
    let seen: HeadlessProcessRequest | undefined;
    try {
        const result = await runAntigravityHeadless({
            binary: "agy.exe",
            cwd: home,
            prompt: "Reply with exactly: OK",
            model: "gemini-3.8-flash-high",
            home,
            environment: source,
            processRunner: async (request) => {
                seen = request;
                // agy stream-json: single-line NDJSON, terminal "result" event (the shape parseResponse expects)
                return { exitCode: 0, stdout: JSON.stringify({ event: "result", result: { status: "success", response: "OK" } }) + "\n", stderr: "" };
            },
        });
        strictEqual(result.response, "OK");
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
    if (seen === undefined)
        throw new Error("the fake runner was never called");
    return seen.environment;
}

describe("antigravity process environment", () => {
    it("AGY_CLI_DISABLE_AUTO_UPDATE reaches agy with EXACTLY the value \"true\"", async () => {
        const environment = await agyEnvironment({ PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\test" });
        strictEqual(environment["AGY_CLI_DISABLE_AUTO_UPDATE"], "true");
        strictEqual(environment["AGY_CLI_HIDE_ACCOUNT_INFO"], "1");
    });
    it("an incorrect source-environment value (\"1\" / \"0\") is OVERRIDDEN -- the updater remains disabled", async () => {
        for (const incorrect of ["1", "0", "false", ""]) {
            const environment = await agyEnvironment({ PATH: "C:\\Windows", AGY_CLI_DISABLE_AUTO_UPDATE: incorrect });
            strictEqual(environment["AGY_CLI_DISABLE_AUTO_UPDATE"], "true", `source value ${JSON.stringify(incorrect)} was not overridden`);
        }
    });
    it("negative arm: the variable list is checked against its exact name (a wrong name is rejected)", async () => {
        const environment = await agyEnvironment({ PATH: "C:\\Windows" });
        deepStrictEqual(Object.keys(environment).filter((key) => /AUTO_UPDATE/u.test(key)), ["AGY_CLI_DISABLE_AUTO_UPDATE"]);
    });
});
