import { randomUUID } from "node:crypto";
import { RouterError } from "../domain/errors.js";
interface StreamBlock {
    readonly index: number;
    readonly kind: "text" | "thinking" | "tool";
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sse(event: string, data: unknown): Uint8Array {
    return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, "utf8");
}
function parseChunk(data: string): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(data);
    }
    catch (error) {
        throw new RouterError("upstream_protocol_error", "Grok emitted malformed SSE JSON.", 502, { cause: error });
    }
    if (!isRecord(value) || !Array.isArray(value["choices"])) {
        throw new RouterError("upstream_protocol_error", "Grok emitted an invalid chat completion chunk.", 502);
    }
    return value;
}
function usageObject(value: unknown): { readonly input_tokens: number; readonly output_tokens: number } {
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
    return "end_turn";
}
export function openAiSseToAnthropic(upstream: ReadableStream<Uint8Array>, configuredModel: string): ReadableStream<Uint8Array> {
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
                        const chunk = parseChunk(data);
                        if (!started) {
                            started = true;
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
                        if (chunk["usage"] !== undefined)
                            finalUsage = usageObject(chunk["usage"]);
                        const choice = (chunk["choices"] as readonly unknown[])[0];
                        if (!isRecord(choice))
                            continue;
                        if (choice["finish_reason"] !== undefined && choice["finish_reason"] !== null) {
                            finalReason = stopReason(choice["finish_reason"]);
                        }
                        const delta = choice["delta"];
                        if (!isRecord(delta))
                            continue;
                        if (typeof delta["reasoning_content"] === "string" && delta["reasoning_content"] !== "") {
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
                                delta: { type: "thinking_delta", thinking: delta["reasoning_content"] },
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
                                    throw new RouterError("upstream_protocol_error", "Grok emitted an invalid tool-call delta.", 502);
                                }
                                const position = rawTool["index"];
                                const fn = isRecord(rawTool["function"]) ? rawTool["function"] : {};
                                let block = toolBlocks.get(position);
                                if (block === undefined) {
                                    const id = requiredToolString(rawTool["id"], "id");
                                    const name = requiredToolString(fn["name"], "name");
                                    block = { index: nextBlockIndex++, kind: "tool" };
                                    toolBlocks.set(position, block);
                                    toolIds.set(position, id);
                                    controller.enqueue(sse("content_block_start", {
                                        type: "content_block_start",
                                        index: block.index,
                                        content_block: { type: "tool_use", id, name, input: {} },
                                    }));
                                }
                                else if (rawTool["id"] !== undefined && rawTool["id"] !== toolIds.get(position)) {
                                    throw new RouterError("upstream_protocol_error", "Grok changed a tool-call id mid-stream.", 502);
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
                    throw new RouterError("upstream_protocol_error", "Grok stream ended without a DONE marker.", 502);
                }
                const openBlocks = [thinkingBlock, textBlock, ...toolBlocks.values()]
                    .filter((block): block is StreamBlock => block !== undefined)
                    .sort((left, right) => left.index - right.index);
                for (const block of openBlocks) {
                    controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: block.index }));
                }
                if (!started) {
                    throw new RouterError("upstream_protocol_error", "Grok stream contained no completion chunks.", 502);
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
            }
        },
        async cancel(reason) {
            await reader.cancel(reason);
        },
    });
}
function requiredToolString(value: unknown, field: string): string {
    if (typeof value !== "string" || value === "") {
        throw new RouterError("upstream_protocol_error", `Grok tool-call ${field} is missing.`, 502);
    }
    return value;
}
