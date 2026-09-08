import { ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { ModelRecord, ModelSnapshot, ProviderModelRecord } from "../src/domain/contracts.js";
import {
    AGENT_MODEL_CONTRACTS,
    OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS,
    OPENAI_CONTEXT_WINDOW_TOKENS,
    OPENAI_MODEL_CONTRACTS,
} from "../src/domain/model-contracts.js";
import { withVerifiedGoogleModels, withVerifiedGrokModel, withVerifiedOpenAiModels } from "../src/domain/model-refresh.js";
import { ModelRegistry, advertisedContextWindow, claudeClientDiscoveryId, modelDetail } from "../src/domain/registry.js";
import { antigravityAllowedModels } from "../src/antigravity/headless-bridge.js";
import { claudeOAuthAgentArguments } from "../src/supervisor/launcher.js";

// CASE RECORD -- this class repeated FOUR times in one day. Every time, a surface was
// hand-written instead of being derived from AGENT_MODEL_CONTRACTS, and every time adding a
// model to the contract left that surface SILENTLY out:
//
//   1. the alias validator in the local patch -> a model visible in the picker that the
//                                                validator rejected
//   2. the Antigravity probe list in cli.ts   -> a model never probed and never entering
//                                                the snapshot
//   3. the Antigravity allow list             -> a LOCAL refusal called
//                                                "model_not_available", reported as an
//                                                upstream refusal
//   4. delegate agent naming                  -> with a third Google model, TWO agents took
//                                                the same name and one was silently
//                                                overwritten
//
// This file is that class's mechanical measure: every underived surface goes red here.

const ALL_EXTERNAL_IDS = [...AGENT_MODEL_CONTRACTS, ...OPENAI_MODEL_CONTRACTS].map((contract) => contract.id);

function injectedAgentNames(availableModelIds: readonly string[]): readonly string[] {
    const rewritten = claudeOAuthAgentArguments([], availableModelIds);
    const index = rewritten.indexOf("--agents");
    if (index === -1)
        return [];
    return Object.keys(JSON.parse(rewritten[index + 1] ?? "{}") as Record<string, unknown>);
}

describe("the Antigravity allow list is derived from contracts", () => {
    it("every Google contract's upstream model is in the allow list", () => {
        for (const contract of AGENT_MODEL_CONTRACTS.filter((entry) => entry.provider === "google")) {
            strictEqual(antigravityAllowedModels.includes(contract.upstreamModel), true, `missing from the allow list: ${contract.upstreamModel}`);
        }
    });

    // NEGATIVE ARM: the list must not reach BEYOND the contracts -- that is the security check.
    it("the allow list does not extend beyond the set of contracts", () => {
        const reviewed = new Set(AGENT_MODEL_CONTRACTS.filter((entry) => entry.provider === "google").map((entry) => entry.upstreamModel));
        for (const model of antigravityAllowedModels) {
            strictEqual(reviewed.has(model), true, `model allowed without a contract: ${model}`);
        }
    });
});

describe("delegate agent names", () => {
    it("every external model contract produces EXACTLY ONE delegate", () => {
        const names = injectedAgentNames(ALL_EXTERNAL_IDS);
        for (const contract of [...AGENT_MODEL_CONTRACTS, ...OPENAI_MODEL_CONTRACTS]) {
            const expected = `${contract.alias}-delege`;
            strictEqual(names.includes(expected), true, `delegate was not generated: ${expected}`);
        }
    });

    // This was the actual defect: when two contracts produce the same name,
    // Object.fromEntries silently overwrites one and that model becomes undelegatable.
    it("delegate names NEVER COLLIDE", () => {
        const names = injectedAgentNames(ALL_EXTERNAL_IDS);
        strictEqual(new Set(names).size, names.length, `duplicate name present: ${names.join(", ")}`);
    });

    it("Grok also produces a delegate (the filter used to include only Google)", () => {
        const names = injectedAgentNames(ALL_EXTERNAL_IDS);
        strictEqual(names.includes("grok-delege"), true);
    });

    it("a delegate IS NOT injected for a model unverified in the snapshot", () => {
        const names = injectedAgentNames([]);
        for (const contract of [...AGENT_MODEL_CONTRACTS, ...OPENAI_MODEL_CONTRACTS]) {
            strictEqual(names.includes(`${contract.alias}-delege`), false, `leaked into an empty snapshot: ${contract.alias}`);
        }
    });
});

describe("native-gateway mode uses the full model identity", () => {
    // The native binary does not recognise aliases: values like "sol", produced for the
    // patched picker, return unrecognized_model on the native path. A delegate definition
    // must carry the FULL identity.
    it("delegate definitions carry the full snapshot identity in native mode", () => {
        const rewritten = claudeOAuthAgentArguments([], ALL_EXTERNAL_IDS, "native-gateway");
        const index = rewritten.indexOf("--agents");
        strictEqual(index !== -1, true);
        const parsed = JSON.parse(rewritten[index + 1] ?? "{}") as Record<string, { model?: string }>;
        for (const contract of [...AGENT_MODEL_CONTRACTS, ...OPENAI_MODEL_CONTRACTS]) {
            strictEqual(parsed[`${contract.alias}-delege`]?.model, contract.id, `alias remained in native mode: ${contract.alias}`);
        }
    });

    it("preserves aliases in patched mode", () => {
        const rewritten = claudeOAuthAgentArguments([], ALL_EXTERNAL_IDS, "patched-shadow");
        const index = rewritten.indexOf("--agents");
        const parsed = JSON.parse(rewritten[index + 1] ?? "{}") as Record<string, { model?: string }>;
        for (const contract of [...AGENT_MODEL_CONTRACTS, ...OPENAI_MODEL_CONTRACTS]) {
            strictEqual(parsed[`${contract.alias}-delege`]?.model, contract.alias, `full identity leaked into patched mode: ${contract.alias}`);
        }
    });

    it("--model IS NOT rewritten in native mode", () => {
        const rewritten = claudeOAuthAgentArguments(["--model", "anthropic-openai-gpt-5.6-sol"], ALL_EXTERNAL_IDS, "native-gateway");
        strictEqual(rewritten[1], "anthropic-openai-gpt-5.6-sol");
    });

    it("--model is converted to an alias in patched mode", () => {
        const rewritten = claudeOAuthAgentArguments(["--model", "anthropic-openai-gpt-5.6-sol"], ALL_EXTERNAL_IDS, "patched-shadow");
        strictEqual(rewritten[1], "sol");
    });
});

// ============================================================================
// ADVERTISED CONTEXT WINDOW (2026-09-05, Astra 1M).
//
// The ONLY window field that reaches Claude Code is the GET /v1/models response:
// gateway-models.json carries only {id, display_name}, and CLAUDE_CODE_AUTO_COMPACT_WINDOW
// comes from the contract. This block measures that surface: the advertisement derives from
// the contract, the MEASURED number in the snapshot is left intact, and no row without a
// contract gets an advertisement.
// ============================================================================

// The Astra seed of clodex 2.11.1 and the "max" stop of the 5.6 family: 872_000. The
// MECHANICAL proof that this number equals the pin in config/install-lock.json is not here
// but in the lock-reading arm of test/auto-compact-window.test.ts; all that is needed here
// is that it DIFFERS from the advertised number -- otherwise the override would be invisible.
const LIVE_WINDOW = 872_000;

const emptyBaseline: ModelSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    source: "pinned-install-baseline",
    models: [],
};

