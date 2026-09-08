#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSnapshot, ProviderId, ProviderReadiness } from "./domain/contracts.js";
import { activeCustomSelectors, blockingCustomSelectors, runAntigravityHeadless } from "./antigravity/headless-bridge.js";
import { RouterError, normalizeRouterError } from "./domain/errors.js";
import {
    catalogVerifiedGoogleModelIds,
    openAiContextMismatches,
    openAiModelReadiness,
    requireAllProvidersReady,
    type GoogleModelCatalogReadiness,
    type OpenAiModelReadiness,
    withPinnedNativeModels,
    withVerifiedGoogleModels,
    withVerifiedGrokModel,
    withVerifiedOpenAiModels,
} from "./domain/model-refresh.js";
import {
    AGENT_MODEL_CONTRACTS,
    ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
    GROK_46_CONTEXT_WINDOW_TOKENS,
    GROK_46_MODEL_ID,
    verifiedGrok46CatalogEntry,
} from "./domain/model-contracts.js";
import { deviceLoginPlan } from "./domain/provider-login.js";
import { modelDetail } from "./domain/registry.js";
import { runGeminiAcp } from "./gemini/acp-bridge.js";
import { inspectGrokModels, prepareGrokProcessEnvironment, runGrokAcp } from "./grok/acp-bridge.js";
import { runCaptured, runInteractive } from "./runtime/child-process.js";
import { prepareEffectiveInstallation, type ClaudeShadowState } from "./runtime/claude-shadow.js";
import {
    expandLockedPath,
    readInstallLock,
    requireInstallChecks,
    verifyInstallLock,
    type InstallCheck,
    type InstallComponent,
    type InstallLock,
} from "./runtime/install-lock.js";
import { gatewayModelsCachePath, gatewayModelsCacheRemedy, gatewayModelsCacheStatus } from "./runtime/gateway-models-cache.js";
import { writeSafeLog } from "./runtime/log.js";
import { preferredLoopbackPort } from "./runtime/loopback-port.js";
import { verifyReleaseIdentity, type ReleaseIdentity } from "./runtime/release-identity.js";
import { runtimePaths, ensurePrivateDirectory } from "./runtime/paths.js";
import { ReceiptStore } from "./runtime/receipt-store.js";
import { isNativeClaudeCommand, resolveEntrypoint } from "./cli-routing.js";
import { readSnapshot, readSnapshotOrDefault, writeSnapshot } from "./runtime/snapshot-store.js";
import {
    assertNoApiKeySelectors,
    presentApiKeySelectors,
    sanitizedClaudeEnvironment,
    sanitizedWorkerEnvironment,
} from "./security/environment.js";
import { createSessionNonce } from "./security/nonce.js";
import { readActiveSupervisorStatuses } from "./supervisor/ipc.js";
import { launchClaudeOAuth } from "./supervisor/launcher.js";
import { startCatalogProviders } from "./supervisor/provider-set.js";
interface CliContext {
    readonly root: string;
    readonly installLock: InstallLock;
    readonly installChecks: readonly InstallCheck[];
    readonly releaseIdentity?: ReleaseIdentity;
    readonly environment: NodeJS.ProcessEnv;
    readonly shadow?: ClaudeShadowState;
    readonly shadowDetailCode?: string;
}
interface NativeAuthStatus {
    readonly loggedIn: boolean;
    readonly authMethod?: string;
    readonly apiProvider?: string;
}
interface CatalogSnapshotResult {
    readonly snapshot: ModelSnapshot;
    readonly providers: readonly ProviderReadiness[];
    readonly openAiModels: readonly OpenAiModelReadiness[];
    readonly grokEnabled: boolean;
    readonly googleModels: readonly GoogleModelCatalogReadiness[];
    readonly dropped: readonly string[];
}
function publicLauncherStatus(environment: NodeJS.ProcessEnv): { readonly source: string; readonly releaseId?: string } {
    const source = environment["HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE"];
    const releaseId = environment["HEZARFEN_CLAUDE_OAUTH_RELEASE_ID"];
    if (source === "embedded-release" && releaseId !== undefined && /^router-v3-[A-F0-9]{12}-[A-F0-9]{12}$/u.test(releaseId)) {
        return { source, releaseId };
    }
    return { source: "direct-or-unverified" };
}
function moduleRoot(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
function printJson(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function clodexEntrypoint(root: string): string {
    return join(root, "node_modules", "@bman654", "clodex", "dist", "cli.js");
}
function geminiEntrypoint(ctx: CliContext): string {
    return expandLockedPath(ctx.installLock.gemini.entrypoint, ctx.environment);
}
function antigravityBinary(ctx: CliContext): string {
    return expandLockedPath(ctx.installLock.antigravity.executable, ctx.environment);
}
async function context(environment: NodeJS.ProcessEnv = process.env): Promise<CliContext> {
    const root = moduleRoot();
    const prepared = await prepareEffectiveInstallation(root, environment);
    return { root, ...prepared, environment };
}
async function diagnosticContext(environment: NodeJS.ProcessEnv = process.env): Promise<CliContext> {
    if (presentApiKeySelectors(environment).length === 0) {
        try {
            return await context(environment);
        }
        catch {
            // Doctor must remain available when the mechanism it diagnoses cannot heal.
        }
    }
    const root = moduleRoot();
    const installLock = await readInstallLock(resolve(root, "config", "install-lock.json"));
    const installChecks = await verifyInstallLock(installLock, root, environment);
    return {
        root,
        installLock,
        installChecks,
        environment,
        releaseIdentity: await verifyReleaseIdentity(root, environment),
        shadowDetailCode: presentApiKeySelectors(environment).length > 0 ? "api_key_selector_active" : "self_heal_failed",
    };
}
function requireComponents(ctx: CliContext, components: readonly InstallComponent[]): void {
    requireInstallChecks(ctx.installChecks, components);
}
async function nativeAuthStatus(ctx: CliContext): Promise<NativeAuthStatus> {
    const binary = expandLockedPath(ctx.installLock.claude.executable, ctx.environment);
    const result = await runCaptured(binary, ["auth", "status", "--json"], {
        cwd: process.cwd(),
        environment: sanitizedClaudeEnvironment(ctx.environment),
        timeoutMs: 30_000,
        maximumOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0)
        return { loggedIn: false };
    try {
        const value: unknown = JSON.parse(result.stdout);
        if (typeof value !== "object" || value === null || !("loggedIn" in value) || typeof value.loggedIn !== "boolean") {
            return { loggedIn: false };
        }
        const authMethod = "authMethod" in value && typeof value.authMethod === "string" ? value.authMethod : undefined;
        const apiProvider = "apiProvider" in value && typeof value.apiProvider === "string" ? value.apiProvider : undefined;
        return {
            loggedIn: value.loggedIn,
            ...(authMethod === undefined ? {} : { authMethod }),
            ...(apiProvider === undefined ? {} : { apiProvider }),
        };
    }
    catch {
        return { loggedIn: false };
    }
}
async function launchNativeClaudeCommand(args: readonly string[]): Promise<number> {
    const ctx = await diagnosticContext();
    requireComponents(ctx, ["claude"]);
    return await runInteractive(expandLockedPath(ctx.installLock.claude.executable, ctx.environment), args, { cwd: process.cwd(), environment: sanitizedClaudeEnvironment(ctx.environment) });
}
function ready(provider: ProviderId, detailCode: string, expiresAt?: string): ProviderReadiness {
    return {
        provider,
        oauthReady: true,
        adapterReady: true,
        status: "ready",
        ...(expiresAt === undefined ? {} : { expiresAt }),
        detailCode,
    };
}
function unavailable(provider: ProviderId, detailCode: string): ProviderReadiness {
    return {
        provider,
        oauthReady: false,
        adapterReady: false,
        status: "auth_required",
        detailCode,
    };
}
async function droppedModelIds(snapshotPath: string, next: ModelSnapshot): Promise<readonly string[]> {
    let current: ModelSnapshot;
    try {
        current = await readSnapshot(snapshotPath);
    }
    catch {
        return [];
    }
    const nextIds = new Set(next.models.map((model) => model.id));
    return current.models.map((model) => model.id).filter((id) => !nextIds.has(id));
}
async function catalogSnapshot(ctx: CliContext, write: boolean, allowShrink = false): Promise<CatalogSnapshotResult> {
    assertNoApiKeySelectors(ctx.environment);
    // Only the components a snapshot cannot be built without. Optional providers
    // that are not installed degrade to "unavailable" in their own probes; they
    // must not hold the installed providers hostage. The shrink guard below is
    // what keeps a partial refresh from silently narrowing the model picker.
    requireComponents(ctx, ["node", "clodex"]);
    const paths = runtimePaths(ctx.environment);
    await ensurePrivateDirectory(paths.root);
    const baseline = await readSnapshot(resolve(ctx.root, "config", "models.default.json"));
    const providers = await startCatalogProviders(paths, createSessionNonce());
    const readiness: ProviderReadiness[] = [];
    let snapshot = baseline;
    // Derived, NOT hand-written -- the reason is at the top of openAiModelReadiness.
    let openAiModels: readonly OpenAiModelReadiness[] = openAiModelReadiness(undefined);
    let grokEnabled = false;
    let googleModels: readonly GoogleModelCatalogReadiness[] = [];
    try {
        if (providers.clodex === undefined) {
            readiness.push(unavailable("openai", "clodex_auth_or_startup_failed"));
        }
        else {
            try {
                const catalog = await providers.clodex.catalog();
                snapshot = withVerifiedOpenAiModels(snapshot, catalog, ctx.installLock.claudeShadow.openAiContextWindow);
                openAiModels = openAiModelReadiness(snapshot);
                const missing = openAiModels.filter((entry) => !entry.enabled).map((entry) => entry.id);
                const mismatches = openAiContextMismatches(catalog, ctx.installLock.claudeShadow.openAiContextWindow);
                readiness.push(missing.length === 0
                    ? ready("openai", "clodex_live_oauth_context_verified")
                    : unavailable("openai", mismatches.length > 0
                        ? `openai_context_window_pin_stale:${mismatches.map((entry) => `${entry.id}=${entry.liveContextWindow ?? "?"}`).join(",")}_pinned=${ctx.installLock.claudeShadow.openAiContextWindow}`
                        // This used to be the fixed string "sol_or_terra_not_in_live_oauth_catalog":
                        // a string that starts lying as soon as the contract list grows. The missing
                        // model is written BY NAME, otherwise the diagnosis goes to the wrong provider.
                        : `openai_models_not_in_live_oauth_catalog:${missing.join(",")}`));
            }
            catch {
                readiness.push(unavailable("openai", "clodex_live_catalog_failed"));
            }
        }
        // Derived from the contracts, not listed by hand: this list used to be two
        // literals, so adding a Google model to AGENT_MODEL_CONTRACTS produced a
        // picker row that was never probed and therefore never entered the snapshot.
        googleModels = await Promise.all(AGENT_MODEL_CONTRACTS
            .filter((entry) => entry.provider === "google")
            .map(async (entry) => await probeAntigravityModel(ctx, entry.upstreamModel)));
        snapshot = withVerifiedGoogleModels(snapshot, catalogVerifiedGoogleModelIds(googleModels));
        readiness.push(...googleModels);
        try {
            const catalog = await inspectGrokModels({
                binary: expandLockedPath(ctx.installLock.grok.executable, ctx.environment),
                home: paths.grokHome,
                cwd: process.cwd(),
                environment: ctx.environment,
                signal: AbortSignal.timeout(30_000),
            });
            const grok = verifiedGrok46CatalogEntry(catalog);
            grokEnabled = grok !== undefined;
            snapshot = withVerifiedGrokModel(snapshot, catalog);
            readiness.push(grokEnabled
                ? ready("xai", "grok_4_6_acp_live_500k_catalog_verified")
                : unavailable("xai", "grok_4_6_500k_not_in_live_catalog"));
        }
        catch {
            readiness.push(unavailable("xai", "grok_acp_live_catalog_failed"));
        }
        const dropped = await droppedModelIds(paths.snapshot, snapshot);
        if (write && dropped.length > 0 && !allowShrink) {
            throw new RouterError("invalid_request", `Refusing to shrink the model snapshot: ${dropped.join(", ")} would be dropped. This is how the picker silently regressed before. FIX: fix the provider that stopped verifying (claude-oauth doctor --live), or re-run with "models refresh --allow-shrink" to accept the narrower snapshot deliberately.`, 409);
        }
        if (write)
            await writeSnapshot(paths.snapshot, snapshot);
        return { snapshot, providers: readiness, openAiModels, grokEnabled, googleModels, dropped };
    }
    finally {
        await providers.close();
    }
}
async function refreshModels(ctx: CliContext, allowShrink: boolean): Promise<number> {
    const result = await catalogSnapshot(ctx, true, allowShrink);
    printJson({
        ok: true,
        snapshot: {
            generatedAt: result.snapshot.generatedAt,
            source: result.snapshot.source,
            models: result.snapshot.models.map((model) => model.id),
            modelDetails: result.snapshot.models.map(modelDetail),
        },
        providers: result.providers,
        ...(result.dropped.length === 0 ? {} : { droppedModels: result.dropped, shrinkAccepted: allowShrink }),
    });
    return 0;
}
async function probeGemini(ctx: CliContext): Promise<ProviderReadiness> {
    requireComponents(ctx, ["node", "gemini"]);
    const paths = runtimePaths(ctx.environment);
    try {
        const result = await runGeminiAcp({
            cwd: process.cwd(),
            task: "Reply with exactly OAUTH_READY. Do not read workspace files.",
            home: paths.geminiHome,
            binary: process.execPath,
            binaryArguments: [geminiEntrypoint(ctx)],
            signal: AbortSignal.timeout(45_000),
        });
        return {
            provider: "google",
            oauthReady: result.text.trim() === "OAUTH_READY",
            adapterReady: result.text.trim() === "OAUTH_READY",
            status: result.text.trim() === "OAUTH_READY" ? "ready" : "unavailable",
            detailCode: result.text.trim() === "OAUTH_READY" ? "gemini_acp_live_verified" : "gemini_acp_marker_mismatch",
        };
    }
    catch {
        return {
            provider: "google",
            oauthReady: false,
            adapterReady: false,
            status: "auth_required",
            detailCode: "gemini_acp_live_failed",
        };
    }
}
async function probeAntigravityModel(ctx: CliContext, model: string): Promise<GoogleModelCatalogReadiness & { readonly contextWindow: number }> {
    // An uninstalled optional provider degrades to "unavailable" like every other
    // provider path here; it must not abort the whole catalog refresh.
    const install = ctx.installChecks.find((check) => check.component === "antigravity");
    if (install === undefined || install.status !== "ok") {
        return {
            provider: "google",
            model,
            contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
            oauthReady: false,
            adapterReady: false,
            status: "unavailable",
            detailCode: `antigravity_install_${install?.detailCode ?? "check_absent"}`,
        };
    }
    // The marker is derived too: a hand-written binary choice would give the same marker to
    // two models once a third was added, and which one answered could not be told apart.
    const marker = `${model.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_OAUTH_READY`;
    try {
        const result = await runAntigravityHeadless({
            binary: antigravityBinary(ctx),
            cwd: process.cwd(),
            prompt: `Reply with exactly ${marker}. Do not use tools or read workspace files.`,
            model,
            environment: ctx.environment,
            timeoutMs: 60_000,
            signal: AbortSignal.timeout(65_000),
        });
        const matched = result.response.trim() === marker;
        return {
            provider: "google",
            model,
            contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
            oauthReady: matched,
            adapterReady: matched,
            status: matched ? "ready" : "unavailable",
            detailCode: matched ? "antigravity_oauth_live_verified" : "antigravity_marker_mismatch",
        };
    }
    catch (error) {
        if (error instanceof RouterError && error.code === "provider_rate_limited") {
            return {
                provider: "google",
                model,
                contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
                oauthReady: true,
                adapterReady: true,
                status: "blocked",
                detailCode: "antigravity_provider_rate_limited",
            };
        }
        if (error instanceof RouterError && error.code === "provider_entitlement_denied") {
            return {
                provider: "google",
                model,
                contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
                oauthReady: true,
                adapterReady: false,
                status: "blocked",
                detailCode: "antigravity_entitlement_denied",
            };
        }
        if (error instanceof RouterError && error.code === "model_not_available") {
            return {
                provider: "google",
                model,
                contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
                oauthReady: true,
                adapterReady: false,
                status: "unavailable",
                detailCode: "antigravity_model_not_available",
            };
        }
        return {
            provider: "google",
            model,
            contextWindow: ANTIGRAVITY_CONTEXT_WINDOW_TOKENS,
            oauthReady: false,
            adapterReady: false,
            status: error instanceof RouterError && error.code === "provider_auth_required" ? "auth_required" : "unavailable",
            // Measured 2026-09-02: when the probe ran from a shell carrying ANTHROPIC_BASE_URL,
            // three models appeared as 'probe_failed' -- not a live outage, a defect of the
            // measurement environment. The reason is read FROM THE ENVIRONMENT, not inferred from
            // the error text; doctor.security lists it too.
            detailCode: error instanceof RouterError && error.code === "provider_auth_required"
                ? "antigravity_oauth_required"
                : blockingCustomSelectors(ctx.environment).length > 0
                    ? "antigravity_custom_selector_active"
                    : "antigravity_live_probe_failed",
        };
    }
}
async function doctor(ctx: CliContext, args: readonly string[]): Promise<number> {
    const requireAll = args.includes("--require-all");
    const live = args.includes("--live") || requireAll;
    const unknown = args.filter((arg) => arg !== "--live" && arg !== "--require-all");
    if (unknown.length > 0)
        throw new RouterError("invalid_request", `Unknown doctor option: ${unknown[0]}`, 400);
    const paths = runtimePaths(ctx.environment);
    const activeApiKeySelectors = presentApiKeySelectors(ctx.environment);
    // Endpoint selectors the Antigravity bridge refuses (e.g. ANTHROPIC_BASE_URL): they do not
    // drop oauthOnly but they do drop the google probe; they must be visible BY NAME.
    const activeAntigravitySelectors = activeCustomSelectors(ctx.environment);
    const oauthOnly = activeApiKeySelectors.length === 0;
    const native = await nativeAuthStatus(ctx);
    const activeSessions = await readActiveSupervisorStatuses(paths);
    // Picker cache: judged against the running session's address, or the fixed port when there
    // is none. Not part of the main path (it does not affect ok), but an empty picker is
    // reported BY NAME and with its remedy.
    const pickerLiveBaseUrl = activeSessions.find((session) => session.baseUrl !== undefined)?.baseUrl
        ?? `http://127.0.0.1:${preferredLoopbackPort(ctx.environment)}`;
    const pickerCacheStatus = await gatewayModelsCacheStatus(gatewayModelsCachePath(ctx.environment), pickerLiveBaseUrl);
    const pickerCacheRemedy = gatewayModelsCacheRemedy(pickerCacheStatus);
    const defaultSnapshot = resolve(ctx.root, "config", "models.default.json");
    const snapshot = withPinnedNativeModels(await readSnapshotOrDefault(paths.snapshot, defaultSnapshot), await readSnapshot(defaultSnapshot));
    let catalog: CatalogSnapshotResult | undefined;
    let googleModels: readonly GoogleModelCatalogReadiness[] = [];
    let geminiAcp: ProviderReadiness | undefined;
    if (live && oauthOnly) {
        try {
            catalog = await catalogSnapshot(ctx, false);
        }
        catch {
            catalog = undefined;
        }
        googleModels = catalog?.googleModels ?? [];
        // Reported only: the ACP bridge carries gemini-delege at runtime but no
        // catalog probe covers it. Not part of providerReady until measured live.
        geminiAcp = await probeGemini(ctx).catch(() => unavailable("google", "gemini_acp_probe_unavailable"));
    }
    const nativeReady = native.loggedIn && native.authMethod === "claude.ai" && native.apiProvider === "firstParty";
    const installReady = ctx.installChecks
        .filter((check) => check.component !== "gemini")
        .every((check) => check.status === "ok");
    // The gate ITSELF now lives in a tested pure function (see the CASE RECORD in
    // model-refresh.ts): as long as it was hand-written here, the `every` -> `some` mutation
    // left the suite green, because no test imports this file. The only thing this line still
    // carries is the question "was --require-all asked for".
    const providerReady = !requireAll || requireAllProvidersReady(catalog === undefined
        ? undefined
        : { openAiModels: catalog.openAiModels, grokEnabled: catalog.grokEnabled, googleModels });
    const ok = oauthOnly && installReady && nativeReady && providerReady;
    printJson({
        ok,
        oauthOnly,
        security: {
            activeApiKeySelectors,
            activeAntigravitySelectors,
        },
        install: ctx.installChecks,
        publicLauncher: {
            ...publicLauncherStatus(ctx.environment),
            identity: ctx.releaseIdentity ?? { status: "unverified", detailCode: "release_identity_not_computed" },
        },
        shadowSelfHeal: ctx.shadow ?? { status: "not_run", detailCode: ctx.shadowDetailCode },
        pickerCache: pickerCacheRemedy === undefined ? pickerCacheStatus : { ...pickerCacheStatus, remedy: pickerCacheRemedy },
        nativeClaude: native,
        session: activeSessions.length === 0
            ? { status: "stopped", count: 0 }
            : { status: "running", count: activeSessions.length, sessions: activeSessions },
        snapshot: {
            generatedAt: snapshot.generatedAt,
            source: snapshot.source,
            models: snapshot.models.map((model) => model.id),
            modelDetails: snapshot.models.map(modelDetail),
        },
        ...(live
            ? {
                live: {
                    providers: catalog?.providers ?? [],
                    // Model by model, by name: the single line "openai unavailable" did not say
                    // which contract had fallen.
                    openAiModels: catalog?.openAiModels ?? [],
                    googleModels,
                    ...(geminiAcp === undefined ? {} : { geminiAcpBridge: geminiAcp }),
                },
            }
            : {}),
    });
    return ok ? 0 : 2;
}
async function authLogin(ctx: CliContext, provider: string): Promise<number> {
    const paths = runtimePaths(ctx.environment);
    await ensurePrivateDirectory(paths.root);
    if (provider === "claude") {
        requireComponents(ctx, ["claude"]);
        return await runInteractive(expandLockedPath(ctx.installLock.claude.executable, ctx.environment), ["auth", "login"], { cwd: process.cwd(), environment: sanitizedClaudeEnvironment(ctx.environment) });
    }
    if (provider === "openai") {
        requireComponents(ctx, ["node", "clodex"]);
        const login = deviceLoginPlan("openai");
        const environment = sanitizedWorkerEnvironment("openai", ctx.environment);
        environment["CLODEX_HOME"] = paths.clodexHome;
        process.stderr.write(`${login.notice}\n`);
        return await runInteractive(process.execPath, [clodexEntrypoint(ctx.root), ...login.arguments], {
            cwd: ctx.root,
            environment,
        });
    }
    if (provider === "xai") {
        requireComponents(ctx, ["grok"]);
        const login = deviceLoginPlan("xai");
        const environment = await prepareGrokProcessEnvironment({
            home: paths.grokHome,
            cwd: process.cwd(),
            environment: ctx.environment,
        });
        process.stderr.write(`${login.notice}\n`);
        return await runInteractive(expandLockedPath(ctx.installLock.grok.executable, ctx.environment), login.arguments, { cwd: process.cwd(), environment });
    }
    if (provider === "google") {
        assertNoApiKeySelectors(ctx.environment);
        requireComponents(ctx, ["antigravity"]);
        const environment = sanitizedWorkerEnvironment("google", ctx.environment);
        environment["AGY_CLI_HIDE_ACCOUNT_INFO"] = "1";
        return await runInteractive(antigravityBinary(ctx), [], { cwd: process.cwd(), environment });
    }
    if (provider === "gemini") {
        // The Gemini ACP bridge authenticates into its OWN home, separate from
        // Antigravity: "auth login google" opens Antigravity and leaves this one
        // unauthenticated, which is why the ACP route reported provider_auth_required
        // while the Google model surface worked. This is the missing half.
        assertNoApiKeySelectors(ctx.environment);
        requireComponents(ctx, ["node", "gemini"]);
        const environment = sanitizedWorkerEnvironment("gemini", ctx.environment);
        environment["GEMINI_CLI_HOME"] = paths.geminiHome;
        environment["HOME"] = paths.geminiHome;
        environment["USERPROFILE"] = paths.geminiHome;
        await ensurePrivateDirectory(paths.geminiHome);
        process.stderr.write("Complete the Gemini CLI OAuth sign-in in the browser window it opens. This is separate from the Antigravity login used by the Google model rows.\n");
        return await runInteractive(process.execPath, [geminiEntrypoint(ctx)], { cwd: process.cwd(), environment });
    }
    throw new RouterError("invalid_request", "Provider must be claude, openai, xai, google, or gemini.", 400);
}
function parseTaskArguments(args: readonly string[]): { readonly cwd: string; readonly task: string } {
    let cwd = process.cwd();
    let task: string | undefined;
    const remainder: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--cwd") {
            const value = args[index + 1];
            if (value === undefined)
                throw new RouterError("invalid_request", "--cwd requires a path.", 400);
            cwd = resolve(value);
            index += 1;
        }
        else if (arg === "--task") {
            const value = args[index + 1];
            if (value === undefined)
                throw new RouterError("invalid_request", "--task requires text.", 400);
            task = value;
            index += 1;
        }
        else {
            remainder.push(arg ?? "");
        }
    }
    const resolvedTask = task ?? remainder.join(" ");
    if (resolvedTask.trim() === "")
        throw new RouterError("invalid_request", "Delegated task must not be empty.", 400);
    return { cwd, task: resolvedTask };
}
async function geminiAcpTask(ctx: CliContext, args: readonly string[]): Promise<number> {
    assertNoApiKeySelectors(ctx.environment);
    requireComponents(ctx, ["node", "gemini"]);
    const parsed = parseTaskArguments(args);
    const paths = runtimePaths(ctx.environment);
    const abort = new AbortController();
    const onSignal = (): void => abort.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
        const result = await runGeminiAcp({
            cwd: parsed.cwd,
            task: parsed.task,
            home: paths.geminiHome,
            binary: process.execPath,
            binaryArguments: [geminiEntrypoint(ctx)],
            signal: abort.signal,
        });
        process.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
        return 0;
    }
    finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
    }
}
async function antigravityTask(ctx: CliContext, args: readonly string[], fixedModel?: string): Promise<number> {
    assertNoApiKeySelectors(ctx.environment);
    requireComponents(ctx, ["antigravity"]);
    let model = fixedModel;
    const taskArguments: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--model") {
            const value = args[index + 1];
            if (value === undefined)
                throw new RouterError("invalid_request", "--model requires an exact model ID.", 400);
            if (fixedModel !== undefined && value !== fixedModel) {
                throw new RouterError("invalid_request", "The command has a fixed Antigravity model.", 400);
            }
            model = value;
            index += 1;
        }
        else {
            taskArguments.push(argument ?? "");
        }
    }
    if (model === undefined) {
        throw new RouterError("invalid_request", "Antigravity requires --model.", 400);
    }
    const parsed = parseTaskArguments(taskArguments);
    const abort = new AbortController();
    const onSignal = (): void => abort.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
        const result = await runAntigravityHeadless({
            binary: antigravityBinary(ctx),
            cwd: parsed.cwd,
            prompt: parsed.task,
            model,
            environment: ctx.environment,
            signal: abort.signal,
        });
        process.stdout.write(result.response.endsWith("\n") ? result.response : `${result.response}\n`);
        return 0;
    }
    finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
    }
}
async function grokTask(ctx: CliContext, args: readonly string[]): Promise<number> {
    assertNoApiKeySelectors(ctx.environment);
    requireComponents(ctx, ["grok"]);
    const parsed = parseTaskArguments(args);
    const paths = runtimePaths(ctx.environment);
    const binary = expandLockedPath(ctx.installLock.grok.executable, ctx.environment);
    const abort = new AbortController();
    const onSignal = (): void => abort.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
        const catalog = await inspectGrokModels({
            binary,
            home: paths.grokHome,
            cwd: parsed.cwd,
            environment: ctx.environment,
            signal: abort.signal,
        });
        const selected = verifiedGrok46CatalogEntry(catalog);
        if (selected === undefined) {
            throw new RouterError("model_not_available", `The OAuth catalog does not expose ${GROK_46_MODEL_ID} with its reviewed ${GROK_46_CONTEXT_WINDOW_TOKENS}-token contract.`, 404);
        }
        const result = await runGrokAcp({
            binary,
            home: paths.grokHome,
            cwd: parsed.cwd,
            task: parsed.task,
            model: selected.id,
            environment: ctx.environment,
            signal: abort.signal,
        });
        process.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
        return 0;
    }
    finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
    }
}
async function receipt(ctx: CliContext): Promise<number> {
    const last = await new ReceiptStore(runtimePaths(ctx.environment).receipts).last();
    printJson(last ?? { status: "none" });
    return 0;
}
function help(): void {
    process.stdout.write([
        "claude-oauth [claude arguments]",
        "claude-oauth doctor [--live] [--require-all]",
        "claude-oauth auth login <claude|openai|xai|google|gemini>",
        "claude-oauth models refresh [--allow-shrink]",
        "claude-oauth receipt",
        "claude-oauth gemini --task <task> [--cwd <path>]",
        "claude-oauth opus-google --task <task> [--cwd <path>]",
        "claude-oauth antigravity --model <gemini-3.8-flash-high|claude-opus-4-6-thinking> --task <task> [--cwd <path>]",
        "claude-oauth grok --task <task> [--cwd <path>]",
        "claude-oauth gemini-acp --task <task> [--cwd <path>]",
        "",
    ].join("\n"));
}
async function main(): Promise<number> {
    const { entrypoint, args } = resolveEntrypoint(process.argv.slice(2), process.env);
    if (entrypoint === "claude") {
        if (isNativeClaudeCommand(args))
            return await launchNativeClaudeCommand(args);
        return await launchClaudeOAuth({ args, cwd: process.cwd() });
    }
    if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
        help();
        return 0;
    }
    const command = args[0];
    if (!["doctor", "auth", "models", "receipt", "gemini", "opus-google", "antigravity", "grok", "gemini-acp"].includes(command ?? "")) {
        return await launchClaudeOAuth({ args, cwd: process.cwd() });
    }
    const ctx = command === "doctor" ? await diagnosticContext() : await context();
    if (command === "doctor")
        return await doctor(ctx, args.slice(1));
    if (command === "auth") {
        if (args[1] !== "login" || args.length !== 3) {
            throw new RouterError("invalid_request", "Usage: claude-oauth auth login <provider>.", 400);
        }
        return await authLogin(ctx, args[2] as string);
    }
    if (command === "models") {
        const allowShrink = args.includes("--allow-shrink");
        const refreshArguments = args.filter((argument) => argument !== "--allow-shrink");
        if (refreshArguments[1] !== "refresh" || refreshArguments.length !== 2) {
            throw new RouterError("invalid_request", "Usage: claude-oauth models refresh [--allow-shrink].", 400);
        }
        return await refreshModels(ctx, allowShrink);
    }
    if (command === "receipt") {
        if (args.length !== 1)
            throw new RouterError("invalid_request", "Usage: claude-oauth receipt.", 400);
        return await receipt(ctx);
    }
    if (command === "gemini") {
        return await antigravityTask(ctx, args.slice(1), "gemini-3.8-flash-high");
    }
    if (command === "opus-google") {
        return await antigravityTask(ctx, args.slice(1), "claude-opus-4-6-thinking");
    }
    if (command === "antigravity") {
        return await antigravityTask(ctx, args.slice(1));
    }
    if (command === "grok") {
        return await grokTask(ctx, args.slice(1));
    }
    return await geminiAcpTask(ctx, args.slice(1));
}
function redactedStackFrames(caught: unknown): readonly string[] {
    if (!(caught instanceof Error) || typeof caught.stack !== "string")
        return [];
    const home = homedir();
    return caught.stack
        .split("\n")
        .filter((line) => /^\s*at\s/u.test(line))
        .slice(0, 8)
        .map((line) => line.trim().split(home).join("~"));
}
void main()
    .then((exitCode) => {
    process.exitCode = exitCode;
})
    .catch((caught: unknown) => {
    const error = normalizeRouterError(caught);
    writeSafeLog({
        event: "cli_fatal",
        level: "error",
        code: error.code,
        ...(caught instanceof Error ? { errorName: caught.name } : {}),
        stackFrames: redactedStackFrames(caught),
    });
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })}\n`);
    process.exitCode = 1;
});
