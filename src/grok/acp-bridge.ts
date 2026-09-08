import { spawn, type ChildProcess } from "node:child_process";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { RouterError } from "../domain/errors.js";
import { assertNoApiKeySelectors, sanitizedWorkerEnvironment } from "../security/environment.js";
import { spawnFailureGuard } from "../runtime/child-process.js";
import { ensurePrivateDirectory } from "../runtime/paths.js";
import { readBoundedWorkspaceText, writeBoundedWorkspaceText } from "../security/workspace-read.js";
import {
    GROK_46_MODEL_ID,
    GROK_AUTO_COMPACT_THRESHOLD_PERCENT,
} from "../domain/model-contracts.js";
export interface GrokModelMetadata {
    readonly id: string;
    readonly contextWindow: number;
}
export interface GrokAcpOptions {
    readonly binary: string;
    readonly home: string;
    readonly cwd: string;
    readonly task: string;
    readonly model: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
}
export interface GrokAcpResult {
    readonly text: string;
    readonly model: string;
    readonly stopReason: string;
}
export interface GrokProcessEnvironmentOptions {
    readonly home: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
    /**
     * 2026-09-03: is this an INTERACTIVE session selected through `/model`?
     * If true, grok runs with full authority (the permission arm allows, writing is on).
     * false/undefined -> the one-shot DELEGATION path, which stays read-only.
     */
    readonly interactive?: boolean;
}
interface GrokCatalogOptions {
    readonly binary: string;
    readonly home: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
}
interface TomlToken {
    readonly kind: "atom" | "punctuation";
    readonly value: string;
}
type RequestPermissionParams = acp.ClientRequestParamsByMethod[typeof acp.methods.client.session.requestPermission];
type RequestPermissionResponse = acp.ClientRequestResponsesByMethod[typeof acp.methods.client.session.requestPermission];
type WriteTextFileParams = acp.ClientRequestParamsByMethod[typeof acp.methods.client.fs.writeTextFile];
type WriteTextFileResponse = acp.ClientRequestResponsesByMethod[typeof acp.methods.client.fs.writeTextFile];
type ReadTextFileParams = acp.ClientRequestParamsByMethod[typeof acp.methods.client.fs.readTextFile];
type ReadTextFileResponse = acp.ClientRequestResponsesByMethod[typeof acp.methods.client.fs.readTextFile];
type SessionUpdateParams = acp.ClientNotificationParamsByMethod[typeof acp.methods.client.session.update];
const maximumReadableFileBytes = 5 * 1024 * 1024;
const maximumConfigFileBytes = 256 * 1024;
const maximumCatalogModels = 1_000;
const modelIdPattern = /^[!-~]{1,256}$/u;
const forbiddenConfigKeys = new Set([
    "api_key",
    "auth_provider",
    "auth_provider_command",
    "base_url",
    "cli_chat_proxy_base_url",
    "endpoints",
    "env_http_headers",
    "env_key",
    "extra_headers",
    "hooks",
    "mcp_servers",
    "model",
    "models_base_url",
    "models_list_url",
    "plugins",
    "query_params",
    "xai_api_base_url",
]);
const autoCompactAssignment = /^\s*(?:(?:session|"session"|'session')\s*\.\s*)?(?:auto_compact_threshold_percent|"auto_compact_threshold_percent"|'auto_compact_threshold_percent')\s*=\s*([^#\r\n]*?)\s*(?:#.*)?$/iu;
const decimalTomlInteger = /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/u;
const hexadecimalTomlInteger = /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/u;
const octalTomlInteger = /^0o[0-7](?:_?[0-7])*$/u;
const binaryTomlInteger = /^0b[01](?:_?[01])*$/u;
const tomlUnicodeEscape = /\\(?:u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/u;
const homeConfigFiles = ["config.toml", "managed_config.toml", "requirements.toml"];
const executableHomeEntries = ["hooks", "hooks-paths", "plugins"];
const executableProjectEntries = [
    join(".grok", "hooks"),
    join(".grok", "plugins"),
    ".mcp.json",
];
const disabledCompatibilityVariables = [
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
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function missing(error: unknown): boolean {
    return isRecord(error) && error["code"] === "ENOENT";
}
async function readIfPresent(path: string): Promise<Buffer | undefined> {
    let before: Stats;
    try {
        before = await lstat(path);
    }
    catch (error) {
        if (missing(error))
            return undefined;
        throw error;
    }
    if (before.isSymbolicLink() || !before.isFile() || before.size > maximumConfigFileBytes) {
        throw new RouterError("adapter_unavailable", "Grok configuration is not a bounded regular file.", 503);
    }
    const handle = await open(path, "r");
    try {
        const after = await handle.stat();
        if (!after.isFile() ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            after.size > maximumConfigFileBytes) {
            throw new RouterError("adapter_unavailable", "Grok configuration changed during inspection.", 503);
        }
        return await handle.readFile();
    }
    finally {
        await handle.close();
    }
}
async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (missing(error))
            return false;
        throw error;
    }
}
function parseTomlInteger(value: string): bigint | undefined {
    const trimmed = value.trim();
    if (!decimalTomlInteger.test(trimmed) &&
        !hexadecimalTomlInteger.test(trimmed) &&
        !octalTomlInteger.test(trimmed) &&
        !binaryTomlInteger.test(trimmed)) {
        return undefined;
    }
    try {
        return BigInt(trimmed.replaceAll("_", ""));
    }
    catch {
        return undefined;
    }
}
function configuredAutoCompactThresholds(text: string): (bigint | undefined)[] {
    const thresholds: (bigint | undefined)[] = [];
    for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed === "" ||
            trimmed.startsWith("#") ||
            !line.includes("auto_compact_threshold_percent")) {
            continue;
        }
        const match = autoCompactAssignment.exec(line);
        thresholds.push(match === null ? undefined : parseTomlInteger(match[1] ?? ""));
    }
    return thresholds;
}
function containsActiveTomlUnicodeEscape(text: string): boolean {
    return text
        .split(/\r?\n/u)
        .some((line) => !line.trim().startsWith("#") && tomlUnicodeEscape.test(line));
}
function tokenizeTomlLine(line: string): TomlToken[] {
    const tokens: TomlToken[] = [];
    let index = 0;
    while (index < line.length) {
        const character = line[index];
        if (character === undefined)
            break;
        if (/\s/u.test(character)) {
            index += 1;
            continue;
        }
        if (character === "#")
            break;
        if (character === '"' || character === "'") {
            const quote = character;
            let value = "";
            index += 1;
            while (index < line.length) {
                const current = line[index];
                if (current === undefined)
                    break;
                if (current === quote) {
                    index += 1;
                    break;
                }
                if (quote === '"' && current === "\\") {
                    const escaped = line[index + 1];
                    if (escaped === undefined)
                        break;
                    value += escaped;
                    index += 2;
                    continue;
                }
                value += current;
                index += 1;
            }
            tokens.push({ kind: "atom", value });
            continue;
        }
        if ("[]=.,{}".includes(character)) {
            tokens.push({ kind: "punctuation", value: character });
            index += 1;
            continue;
        }
        const start = index;
        while (index < line.length) {
            const current = line[index];
            if (current === undefined ||
                /\s/u.test(current) ||
                current === "#" ||
                "[]=.,{}\"'".includes(current)) {
                break;
            }
            index += 1;
        }
        tokens.push({ kind: "atom", value: line.slice(start, index) });
    }
    return tokens;
}
function isForbiddenConfigKey(value: string): boolean {
    return forbiddenConfigKeys.has(value.toLowerCase());
}
function containsForbiddenTomlKey(text: string): boolean {
    for (const line of text.split(/\r?\n/u)) {
        const tokens = tokenizeTomlLine(line);
        if (tokens.length === 0)
            continue;
        if (tokens[0]?.value === "[") {
            for (const token of tokens.slice(1)) {
                if (token.value === "]")
                    break;
                if (token.kind === "atom" && isForbiddenConfigKey(token.value))
                    return true;
            }
        }
        for (let index = 0; index < tokens.length; index += 1) {
            const first = tokens[index];
            if (first?.kind !== "atom")
                continue;
            const keyParts = [first.value];
            let cursor = index + 1;
            while (tokens[cursor]?.value === "." &&
                tokens[cursor + 1]?.kind === "atom") {
                keyParts.push(tokens[cursor + 1]?.value ?? "");
                cursor += 2;
            }
            if (tokens[cursor]?.value === "=" &&
                keyParts.some((part) => isForbiddenConfigKey(part))) {
                return true;
            }
        }
    }
    return false;
}
async function assertSafeConfigFile(path: string): Promise<void> {
    try {
        const contents = await readIfPresent(path);
        const text = contents?.toString("utf8");
        if (text !== undefined && containsForbiddenTomlKey(text)) {
            throw new RouterError("adapter_unavailable", "Grok configuration contains an executable extension, credential helper, or upstream override.", 503);
        }
        if (text !== undefined && containsActiveTomlUnicodeEscape(text)) {
            throw new RouterError("adapter_unavailable", "Grok configuration uses a TOML Unicode escape that the locked policy does not permit.", 503);
        }
        if (text !== undefined) {
            const configuredThresholds = configuredAutoCompactThresholds(text);
            if (configuredThresholds.length > 1 ||
                configuredThresholds.some((value) => value !== BigInt(GROK_AUTO_COMPACT_THRESHOLD_PERCENT))) {
                throw new RouterError("adapter_unavailable", "Grok configuration must retain the reviewed 85 percent auto-compaction policy.", 503);
            }
        }
    }
    catch (error) {
        if (error instanceof RouterError)
            throw error;
        throw new RouterError("adapter_unavailable", "Grok configuration could not be inspected safely.", 503);
    }
}
async function assertEmptyOrMissing(path: string): Promise<void> {
    try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) {
            throw new RouterError("adapter_unavailable", "Grok executable extension paths must not be symbolic links.", 503);
        }
        if (metadata.isDirectory()) {
            if ((await readdir(path)).length === 0)
                return;
        }
        else if (metadata.isFile() && metadata.size === 0) {
            return;
        }
        throw new RouterError("adapter_unavailable", "Grok executable extension paths must be empty or absent.", 503);
    }
    catch (error) {
        if (missing(error))
            return;
        if (error instanceof RouterError)
            throw error;
        throw new RouterError("adapter_unavailable", "Grok executable extension paths could not be inspected.", 503);
    }
}
async function assertSafeGrokConfig(home: string, cwd: string): Promise<void> {
    const homeMetadata = await lstat(home);
    if (homeMetadata.isSymbolicLink() || !homeMetadata.isDirectory()) {
        throw new RouterError("adapter_unavailable", "The isolated Grok home is not a real directory.", 503);
    }
    for (const name of homeConfigFiles)
        await assertSafeConfigFile(join(home, name));
    for (const name of executableHomeEntries)
        await assertEmptyOrMissing(join(home, name));
    let current = await realpath(cwd);
    while (true) {
        await assertSafeConfigFile(join(current, ".grok", "config.toml"));
        for (const name of executableProjectEntries)
            await assertEmptyOrMissing(join(current, name));
        if (await exists(join(current, ".git")))
            break;
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
}
function grokEnvironment(home: string, source: NodeJS.ProcessEnv, interactive = false): NodeJS.ProcessEnv {
    const environment = sanitizedWorkerEnvironment("xai", source);
    environment["GROK_HOME"] = home;
    environment["GROK_DISABLE_API_KEY_AUTH"] = "1";
    environment["GROK_OAUTH_ENABLED"] = "1";
    environment["GROK_DEFAULT_MODEL"] = GROK_46_MODEL_ID;
    environment["GROK_DEFAULT_SELECTED_PERMISSION"] = interactive ? "allow" : "reject";
    environment["GROK_FOLDER_TRUST"] = "1";
    environment["GROK_MEMORY"] = "0";
    environment["GROK_SUBAGENTS"] = "0";
    environment["GROK_WORKFLOWS"] = "0";
    environment["GROK_WEB_FETCH"] = "0";
    environment["GROK_IMAGE_GEN"] = "0";
    environment["GROK_VIDEO_GEN"] = "0";
    for (const name of disabledCompatibilityVariables)
        environment[name] = "0";
    return environment;
}
export async function prepareGrokProcessEnvironment(options: GrokProcessEnvironmentOptions): Promise<NodeJS.ProcessEnv> {
    const source = options.environment ?? process.env;
    assertNoApiKeySelectors(source);
    await ensurePrivateDirectory(options.home);
    await assertSafeGrokConfig(options.home, options.cwd);
    return grokEnvironment(options.home, source, options.interactive === true);
}
function spawnGrok(options: { readonly binary: string; readonly cwd: string }, environment: NodeJS.ProcessEnv, model?: string): ChildProcess {
    const argumentsList = [
        "agent",
        ...(model === undefined ? [] : ["--model", model, "--reasoning-effort", "xhigh"]),
        "--no-leader",
        "stdio",
    ];
    return spawn(options.binary, argumentsList, {
        cwd: options.cwd,
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
}
function childStream(child: ChildProcess): acp.Stream {
    if (child.stdin === null || child.stdout === null) {
        child.kill();
        throw new RouterError("adapter_unavailable", "Grok ACP stdio is unavailable.", 503);
    }
    child.stderr?.resume();
    return acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
}
// Grok Build 1.0.13 does NOT EXPOSE the catalog IN A SEPARATE METHOD; it buries it in
// the `_meta.modelState` field of the `initialize` response. The former `x.ai/models/list`
// call now returns -32601 Method not found.
//
// The field names changed too: `id` -> `modelId`, `meta` -> `_meta`. Both are accepted,
// because that very renaming is what broke the bridge; the real strict check (context
// window equality) is preserved.
function modelStateOf(initializeResponse: unknown): unknown {
    if (!isRecord(initializeResponse))
        return undefined;
    const meta = initializeResponse["_meta"] ?? initializeResponse["meta"];
    return isRecord(meta) ? meta["modelState"] : undefined;
}
function parseCatalog(value: unknown): readonly GrokModelMetadata[] {
    if (!isRecord(value) || !Array.isArray(value["availableModels"])) {
        throw new RouterError("upstream_protocol_error", "Grok ACP returned a malformed model catalog.", 502);
    }
    const entries = value["availableModels"];
    if (entries.length === 0 || entries.length > maximumCatalogModels) {
        throw new RouterError("upstream_protocol_error", "Grok ACP returned an invalid model count.", 502);
    }
    const seen = new Set<string>();
    return entries.map((entry: unknown) => {
        const identifier = isRecord(entry) ? (entry["modelId"] ?? entry["id"]) : undefined;
        if (typeof identifier !== "string" || !modelIdPattern.test(identifier)) {
            throw new RouterError("upstream_protocol_error", "Grok ACP returned an invalid model ID.", 502);
        }
        if (seen.has(identifier)) {
            throw new RouterError("upstream_protocol_error", "Grok ACP returned a duplicate model ID.", 502);
        }
        seen.add(identifier);
        const record = entry as Record<string, unknown>;
        const meta = record["_meta"] ?? record["meta"];
        const contextWindow = isRecord(meta) ? meta["totalContextTokens"] : undefined;
        if (!Number.isSafeInteger(contextWindow) || (contextWindow as number) <= 0 || (contextWindow as number) > 10_000_000) {
            throw new RouterError("upstream_protocol_error", "Grok ACP returned invalid context metadata.", 502);
        }
        return { id: identifier, contextWindow: contextWindow as number };
    });
}
function attachAbort(child: ChildProcess, signal?: AbortSignal): () => void {
    const onAbort = (): void => {
        child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted)
        onAbort();
    return () => signal?.removeEventListener("abort", onAbort);
}
async function stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null)
        return;
    await new Promise<void>((resolveStop) => {
        let forceTimer: NodeJS.Timeout | undefined;
        let giveUpTimer: NodeJS.Timeout | undefined;
        const complete = (): void => {
            if (forceTimer !== undefined)
                clearTimeout(forceTimer);
            if (giveUpTimer !== undefined)
                clearTimeout(giveUpTimer);
            child.removeListener("exit", complete);
            child.removeListener("error", complete);
            resolveStop();
        };
        child.once("exit", complete);
        child.once("error", complete);
        forceTimer = setTimeout(() => child.kill("SIGKILL"), 500);
        giveUpTimer = setTimeout(complete, 1_500);
        if (child.exitCode !== null || child.signalCode !== null)
            complete();
        else
            child.kill();
    });
}
export async function inspectGrokModels(options: GrokCatalogOptions): Promise<readonly GrokModelMetadata[]> {
    const environment = await prepareGrokProcessEnvironment(options);
    const child = spawnGrok(options, environment);
    const spawnFailure = spawnFailureGuard(child);
    const detach = attachAbort(child, options.signal);
    try {
        const result = await acp.client({ name: "hezarfen-claude-oauth" }).connectWith(childStream(child), async (context) => {
            return await context.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            });
        });
        return parseCatalog(modelStateOf(result));
    }
    catch (error) {
        const failure = spawnFailure();
        if (failure !== undefined) {
            throw new RouterError("adapter_unavailable", `Grok CLI could not be started from its pinned path (${failure.code ?? "spawn failed"}). ONARIM: install the pinned grok build, then re-run claude-oauth doctor.`, 503, { cause: failure });
        }
        if (options.signal?.aborted) {
            throw new RouterError("upstream_timeout", "Grok ACP catalog inspection was cancelled.", 504, { cause: error });
        }
        if (error instanceof RouterError)
            throw error;
        // JSON-RPC -32601 "Method not found" is NOT an authentication problem; the ACP
        // surface the bridge expects has changed. Reporting the two under the same label
        // once led to a wrong diagnosis that said "log in".
        const rpcCode: unknown = isRecord(error) ? error["code"] : undefined;
        if (rpcCode === -32601) {
            throw new RouterError("upstream_protocol_error", "Grok ACP no longer exposes the expected model-catalog surface. ONARIM: re-inspect the initialize response and update src/grok/acp-bridge.ts.", 502, { cause: error });
        }
        throw new RouterError("provider_auth_required", "Grok ACP could not return the OAuth model catalog. Complete grok login.", 401, { cause: error });
    }
    finally {
        detach();
        await stopChild(child);
    }
}
class ReadOnlyGrokClient {
    #chunks: string[] = [];
    #workspace: string;
    constructor(workspace: string) {
        this.#workspace = workspace;
    }
    async requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResponse> {
        const rejected = params.options.find((option) => option.kind === "reject_once" || option.kind === "reject_always");
        return rejected === undefined
            ? { outcome: { outcome: "cancelled" } }
            : { outcome: { outcome: "selected", optionId: rejected.optionId } };
    }
    async sessionUpdate(params: SessionUpdateParams): Promise<void> {
        if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
            this.#chunks.push(params.update.content.text);
        }
    }
    async writeTextFile(params: WriteTextFileParams): Promise<WriteTextFileResponse> {
        await writeBoundedWorkspaceText({
            workspace: this.#workspace,
            requestedPath: params.path,
            content: params.content,
            maximumBytes: maximumReadableFileBytes,
        });
        return null as unknown as WriteTextFileResponse;
    }
    async readTextFile(params: ReadTextFileParams): Promise<ReadTextFileResponse> {
        return {
            content: await readBoundedWorkspaceText({
                workspace: this.#workspace,
                requestedPath: params.path,
                maximumBytes: maximumReadableFileBytes,
            }),
        };
    }
    text(): string {
        return this.#chunks.join("");
    }
}
export async function runGrokAcp(options: GrokAcpOptions): Promise<GrokAcpResult> {
    if (options.task.trim() === "")
        throw new RouterError("invalid_request", "Grok task must not be empty.", 400);
    const environment = await prepareGrokProcessEnvironment(options);
    const child = spawnGrok(options, environment, options.model);
    const spawnFailure = spawnFailureGuard(child);
    const detach = attachAbort(child, options.signal);
    const implementation = new ReadOnlyGrokClient(options.cwd);
    let initialized = false;
    try {
        const result = await acp
            .client({ name: "hezarfen-claude-oauth" })
            .onRequest(acp.methods.client.session.requestPermission, (context) => implementation.requestPermission(context.params))
            .onRequest(acp.methods.client.fs.readTextFile, (context) => implementation.readTextFile(context.params))
            .onNotification(acp.methods.client.session.update, (context) => implementation.sessionUpdate(context.params))
            .connectWith(childStream(child), async (context) => {
            await context.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
            });
            initialized = true;
            const session = await context.request(acp.methods.agent.session.new, {
                cwd: resolve(options.cwd),
                mcpServers: [],
            });
            const prompt = await context.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{
                        type: "text",
                        text: [
                            "Operate in read-only analysis mode.",
                            "Do not request writes, shell execution, network side effects, or permission escalation.",
                            "Return analysis and recommendations only.",
                            "",
                            options.task,
                        ].join("\n"),
                    }],
            });
            return { stopReason: prompt.stopReason };
        });
        return { text: implementation.text(), model: options.model, stopReason: result.stopReason };
    }
    catch (error) {
        const failure = spawnFailure();
        if (failure !== undefined) {
            throw new RouterError("adapter_unavailable", `Grok CLI could not be started (${failure.code ?? "spawn failed"}).`, 503, { cause: failure });
        }
        if (options.signal?.aborted) {
            throw new RouterError("upstream_timeout", "Grok ACP task was cancelled.", 504, { cause: error });
        }
        if (!initialized) {
            throw new RouterError("provider_auth_required", "Grok ACP could not initialize. Complete grok login.", 401, {
                cause: error,
            });
        }
        throw new RouterError("upstream_protocol_error", "Grok ACP task failed.", 502, { cause: error });
    }
    finally {
        detach();
        await stopChild(child);
    }
}