function liveCatalog(window: number): readonly ProviderModelRecord[] {
    return OPENAI_MODEL_CONTRACTS.map((contract) => ({
        id: contract.upstreamModel,
        contextWindow: window,
        maximumOutputTokens: contract.maximumOutputTokens,
    }));
}

function discoveryRows(snapshot: ModelSnapshot): readonly Record<string, unknown>[] {
    const payload = new ModelRegistry(snapshot, new Map()).discoveryPayload();
    return payload["data"] as readonly Record<string, unknown>[];
}

const verifiedSnapshot = withVerifiedOpenAiModels(emptyBaseline, liveCatalog(LIVE_WINDOW), LIVE_WINDOW);

// A single Astra row factory: both describes use it. `contextWindow` has to be overridable
// -- that is the REAL trigger of the `[1m]` suffix (see below).
function astraRow(over: {
    readonly id?: string;
    readonly provider?: ModelRecord["provider"];
    readonly upstreamModel?: string;
    readonly contextWindow?: number;
} = {}): ModelRecord {
    return {
        id: over.id ?? "anthropic-openai-gpt-6-astra",
        provider: over.provider ?? "openai",
        upstreamModel: over.upstreamModel ?? "anthropic-openai-oauth__gpt-6-astra",
        displayName: "GPT-6 Astra via ChatGPT OAuth",
        oauthType: "chatgpt",
        executionMode: "native-message-loop",
        discoverable: true,
        contextWindow: over.contextWindow ?? LIVE_WINDOW,
        capabilities: ["messages"],
    };
}


