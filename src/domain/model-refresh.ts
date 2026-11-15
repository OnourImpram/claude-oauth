import type { ModelRecord, ModelSnapshot, ProviderModelRecord, ProviderReadiness } from "./contracts.js";
import {
    AGENT_MODEL_CONTRACTS,
    OPENAI_MODEL_CONTRACTS,
    WEB_MODEL_CONTRACTS,
    apiKeyModelContracts,
    type ApiKeyProvider,
    openAiCatalogEntry,
    verifiedGrokCatalogEntry,
} from "./model-contracts.js";
/**
 * A7 (2026-09-02). Native rows (anthropic, native-message-loop) ALWAYS come from the
 * release's pinned models.default.json; external rows come from the live refresh. Measured:
 * seedSnapshot only seeds when there is no snapshot, and refresh carries native rows over
 * from the snapshot as "retained" -- so a native model added to models.default.json never
 * reached a running installation (claude-fable-5-1: unknown_model under the launcher, ok on
 * the native path). What was configured was not what ran; this function binds the two to the
 * same place.
 */
export function isNativeModel(model: ModelRecord): boolean {
    return model.provider === "anthropic" && model.executionMode === "native-message-loop";
}
export function withPinnedNativeModels(runtime: ModelSnapshot, pinned: ModelSnapshot): ModelSnapshot {
    const native = pinned.models.filter(isNativeModel);
    const external = runtime.models.filter((model) => !isNativeModel(model));
    return { ...runtime, models: [...native, ...external] };
}
export interface OpenAiContextMismatch {
    readonly id: string;
    readonly lockedContextWindow: number;
    readonly liveContextWindow: number | undefined;
}
// A model rejected for a context-window mismatch is NOT a model missing from the
// catalogue, and reporting it as missing sends the reader to the wrong provider.
// This names the real reason so a stale pin cannot masquerade as an outage.
export function openAiContextMismatches(clodexCatalog: readonly ProviderModelRecord[], lockedContextWindow: number): readonly OpenAiContextMismatch[] {
    const mismatches: OpenAiContextMismatch[] = [];
    for (const configured of OPENAI_MODEL_CONTRACTS) {
        const live = openAiCatalogEntry(clodexCatalog, configured);
        if (live !== undefined && live.contextWindow !== lockedContextWindow) {
            mismatches.push({
                id: configured.id,
                lockedContextWindow,
                liveContextWindow: live.contextWindow,
            });
        }
    }
    return mismatches;
}
export function withVerifiedOpenAiModels(baseline: ModelSnapshot, clodexCatalog: readonly ProviderModelRecord[], lockedContextWindow: number): ModelSnapshot {
    const externalIds = new Set(OPENAI_MODEL_CONTRACTS.map((entry) => entry.id));
    const retained = baseline.models.filter((model) => !externalIds.has(model.id));
    const verified: ModelRecord[] = [];
    for (const configured of OPENAI_MODEL_CONTRACTS) {
        const live = openAiCatalogEntry(clodexCatalog, configured);
        if (live?.contextWindow !== lockedContextWindow)
            continue;
        verified.push({
            id: configured.id,
            provider: "openai",
            upstreamModel: configured.upstreamModel,
            displayName: configured.displayName,
            oauthType: "chatgpt",
            executionMode: "native-message-loop",
            discoverable: true,
            contextWindow: live.contextWindow,
            maximumOutputTokens: configured.maximumOutputTokens,
            capabilities: ["messages", "streaming", "tools", "thinking"],
        });
    }
    return {
        ...baseline,
        generatedAt: new Date().toISOString(),
        source: "live-provider-refresh",
        models: [...retained, ...verified],
    };
}
export interface OpenAiModelReadiness {
    readonly alias: string;
    readonly id: string;
    readonly enabled: boolean;
}
/**
 * Which OpenAI contracts actually survived into the snapshot -- one row per contract,
 * DERIVED, never listed by hand.
 *
 * CASE RECORD: cli.ts wrote this with two literals (`solEnabled` / `terraEnabled`). Adding a
 * third model (astra) to OPENAI_MODEL_CONTRACTS would leave it outside this surface:
 * `doctor --require-all` would go green WITHOUT EVER asking about the new model. Exactly the
 * same defect was measured on the google arm on 2026-09-02 (hand-written 2, live 3). Here the
 * count comes from the contract list, so a new contract cannot drop out silently.
 */
