import { ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

// Removing the registry's parked-call emission must fail the plain-process arm.
// Running only inside node:test cannot measure that emission: the production
// logger intentionally suppresses its file sink when NODE_TEST_CONTEXT is set.
for (const mode of ["plain", "node-test"] as const) {
    it(`MCP parked-call log: ${mode === "plain" ? "real registry emits to router.log" : "node:test leaves router.log untouched"}`, async () => {
        const temporaryRoot = resolve(tmpdir());
        const scratch = resolve(await mkdtemp(join(temporaryRoot, "claude-oauth-park-log-")));
        const scratchRelative = relative(temporaryRoot, scratch);
        ok(scratchRelative !== "" && !scratchRelative.startsWith("..") && !isAbsolute(scratchRelative),
            "The fixture's cleanup target must stay inside the temporary directory.");
        try {
            const logDirectory = join(scratch, "Hezarfen", "claude-oauth");
            await mkdir(logDirectory, { recursive: true });
            const environment: NodeJS.ProcessEnv = {
                ...process.env,
                HOME: scratch,
                USERPROFILE: scratch,
                LOCALAPPDATA: scratch,
                HEZARFEN_MCP_PARK_LOG_MODE: mode,
            };
            delete environment["NODE_TEST_CONTEXT"];
            const child = spawnSync(process.execPath, [
                ...(mode === "node-test" ? ["--test"] : []),
                fileURLToPath(new URL("./fixtures/mcp-park-log.js", import.meta.url)),
            ], {
                cwd: scratch,
                env: environment,
                encoding: "utf8",
                timeout: 15_000,
                killSignal: "SIGKILL",
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            });
            strictEqual(child.error === undefined, true,
                "The real-registry logging fixture must start and finish within its timeout.");
            strictEqual(child.status, 0,
                `The real-registry logging fixture failed; status=${child.status}, signal=${child.signal}.`);
            const raw = await readFile(join(logDirectory, "router.log"), "utf8").catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
                return "";
            });
            const entries = raw.split("\n").filter((line) => line.trim() !== "")
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            if (mode === "node-test") {
                strictEqual(entries.length, 0, "node:test must not write fixture events to router.log.");
                return;
            }
            const parked = entries.filter((entry) => entry["event"] === "agent_tool_call_parked");
            strictEqual(parked.length, 1,
                "One real parked tool call must produce one agent_tool_call_parked entry in router.log.");
            strictEqual(parked[0]?.["route"], "mcp");
            strictEqual(parked[0]?.["level"], "info");
            strictEqual(parked[0]?.["code"], "Read");
        }
        finally {
            await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
    });
}