describe("the window advertised to Claude Code is derived from the contract", () => {
    it("B06 Astra keeps the context advertisement separate from its pinned input capacity", () => {
        const line = discoveryRows(verifiedSnapshot).find((entry) => String(entry["id"]).startsWith("anthropic-openai-gpt-6-astra"));
        ok(line !== undefined, "Astra discovery row is missing");
        strictEqual(line["context_window"], OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS);
        strictEqual(line["max_input_tokens"], LIVE_WINDOW);
        strictEqual(OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS, 1_000_000);
    });

    it("B06 every routed model advertises max_input_tokens at or below its snapshot pin", async () => {
        const lock = JSON.parse(await readFile(resolve("config/install-lock.json"), "utf8")) as { claudeShadow: { openAiContextWindow: number } };
        const pin = lock.claudeShadow.openAiContextWindow;
        ok(Number.isSafeInteger(pin) && pin > 0);
        const openAi = withVerifiedOpenAiModels(emptyBaseline, liveCatalog(pin), pin);
        const google = withVerifiedGoogleModels(openAi, AGENT_MODEL_CONTRACTS.filter((model) => model.provider === "google").map((model) => model.upstreamModel));
        const snapshot = withVerifiedGrokModel(google, AGENT_MODEL_CONTRACTS.filter((model) => model.provider === "xai").map((model) => ({ id: model.upstreamModel, contextWindow: model.contextWindow })));
        const rows = discoveryRows(snapshot);
        strictEqual(rows.length, ALL_EXTERNAL_IDS.length, "every routed contract must be covered");
        for (const model of snapshot.models) {
            const row = rows.find((entry) => entry["id"] === claudeClientDiscoveryId(model));
            ok(row !== undefined, `missing discovery row: ${model.id}`);
            const input = row["max_input_tokens"];
            ok(typeof input === "number" && input > 0, `missing capacity: ${model.id}`);
            ok(model.contextWindow !== undefined && input <= model.contextWindow, `input capacity exceeds snapshot pin: ${model.id}`);
            if (model.provider === "openai") ok(input <= pin, `input capacity exceeds install-lock pin: ${model.id}`);
        }
    });

    it("B06 input capacity follows a smaller snapshot window even with an Astra advertisement", () => {
        const snapshot = { ...emptyBaseline, models: [astraRow({ contextWindow: 272_000 })] };
        const row = discoveryRows(snapshot)[0];
        strictEqual(row?.["context_window"], OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS);
        strictEqual(row?.["max_input_tokens"], 272_000);
    });

    // EVIDENCE GRAMMAR: the advertisement is a POLICY number, not a measurement. The
    // snapshot is the record of the measurement and is not overwritten -- were it
    // overwritten, the drift detector would be matching against itself.
    it("the Astra snapshot row preserves the MEASURED live value, not the advertised one", () => {
        const astra = verifiedSnapshot.models.find((model) => model.id === "anthropic-openai-gpt-6-astra");
        strictEqual(astra?.contextWindow, LIVE_WINDOW);
    });

    // NEGATIVE ARM: the override is SPECIFIC to Astra. Sol/Terra show the measured number,
    // not the advertised one; had it leaked, two models would run on the wrong budget.
    //
    // FIX 2026-09-05 (audit FINDING 2). The loop used to iterate over
    // `.filter((entry) => entry.advertisedContextWindow === undefined)` -- that is, exactly
    // the class of change it PROTECTED against emptied the filter. MEASURED (this run,
    // staging): when the advertisement was added to the Sol and Terra contracts too, the
    // loop length fell to 0, the arm stayed GREEN, and all three models started advertising
    // 1_000_000. The only arm that caught the leak was the one auditing the table's SHAPE;
    // it was not this arm, which audits behaviour.
    //
    // Two changes: the filter now derives from the ALIAS (the loop walks the same rows even
    // if the advertisement leaks) and the scope claim is stated up front -- an empty set is
    // now red, not a silent pass.
    it("the Sol/Terra advertisement stays unchanged: it remains the live value", () => {
        const rows = discoveryRows(verifiedSnapshot);
        const nonAstraContracts = OPENAI_MODEL_CONTRACTS.filter((entry) => entry.alias !== "astra");
        strictEqual(nonAstraContracts.length, OPENAI_MODEL_CONTRACTS.length - 1, "coverage: every row other than Astra must be measured");
        ok(nonAstraContracts.length >= 2, `coverage is empty or incomplete: ${nonAstraContracts.length} contracts`);
        for (const contract of nonAstraContracts) {
            const line = rows.find((entry) => String(entry["id"]).startsWith(contract.id));
            ok(line !== undefined, `discovery row is missing: ${contract.id}`);
            strictEqual(line["context_window"], LIVE_WINDOW, `advertised override leaked: ${contract.id}`);
        }
    });

    // FIX 2026-09-05 (audit FINDING 1). This arm's old comment claimed "if someone sets the
    // advertisement equal to the ceiling, the picker row's name changes silently and this
    // arm goes red". MEASURED (this run, staging): the advertisement was raised to
    // 1_050_000, the identity STAYED `anthropic-openai-gpt-6-astra`, and the arm went GREEN.
    // claudeClientDiscoveryId looks at `model.contextWindow` -- that is, at the SNAPSHOT
    // number; it never sees the advertised number, and cannot change with what it does not
    // see.
    //
    // What the arm now measures is the real invariant: identity derives from the snapshot
    // window. Three negative arms plus ONE POSITIVE; without the positive, "the suffix was
    // not attached" and "the instrument is broken" would look identical. Keeping the
    // advertisement at 1_000_000 is another arm's job ("Astra advertises 1_000_000"),
    // because its rationale is not the picker: a round number and headroom under the ceiling.
    it("picker identity derives from the SNAPSHOT window, NOT the advertised one", () => {
        const identities = discoveryRows(verifiedSnapshot).map((entry) => String(entry["id"]));
        strictEqual(identities.includes("anthropic-openai-gpt-6-astra"), true);
        strictEqual(identities.includes("anthropic-openai-gpt-6-astra[1m]"), false);
        strictEqual(claudeClientDiscoveryId(astraRow()), "anthropic-openai-gpt-6-astra");

        // POSITIVE ARM -- the suffix CAN in fact be attached, and its trigger is the
        // snapshot window becoming equal to the contract ceiling. If this arm does not fall,
        // the three negative arms above are measuring nothing.
        strictEqual(claudeClientDiscoveryId(astraRow({ contextWindow: OPENAI_CONTEXT_WINDOW_TOKENS })), "anthropic-openai-gpt-6-astra[1m]");
    });

    // NEGATIVE ARM: a model that never entered the snapshot CANNOT BE ADVERTISED either. The
    // constant in the contract cannot produce a picker row on its own -- verification is
    // still the gate itself.
    it("nothing is advertised for Astra when the live catalog does not contain it", () => {
        const withoutAstra = liveCatalog(LIVE_WINDOW).filter((entry) => !entry.id.includes("astra"));
        const identities = discoveryRows(withVerifiedOpenAiModels(emptyBaseline, withoutAstra, LIVE_WINDOW))
            .map((entry) => String(entry["id"]));
        strictEqual(identities.some((id) => id.startsWith("anthropic-openai-gpt-6-astra")), false);
        strictEqual(identities.includes("anthropic-openai-gpt-5.6-sol"), true, "the other lane must remain available");
    });
});