export function openAiModelReadiness(snapshot: ModelSnapshot | undefined): readonly OpenAiModelReadiness[] {
    const verified = new Set(snapshot?.models.map((model) => model.id) ?? []);
    return OPENAI_MODEL_CONTRACTS.map((contract) => ({
        alias: contract.alias,
        id: contract.id,
        enabled: verified.has(contract.id),
    }));
}
export function withVerifiedGoogleModels(baseline: ModelSnapshot, verifiedUpstreamModels: readonly string[]): ModelSnapshot {
    const googleContracts = AGENT_MODEL_CONTRACTS.filter((entry) => entry.provider === "google");
    const externalIds = new Set(googleContracts.map((entry) => entry.id));
    const verifiedIds = new Set(verifiedUpstreamModels);
    const retained = baseline.models.filter((model) => !externalIds.has(model.id));
    const verified = googleContracts
        .filter((entry) => verifiedIds.has(entry.upstreamModel))
        .map((entry): ModelRecord => ({
        id: entry.id,
        provider: entry.provider,
        upstreamModel: entry.upstreamModel,
        displayName: entry.displayName,
        oauthType: entry.oauthType,
        executionMode: "agent-readonly",
        discoverable: true,
        contextWindow: entry.contextWindow,
        capabilities: ["messages", "streaming"],
    }));
    return {
        ...baseline,
        generatedAt: new Date().toISOString(),
        source: "live-provider-refresh",
        models: [...retained, ...verified],
    };
}
export interface GoogleModelCatalogReadiness extends ProviderReadiness {
    readonly model: string;
}
export function catalogVerifiedGoogleModelIds(readiness: readonly GoogleModelCatalogReadiness[]): readonly string[] {
    return readiness
        .filter((entry) => entry.oauthReady &&
        entry.adapterReady &&
        (entry.status === "ready" ||
            (entry.status === "blocked" && entry.detailCode === "antigravity_provider_rate_limited")))
        .map((entry) => entry.model);
}
export function withVerifiedGrokModel(baseline: ModelSnapshot, catalog: readonly ProviderModelRecord[]): ModelSnapshot {
    const contract = AGENT_MODEL_CONTRACTS.find((entry) => entry.provider === "xai");
    if (contract === undefined)
        return baseline;
    const retained = baseline.models.filter((model) => model.id !== contract.id);
    const live = verifiedGrokCatalogEntry(catalog);
    const verified: readonly ModelRecord[] = live === undefined
        ? []
        : [{
                id: contract.id,
                provider: contract.provider,
                upstreamModel: contract.upstreamModel,
                displayName: contract.displayName,
                oauthType: contract.oauthType,
                executionMode: "agent-readonly",
                discoverable: true,
                contextWindow: contract.contextWindow,
                capabilities: ["messages", "streaming"],
            }];
    return {
        ...baseline,
        generatedAt: new Date().toISOString(),
        source: "live-provider-refresh",
        models: [...retained, ...verified],
    };
}
/**
 * The `doctor --require-all` OpenAI arm -- the GATE expression itself, now pure and
 * measurable.
 *
 * CASE RECORD (measured 2026-09-05, mutation M1, independent audit and repeated in this run):
 * this expression was written BY HAND inside cli.ts, and no test imports src/cli.ts
 * (test/cli-routing.test.ts tests src/cli-routing.ts). The `every` -> `some` mutation left the
 * suite GREEN: tests 270, pass 269, fail 0, exit 0. That is, the defect "--require-all going
 * green WITHOUT EVER asking about the third model" -- the very defect class the change existed
 * to close -- was sitting at the consumer end of that same change: the derivation was
 * measured, the gate was not.
 *
 * IDENTITY is asked, not a count. The old expression's
 * `readiness.length === OPENAI_MODEL_CONTRACTS.length` arm was a tautology for a caller that
 * already produces the list from the contracts: it could not be false on any input, that is,
 * it is unfalsifiable -- and a check that cannot be falsified is not a measurement. In this
 * form three separate arms can drop it: a missing row, an ineffective row, a foreign row.
 */
export function openAiGateReady(readiness: readonly OpenAiModelReadiness[]): boolean {
    const enabled = new Set(readiness.filter((entry) => entry.enabled).map((entry) => entry.id));
    return OPENAI_MODEL_CONTRACTS.every((contract) => enabled.has(contract.id));
}
/** Same class, google arm: the hand-written count fell on 2026-09-02 when the third google model arrived. */
export function googleGateReady(readiness: readonly GoogleModelCatalogReadiness[]): boolean {
    const ready = new Set(readiness.filter((entry) => entry.status === "ready").map((entry) => entry.model));
    return AGENT_MODEL_CONTRACTS
        .filter((entry) => entry.provider === "google")
        .every((contract) => ready.has(contract.upstreamModel));
}
export interface RequireAllProviderInput {
    readonly openAiModels: readonly OpenAiModelReadiness[];
    readonly grokEnabled: boolean;
    readonly googleModels: readonly GoogleModelCatalogReadiness[];
}
/** If the catalogue could not be built at all (`undefined`), --require-all CANNOT go GREEN; that is an arm too. */
export function requireAllProvidersReady(catalog: RequireAllProviderInput | undefined): boolean {
    if (catalog === undefined)
        return false;
    return openAiGateReady(catalog.openAiModels) &&
        catalog.grokEnabled &&
        googleGateReady(catalog.googleModels);
}

