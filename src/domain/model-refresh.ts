import type { ModelRecord, ModelSnapshot, ProviderModelRecord, ProviderReadiness } from "./contracts.js";
import {
    AGENT_MODEL_CONTRACTS,
    OPENAI_MODEL_CONTRACTS,
    openAiCatalogEntry,
    verifiedGrok46CatalogEntry,
} from "./model-contracts.js";
/**
 * A7 (2026-09-02). Native satirlar (anthropic, native-message-loop) HER ZAMAN release'in
 * pinli models.default.json'undan gelir; harici satirlar canli refresh'ten. Olculdu:
 * seedSnapshot yalniz snapshot yokken tohumlar ve refresh native satirlari snapshot'tan
 * "retained" tasir -- models.default.json'a eklenen bir native model calisan kuruluma
 * hic ulasmiyordu (claude-fable-5-1: launcher altinda unknown_model, native yolda ok).
 * Yapilandirilmis olan kosan degildi; bu fonksiyon ikisini ayni yere baglar.
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
 * VAKA KAYDI: cli.ts bunu iki literalle yaziyordu (`solEnabled` / `terraEnabled`).
 * OPENAI_MODEL_CONTRACTS'a ucuncu bir model (astra) eklemek onu bu yuzeyin disinda
 * birakirdi: `doctor --require-all` yeni modeli HIC sormadan yesil verirdi. Google
 * kolunda birebir ayni defekt 2026-09-02'de olculdu (elle yazilan 2, canli 3).
 * Sayi burada sozlesme listesinden gelir, o yuzden yeni bir sozlesme sessizce
 * dusemez.
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
    const live = verifiedGrok46CatalogEntry(catalog);
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
 * `doctor --require-all` OpenAI kolu -- KAPI ifadesinin kendisi, artik saf ve olculebilir.
 *
 * VAKA KAYDI (olculdu 2026-09-05, mutasyon M1, bagimsiz denetim ve bu kosumda tekrar):
 * bu ifade cli.ts icinde ELLE yaziliydi ve hicbir test src/cli.ts'i import etmiyor
 * (test/cli-routing.test.ts src/cli-routing.ts'i test eder). `every` -> `some`
 * mutasyonu takimi YESIL birakti: tests 270, pass 269, fail 0, exit 0. Yani "ucuncu
 * modeli HIC sormadan yesil veren --require-all" defekti -- degisikligin kapatmak icin
 * var oldugu defekt sinifi -- tam da o degisikligin tuketici ucunda duruyordu:
 * turetim olculuyordu, kapi olculmuyordu.
 *
 * Sayim degil KIMLIK sorulur. Eski ifadedeki
 * `readiness.length === OPENAI_MODEL_CONTRACTS.length` kolu, listeyi zaten
 * sozlesmeden ureten bir cagirici icin totolojiydi: hicbir girdide false olamiyordu,
 * yani yanlislanamaz -- ve yanlislanamayan bir kontrol olcu degildir. Bu bicimde uc
 * ayri kol dusurebilir: eksik satir, etkisiz satir, yabanci satir.
 */
export function openAiGateReady(readiness: readonly OpenAiModelReadiness[]): boolean {
    const enabled = new Set(readiness.filter((entry) => entry.enabled).map((entry) => entry.id));
    return OPENAI_MODEL_CONTRACTS.every((contract) => enabled.has(contract.id));
}
/** Ayni sinif, google kolu: elle yazilan sayi 2026-09-02'de ucuncu google modeli gelince dusmustu. */
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
/** Katalog hic kurulamadiysa (`undefined`) --require-all YESIL VEREMEZ; bu da bir kol. */
export function requireAllProvidersReady(catalog: RequireAllProviderInput | undefined): boolean {
    if (catalog === undefined)
        return false;
    return openAiGateReady(catalog.openAiModels) &&
        catalog.grokEnabled &&
        googleGateReady(catalog.googleModels);
}
