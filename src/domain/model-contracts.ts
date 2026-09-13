import { SUPERVISOR_DETAIL_CODE_LIMIT } from "./contracts.js";
import type { ModelRecord, ProviderModelRecord, ProviderReadiness } from "./contracts.js";
export const OPENAI_CONTEXT_WINDOW_TOKENS = 1_050_000;
export const OPENAI_MAXIMUM_OUTPUT_TOKENS = 128_000;
export const ANTIGRAVITY_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const GROK_46_MODEL_ID = "grok-4.6";
export const GROK_46_CONTEXT_WINDOW_TOKENS = 500_000;
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
export type AgentModelAlias = "gemini" | "gemini-pro" | "opus-google" | "grok";
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
    {
        alias: "gemini-pro",
        id: "anthropic-google-gemini-3.1-pro-high",
        provider: "google",
        upstreamModel: "gemini-3.1-pro-high",
        displayName: "Gemini 3.1 Pro High via Google OAuth",
        oauthType: "google-cli",
        contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
        autoCompactWindow: ANTIGRAVITY_AUTO_COMPACT_WINDOW_TOKENS,
    },
    {
        alias: "opus-google",
        id: "anthropic-google-claude-opus-4-6-thinking",
        provider: "google",
        upstreamModel: "claude-opus-4-6-thinking",
        displayName: "Claude Opus 4.6 Thinking via Google OAuth",
        oauthType: "google-cli",
        contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
        autoCompactWindow: ANTIGRAVITY_AUTO_COMPACT_WINDOW_TOKENS,
    },
    {
        alias: "grok",
        id: "anthropic-xai-grok-4.6",
        provider: "xai",
        upstreamModel: GROK_46_MODEL_ID,
        displayName: "Grok 4.6 via xAI OAuth",
        oauthType: "xai-cli",
        contextWindow: GROK_46_CONTEXT_WINDOW_TOKENS,
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
    readonly alias: "sol" | "terra" | "astra";
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
    // GPT-6 Astra. Seeded by clodex 2.11.1 only (measured 2026-09-05: the id
    // "gpt-6-astra" has ZERO occurrences in the 2.8.2 bundle and three in 2.11.1),
    // which is why this row and the clodex pin move together -- withVerifiedOpenAiModels
    // admits a model only when the LIVE catalogue reports it, so a contract without the
    // matching clodex build is a picker row that can never be verified.
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
export function verifiedGrok46CatalogEntry(catalog: readonly ProviderModelRecord[]): ProviderModelRecord | undefined {
    return catalog.find((entry) => entry.id === GROK_46_MODEL_ID &&
        entry.contextWindow === GROK_46_CONTEXT_WINDOW_TOKENS);
}
// Resolves the auto-compaction window for whatever the user typed after --model:
// a picker alias ("sol"), a full snapshot id, or either with the [1m] suffix.
//
// Returns undefined for every Claude model ON PURPOSE. The launcher then leaves
// CLAUDE_CODE_AUTO_COMPACT_WINDOW unset, because that variable OVERRIDES the
// autoCompactWindow setting -- setting it for a Claude model would silently
// disable the operator's own configured threshold.
export function autoCompactWindowForModel(modelArgument: string): number | undefined {
    const normalized = modelArgument.trim().toLowerCase().replace(/\[1m\]$/u, "");
    if (normalized === "")
        return undefined;
    for (const contract of AGENT_MODEL_CONTRACTS) {
        if (normalized === contract.alias.toLowerCase() || normalized === contract.id.toLowerCase())
            return contract.autoCompactWindow;
    }
    for (const contract of OPENAI_MODEL_CONTRACTS) {
        if (normalized === contract.alias.toLowerCase() || normalized === contract.id.toLowerCase())
            return contract.autoCompactWindow;
    }
    return undefined;
}