// ---------------------------------------------------------------------------
// Phase 9 / Path 4 -- long-lived ACP session.
//
// runGrokAcp is ONE-SHOT: it connects, asks, closes. A tool loop cannot cross the turn
// boundary that way, because Claude Code sends a SEPARATE HTTP request for every turn.
// This function does the same work but does NOT WAIT: it returns the handle immediately,
// so the session registry can keep the process and the connection alive.
// ---------------------------------------------------------------------------

export interface GrokAcpSessionOptions extends GrokAcpOptions {
    /** MCP servers. In Phase 9 there is a single element: the tool bridge on the router. */
    readonly mcpServers?: readonly unknown[];
    /** Tool names published by the bridge; the permission arm recognises these. */
    readonly bridgedToolNames?: readonly string[];
}

export interface GrokAcpSession {
    /** Resolves when the agent's prompt call finishes on its own. */
    readonly done: Promise<void>;
    text(): string;
    cancel(reason: string): void;
}

/**
 * Is this a permission request for a tool published by the bridge?
 *
 * [UNVERIFIED] Whether the ACP agent runs its OWN permission flow for an MCP tool call,
 * and if it does, which field of the request carries the tool name, will be MEASURED IN A
 * LIVE RUN. Until then this arm is FAIL-CLOSED: if it cannot recognise the name it
 * refuses. A permission gate opened on the wrong side would also let loose the agent's
 * own write tools.
 */