// ---- Router-owned API-key lanes (alibaba / zai / openaiapi, 2026-11-09) ----
//
// The contract is the source of truth, the live model
// LIST decides membership, and a lane without a key or without an answer yields an empty
// catalog and therefore no rows -- never picker entries that cannot answer. The window comes
// from the contract (a live list that publishes no window), which is why every unsourced row
// carries a conservative default and an [UNVERIFIED] source string.
// A lane that lists its models but cannot serve them (Z.AI 429/1113 today, OpenAI with no
// credits) KEEPS its rows and carries the named blocked readiness instead: the operator asked
// for the lane, membership is real, and a request fails with the named remedy.
export function withVerifiedApiKeyModels(baseline: ModelSnapshot, provider: ApiKeyProvider, liveIds: readonly string[]): ModelSnapshot {
    const contracts = apiKeyModelContracts(provider);
    const externalIds = new Set(contracts.map((entry) => entry.id));
    const retained = baseline.models.filter((model) => !externalIds.has(model.id));
    const live = new Set(liveIds);
    const verified = contracts
        .filter((entry) => live.has(entry.upstreamModel))
        .map((entry): ModelRecord => ({
        id: entry.id,
        provider: entry.provider,
        upstreamModel: entry.upstreamModel,
        displayName: entry.displayName,
        oauthType: "api-key",
        executionMode: "native-message-loop",
        discoverable: true,
        contextWindow: entry.contextWindow,
        ...(entry.maximumOutputTokens === undefined ? {} : { maximumOutputTokens: entry.maximumOutputTokens }),
        capabilities: provider === "openaiapi"
            ? ["messages", "streaming", "tools"]
            : ["messages", "streaming", "tools", "thinking"],
    }));
    return {
        ...baseline,
        generatedAt: new Date().toISOString(),
        source: "live-provider-refresh",
        models: [...retained, ...verified],
    };
}
export function withVerifiedAlibabaModels(baseline: ModelSnapshot, liveIds: readonly string[]): ModelSnapshot {
    return withVerifiedApiKeyModels(baseline, "alibaba", liveIds);
}
export function withVerifiedZaiModels(baseline: ModelSnapshot, liveIds: readonly string[]): ModelSnapshot {
    return withVerifiedApiKeyModels(baseline, "zai", liveIds);
}
export function withVerifiedOpenAiApiModels(baseline: ModelSnapshot, liveIds: readonly string[]): ModelSnapshot {
    return withVerifiedApiKeyModels(baseline, "openaiapi", liveIds);
}
/**
 * ChatGPT Web rows enter the snapshot only when the lane's three readiness checks passed
 * (bridge daemon, tunnel-client, Chrome CDP). Same shape as withVerifiedGoogleModels: the
 * contract is the source of truth, the live check decides membership, and an absent lane
 * drops its rows instead of leaving picker entries that cannot answer.
 */
export function withVerifiedWebModels(baseline: ModelSnapshot, laneReady: boolean): ModelSnapshot {
    const externalIds = new Set(WEB_MODEL_CONTRACTS.map((entry) => entry.id));
    const retained = baseline.models.filter((model) => !externalIds.has(model.id));
    const verified = laneReady
        ? WEB_MODEL_CONTRACTS.map((entry): ModelRecord => ({
            id: entry.id,
            provider: "web",
            upstreamModel: entry.upstreamModel,
            displayName: entry.displayName,
            oauthType: "chatgpt-web",
            executionMode: "native-message-loop",
            discoverable: true,
            contextWindow: entry.contextWindow,
            capabilities: ["messages", "streaming", "tools"],
        }))
        : [];
    return {
        ...baseline,
        generatedAt: new Date().toISOString(),
        source: "live-provider-refresh",
        models: [...retained, ...verified],
    };
}
/**
 * The Grok CLI answers the first `initialize` after a period of disuse from its on-disk model
 * cache and refreshes that cache in the background (measured 2026-11-15: models_cache.json
 * was rewritten during the next call, which then listed the contract model). One stale
 * answer read as "the model is gone" dropped the whole xAI lane. When the contract model is
 * missing, the catalog is therefore asked for ONCE more after a short pause. A model that is
 * really gone, or listed at another window, is still reported: the second answer is returned
 * as it is and the caller's check decides.
 */
export async function grokCatalogAfterCacheRefresh(inspect: () => Promise<readonly ProviderModelRecord[]>, options: { readonly sleep?: (ms: number) => Promise<void>; readonly delayMs?: number } = {}): Promise<readonly ProviderModelRecord[]> {
    const first = await inspect();
    if (verifiedGrokCatalogEntry(first) !== undefined)
        return first;
    const sleep = options.sleep ?? (async (ms: number): Promise<void> => await new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
    await sleep(options.delayMs ?? 2_000);
    return await inspect();
}
