import { randomUUID } from "node:crypto";
import { RouterError } from "../domain/errors.js";
interface StreamBlock {
    readonly index: number;
    readonly kind: "text" | "thinking" | "tool";
}
/**
 * OpenAI chat-completions SSE -> Anthropic Messages SSE. Written for the old Grok HTTP path and
 * since shared by the chat-completions API-key lanes; the defaults reproduce the original
 * behaviour.
 */
export interface ChatStreamOptions {
    /** Lane name used in every error message. */
    readonly label?: string;
    /**
     * Emit upstream reasoning as Anthropic thinking blocks. Default true (original behaviour).
     * The API-key lanes turn it off: an unsigned thinking block that Claude Code later replays to a Claude
     * model is a 400 there, and the reasoning text is not the answer.
     */
    readonly emitReasoning?: boolean;
    /**
     * Called exactly once when the stream ends, however it ends (done, error, cancel), with
     * whatever usage and id had been seen. Receipts wait on this; a callback that could be
     * skipped would hang the receipt of a cancelled turn.
     */
    readonly onComplete?: (outcome: { readonly usage?: Readonly<Record<string, number>>; readonly providerRequestId?: string }) => void;
    /**
     * Credential values of the lane. An upstream error quoted from inside the stream is scrubbed
     * of each one first, the same rule the HTTP-status path applies to an error body.
     */
    readonly secrets?: readonly string[];
    /**
     * Called each time the upstream delivers bytes. The translated body cannot be declared the
     * provider's own (it carries a router-made ping every 15 s), so this is how a translating
     * lane tells the router's silence guard that the provider spoke: adapters pass
     * `request.upstreamActivity`. The ping never calls it.
     */
    readonly onUpstreamRead?: () => void;
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sse(event: string, data: unknown): Uint8Array {
    return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, "utf8");
}
const ERROR_SNIPPET_LIMIT = 300;
// An error `type` or `code` that names a deterministic condition (audit D2-05).
const DETERMINISTIC_ERROR_NAME = /context[_ -]?(?:length|window)|invalid[_ -]?request/iu;
/**
 * An error object streamed AFTER the headers (`data: {"error":{"message":...,"code":...}}`, no
 * `choices`): OpenAI-style servers send one when generation fails mid-response. The reason is
 * quoted the way the HTTP-status path quotes an error body -- key-scrubbed, whitespace-collapsed,
 * bounded to 300 characters -- and the status follows the same classes: a 400/413/422 code (or a
 * type/code naming a context-length or invalid-request condition) is a 400-class error so the
 * client does not retry a deterministic failure, 429 is the lane's rate-limit error, anything
 * else stays a 502. Undefined when the record carries no error object.
 */
