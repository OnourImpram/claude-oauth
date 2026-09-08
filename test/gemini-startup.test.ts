import { ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { RouterError } from "../src/domain/errors.js";
import type { GeminiAcpSession } from "../src/gemini/acp-bridge.js";

const scenarioVariable = "HEZARFEN_GEMINI_STARTUP_SCENARIO";
const scenarios = [
    "task-pre-aborted", "session-pre-aborted",
    "task-abort-during-preparation", "session-abort-during-preparation",
    "session-cancel-during-preparation", "task-active", "session-active",
] as const;
type Scenario = typeof scenarios[number];

async function checkStartup(scenario: Scenario): Promise<void> {
    let configurations = 0;
    let spawns = 0;
    let finishPreparation: (() => void) | undefined;
    const preparation = new Promise<string>((resolvePreparation) => {
        finishPreparation = () => resolvePreparation(join(import.meta.dirname, ".gemini-startup", "settings.json"));
    });
    const spawnReached = new Error("Synthetic provider spawn boundary reached");
    // Configuration normally writes files; spawn normally launches the provider. Replacing
    // these two boundaries keeps the real startup/cancellation ordering under test offline.
    // Local API reference: node_modules/@types/node/test.d.ts, MockTracker.module.
    const configurationModule = mock.module(new URL("../src/runtime/provider-config.js", import.meta.url), {
        namedExports: {
            ensureGeminiOAuthConfiguration: async () => {
                configurations += 1;
                return await preparation;
            },
        },
    });
    const childProcessModule = mock.module("node:child_process", {
        namedExports: {
            spawn: () => {
                spawns += 1;
                throw spawnReached;
            },
        },
    });
    try {
        const { runGeminiAcp, startGeminiAcpSession } = await import("../src/gemini/acp-bridge.js");
        const controller = new AbortController();
        const preAborted = scenario.endsWith("pre-aborted");
        const active = scenario.endsWith("active");
        if (preAborted)
            controller.abort();
        const options = {
            cwd: import.meta.dirname,
            home: join(import.meta.dirname, ".gemini-startup"),
            task: "Review the fixture.",
            signal: controller.signal,
        };
        let session: GeminiAcpSession | undefined;
        const operation = scenario.startsWith("task-")
            ? runGeminiAcp(options)
            : (session = startGeminiAcpSession(options)).done;
        if (scenario === "session-cancel-during-preparation")
            session?.cancel("Fixture cancellation during preparation");
        else if (scenario.endsWith("abort-during-preparation"))
            controller.abort();
        finishPreparation?.();
        const failure = await operation.then(() => undefined, (error: unknown) => error);
        strictEqual(configurations, preAborted ? 0 : 1,
            "A pre-aborted request must not start configuration.");
        strictEqual(spawns, active ? 1 : 0,
            "Only an active request may reach provider spawn.");
        if (active) {
            strictEqual(failure, spawnReached, "An active request must still reach the provider boundary.");
        }
        else {
            ok(failure instanceof RouterError, "Cancellation must return a router error.");
            strictEqual(failure.code, "upstream_timeout");
            strictEqual(failure.status, 504);
        }
    }
    finally {
        childProcessModule.restore();
        configurationModule.restore();
    }
}

const childScenario = process.env[scenarioVariable];
if (childScenario === undefined) {
    for (const scenario of scenarios) {
        it(`Gemini startup cancellation: ${scenario}`, () => {
            const child = spawnSync(process.execPath, [
                "--experimental-test-module-mocks", fileURLToPath(import.meta.url),
            ], {
                cwd: import.meta.dirname,
                env: { ...process.env, [scenarioVariable]: scenario },
                encoding: "utf8",
                timeout: 15_000,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            });
            strictEqual(child.error === undefined, true, "The startup fixture must finish within its timeout.");
            strictEqual(child.status, 0,
                `The ${scenario} fixture exited unsuccessfully; status=${child.status}, signal=${child.signal}.`);
        });
    }
}
else {
    if (!scenarios.includes(childScenario as Scenario))
        throw new Error("Unknown Gemini startup fixture scenario.");
    await checkStartup(childScenario as Scenario);
}
