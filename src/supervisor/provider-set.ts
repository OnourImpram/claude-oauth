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
     * Phase 9. When supplied, the xai lane carries a real tool loop.
     *
     * It is DELIBERATELY not supplied to the Google lane: agy has no per-call MCP injection,
     * only the persistent `agy mcp add`, and that would write the session nonce to disk. The
     * Security hard rule does not permit it (evidence ledger §7).
     */
    readonly grokSessions?: AgentSessionRegistry;
    /**
     * G01. Supplied, the Google lane carries the same real tool loop the xai lane has.
     * The objection that kept it away was that `agy mcp add` writes the session nonce into
     * the operator's persistent config; Path D removes the premise -- the nonce goes into a
     * call-scoped configuration home and the operator's file is never opened for writing
     * (tasks/router-karar-20260907/g01-ana-oturum-tasarimi.md, measured 2026-09-08).
     */
    readonly googleSessions?: AgentSessionRegistry;
    /** A4: side providers with a lock violation -- no adapter is built, drop their models. */
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
            let retained = false;
            try {
                const catalog = await capsule.catalog();
                const required = snapshot.models.filter((model) => model.provider === "openai");
                if (required.every((model) => isVerifiedOpenAiSnapshotRoute(model, catalog))) {
                    const adapter = new ClodexAdapter(new FixedOriginFetchTransport(capsule.origin), capsule.transportNonce, capsule.readiness);
                    const providerReadiness = await adapter.readiness();
                    adapters.set("openai", adapter);
                    readiness.push(providerReadiness);
                    closeActions.push(capsule.close);
                    retained = true;
                }
                else {
                    // The single-word code did NOT SAY which model clashed on which number; because
                    // what falls in the post-release window is not the new model but the working
                    // sol/terra lane, that silence looked like an outage (FINDING 1).
                    readiness.push(openAiCatalogDriftReadiness(required, catalog));
                }
            }
            finally {
                // Startup owns the capsule until the verified adapter takes over shutdown.
                if (!retained)
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
                // Phase 9: WHEN PRESENT this lane carries a real tool loop; otherwise the
                // text-only runner below runs. It is DELIBERATELY not supplied to the Google
                // lane: agy has no per-call MCP injection, and mcp add would write the session
                // secret into a persistent config (evidence §7).
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
                // 2026-09-03: agy has its OWN tool loop (the filesystem/git/memory servers in
                // the operator's persistent mcp_config.json). Our MCP bridge was NOT injected --
                // no session secret was written anywhere. That was why the preamble stopped
                // saying "read-only" while still producing no Anthropic tool_use blocks.
                //
                // 2026-09-08 (G01): WHEN a registry is supplied the lane carries the real tool
                // loop and the self-driven fallback is gone. Both are kept because the delegation
                // lane runs without a registry and must keep working as before.
                ...(externalRuntime.googleSessions === undefined
                    ? { selfDrivenTools: true }
                    : { sessions: externalRuntime.googleSessions }),
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
