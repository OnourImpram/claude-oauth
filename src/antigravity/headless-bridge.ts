import { spawn } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RouterError } from "../domain/errors.js";
import { AGENT_MODEL_CONTRACTS } from "../domain/model-contracts.js";
import { assertNoApiKeySelectors, sanitizedWorkerEnvironment } from "../security/environment.js";
// The allowlist is a SECURITY control: only reviewed models may be spawned. But writing
// the list by hand silently left a model out whenever one was added to the contracts --
// and because the error code presented that as Google's own refusal
// ("model_not_available"), the diagnosis blamed the wrong layer.
// The reviewed set is already AGENT_MODEL_CONTRACTS; the list is derived from it, so the
// control is preserved but drift becomes impossible.
export const antigravityAllowedModels: readonly string[] = AGENT_MODEL_CONTRACTS
    .filter((contract) => contract.provider === "google")
    .map((contract) => contract.upstreamModel);
type AntigravityModel = string;
export interface HeadlessProcessRequest {
    readonly command: string;
    readonly arguments: readonly string[];
    readonly input: string;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly maximumOutputBytes: number;
    readonly signal?: AbortSignal;
    readonly shell: false;
    readonly windowsHide: true;
}
export interface HeadlessProcessOutput {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}
export type AntigravityProcessRunner = (request: HeadlessProcessRequest) => Promise<HeadlessProcessOutput>;
export interface AntigravityHeadlessOptions {
    /** If true, agy becomes a fully working agent (accept-edits); the delegation lane leaves it false. */
    readonly allowEdits?: boolean;
    readonly binary: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly model: string;
    readonly home?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly processRunner?: AntigravityProcessRunner;
}
export interface AntigravityHeadlessResult {
    readonly response: string;
    readonly model: AntigravityModel;
    readonly usage?: Readonly<Record<string, number>>;
}
interface TerminalResult {
    readonly status: string;
    readonly response: string;
    readonly error?: string;
    readonly usage?: Readonly<Record<string, number>>;
}
const requiredUsageFields = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"];
const defaultTimeoutMs = 300_000;
const maximumTimeoutMs = 600_000;
const maximumOutputBytes = 8 * 1024 * 1024;
const maximumInputBytes = 32 * 1024 * 1024;
const maximumSettingsBytes = 256 * 1024;
const antigravitySelectorPattern = /^(?:AGY|ANTIGRAVITY|GEMINI|GOOGLE|GOOGLE_GENAI)_(?:API_?KEY|API_?ENDPOINT|BASE_?URL|ENDPOINT|GATEWAY(?:_URL)?|PROXY(?:_URL)?)$/iu;
const genericEndpointSelectors = [
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "XAI_BASE_URL",
    "GROK_API_BASE_URL",
];
function isGenericEndpointSelector(name: string): boolean {
    const normalized = name.toUpperCase();
    return genericEndpointSelectors.includes(normalized);
}
function isAllowedModel(model: string): model is AntigravityModel {
    return antigravityAllowedModels.includes(model);
}
export function activeCustomSelectors(environment: NodeJS.ProcessEnv): string[] {
    return Object.keys(environment)
        .filter((name) => {
        const value = environment[name];
        return value !== undefined && value.trim() !== "" && (antigravitySelectorPattern.test(name) || isGenericEndpointSelector(name));
    })
        .sort();
}
// Only the antigravity/Google key-and-endpoint selectors are blocking: if the operator has
// pointed agy at an API key, OAuth-only readiness must drop. The generic endpoint selectors
// (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, XAI_*) are other providers' variables;
// processEnvironment() already strips them from the child. The ANTHROPIC_BASE_URL the
// launcher gives its own child is inherited by the router in a nested session -- counting
// that as blocking turned every google request into adapter_unavailable (measured
// 2026-09-02). activeCustomSelectors stays for reporting.
export function blockingCustomSelectors(environment: NodeJS.ProcessEnv): string[] {
    return activeCustomSelectors(environment).filter((name) => antigravitySelectorPattern.test(name));
}
function assertNoCustomSelectors(environment: NodeJS.ProcessEnv): void {
    const selectors = blockingCustomSelectors(environment);
    if (selectors.length > 0) {
        throw new RouterError("adapter_unavailable", `Antigravity API-key or custom endpoint selectors are active: ${selectors.join(", ")}. OAuth-only readiness failed.`, 503);
    }
}
async function assertSettingsDoNotSelectGemini(home: string): Promise<void> {
    const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
    let before: Stats;
    try {
        before = await lstat(settingsPath);
    }
    catch (error) {
        if (isMissingFile(error))
            return;
        throw new RouterError("adapter_unavailable", "Antigravity settings could not be read safely.", 503);
    }
    if (before.isSymbolicLink() || !before.isFile() || before.size > maximumSettingsBytes) {
        throw new RouterError("adapter_unavailable", "Antigravity settings are not a bounded regular file.", 503);
    }
    let handle: FileHandle;
    try {
        handle = await open(settingsPath, "r");
    }
    catch {
        throw new RouterError("adapter_unavailable", "Antigravity settings could not be opened safely.", 503);
    }
    let contents: string;
    try {
        const after = await handle.stat();
        if (!after.isFile() ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            after.size > maximumSettingsBytes) {
            throw new RouterError("adapter_unavailable", "Antigravity settings changed during inspection.", 503);
        }
        contents = (await handle.readFile()).toString("utf8");
    }
    finally {
        await handle.close();
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    }
    catch {
        throw new RouterError("adapter_unavailable", "Antigravity settings could not be parsed safely.", 503);
    }
    if (isRecord(parsed) &&
        typeof parsed["modelProvider"] === "string" &&
        parsed["modelProvider"].toLowerCase() === "gemini") {
        throw new RouterError("adapter_unavailable", "Antigravity settings select the Gemini model provider. OAuth-only readiness failed.", 503);
    }
    if (containsActiveCustomSelector(parsed)) {
        throw new RouterError("adapter_unavailable", "Antigravity settings contain an active API-key or custom endpoint selector.", 503);
    }
}
function containsActiveCustomSelector(value: unknown, depth = 0): boolean {
    if (depth > 32)
        return true;
    if (Array.isArray(value))
        return value.some((entry: unknown) => containsActiveCustomSelector(entry, depth + 1));
    if (!isRecord(value))
        return false;
    for (const [name, entry] of Object.entries(value)) {
        if (/^(?:api_?key|api_?endpoint|base_?url|endpoint|gateway(?:_url)?|proxy(?:_url)?)$/iu.test(name) &&
            entry !== undefined &&
            entry !== null &&
            entry !== false &&
            entry !== "") {
            return true;
        }
        if (containsActiveCustomSelector(entry, depth + 1))
            return true;
    }
    return false;
}
function isMissingFile(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseResponse(stdout: string): TerminalResult {
    let result: Record<string, unknown> | undefined;
    for (const line of stdout.split(/\r?\n/u).filter((entry) => entry.trim() !== "")) {
        let event: unknown;
        try {
            event = JSON.parse(line);
        }
        catch {
            throw new RouterError("upstream_protocol_error", "Antigravity returned invalid NDJSON output.", 502);
        }
        if (!isRecord(event) || typeof event["event"] !== "string") {
            throw new RouterError("upstream_protocol_error", "Antigravity returned an invalid stream event.", 502);
        }
        if (event["event"] !== "result")
            continue;
        if (result !== undefined || !isRecord(event["result"])) {
            throw new RouterError("upstream_protocol_error", "Antigravity returned an invalid terminal result event.", 502);
        }
        result = event["result"];
    }
    if (result === undefined || typeof result["status"] !== "string" || typeof result["response"] !== "string") {
        throw new RouterError("upstream_protocol_error", "Antigravity stream is missing a terminal response.", 502);
    }
    const error = result["error"];
    if (error !== undefined && typeof error !== "string") {
        throw new RouterError("upstream_protocol_error", "Antigravity stream has an invalid terminal error.", 502);
    }
    const usage = parseUsage(result["usage"]);
    return {
        status: result["status"],
        response: result["response"],
        ...(error === undefined ? {} : { error }),
        ...(usage === undefined ? {} : { usage }),
    };
}
function parseUsage(value: unknown): Record<string, number> | undefined {
    if (value === undefined)
        return undefined;
    if (!isRecord(value) || Object.keys(value).length !== requiredUsageFields.length) {
        throw new RouterError("upstream_protocol_error", "Antigravity JSON output has invalid usage.", 502);
    }
    const usage: Record<string, number> = {};
    for (const name of requiredUsageFields) {
        const field = value[name];
        if (typeof field !== "number" || !Number.isFinite(field) || field < 0) {
            throw new RouterError("upstream_protocol_error", "Antigravity JSON output has invalid usage.", 502);
        }
        usage[name] = field;
    }
    return usage;
}
function classifiedProviderResultFailure(result: TerminalResult): RouterError | undefined {
    if (result.status !== "ERROR" || result.response !== "" || result.error === undefined)
        return undefined;
    const signal = result.error;
    const matches: RouterError[] = [];
    if (/(?:quota|resource[ _-]?exhausted|rate[ _-]?limit|too many requests|limit[ _-]?exceeded|weighted tokens? left)/iu.test(signal)) {
        matches.push(new RouterError("provider_rate_limited", "Antigravity provider quota is currently unavailable.", 429));
    }
    if (/(?:entitlement|not entitled|permission denied|access denied|forbidden)/iu.test(signal)) {
        matches.push(new RouterError("provider_entitlement_denied", "Antigravity model entitlement was denied.", 403));
    }
    if (/(?:model[ _-]?not[ _-]?available|unsupported[ _-]?model|invalid[ _-]?model|unknown[ _-]?model)/iu.test(signal)) {
        matches.push(new RouterError("model_not_available", "The requested Antigravity model is not available.", 404));
    }
    if (/(?:auth(?:entication|orization)?|login|sign[ -]?in|oauth)/iu.test(signal)) {
        matches.push(new RouterError("provider_auth_required", "Antigravity OAuth login is required.", 401));
    }
    return matches.length === 1 ? matches[0] : undefined;
}
function processEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const environment = sanitizedWorkerEnvironment("gemini", source);
    for (const name of Object.keys(environment).filter((key) => isGenericEndpointSelector(key) || antigravitySelectorPattern.test(key))) {
        delete environment[name];
    }
    environment["AGY_CLI_HIDE_ACCOUNT_INFO"] = "1";
    // 2026-09-05: on every `--print` launch agy spawns a BACKGROUND updater
    // (auto_updater.go:305 "Spawned background update process") and does not write the binary
    // in place -- it RENAMES it `agy.exe -> agy.exe.<ts>.old` and writes the new one; the
    // IsReadOnly flag does not stop that (the 09-03 protection was bypassed in exactly this
    // way at 09-05 09:47:37; violation of nail 14).
    // Two-arm experiment (a copy of 1.1.25, a real print call): with the value "1" it UPDATED;
    // with "true" the log said "auto_updater.go:218 Auto-update disabled via environment
    // variable" and the binary stayed fixed. Accepting a new version:
    // agy-manifest-dogrulama.py (Google manifest) -> new release.
    environment["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true";
    return environment;
}
function processArguments(model: string, timeoutMs: number, allowEdits = false): string[] {
    // 2026-09-03: `--mode plan --sandbox` makes agy READ-ONLY. That was not a secrecy or
    // security constraint but a flag we passed ourselves; measured: with `--mode accept-edits
    // --dangerously-skip-permissions` agy WROTE a file through its own filesystem MCP server
    // (evidence: tasks/sistem-onarim-20260903/kanit.md A13). The tool bridge is NOT injected --
    // agy already carries the tools from the operator's persistent mcp_config.json, so no
    // session secret is written anywhere; the Phase 9 objection does not cover this path.
    // The one-shot delegation lane (cli.ts) does NOT pass allowEdits: there, plan mode is the
    // correct behaviour.
    return [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        model,
        ...(model === "gemini-3.8-flash-high" ? ["--effort", "high"] : []),
        "--mode",
        allowEdits ? "accept-edits" : "plan",
        ...(allowEdits ? ["--dangerously-skip-permissions"] : ["--sandbox"]),
        "--disable-slash-commands",
        "--print-timeout",
        `${timeoutMs / 1_000}s`,
    ];
}
function processInput(prompt: string): string {
    return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
}
export async function runAntigravityProcess(request: HeadlessProcessRequest): Promise<HeadlessProcessOutput> {
    return await new Promise((resolveResult, rejectResult) => {
        const child = spawn(request.command, request.arguments, {
            cwd: request.cwd,
            env: request.environment,
            shell: request.shell,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: request.windowsHide,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;
        const settle = (action: () => void): void => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            request.signal?.removeEventListener("abort", onAbort);
            action();
        };
        const fail = (error: RouterError): void => settle(() => rejectResult(error));
        const collect = (target: Buffer[], chunk: Buffer): void => {
            outputBytes += chunk.byteLength;
            if (outputBytes > request.maximumOutputBytes) {
                child.kill();
                fail(new RouterError("upstream_protocol_error", "Antigravity exceeded the safe output limit.", 502));
                return;
            }
            target.push(chunk);
        };
        const onAbort = (): void => {
            child.kill();
            fail(new RouterError("upstream_timeout", "Antigravity request was cancelled.", 504));
        };
        const timeout = setTimeout(() => {
            child.kill();
            fail(new RouterError("upstream_timeout", "Antigravity exceeded the process timeout.", 504));
        }, request.timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
        child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
        child.stdin?.once("error", () => {
            child.kill();
            fail(new RouterError("adapter_unavailable", "Antigravity stdin transport failed.", 503));
        });
        child.once("error", () => fail(new RouterError("adapter_unavailable", "Antigravity could not be started.", 503)));
        child.once("close", (code) => {
            settle(() => resolveResult({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
        });
        child.stdin?.end(request.input, "utf8");
        if (request.signal?.aborted)
            onAbort();
        else
            request.signal?.addEventListener("abort", onAbort, { once: true });
    });
}
// A child failure is only actionable if the child's own explanation survives the
// throw. Measured 2026-09-07: the child said, on stderr, exactly why it produced
// nothing ("a tool required the \"command\" permission that headless mode cannot
// prompt for, so it was auto-denied"), while the router reported only "Antigravity
// did not complete the request." The diagnosis was collected and then discarded.
//
// A red-team pass over the first version of this fix (2026-09-07, report
// tasks/router-karar-20260907/astra-red-team.md) broke three of its claims, and the
// repairs below are its findings, not this file's own optimism:
//   - the explanation survived on TWO throw paths and was still dropped on a dozen
//     others, including the one where the child wrote its reason into the terminal
//     event's `error` field rather than to stderr;
//   - the redaction let a Bearer value, a query-string token, an AWS key id, a
//     multi-word field value and any non-ASCII run through;
//   - the "bytes" counter counted UTF-16 units and could cut a surrogate pair in half.
//
// stderr is untrusted text from a child whose environment carries credentials, so it
// is redacted before it travels: a diagnostic channel must never become a leak. The
// redaction deliberately over-reaches on named fields (it takes the rest of the
// line) — a diagnostic that hides one word too many is recoverable, one that leaks
// is not.
const childDetailLimit = 600;

const secretFieldNames = "api[_-]?key|apikey|key|token|secret|client_secret|access_token|refresh_token|password|passwd|pwd|authorization|auth";

function redactChildDetail(text: string): string {
    return text
        // Provider-prefixed credentials. The left lookbehind keeps ordinary words
        // ("task-management-system" would otherwise match the sk- rule) out of it.
        .replace(/(?<![A-Za-z0-9])(?:sk|pk|ghp|gho|ghu|ghs|ghr|xai|key|api)[-_][A-Za-z0-9_-]{8,}/giu, "[REDACTED]")
        .replace(/(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/gu, "[REDACTED]")
        .replace(/(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{10,}/gu, "[REDACTED]")
        .replace(/(?<![A-Za-z0-9])ya29\.[A-Za-z0-9._-]{10,}/gu, "[REDACTED]")
        // The VALUE after a scheme word, not the scheme word itself. The first
        // version redacted "Bearer" and left the token standing.
        .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "$1 [REDACTED]")
        // A JWT in full: the header and payload carry claims, so redacting only the
        // signature (as the first version did) still leaks the contents.
        .replace(/(?<![A-Za-z0-9._-])[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{6,}(?![A-Za-z0-9._-])/gu, "[REDACTED]")
        // A named field in bare, quoted, JSON or query-string form. The value runs to
        // the end of the line so a multi-word or space-broken secret cannot survive
        // in fragments; \S+ let the tail through.
        .replace(new RegExp(`("?\\b(?:${secretFieldNames})"?\\s*[:=]\\s*)[^\\n]*`, "giu"), "$1[REDACTED]")
        // Long opaque runs, letters of any script — the ASCII-only class missed a
        // 40-character non-ASCII value entirely.
        .replace(/(?<![\p{L}\p{N}_-])[\p{L}\p{N}_-]{32,}(?![\p{L}\p{N}_-])/gu, "[REDACTED]");
}

// The limit is in BYTES and is measured in bytes; the first version sliced UTF-16
// units, reported them as "bytes", and could leave a lone surrogate at the cut.
function boundedExcerpt(text: string): string {
    const totalBytes = Buffer.byteLength(text, "utf8");
    if (totalBytes <= childDetailLimit)
        return text;
    let usedBytes = 0;
    let kept = "";
    for (const character of text) {
        const size = Buffer.byteLength(character, "utf8");
        if (usedBytes + size > childDetailLimit)
            break;
        usedBytes += size;
        kept += character;
    }
    return `${kept}...[${totalBytes - usedBytes} more bytes]`;
}

// Both channels the child can explain itself through. Measured: with a terminal
// event carrying `error: "disk full: ..."` and an empty stderr, the first version
// said "child wrote nothing to stderr" while the child had written plenty.
function childDetail(output: { readonly exitCode: number | null; readonly stderr: string }, reported?: string): string {
    const channels: string[] = [];
    const stderr = redactChildDetail(output.stderr.trim());
    if (stderr !== "")
        channels.push(`stderr: ${boundedExcerpt(stderr)}`);
    const terminal = reported === undefined ? "" : redactChildDetail(reported.trim());
    if (terminal !== "")
        channels.push(`terminal error: ${boundedExcerpt(terminal)}`);
    const exit = output.exitCode === null ? "exit unknown" : `exit ${output.exitCode}`;
    return channels.length === 0
        ? `${exit}, child wrote no diagnostic on stderr or in its terminal event`
        : `${exit}: ${channels.join(" | ")}`;
}

function withChildDetail(error: RouterError, output: HeadlessProcessOutput, reported?: string): RouterError {
    return new RouterError(error.code, `${error.message} ${childDetail(output, reported)}`, error.status);
}

// The child names this condition itself. Measured 2026-09-07, agy stderr:
// "no output produced -- a tool required the \"command\" permission that headless
// mode cannot prompt for, so it was auto-denied". The first version matched a bare
// mention of a permission setting, so an INFO line naming permissions.allow and a
// usage line for --dangerously-skip-permissions were both classified as denials,
// while "execution rejected: approval unavailable" (verb before noun) was missed.
// A denial now needs a permission word AND a denial verb, in either order, and an
// explicit negation disqualifies it.
const permissionWords = "permissions?|approval|authori[sz]ation";
const denialWords = "denied|rejected|refused|not permitted|cannot prompt|could not prompt|auto-?denied";
const permissionDenialSignature = new RegExp(
    `(?:${permissionWords})[\\s\\S]{0,80}?(?:${denialWords})`
    + `|(?:${denialWords})[\\s\\S]{0,80}?(?:${permissionWords})`
    + `|auto-?denied`,
    "iu",
);
const permissionDenialNegation = /\b(?:not|never|n't)\s+(?:auto-?)?(?:denied|rejected|refused)\b|^\s*usage:|--help\b/imu;

function looksLikePermissionDenial(...channels: readonly (string | undefined)[]): boolean {
    return channels.some((channel) => channel !== undefined
        && permissionDenialSignature.test(channel)
        && !permissionDenialNegation.test(channel));
}

export async function runAntigravityHeadless(options: AntigravityHeadlessOptions): Promise<AntigravityHeadlessResult> {
    if (!isAllowedModel(options.model)) {
        throw new RouterError("model_not_available", `Antigravity model ${JSON.stringify(options.model)} is not in this router's reviewed contract set. ONARIM: add it to AGENT_MODEL_CONTRACTS -- this is a LOCAL policy refusal, not an upstream one.`, 404);
    }
    if (options.prompt.trim() === "")
        throw new RouterError("invalid_request", "Antigravity prompt must not be empty.", 400);
    if (Buffer.byteLength(options.prompt, "utf8") > maximumInputBytes) {
        throw new RouterError("invalid_request", "Antigravity prompt exceeds the safe stdin limit.", 413);
    }
    if (options.signal?.aborted)
        throw new RouterError("upstream_timeout", "Antigravity request was cancelled.", 504);
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximumTimeoutMs || timeoutMs % 1_000 !== 0) {
        throw new RouterError("invalid_request", "Antigravity timeout must be a positive bounded integer.", 400);
    }
    const source = options.environment ?? process.env;
    assertNoApiKeySelectors(source);
    assertNoCustomSelectors(source);
    await assertSettingsDoNotSelectGemini(options.home ?? homedir());
    let output: HeadlessProcessOutput;
    try {
        output = await (options.processRunner ?? runAntigravityProcess)({
            command: options.binary,
            arguments: processArguments(options.model, timeoutMs, options.allowEdits === true),
            input: processInput(options.prompt),
            cwd: options.cwd,
            environment: processEnvironment(source),
            timeoutMs,
            maximumOutputBytes,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            shell: false,
            windowsHide: true,
        });
    }
    catch (error) {
        if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
            throw new RouterError("upstream_timeout", "Antigravity request was cancelled.", 504);
        }
        if (error instanceof RouterError)
            throw error;
        throw new RouterError("adapter_unavailable", "Antigravity could not complete the process request.", 503);
    }
    if (output.exitCode !== 0 && output.stdout.trim() === "" && /(?:auth(?:entication|orization)?|login|sign[ -]?in|oauth)/iu.test(output.stderr)) {
        throw new RouterError("provider_auth_required", `Antigravity OAuth login is required. ${childDetail(output)}`, 401);
    }
    // parseResponse throws on every malformed-stream shape, and each of those throws
    // used to leave the child's explanation behind. The parse failure keeps its own
    // code and status; only the diagnosis is added.
    let parsed: TerminalResult;
    try {
        parsed = parseResponse(output.stdout);
    }
    catch (error) {
        throw error instanceof RouterError ? withChildDetail(error, output) : error;
    }
    if (output.exitCode !== 0 || !["success", "ok"].includes(parsed.status.toLowerCase())) {
        const classified = output.exitCode === 0 ? undefined : classifiedProviderResultFailure(parsed);
        if (classified !== undefined)
            throw withChildDetail(classified, output, parsed.error);
        throw new RouterError(
            "upstream_protocol_error",
            `Antigravity did not complete the request. ${childDetail(output, parsed.error)}`,
            502,
        );
    }
    // A terminal SUCCESS carrying an empty response is not a success: the caller
    // receives nothing and is told nothing. Before this branch existed the empty
    // case returned as success and the whole delegation lane looked healthy while
    // delivering nothing.
    if (parsed.response.trim() === "") {
        const permissionDenied = looksLikePermissionDenial(output.stderr, parsed.error);
        // The remedy names the arguments this call ACTUALLY used. The first version
        // hardcoded "--mode plan --sandbox" while provider-set.ts passes
        // allowEdits: true, so on that lane the message described a command that was
        // never run -- a remedy that misdescribes the run teaches distrust.
        const lane = options.allowEdits === true
            ? `"--mode accept-edits --dangerously-skip-permissions"`
            : `"--mode plan --sandbox"`;
        throw new RouterError(
            permissionDenied ? "provider_tool_permission_denied" : "upstream_protocol_error",
            permissionDenied
                ? `Antigravity produced no response: a tool permission could not be granted in headless mode. ONARIM: this call ran agy with ${lane} (see processArguments), and a tool needing a permission is auto-denied there, which stops the run. Add an allow-rule for the tool the child names below under permissions.allow in the agy settings, or run the task on a lane that grants that tool. ${childDetail(output, parsed.error)}`
                : `Antigravity reported success with an empty response. ${childDetail(output, parsed.error)}`,
            502,
        );
    }
    return parsed.usage === undefined
        ? { response: parsed.response, model: options.model }
        : { response: parsed.response, model: options.model, usage: parsed.usage };
}
