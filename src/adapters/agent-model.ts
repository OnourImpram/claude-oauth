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
    /** The agent has its OWN tool loop (like agy): the preamble does not say read-only, but no Anthropic tool_use is produced. */
    readonly selfDrivenTools?: boolean;
    readonly provider: AgentModelProvider;
    readonly readiness: () => Promise<ProviderReadiness>;
    readonly run: AgentModelRunner;
    readonly pingIntervalMs?: number;
    // Phase 9. IF NOT SUPPLIED, this route preserves today's text-only behaviour
    // exactly -- 422 as soon as it sees a tool block. When supplied, the same route
    // exposes Claude Code's tools to the ACP agent and carries the tool_use loop.
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

// Phase 9. The content of a tool_result block is either plain text or an array of blocks.
// Both are reduced to text: the bridge hands text to the MCP side.
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
 * Phase 9. Validates Claude Code tool definitions before handing them to the BRIDGE.
 *
 * It checks the same shape as `toolNames` but returns the result typed: the schema
 * passes through to the bridge as-is, and an unvalidated schema means a tool the
 * agent calls in the wrong shape.
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
 * The tool_result blocks in the last user message.
 *
 * These are the session's IDENTITY (see the session-registry header): the tool_use_id
 * is the id we generated and Claude Code returns it verbatim. An empty array means
 * "new session", not an error.
 */
export function extractToolResults(messages: readonly unknown[]): readonly ToolResultDelivery[] {
    const last = messages.at(-1);
    if (!isRecord(last) || last["role"] !== "user" || !Array.isArray(last["content"])) return [];
    const output: ToolResultDelivery[] = [];
    for (const block of last["content"]) {
        if (!isRecord(block) || block["type"] !== "tool_result") continue;
        const id = block["tool_use_id"];
        if (typeof id !== "string" || id === "") continue;
        output.push({
            toolUseId: id,
            content: toolResultText(block["content"]),
            isError: block["is_error"] === true,
        });
    }
    return output;
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
 * Phase 9 history reader: it does NOT DROP tool blocks, it converts them to text.
 *
 * tool_use/tool_result blocks left over from a previous (retired) session stay in the
 * history. Rejecting them with 422 kills the conversation; dropping them silently makes
 * the agent forget what it did -- both are wrong. They are carried over as a summary.
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
        // 2026-09-03: these two lines were UNCONDITIONAL. Even with the tool loop
        // (Phase 9) on, the model was told "you are a read-only analysis agent, return
        // text only", while below it was told "you have REAL tools, call them". The
        // model did not resolve the contradiction correctly: in the operator test Grok
        // introduced itself as HEZARFEN_AGENT_READONLY_V1 and said "writing to disk is
        // not available on this route" -- WHILE IT HAD the authority. Both now depend on
        // the route's real state.
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

// Phase 9. The response returned to Claude Code when the agent calls a tool. The text
// block is added ONLY if it is non-empty: an empty text block draws an empty bubble in
// some clients.
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
    // The input is sent in a single chunk. The Anthropic stream expects input_json_delta,
    // and an empty partial_json chain leaves invalid JSON on the client.
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
        // Phase 9. IF the session registry is present, this route carries a real tool
        // loop. If not, what follows is exactly today's text-only path -- not a single
        // line of it changed, and the existing agent-model tests are the receipt.
        if (this.#sessions !== undefined && request.path === "/v1/messages") {
            return await this.#sendWithTools(request, this.#sessions);
        }
        // FINDING 5 (adversarial review). count_tokens sees the same body even when the
        // tool loop is ON. Compiling it with allowToolBlocks=false meant giving OPPOSITE
        // answers to the SAME conversation at two gates: /v1/messages accepts it while
        // /v1/messages/count_tokens returns 422, and compaction dies at that gate -- the
        // very defect Phase 9 exists to close.
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
     * Phase 9 -- binds the stateless request to a stateful ACP session.
     *
     * If the last user message carries a tool_result, THIS CONVERSATION names a session
     * and resumes it; otherwise a new session is opened. When the agent calls a tool the
     * turn ends with stop_reason: tool_use and Claude Code runs the tool (spec §6).
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
        // On a resume turn there is NO compiled prompt: the agent is already inside the
        // loop. The input upper bound is taken from the body size, not invented.
        const inputTokenUpperBound = results.length > 0
            ? Math.max(1, request.body.length)
            : compilePrompt(request, true).inputTokenUpperBound;
        const runTurn = async (): Promise<TurnOutcome> => {
            // FINDING 1. Without this signal the router's 300 s request timeout and the
            // client disconnect do nothing on this route: the only thing that would end a
            // running ACP turn would be the agent finishing on its own.
            if (results.length > 0) return (await sessions.resume(results, request.signal)).outcome;
            return (await sessions.begin(
                compilePrompt(request, true).text,
                deriveMcpTools(anthropicTools(request.envelope.tools)),
                request.model.upstreamModel,
                request.signal,
            )).outcome;
        };
        if (request.envelope.stream === true) return this.#streamWithTools(request, inputTokenUpperBound, runTurn);
        const outcome = await runTurn();
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
    #streamWithTools(request: AdapterRequest, inputTokenUpperBound: number, runTurn: () => Promise<TurnOutcome>): AdapterResponse {
        let streamOpen = true;
        let ping: NodeJS.Timeout | undefined;
        const stop = (): void => {
            streamOpen = false;
            if (ping !== undefined) clearInterval(ping);
        };
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                // An agent turn can take minutes. Without a ping the client treats a silent
                // connection as dead; that is exactly what the "model selected, no answer"
                // symptom looks like.
                ping = setInterval(() => {
                    if (!streamOpen) return;
                    try {
                        controller.enqueue(Buffer.from(": ping\n\n", "utf8"));
                    }
                    catch {
                        stop();
                    }
                }, this.#pingIntervalMs);
                void runTurn()
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