function streamedUpstreamError(value: Record<string, unknown>, label: string, secrets: readonly string[]): RouterError | undefined {
    const raw = value["error"];
    const error = isRecord(raw) ? raw : typeof raw === "string" && raw !== "" ? { message: raw } : undefined;
    if (error === undefined)
        return undefined;
    const message = typeof error["message"] === "string" ? error["message"] : "";
    const scrubbed = secrets.reduce((current, secret) => secret === "" ? current : current.split(secret).join("[redacted]"), message);
    const snippet = scrubbed.replace(/\s+/gu, " ").trim().slice(0, ERROR_SNIPPET_LIMIT);
    const detail = snippet === "" ? "" : ` Upstream said: ${snippet}`;
    const code = error["code"];
    const numeric = typeof code === "number" && Number.isInteger(code) ? code : typeof code === "string" && /^\d{3}$/u.test(code.trim()) ? Number(code.trim()) : undefined;
    const named = [code, error["type"]].some((entry) => typeof entry === "string" && DETERMINISTIC_ERROR_NAME.test(entry));
    const codeNote = numeric === undefined ? "" : ` (upstream code ${numeric})`;
    if (numeric === 429)
        return new RouterError("provider_rate_limited", `${label} rate limit${codeNote} reported inside the stream.${detail}`, 429);
    if (numeric === 400 || numeric === 413 || numeric === 422 || named)
        return new RouterError("invalid_request", `${label} rejected the request${codeNote} inside the stream.${detail}`, 400);
    return new RouterError("upstream_protocol_error", `${label} reported an error${codeNote} inside the stream.${detail}`, 502);
}
function parseChunk(data: string, label: string, secrets: readonly string[]): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(data);
    }
    catch (error) {
        throw new RouterError("upstream_protocol_error", `${label} emitted malformed SSE JSON.`, 502, { cause: error });
    }
    if (isRecord(value) && !Array.isArray(value["choices"])) {
        const reported = streamedUpstreamError(value, label, secrets);
        if (reported !== undefined)
            throw reported;
    }
    if (!isRecord(value) || !Array.isArray(value["choices"])) {
        throw new RouterError("upstream_protocol_error", `${label} emitted an invalid chat completion chunk.`, 502);
    }
    return value;
}
// Only the two standard counters are read. Anything else a provider adds to `usage` (a vendor
// object, `*_details`) is ignored on purpose: a vendor extension must not be able
// to break the parse, and a nested object is not a token count.
export function usageObject(value: unknown): { readonly input_tokens: number; readonly output_tokens: number } {
    if (!isRecord(value))
        return { input_tokens: 0, output_tokens: 0 };
    return {
        input_tokens: typeof value["prompt_tokens"] === "number" ? value["prompt_tokens"] : 0,
        output_tokens: typeof value["completion_tokens"] === "number" ? value["completion_tokens"] : 0,
    };
}
function stopReason(value: unknown): string {
    if (value === "length")
        return "max_tokens";
    if (value === "tool_calls")
        return "tool_use";
    // The provider cut the answer (audit D2-06): a filtered, partial answer must not look finished.
    if (value === "content_filter")
        return "refusal";
    return "end_turn";
}
/**
 * Whether a parsed chat-completions chunk is the provider speaking: usage, a finish reason, or a
 * delta carrying text, reasoning or a tool call. Reasoning counts on purpose: a model that is
 * thinking out loud is working, and cutting it would be the old duration cap under a new name.
 */
