import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { RouterError } from "../domain/errors.js";
import { sanitizedWorkerEnvironment } from "../security/environment.js";
import { spawnFailureGuard } from "../runtime/child-process.js";
import { ensureGeminiOAuthConfiguration } from "../runtime/provider-config.js";
import { readBoundedWorkspaceText } from "../security/workspace-read.js";
export interface GeminiAcpOptions {
    readonly cwd: string;
    readonly task: string;
    readonly home: string;
    readonly binary?: string;
    readonly binaryArguments?: readonly string[];
    readonly signal?: AbortSignal;
}
export interface GeminiAcpResult {
    readonly text: string;
    readonly sessionId: string;
    readonly stopReason: string;
}
type RequestPermissionParams = acp.ClientRequestParamsByMethod[typeof acp.methods.client.session.requestPermission];
type RequestPermissionResponse = acp.ClientRequestResponsesByMethod[typeof acp.methods.client.session.requestPermission];
type ReadTextFileParams = acp.ClientRequestParamsByMethod[typeof acp.methods.client.fs.readTextFile];
type ReadTextFileResponse = acp.ClientRequestResponsesByMethod[typeof acp.methods.client.fs.readTextFile];
type SessionUpdateParams = acp.ClientNotificationParamsByMethod[typeof acp.methods.client.session.update];
const maximumReadableFileBytes = 5 * 1024 * 1024;
class ReadOnlyGeminiClient {
    #chunks: string[] = [];
    #workspace: string;
    constructor(workspace: string) {
        this.#workspace = workspace;
    }
    async requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResponse> {
        const rejected = params.options.find((option) => option.kind === "reject_once" || option.kind === "reject_always");
        if (rejected !== undefined) {
            return { outcome: { outcome: "selected", optionId: rejected.optionId } };
        }
        return { outcome: { outcome: "cancelled" } };
    }
    async sessionUpdate(params: SessionUpdateParams): Promise<void> {
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            this.#chunks.push(update.content.text);
        }
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
    resultText(): string {
        return this.#chunks.join("");
    }
}
// gemini-cli accepts only these telemetry targets. Anything else is rejected
// during startup validation, before the ACP handshake and before the enabled
// flag is consulted. Exported so the test can pin the set rather than restate it.
export const GEMINI_VALID_TELEMETRY_TARGETS: readonly string[] = ["local", "gcp"];
// Split out of spawnGemini so the environment is testable without spawning a
// process. A defect that only appears in a live child is a defect the suite
// cannot hold.
export function geminiWorkerEnvironment(home: string, systemSettings: string): NodeJS.ProcessEnv {
    const environment = sanitizedWorkerEnvironment("gemini");
    environment["GEMINI_CLI_HOME"] = home;
    environment["GEMINI_TELEMETRY_ENABLED"] = "false";
    // MEASURED 2026-09-01: "none" is NOT a valid target for gemini-cli 0.38.2.
    // The CLI validates the target BEFORE looking at the enabled flag, so the
    // previous line here killed every Gemini ACP session at startup:
    //     Invalid telemetry configuration: Invalid telemetry target: none.
    //     Valid values are: local, gcp.        -> exit code 52, stdout empty
    // The symptom reaching the operator was "model selected, no answer": the
    // process died before the ACP handshake, so nothing ever went upstream.
    // Deleting the variable, rather than naming a valid target, is the right
    // fix: telemetry is already disabled by the line above, and a target only
    // describes WHERE data would go if it were ever enabled.
    delete environment["GEMINI_TELEMETRY_TARGET"];
    environment["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] = systemSettings;
    return environment;
}
function spawnGemini(options: GeminiAcpOptions, systemSettings: string): ChildProcess {
    const environment = geminiWorkerEnvironment(options.home, systemSettings);
    return spawn(options.binary ?? "gemini", [...(options.binaryArguments ?? []), "--acp"], {
        cwd: options.cwd,
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
}
export async function runGeminiAcp(options: GeminiAcpOptions): Promise<GeminiAcpResult> {
    if (options.task.trim() === "")
        throw new RouterError("invalid_request", "Gemini task must not be empty.", 400);
    if (options.signal?.aborted)
        throw new RouterError("upstream_timeout", "Gemini ACP task was cancelled.", 504);
    const systemSettings = await ensureGeminiOAuthConfiguration(options.home);
    if (options.signal?.aborted)
        throw new RouterError("upstream_timeout", "Gemini ACP task was cancelled.", 504);
    const child = spawnGemini(options, systemSettings);
    const spawnFailure = spawnFailureGuard(child);
    if (child.stdin === null || child.stdout === null) {
        child.kill();
        throw new RouterError("adapter_unavailable", "Gemini ACP stdio is unavailable.", 503);
    }
    child.stderr?.resume();
    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);
    const implementation = new ReadOnlyGeminiClient(options.cwd);
    let activeSessionId: string | undefined;
    const onAbort = (): void => {
        child.kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        const result = await acp
            .client({ name: "hezarfen-claude-oauth" })
            .onRequest(acp.methods.client.session.requestPermission, (context) => implementation.requestPermission(context.params))
            .onRequest(acp.methods.client.fs.readTextFile, (context) => implementation.readTextFile(context.params))
            .onNotification(acp.methods.client.session.update, (context) => implementation.sessionUpdate(context.params))
            .connectWith(stream, async (context) => {
            await context.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
            });
            const session = await context.request(acp.methods.agent.session.new, {
                cwd: resolve(options.cwd),
                mcpServers: [],
            });
            activeSessionId = session.sessionId;
            const prompt = await context.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [
                    {
                        type: "text",
                        text: [
                            "Operate in read-only analysis mode.",
                            "Do not request file writes, shell execution, network side effects, or permission escalation.",
                            "Return recommendations and review findings only.",
                            "",
                            options.task,
                        ].join("\n"),
                    },
                ],
            });
            return { sessionId: session.sessionId, stopReason: prompt.stopReason };
        });
        return {
            text: implementation.resultText(),
            sessionId: result.sessionId,
            stopReason: result.stopReason,
        };
    }
    catch (error) {
        const failure = spawnFailure();
        if (failure !== undefined) {
            throw new RouterError("adapter_unavailable", `Gemini CLI could not be started from its pinned path (${failure.code ?? "spawn failed"}). ONARIM: reinstall the pinned Gemini CLI, then re-run claude-oauth doctor.`, 503, { cause: failure });
        }
        if (options.signal?.aborted) {
            throw new RouterError("upstream_timeout", "Gemini ACP task was cancelled.", 504, { cause: error });
        }
        if (activeSessionId === undefined) {
            throw new RouterError("provider_auth_required", "Gemini ACP could not initialize. Complete Gemini OAuth login.", 401, {
                cause: error,
            });
        }
        throw new RouterError("upstream_protocol_error", "Gemini ACP task failed.", 502, { cause: error });
    }
    finally {
        options.signal?.removeEventListener("abort", onAbort);
        child.kill();
    }
}

