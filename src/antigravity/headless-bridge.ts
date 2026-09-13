import { spawn } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RouterError } from "../domain/errors.js";
import { AGENT_MODEL_CONTRACTS } from "../domain/model-contracts.js";
import { assertNoApiKeySelectors, sanitizedWorkerEnvironment } from "../security/environment.js";
import { createEphemeralConfigHome, DEFAULT_TOOL_SERVER_NAME, type AgentToolEndpoint, type EphemeralConfigHome } from "./config-home.js";
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
    /** Legacy calls without a tool endpoint may bypass permissions; ignored on the bridge lane. */
    readonly allowEdits?: boolean;
    readonly binary: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly model: string;
    readonly home?: string;
    /**
     * G01. When both are supplied the call runs inside a CALL-SCOPED configuration home
     * that carries our MCP entry and nothing else; the operator's own mcp_config.json is
     * never opened for writing. Omitted, the lane behaves exactly as before.
     */
    readonly toolEndpoint?: AgentToolEndpoint;
    readonly configHomeRoot?: string;
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
function processEnvironment(source: NodeJS.ProcessEnv, configHome?: string): NodeJS.ProcessEnv {
    const environment = sanitizedWorkerEnvironment("gemini", source);
    if (configHome !== undefined) {
        // MEASURED 2026-09-08: agy resolves its configuration home from these. Both are set
        // because the two platforms disagree on which one wins, and a home that is redirected
        // on one variable only would silently read the operator's real config.
        environment["USERPROFILE"] = configHome;
        environment["HOME"] = configHome;
    }
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
    // Measured with agy 1.1.27 on 2026-09-08: --mode has no effect alongside
    // --disable-slash-commands. Sandbox constrains terminal execution on the bridge
    // and delegation lanes; agy's workspace file permissions are configured separately.
    return [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        model,
        ...(model === "gemini-3.8-flash-high" ? ["--effort", "high"] : []),
        ...(allowEdits ? ["--dangerously-skip-permissions"] : ["--sandbox"]),
        "--disable-slash-commands",
        "--print-timeout",
        `${timeoutMs / 1_000}s`,
    ];
}
// B07 (2026-09-08): on the bridged lane the model's native file, shell and browser tools are
// denied by the call-scoped settings; a model that reaches for one ends its turn. The prompt
// says so once, so the model has a reason to pick the bridged tools instead of guessing.
export const BRIDGED_TOOL_POLICY_NOTE = `Tool policy for this session: your native file, shell and browser tools are disabled here and a call to any of them ends the turn without an answer. Use the tools served by the MCP server "${DEFAULT_TOOL_SERVER_NAME}" for every file read, edit, search and command.`;
export function processInput(prompt: string, bridged = false): string {
    const content = bridged ? `${BRIDGED_TOOL_POLICY_NOTE}\n\n${prompt}` : prompt;
    return `${JSON.stringify({ event: "user", message: { content } })}\n`;
}
export async function runAntigravityProcess(request: HeadlessProcessRequest): Promise<HeadlessProcessOutput> {
    if (request.signal?.aborted)
        throw new RouterError("upstream_timeout", "Antigravity request was cancelled.", 504);
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
        let failure: RouterError | undefined;
        const settle = (action: () => void): void => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            request.signal?.removeEventListener("abort", onAbort);
            action();
        };
        const fail = (error: RouterError, terminate = true): void => {
            if (settled || failure !== undefined)
                return;
            failure = error;
            clearTimeout(timeout);
            request.signal?.removeEventListener("abort", onAbort);
            if (terminate && child.exitCode === null && child.signalCode === null)
                child.kill();
        };
        const collect = (target: Buffer[], chunk: Buffer): void => {
            if (settled || failure !== undefined)
                return;
            outputBytes += chunk.byteLength;
            if (outputBytes > request.maximumOutputBytes) {
                fail(new RouterError("upstream_protocol_error", "Antigravity exceeded the safe output limit.", 502));
                return;
            }
            target.push(chunk);
        };
        const onAbort = (): void => {
            fail(new RouterError("upstream_timeout", "Antigravity request was cancelled.", 504));
        };
        const timeout = setTimeout(() => {
            fail(new RouterError("upstream_timeout", "Antigravity exceeded the process timeout.", 504));
        }, request.timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
        child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
        child.stdin?.once("error", () => {
            fail(new RouterError("adapter_unavailable", "Antigravity stdin transport failed.", 503));
        });
        child.once("error", () => fail(new RouterError("adapter_unavailable", "Antigravity could not be started.", 503), false));
        // close follows process exit AND stdio closure, including after a spawn error.
        // Waiting here prevents the caller's finally from deleting a live child's home.
        // https://nodejs.org/download/release/v24.14.0/docs/api/child_process.html#event-close
        child.once("close", (code) => {
            settle(() => {
                if (failure !== undefined)
                    rejectResult(failure);
                else
                    resolveResult({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
            });
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
// Two adversarial passes have been run against this code, and every rule below is
// one of their counter-examples rather than this file's own confidence. The second
// pass (Gemini, 2026-09-07) broke the first repair three more ways:
//   - "api-signature-token: <password>" was destroyed by the prefix rule, which
//     removed the very field name the later field rule needed, and the password
//     then walked out untouched;
//   - an AWS secret access key survived because "/" and "+" split it into runs
//     shorter than the 32-character opaque threshold;
//   - a quoted token after Bearer survived because the scheme rule expected the
//     value to start immediately.
// It also showed the reverse failure: redacting a whole line after a bare `key:`
// deleted the actual error message, which is a diagnostic channel destroying the
// diagnosis it exists to carry.
//
// The standing rule for this file: over-redaction is recoverable, a leak is not --
// but over-redaction that removes the ERROR ITSELF is not recoverable either, so
// weak field names take a bounded value and strong ones take the line.
const childDetailLimit = 600;

// Names whose value is a credential often enough that the rest of the line goes.
const strongSecretFields = "password|passwd|pwd|secret|client_secret|api[_-]?key|apikey|access_token|refresh_token|authorization|private_key";
// Names that appear in ordinary diagnostics too ("key": "spawn_failed", "unexpected
// token: '}'"). Their value is bounded and must be long enough to be a credential.
const weakSecretFields = "key|token|auth|credential";

// A weak field name ("key", "token") sits in front of ordinary diagnostic values as
// often as in front of credentials, and length alone does not separate them:
// "spawn_failed" and a 12-character token are the same size. Shape does: a credential
// is long, or mixes cases, or carries digits. Deleting "spawn_failed" costs the reader
// the reason their run died, which is the one thing this channel exists to carry.
// Measured 2026-09-07: the base64 rule redacted a POSIX source path and left the
// reader with "ENOENT open '[REDACTED].ts'". A path is diagnosis, not secret.
function looksLikePath(candidate: string): boolean {
    return candidate.startsWith("/") || (candidate.split("/").length - 1) >= 3;
}

function looksLikeCredential(value: string): boolean {
    // Two measured edges: "Error1" (a short status code behind a weak field name)
    // was called a credential because it mixes a letter and a digit, and a
    // nineteen-character lowercase token escaped because the plain-length threshold
    // sat at twenty. Shape heuristics need a length floor under them, and the floor
    // for length alone is lower than it was.
    if (value.length >= 16)
        return true;
    if (value.length < 12)
        return false;
    return (/[0-9]/u.test(value) && /[A-Za-z]/u.test(value))
        || (/[a-z]/u.test(value) && /[A-Z]/u.test(value));
}

function redactChildDetail(text: string): string {
    return text
        // ANSI sequences first: they are noise, they can be cut in half by the byte
        // limit, and half an escape sequence leaves the reader's terminal in a
        // colour it never asked for.
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "")
        // Provider-prefixed credentials. "key" and "api" were in this list and made
        // it match ordinary hyphenated words like "api-signature-token"; they are
        // handled as field names below instead.
        .replace(/(?<![A-Za-z0-9])(?:sk|pk|ghp|gho|ghu|ghs|ghr|xai|ya29|glpat|npm)[-_.][A-Za-z0-9_-]{8,}/giu, "[REDACTED]")
        .replace(/(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/gu, "[REDACTED]")
        .replace(/(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{10,}/gu, "[REDACTED]")
        // The VALUE after a scheme word, quoted or bare -- not the scheme word.
        .replace(/\b(Bearer|Basic|Token)\s+["']?[A-Za-z0-9._~+/=-]{8,}["']?/giu, "$1 [REDACTED]")
        // A JWT in full: header and payload carry claims, so redacting only the
        // signature still leaks the contents.
        .replace(/(?<![A-Za-z0-9._-])[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{6,}(?![A-Za-z0-9._-])/gu, "[REDACTED]")
        // Strong field names: the value runs to the end of the line, so a multi-word
        // or space-broken secret cannot survive in fragments.
        .replace(new RegExp(`("?\\b(?:${strongSecretFields})"?\\s*[:=]\\s*)[^\\n]*`, "giu"), "$1[REDACTED]")
        // Weak field names: one bounded value, and only when it is long enough to be
        // a credential. `"key": "spawn_failed"` keeps the rest of its line.
        .replace(new RegExp(`("?\\b(?:${weakSecretFields})"?\\s*[:=]\\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\\2`, "giu"),
                 (whole: string, name: string, quote: string, value: string) =>
                     (looksLikeCredential(value) ? `${name}${quote}[REDACTED]${quote}` : whole))
        // Base64-shaped runs, which the opaque-run rule below cannot see because "/"
        // and "+" split them. The mixed-case-plus-digit condition was NOT enough: it
        // was measured eating "/home/runner/work/MyApp123/src/index", and the comment
        // that used to sit here claimed the opposite. A path is what a reader needs
        // most from a diagnostic, so the separator count decides -- a credential
        // carries at most a couple, a path carries many, and a leading separator says
        // path outright. This is a heuristic and it is stated as one: a key with three
        // slashes still escapes, and a two-segment path with mixed case is still eaten.
        .replace(/(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/gu,
                 (candidate: string) => (looksLikePath(candidate) ? candidate : "[REDACTED]"))
        // Long opaque runs, letters of any script.
        .replace(/(?<![\p{L}\p{N}_-])[\p{L}\p{N}_-]{32,}(?![\p{L}\p{N}_-])/gu, "[REDACTED]");
}

// The limit is in BYTES and is measured in bytes; an earlier version sliced UTF-16
// units, reported them as "bytes", and could leave a lone surrogate at the cut. The
// cut is also pulled back off a combining mark or a zero-width joiner, so the last
// glyph is never left half-composed.
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
    while (kept.length > 0 && /[\p{M}\u200d]/u.test(kept.slice(-1))) {
        usedBytes -= Buffer.byteLength(kept.slice(-1), "utf8");
        kept = kept.slice(0, -1);
    }
    return `${kept}...[${totalBytes - usedBytes} more bytes]`;
}

// Both channels the child can explain itself through. Measured: with a terminal
// event carrying `error: "disk full: ..."` and an empty stderr, an earlier version
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
// mode cannot prompt for, so it was auto-denied".
//
// Three shapes had to be told apart, and each one is a counter-example that was
// classified wrongly at some point in this file's history:
//   - a mention is not a denial ("INFO permissions.allow loaded");
//   - a denial elsewhere in the system is not THIS denial ("IAM permission denied
//     for project x" is a Google authorisation failure, and sending its reader to
//     permissions.allow wastes their afternoon);
//   - a negation is not a denial ("permission was not denied").
// So a denial needs a permission word, a denial verb, AND a word placing it in this
// process's tool-approval path -- all within one line, because a `--help` line
// elsewhere in the output used to disqualify the whole channel.
const permissionWords = "permissions?|approval|authori[sz]ation";
const denialWords = "denied|rejected|refused|not permitted|cannot prompt|could not prompt|could not be obtained|auto-?denied";
// Bare "command" was measured matching "command failed: permission denied for
// /etc/passwd" -- an operating-system EACCES, classified as a tool-approval denial
// and answered with a permissions.allow remedy that has nothing to do with it. The
// child's own wording ("a tool required the \"command\" permission that headless mode
// cannot prompt for") still matches through "tool" and "headless".
const toolContextWords = "tool|headless|noninteractive|non-interactive|interactively|prompt for|approve|approval|skip-permissions|allow-rule|permissions\\.allow|\"command\" permission";
const permissionDenialSignature = new RegExp(
    `(?:${permissionWords})[\\s\\S]{0,80}?(?:${denialWords})`
    + `|(?:${denialWords})[\\s\\S]{0,80}?(?:${permissionWords})`
    + `|auto-?denied`,
    "iu",
);
const permissionDenialNegation = /\b(?:not|never|n't)\s+(?:auto-?)?(?:denied|rejected|refused)\b|^\s*usage:|--help\b/iu;
const toolContext = new RegExp(`(?:${toolContextWords})`, "iu");

function looksLikePermissionDenial(...channels: readonly (string | undefined)[]): boolean {
    // The window is the match's OWN span, widened to whole lines. Testing the entire
    // channel let a distant "--help" disqualify a real denial; testing single lines
    // lost a denial that straddled a line break. The match knows where it starts and
    // ends, so it defines its own neighbourhood.
    const scanner = new RegExp(permissionDenialSignature.source, "giu");
    return channels.some((channel) => {
        if (channel === undefined)
            return false;
        scanner.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = scanner.exec(channel)) !== null) {
            const from = channel.lastIndexOf("\n", match.index) + 1;
            const lineEnd = channel.indexOf("\n", match.index + match[0].length);
            const window = channel.slice(from, lineEnd === -1 ? channel.length : lineEnd);
            if (toolContext.test(window) && !permissionDenialNegation.test(window))
                return true;
        }
        return false;
    });
}

export async function runAntigravityHeadless(options: AntigravityHeadlessOptions): Promise<AntigravityHeadlessResult> {
    if (!isAllowedModel(options.model)) {
        throw new RouterError("model_not_available", `Antigravity model ${JSON.stringify(options.model)} is not in this router's reviewed contract set. FIX: add it to AGENT_MODEL_CONTRACTS -- this is a LOCAL policy refusal, not an upstream one.`, 404);
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
    const allowEdits = options.toolEndpoint === undefined && options.allowEdits === true;
    assertNoApiKeySelectors(source);
    assertNoCustomSelectors(source);
    await assertSettingsDoNotSelectGemini(options.home ?? homedir());
    if (options.toolEndpoint !== undefined && options.configHomeRoot === undefined) {
        throw new RouterError("invalid_request", "An Antigravity tool endpoint requires a call-scoped configuration root.", 400);
    }
    let output: HeadlessProcessOutput;
    let configHome: EphemeralConfigHome | undefined;
    try {
        if (options.toolEndpoint !== undefined && options.configHomeRoot !== undefined) {
            configHome = await createEphemeralConfigHome({
                root: options.configHomeRoot,
                ...(options.home === undefined ? {} : { sourceHome: options.home }),
                endpoint: options.toolEndpoint,
            });
            await assertSettingsDoNotSelectGemini(configHome.path);
        }
        output = await (options.processRunner ?? runAntigravityProcess)({
            command: options.binary,
            arguments: processArguments(options.model, timeoutMs, allowEdits),
            input: processInput(options.prompt, options.toolEndpoint !== undefined),
            cwd: options.cwd,
            environment: processEnvironment(source, configHome?.path),
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
    finally {
        // The nonce lives ONLY inside this directory. Every exit path -- success, timeout,
        // cancellation, a thrown RouterError -- passes through here; a crash that skips it
        // is what the startup sweep exists for.
        await configHome?.dispose();
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
        // A non-RouterError here (a TypeError, say) used to escape with the child's
        // stderr and exit code attached to nothing. Whatever the parser threw, the
        // caller gets a code it can act on and the diagnosis that goes with it.
        if (error instanceof RouterError)
            throw withChildDetail(error, output);
        throw new RouterError(
            "upstream_protocol_error",
            `Antigravity output could not be parsed. ${childDetail(output)}`,
            502,
            { cause: error },
        );
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
        // Use the same effective policy as argv, including the bridge override.
        const lane = allowEdits ? `"--dangerously-skip-permissions"` : `"--sandbox"`;
        const remedy = options.toolEndpoint === undefined
            ? "Add an allow-rule for the tool the child names below under permissions.allow in the agy settings, or run the task on a lane that grants that tool."
            : "Use the Claude Code MCP bridge for tool effects; do not widen this call's native tool permissions.";
        throw new RouterError(
            permissionDenied ? "provider_tool_permission_denied" : "upstream_protocol_error",
            permissionDenied
                ? `Antigravity produced no response: a tool permission could not be granted in headless mode. FIX: this call ran agy with ${lane} (see processArguments), and a tool needing a permission is auto-denied there, which stops the run. ${remedy} ${childDetail(output, parsed.error)}`
                : `Antigravity reported success with an empty response. ${childDetail(output, parsed.error)}`,
            // B07 (measured 2026-09-08, Agent inheritance arm): a denial returned as 502 was
            // retried by Claude Code ten times with exponential backoff, each retry meeting the
            // same policy. A denial is this turn's terminal answer, not a transient upstream
            // fault, so it must not be a 5xx.
            // B11 (reported 2026-09-10): 403 was the wrong terminal code. Claude Code reads 401/403
            // as an authentication failure and shows "Please run /login"; the operator ran /login
            // against a lane whose OAuth session was fine. A denial is a bad request for this lane
            // (the tool is not grantable here): 400, terminal, no login prompt, no retry.
            permissionDenied ? 400 : 502,
        );
    }
    return parsed.usage === undefined
        ? { response: parsed.response, model: options.model }
        : { response: parsed.response, model: options.model, usage: parsed.usage };
}