function chunkSpeaks(chunk: Record<string, unknown>): boolean {
    if (chunk["usage"] !== undefined && chunk["usage"] !== null)
        return true;
    const choices: readonly unknown[] = Array.isArray(chunk["choices"]) ? chunk["choices"] : [];
    return choices.some((choice) => {
        if (typeof choice !== "object" || choice === null || Array.isArray(choice))
            return false;
        const record = choice as Record<string, unknown>;
        if (record["finish_reason"] !== undefined && record["finish_reason"] !== null)
            return true;
        const rawDelta = record["delta"];
        if (typeof rawDelta !== "object" || rawDelta === null || Array.isArray(rawDelta))
            return false;
        const delta = rawDelta as Record<string, unknown>;
        return (typeof delta["content"] === "string" && delta["content"] !== "") ||
            (reasoningText(delta) ?? "") !== "" ||
            (Array.isArray(delta["tool_calls"]) && delta["tool_calls"].length > 0);
    });
}
function reasoningText(delta: Record<string, unknown>): string | undefined {
    for (const key of ["reasoning_content", "reasoning"]) {
        const value = delta[key];
        if (typeof value === "string" && value !== "")
            return value;
    }
    return undefined;
}
export function openAiSseToAnthropic(upstream: ReadableStream<Uint8Array>, configuredModel: string, options: ChatStreamOptions = {}): ReadableStream<Uint8Array> {
    const label = options.label ?? "Grok";
    const emitReasoning = options.emitReasoning ?? true;
    const secrets = options.secrets ?? [];
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let started = false;
    let doneMarker = false;
    let nextBlockIndex = 0;
    let textBlock: StreamBlock | undefined;
    let thinkingBlock: StreamBlock | undefined;
    const toolBlocks = new Map<number, StreamBlock>();
    const toolIds = new Map<number, string>();
    let finalReason = "end_turn";
    let finalUsage: { readonly input_tokens: number; readonly output_tokens: number } = { input_tokens: 0, output_tokens: 0 };
    let sawUsage = false;
    let providerRequestId: string | undefined;
    let completed = false;
    const complete = (): void => {
        if (completed)
            return;
        completed = true;
        options.onComplete?.({
            ...(sawUsage ? { usage: finalUsage } : {}),
            ...(providerRequestId === undefined ? {} : { providerRequestId }),
        });
    };
    return new ReadableStream({
        async start(controller) {
            let ping: NodeJS.Timeout | undefined;
            try {
                ping = setInterval(() => controller.enqueue(sse("ping", { type: "ping" })), 15_000);
                for (;;) {
                    const result = await reader.read();
                    if (result.done)
                        break;
                    buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r", "");
                    for (;;) {
                        const boundary = buffer.indexOf("\n\n");
                        if (boundary < 0)
                            break;
                        const eventText = buffer.slice(0, boundary);
                        buffer = buffer.slice(boundary + 2);
                        const data = eventText
                            .split("\n")
                            .filter((line) => line.startsWith("data:"))
                            .map((line) => line.slice(5).trimStart())
                            .join("\n");
                        if (data === "")
                            continue;
                        if (data === "[DONE]") {
                            doneMarker = true;
                            continue;
                        }
                        const chunk = parseChunk(data, label, secrets);
                        // Audit D3-02: the router's silence guard is re-armed by what the provider
                        // SAYS, not by every byte it sends. An SSE comment never gets here (it has no
                        // `data:` line) and a chunk whose deltas are all empty is a keep-alive in JSON
                        // clothing; neither proves the model is producing anything.
                        if (chunkSpeaks(chunk))
                            options.onUpstreamRead?.();
                        if (!started) {
                            started = true;
                            if (typeof chunk["id"] === "string")
                                providerRequestId = chunk["id"];
                            controller.enqueue(sse("message_start", {
                                type: "message_start",
                                message: {
                                    id: typeof chunk["id"] === "string" ? chunk["id"] : `msg_${randomUUID()}`,
                                    type: "message",
                                    role: "assistant",
                                    content: [],
                                    model: configuredModel,
                                    stop_reason: null,
                                    stop_sequence: null,
                                    usage: { input_tokens: 0, output_tokens: 0 },
                                },
                            }));
                        }
                        if (chunk["usage"] !== undefined && chunk["usage"] !== null) {
                            finalUsage = usageObject(chunk["usage"]);
                            sawUsage = true;
                        }
                        const choice = (chunk["choices"] as readonly unknown[])[0];
                        if (!isRecord(choice))
                            continue;
                        if (choice["finish_reason"] !== undefined && choice["finish_reason"] !== null) {
                            finalReason = stopReason(choice["finish_reason"]);
                        }
                        const delta = choice["delta"];
                        if (!isRecord(delta))
                            continue;
                        const reasoning = reasoningText(delta);
                        if (emitReasoning && reasoning !== undefined) {
                            if (thinkingBlock === undefined) {
                                thinkingBlock = { index: nextBlockIndex++, kind: "thinking" };
                                controller.enqueue(sse("content_block_start", {
                                    type: "content_block_start",
                                    index: thinkingBlock.index,
                                    content_block: { type: "thinking", thinking: "" },
                                }));
                            }
                            controller.enqueue(sse("content_block_delta", {
                                type: "content_block_delta",
                                index: thinkingBlock.index,
                                delta: { type: "thinking_delta", thinking: reasoning },
                            }));
                        }
                        if (typeof delta["content"] === "string" && delta["content"] !== "") {
                            if (textBlock === undefined) {
                                textBlock = { index: nextBlockIndex++, kind: "text" };
                                controller.enqueue(sse("content_block_start", {
                                    type: "content_block_start",
                                    index: textBlock.index,
                                    content_block: { type: "text", text: "" },
                                }));
                            }
                            controller.enqueue(sse("content_block_delta", {
                                type: "content_block_delta",
                                index: textBlock.index,
                                delta: { type: "text_delta", text: delta["content"] },
                            }));
                        }
                        if (Array.isArray(delta["tool_calls"])) {
                            for (const rawTool of delta["tool_calls"]) {
                                if (!isRecord(rawTool) || typeof rawTool["index"] !== "number") {
                                    throw new RouterError("upstream_protocol_error", `${label} emitted an invalid tool-call delta.`, 502);
                                }
                                const position = rawTool["index"];
                                const fn = isRecord(rawTool["function"]) ? rawTool["function"] : {};
                                let block = toolBlocks.get(position);
                                if (block === undefined) {
                                    const id = requiredToolString(rawTool["id"], "id", label);
                                    const name = requiredToolString(fn["name"], "name", label);
                                    block = { index: nextBlockIndex++, kind: "tool" };
                                    toolBlocks.set(position, block);
                                    toolIds.set(position, id);
                                    controller.enqueue(sse("content_block_start", {
                                        type: "content_block_start",
                                        index: block.index,
                                        content_block: { type: "tool_use", id, name, input: {} },
                                    }));
                                }
                                else if (rawTool["id"] !== undefined && rawTool["id"] !== null && rawTool["id"] !== "" && rawTool["id"] !== toolIds.get(position)) {
                                    throw new RouterError("upstream_protocol_error", `${label} changed a tool-call id mid-stream.`, 502);
                                }
                                if (typeof fn["arguments"] === "string" && fn["arguments"] !== "") {
                                    controller.enqueue(sse("content_block_delta", {
                                        type: "content_block_delta",
                                        index: block.index,
                                        delta: { type: "input_json_delta", partial_json: fn["arguments"] },
                                    }));
                                }
                            }
                        }
                    }
                }
                if (!doneMarker) {
                    throw new RouterError("upstream_protocol_error", `${label} stream ended without a DONE marker.`, 502);
                }
                const openBlocks = [thinkingBlock, textBlock, ...toolBlocks.values()]
                    .filter((block): block is StreamBlock => block !== undefined)
                    .sort((left, right) => left.index - right.index);
                for (const block of openBlocks) {
                    controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: block.index }));
                }
                if (!started) {
                    throw new RouterError("upstream_protocol_error", `${label} stream contained no completion chunks.`, 502);
                }
                controller.enqueue(sse("message_delta", {
                    type: "message_delta",
                    delta: { stop_reason: finalReason, stop_sequence: null },
                    usage: finalUsage,
                }));
                controller.enqueue(sse("message_stop", { type: "message_stop" }));
                controller.close();
            }
            catch (error) {
                controller.error(error);
            }
            finally {
                if (ping !== undefined)
                    clearInterval(ping);
                reader.releaseLock();
                complete();
            }
        },
        async cancel(reason) {
            complete();
            await reader.cancel(reason);
        },
    });
}
function requiredToolString(value: unknown, field: string, label: string): string {
    if (typeof value !== "string" || value === "") {
        throw new RouterError("upstream_protocol_error", `${label} tool-call ${field} is missing.`, 502);
    }
    return value;
}
/**
 * A non-streaming chat completion -> an Anthropic Messages response body. Reasoning is not
 * carried (same rule as the stream with emitReasoning=false), extra usage keys are ignored.
 */