// ---------------------------------------------------------------------------
// Phase 9 / Path 4 -- long-lived ACP session (the same skeleton as the Grok side).
//
// runGeminiAcp is ONE-SHOT and cannot carry a tool loop past the turn boundary: Claude Code
// sends a SEPARATE HTTP request for every turn, whereas the ACP prompt call does not return
// until the agent has finished its work. This function returns the handle IMMEDIATELY, so the
// session registry can keep the process and the connection alive.
//
// Gemini has NO session/resume (measured). Continuity therefore does not rest on resume but on
// the process itself staying alive.
// ---------------------------------------------------------------------------

export interface GeminiAcpSessionOptions extends GeminiAcpOptions {
    /** MCP servers. In Phase 9 there is a single element: the tool bridge on the router. */
    readonly mcpServers?: readonly unknown[];
    /** Tool names published by the bridge; the permission arm recognises these. */
    readonly bridgedToolNames?: readonly string[];
    /**
     * When the tool loop is on, the read-only instruction is NOT SENT.
     *
     * Telling the same agent both "do not write" and "you have tools" is a contradiction, and
     * its measured result is that the agent never calls the tool at all.
     */
    readonly toolsEnabled?: boolean;
}

export interface GeminiAcpSession {
    readonly done: Promise<void>;
    text(): string;
    cancel(reason: string): void;
}

/**
 * Is this a permission request for a tool published by the bridge?
 *
 * [UNVERIFIED] Whether the ACP agent runs its OWN permission flow for an MCP tool call will be
 * MEASURED IN A LIVE RUN. Until then it is FAIL-CLOSED: if it cannot recognise the name it
 * refuses. A permission gate opened on the wrong side would also let loose the agent's OWN
 * write tools.
 */
function geminiNamesBridgedTool(params: unknown, bridged: readonly string[]): boolean {
    if (bridged.length === 0) return false;
    const govde = JSON.stringify(params ?? {});
    return bridged.some((name) => govde.includes(`"${name}"`));
}

