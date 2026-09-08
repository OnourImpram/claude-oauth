import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ModelSnapshot } from "../src/domain/contracts.js";
import { agentModelContract } from "../src/domain/model-contracts.js";
import { runtimePaths } from "../src/runtime/paths.js";
import { startProviderSet } from "../src/supervisor/provider-set.js";

// A4 (2026-09-02): a SIDE provider that violates the lock does not stop the set from
// coming up -- its adapter is not installed, its models drop out of the served snapshot,
// and readiness says so BY NAME. The main path (anthropic) is left untouched.
// openai/google are not requested so the test starts neither the clodex capsule nor the
// agy binary: only the pure branches run.
const GROK = agentModelContract("anthropic-xai-grok-4.6");
if (GROK === undefined)
    throw new Error("Grok contract is missing: AGENT_MODEL_CONTRACTS changed");
const snapshot: ModelSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    source: "pinned-install-baseline",
    models: [
        {
            id: "claude-opus-5",
            provider: "anthropic",
            upstreamModel: "claude-opus-5",
            displayName: "Claude Opus 5",
            oauthType: "claude.ai",
            executionMode: "native-message-loop",
            discoverable: true,
            capabilities: ["messages"],
        },
        // Derived from the contract: isVerifiedAgentSnapshotRoute compares every field
        // against the contract; a hand-written constant silently empties the test when the
        // contract changes.
        {
            id: GROK.id,
            provider: GROK.provider,
            upstreamModel: GROK.upstreamModel,
            displayName: GROK.displayName,
            oauthType: GROK.oauthType,
            contextWindow: GROK.contextWindow,
            executionMode: "agent-readonly",
            discoverable: true,
            capabilities: ["messages", "streaming"],
        },
    ],
};

describe("startProviderSet -- A4 side provider disabled", () => {
    let directory: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "provider-set-"));
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("xai in disabledProviders is reported with install_lock_drift and its models are dropped", async () => {
        const set = await startProviderSet(snapshot, runtimePaths({ LOCALAPPDATA: directory }), "nonce", {
            cwd: directory,
            environment: {},
            antigravityBinary: join(directory, "missing-agy.exe"),
            grokBinary: join(directory, "missing-grok.exe"),
            disabledProviders: new Set(["xai"]),
        });
        try {
            const xai = set.readiness.find((entry) => entry.provider === "xai");
            ok(xai !== undefined, "xai readiness row exists");
            strictEqual(xai.status, "unavailable");
            strictEqual(xai.detailCode, "install_lock_drift");
            deepStrictEqual(set.snapshot.models.map((model) => model.id), ["claude-opus-5"], "xai model is not served");
            ok(!set.adapters.has("xai"), "xai adapter is not installed");
            ok(set.adapters.has("anthropic"), "the main path remains untouched");
        }
        finally {
            await set.close();
        }
    });

    // NEGATIVE ARM: same snapshot, disabled set EMPTY -> the xai branch takes its normal
    // path (no real binary, but the adapter is installed and its model stays in the list).
    // If the first test could not tell this arm apart, "install_lock_drift" would be a
    // label, not a measure.
    it("an empty disabled set does not degrade the xai branch: the adapter is installed and the model stays", async () => {
        const set = await startProviderSet(snapshot, runtimePaths({ LOCALAPPDATA: directory }), "nonce", {
            cwd: directory,
            environment: {},
            antigravityBinary: join(directory, "missing-agy.exe"),
            grokBinary: join(directory, "missing-grok.exe"),
        });
        try {
            const xai = set.readiness.find((entry) => entry.provider === "xai");
            ok(xai !== undefined);
            ok(xai.detailCode !== "install_lock_drift", `an empty set must not produce install_lock_drift (${xai.detailCode})`);
            deepStrictEqual(set.snapshot.models.map((model) => model.id), ["claude-opus-5", "anthropic-xai-grok-4.6"]);
        }
        finally {
            await set.close();
        }
    });
});
