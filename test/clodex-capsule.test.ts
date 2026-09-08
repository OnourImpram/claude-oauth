import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import type { N05Result } from "./fixtures/n05-capsule.js";

async function runIsolatedFixture(scenario: "auth-matrix" | "empty-nonce" | "child-missing-nonce" | "child-empty-nonce"): Promise<N05Result> {
    const scratch = await mkdtemp(join(tmpdir(), "n05-capsule-"));
    try {
        // Explicit env replaces inheritance: real OAuth, proxy, preload, and user
        // configuration must never enter this anonymous real-listener fixture.
        const env: NodeJS.ProcessEnv = {};
        for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
            const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
            if (key !== undefined)
                env[name] = process.env[key];
        }
        for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "CODEX_HOME", "TEMP", "TMP"]) {
            const directory = join(scratch, name.toLowerCase());
            await mkdir(directory);
            env[name] = directory;
        }
        env["PATH"] = dirname(process.execPath);
        const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/n05-capsule.js", import.meta.url)), scenario], {
            cwd: scratch, env, shell: false, windowsHide: true,
            // Never forward or retain arbitrary output, even on a failing test.
            stdio: ["ignore", "ignore", "ignore", "ipc"], timeout: 60_000,
        });
        let result: N05Result | undefined;
        let spawnFailed = false;
        child.once("error", () => { spawnFailed = true; });
        child.on("message", (message: N05Result) => { result = message; });
        const exitCode = await new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
        strictEqual(spawnFailed, false, "The isolated N05 fixture must spawn successfully.");
        strictEqual(exitCode, 0, "The isolated N05 fixture must complete successfully.");
        strictEqual(result?.completed, true, "The N05 fixture must report completed observations.");
        return result as N05Result;
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
}

it("the real Clodex listener authenticates health, catalog, and messages before JSON parsing", { timeout: 70_000 }, async () => {
    const result = await runIsolatedFixture("auth-matrix");
    strictEqual(result.rejected, false);
    deepStrictEqual(result.observations.map(({ path, arm, status }) => ({ path, arm, status })), [
        { path: "/health", arm: "absent", status: 401 },
        { path: "/health", arm: "wrong", status: 401 },
        { path: "/health", arm: "correct", status: 200 },
        { path: "/anthropic/v1/models", arm: "absent", status: 401 },
        { path: "/anthropic/v1/models", arm: "wrong", status: 401 },
        { path: "/anthropic/v1/models", arm: "correct", status: 200 },
        { path: "/anthropic/v1/messages", arm: "absent", status: 401 },
        { path: "/anthropic/v1/messages", arm: "wrong", status: 401 },
        { path: "/anthropic/v1/messages", arm: "correct", status: 400 },
    ]);
    strictEqual(result.observations[2]?.healthBody, true);
    strictEqual(result.observations[5]?.catalogBody, true);
    strictEqual(result.observations[5]?.modelCount, 1);
    strictEqual(result.observations[8]?.invalidJsonBody, true);
    strictEqual(result.readinessWorks, true, "readiness() must authenticate its health request.");
    strictEqual(result.catalogWorks, true, "catalog() must return the seeded local model.");
    strictEqual(result.closed, true, "close() must stop the real listener.");
});

it("the real Clodex capsule rejects an empty transport nonce at startup", { timeout: 70_000 }, async () => {
    const result = await runIsolatedFixture("empty-nonce");
    strictEqual(result.rejected, true, "An empty transport nonce must never start an unauthenticated capsule.");
    strictEqual(result.adapterUnavailable, true);
});

for (const scenario of ["child-missing-nonce", "child-empty-nonce"] as const) {
    it(`the prepared Clodex child exits before listening: ${scenario}`, { timeout: 70_000 }, async () => {
        const result = await runIsolatedFixture(scenario);
        deepStrictEqual(result.childGuard, { spawned: true, exitedNonzero: true, listenerResponded: false },
            "Missing or empty child nonce must cause a nonzero exit, even when HTTP auth would reject health.");
    });
}
