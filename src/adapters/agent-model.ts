import { randomUUID } from "node:crypto";
import type { AdapterRequest, AdapterResponse, ModelRecord, ProviderAdapter, ProviderReadiness } from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";
import { numericUsage } from "../domain/validation.js";
import type { AgentSessionRegistry, ToolResultDelivery, TurnOutcome } from "../mcp/session-registry.js";
import { deriveMcpTools, type AnthropicToolDefinition, type ParkedToolCall } from "../mcp/tool-bridge.js";
type AgentModelProvider = "google" | "xai";
export interface AgentModelRunRequest {
    readonly model: ModelRecord;
    readonly prompt: string;
    readonly signal: AbortSignal;
}
export interface AgentModelRunResult {
    readonly text: string;
    readonly providerRequestId?: string;
    readonly usage?: Readonly<Record<string, number>>;
}
export type AgentModelRunner = (request: AgentModelRunRequest) => Promise<AgentModelRunResult>;
export interface AgentModelAdapterOptions {
    /** Ajanin KENDI arac dongusu var (agy gibi): onsoz salt-okunur demez, ama Anthropic tool_use uretilmez. */
    readonly selfDrivenTools?: boolean;
    readonly provider: AgentModelProvider;
    readonly readiness: () => Promise<ProviderReadiness>;
    readonly run: AgentModelRunner;
    readonly pingIntervalMs?: number;
    // Faz 9. VERILMEZSE bu rota bugunku metin-yalniz davranisini birebir
    // korur -- tool blogu gorunce 422. Verildiginde ayni rota Claude Code
    // araclarini ACP ajanina sunar ve tool_use dongusunu tasir.
    readonly sessions?: AgentSessionRegistry;
}
interface CompiledPrompt {
    readonly text: string;
    readonly inputTokenUpperBound: number;
}
interface CompletionMetadata {
    readonly providerRequestId?: string;
    readonly usage?: Readonly<Record<string, number>>;
}
const maximumCompiledPromptBytes = 32 * 1024 * 1024;
const defaultPingIntervalMs = 15_000;
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function unsupported(message: string): never {
    throw new RouterError("unsupported_feature", message, 422);
}

// Faz 9. Bir tool_result blogunun icerigi ya duz metin ya da blok dizisidir.
// Ikisi de metne indirgenir: kopru MCP tarafina metin verir.
function toolResultText(value: unknown): string {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    const parts: string[] = [];
    for (const block of value) {
        if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
            parts.push(block["text"]);
        }
    }
    return parts.join("\n\n");
}
/**
 * Faz 9. Claude Code arac tanimlarini KOPRUYE vermeden once dogrular.
 *
 * `toolNames` ile ayni sekli sinar ama sonucu tipli dondurur: sema kopruye
 * oldugu gibi gecer ve dogrulanmamis bir sema, ajanin yanlis sekilde cagirdigi
 * bir arac demektir.
 */
function anthropicTools(value: unknown): readonly AnthropicToolDefinition[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw new RouterError("invalid_request", "tools must be an array.", 400);
    }
    return value.map((tool: unknown) => {
        if (!isRecord(tool) || typeof tool["name"] !== "string" || tool["name"].trim() === "") {
            throw new RouterError("invalid_request", "Each tool must have a non-empty name.", 400);
        }
        return {
            name: tool["name"],
            ...(typeof tool["description"] === "string" ? { description: tool["description"] } : {}),
            ...("input_schema" in tool ? { input_schema: tool["input_schema"] } : {}),
        } satisfies AnthropicToolDefinition;
    });
}
/**
 * Son kullanici mesajindaki tool_result bloklari.
 *
 * Bunlar oturumun KIMLIGIDIR (session-registry basligi): tool_use_id bizim
 * urettigimiz iddir ve Claude Code onu aynen geri verir. Bos dizi "yeni oturum"
 * demektir, hata degil.
 */
