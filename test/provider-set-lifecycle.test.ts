import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import type { ModelSnapshot, ProviderModelRecord } from "../src/domain/contracts.js";
import { OPENAI_MODEL_CONTRACTS } from "../src/domain/model-contracts.js";
import { runtimePaths } from "../src/runtime/paths.js";
import type { RunningClodexCapsule } from "../src/workers/clodex-capsule.js";

const scenarioVariable = "HEZARFEN_PROVIDER_SET_LIFECYCLE_SCENARIO";
const scenarios = ["catalog-failure", "verified", "catalog-drift"] as const;
type Scenario = typeof scenarios[number];

async function checkLifecycle(scenario: Scenario): Promise<void> {
    const contract = OPENAI_MODEL_CONTRACTS[0];
    if (contract === undefined)
        throw new Error("The lifecycle fixture requires an OpenAI model contract.");
    const snapshot: ModelSnapshot = {
        schemaVersion: 1,
        generatedAt: "2026-01-01T00:00:00.000Z",
        source: "lifecycle-test",
        models: [
            {
                id: "claude-test", provider: "anthropic", upstreamModel: "claude-test",
                displayName: "Claude test", oauthType: "claude.ai", executionMode: "native-message-loop",
                discoverable: true, capabilities: ["messages"],
            },
            {
                id: contract.id, provider: "openai", upstreamModel: contract.upstreamModel,
                displayName: contract.displayName, oauthType: "chatgpt", executionMode: "native-message-loop",
                discoverable: true, capabilities: ["messages"], contextWindow: contract.contextWindow,
                maximumOutputTokens: contract.maximumOutputTokens,
            },
        ],
    };
    const catalog: readonly ProviderModelRecord[] = scenario === "catalog-drift" ? [] : [{
        id: contract.upstreamModel, contextWindow: contract.contextWindow,
    }];
    let starts = 0;
    let closes = 0;
    const capsule: RunningClodexCapsule = {
        origin: new URL("http://127.0.0.1:1"),
        transportNonce: "",
        readiness: async () => ({ provider: "openai", oauthReady: true, adapterReady: true, status: "ready" }),
        catalog: async () => {
            if (scenario === "catalog-failure")
                throw new Error("Synthetic catalog failure");
            return catalog;
        },
        close: async () => { closes += 1; },
    };
    // Module mocking needs a startup flag, so each fixture runs in its own child below.
    // Local API reference: node_modules/@types/node/test.d.ts, MockTracker.module.
    const capsuleModule = mock.module(new URL("../src/workers/clodex-capsule.js", import.meta.url), {
        namedExports: {
            startClodexCapsule: async () => {
                starts += 1;
                return capsule;
            },
        },
    });
    try {
        const { startProviderSet } = await import("../src/supervisor/provider-set.js");
        // No directory is created: the capsule factory is mocked before the provider set loads.
        const paths = runtimePaths({ LOCALAPPDATA: join(import.meta.dirname, ".provider-set-lifecycle") });
        const providers = await startProviderSet(snapshot, paths, "");
        strictEqual(starts, 1);
        strictEqual(providers.adapters.has("anthropic"), true);
        strictEqual(providers.adapters.has("openai"), scenario === "verified");
        deepStrictEqual(providers.snapshot.models.map((model) => model.id),
            scenario === "verified" ? ["claude-test", contract.id] : ["claude-test"]);
        strictEqual(closes, scenario === "verified" ? 0 : 1,
            "An unused capsule must close before the provider set is returned.");
        const readiness = providers.readiness.find((entry) => entry.provider === "openai");
        strictEqual(readiness?.status, scenario === "verified" ? "ready" : "unavailable");
        if (scenario === "catalog-failure")
            strictEqual(readiness?.detailCode, "clodex_auth_or_startup_failed");
        if (scenario === "catalog-drift")
            strictEqual(readiness?.detailCode?.startsWith("clodex_session_catalog_drift:"), true);
        await providers.close();
        strictEqual(closes, 1, "A retained capsule closes at shutdown; a discarded capsule is not closed twice.");
    }
    finally {
        capsuleModule.restore();
    }
}

const childScenario = process.env[scenarioVariable];
if (childScenario === undefined) {
    for (const scenario of scenarios) {
        it(`provider capsule lifecycle: ${scenario}`, () => {
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
            strictEqual(child.error === undefined, true, "The lifecycle fixture child must start and finish within its timeout.");
            strictEqual(child.status, 0, `The ${scenario} fixture exited unsuccessfully; status=${child.status}, signal=${child.signal}.`);
        });
    }
}
else {
    if (!scenarios.includes(childScenario as Scenario))
        throw new Error("Unknown provider lifecycle fixture scenario.");
    await checkLifecycle(childScenario as Scenario);
}
