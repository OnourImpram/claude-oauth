import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { ProviderReadiness } from "../domain/contracts.js";
import { ModelRegistry } from "../domain/registry.js";
import { RouterError } from "../domain/errors.js";
import { startRouterServer } from "../router/server.js";
import { ReceiptStore } from "../runtime/receipt-store.js";
import { requireInstallChecks, expandLockedPath, sideProviderInstallDrift, type InstallComponent } from "../runtime/install-lock.js";
import { prepareEffectiveInstallation, type PreparedInstallation } from "../runtime/claude-shadow.js";
import { ensurePrivateDirectory, runtimePaths, runtimeSessionPaths } from "../runtime/paths.js";
import { withPinnedNativeModels } from "../domain/model-refresh.js";
import { readSnapshot, readSnapshotOrDefault, seedSnapshot } from "../runtime/snapshot-store.js";
import { removeSupervisorState, writeSupervisorState } from "../runtime/state-store.js";
import { runInteractive } from "../runtime/child-process.js";
import { assertNoApiKeySelectors, sanitizedClaudeEnvironment } from "../security/environment.js";
import { createSessionNonce, SESSION_HEADER } from "../security/nonce.js";
import { AgentSessionRegistry } from "../mcp/session-registry.js";
import { mcpHttpServer, startGrokAcpSession } from "../grok/acp-bridge.js";
import { startAntigravitySession } from "../antigravity/session.js";
import { sweepStaleConfigHomes } from "../antigravity/config-home.js";
import { startSupervisorIpc, type SupervisorStatus } from "./ipc.js";
import { startProviderSet } from "./provider-set.js";
import { AGENT_MODEL_CONTRACTS, OPENAI_MODEL_CONTRACTS, autoCompactWindowForModel } from "../domain/model-contracts.js";
import type { ClaudeClientMode } from "../runtime/install-lock.js";
import { preferredLoopbackPort } from "../runtime/loopback-port.js";
import { gatewayModelsCachePath, projectDiscoveryPayload, shouldWriteGatewayModelsCache, writeGatewayModelsCache } from "../runtime/gateway-models-cache.js";
import { writeSafeLog } from "../runtime/log.js";
export interface ClaudeOAuthLaunchOptions {
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
    /** Internal test seam. The public CLI always performs self-healing verification. */
    readonly preparedInstallation?: PreparedInstallation;
    /** Internal test seam. Public sessions always receive a random identifier. */
    readonly sessionId?: string;
    /** Internal test seam. The public CLI always starts the verified Claude shadow. */
    readonly interactiveRunner?: typeof runInteractive;
}
interface OAuthAgentDefinition {
    readonly description: string;
    readonly prompt: string;
    readonly model: string;
    readonly tools: readonly string[];
    readonly maxTurns?: number;
}
interface OAuthAgentContract {
    readonly name: string;
    readonly requiredSnapshotModel?: string;
    readonly definition: OAuthAgentDefinition;
}
function moduleRoot(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
const patchedModelAliases = new Map([...OPENAI_MODEL_CONTRACTS, ...AGENT_MODEL_CONTRACTS].flatMap((model) => [
    [model.id, model.alias],
    [`${model.id}[1m]`, model.alias],
    [model.alias, model.alias],
]));
const nativeOAuthAgentTools = ["Read", "Write", "Edit", "Grep", "Glob", "PowerShell"];
// The model string the agent will hand to Claude Code depends on the mode: the patched
// picker expects an alias ("sol"), while the native gateway expects the FULL snapshot
// identity ("anthropic-openai-gpt-5.6-sol") -- the native binary does not recognise aliases.
function clientModelFor(mode: ClaudeClientMode, alias: string, id: string): string {
    return mode === "native-gateway" ? id : alias;
}
// The name is NOW DERIVED. Its previous shape was `alias === "gemini" ? "gemini-delege" :
// "opus-google-delege"`: that worked with two Google models, but once a third was added two
// agents took the same name and Object.fromEntries silently overwrote one of them.
// Also, because the filter was `provider === "google"`, grok-delege was NEVER produced.
function oauthAgentContractsFor(mode: ClaudeClientMode): readonly OAuthAgentContract[] {
    return [
        {
            name: "claude-opus-delege",
            definition: {
                description: 'Claude.ai OAuth Opus 1M agent. REQUIRED: invoke Agent with model="opus[1m]"; any other model is invalid.',
                prompt: "Use Claude.ai OAuth Opus 1M. Complete the delegated task without provider fallback.",
                model: "opus[1m]",
                tools: nativeOAuthAgentTools,
            },
        },
        ...OPENAI_MODEL_CONTRACTS.map((contract) => {
            const clientModel = clientModelFor(mode, contract.alias, contract.id);
            return {
                name: `${contract.alias}-delege`,
                requiredSnapshotModel: contract.id,
                definition: {
                    description: `ChatGPT OAuth ${contract.displayName}. REQUIRED: invoke Agent with model="${clientModel}"; any other model is invalid.`,
                    prompt: `Use exact ${contract.displayName}. Complete the delegated task without provider fallback.`,
                    model: clientModel,
                    tools: nativeOAuthAgentTools,
                },
            };
        }),
        ...AGENT_MODEL_CONTRACTS.map((contract) => {
            const clientModel = clientModelFor(mode, contract.alias, contract.id);
            const lane = contract.provider === "google" ? "Google account OAuth" : "xAI OAuth";
            return {
                name: `${contract.alias}-delege`,
                requiredSnapshotModel: contract.id,
                definition: {
                    description: `${lane} ${contract.displayName}. REQUIRED: invoke Agent with model="${clientModel}"; any other model is invalid. Read-only.`,
                    prompt: `Use exact ${contract.upstreamModel} through ${lane}. Return read-only analysis text and perform no side effects.`,
                    model: clientModel,
                    tools: [],
                    maxTurns: 1,
                },
            };
        }),
    ];
}
function patchedModelAlias(modelId: string, mode: ClaudeClientMode = "patched-shadow"): string {
    // On the native path there is NO rewriting: the full identity passes through as-is.
    if (mode === "native-gateway")
        return modelId;
    return patchedModelAliases.get(modelId) ?? modelId;
}
function patchedAgentDefinitions(serialized: string, mode: ClaudeClientMode): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized);
    }
    catch {
        return serialized;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return serialized;
    let changed = false;
    const definitions = Object.fromEntries(Object.entries(parsed).map(([name, definition]) => {
        if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
            return [name, definition];
        }
        const model = (definition as Record<string, unknown>)["model"];
        if (typeof model !== "string")
            return [name, definition];
        const clientModel = patchedModelAlias(model, mode);
        if (clientModel === model)
            return [name, definition];
        changed = true;
        return [name, { ...definition, model: clientModel }];
    }));
    return changed ? JSON.stringify(definitions) : serialized;
}
function parsedAgentDefinitions(serialized: string): Record<string, unknown> | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return undefined;
    return parsed as Record<string, unknown>;
}
function activeOAuthAgentDefinitions(availableModelIds: readonly string[], mode: ClaudeClientMode): Record<string, OAuthAgentDefinition> {
    const available = new Set(availableModelIds);
    return Object.fromEntries(oauthAgentContractsFor(mode)
        .filter((contract) => contract.requiredSnapshotModel === undefined || available.has(contract.requiredSnapshotModel))
        .map((contract) => [contract.name, contract.definition]));
}
function mergedOAuthAgentDefinitions(serialized: string | undefined, availableModelIds: readonly string[], mode: ClaudeClientMode): string | undefined {
    const required = activeOAuthAgentDefinitions(availableModelIds, mode);
    if (Object.keys(required).length === 0)
        return serialized;
    const definitions = serialized === undefined ? {} : parsedAgentDefinitions(serialized);
    if (definitions === undefined)
        return undefined;
    for (const [name, definition] of Object.entries(required)) {
        const existing = definitions[name];
        if (existing === undefined) {
            definitions[name] = definition;
            continue;
        }
        if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
            throw new RouterError("invalid_request", `Reserved OAuth agent ${name} has an invalid definition.`, 400);
        }
        const configuredModel = (existing as Record<string, unknown>)["model"];
        if (typeof configuredModel !== "string" || patchedModelAlias(configuredModel, mode) !== definition.model) {
            throw new RouterError("invalid_request", `Reserved OAuth agent ${name} must keep its exact model route.`, 400);
        }
        if (definition.maxTurns !== undefined) {
            const configuredMaxTurns = (existing as Record<string, unknown>)["maxTurns"];
            const configuredTools = (existing as Record<string, unknown>)["tools"];
            if (configuredMaxTurns !== definition.maxTurns ||
                !Array.isArray(configuredTools) ||
                configuredTools.length !== 0) {
                throw new RouterError("invalid_request", `Reserved OAuth agent ${name} must keep its read-only single-turn bounds.`, 400);
            }
        }
    }
    return JSON.stringify(definitions);
}
export function claudePatchedModelArguments(args: readonly string[], mode: ClaudeClientMode = "patched-shadow"): readonly string[] {
    const rewritten = [...args];
    for (let index = 0; index < rewritten.length; index += 1) {
        const argument = rewritten[index];
        if (argument === "--model") {
            const model = rewritten[index + 1];
            if (model !== undefined)
                rewritten[index + 1] = patchedModelAlias(model, mode);
            index += 1;
            continue;
        }
        if (argument?.startsWith("--model=")) {
            const model = argument.slice("--model=".length);
            rewritten[index] = `--model=${patchedModelAlias(model, mode)}`;
            continue;
        }
        if (argument === "--agents") {
            const definitions = rewritten[index + 1];
            if (definitions !== undefined)
                rewritten[index + 1] = patchedAgentDefinitions(definitions, mode);
            index += 1;
            continue;
        }
        if (argument?.startsWith("--agents=")) {
            const definitions = argument.slice("--agents=".length);
            rewritten[index] = `--agents=${patchedAgentDefinitions(definitions, mode)}`;
        }
    }
    return rewritten;
}
export function claudeOAuthAgentArguments(args: readonly string[], availableModelIds: readonly string[], mode: ClaudeClientMode = "patched-shadow"): readonly string[] {
    const rewritten = [...claudePatchedModelArguments(args, mode)];
    if (rewritten.includes("--safe-mode") || rewritten.includes("--version") || rewritten.includes("-v")) {
        return rewritten;
    }
    const agentArgumentIndexes = rewritten.flatMap((argument, index) => argument === "--agents" || argument.startsWith("--agents=") ? [index] : []);
    if (agentArgumentIndexes.length > 1) {
        throw new RouterError("invalid_request", "Claude received multiple ambiguous --agents arguments.", 400);
    }
    if (agentArgumentIndexes.length === 0) {
        const definitions = mergedOAuthAgentDefinitions(undefined, availableModelIds, mode);
        return definitions === undefined ? rewritten : [...rewritten, "--agents", definitions];
    }
    const index = agentArgumentIndexes[0];
    if (index === undefined)
        return rewritten;
    const argument = rewritten[index];
    if (argument === "--agents") {
        const definitions = rewritten[index + 1];
        if (definitions === undefined)
            return rewritten;
        const merged = mergedOAuthAgentDefinitions(definitions, availableModelIds, mode);
        if (merged === undefined)
            return rewritten;
        rewritten[index + 1] = merged;
        return rewritten;
    }
    if (argument?.startsWith("--agents=")) {
        const definitions = argument.slice("--agents=".length);
        const merged = mergedOAuthAgentDefinitions(definitions, availableModelIds, mode);
        if (merged === undefined)
            return rewritten;
        rewritten[index] = `--agents=${merged}`;
    }
    return rewritten;
}
// Reads the model the user asked for out of the raw argv. Last --model wins, which
// is what the CLI itself does. Returns undefined when no --model was passed, so the
// default model keeps whatever threshold the operator configured.
export function requestedModelArgument(args: readonly string[]): string | undefined {
    let requested: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--model") {
            const value = args[index + 1];
            if (value !== undefined && !value.startsWith("-")) {
                requested = value;
                index += 1;
            }
            continue;
        }
        if (argument?.startsWith("--model=")) {
            requested = argument.slice("--model=".length);
        }
    }
    return requested === undefined || requested.trim() === "" ? undefined : requested;
}
export function claudeRouterEnvironment(baseUrl: string, nonce: string, source: NodeJS.ProcessEnv = process.env, requestedModel?: string): NodeJS.ProcessEnv {
    const environment = sanitizedClaudeEnvironment(source);
    // FIXED base URL. The nonce is NO LONGER IN THE PATH, only in the header -- the router
    // accepts both channels (measured: the header alone gives HTTP 200; with neither present,
    // 401). The secret is the same secret, only where it is carried changed; security is not
    // weakened.
    //
    // Reason: Claude Code keys gateway model discovery to ANTHROPIC_BASE_URL EXACTLY. As long
    // as a session-specific nonce is carried in the path, the base URL changes every session,
    // the cache never matches, and the /model list NEVER shows external models.
    environment["ANTHROPIC_BASE_URL"] = baseUrl.replace(/\/$/u, "");
    environment["ANTHROPIC_CUSTOM_HEADERS"] = `${SESSION_HEADER}: ${nonce}`;
    environment["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"] = "1";
    // ANTHROPIC_AUTH_TOKEN CANNOT BE PUT HERE. Discovery looked like it was failing without it
    // -- the binary says "skipped: no credential (ANTHROPIC_AUTH_TOKEN, apiKeyHelper, or API
    // key)" -- but it was measured: when it is set, Claude Code DROPS its own OAuth token and
    // sends this value as Authorization: Bearer, AnthropicAdapter forwards it upstream verbatim,
    // and Anthropic returns "401 Invalid bearer token". That is, the Claude main path breaks and
    // /login cannot fix it, because the problem is not in the session but in the header.
    //
    // Discovery has already run once and wrote ~/.claude/cache/gateway-models.json with the
    // fixed base URL; the picker reads the cache and does not re-run discovery every session. A
    // channel that requires a credential is a channel whose price is the Claude main path -- and
    // that price is not paid.
    environment["NO_PROXY"] = "127.0.0.1,localhost";
    delete environment["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"];
    // Per-model auto-compaction. Deliberately scoped to external models: for a Claude
    // model autoCompactWindowForModel returns undefined and we DELETE the variable
    // rather than leaving an inherited one in place, because this variable overrides
    // the operator's autoCompactWindow setting and a stale inherited value would
    // silently retarget a Claude session.
    const autoCompactWindow = requestedModel === undefined ? undefined : autoCompactWindowForModel(requestedModel);
    if (autoCompactWindow === undefined)
        delete environment["CLAUDE_CODE_AUTO_COMPACT_WINDOW"];
    else
        environment["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = String(autoCompactWindow);
    return environment;
}
function runningStatus(startedAt: string, baseUrl: string, models: readonly string[], providers: readonly ProviderReadiness[]): SupervisorStatus {
    return {
        schemaVersion: 1,
        status: "running",
        pid: process.pid,
        startedAt,
        baseUrl,
        models,
        providers,
    };
}
export async function launchClaudeOAuth(options: ClaudeOAuthLaunchOptions): Promise<number> {
    const root = moduleRoot();
    const environment = options.environment ?? process.env;
    assertNoApiKeySelectors(environment);
    const sharedPaths = runtimePaths(environment);
    await ensurePrivateDirectory(sharedPaths.root);
    const sessionId = options.sessionId ?? randomBytes(16).toString("hex");
    const paths = runtimeSessionPaths(sharedPaths, sessionId);
    await ensurePrivateDirectory(dirname(paths.state));
    const prepared = options.preparedInstallation ?? await prepareEffectiveInstallation(root, environment);
    const { installLock, installChecks } = prepared;
    requireInstallChecks(installChecks, ["node", "claude", "claude-shadow", "clodex"]);
    const defaultSnapshot = resolve(root, "config", "models.default.json");
    await seedSnapshot(paths.snapshot, defaultSnapshot);
    // Native rows come from the pinned baseline, external rows from the running snapshot (A7).
    const snapshot = withPinnedNativeModels(await readSnapshotOrDefault(paths.snapshot, defaultSnapshot), await readSnapshot(defaultSnapshot));
    const conditionalComponents: InstallComponent[] = [
        ...(snapshot.models.some((model) => model.provider === "google") ? ["antigravity" as const] : []),
        ...(snapshot.models.some((model) => model.provider === "xai") ? ["grok" as const] : []),
    ];
    // A4: a side provider's nail violation does NOT CLOSE the main path (see the install-lock.ts
    // header). The violation drops to a warning, that provider's models are not served this
    // session and the picker cache does not list them either; `claude` still starts.
    const sideDrift = sideProviderInstallDrift(installChecks, conditionalComponents);
    for (const drift of sideDrift) {
        writeSafeLog({
            event: "side_provider_install_drift",
            level: "warn",
            code: `${drift.component}:${drift.status}:${drift.detailCode}`,
            remedy: `${drift.provider} models are disabled this session; claude keeps running. Run claude-oauth doctor, then re-pin ${drift.component} in config/install-lock.json through a fresh release (never edit a release in place).`,
        });
    }
    const disabledProviders = new Set(sideDrift.map((drift) => drift.provider));
    const grokBinary = expandLockedPath(installLock.grok.executable, environment);
    // Phase 9 -- CHICKEN AND EGG. This registry has to be built BEFORE the provider set (the
    // adapters will bind to it), but the MCP endpoint's URL and the session nonce are only
    // known ONCE the router STARTS. Both are read LAZILY; if a session is opened before the
    // injection happens, mcpUrlFor throws a named error rather than producing a silently
    // broken URL.
    let routerBaseUrl = "";
    let routerNonce = "";
    const grokSessions = new AgentSessionRegistry({
        mcpBaseUrl: () => routerBaseUrl,
        mcpHeaders: () => (routerNonce === "" ? {} : { [SESSION_HEADER]: routerNonce }),
        startAgent: ({ prompt, mcpUrl, mcpHeaders, model, bridge }) =>
            startGrokAcpSession({
                binary: grokBinary,
                home: paths.grokHome,
                cwd: options.cwd,
                task: prompt,
                model,
                environment,
                mcpServers: [mcpHttpServer("hezarfen-claude-code-tools", mcpUrl, mcpHeaders)],
                bridgedToolNames: bridge.tools.map((tool) => tool.name),
            }),
    });
    const antigravityBinary = expandLockedPath(installLock.antigravity.executable, environment);
    // G01. Before any call builds one, homes orphaned by an earlier crash are removed. The
    // sweep runs at STARTUP and not on a timer: a timer would race a live call, and the
    // sweep's own measure asserts that a home whose owner is alive SURVIVES.
    const configHomeRoot = join(paths.root, "providers", "antigravity", "call-homes");
    const sweep = await sweepStaleConfigHomes({ root: configHomeRoot });
    if (sweep.removed.length > 0) {
        writeSafeLog({
            event: "antigravity_config_home_sweep",
            level: "info",
            code: `removed:${sweep.removed.length}:kept:${sweep.kept.length}`,
            remedy: "No action needed: these are call-scoped Antigravity homes left by an interrupted run; the operator's own configuration is never written by this lane.",
        });
    }
    const googleSessions = new AgentSessionRegistry({
        mcpBaseUrl: () => routerBaseUrl,
        mcpHeaders: () => (routerNonce === "" ? {} : { [SESSION_HEADER]: routerNonce }),
        startAgent: ({ prompt, mcpUrl, mcpHeaders, model }) =>
            startAntigravitySession({
                binary: antigravityBinary,
                cwd: options.cwd,
                prompt,
                model,
                environment,
                configHomeRoot,
                toolEndpoint: { url: mcpUrl, headers: mcpHeaders },
            }),
    });
    const providerSet = await startProviderSet(snapshot, paths, createSessionNonce(), {
        cwd: options.cwd,
        environment,
        antigravityBinary,
        grokBinary,
        grokSessions,
        googleSessions,
        disabledProviders,
    });
    try {
        const sessionNonce = createSessionNonce();
        const registry = new ModelRegistry(providerSet.snapshot, providerSet.adapters);
        routerNonce = sessionNonce;
        const router = await startRouterServer({
            nonce: sessionNonce,
            registry,
            receipts: new ReceiptStore(paths.receipts),
            preferredPort: preferredLoopbackPort(environment),
            mcpBridge: (sessionKey) => grokSessions.bridgeFor(sessionKey) ?? googleSessions.bridgeFor(sessionKey),
        });
        // The endpoint behind the gate becomes addressable only NOW.
        routerBaseUrl = router.baseUrl;
        // The ROUTER writes the picker cache (see the gateway-models-cache.ts header). Discovery
        // demands a credential and a credential breaks the main path; the router writes without
        // one, using the address it is actually bound to. If it cannot write, it logs and
        // CONTINUES: an empty picker is a defect, `claude` not starting is a breakage.
        const gatewayCachePath = gatewayModelsCachePath(environment);
        const pinnedPort = preferredLoopbackPort(environment);
        if (!shouldWriteGatewayModelsCache(router.port, pinnedPort)) {
            // A3: a session on an ephemeral port must not overwrite the picker of the session on
            // the fixed port.
            writeSafeLog({
                event: "gateway_models_cache_skipped",
                level: "warn",
                code: `port=${router.port}`,
                remedy: `Router is on an ephemeral port, not ${pinnedPort} (another claude session holds it): the /model picker keeps the pinned session's cache and lists no external models here. External models still resolve by id (--model ...). Free port ${pinnedPort} and relaunch to get the picker back.`,
            });
        }
        else {
            try {
                const written = await writeGatewayModelsCache(gatewayCachePath, router.baseUrl, projectDiscoveryPayload(registry.discoveryPayload()));
                writeSafeLog({ event: "gateway_models_cache_written", level: "info", code: `models=${written.models.length}`, remedy: `${written.baseUrl} -> ${gatewayCachePath}` });
            }
            catch (error) {
                writeSafeLog({
                    event: "gateway_models_cache_write_failed",
                    level: "warn",
                    code: (error as NodeJS.ErrnoException).code ?? "write_failed",
                    remedy: `The /model picker will not list external models this session (${gatewayCachePath}). Check that the cache directory is writable; the router keeps running.`,
                });
            }
        }
        const startedAt = new Date().toISOString();
        const models = registry.list().map((model) => model.id);
        const providers = providerSet.readiness;
        const status = (): SupervisorStatus => runningStatus(startedAt, router.baseUrl, models, providers);
        let ipc: { close(): Promise<void> } | undefined;
        try {
            ipc = await startSupervisorIpc(paths.ipc, status);
            await writeSupervisorState(paths.state, status());
            const claudeBinary = expandLockedPath(installLock.claudeShadow.executable, environment);
            const interactiveRunner = options.interactiveRunner ?? runInteractive;
            return await interactiveRunner(claudeBinary, claudeOAuthAgentArguments(options.args, models, prepared.clientMode), {
                cwd: options.cwd,
                environment: claudeRouterEnvironment(router.baseUrl, sessionNonce, environment, requestedModelArgument(options.args)),
            });
        }
        finally {
            await ipc?.close().catch(() => undefined);
            // Abandoned ACP processes are a process-tree leak; on shutdown the parked calls are
            // released as well.
            grokSessions.closeAll("router shutdown");
            await router.close().catch(() => undefined);
            await removeSupervisorState(paths.state).catch(() => undefined);
        }
    }
    finally {
        await providerSet.close().catch(() => undefined);
    }
}