export function openAiCompletionToAnthropic(value: unknown, configuredModel: string, label: string): Record<string, unknown> {
    if (!isRecord(value) || !Array.isArray(value["choices"])) {
        throw new RouterError("upstream_protocol_error", `${label} returned an invalid chat completion.`, 502);
    }
    const choice = value["choices"][0];
    const message = isRecord(choice) && isRecord(choice["message"]) ? choice["message"] : {};
    const content: Record<string, unknown>[] = [];
    if (typeof message["content"] === "string" && message["content"] !== "") {
        content.push({ type: "text", text: message["content"] });
    }
    if (Array.isArray(message["tool_calls"])) {
        for (const call of message["tool_calls"]) {
            const fn = isRecord(call) && isRecord(call["function"]) ? call["function"] : {};
            const id = requiredToolString(isRecord(call) ? call["id"] : undefined, "id", label);
            const name = requiredToolString(fn["name"], "name", label);
            let input: unknown = {};
            if (typeof fn["arguments"] === "string" && fn["arguments"] !== "") {
                try {
                    input = JSON.parse(fn["arguments"]);
                }
                catch (error) {
                    throw new RouterError("upstream_protocol_error", `${label} returned tool arguments that are not JSON.`, 502, { cause: error });
                }
            }
            content.push({ type: "tool_use", id, name, input });
        }
    }
    return {
        id: typeof value["id"] === "string" ? value["id"] : `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: configuredModel,
        content,
        stop_reason: stopReason(isRecord(choice) ? choice["finish_reason"] : undefined),
        stop_sequence: null,
        usage: usageObject(value["usage"]),
    };
}
