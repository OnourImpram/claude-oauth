import { createHash } from "node:crypto";
import type { AdapterRequest, AdapterResponse, HttpTransport, MessageEnvelope, ProviderAdapter, ProviderReadiness } from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";
import { upstreamRequestHeaders } from "../router/headers.js";
import { writeSafeLog } from "../runtime/log.js";
interface ErrorDiagnostic {
    readonly upstreamErrorBytes: number;
    readonly upstreamErrorFingerprint: string;
    readonly upstreamErrorKeys: readonly string[];
    readonly upstreamErrorHints: readonly string[];
}
interface SanitizedValue {
    readonly value: unknown;
    readonly removedUnicodePatterns: number;
}
const knownBlockTypes = new Set([
    "text",
    "image",
    "document",
    "tool_use",
    "tool_result",
    "thinking",
    "redacted_thinking",
    "server_tool_use",
    "web_search_tool_result",
    "mcp_tool_use",
    "mcp_tool_result",
]);
const allowedErrorKeys = new Set(["type", "error", "code", "message", "param", "status", "name", "cause", "details"]);
function messageBlockTypes(content: unknown): string[] {
    if (typeof content === "string")
        return ["text"];
    if (!Array.isArray(content))
        return ["invalid"];
    return content.map((block: unknown) => {
        if (typeof block !== "object" || block === null || Array.isArray(block))
            return "invalid";
        const type = (block as Record<string, unknown>)["type"];
        return typeof type === "string" && knownBlockTypes.has(type) ? type : "unknown";
    });
}
function requestShape(envelope: MessageEnvelope): {
    readonly messageRoles: readonly string[];
    readonly messageBlockTypes: readonly (readonly string[])[];
    readonly toolUseCount: number;
    readonly toolResultCount: number;
    readonly unmatchedToolResultCount: number;
} {
    const messages = Array.isArray(envelope.messages) ? envelope.messages : [];
    const toolUseIds = new Set<string>();
    const toolResultIds: string[] = [];
    const roles: string[] = [];
    const blockTypes: string[][] = [];
    let toolUseCount = 0;
    let toolResultCount = 0;
    for (const message of messages) {
        if (typeof message !== "object" || message === null || Array.isArray(message)) {
            roles.push("invalid");
            blockTypes.push(["invalid"]);
            continue;
        }
        const record = message as Record<string, unknown>;
        const role = record["role"];
        roles.push(role === "user" || role === "assistant" || role === "system" ? role : "unknown");
        const content = record["content"];
        blockTypes.push(messageBlockTypes(content));
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            if (typeof block !== "object" || block === null || Array.isArray(block))
                continue;
            const candidate = block as Record<string, unknown>;
            if (candidate["type"] === "tool_use") {
                toolUseCount += 1;
                if (typeof candidate["id"] === "string")
                    toolUseIds.add(candidate["id"]);
            }
            else if (candidate["type"] === "tool_result") {
                toolResultCount += 1;
                if (typeof candidate["tool_use_id"] === "string")
                    toolResultIds.push(candidate["tool_use_id"]);
            }
        }
    }
    return {
        messageRoles: roles,
        messageBlockTypes: blockTypes,
        toolUseCount,
        toolResultCount,
        unmatchedToolResultCount: toolResultIds.filter((id) => !toolUseIds.has(id)).length,
    };
}
function collectAllowedErrorKeys(value: unknown, target: Set<string>, depth = 0): void {
    if (depth > 5 || typeof value !== "object" || value === null)
        return;
    if (Array.isArray(value)) {
        for (const item of value.slice(0, 16))
            collectAllowedErrorKeys(item, target, depth + 1);
        return;
    }
    for (const [key, nested] of Object.entries(value)) {
        if (allowedErrorKeys.has(key))
            target.add(key);
        collectAllowedErrorKeys(nested, target, depth + 1);
    }
}
function fixedErrorHints(text: string): string[] {
    const normalized = text.toLowerCase();
    const hints: string[] = [];
    if (/tool|function_call|function call/u.test(normalized))
        hints.push("tool_protocol");
    if (/tool_result|function_call_output|function call output/u.test(normalized))
        hints.push("tool_result");
    if (/call[_ ]?id|tool_use_id|tool call id/u.test(normalized))
        hints.push("tool_call_id");
    if (/reasoning|encrypted_content|signature/u.test(normalized))
        hints.push("reasoning_state");
    if (/previous_response|conversation|response id/u.test(normalized))
        hints.push("response_state");
    if (/context.length|too many tokens|maximum context/u.test(normalized))
        hints.push("context_limit");
    if (/unsupported|not supported/u.test(normalized))
        hints.push("unsupported_shape");
    if (/missing|required|must be provided|without/u.test(normalized))
        hints.push("missing_required");
    if (/duplicate|already exists|already been used/u.test(normalized))
        hints.push("duplicate_item");
    if (/system/u.test(normalized))
        hints.push("system_role");
    if (/developer/u.test(normalized))
        hints.push("developer_role");
    if (/role/u.test(normalized))
        hints.push("message_role");
    if (/invalid value|invalid type|invalid input|not allowed/u.test(normalized))
        hints.push("invalid_value");
    if (/after|following/u.test(normalized))
        hints.push("ordering_after");
    if (/before|preceding/u.test(normalized))
        hints.push("ordering_before");
    if (/last message|final message|at the end/u.test(normalized))
        hints.push("final_position");
    if (/token|context|input length|request too large|too long|exceed|maximum|limit/u.test(normalized))
        hints.push("size_or_token_limit");
    if (/rate|quota|usage|capacity/u.test(normalized))
        hints.push("rate_or_quota");
    if (/account|organization|workspace|entitl|subscription/u.test(normalized))
        hints.push("account_or_entitlement");
    if (/policy|safety|moderation|blocked/u.test(normalized))
        hints.push("policy_rejection");
    if (/server|internal|failed|failure|unavailable/u.test(normalized))
        hints.push("provider_internal");
    if (/cache|cached/u.test(normalized))
        hints.push("cache_state");
    return hints;
}
async function errorDiagnostic(response: Response): Promise<ErrorDiagnostic> {
    const maximumBytes = 32 * 1024;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maximumBytes) {
        await response.body?.cancel();
        return {
            upstreamErrorBytes: declared,
            upstreamErrorFingerprint: "oversized",
            upstreamErrorKeys: [],
            upstreamErrorHints: [],
        };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const bounded = bytes.byteLength <= maximumBytes ? bytes : bytes.slice(0, maximumBytes);
    const text = Buffer.from(bounded).toString("utf8");
    const keys = new Set<string>();
    try {
        const parsed: unknown = JSON.parse(text);
        collectAllowedErrorKeys(parsed, keys);
    }
    catch {
        // A non-JSON provider error is fingerprinted but never logged as text.
    }
    return {
        upstreamErrorBytes: bytes.byteLength,
        upstreamErrorFingerprint: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
        upstreamErrorKeys: [...keys].sort(),
        upstreamErrorHints: fixedErrorHints(text),
    };
}
function sanitizeUnicodeSchemaPatterns(value: unknown): SanitizedValue {
    if (Array.isArray(value)) {
        let removedUnicodePatterns = 0;
        const sanitized = value.map((item: unknown) => {
            const result = sanitizeUnicodeSchemaPatterns(item);
            removedUnicodePatterns += result.removedUnicodePatterns;
            return result.value;
        });
        return { value: sanitized, removedUnicodePatterns };
    }
    if (typeof value !== "object" || value === null)
        return { value, removedUnicodePatterns: 0 };
    let removedUnicodePatterns = 0;
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
        if (key === "pattern" && typeof nested === "string" && /\\[pP]\{[^}]+\}/u.test(nested)) {
            removedUnicodePatterns += 1;
            continue;
        }
        const result = sanitizeUnicodeSchemaPatterns(nested);
        sanitized[key] = result.value;
        removedUnicodePatterns += result.removedUnicodePatterns;
    }
    return { value: sanitized, removedUnicodePatterns };
}
function sanitizedTools(value: unknown): SanitizedValue {
    if (!Array.isArray(value))
        return { value, removedUnicodePatterns: 0 };
    let removedUnicodePatterns = 0;
    const tools = value.map((tool: unknown) => {
        if (typeof tool !== "object" || tool === null || Array.isArray(tool))
            return tool;
        const record = tool as Record<string, unknown>;
        const inputSchema = sanitizeUnicodeSchemaPatterns(record["input_schema"]);
        removedUnicodePatterns += inputSchema.removedUnicodePatterns;
        return { ...record, input_schema: inputSchema.value };
    });
    return { value: tools, removedUnicodePatterns };
}
function rewrittenBody(request: AdapterRequest): { readonly body: Buffer; readonly removedUnicodePatterns: number } {
    const existingOutputConfig = request.envelope["output_config"];
    const outputConfig: Record<string, unknown> = typeof existingOutputConfig === "object" && existingOutputConfig !== null && !Array.isArray(existingOutputConfig)
        ? { ...existingOutputConfig }
        : {};
    if (!("effort" in outputConfig))
        outputConfig["effort"] = "xhigh";
    const tools = sanitizedTools(request.envelope.tools);
    const body = {
        ...request.envelope,
        model: request.model.upstreamModel,
        output_config: outputConfig,
        ...(Array.isArray(request.envelope.tools) ? { tools: tools.value } : {}),
    };
    return {
        body: Buffer.from(JSON.stringify(body), "utf8"),
        removedUnicodePatterns: tools.removedUnicodePatterns,
    };
}
async function throwMappedError(response: Response, request: AdapterRequest, upstreamRequestBytes: number, removedUnicodePatterns: number): Promise<never> {
    if (response.status === 400) {
        const diagnostic = await errorDiagnostic(response);
        writeSafeLog({
            event: "clodex_request_rejected",
            level: "warn",
            requestId: request.requestId,
            provider: "openai",
            code: "invalid_request",
            ...requestShape(request.envelope),
            ...diagnostic,
            upstreamRequestBytes,
            toolDefinitionCount: Array.isArray(request.envelope.tools) ? request.envelope.tools.length : 0,
            removedUnicodeSchemaPatterns: removedUnicodePatterns,
        });
    }
    else {
        await response.body?.cancel();
    }
    const retryAfter = response.headers.get("retry-after") ?? undefined;
    if (response.status === 401) {
        throw new RouterError("provider_auth_required", "ChatGPT OAuth authentication is required.", 401);
    }
    if (response.status === 403) {
        throw new RouterError("provider_entitlement_denied", "The ChatGPT account is not entitled to this model.", 403);
    }
    if (response.status === 404) {
        throw new RouterError("model_not_available", "The requested Sol model is not in the pinned Clodex catalog.", 404);
    }
    if (response.status === 429) {
        throw new RouterError("provider_rate_limited", "The OpenAI provider rate-limited this request.", 429, {
            ...(retryAfter === undefined ? {} : { retryAfter }),
        });
    }
    if (response.status === 400) {
        throw new RouterError("invalid_request", "The Clodex compatibility capsule rejected the request shape.", 400);
    }
    if (response.status === 422) {
        throw new RouterError("unsupported_feature", "The Clodex compatibility capsule rejected an unsupported feature.", 422);
    }
    throw new RouterError(response.status >= 500 ? "adapter_unavailable" : "upstream_protocol_error", "The Clodex compatibility capsule rejected the request.", response.status >= 500 ? 503 : 502);
}
export class ClodexAdapter implements ProviderAdapter {
    readonly provider: "openai" = "openai";
    constructor(private readonly transport: HttpTransport, private readonly transportNonce: string, private readonly readinessProbe: () => Promise<ProviderReadiness>) {
    }
    async readiness(): Promise<ProviderReadiness> {
        return await this.readinessProbe();
    }
    async send(request: AdapterRequest): Promise<AdapterResponse> {
        const headers = upstreamRequestHeaders(request.headers, false);
        headers.set("content-type", "application/json");
        headers.set("x-api-key", this.transportNonce);
        const rewritten = rewrittenBody(request);
        if (rewritten.removedUnicodePatterns > 0) {
            writeSafeLog({
                event: "clodex_schema_compatibility_applied",
                level: "info",
                requestId: request.requestId,
                provider: "openai",
                removedUnicodeSchemaPatterns: rewritten.removedUnicodePatterns,
            });
        }
        if (process.env["HEZARFEN_CLODEX_SHAPE_DIAGNOSTICS"] === "1") {
            writeSafeLog({
                event: "clodex_request_dispatched",
                level: "info",
                requestId: request.requestId,
                provider: "openai",
                ...requestShape(request.envelope),
                upstreamRequestBytes: rewritten.body.byteLength,
                toolDefinitionCount: Array.isArray(request.envelope.tools) ? request.envelope.tools.length : 0,
                removedUnicodeSchemaPatterns: rewritten.removedUnicodePatterns,
            });
        }
        const response = await this.transport.send({
            path: `/anthropic${request.path}${request.query}`,
            method: "POST",
            headers,
            body: rewritten.body,
            signal: request.signal,
        });
        if (!response.ok) {
            return await throwMappedError(response, request, rewritten.body.byteLength, rewritten.removedUnicodePatterns);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
            await response.body?.cancel();
            throw new RouterError("upstream_protocol_error", "Clodex returned an unsupported response type.", 502);
        }
        const providerRequestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
        return {
            status: response.status,
            headers: response.headers,
            body: response.body,
            ...(providerRequestId === undefined ? {} : { providerRequestId }),
        };
    }
}
