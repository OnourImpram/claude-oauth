import type { ModelSnapshot, ProviderAdapter, ProviderId, ProviderReadiness } from "../domain/contracts.js";
import type { RuntimePaths } from "../runtime/paths.js";
import { AnthropicAdapter } from "../adapters/anthropic.js";
import { AgentModelAdapter } from "../adapters/agent-model.js";
import { ClodexAdapter } from "../adapters/clodex.js";
import { runAntigravityHeadless } from "../antigravity/headless-bridge.js";
import { FixedOriginFetchTransport } from "../ports/fetch-transport.js";
import { startClodexCapsule, type RunningClodexCapsule } from "../workers/clodex-capsule.js";
import { isVerifiedAgentSnapshotRoute, isVerifiedOpenAiSnapshotRoute, openAiCatalogDriftReadiness } from "../domain/model-contracts.js";
import { runGrokAcp } from "../grok/acp-bridge.js";
import type { AgentSessionRegistry } from "../mcp/session-registry.js";
export interface ProviderSet {
    readonly snapshot: ModelSnapshot;
    readonly adapters: ReadonlyMap<ProviderId, ProviderAdapter>;
    readonly readiness: readonly ProviderReadiness[];
    close(): Promise<void>;
}
export interface ExternalAgentRuntime {
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly antigravityBinary: string;
    readonly grokBinary: string;
    /**
     * Faz 9. Verilirse xai seridi gercek arac dongusu tasir.
     *
     * Google seridine BILEREK verilmiyor: agy'de cagri basina MCP enjeksiyonu
     * yok, yalnizca kalici `agy mcp add` var, ve o oturum nonce'unu diske
     * yazardi. Guvenlik sert kurali buna izin vermiyor (kanit defteri §7).
     */
    readonly grokSessions?: AgentSessionRegistry;
    /** A4: kilit ihlali olan yan saglayicilar -- adapter kurulmaz, modelleri dusur. */
    readonly disabledProviders?: ReadonlySet<ProviderId>;
}
export async function startProviderSet(snapshot: ModelSnapshot, paths: RuntimePaths, clodexNonce: string, externalRuntime?: ExternalAgentRuntime): Promise<ProviderSet> {
    const adapters = new Map<ProviderId, ProviderAdapter>();
    const readiness: ProviderReadiness[] = [];
    const closeActions: (() => Promise<void>)[] = [];
    const anthropic = new AnthropicAdapter(new FixedOriginFetchTransport(new URL("https://api.anthropic.com")));
    adapters.set("anthropic", anthropic);
    readiness.push(await anthropic.readiness());
    const requestedProviders = new Set(snapshot.models.map((model) => model.provider));
    if (requestedProviders.has("openai")) {
        try {
            const capsule = await startClodexCapsule({ home: paths.clodexHome }, clodexNonce);
            const catalog = await capsule.catalog();
            const required = snapshot.models.filter((model) => model.provider === "openai");
            if (required.every((model) => isVerifiedOpenAiSnapshotRoute(model, catalog))) {
                const adapter = new ClodexAdapter(new FixedOriginFetchTransport(capsule.origin), capsule.transportNonce, capsule.readiness);
                adapters.set("openai", adapter);
                readiness.push(await adapter.readiness());
                closeActions.push(capsule.close);
            }
            else {
                // Tek kelimelik kod hangi modelin hangi sayida catistigini SOYLEMIYORDU;
                // yayin sonrasi pencerede dusen sey yeni model degil calisan sol/terra
                // seridi oldugu icin bu sessizlik arizaya benziyordu (BULGU 1).
                readiness.push(openAiCatalogDriftReadiness(required, catalog));
                await capsule.close();
            }
        }
        catch {
            readiness.push(unavailable("openai", "clodex_auth_or_startup_failed"));
        }
    }
    if (requestedProviders.has("xai")) {
        const requested = snapshot.models.filter((model) => model.provider === "xai" && isVerifiedAgentSnapshotRoute(model));
        if (externalRuntime?.disabledProviders?.has("xai") === true) {
            readiness.push(unavailable("xai", "install_lock_drift"));
        }
        else if (requested.length === 0 || externalRuntime === undefined) {
            readiness.push(unavailable("xai", "grok_agent_model_contract_unavailable"));
        }
        else {
            const adapter = new AgentModelAdapter({
                provider: "xai",
                // Faz 9: VARSA bu serit gercek arac dongusu tasir; yoksa
                // asagidaki metin-yalniz kosucu calisir. Google seridine
                // BILEREK verilmiyor: agy'de cagri basina MCP enjeksiyonu yok
                // ve mcp add oturum sirrini kalici config'e yazardi (kanit §7).
                ...(externalRuntime.grokSessions === undefined
                    ? {}
                    : { sessions: externalRuntime.grokSessions }),
                readiness: async () => ready("xai", "grok_4_6_acp_snapshot_verified"),
                run: async ({ model, prompt, signal }) => {
                    const result = await runGrokAcp({
                        binary: externalRuntime.grokBinary,
                        home: paths.grokHome,
                        cwd: externalRuntime.cwd,
                        task: prompt,
                        model: model.upstreamModel,
                        environment: externalRuntime.environment,
                        signal,
                    });
                    return { text: result.text };
                },
            });
            adapters.set("xai", adapter);
            readiness.push(await adapter.readiness());
        }
    }
    if (requestedProviders.has("google")) {
        const requested = snapshot.models.filter((model) => model.provider === "google" && isVerifiedAgentSnapshotRoute(model));
        if (externalRuntime?.disabledProviders?.has("google") === true) {
            readiness.push(unavailable("google", "install_lock_drift"));
        }
        else if (requested.length === 0 || externalRuntime === undefined) {
            readiness.push(unavailable("google", "antigravity_agent_model_contract_unavailable"));
        }
        else {
            const adapter = new AgentModelAdapter({
                provider: "google",
                // 2026-09-03: agy KENDI arac dongusune sahiptir (operatorun kalici
                // mcp_config.json'undaki filesystem/git/memory sunuculari). Bizim MCP
                // koprumuz enjekte EDILMIYOR -- oturum sirri hicbir yere yazilmiyor.
                // Bu yuzden onsoz "salt okunur" demeyi birakir ama Anthropic tool_use
                // bloklari da uretmez: is agy'nin kendi araclariyla yapilir.
                selfDrivenTools: true,
                readiness: async () => ready("google", "antigravity_oauth_snapshot_verified"),
                run: async ({ model, prompt, signal }) => {
                    const result = await runAntigravityHeadless({
                        binary: externalRuntime.antigravityBinary,
                        cwd: externalRuntime.cwd,
                        prompt,
                        model: model.upstreamModel,
                        environment: externalRuntime.environment,
                        signal,
                        allowEdits: true,
                    });
                    return {
                        text: result.response,
                        ...(result.usage === undefined ? {} : { usage: result.usage }),
                    };
                },
            });
            adapters.set("google", adapter);
            readiness.push(await adapter.readiness());
        }
    }
    const activeModels = snapshot.models.filter((model) => adapters.has(model.provider));
    return {
        snapshot: { ...snapshot, models: activeModels },
        adapters,
        readiness,
        close: async () => {
            for (const close of closeActions.reverse())
                await close();
        },
    };
}
function ready(provider: ProviderId, detailCode: string): ProviderReadiness {
    return {
        provider,
        oauthReady: true,
        adapterReady: true,
        status: "ready",
        detailCode,
    };
}
function unavailable(provider: ProviderId, detailCode: string): ProviderReadiness {
    return {
        provider,
        oauthReady: false,
        adapterReady: false,
        status: "unavailable",
        detailCode,
    };
}
export interface CatalogProviders {
    readonly clodex?: RunningClodexCapsule;
    readonly readiness: readonly ProviderReadiness[];
    close(): Promise<void>;
}
export async function startCatalogProviders(paths: RuntimePaths, clodexNonce: string): Promise<CatalogProviders> {
    let clodex: RunningClodexCapsule | undefined;
    const readiness: ProviderReadiness[] = [];
    try {
        clodex = await startClodexCapsule({ home: paths.clodexHome }, clodexNonce);
        readiness.push(await clodex.readiness());
    }
    catch {
        readiness.push(unavailable("openai", "clodex_auth_or_startup_failed"));
    }
    readiness.push(unavailable("xai", "grok_official_acp_catalog_not_started"));
    return {
        ...(clodex === undefined ? {} : { clodex }),
        readiness,
        close: async () => {
            await clodex?.close();
        },
    };
}
