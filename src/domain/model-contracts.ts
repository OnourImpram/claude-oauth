import { SUPERVISOR_DETAIL_CODE_LIMIT } from "./contracts.js";
import type { ModelRecord, ProviderModelRecord, ProviderReadiness } from "./contracts.js";
export const OPENAI_CONTEXT_WINDOW_TOKENS = 1_050_000;
export const OPENAI_MAXIMUM_OUTPUT_TOKENS = 128_000;
export const ANTIGRAVITY_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const GROK_MODEL_ID = "grok-4.7";
// Advertised window: xAI's model page lists grok-4.7 at "500k" (docs.x.ai/docs/models, read
// 2026-09-29). The Grok CLI 1.0.40 ACP catalog reports 256_000 for the same id; the catalog
// check below pins THAT value, so a catalog change is still caught as drift.
export const GROK_CONTEXT_WINDOW_TOKENS = 500_000;
export const GROK_CATALOG_CONTEXT_WINDOW_TOKENS = 256_000;
export const GROK_AUTO_COMPACT_THRESHOLD_PERCENT = 85;
// OpenAI prices a request whose context crosses this boundary at 2x input and 1.5x
// output -- for the WHOLE request, not just the excess. The multipliers were read
// from OpenAI's own pricing page on 2026-08-31 (sol 4.00->8.00 in, 20.00->30.00 out;
// terra 2.00->4.00 and 12.00->18.00). The boundary VALUE is printed there only for
// gpt-5.5/5.4 ("<272K context length"); for 5.6 it is carried over and therefore
// unverified. Treated as real because being wrong costs 2x and being right costs
// nothing.
export const OPENAI_LONG_CONTEXT_PRICING_BOUNDARY_TOKENS = 272_000;
// Auto-compaction windows, one per model family. Claude Code reads this from
// CLAUDE_CODE_AUTO_COMPACT_WINDOW and takes min(setting, model context window),
// so a value above the model's own window is silently harmless but pointless.
//
// Sol/Terra: below the pricing boundary, with enough headroom that the turn which
// TRIGGERS compaction -- it still carries its own tool results -- does not cross the
// boundary on the very request meant to prevent that.
//
// MEASURED 2026-09-01, and the reason this moved off 200_000. A threshold is only
// correct relative to where its environment STARTS, and that had never been measured.
// Across 64 vault sessions the fixed opening cost (system prompt + tool definitions +
// MCP surface + skill list, before any conversation) at the first assistant turn was:
//     min 17_669 · median 173_046 · max 497_349
// Against a 200_000 threshold the median session had 26_954 tokens left for actual
// conversation, and 20 of 64 sessions (31%) were ALREADY past the threshold on their
// first reply. Compaction cannot recover that: it shortens the conversation, never the
// fixed opening cost, so the session re-compacts at once and the context reads full
// again -- the reported "context fills immediately, still full after compact".
//
// 220_000 holds every invariant in test/auto-compact-window.test.ts (52_000 of headroom,
// still under the boundary) and raises usable conversation room by ~74%. It is a
// PALLIATIVE, not the cure: the dominant term is the 173_046 opening cost, not this
// constant. Cutting the installed surface (06-Altyapi/scripts/eklenti-maliyet-denetimi.py)
// is what actually fixes this lane, and it helps every model rather than these two.
export const OPENAI_AUTO_COMPACT_WINDOW_TOKENS = 220_000;
// GPT-6 Astra ADVERTISED window -- what the router tells Claude Code in GET /v1/models,
// NOT what any provider snapshot measured. The two numbers are deliberately different and
// live in different places: the snapshot keeps the measured live number (872_000 today) so
// openAiSnapshotRouteDrift can still see a live catalogue move; this constant is a policy
// projection applied to context_window only (src/domain/registry.ts). It must never raise
// max_input_tokens above the snapshot's pinned transport capacity. Accepted capacity above
// that pin is unproven; a model-card advertisement does not establish OAuth acceptance.
//
// 1_000_000 rather than the model card's own 1,050,000, and the reason is NOT the picker id.
//
// B10 (2026-09-10): this constant NOW DOES reach the picker id. B08 measured that Claude Code
// ignores discovery's context_window and assumes 200k without the `[1m]` suffix, so the
// advertised window that only lived in GET /v1/models was never seen by the client: Astra ran
// at 200k. claudeClientDiscoveryId attaches the suffix when the advertised window reaches
// 1_000_000. The history below is kept as the record of the earlier, refuted assumption.
//
// CORRECTED 2026-09-05 (independent audit FINDING 1, reproduced in this run). This comment used
// to claim the value stayed clear of claudeClientDiscoveryId's `[1m]` suffix rule. It could not
// then: that rule read model.contextWindow -- the SNAPSHOT number -- and this constant never
// reached it. MEASURED by raising the constant to 1_050_000 in the staging tree: the picker id
// stayed `anthropic-openai-gpt-6-astra`, no suffix. The suffix fired only when the SNAPSHOT itself
// reaches 1_050_000 (measured in the same run), which is a different lever with its own branch
// in test/contract-derivation.test.ts.
//
// What actually decides the number: it is the round figure Claude Code's own 1M lane uses, and
// it leaves headroom under the model card's 1,050,000 ceiling instead of sitting flush against
// it. Both are preferences rather than constraints -- which is precisely why the value is held
// by an equality branch and not by an inequality that would let it drift.
export const OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS = 1_000_000;
// Astra compacts at 650_000 -- ABOVE the 272_000 pricing boundary that governs Sol/Terra,
// and that is not an oversight. Two measured facts license it, and both are named in the
// contract's contextWindowSource: the Codex long-context exception removes the multiplier on
// this lane, and clodex's real ceiling for Astra is 872_000, which 650_000 stays under with
// 222_000 of headroom for the turn that triggers compaction.
export const OPENAI_ASTRA_AUTO_COMPACT_WINDOW_TOKENS = 650_000;
// Grok: 70% of the announced 500_000, and deliberately BELOW Grok's own 85%
// (425_000) internal trigger so exactly one compaction authority is in charge.
// Two summarizers firing near each other double-summarize the same history.
export const GROK_AUTO_COMPACT_WINDOW_TOKENS = 350_000;
// Google: ~76% of 1_048_576. No token pricing boundary applies on this lane (the
// quota is per-request, not per-token), so the only constraint is the hard wall.
export const ANTIGRAVITY_AUTO_COMPACT_WINDOW_TOKENS = 800_000;
export type AgentModelAlias = "gemini" | "argon" | "carbon" | "hydrogen" | "orchestrator" | "orchestrator-argon" | "opus-google" | "sonnet-google" | "grok";
export interface AgentModelContract {
    readonly alias: AgentModelAlias;
    readonly id: string;
    readonly provider: "google" | "xai";
    readonly upstreamModel: string;
    readonly displayName: string;
    readonly oauthType: "google-cli" | "xai-cli";
    readonly contextWindow: number;
    readonly autoCompactWindow: number;
}
export const AGENT_MODEL_CONTRACTS: readonly AgentModelContract[] = [
    {
        alias: "gemini",
        id: "anthropic-google-gemini-3.8-flash-high",
        provider: "google",
        upstreamModel: "gemini-3.8-flash-high",
        displayName: "Gemini 3.8 Flash High via Google OAuth",
        oauthType: "google-cli",
        contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
        autoCompactWindow: ANTIGRAVITY_AUTO_COMPACT_WINDOW_TOKENS,
    },
    // RETIRED 2026-11-15: alias `gemini-pro` (gemini-3.1-pro-high). MEASURED with `agy models`
    // (agy 1.5.9): the catalogue lists 22 models and no gemini-3.1-pro row, so the row could not
    // be served. The alias is NOT repointed to another model: the selected model is the model
    // that answers. Carbon, Hydrogen and the two Orchestrator rows below are the successors.
    // Gemini 4 Argon (2026-10-18). MEASURED with `agy models` (agy 1.3.1) on this machine's Google AI
    // Ultra account: `gemini-4-argon-{low,medium,high}` are listed; only the High row is contracted,
    // matching every other Antigravity row. The catalogue and antigravity.google/docs/models publish
    // NO context window for Argon, so the shared Antigravity constants are INHERITED, not measured.
    {
        alias: "argon",
        id: "anthropic-google-gemini-4-argon-high",
        provider: "google",
        upstreamModel: "gemini-4-argon-high",
        displayName: "Gemini 4 Argon High via Google OAuth",
        oauthType: "google-cli",
        contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
        autoCompactWindow: ANTIGRAVITY_AUTO_COMPACT_WINDOW_TOKENS,
    },
    // Added 2026-11-15. MEASURED with `agy models` (agy 1.5.9) on this machine's Google account: the catalogue
    // lists `gemini-4-carbon-high`, `gemini-4-hydrogen-xhigh`, `gemini-pro-orchestrator`, `gemini-pro-orchestrator-argon`. Each row below answered a live one-line probe through the same flags the
    // headless bridge passes before it was contracted. Like Argon, the catalogue publishes no context
    // window for these, so the shared Antigravity constants are INHERITED, not measured.
    {
        alias: "carbon",
        id: "anthropic-google-gemini-4-carbon-high",
        provider: "google",
        upstreamModel: "gemini-4-carbon-high",
        displayName: "Gemini 4 Carbon High via Google OAuth",
        oauthType: "google-cli",
        contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
        autoCompactWindow: ANTIGRAVITY_AUTO_COMPACT_WINDOW_TOKENS,
    },
    {
        alias: "hydrogen",
        id: "anthropic-google-gemini-4-hydrogen-xhigh",
        provider: "google",
        upstreamModel: "gemini-4-hydrogen-xhigh",
        displayName: "Gemini 4 Hydrogen XHigh via Google OAuth",
        oauthType: "google-cli",
        contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
        autoCompactWindow: ANTIGRAVITY_AUTO_COMPACT_WINDOW_TOKENS,
    },
    {
        alias: "orchestrator",
        id: "anthropic-google-gemini-pro-orchestrator",
        provider: "google",
        upstreamModel: "gemini-pro-orchestrator",
        displayName: "Gemini Orchestrator Carbon via Google OAuth",
        oauthType: "google-cli",
        contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
        autoCompactWindow: ANTIGRAVITY_AUTO_COMPACT_WINDOW_TOKENS,
    },
    {
        alias: "orchestrator-argon",
        id: "anthropic-google-gemini-pro-orchestrator-argon",
        provider: "google",
        upstreamModel: "gemini-pro-orchestrator-argon",
        displayName: "Gemini Orchestrator Argon via Google OAuth",
        oauthType: "google-cli",
        contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
        autoCompactWindow: ANTIGRAVITY_AUTO_COMPACT_WINDOW_TOKENS,
    },
    // Claude via Antigravity moved 4.6 -> 5.5 (2026-10-05). MEASURED on this machine's Google AI
    // Ultra account with `agy models` (agy 1.1.27): claude-opus-5-5-{low,medium,high} and
    // claude-sonnet-5-5-{low,medium,high} are listed, claude-opus-4-6-thinking is NOT. Antigravity's
    // models page (antigravity.google/docs/models, read the same day) marks the 4.6 rows unavailable
    // on Ultra and "Will be removed on November 2, 2026"; the 5.5 rows are Pro (non-trial) and Ultra
    // only. The alias opus-google is kept so every caller (delege-hat, model-sor) keeps working.
    {
        alias: "opus-google",
        id: "anthropic-google-claude-opus-5-5-high",
        provider: "google",
        upstreamModel: "claude-opus-5-5-high",
        displayName: "Claude Opus 5.5 High via Google OAuth",
        oauthType: "google-cli",
        contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
        autoCompactWindow: ANTIGRAVITY_AUTO_COMPACT_WINDOW_TOKENS,
    },
    {
        alias: "sonnet-google",
        id: "anthropic-google-claude-sonnet-5-5-high",
        provider: "google",
        upstreamModel: "claude-sonnet-5-5-high",
        displayName: "Claude Sonnet 5.5 High via Google OAuth",
        oauthType: "google-cli",
        contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
        autoCompactWindow: ANTIGRAVITY_AUTO_COMPACT_WINDOW_TOKENS,
    },
    {
        alias: "grok",
        id: "anthropic-xai-grok-4.7",
        provider: "xai",
        upstreamModel: GROK_MODEL_ID,
        displayName: "Grok 4.7 via xAI OAuth",
        oauthType: "xai-cli",
        contextWindow: GROK_CONTEXT_WINDOW_TOKENS,
        autoCompactWindow: GROK_AUTO_COMPACT_WINDOW_TOKENS,
    },
];
export function agentModelContract(modelId: string): AgentModelContract | undefined {
    return AGENT_MODEL_CONTRACTS.find((entry) => entry.id === modelId);
}
export function isVerifiedAgentSnapshotRoute(model: ModelRecord): boolean {
    const contract = agentModelContract(model.id);
    return (contract !== undefined &&
        model.provider === contract.provider &&
        model.upstreamModel === contract.upstreamModel &&
        model.oauthType === contract.oauthType &&
        model.executionMode === "agent-readonly" &&
        model.discoverable &&
        model.contextWindow === contract.contextWindow &&
        model.capabilities.includes("messages") &&
        model.capabilities.includes("streaming") &&
        !model.capabilities.includes("tools") &&
        !model.capabilities.includes("vision"));
}
export interface OpenAiModelContract {
    readonly alias: "sol" | "terra" | "sol6" | "luna" | "sol61" | "terra61" | "astra";
    readonly id: string;
    readonly upstreamModel: string;
    readonly displayName: string;
    readonly contextWindow: typeof OPENAI_CONTEXT_WINDOW_TOKENS;
    readonly maximumOutputTokens: typeof OPENAI_MAXIMUM_OUTPUT_TOKENS;
    readonly autoCompactWindow: number;
    /**
     * Presentation-only context_window override. max_input_tokens uses the lower of this
     * value and the verified snapshot contextWindow. Absent means use the snapshot value.
     *
     * It is read ONLY by the discovery projection (src/domain/registry.ts). Verification
     * -- withVerifiedOpenAiModels, isVerifiedOpenAiSnapshotRoute, openAiSnapshotRouteDrift,
     * openAiContextMismatches -- never sees it, ON PURPOSE: the moment a policy number
     * enters the snapshot, the snapshot stops being a record of what was measured and the
     * drift detector loses the anchor it compares against.
     */
    readonly advertisedContextWindow?: number;
    /** Where advertisedContextWindow comes from. An override with no source is folklore. */
    readonly contextWindowSource?: string;
}
export const OPENAI_MODEL_CONTRACTS: readonly OpenAiModelContract[] = [
    {
        alias: "sol",
        id: "anthropic-openai-gpt-5.6-sol",
        upstreamModel: "anthropic-openai-oauth__gpt-5.6-sol",
        displayName: "GPT-5.6 Sol via ChatGPT OAuth",
        contextWindow: OPENAI_CONTEXT_WINDOW_TOKENS,
        maximumOutputTokens: OPENAI_MAXIMUM_OUTPUT_TOKENS,
        autoCompactWindow: OPENAI_AUTO_COMPACT_WINDOW_TOKENS,
    },
    {
        alias: "terra",
        id: "anthropic-openai-gpt-5.6-terra",
        upstreamModel: "anthropic-openai-oauth__gpt-5.6-terra",
        displayName: "GPT-5.6 Terra via ChatGPT OAuth",
        contextWindow: OPENAI_CONTEXT_WINDOW_TOKENS,
        maximumOutputTokens: OPENAI_MAXIMUM_OUTPUT_TOKENS,
        autoCompactWindow: OPENAI_AUTO_COMPACT_WINDOW_TOKENS,
    },
    // Added 2026-11-15. MEASURED in clodex 2.21.7 dist/cli.js (OPENAI_OAUTH_MODEL_SEEDS): the
    // bundle gained gpt-6-sol and gpt-6-luna (window 272_000, ceiling 872_000) and gpt-6.1-sol
    // (window 500_000, ceiling 872_000). The ceiling equals the locked openAiContextWindow, so
    // the rows share OPENAI_CONTEXT_WINDOW_TOKENS; the auto-compact window is INHERITED from
    // sol/terra, not measured per model. `sol` keeps meaning gpt-5.6-sol: an existing alias is
    // not repointed without the operator's word. A row is served only when the LIVE catalogue of
    // the operator's ChatGPT account reports the id (withVerifiedOpenAiModels).
    {
        alias: "sol6",
        id: "anthropic-openai-gpt-6-sol",
        upstreamModel: "anthropic-openai-oauth__gpt-6-sol",
        displayName: "GPT-6 Sol via ChatGPT OAuth",
        contextWindow: OPENAI_CONTEXT_WINDOW_TOKENS,
        maximumOutputTokens: OPENAI_MAXIMUM_OUTPUT_TOKENS,
        autoCompactWindow: OPENAI_AUTO_COMPACT_WINDOW_TOKENS,
    },
    {
        alias: "luna",
        id: "anthropic-openai-gpt-6-luna",
        upstreamModel: "anthropic-openai-oauth__gpt-6-luna",
        displayName: "GPT-6 Luna via ChatGPT OAuth",
        contextWindow: OPENAI_CONTEXT_WINDOW_TOKENS,
        maximumOutputTokens: OPENAI_MAXIMUM_OUTPUT_TOKENS,
        autoCompactWindow: OPENAI_AUTO_COMPACT_WINDOW_TOKENS,
    },
    {
        alias: "sol61",
        id: "anthropic-openai-gpt-6.1-sol",
        upstreamModel: "anthropic-openai-oauth__gpt-6.1-sol",
        displayName: "GPT-6.1 Sol via ChatGPT OAuth",
        contextWindow: OPENAI_CONTEXT_WINDOW_TOKENS,
        maximumOutputTokens: OPENAI_MAXIMUM_OUTPUT_TOKENS,
        autoCompactWindow: OPENAI_AUTO_COMPACT_WINDOW_TOKENS,
    },
    // gpt-6.1-terra is NOT in the 2.21.7 seed list. MEASURED 2026-11-15 after `clodex providers
    // refresh-models openai-oauth`: the operator's account catalogue lists it (window 500_000,
    // ceiling 872_000) and `clodex models --json` reports effective 872_000 with the saved max
    // stop, like the six seeded rows. Its live row publishes NO maxOutputTokens, so the output
    // limit here is INHERITED from the seeded rows, not measured.
    {
        alias: "terra61",
        id: "anthropic-openai-gpt-6.1-terra",
        upstreamModel: "anthropic-openai-oauth__gpt-6.1-terra",
        displayName: "GPT-6.1 Terra via ChatGPT OAuth",
        contextWindow: OPENAI_CONTEXT_WINDOW_TOKENS,
        maximumOutputTokens: OPENAI_MAXIMUM_OUTPUT_TOKENS,
        autoCompactWindow: OPENAI_AUTO_COMPACT_WINDOW_TOKENS,
    },
    // GPT-6 Astra. Seeded by clodex 2.11.1 only (measured 2026-09-05: the id
    // "gpt-6-astra" has ZERO occurrences in the 2.8.2 bundle and three in 2.11.1),
    // which is why this row and the clodex pin move together -- withVerifiedOpenAiModels
    // admits a model only when the LIVE catalogue reports it, so a contract without the
    // matching clodex build is a picker row that can never be verified.
    //
    // RE-MEASURED 2026-11-15 in clodex 2.21.7 dist/cli.js (OPENAI_OAUTH_MODEL_SEEDS, 17 ids
    // against 14 in 2.11.1): gpt-6-astra is still seeded, the same row (window 272_000, ceiling
    // 872_000, line 6297), so this contract and the pin still move together. The three ids the
    // bundle gained are gpt-6.1-sol, gpt-6-sol and gpt-6-luna; their rows are above (sol61, sol6, luna),
    // next to terra61, which the account lists without a seed.
    //
    // contextWindow here is the ceiling (openAiCatalogEntry checks live <= ceiling), not
    // an equality: Astra's own maxContextWindow is 872_000.
    //
    // Astra's context_window presentation and compaction policy remain independent of
    // max_input_tokens. The historical sources below explain that policy; they do not
    // prove the capacity accepted by this OAuth transport. Discovery caps input at the pin.
    {
        alias: "astra",
        id: "anthropic-openai-gpt-6-astra",
        upstreamModel: "anthropic-openai-oauth__gpt-6-astra",
        displayName: "GPT-6 Astra via ChatGPT OAuth",
        contextWindow: OPENAI_CONTEXT_WINDOW_TOKENS,
        maximumOutputTokens: OPENAI_MAXIMUM_OUTPUT_TOKENS,
        autoCompactWindow: OPENAI_ASTRA_AUTO_COMPACT_WINDOW_TOKENS,
        advertisedContextWindow: OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS,
        // The rate-card sentence below carries a real EM DASH (U+2014) because that is what the
        // source string carries. It was ASCII-folded to "--" when this row was written and the
        // fold was not marked -- an unmarked character change inside quotation marks (audit
        // FINDING 4). MEASURED 2026-09-05: this repository is NOT ASCII-only (11 files under
        // src/ test/ scripts/ already carry U+A7 / U+B7 / U+FC), so the honest repair is the
        // character itself rather than a footnote about it. test/contract-derivation.test.ts
        // holds it in place from both sides.
        contextWindowSource: "Model card https://developers.openai.com/api/docs/models/gpt-6-astra, " +
            "fetched verbatim on 2026-09-05 (HTTP 200) by the implementation run and again, " +
            "independently, by the audit run the same day: \"1,050,000 context window\", " +
            "\"128,000 max output tokens\", \"Prompts with more than 272K input tokens are priced at " +
            "2x input and cache rates and 1.5x output for the full request.\" -- so the window is " +
            "1,050,000, not clodex's seeded 872,000. The 272K multiplier does NOT apply on the lane " +
            "this router uses: ChatGPT Enterprise rate card " +
            "https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing, " +
            "quoted by the main session 2026-09-05 (two later subagent runs both got HTTP 403 on re-fetch, so " +
            "that quote is [main-session measurement], not re-verified here): \"GPT-6 Astra — Codex " +
            "long-context exception: GPT-6 Astra usage in Codex does not incur additional long-context " +
            "multipliers above 272K input tokens. Codex does not charge for cache writes.\"",
    },
];
export function openAiModelContract(modelId: string): OpenAiModelContract | undefined {
    return OPENAI_MODEL_CONTRACTS.find((entry) => entry.id === modelId);
}
export function openAiCatalogEntry(catalog: readonly ProviderModelRecord[], contract: OpenAiModelContract): ProviderModelRecord | undefined {
    return catalog.find((entry) => entry.id === contract.upstreamModel &&
        entry.contextWindow !== undefined &&
        entry.contextWindow > 0 &&
        entry.contextWindow <= contract.contextWindow);
}
export function isVerifiedOpenAiSnapshotRoute(model: ModelRecord, catalog: readonly ProviderModelRecord[]): boolean {
    const contract = openAiModelContract(model.id);
    if (contract === undefined)
        return false;
    const live = openAiCatalogEntry(catalog, contract);
    if (live?.contextWindow === undefined)
        return false;
    return (model.provider === "openai" &&
        model.upstreamModel === contract.upstreamModel &&
        model.oauthType === "chatgpt" &&
        model.executionMode === "native-message-loop" &&
        model.discoverable &&
        model.contextWindow === live.contextWindow &&
        model.maximumOutputTokens === contract.maximumOutputTokens &&
        live.contextWindow <= contract.contextWindow);
}
export interface OpenAiSnapshotRouteDrift {
    readonly id: string;
    readonly snapshotContextWindow: number | undefined;
    readonly liveContextWindow: number | undefined;
}
// WHY a snapshot route stopped verifying: one row per failing model, carrying BOTH
// numbers.
//
// MEASURED 2026-09-05 (independent audit, FINDING 1). The live snapshot under
// %LOCALAPPDATA% outlives a release upgrade and still carried contextWindow 828400 for
// sol and terra while the clodex pin moved to 872000. The first session served by the
// new clodex therefore fails isVerifiedOpenAiSnapshotRoute for EVERY OpenAI row, and
// provider-set drops the whole lane -- the working sol/terra lane, not just the model
// being added -- until a successful `models refresh` rewrites the snapshot.
//
// That window is real and cannot be designed away here; what was defective is that the
// operator saw one mute string ("clodex_session_catalog_drift") naming neither the model
// nor either number, and a routine pin refresh reads as a provider outage.
//
// The live number comes from the RAW catalogue row, not from openAiCatalogEntry: a live
// window ABOVE the contract ceiling is exactly the case that must be printed, and the
// ceiling filter would report it as absent.
export function openAiSnapshotRouteDrift(models: readonly ModelRecord[], catalog: readonly ProviderModelRecord[]): readonly OpenAiSnapshotRouteDrift[] {
    return models
        .filter((model) => model.provider === "openai" && !isVerifiedOpenAiSnapshotRoute(model, catalog))
        .map((model) => {
        const contract = openAiModelContract(model.id);
        const live = contract === undefined
            ? undefined
            : catalog.find((entry) => entry.id === contract.upstreamModel);
        return {
            id: model.id,
            snapshotContextWindow: model.contextWindow,
            liveContextWindow: live?.contextWindow,
        };
    });
}
export function clodexCatalogDriftDetailCode(drift: readonly OpenAiSnapshotRouteDrift[]): string {
    if (drift.length === 0)
        return "clodex_session_catalog_drift";
    const prefix = "clodex_session_catalog_drift:";
    const parts = drift
        .map((entry) => `${entry.id}=live${entry.liveContextWindow ?? "absent"}_snapshot${entry.snapshotContextWindow ?? "absent"}`);
    // The code has to survive the IPC contract, so it is built up to the bound rather
    // than assembled and then rejected. What does not fit is counted, not dropped
    // silently: "+2 more" is a smaller loss than a status that never arrives.
    const kept: string[] = [];
    let used = prefix.length;
    for (const part of parts) {
        const cost = part.length + (kept.length === 0 ? 0 : 1);
        const remainder = parts.length - kept.length - 1;
        const suffix = remainder > 0 ? `,+${remainder}_more`.length : 0;
        if (used + cost + suffix > SUPERVISOR_DETAIL_CODE_LIMIT)
            break;
        used += cost;
        kept.push(part);
    }
    const dropped = parts.length - kept.length;
    const detail = dropped === 0 ? kept.join(",") : [...kept, `+${dropped}_more`].join(",");
    return `${prefix}${detail}`;
}
export const OPENAI_CATALOG_DRIFT_REMEDY = "FIX: claude-oauth models refresh -- the OpenAI lane stays closed until this RUN succeeds. If the live count differs from the lock, first set config/install-lock.json claudeShadow.openAiContextWindow to the measured count, then run refresh AGAIN (if the first refresh hits the shrink gate with 409, no snapshot is written).";
export function openAiCatalogDriftReadiness(models: readonly ModelRecord[], catalog: readonly ProviderModelRecord[]): ProviderReadiness {
    return {
        provider: "openai",
        oauthReady: false,
        adapterReady: false,
        status: "unavailable",
        detailCode: clodexCatalogDriftDetailCode(openAiSnapshotRouteDrift(models, catalog)),
        remedy: OPENAI_CATALOG_DRIFT_REMEDY,
    };
}
export function verifiedGrokCatalogEntry(catalog: readonly ProviderModelRecord[]): ProviderModelRecord | undefined {
    return catalog.find((entry) => entry.id === GROK_MODEL_ID &&
        entry.contextWindow === GROK_CATALOG_CONTEXT_WINDOW_TOKENS);
}
// Resolves the auto-compaction window for whatever the user typed after --model:
// a picker alias ("sol"), a full snapshot id, or either with the [1m] suffix.
//
// Returns undefined for every Claude model ON PURPOSE. The launcher then leaves
// CLAUDE_CODE_AUTO_COMPACT_WINDOW unset, because that variable OVERRIDES the
// autoCompactWindow setting -- setting it for a Claude model would silently
// disable the operator's own configured threshold.
// ChatGPT Web lane (Agent Web Bridge, operator's own project; 2026-09-13).
//
// Window and compaction numbers come from the working reference codex-chatgpt-web, read from
// its source on 2026-09-13 (tasks/claude-oauth-web-koprusu-20260913/okuma-3 §5): on a Pro
// account every reasoning effort carries a 111,193-token window (Pro itself 112,193) with
// auto-compact at 95,000; the bridge does not advertise any of this, and Claude Code assumes
// 200k for an id without the `[1m]` suffix (B08), so without these rows the client would
// overrun ChatGPT's own limit before compaction ever fired. This machine is a Pro account
// (measured: effort slider 0..4, five stops, the reference's own Pro test at
// chatgpt-session.ts:239). A Plus-only account would need the Plus rows (41,000 / 90,000)
// and the two Pro-gated profiles removed; that is a refresh-time check, not done yet.
//
// The five profile names are the bridge's own (config.py model_defaults) and are what the
// adapter sends as `model`. The router ids follow the reference's slugs (extra-high, pro).
// The model names in the display strings are the operator's statement for this Pro account
// (2026-09-13: instant..extra-high use the "Latest" model entry of the ChatGPT picker (the
// operator corrected an earlier "GPT-5.6 Sol" label), the Pro stop runs GPT-6 Astra in pro
// mode); the bridge reports the UI route, not a backend identity, so this is a label.
export const CHATGPT_WEB_PRO_CONTEXT_WINDOW_TOKENS = 111_193;
export const CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW_TOKENS = 112_193;
export const CHATGPT_WEB_PRO_AUTO_COMPACT_WINDOW_TOKENS = 95_000;
export interface WebModelContract {
    readonly id: string;
    readonly upstreamModel: string;
    readonly displayName: string;
    readonly contextWindow: number;
    readonly autoCompactWindow: number;
    /** The reference gates these on the account exposing Pro; the bridge's slider probe agrees. */
    readonly requiresPro: boolean;
}
export const WEB_MODEL_CONTRACTS: readonly WebModelContract[] = [
    { id: "anthropic-web-chatgpt-instant", upstreamModel: "chatgpt-web-instant", displayName: "ChatGPT Web Instant (Latest)", contextWindow: CHATGPT_WEB_PRO_CONTEXT_WINDOW_TOKENS, autoCompactWindow: CHATGPT_WEB_PRO_AUTO_COMPACT_WINDOW_TOKENS, requiresPro: false },
    { id: "anthropic-web-chatgpt-medium", upstreamModel: "chatgpt-web-medium", displayName: "ChatGPT Web Medium (Latest)", contextWindow: CHATGPT_WEB_PRO_CONTEXT_WINDOW_TOKENS, autoCompactWindow: CHATGPT_WEB_PRO_AUTO_COMPACT_WINDOW_TOKENS, requiresPro: false },
    { id: "anthropic-web-chatgpt-high", upstreamModel: "chatgpt-web-high", displayName: "ChatGPT Web High (Latest)", contextWindow: CHATGPT_WEB_PRO_CONTEXT_WINDOW_TOKENS, autoCompactWindow: CHATGPT_WEB_PRO_AUTO_COMPACT_WINDOW_TOKENS, requiresPro: false },
    { id: "anthropic-web-chatgpt-extra-high", upstreamModel: "chatgpt-web-xhigh", displayName: "ChatGPT Web Extra High (Latest)", contextWindow: CHATGPT_WEB_PRO_CONTEXT_WINDOW_TOKENS, autoCompactWindow: CHATGPT_WEB_PRO_AUTO_COMPACT_WINDOW_TOKENS, requiresPro: true },
    { id: "anthropic-web-chatgpt-pro", upstreamModel: "chatgpt-web-pro", displayName: "ChatGPT Web Pro (GPT-6 Astra)", contextWindow: CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW_TOKENS, autoCompactWindow: CHATGPT_WEB_PRO_AUTO_COMPACT_WINDOW_TOKENS, requiresPro: true },
];
export function webModelContract(modelId: string): WebModelContract | undefined {
    return WEB_MODEL_CONTRACTS.find((entry) => entry.id === modelId);
}
// ---- Router-owned API-key lanes: Alibaba Token Plan, Z.AI, OpenAI API (2026-11-09) ----
//
// DATA RULE: these are third-party commercial endpoints without a corpus-consent guarantee
// reviewed by the maintainer. Sensitive, clinical, client or private data MUST NOT be routed
// here; public or synthetic material only. README states the rule and
// `mcp__*` tools are never advertised upstream (a tool the provider can call is a path for
// connected-account data to reach the provider in the tool result).
//
// MEASURED 2026-11-09 (tasks/2026-11-09-router-alibaba-zai/kanit/): the Alibaba Token Plan
// endpoint is Anthropic-compatible at POST /apps/anthropic/v1/messages with `x-api-key` (all 13
// chat models answered 200 "pong"); /anthropic/v1/messages and /compatible-mode/v1/messages
// returned 404; the model list is GET /compatible-mode/v1/models (20 rows, NO context_length
// field on any row). Z.AI is Anthropic-compatible at POST /api/anthropic/v1/messages with
// `x-api-key`; its model list GET /api/paas/v4/models answered 200 while every chat call
// answered 429 code 1113 "Insufficient balance or no resource package. Please recharge.".
// OpenAI: GET /v1/models 200 with a valid key that has NO credits left, while
// POST /v1/responses and /v1/chat/completions answered 429 insufficient_quota /
// credit_balance_exhausted.
//
// WINDOW RULE: only primary sources or measurements give numbers. Everything below without a
// source takes a conservative default (262_144 window / 200_000 auto-compact) and is marked
// [UNVERIFIED] in the README. The one sourced
// number is GPT-6 Astra's model-card 1,050,000 context / 128,000 max output (the same card the
// ChatGPT-OAuth astra row quotes verbatim). Claude Code buckets any id without the [1m] suffix
// at 200k, so the unverified rows stay in the client's own conservative bucket.
export const ALIBABA_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com";
export const ZAI_BASE_URL = "https://api.z.ai";
export const OPENAI_API_BASE_URL = "https://api.openai.com";
export const UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS = 262_144;
export const UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS = 200_000;
export const OPENAI_API_ASTRA_CONTEXT_WINDOW_TOKENS = 1_050_000;
export const OPENAI_API_ASTRA_MAXIMUM_OUTPUT_TOKENS = 128_000;
export type ApiKeyProvider = "alibaba" | "zai" | "openaiapi";
export interface ApiKeyModelContract {
    readonly id: string;
    readonly provider: ApiKeyProvider;
    readonly upstreamModel: string;
    readonly displayName: string;
    readonly contextWindow: number;
    readonly autoCompactWindow: number;
    readonly maximumOutputTokens?: number;
    /** Where the window came from. An unsourced number is folklore; "[UNVERIFIED]" names it. */
    readonly contextWindowSource: string;
}
export const ALIBABA_MODEL_CONTRACTS: readonly ApiKeyModelContract[] = [
    // CURATED 2026-11-15 (operator request: keep the lanes to models worth routing to). The live
    // list (GET /compatible-mode/v1/models, 21 rows) still carries every id removed here:
    // qwen3.7-max, qwen3.7-plus, qwen3.6-flash, glm-5.2 (older generations of rows that stay) and
    // deepseek-v4-pro-0813, deepseek-v4.1-flash-1017, deepseek-v4-flash-0731 (dated snapshots).
    // qwen4-max-preview is new in the live list and answered a live one-line probe (HTTP 200,
    // "pong") before it was contracted; like every row here its window is the [UNVERIFIED] default.
    { id: "anthropic-alibaba-qwen4-max-preview", provider: "alibaba", upstreamModel: "qwen4-max-preview", displayName: "Qwen 4 Max Preview (Alibaba)", contextWindow: UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS, autoCompactWindow: UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS, contextWindowSource: "[UNVERIFIED] conservative default; Alibaba's model list publishes no context_length" },
    { id: "anthropic-alibaba-qwen3.8-max", provider: "alibaba", upstreamModel: "qwen3.8-max", displayName: "Qwen 3.8 Max (Alibaba)", contextWindow: UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS, autoCompactWindow: UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS, contextWindowSource: "[UNVERIFIED] conservative default; Alibaba's model list publishes no context_length" },
    { id: "anthropic-alibaba-qwen3.8-flash", provider: "alibaba", upstreamModel: "qwen3.8-flash", displayName: "Qwen 3.8 Flash (Alibaba)", contextWindow: UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS, autoCompactWindow: UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS, contextWindowSource: "[UNVERIFIED] conservative default; Alibaba's model list publishes no context_length" },
    { id: "anthropic-alibaba-glm-5.3", provider: "alibaba", upstreamModel: "glm-5.3", displayName: "GLM 5.3 (Alibaba)", contextWindow: UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS, autoCompactWindow: UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS, contextWindowSource: "[UNVERIFIED] conservative default; Alibaba's model list publishes no context_length" },
    { id: "anthropic-alibaba-deepseek-v4-pro", provider: "alibaba", upstreamModel: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro (Alibaba)", contextWindow: UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS, autoCompactWindow: UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS, contextWindowSource: "[UNVERIFIED] conservative default; Alibaba's model list publishes no context_length" },
    { id: "anthropic-alibaba-deepseek-v4.1-flash", provider: "alibaba", upstreamModel: "deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash (Alibaba)", contextWindow: UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS, autoCompactWindow: UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS, contextWindowSource: "[UNVERIFIED] conservative default; Alibaba's model list publishes no context_length" },
    { id: "anthropic-alibaba-auto", provider: "alibaba", upstreamModel: "auto", displayName: "Auto (Alibaba)", contextWindow: UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS, autoCompactWindow: UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS, contextWindowSource: "[UNVERIFIED] conservative default; Alibaba's model list publishes no context_length" },
];
export const ZAI_MODEL_CONTRACTS: readonly ApiKeyModelContract[] = [
    // Z.AI's own list carries no window for either row; glm-5.3 is the "max" tier of the pair
    // (GET /api/paas/v4/models 2026-11-09 lists glm-5.3 and glm-5.3-flash, no glm-5.3-max).
    { id: "anthropic-zai-glm-5.3", provider: "zai", upstreamModel: "glm-5.3", displayName: "GLM 5.3 Max (Z.AI)", contextWindow: UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS, autoCompactWindow: UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS, contextWindowSource: "[UNVERIFIED] conservative default; Z.AI's model list publishes no context window" },
    { id: "anthropic-zai-glm-5.3-flash", provider: "zai", upstreamModel: "glm-5.3-flash", displayName: "GLM 5.3 Flash (Z.AI)", contextWindow: UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS, autoCompactWindow: UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS, contextWindowSource: "[UNVERIFIED] conservative default; Z.AI's model list publishes no context window" },
];
export const OPENAI_API_MODEL_CONTRACTS: readonly ApiKeyModelContract[] = [
    {
        id: "anthropic-openaiapi-gpt-6-astra",
        provider: "openaiapi",
        upstreamModel: "gpt-6-astra",
        displayName: "GPT-6 Astra (OpenAI API)",
        contextWindow: OPENAI_API_ASTRA_CONTEXT_WINDOW_TOKENS,
        autoCompactWindow: OPENAI_AUTO_COMPACT_WINDOW_TOKENS,
        maximumOutputTokens: OPENAI_API_ASTRA_MAXIMUM_OUTPUT_TOKENS,
        contextWindowSource: "Model card https://developers.openai.com/api/docs/models/gpt-6-astra (quoted verbatim by the ChatGPT-OAuth astra contract, fetched 2026-09-05): \"1,050,000 context window\", \"128,000 max output tokens\". The 272K 2x pricing boundary applies on THIS lane; the Codex long-context exception quoted for the OAuth lane does not, so the auto-compact window is the Sol/Terra 220_000 below the boundary.",
    },
    { id: "anthropic-openaiapi-gpt-6.1-sol", provider: "openaiapi", upstreamModel: "gpt-6.1-sol", displayName: "GPT-6.1 Sol (OpenAI API)", contextWindow: UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS, autoCompactWindow: UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS, contextWindowSource: "[UNVERIFIED] conservative default; GET /v1/models publishes no context window" },
    { id: "anthropic-openaiapi-gpt-6.1-terra", provider: "openaiapi", upstreamModel: "gpt-6.1-terra", displayName: "GPT-6.1 Terra (OpenAI API)", contextWindow: UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS, autoCompactWindow: UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS, contextWindowSource: "[UNVERIFIED] conservative default; GET /v1/models publishes no context window" },
];
export function apiKeyModelContracts(provider: ApiKeyProvider): readonly ApiKeyModelContract[] {
    switch (provider) {
        case "alibaba": return ALIBABA_MODEL_CONTRACTS;
        case "zai": return ZAI_MODEL_CONTRACTS;
        case "openaiapi": return OPENAI_API_MODEL_CONTRACTS;
    }
}
export function apiKeyModelContract(provider: ApiKeyProvider, modelId: string): ApiKeyModelContract | undefined {
    return apiKeyModelContracts(provider).find((entry) => entry.id === modelId);
}
export function autoCompactWindowForModel(modelArgument: string): number | undefined {
    const normalized = modelArgument.trim().toLowerCase().replace(/\[1m\]$/u, "");
    if (normalized === "")
        return undefined;
    for (const contract of AGENT_MODEL_CONTRACTS) {
        if (normalized === contract.alias.toLowerCase() || normalized === contract.id.toLowerCase())
            return contract.autoCompactWindow;
    }
    for (const contract of WEB_MODEL_CONTRACTS) {
        if (normalized === contract.id.toLowerCase())
            return contract.autoCompactWindow;
    }
    for (const contract of OPENAI_MODEL_CONTRACTS) {
        if (normalized === contract.alias.toLowerCase() || normalized === contract.id.toLowerCase())
            return contract.autoCompactWindow;
    }
    // The API-key lanes have no launch aliases: they resolve by their full snapshot ids only,
    // so each lane is asked for by name.
    for (const provider of ["alibaba", "zai", "openaiapi"] as const) {
        for (const contract of apiKeyModelContracts(provider)) {
            if (normalized === contract.id.toLowerCase())
                return contract.autoCompactWindow;
        }
    }
    return undefined;
}
