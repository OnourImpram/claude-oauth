import type { AdapterRequest, MessageEnvelope } from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";
import { withholdMcpHistory } from "./mcp-history.js";
import { foldToolAdditions } from "./tool-addition.js";
type JsonRecord = Record<string, unknown>;
/**
 * Anthropic Messages -> OpenAI chat completions. Written for the old Grok HTTP path and since
 * shared by the chat-completions API-key lanes, so everything lane-specific is an option; the
 * defaults reproduce the original Grok behaviour exactly.
 */
export interface ChatTranslationOptions {
    /** Lane name used in every error message, so a refusal names the lane it came from. */
    readonly label: string;
    /** Upstream `stream`. Non-streaming requests are refused unless this is explicitly false. */
    readonly stream: boolean;
    /** Replaces the envelope's max_tokens (the caller owns clamping). */
    readonly maxTokens?: number;
    /**
     * Which chat-completions field carries the output cap. "max_tokens" (the default, the
     * original Grok behaviour) or "max_completion_tokens" -- the field the OpenAI API
     * requires for reasoning-capable models (the gpt-6 family rejects `max_tokens`).
     */
    readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
    /**
     * "reject": a thinking block in history is a 422 (the old Grok rule).
     * "drop": thinking blocks are left out of the replay. Reasoning from another provider (or an
     * unsigned block from this one) cannot be replayed meaningfully, and refusing it would kill
     * every multi-turn conversation after the first reasoning turn.
     */
    readonly thinkingReplay: "reject" | "drop";
    /** Maps the envelope's effort/thinking request onto upstream fields; default is the Grok rule. */
    readonly reasoning?: (envelope: MessageEnvelope) => JsonRecord;
    /**
     * Drop tool definitions the upstream cannot execute: server tools (a `type` other than
     * "custom") and deferred tools (`defer_loading`). Default false (the original behaviour).
     */
    readonly clientToolsOnly?: boolean;
    /**
     * Tool names starting with any of these prefixes are never advertised upstream, and their
     * earlier calls and results are withheld from the replayed history too (mcp-history.ts).
     */
    readonly withheldToolPrefixes?: readonly string[];
}
const GROK_DEFAULTS: ChatTranslationOptions = { label: "Grok", stream: true, thinkingReplay: "reject" };
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
// A tool result is text on the chat-completions side. A non-text block (a screenshot, a document)
// is named rather than refused: refusing it kills the whole turn over one attachment.
function toolResultText(value: unknown): string {
    if (value === undefined || value === null)
        return "";
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value))
        throw new RouterError("unsupported_feature", "tool_result content is not supported.", 422);
    return value
        .map((block) => {
        if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string")
            return block["text"];
        const type = isRecord(block) && typeof block["type"] === "string" ? block["type"] : "unknown";
        return `[${type} block omitted by the router]`;
    })
        .join("\n");
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
            if (typeof block["text"] !== "string")
                throw new RouterError("unsupported_feature", "text block must carry a string.", 422);
            // Claude Code can emit an empty text block beside a tool_result; it carries nothing.
            if (block["text"] !== "")
                pending.push({ type: "text", text: block["text"] });
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
                content: toolResultText(block["content"]),
            });
            continue;
        }
        throw new RouterError("unsupported_feature", `User content block ${block["type"]} is not supported.`, 422);
    }
    flush();
    return messages;
}
function mapAssistantMessage(content: unknown, options: ChatTranslationOptions): JsonRecord | undefined {
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
            if (typeof block["text"] !== "string")
                throw new RouterError("unsupported_feature", "assistant text block must carry a string.", 422);
            if (block["text"] !== "")
                text.push(block["text"]);
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
            if (options.thinkingReplay === "drop")
                continue;
            throw new RouterError("unsupported_feature", "Cross-provider replay of thinking blocks is not supported.", 422);
        }
        throw new RouterError("unsupported_feature", `Assistant content block ${block["type"]} is not supported.`, 422);
    }
    // A turn that was ONLY thinking leaves nothing to replay; an empty assistant message is a
    // 400 on most chat-completions servers.
    if (text.length === 0 && toolCalls.length === 0)
        return undefined;
    return {
        role: "assistant",
        content: text.length === 0 ? null : text.join("\n"),
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    };
}
function mapMessages(messages: unknown, options: ChatTranslationOptions, systemExtras: string[]): JsonRecord[] {
    if (!Array.isArray(messages))
        throw new RouterError("invalid_request", "messages must be an array.", 400);
    const result: JsonRecord[] = [];
    for (const message of messages) {
        const role = isRecord(message) ? message["role"] : undefined;
        // B02 class (agent-model.ts): Claude Code puts a system message INSIDE messages -- at the
        // end when it does not recognise the model id -- carrying the skill catalogue and
        // reminders. Dropping it is silent data loss; refusing it kills the turn (the first
        // translator draft answered 422). Chat templates commonly accept a system message only in
        // first position, so its text joins the leading system prompt, in arrival order.
        if (isRecord(message) && (role === "system" || role === "developer")) {
            const text = toolResultText(message["content"]).trim();
            if (text !== "")
                systemExtras.push(text);
            continue;
        }
        if (!isRecord(message) || (role !== "user" && role !== "assistant")) {
            throw new RouterError("unsupported_feature", "Only user, assistant and system message roles are supported.", 422);
        }
        if (message["role"] === "user") {
            result.push(...mapUserMessage(message["content"]));
        }
        else {
            const mapped = mapAssistantMessage(message["content"], options);
            if (mapped !== undefined)
                result.push(mapped);
        }
    }
    return result;
}
/** The tool definitions this lane may offer: client tools only (when asked), minus the withheld prefixes. */
function usableTools(tools: unknown, clientToolsOnly: boolean, withheldPrefixes: readonly string[]): unknown[] | undefined {
    if (tools === undefined)
        return undefined;
    if (!Array.isArray(tools))
        throw new RouterError("unsupported_feature", "tools must be an array.", 422);
    return (clientToolsOnly
        ? tools.filter((tool: unknown) => isRecord(tool) &&
            tool["defer_loading"] !== true &&
            (tool["type"] === undefined || tool["type"] === "custom"))
        : tools)
        .filter((tool: unknown) => !(isRecord(tool) &&
        typeof tool["name"] === "string" &&
        withheldPrefixes.some((prefix) => (tool["name"] as string).startsWith(prefix))));
}
function mapTools(usable: readonly unknown[]): JsonRecord[] {
    return usable.map((tool: unknown) => {
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
function grokReasoning(envelope: MessageEnvelope): JsonRecord {
    const outputConfig = envelope["output_config"];
    const explicit = isRecord(outputConfig) ? outputConfig["effort"] : envelope["reasoning_effort"];
    if (explicit !== undefined) {
        if (!["low", "medium", "high"].includes(String(explicit))) {
            throw new RouterError("unsupported_feature", `Reasoning effort ${String(explicit)} is not supported by Grok.`, 422);
        }
        return { reasoning_effort: String(explicit) };
    }
    if (envelope.thinking !== undefined) {
        if (isRecord(envelope.thinking) && envelope.thinking["type"] === "disabled")
            return {};
        throw new RouterError("unsupported_feature", "Grok requests with thinking enabled require an explicit low, medium, or high output effort.", 422);
    }
    return {};
}
export function anthropicToOpenAi(request: AdapterRequest, options: ChatTranslationOptions = GROK_DEFAULTS): JsonRecord {
    const envelope = request.envelope;
    if (request.path === "/v1/messages/count_tokens") {
        throw new RouterError("unsupported_feature", `${options.label} does not expose a compatible token-count endpoint.`, 422);
    }
    if (envelope.stream !== true && options.stream) {
        throw new RouterError("unsupported_feature", `The ${options.label} adapter requires streaming messages.`, 422);
    }
    const systemExtras: string[] = [];
    const withheldPrefixes = options.withheldToolPrefixes ?? [];
    // tool_addition blocks are folded out of the messages and their definitions join the tools,
    // exactly as on the passthrough lanes (audit D2-03). The names already offered are the ones
    // that survive this lane's own filter: a deferred stub is not offered here, so it must not
    // hide the full definition a tool_addition brings.
    const offered = usableTools(envelope.tools, options.clientToolsOnly === true, withheldPrefixes);
    const fold = foldToolAdditions(envelope.messages, new Set((offered ?? []).flatMap((tool) => isRecord(tool) && typeof tool["name"] === "string" ? [tool["name"]] : [])), withheldPrefixes);
    // DATA RULE on replayed history (audit D2-01): a lane that withholds a tool prefix also
    // withholds that prefix's earlier calls and results, not only the definitions.
    const history = withheldPrefixes.length === 0 ? fold.messages : withholdMcpHistory(fold.messages, withheldPrefixes);
    const conversation = mapMessages(history, options, systemExtras);
    const systemParts = [
        ...(envelope["system"] === undefined ? [] : [textFromContent(envelope["system"], "system")]),
        ...systemExtras,
    ].filter((part) => part !== "");
    const messages: JsonRecord[] = [
        ...(systemParts.length === 0 ? [] : [{ role: "system", content: systemParts.join("\n\n") }]),
        ...conversation,
    ];
    const folded = usableTools(fold.definitions, options.clientToolsOnly === true, withheldPrefixes) ?? [];
    const tools = offered === undefined && !fold.sawToolAddition ? undefined : mapTools([...(offered ?? []), ...folded]);
    const toolChoice = tools === undefined || tools.length === 0 ? undefined : mapToolChoice(envelope["tool_choice"]);
    const reasoning = (options.reasoning ?? grokReasoning)(envelope);
    const maxTokens = options.maxTokens ?? (typeof envelope["max_tokens"] === "number" ? envelope["max_tokens"] : undefined);
    const maxTokensField = options.maxTokensField ?? "max_tokens";
    return {
        model: request.model.upstreamModel,
        messages,
        stream: options.stream,
        ...(options.stream ? { stream_options: { include_usage: true } } : {}),
        ...(maxTokens === undefined ? {} : { [maxTokensField]: maxTokens }),
        ...(typeof envelope["temperature"] === "number" ? { temperature: envelope["temperature"] } : {}),
        ...(typeof envelope["top_p"] === "number" ? { top_p: envelope["top_p"] } : {}),
        ...(Array.isArray(envelope["stop_sequences"]) ? { stop: envelope["stop_sequences"] } : {}),
        ...(tools === undefined || tools.length === 0 ? {} : { tools }),
        ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
        ...reasoning,
    };
}