describe("advertisedContextWindow -- override boundaries", () => {
    it("returns the advertised value for a row with a contract", () => {
        strictEqual(advertisedContextWindow(astraRow()), OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS);
    });

    // A window is NOT invented for a row that has none: a missing measurement is not zero.
    it("returns undefined for a row without a window", () => {
        const withoutWindow: ModelRecord = {
            id: "anthropic-openai-gpt-6-astra",
            provider: "openai",
            upstreamModel: "anthropic-openai-oauth__gpt-6-astra",
            displayName: "GPT-6 Astra via ChatGPT OAuth",
            oauthType: "chatgpt",
            executionMode: "native-message-loop",
            discoverable: true,
            capabilities: ["messages"],
        };
        strictEqual(advertisedContextWindow(withoutWindow), undefined);
    });

    // NEGATIVE ARM: identity is not enough. A row that does not route to the contract's
    // upstream model cannot inherit Astra's advertisement -- if it could, a request going
    // somewhere else would be set up with Astra's budget.
    it("a row with a mismatched upstream model or provider DOES NOT INHERIT the advertisement", () => {
        strictEqual(advertisedContextWindow(astraRow({ upstreamModel: "another-model" })), LIVE_WINDOW);
        strictEqual(advertisedContextWindow(astraRow({ provider: "anthropic" })), LIVE_WINDOW);
    });

    it("a model without a contract is advertised with its own measured window", () => {
        strictEqual(advertisedContextWindow(astraRow({ id: "claude-opus-5", provider: "anthropic", upstreamModel: "claude-opus-5" })), LIVE_WINDOW);
    });
});