export function extractToolResults(messages: readonly unknown[]): readonly ToolResultDelivery[] {
    const last = messages.at(-1);
    if (!isRecord(last) || last["role"] !== "user" || !Array.isArray(last["content"])) return [];
    const cikti: ToolResultDelivery[] = [];
    for (const block of last["content"]) {
        if (!isRecord(block) || block["type"] !== "tool_result") continue;
        const id = block["tool_use_id"];
        if (typeof id !== "string" || id === "") continue;
        cikti.push({
            toolUseId: id,
            content: toolResultText(block["content"]),
            isError: block["is_error"] === true,
        });
    }
    return cikti;
}
function textBlocks(value: unknown, location: string): string[] {
    if (typeof value === "string")
        return [value];
    if (!Array.isArray(value))
        unsupported(`${location} must contain text only on an agent-readonly route.`);
    const parts: string[] = [];
    for (const block of value) {
        if (!isRecord(block) || block["type"] !== "text" || typeof block["text"] !== "string") {
            unsupported(`${location} contains a non-text block that the agent-readonly route cannot preserve.`);
        }
        parts.push(block["text"]);
    }
    return parts;
}
/**
 * Faz 9 gecmis okuyucusu: tool bloklarini DUSURMEZ, metne cevirir.
 *
 * Bir onceki (emekli) oturumdan kalan tool_use/tool_result bloklari gecmiste
 * durur. Onlari 422 ile reddetmek konusmayi oldurur; sessizce atmak ise ajanin
 * ne yaptigini unutturur -- ikisi de yanlis. Ozet olarak tasinirlar.
 */