const READ_ONLY_PREAMBLE = [
    "Operate in read-only analysis mode.",
    "Do not request file writes, shell execution, network side effects, or permission escalation.",
    "Return recommendations and review findings only.",
    "",
].join("\n");

export function startGeminiAcpSession(options: GeminiAcpSessionOptions): GeminiAcpSession {
    const implementation = new ReadOnlyGeminiClient(options.cwd);
    const bridged = options.bridgedToolNames ?? [];
    // FINDING 2 (adversarial review). cancel() can be called BEFORE the child is SPAWNED;
    // in the old shape it then did nothing and the IIFE would still start the child --
    // a process that cannot be killed, and a router that does not shut down.
    let iptalEdildi = false;
    let child: ChildProcess | undefined;
    let onAbort: (() => void) | undefined;

    const done = (async (): Promise<void> => {
        if (options.task.trim() === "") {
            throw new RouterError("invalid_request", "Gemini task must not be empty.", 400);
        }
        if (iptalEdildi || options.signal?.aborted)
            throw new RouterError("upstream_timeout", "Gemini ACP session was cancelled before start.", 504);
        const systemSettings = await ensureGeminiOAuthConfiguration(options.home);
        // Preparation yields: cancel() or the caller's signal may have fired while it ran.
        if (iptalEdildi || options.signal?.aborted) {
            throw new RouterError("upstream_timeout", "Gemini ACP session was cancelled during start.", 504);
        }
        child = spawnGemini(options, systemSettings);
        const spawnFailure = spawnFailureGuard(child);
        if (child.stdin === null || child.stdout === null) {
            child.kill();
            throw new RouterError("adapter_unavailable", "Gemini ACP stdio is unavailable.", 503);
        }
        child.stderr?.resume();
        const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
        const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
        const stream = acp.ndJsonStream(input, output);
        let activeSessionId: string | undefined;
        const target = child;
        onAbort = (): void => {
            target.kill();
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        try {
            await acp
                .client({ name: "hezarfen-claude-oauth" })
                .onRequest(acp.methods.client.session.requestPermission, (context) => {
                    if (geminiNamesBridgedTool(context.params, bridged)) {
                        const allowed = context.params.options.find((option) => option.kind === "allow_once" || option.kind === "allow_always");
                        if (allowed !== undefined) {
                            return Promise.resolve({ outcome: { outcome: "selected" as const, optionId: allowed.optionId } });
                        }
                    }
                    return implementation.requestPermission(context.params);
                })
                .onRequest(acp.methods.client.fs.readTextFile, (context) => implementation.readTextFile(context.params))
                .onNotification(acp.methods.client.session.update, (context) => implementation.sessionUpdate(context.params))
                .connectWith(stream, async (context) => {
                    await context.request(acp.methods.agent.initialize, {
                        protocolVersion: acp.PROTOCOL_VERSION,
                        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
                    });
                    const session = await context.request(acp.methods.agent.session.new, {
                        cwd: resolve(options.cwd),
                        mcpServers: (options.mcpServers ?? []) as never,
                    });
                    activeSessionId = session.sessionId;
                    await context.request(acp.methods.agent.session.prompt, {
                        sessionId: session.sessionId,
                        prompt: [{
                            type: "text",
                            text: options.toolsEnabled === true
                                ? options.task
                                : `${READ_ONLY_PREAMBLE}${options.task}`,
                        }],
                    });
                });
        }
        catch (error) {
            const failure = spawnFailure();
            if (failure !== undefined) {
                throw new RouterError("adapter_unavailable", `Gemini CLI could not be started from its pinned path (${failure.code ?? "spawn failed"}). ONARIM: reinstall the pinned Gemini CLI, then re-run claude-oauth doctor.`, 503, { cause: failure });
            }
            if (options.signal?.aborted) {
                throw new RouterError("upstream_timeout", "Gemini ACP session was cancelled.", 504, { cause: error });
            }
            if (activeSessionId === undefined) {
                throw new RouterError("provider_auth_required", "Gemini ACP could not initialize. Complete Gemini OAuth login.", 401, { cause: error });
            }
            throw new RouterError("upstream_protocol_error", "Gemini ACP session failed.", 502, { cause: error });
        }
        finally {
            if (onAbort !== undefined) options.signal?.removeEventListener("abort", onAbort);
            child.kill();
        }
    })();

    return {
        done,
        text: () => implementation.resultText(),
        cancel: () => {
            iptalEdildi = true;
            child?.kill();
        },
    };
}