describe("the advertised window lives in ONE place in the contract table", () => {
    it("advertisedContextWindow is defined only for Astra", () => {
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            const expected = contract.alias === "astra" ? OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS : undefined;
            strictEqual(contract.advertisedContextWindow, expected, `unexpected advertisement: ${contract.id}`);
        }
    });

    // An override with no source is folklore: nobody can verify the number, nobody can delete it.
    it("every contract with an advertisement carries its SOURCE; contracts without one do not", () => {
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            const hasAdvertisement = contract.advertisedContextWindow !== undefined;
            strictEqual((contract.contextWindowSource ?? "").length > 0, hasAdvertisement, `source/advertisement mismatch: ${contract.id}`);
        }
    });

    // The source note is not a string but a QUOTE: it names the primary page and the atom taken from it.
    it("Astra's source note includes the primary page and the quote", () => {
        const astra = OPENAI_MODEL_CONTRACTS.find((contract) => contract.alias === "astra");
        const source = astra?.contextWindowSource ?? "";
        strictEqual(source.includes("developers.openai.com/api/docs/models/gpt-6-astra"), true, "model card is missing");
        strictEqual(source.includes("1,050,000 context window"), true, "quote from the model card is missing");
        strictEqual(source.includes("272K input tokens"), true, "pricing boundary exception is missing");
    });

    // FIX 2026-09-05 (audit FINDING 4). The em dash in the rate card sentence had been
    // downgraded to ASCII "--", and the downgrade was done INSIDE THE QUOTE, unmarked. The
    // repository is not ASCII-only (measured: 11 files under src/ test/ scripts/ already
    // carry U+A7/U+B7/U+FC), so the correct fix is the character itself, not a footnote. The
    // arm runs both ways: the correct character IS present and the downgraded form is NOT --
    // one-way, the "neither is present" state would pass silently.
    it("the rate card quote preserves the em dash EXACTLY, without downgrading it to ASCII", () => {
        const astra = OPENAI_MODEL_CONTRACTS.find((contract) => contract.alias === "astra");
        const source = astra?.contextWindowSource ?? "";
        strictEqual(source.includes("GPT-6 Astra \u2014 Codex long-context exception"), true, "em dash was downgraded to ASCII");
        strictEqual(source.includes("GPT-6 Astra -- Codex long-context exception"), false, "ASCII downgrade has returned");
    });

    // An advertisement cannot exceed the contract's CEILING: openAiCatalogEntry filters the
    // live number against that ceiling, and an advertisement above it would hand Claude Code
    // a budget the model would reject.
    it("no advertised window exceeds the contract ceiling", () => {
        // CLASS SWEEP (same pattern as FINDING 2): a loop containing `continue` also passes
        // silently on an empty set. The counter asserts what the arm measures.
        let measuredCount = 0;
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            if (contract.advertisedContextWindow === undefined)
                continue;
            measuredCount += 1;
            strictEqual(contract.advertisedContextWindow <= contract.contextWindow, true, `ceiling exceeded: ${contract.id}`);
        }
        ok(measuredCount >= 1, "coverage: no contract advertises a window; the arm succeeded vacuously");
    });
});