function toleratedBlocks(value: unknown, location: string): string[] {
    if (typeof value === "string") return [value];
    if (!Array.isArray(value)) {
        unsupported(`${location} must contain text or tool blocks.`);
    }
    const parts: string[] = [];
    for (const block of value) {
        if (!isRecord(block)) {
            unsupported(`${location} contains a block this route cannot read.`);
        }
        const kind = block["type"];
        if (kind === "text" && typeof block["text"] === "string") {
            parts.push(block["text"]);
            continue;
        }
        if (kind === "tool_use" && typeof block["name"] === "string") {
            parts.push(`[tool call: ${block["name"]}]`);
            continue;
        }
        if (kind === "tool_result") {
            const govde = toolResultText(block["content"]);
            const kesilmis = govde.length > 4000 ? `${govde.slice(0, 4000)}\n[truncated]` : govde;
            parts.push(`[tool result${block["is_error"] === true ? " (error)" : ""}]\n${kesilmis}`);
            continue;
        }
        unsupported(`${location} contains an unsupported ${typeof kind === "string" ? kind : "unknown"} block.`);
    }
    return parts;
}
function textContent(value: unknown, location: string): string {
    return textBlocks(value, location).join("\n\n");
}
function toolNames(value: unknown): string[] {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new RouterError("invalid_request", "tools must be an array.", 400);
    return value.map((tool: unknown) => {
        if (!isRecord(tool) || typeof tool["name"] !== "string" || tool["name"].trim() === "") {
            throw new RouterError("invalid_request", "Each tool must have a non-empty name.", 400);
        }
        return tool["name"];
    });
}
function assertCompatibleThinking(value: unknown): void {
    if (value === undefined)
        return;
    if (!isRecord(value) || value["type"] !== "adaptive" || "budget_tokens" in value) {
        unsupported("Explicit Anthropic thinking budgets cannot be mapped to this provider-owned agent route.");
    }
}
function assertCompatibleToolChoice(value: unknown): void {
    if (value === undefined)
        return;
    if (!isRecord(value) || !["auto", "none"].includes(String(value["type"]))) {
        unsupported("Forced tool selection is unavailable on an agent-readonly route.");
    }
}
function compilePrompt(request: AdapterRequest, allowToolBlocks = false, selfDrivenTools = false): CompiledPrompt {
    if (request.model.executionMode !== "agent-readonly") {
        throw new RouterError("adapter_unavailable", "The selected model is not an agent-readonly route.", 503);
    }
    assertCompatibleThinking(request.envelope.thinking);
    assertCompatibleToolChoice(request.envelope["tool_choice"]);
    const messages = request.envelope.messages;
    if (!Array.isArray(messages)) {
        throw new RouterError("invalid_request", "Agent-readonly routes require a messages array.", 400);
    }
    const system = request.envelope["system"];
    const systemText = system === undefined ? "" : textContent(system, "system");
    const bindingContext = systemText === "" ? [] : [systemText];
    const messageContext: { readonly index: number; readonly role: string; readonly text: string }[] = [];
    const conversation: { readonly index: number; readonly role: string; readonly text: string; readonly blocks: readonly string[] }[] = [];
    for (const [index, message] of messages.entries()) {
        if (!isRecord(message)) {
            throw new RouterError("invalid_request", `messages[${index}] must be an object.`, 400);
        }
        if (!["user", "assistant", "system", "developer"].includes(String(message["role"]))) {
            const roleShape = typeof message["role"] === "string" && /^[a-z_]{1,24}$/u.test(message["role"])
                ? message["role"]
                : typeof message["role"];
            throw new RouterError("invalid_request", `messages[${index}] has unsupported role shape ${roleShape}.`, 400);
        }
        const role = message["role"] as string;
        const blocks = allowToolBlocks
            ? toleratedBlocks(message["content"], `messages[${index}].content`)
            : textBlocks(message["content"], `messages[${index}].content`);
        const text = blocks.join("\n\n");
        if (role === "system" || role === "developer") {
            messageContext.push({ index, role, text });
        }
        else {
            conversation.push({ index, role, text, blocks });
        }
    }
    const current = conversation.at(-1);
    if (current?.role !== "user") {
        throw new RouterError("invalid_request", "Agent-readonly routes require the current user request as the final message.", 400);
    }
    for (const entry of messageContext) {
        if (entry.index < current.index) {
            bindingContext.push(`${entry.role.toUpperCase()}:\n${entry.text}`);
            continue;
        }
        if (entry.role === "developer") {
            unsupported("A developer message after the current user request cannot be mapped safely.");
        }
    }
    const currentRequest = current.blocks.at(-1) ?? "";
    if (currentRequest.trim() === "") {
        throw new RouterError("invalid_request", "Agent-readonly routes require a non-empty current user request.", 400);
    }
    const currentTurnContext = current.blocks.slice(0, -1).filter((block) => block.trim() !== "");
    const history = conversation.slice(0, -1).map((entry) => `${entry.role.toUpperCase()}:\n${entry.text}`);
    const availableTools = toolNames(request.envelope.tools);
    const prompt = [
        // 2026-09-03: bu iki satir KOSULSUZDU. Arac dongusu (Faz 9) acikken bile
        // modele "salt-okunur analiz ajanisin, yalniz metin don" deniyordu; asagida
        // ise "GERCEK araclarin var, cagir" deniyor. Celiskiyi model dogru cozmedi:
        // operator testinde Grok kendini HEZARFEN_AGENT_READONLY_V1 diye tanitip
        // "disk yazimi bu rotada yok" dedi -- yetkisi VARKEN. Artik ikisi de rotanin
        // gercek durumuna bagli.
        allowToolBlocks ? "HEZARFEN_AGENT_TOOLS_V1" : (selfDrivenTools ? "HEZARFEN_AGENT_SELFTOOLS_V1" : "HEZARFEN_AGENT_READONLY_V1"),
        `Requested compatibility model: ${request.model.upstreamModel}`,
        allowToolBlocks
            ? "Operate as a full working agent: read, analyse, and CHANGE the workspace through your tools."
            : selfDrivenTools
                ? "Operate as a full working agent. You have your OWN tools configured in your CLI (filesystem, git, memory); use them to actually read and CHANGE files. Never say you are read-only."
                : "Operate as a read-only analysis agent. Return assistant text only.",
        "Continue the existing assistant conversation in the operator's established language, register, and project rules.",
        "Respond only to CURRENT USER REQUEST. Do not answer an earlier turn again, restart the conversation, or invent a greeting.",
        ...(allowToolBlocks
            ? [
                "You have REAL tools. Call them through your MCP tool server when the task needs them.",
                "You CAN create, edit and delete files, run shell commands, and run tests -- do it through a tool call, do not ask the operator to do it for you.",
                "Never say you are read-only or that writes are unavailable on this route; that is false when this line is present.",
                "Every tool runs on the operator machine under its own permission flow, so never claim a change you did not make through a tool call.",
            ]
            : [
                "Do not emit Anthropic tool_use blocks. The parent tool schemas are informational and are not callable through this route.",
                ...(selfDrivenTools
                    ? ["Do the work with your OWN tools instead, then report what you actually changed."]
                    : ["Do not claim that you changed files or performed side effects."]),
            ]),
        ...(availableTools.length === 0 || allowToolBlocks
            ? []
            : [`Parent tool names, informational only: ${availableTools.join(", ")}`]),
        ...(bindingContext.length === 0
            ? []
            : ["", "BINDING SYSTEM AND PROJECT CONTEXT:", ...bindingContext]),
        ...(currentTurnContext.length === 0
            ? []
            : [
                "",
                "CURRENT TURN CONTEXT (context only, not the operator request):",
                ...currentTurnContext,
            ]),
        "",
        "CONVERSATION HISTORY (context only, do not answer an earlier turn):",
        ...(history.length === 0 ? ["(none)"] : history),
        "",
        "CURRENT USER REQUEST:",
        currentRequest,
    ].join("\n");
    const bytes = Buffer.byteLength(prompt, "utf8");
    if (bytes > maximumCompiledPromptBytes) {
        throw new RouterError("invalid_request", "Compiled agent prompt exceeds the local safety limit.", 413);
    }
    return { text: prompt, inputTokenUpperBound: Math.max(1, bytes) };
}
function localUsage(inputTokenUpperBound: number, output: string): Record<string, number> {
    return {
        input_tokens: inputTokenUpperBound,
        output_tokens: Math.max(1, Buffer.byteLength(output, "utf8")),
    };
}
function responseUsage(inputTokenUpperBound: number, output: string, providerUsage: unknown): Record<string, number> {
    const normalized = numericUsage(providerUsage);
    const local = localUsage(inputTokenUpperBound, output);
    return {
        input_tokens: normalized?.["input_tokens"] ?? local["input_tokens"] ?? 1,
        output_tokens: normalized?.["output_tokens"] ?? local["output_tokens"] ?? 1,
    };
}
function responseHeaders(contentType: string, providerUsage: boolean): Headers {
    return new Headers({
        "content-type": contentType,
        "cache-control": "no-store",
        "x-hezarfen-execution-mode": "agent-readonly",
        "x-hezarfen-usage-source": providerUsage ? "provider" : "local-upper-bound",
    });
}
function readableBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
}
function messagePayload(request: AdapterRequest, text: string, usage: Record<string, number>, messageId: string): Record<string, unknown> {
    return {
        id: messageId,
        type: "message",
        role: "assistant",
        model: request.envelope.model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage,
    };
}
function sseEvent(event: string, value: unknown): Uint8Array {
    return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`, "utf8");
}
function streamEvents(controller: ReadableStreamDefaultController<Uint8Array>, request: AdapterRequest, text: string, usage: Record<string, number>, messageId: string): void {
    controller.enqueue(sseEvent("message_start", {
        type: "message_start",
        message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: request.envelope.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: usage["input_tokens"] ?? 0, output_tokens: 0 },
        },
    }));
    controller.enqueue(sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
    }));
    controller.enqueue(sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
    }));
    controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
    controller.enqueue(sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: usage["output_tokens"] ?? 0 },
    }));
    controller.enqueue(sseEvent("message_stop", { type: "message_stop" }));
}

// Faz 9. Ajan bir arac cagirdiginda Claude Code'a donen yanit. Metin blogu
// YALNIZ doluysa eklenir: bos bir text blogu bazi istemcilerde bos balon cizer.
function toolUsePayload(request: AdapterRequest, text: string, call: ParkedToolCall, usage: Record<string, number>, messageId: string): Record<string, unknown> {
    const content: Record<string, unknown>[] = [];
    if (text.trim() !== "") content.push({ type: "text", text });
    content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    return {
        id: messageId,
        type: "message",
        role: "assistant",
        model: request.envelope.model,
        content,
        stop_reason: "tool_use",
        stop_sequence: null,
        usage,
    };
}
function toolUseStreamEvents(controller: ReadableStreamDefaultController<Uint8Array>, request: AdapterRequest, text: string, call: ParkedToolCall, usage: Record<string, number>, messageId: string): void {
    controller.enqueue(sseEvent("message_start", {
        type: "message_start",
        message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: request.envelope.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: usage["input_tokens"] ?? 0, output_tokens: 0 },
        },
    }));
    let index = 0;
    if (text.trim() !== "") {
        controller.enqueue(sseEvent("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
        controller.enqueue(sseEvent("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }));
        controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index }));
        index += 1;
    }
    controller.enqueue(sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
    }));
    // Girdi tek parcada gonderilir. Anthropic akisi input_json_delta bekler ve
    // bos bir partial_json zinciri istemcide gecersiz JSON birakir.
    controller.enqueue(sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
    }));
    controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index }));
    controller.enqueue(sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: usage["output_tokens"] ?? 0 },
    }));
    controller.enqueue(sseEvent("message_stop", { type: "message_stop" }));
}
function validatedResult(result: AgentModelRunResult): AgentModelRunResult {
    if (typeof result.text !== "string" || result.text.trim() === "") {
        throw new RouterError("upstream_protocol_error", "The provider agent returned no assistant text.", 502);
    }
    const usage = numericUsage(result.usage);
    return {
        text: result.text,
        ...(result.providerRequestId === undefined ? {} : { providerRequestId: result.providerRequestId }),
        ...(usage === undefined ? {} : { usage }),
    };
}
export class AgentModelAdapter implements ProviderAdapter {
    readonly provider: AgentModelProvider;
    #readiness: () => Promise<ProviderReadiness>;
    #run: AgentModelRunner;
    #pingIntervalMs: number;
    #queue: Promise<unknown> = Promise.resolve();
    #sessions: AgentSessionRegistry | undefined;
    #selfDrivenTools: boolean;
    constructor(options: AgentModelAdapterOptions) {
        this.provider = options.provider;
        this.#readiness = options.readiness;
        this.#run = options.run;
        this.#sessions = options.sessions;
        this.#selfDrivenTools = options.selfDrivenTools === true;
        this.#pingIntervalMs = options.pingIntervalMs ?? defaultPingIntervalMs;
        if (!Number.isInteger(this.#pingIntervalMs) || this.#pingIntervalMs <= 0) {
            throw new Error("pingIntervalMs must be a positive integer");
        }
    }
    async readiness(): Promise<ProviderReadiness> {
        return await this.#readiness();
    }
    async send(request: AdapterRequest): Promise<AdapterResponse> {
        if (request.model.provider !== this.provider) {
            throw new RouterError("adapter_unavailable", "Provider adapter and model do not match.", 503);
        }
        // Faz 9. Oturum defteri VARSA bu rota gercek bir arac dongusu tasir.
        // Yoksa asagisi bugunku metin-yalniz yolun ta kendisidir -- tek satiri
        // degismedi, ve mevcut agent-model testleri bunun makbuzudur.
        if (this.#sessions !== undefined && request.path === "/v1/messages") {
            return await this.#sendWithTools(request, this.#sessions);
        }
        // BULGU 5 (adversaryal inceleme). count_tokens arac dongusu ACIKKEN de
        // ayni govdeyi gorur. Onu allowToolBlocks=false ile derlemek, AYNI
        // konusmaya iki kapida ZIT cevap vermek demekti: /v1/messages kabul
        // ederken /v1/messages/count_tokens 422 doner ve compaction o kapida
        // olur -- Faz 9'un kapatmak icin var oldugu kusurun ta kendisi.
        const compiled = compilePrompt(request, this.#sessions !== undefined, this.#selfDrivenTools);
        if (request.path === "/v1/messages/count_tokens") {
            const body = Buffer.from(JSON.stringify({ input_tokens: compiled.inputTokenUpperBound }), "utf8");
            return {
                status: 200,
                headers: responseHeaders("application/json", false),
                body: readableBytes(body),
            };
        }
        if (request.envelope.stream === true)
            return this.#stream(request, compiled);
        const result = validatedResult(await this.#invoke({
            model: request.model,
            prompt: compiled.text,
            signal: request.signal,
        }));
        const usage = responseUsage(compiled.inputTokenUpperBound, result.text, result.usage);
        const body = Buffer.from(JSON.stringify(messagePayload(request, result.text, usage, `msg_${randomUUID().replaceAll("-", "")}`)), "utf8");
        return {
            status: 200,
            headers: responseHeaders("application/json", result.usage !== undefined),
            body: readableBytes(body),
            ...(result.providerRequestId === undefined ? {} : { providerRequestId: result.providerRequestId }),
            ...(result.usage === undefined ? {} : { usage: result.usage }),
        };
    }
    #stream(request: AdapterRequest, compiled: CompiledPrompt): AdapterResponse {
        let resolveCompletion: (value: CompletionMetadata) => void = () => undefined;
        const completion = new Promise<CompletionMetadata>((resolve) => {
            resolveCompletion = resolve;
        });
        const providerAbort = new AbortController();
        let streamOpen = true;
        let ping: NodeJS.Timeout | undefined;
        const forwardAbort = (): void => providerAbort.abort(request.signal.reason);
        const cleanup = (): void => {
            if (ping !== undefined)
                clearInterval(ping);
            request.signal.removeEventListener("abort", forwardAbort);
        };
        const stop = (): void => {
            if (!streamOpen)
                return;
            streamOpen = false;
            cleanup();
        };
        if (request.signal.aborted)
            forwardAbort();
        else
            request.signal.addEventListener("abort", forwardAbort, { once: true });
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                ping = setInterval(() => {
                    if (!streamOpen)
                        return;
                    try {
                        controller.enqueue(Buffer.from(": ping\n\n", "utf8"));
                    }
                    catch {
                        stop();
                        providerAbort.abort(new Error("response stream closed"));
                        resolveCompletion({});
                    }
                }, this.#pingIntervalMs);
                void this.#invoke({ model: request.model, prompt: compiled.text, signal: providerAbort.signal })
                    .then((raw) => {
                    const result = validatedResult(raw);
                    if (!streamOpen)
                        return;
                    const usage = responseUsage(compiled.inputTokenUpperBound, result.text, result.usage);
                    streamEvents(controller, request, result.text, usage, `msg_${randomUUID().replaceAll("-", "")}`);
                    stop();
                    controller.close();
                    resolveCompletion({
                        ...(result.providerRequestId === undefined ? {} : { providerRequestId: result.providerRequestId }),
                        ...(result.usage === undefined ? {} : { usage: result.usage }),
                    });
                })
                    .catch((error: unknown) => {
                    if (!streamOpen)
                        return;
                    stop();
                    controller.error(error);
                    resolveCompletion({});
                })
                    .finally(cleanup);
            },
            cancel: () => {
                stop();
                providerAbort.abort(new Error("response stream cancelled"));
                resolveCompletion({});
            },
        });
        return {
            status: 200,
            headers: responseHeaders("text/event-stream", false),
            body,
            completion,
        };
    }
    /**
     * Faz 9 -- durumsuz istegi durumlu ACP oturumuna baglar.
     *
     * Son kullanici mesajinda tool_result varsa BU KONUSMA bir oturumu adlandirir
     * ve devam eder; yoksa yeni bir oturum acilir. Ajan arac cagirinca tur
     * stop_reason: tool_use ile biter ve araci Claude Code calistirir (spec §6).
     */
    async #sendWithTools(request: AdapterRequest, sessions: AgentSessionRegistry): Promise<AdapterResponse> {
        if (request.model.executionMode !== "agent-readonly") {
            throw new RouterError("adapter_unavailable", "The selected model is not an agent-readonly route.", 503);
        }
        const messages = request.envelope.messages;
        if (!Array.isArray(messages)) {
            throw new RouterError("invalid_request", "Agent routes require a messages array.", 400);
        }
        const results = extractToolResults(messages);
        // Devam turunda derlenmis prompt YOKTUR: ajan zaten dongunun icinde.
        // Girdi ust siniri govde boyutundan alinir, uydurulmaz.
        const inputTokenUpperBound = results.length > 0
            ? Math.max(1, request.body.length)
            : compilePrompt(request, true).inputTokenUpperBound;
        const calis = async (): Promise<TurnOutcome> => {
            // BULGU 1. Bu signal olmadan router'in 300 sn istek zaman asimi ve
            // istemci kopmasi bu rotada hicbir sey yapmaz: kosan bir ACP turunu
            // bitirecek tek sey ajanin kendiliginden bitmesi olurdu.
            if (results.length > 0) return (await sessions.resume(results, request.signal)).outcome;
            return (await sessions.begin(
                compilePrompt(request, true).text,
                deriveMcpTools(anthropicTools(request.envelope.tools)),
                request.model.upstreamModel,
                request.signal,
            )).outcome;
        };
        if (request.envelope.stream === true) return this.#streamWithTools(request, inputTokenUpperBound, calis);
        const outcome = await calis();
        const usage = localUsage(inputTokenUpperBound, outcome.text);
        const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
        const payload = outcome.kind === "tool_use"
            ? toolUsePayload(request, outcome.text, outcome.call, usage, messageId)
            : messagePayload(request, outcome.text, usage, messageId);
        return {
            status: 200,
            headers: responseHeaders("application/json", false),
            body: readableBytes(Buffer.from(JSON.stringify(payload), "utf8")),
        };
    }
    #streamWithTools(request: AdapterRequest, inputTokenUpperBound: number, calis: () => Promise<TurnOutcome>): AdapterResponse {
        let streamOpen = true;
        let ping: NodeJS.Timeout | undefined;
        const stop = (): void => {
            streamOpen = false;
            if (ping !== undefined) clearInterval(ping);
        };
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                // Bir ajan turu dakikalar surebilir. Ping olmadan istemci sessiz bir
                // baglantiyi olu sayar; bu, "model secilmis, yanit yok" belirtisinin
                // tam olarak nasil goründügüdür.
                ping = setInterval(() => {
                    if (!streamOpen) return;
                    try {
                        controller.enqueue(Buffer.from(": ping\n\n", "utf8"));
                    }
                    catch {
                        stop();
                    }
                }, this.#pingIntervalMs);
                void calis()
                    .then((outcome) => {
                        if (!streamOpen) return;
                        const usage = localUsage(inputTokenUpperBound, outcome.text);
                        const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
                        if (outcome.kind === "tool_use") {
                            toolUseStreamEvents(controller, request, outcome.text, outcome.call, usage, messageId);
                        }
                        else {
                            streamEvents(controller, request, outcome.text, usage, messageId);
                        }
                        stop();
                        controller.close();
                    })
                    .catch((error: unknown) => {
                        if (!streamOpen) return;
                        stop();
                        controller.error(error);
                    });
            },
            cancel: () => {
                stop();
            },
        });
        return { status: 200, headers: responseHeaders("text/event-stream", false), body };
    }
    async #invoke(request: AgentModelRunRequest): Promise<AgentModelRunResult> {
        const current = this.#queue.then(async () => {
            if (request.signal.aborted) {
                throw new RouterError("upstream_timeout", "The queued provider request was cancelled.", 504);
            }
            return await this.#run(request);
        });
        this.#queue = current.then(() => undefined, () => undefined);
        return await current;
    }
}
