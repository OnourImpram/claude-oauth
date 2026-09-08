import type { ProviderId } from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";
export const PROVIDER_API_KEY_VARIABLES = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "GROK_DEPLOYMENT_KEY",
    "GROK_ALPHA_TEST_KEY",
    "GROK_CODE_XAI_API_KEY",
    "GROK_AUTH_PROVIDER_COMMAND",
    "GROK_AUTH_PROVIDER_ACCESS_TOKEN",
    "GROK_AUTH_PROVIDER_REFRESH_TOKEN",
    "GROK_AUTH_PATH",
    "GROK_CONFIG",
    "GROK_CONFIG_PATH",
    "GROK_MANAGED_CONFIG",
    "GROK_OIDC_ISSUER",
    "GROK_OIDC_CLIENT_ID",
    "GROK_MODELS_BASE_URL",
    "GROK_MODELS_LIST_URL",
    "GROK_MODES_BASE_URL",
    "GROK_CLI_BASE_URL",
    "GROK_CLI_CHAT_PROXY_BASE_URL",
    "GROK_API_BASE_URL",
    "GROK_XAI_API_BASE_URL",
    "GROK_CODE_BACKEND_URL",
    "GROK_CODE_WEB_URL",
    "GROK_SKILLS_BASE_URL",
    "GROK_CONVERSATIONS_BASE_URL",
    "GROK_WORKSPACES_BASE_URL",
    "XAI_BASE_URL",
    "XAI_EXPLORER_SERVICE_URL",
    "GROK_WS_ORIGIN",
    "GROK_WS_URL",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_API_KEY",
    "GOOGLE_GEMINI_BASE_URL",
    "GOOGLE_VERTEX_BASE_URL",
    "GEMINI_CLI_CUSTOM_HEADERS",
    "GEMINI_API_KEY_AUTH_MECHANISM",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "VERTEXAI_PROJECT",
    "VERTEXAI_LOCATION",
    "AZURE_CLIENT_SECRET",
] as const;
const networkProxyVariables = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];
const launcherMetadataVariables = [
    "HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE",
    "HEZARFEN_CLAUDE_OAUTH_RELEASE_ID",
];
const grokRuntimeOverrides = [
    "GROK_AGENT_SECRET",
    "GROK_AGENT",
    "GROK_AUTH_PROVIDER_LABEL",
    "GROK_AUTH_PROVIDER_EXPIRES_AT",
    "GROK_AUTH_TOKEN_TTL",
    "GROK_DISABLE_API_KEY_AUTH",
    "GROK_DEBUG_CONTEXT_WINDOW",
    "GROK_DEFAULT_SELECTED_PERMISSION",
    "GROK_FOLDER_TRUST",
    "GROK_IMAGE_GEN",
    "GROK_LOCAL_AUTH",
    "GROK_MEMORY",
    "GROK_OAUTH_ENABLED",
    "GROK_SANDBOX",
    "GROK_SUBAGENTS",
    "GROK_VIDEO_GEN",
    "GROK_WEB_FETCH",
    "GROK_WEB_FETCH_ALLOW_LOCAL",
    "GROK_WEB_FETCH_PROXY",
    "GROK_WORKFLOWS",
    "GROK_CLAUDE_SKILLS_ENABLED",
    "GROK_CLAUDE_RULES_ENABLED",
    "GROK_CLAUDE_AGENTS_ENABLED",
    "GROK_CLAUDE_MCPS_ENABLED",
    "GROK_CLAUDE_HOOKS_ENABLED",
    "GROK_CLAUDE_SESSIONS_ENABLED",
    "GROK_CURSOR_SKILLS_ENABLED",
    "GROK_CURSOR_RULES_ENABLED",
    "GROK_CURSOR_AGENTS_ENABLED",
    "GROK_CURSOR_MCPS_ENABLED",
    "GROK_CURSOR_HOOKS_ENABLED",
    "GROK_CURSOR_SESSIONS_ENABLED",
    "GROK_CODEX_SKILLS_ENABLED",
    "GROK_CODEX_RULES_ENABLED",
    "GROK_CODEX_AGENTS_ENABLED",
    "GROK_CODEX_MCPS_ENABLED",
    "GROK_CODEX_HOOKS_ENABLED",
    "GROK_CODEX_SESSIONS_ENABLED",
];
const telemetryCredentialVariables = [
    "GROK_TELEMETRY_BUILD_EVENTS_API_KEY",
    "GROK_TELEMETRY_BUILD_EVENTS_URL",
    "GROK_TELEMETRY_BUILD_MIXPANEL_TOKEN",
    "GROK_TELEMETRY_EVENTS_API_KEY",
    "GROK_TELEMETRY_EVENTS_URL",
    "GROK_TELEMETRY_MIXPANEL_TOKEN",
    "GROK_TELEMETRY_TRACE_UPLOAD",
    "OTEL_EXPORTER_OTLP_HEADERS",
];
const cloudProviderVariables = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "CLOUD_ML_REGION",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAT_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
];
const clodexRuntimeOverrides = [
    "CLODEX_CREDENTIAL_HELPER",
    "CLODEX_OAUTH_ACCOUNT",
    "CLODEX_LOG_REQUEST_PREVIEW",
    "CLODEX_MISMATCH_DUMP",
    "CLODEX_TRACE",
    "CLODEX_SERVICE_TIER",
    "CLODEX_UPSTREAM_MAX_RETRIES",
    // The endpoint added in clodex 2.11.1 (measured 2026-09-05: 0 occurrences in the 2.8.2
    // bundle). An override introduced by a new version, if it is not added to the strip list
    // in the same pass, is silently inherited from the working session: the claim of a
    // hygienic environment is left unmeasured.
    "CLODEX_UPSTREAM_IDLE_TIMEOUT_MS",
    "CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS",
    "CLODEX_WS_MAX_NEW_CONNECTIONS_PER_MIN",
];
function isClodexKeySelector(name: string): boolean {
    return /^CLODEX_KEY_[A-Z0-9_]+$/iu.test(name);
}
function normalizedEnvironmentName(name: string): string {
    return name.toUpperCase();
}
function environmentValue(environment: NodeJS.ProcessEnv, expectedName: string): string | undefined {
    const expected = normalizedEnvironmentName(expectedName);
    const actual = Object.keys(environment).find((name) => normalizedEnvironmentName(name) === expected);
    return actual === undefined ? undefined : environment[actual];
}
function deleteEnvironmentNames(environment: NodeJS.ProcessEnv, names: readonly string[]): void {
    const blocked = new Set(names.map(normalizedEnvironmentName));
    for (const actual of Object.keys(environment)) {
        if (blocked.has(normalizedEnvironmentName(actual)))
            delete environment[actual];
    }
}
export function presentApiKeySelectors(environment: NodeJS.ProcessEnv): readonly string[] {
    const fixedNames = new Set(PROVIDER_API_KEY_VARIABLES.map(normalizedEnvironmentName));
    const fixed = Object.keys(environment).filter((name) => {
        const value = environment[name];
        return fixedNames.has(normalizedEnvironmentName(name)) && value !== undefined && value.trim() !== "";
    });
    const dynamic = Object.keys(environment).filter((name) => {
        const value = environment[name];
        return isClodexKeySelector(name) && value !== undefined && value.trim() !== "";
    });
    return [...new Set([...fixed, ...dynamic])].sort();
}
export function assertNoApiKeySelectors(environment: NodeJS.ProcessEnv): void {
    const present = presentApiKeySelectors(environment);
    if (present.length > 0) {
        throw new RouterError("adapter_unavailable", `Provider API-key selectors are active: ${present.join(", ")}. OAuth-only readiness failed.`, 503);
    }
}
export function sanitizedWorkerEnvironment(provider: ProviderId | "gemini", source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const result = { ...source };
    deleteEnvironmentNames(result, [...PROVIDER_API_KEY_VARIABLES, ...cloudProviderVariables]);
    deleteEnvironmentNames(result, [...networkProxyVariables, ...grokRuntimeOverrides]);
    deleteEnvironmentNames(result, telemetryCredentialVariables);
    deleteEnvironmentNames(result, launcherMetadataVariables);
    for (const name of Object.keys(result)) {
        if (isClodexKeySelector(name))
            delete result[name];
    }
    deleteEnvironmentNames(result, clodexRuntimeOverrides);
    deleteEnvironmentNames(result, [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "GEMINI_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ]);
    result["HEZARFEN_OAUTH_PROVIDER"] = provider;
    return result;
}
export function sanitizedClaudeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const preservedOatToken = environmentValue(source, "ANTHROPIC_OAT_TOKEN");
    const result = sanitizedWorkerEnvironment("anthropic", source);
    delete result["HEZARFEN_OAUTH_PROVIDER"];
    if (preservedOatToken !== undefined)
        result["ANTHROPIC_OAT_TOKEN"] = preservedOatToken;
    return result;
}
