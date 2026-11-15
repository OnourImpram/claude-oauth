import type { ModelSnapshot, ProviderAdapter, ProviderId, ProviderReadiness } from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";
import { writeSafeLog } from "../runtime/log.js";
import type { RuntimePaths } from "../runtime/paths.js";
import { AnthropicAdapter } from "../adapters/anthropic.js";
import { AgentModelAdapter } from "../adapters/agent-model.js";
import { ClodexAdapter } from "../adapters/clodex.js";
import { WebBridgeAdapter } from "../adapters/web-bridge.js";
import { AnthropicApiKeyAdapter, ALIBABA_LANE, ZAI_LANE } from "../adapters/anthropic-api-key.js";
import { OpenAiApiKeyAdapter } from "../adapters/openai-api-key.js";
import { runAntigravityHeadless } from "../antigravity/headless-bridge.js";
import { FixedOriginFetchTransport } from "../ports/fetch-transport.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { startClodexCapsule, type RunningClodexCapsule } from "../workers/clodex-capsule.js";
import { ALIBABA_BASE_URL, OPENAI_API_BASE_URL, ZAI_BASE_URL, isVerifiedAgentSnapshotRoute, isVerifiedOpenAiSnapshotRoute, openAiCatalogDriftReadiness } from "../domain/model-contracts.js";
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
/**
 * ChatGPT Web lane adapter with the operator's fixed loopback layout. One constructor for
 * the refresh path (cli.ts) and the serving path (below), so the two cannot disagree on
 * which files and ports make the lane "ready".
 */
export function defaultWebBridgeAdapter(home: string = homedir()): WebBridgeAdapter {
    const origin = "http://127.0.0.1:8765";
    return new WebBridgeAdapter(new FixedOriginFetchTransport(new URL(origin)), {
        origin,
        secretsPath: join(home, ".hermes-web-bridge", "secrets.json"),
        tunnelHealthUrlFile: join(home, ".local", "state", "tunnel-client", "health", "hermes-web-bridge.url"),
        chromeCdpUrl: "http://127.0.0.1:9222",
    });
}
/**
 * Alibaba Token Plan lane adapter (Anthropic-protocol passthrough, `x-api-key`). One
 * constructor for refresh (cli.ts) and serving (below); the fixed HTTPS origin is enforced by
 * the transport and the key is resolved per call from `environment`.
 * DATA RULE: public or synthetic material only (see ALIBABA_MODEL_CONTRACTS).
 */
export function defaultAlibabaAdapter(environment: NodeJS.ProcessEnv): AnthropicApiKeyAdapter {
    return new AnthropicApiKeyAdapter(new FixedOriginFetchTransport(new URL(ALIBABA_BASE_URL)), ALIBABA_LANE, environment);
}
/** Z.AI lane adapter, same shape as the Alibaba lane. */
export function defaultZaiAdapter(environment: NodeJS.ProcessEnv): AnthropicApiKeyAdapter {
    return new AnthropicApiKeyAdapter(new FixedOriginFetchTransport(new URL(ZAI_BASE_URL)), ZAI_LANE, environment);
}
/**
 * OpenAI API-key lane adapter (chat completions via the shared Messages translation,
 * `authorization: Bearer`). Distinct from the `openai` ChatGPT-OAuth/clodex lane, which is
 * untouched. DATA RULE: public or synthetic material only.
 */
export function defaultOpenAiApiKeyAdapter(environment: NodeJS.ProcessEnv): OpenAiApiKeyAdapter {
    return new OpenAiApiKeyAdapter(new FixedOriginFetchTransport(new URL(OPENAI_API_BASE_URL)), environment);
}
export async function startProviderSet(snapshot: ModelSnapshot, paths: RuntimePaths, clodexNonce: string, externalRuntime?: ExternalAgentRuntime): Promise<ProviderSet> {
    const adapters = new Map<ProviderId, ProviderAdapter>();
    const readiness: ProviderReadiness[] = [];
    const closeActions: (() => Promise<void>)[] = [];
    const anthropic = new AnthropicAdapter(new FixedOriginFetchTransport(new URL("https://api.anthropic.com")));
    adapters.set("anthropic", anthropic);
    readiness.push(await anthropic.readiness());
    const requestedProviders = new Set(snapshot.models.map((model) => model.provider));
    if (requestedProviders.has("web") && externalRuntime?.disabledProviders?.has("web") !== true) {
        // Loopback only. A lane that is down keeps its adapter registered: a request against
        // it then fails with the detailCode remedy instead of a bare "adapter unavailable".
        const web = defaultWebBridgeAdapter();
        adapters.set("web", web);
        readiness.push(await web.readiness());
    }
    // The API-key lanes (alibaba / zai / openaiapi): a lane that is down keeps its adapter
    // (same rule as the web lane). The adapter
    // stays registered even when its key is missing, so a request against the lane answers with
    // the named remedy (`alibaba_key_missing`, `zai_key_missing`, `openaiapi_key_missing`)
    // instead of a bare "adapter unavailable".
    for (const lane of [
        { id: "alibaba", build: defaultAlibabaAdapter },
        { id: "zai", build: defaultZaiAdapter },
        { id: "openaiapi", build: defaultOpenAiApiKeyAdapter },
    ] as const) {
        if (requestedProviders.has(lane.id) && externalRuntime?.disabledProviders?.has(lane.id) !== true) {
            const adapter = lane.build(externalRuntime?.environment ?? process.env);
            adapters.set(lane.id, adapter);
            readiness.push(await adapter.readiness());
        }
    }
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
        catch (error) {
            writeSafeLog({ event: "provider_start_failed", level: "warn", provider: "openai", ...describeProviderStartFailure(error) });
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
                readiness: async () => ready("xai", "grok_acp_snapshot_verified"),
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
                // With a registry, agy's call-scoped MCP map contains only our
                // server and --sandbox is enforced. Claude Code decides each
                // bridged tool call. The legacy registry-free fallback below retains
                // its own tools and permission bypass; it is not the routed session lane.
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
/**
 * What a provider's failed start leaves in router.log (audit D1-04, 2026-11-15). The serving
 * path swallowed every OpenAI-lane failure into one readiness code and wrote nothing, so a
 * capsule that would not spawn, a stale entrypoint hash and an expired ChatGPT login read the
 * same although their remedies are opposite. A RouterError's message is author-written and
 * carries the remedy; a foreign error contributes its name only.
 */
export function describeProviderStartFailure(error: unknown): { readonly code: string; readonly remedy?: string; readonly errorName?: string } {
    if (error instanceof RouterError)
        return { code: error.code, remedy: error.message.slice(0, 300) };
    if (error instanceof Error)
        return { code: "provider_start_failed", errorName: error.name };
    return { code: "provider_start_failed" };
}