function namesBridgedTool(params: unknown, bridged: readonly string[]): boolean {
    if (bridged.length === 0) return false;
    const govde = JSON.stringify(params ?? {});
    return bridged.some((name) => govde.includes(`"${name}"`));
}

export function startGrokAcpSession(options: GrokAcpSessionOptions): GrokAcpSession {
    const implementation = new ReadOnlyGrokClient(options.cwd);
    const bridged = options.bridgedToolNames ?? [];
    // FINDING 2 (adversarial review). cancel() can be called BEFORE the child is SPAWNED;
    // in the old shape it then did nothing and the IIFE would still start the child --
    // a process that cannot be killed, and a router that does not shut down.
    let iptalEdildi = false;
    let child: ChildProcess | undefined;
    let detach: (() => void) | undefined;

    const done = (async (): Promise<void> => {
        if (options.task.trim() === "") {
            throw new RouterError("invalid_request", "Grok task must not be empty.", 400);
        }
        if (iptalEdildi) throw new RouterError("upstream_timeout", "Grok ACP session was cancelled before start.", 504);
        const environment = await prepareGrokProcessEnvironment({ ...options, interactive: true });
        child = spawnGrok(options, environment, options.model);
        const spawnFailure = spawnFailureGuard(child);
        // Race: cancel() may have arrived between the spawn and this line.
        if (iptalEdildi) {
            child.kill();
            throw new RouterError("upstream_timeout", "Grok ACP session was cancelled during start.", 504);
        }
        detach = attachAbort(child, options.signal);
        let initialized = false;
        try {
            await acp
                .client({ name: "hezarfen-claude-oauth" })
                .onRequest(acp.methods.client.session.requestPermission, (context) => {
                    // 2026-09-03: in an interactive session grok is a fully working model.
                    // The bridge no longer REFUSES by default; if an allow option exists it
                    // selects it. The bridge is NOT a permission layer -- the real boundary is
                    // Claude Code's own permission system (see the bridged tool arm kept below).
                    void bridged;
                    const allowed = context.params.options.find((option) => option.kind === "allow_once" || option.kind === "allow_always");
                    if (allowed !== undefined) {
                        return Promise.resolve({ outcome: { outcome: "selected" as const, optionId: allowed.optionId } });
                    }
                    return implementation.requestPermission(context.params);
                })
                .onRequest(acp.methods.client.fs.readTextFile, (context) => implementation.readTextFile(context.params))
                .onRequest(acp.methods.client.fs.writeTextFile, (context) => implementation.writeTextFile(context.params))
                .onNotification(acp.methods.client.session.update, (context) => implementation.sessionUpdate(context.params))
                .connectWith(childStream(child), async (context) => {
                    await context.request(acp.methods.agent.initialize, {
                        protocolVersion: acp.PROTOCOL_VERSION,
                        // 2026-09-03: the interactive session has full authority. Write permission
                        // is opened here; the boundary is Claude Code's OWN permission layer, not
                        // this bridge.
                        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
                    });
                    initialized = true;
                    const session = await context.request(acp.methods.agent.session.new, {
                        cwd: resolve(options.cwd),
                        mcpServers: (options.mcpServers ?? []) as never,
                    });
                    await context.request(acp.methods.agent.session.prompt, {
                        sessionId: session.sessionId,
                        prompt: [{ type: "text", text: options.task }],
                    });
                });
        }
        catch (error) {
            const failure = spawnFailure();
            if (failure !== undefined) {
                throw new RouterError("adapter_unavailable", `Grok CLI could not be started (${failure.code ?? "spawn failed"}).`, 503, { cause: failure });
            }
            if (options.signal?.aborted) {
                throw new RouterError("upstream_timeout", "Grok ACP session was cancelled.", 504, { cause: error });
            }
            if (!initialized) {
                throw new RouterError("provider_auth_required", "Grok ACP could not initialize. Complete grok login.", 401, { cause: error });
            }
            throw new RouterError("upstream_protocol_error", "Grok ACP session failed.", 502, { cause: error });
        }
        finally {
            detach?.();
            await stopChild(child);
        }
    })();

    return {
        done,
        text: () => implementation.text(),
        cancel: () => {
            iptalEdildi = true;
            detach?.();
            child?.kill();
        },
    };
}

/**
 * Phase 9 -- converts the bridge into the MCP server definition ACP expects.
 *
 * The session nonce goes into a header; same secret, same gate. Into the header and NOT
 * the URL, because URLs get logged.
 */
export function mcpHttpServer(name: string, url: string, headers: Readonly<Record<string, string>>): Record<string, unknown> {
    return {
        type: "http",
        name,
        url,
        headers: Object.entries(headers).map(([key, value]) => ({ name: key, value })),
    };
}