// ============================================================================
// OPERATOR SURFACE (audit FINDING 3, 2026-09-05)
//
// `claude-oauth models --refresh` and `claude-oauth doctor` built their model lines BY HAND,
// in two separate places and identically to each other, and printed ONLY the measured
// window. For Astra that number is 872_000; the one told to Claude Code is 1_000_000. The
// concrete accident: a correct release is pinned, the main session reflexively runs
// `doctor`, sees 872_000 and concludes "the change did not land". The only place the
// advertised number was visible was the running router's GET /v1/models endpoint.
// ============================================================================

describe("the operator surface shows measured and advertised values under SEPARATE names", () => {
    it("the Astra row carries both values", () => {
        const astra = verifiedSnapshot.models.find((model) => model.id === "anthropic-openai-gpt-6-astra");
        ok(astra !== undefined, "Astra snapshot row is missing");
        const line = modelDetail(astra);
        strictEqual(line["contextWindow"], LIVE_WINDOW, "measured value was lost");
        strictEqual(line["advertisedContextWindow"], OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS, "advertised value is not printed");
    });

    // The field is written ONLY when the two numbers differ. Repeating "872000 = 872000"
    // tells the operator nothing, and what comes with noise is blindness.
    it("the field is NEVER written for a row without an advertisement", () => {
        const sol = verifiedSnapshot.models.find((model) => model.id === "anthropic-openai-gpt-5.6-sol");
        ok(sol !== undefined, "Sol snapshot row is missing");
        const line = modelDetail(sol);
        strictEqual(line["contextWindow"], LIVE_WINDOW);
        strictEqual("advertisedContextWindow" in line, false, "unnecessary field was written");
    });

    // MECHANICAL ARM. The two arms above measure the helper; this arm measures that cli.ts
    // ACTUALLY uses it. The lines were hand-written once and broke in both places at once --
    // if they are hand-written again this goes red, rather than silently returning to the
    // old behaviour.
    it("cli.ts derives every modelDetails row from this helper", async (t) => {
        const cliPath = resolve(import.meta.dirname, "..", "..", "src", "cli.ts");
        let source: string;
        try {
            source = await readFile(cliPath, "utf8");
        }
        catch (error) {
            // Evidence grammar: a check that could not run is NOT a silent pass, it is skipped with its reason.
            t.skip(`could not read src/cli.ts: ${(error as Error).message}`);
            return;
        }
        const rows = [...source.matchAll(/modelDetails:\s*([^\r\n]*)/g)].map((match) => match[1] ?? "");
        ok(rows.length >= 2, `coverage: fewer modelDetails rows than expected (${rows.length})`);
        for (const line of rows)
            strictEqual(line.includes("map(modelDetail)"), true, `hand-written modelDetails row: ${line}`);
    });
});
