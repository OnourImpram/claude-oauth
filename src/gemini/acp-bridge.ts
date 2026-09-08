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
    const systemSettings = await ensureGeminiOAuthConfiguration(options.home);
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
// Faz 9 / Yol 4 -- uzun-omurlu ACP oturumu (Grok tarafiyla ayni iskelet).
//
// runGeminiAcp TEK ATISLIK ve bir arac dongusunu tur sinirinin otesine tasiyamaz:
// Claude Code her tur icin AYRI bir HTTP istegi gonderir, oysa ACP prompt cagrisi
// ajan isini bitirene kadar donmez. Bu fonksiyon tutamaci HEMEN dondurur, boylece
// oturum defteri sureci ve baglantiyi canli tutabilir.
//
// Gemini'de session/resume YOK (olculdu). Sureklilik bu yuzden resume'a degil,
// surecin kendisinin canli kalmasina dayanir.
// ---------------------------------------------------------------------------

export interface GeminiAcpSessionOptions extends GeminiAcpOptions {
    /** MCP sunuculari. Faz 9'da tek eleman: router uzerindeki arac koprusu. */
    readonly mcpServers?: readonly unknown[];
    /** Kopruden yayimlanan arac adlari; izin kolu bunlari tanir. */
    readonly bridgedToolNames?: readonly string[];
    /**
     * Arac dongusu aciksa salt-okunur talimat GONDERILMEZ.
     *
     * Ayni ajana hem "yazma" hem "araclarin var" demek celiskidir ve olculen
     * sonucu, ajanin araci hic cagirmamasidir.
     */
    readonly toolsEnabled?: boolean;
}

export interface GeminiAcpSession {
    readonly done: Promise<void>;
    text(): string;
    cancel(reason: string): void;
}

/**
 * Kopruden yayimlanan bir araca ait izin istegi mi?
 *
 * [DOGRULANMADI] ACP ajaninin MCP arac cagrisi icin KENDI izin akisini isletip
 * isletmedigi CANLI KOSUMDA olculecek. O zamana kadar FAIL-CLOSED: adi
 * taniyamazsa reddeder. Yanlis tarafa acilmis bir izin kapisi ajanin KENDI
 * yazma araclarini da serbest birakirdi.
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
    // BULGU 2 (adversaryal inceleme). cancel() cocuk SPAWN EDILMEDEN once
    // cagrilabilir; o durumda eski hal hicbir sey yapmaz ve IIFE cocugu
    // yine de baslatirdi -- oldurulemeyen bir surec, ve kapanmayan router.
    let iptalEdildi = false;
    let child: ChildProcess | undefined;
    let onAbort: (() => void) | undefined;

    const done = (async (): Promise<void> => {
        if (options.task.trim() === "") {
            throw new RouterError("invalid_request", "Gemini task must not be empty.", 400);
        }
        if (iptalEdildi) throw new RouterError("upstream_timeout", "Gemini ACP session was cancelled before start.", 504);
        const systemSettings = await ensureGeminiOAuthConfiguration(options.home);
        child = spawnGemini(options, systemSettings);
        // Yaris: cancel() spawn ile bu satir arasinda gelmis olabilir.
        if (iptalEdildi) {
            child.kill();
            throw new RouterError("upstream_timeout", "Gemini ACP session was cancelled during start.", 504);
        }
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
