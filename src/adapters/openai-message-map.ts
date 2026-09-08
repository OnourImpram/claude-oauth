import type { AdapterRequest, MessageEnvelope } from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";
type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value === "") {
        throw new RouterError("unsupported_feature", `${field} must be a non-empty string.`, 422);
    }
    return value;
}
function textFromContent(value: unknown, field: string): string {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value))
        throw new RouterError("unsupported_feature", `${field} content is not supported.`, 422);
    const text: string[] = [];
    for (const block of value) {
        if (!isRecord(block) || block["type"] !== "text" || typeof block["text"] !== "string") {
            throw new RouterError("unsupported_feature", `${field} contains a non-text block.`, 422);
        }
        text.push(block["text"]);
    }
    return text.join("\n");
}
function mapImageSource(source: unknown): JsonRecord {
    if (!isRecord(source) || typeof source["type"] !== "string") {
        throw new RouterError("unsupported_feature", "Image source is malformed.", 422);
    }
    if (source["type"] === "base64") {
        const mediaType = requiredString(source["media_type"], "image media_type");
        const data = requiredString(source["data"], "image data");
        return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
    }
    if (source["type"] === "url") {
        return { type: "image_url", image_url: { url: requiredString(source["url"], "image url") } };
    }
    throw new RouterError("unsupported_feature", `Image source type ${source["type"]} is not supported.`, 422);
}
function mapUserMessage(content: unknown): JsonRecord[] {
    if (typeof content === "string")
        return [{ role: "user", content }];
    if (!Array.isArray(content))
        throw new RouterError("unsupported_feature", "User content is malformed.", 422);
    const messages: JsonRecord[] = [];
    let pending: JsonRecord[] = [];
    const flush = (): void => {
        if (pending.length === 0)
            return;
        messages.push({ role: "user", content: pending.length === 1 && pending[0]?.["type"] === "text" ? pending[0]!["text"] : pending });
        pending = [];
    };
    for (const block of content) {
        if (!isRecord(block) || typeof block["type"] !== "string") {
            throw new RouterError("unsupported_feature", "User content contains a malformed block.", 422);
        }
        if (block["type"] === "text") {
            pending.push({ type: "text", text: requiredString(block["text"], "text block") });
            continue;
        }
        if (block["type"] === "image") {
            pending.push(mapImageSource(block["source"]));
            continue;
        }
        if (block["type"] === "tool_result") {
            flush();
            messages.push({
                role: "tool",
                tool_call_id: requiredString(block["tool_use_id"], "tool_result tool_use_id"),
                content: textFromContent(block["content"], "tool_result"),
            });
            continue;
        }
        throw new RouterError("unsupported_feature", `User content block ${block["type"]} is not supported.`, 422);
    }
    flush();
    return messages;
}
function mapAssistantMessage(content: unknown): JsonRecord {
    if (typeof content === "string")
        return { role: "assistant", content };
    if (!Array.isArray(content))
        throw new RouterError("unsupported_feature", "Assistant content is malformed.", 422);
    const text: string[] = [];
    const toolCalls: JsonRecord[] = [];
    for (const block of content) {
        if (!isRecord(block) || typeof block["type"] !== "string") {
            throw new RouterError("unsupported_feature", "Assistant content contains a malformed block.", 422);
        }
        if (block["type"] === "text") {
            text.push(requiredString(block["text"], "assistant text block"));
            continue;
        }
        if (block["type"] === "tool_use") {
            toolCalls.push({
                id: requiredString(block["id"], "tool_use id"),
                type: "function",
                function: {
                    name: requiredString(block["name"], "tool_use name"),
                    arguments: JSON.stringify(block["input"] ?? {}),
                },
            });
            continue;
        }
        if (block["type"] === "thinking" || block["type"] === "redacted_thinking") {
            throw new RouterError("unsupported_feature", "Cross-provider replay of thinking blocks is not supported.", 422);
        }
        throw new RouterError("unsupported_feature", `Assistant content block ${block["type"]} is not supported.`, 422);
    }
    return {
        role: "assistant",
        content: text.length === 0 ? null : text.join("\n"),
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    };
}
function mapMessages(messages: unknown): JsonRecord[] {
    if (!Array.isArray(messages))
        throw new RouterError("invalid_request", "messages must be an array.", 400);
    const result: JsonRecord[] = [];
    for (const message of messages) {
        if (!isRecord(message) || (message["role"] !== "user" && message["role"] !== "assistant")) {
            throw new RouterError("unsupported_feature", "Only user and assistant message roles are supported.", 422);
        }
        if (message["role"] === "user")
            result.push(...mapUserMessage(message["content"]));
        else
            result.push(mapAssistantMessage(message["content"]));
    }
    return result;
}
function mapTools(tools: unknown): JsonRecord[] | undefined {
    if (tools === undefined)
        return undefined;
    if (!Array.isArray(tools))
        throw new RouterError("unsupported_feature", "tools must be an array.", 422);
    return tools.map((tool: unknown) => {
        if (!isRecord(tool))
            throw new RouterError("unsupported_feature", "Tool definition is malformed.", 422);
        return {
            type: "function",
            function: {
                name: requiredString(tool["name"], "tool name"),
                ...(typeof tool["description"] === "string" ? { description: tool["description"] } : {}),
                parameters: isRecord(tool["input_schema"]) ? tool["input_schema"] : { type: "object", properties: {} },
            },
        };
    });
}
function mapToolChoice(value: unknown): string | JsonRecord | undefined {
    if (value === undefined)
        return undefined;
    if (!isRecord(value) || typeof value["type"] !== "string") {
        throw new RouterError("unsupported_feature", "tool_choice is malformed.", 422);
    }
    if (value["type"] === "auto")
        return "auto";
    if (value["type"] === "any")
        return "required";
    if (value["type"] === "none")
        return "none";
    if (value["type"] === "tool") {
        return { type: "function", function: { name: requiredString(value["name"], "tool_choice name") } };
    }
    throw new RouterError("unsupported_feature", `tool_choice ${value["type"]} is not supported.`, 422);
}
function mapReasoningEffort(envelope: MessageEnvelope): string | undefined {
    const outputConfig = envelope["output_config"];
    const explicit = isRecord(outputConfig) ? outputConfig["effort"] : envelope["reasoning_effort"];
    if (explicit !== undefined) {
        if (!["low", "medium", "high"].includes(String(explicit))) {
            throw new RouterError("unsupported_feature", `Reasoning effort ${String(explicit)} is not supported by Grok.`, 422);
        }
        return String(explicit);
    }
    if (envelope.thinking !== undefined) {
        if (isRecord(envelope.thinking) && envelope.thinking["type"] === "disabled")
            return undefined;
        throw new RouterError("unsupported_feature", "Grok requests with thinking enabled require an explicit low, medium, or high output effort.", 422);
    }
    return undefined;
}
export function anthropicToOpenAi(request: AdapterRequest): JsonRecord {
    const envelope = request.envelope;
    if (request.path === "/v1/messages/count_tokens") {
        throw new RouterError("unsupported_feature", "Grok does not expose a compatible token-count endpoint.", 422);
    }
    if (envelope.stream !== true) {
        throw new RouterError("unsupported_feature", "The Grok adapter requires streaming messages.", 422);
    }
    const messages: JsonRecord[] = [];
    if (envelope["system"] !== undefined) {
        messages.push({ role: "system", content: textFromContent(envelope["system"], "system") });
    }
    messages.push(...mapMessages(envelope.messages));
    const tools = mapTools(envelope.tools);
    const toolChoice = mapToolChoice(envelope["tool_choice"]);
    const effort = mapReasoningEffort(envelope);
    return {
        model: request.model.upstreamModel,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(typeof envelope["max_tokens"] === "number" ? { max_tokens: envelope["max_tokens"] } : {}),
        ...(typeof envelope["temperature"] === "number" ? { temperature: envelope["temperature"] } : {}),
        ...(typeof envelope["top_p"] === "number" ? { top_p: envelope["top_p"] } : {}),
        ...(Array.isArray(envelope["stop_sequences"]) ? { stop: envelope["stop_sequences"] } : {}),
        ...(tools === undefined ? {} : { tools }),
        ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
    };
}
