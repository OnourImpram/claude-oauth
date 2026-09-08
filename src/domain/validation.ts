import {
    PROVIDER_IDS,
    type Capability,
    type MessageEnvelope,
    type ModelExecutionMode,
    type ModelRecord,
    type ModelSnapshot,
    type ProviderId,
} from "./contracts.js";
import { RouterError } from "./errors.js";
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value: unknown, maximum = 256): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
export function parseMessageEnvelope(body: Uint8Array, requireMessages: boolean): MessageEnvelope {
    let value: unknown;
    try {
        value = JSON.parse(Buffer.from(body).toString("utf8"));
    }
    catch (error) {
        throw new RouterError("invalid_request", "Request body must be valid JSON.", 400, { cause: error });
    }
    if (!isRecord(value) || !isNonEmptyString(value["model"])) {
        throw new RouterError("invalid_request", "Request body must contain a non-empty model string.", 400);
    }
    if (requireMessages && !Array.isArray(value["messages"])) {
        throw new RouterError("invalid_request", "Messages requests must contain a messages array.", 400);
    }
    if (value["stream"] !== undefined && typeof value["stream"] !== "boolean") {
        throw new RouterError("invalid_request", "stream must be a boolean when supplied.", 400);
    }
    return value as MessageEnvelope;
}
const capabilities = new Set(["messages", "streaming", "tools", "vision", "thinking"]);
function parseModel(value: unknown): ModelRecord {
    if (!isRecord(value))
        throw new Error("model entry must be an object");
    const provider = value["provider"];
    const oauthType = value["oauthType"];
    const rawCapabilities = value["capabilities"];
    const contextWindow = value["contextWindow"];
    const maximumOutputTokens = value["maximumOutputTokens"];
    const executionMode = value["executionMode"] ??
        (provider === "anthropic" || provider === "openai" ? "native-message-loop" : undefined);
    if (!isNonEmptyString(value["id"]) ||
        !PROVIDER_IDS.includes(provider as ProviderId) ||
        !isNonEmptyString(value["upstreamModel"]) ||
        !isNonEmptyString(value["displayName"]) ||
        !["claude.ai", "chatgpt", "xai-cli", "google-cli"].includes(String(oauthType)) ||
        !["native-message-loop", "agent-readonly"].includes(String(executionMode)) ||
        ((provider === "anthropic" || provider === "openai") && executionMode !== "native-message-loop") ||
        ((provider === "google" || provider === "xai") && executionMode !== "agent-readonly") ||
        typeof value["discoverable"] !== "boolean" ||
        (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || (contextWindow as number) <= 0)) ||
        (maximumOutputTokens !== undefined &&
            (!Number.isSafeInteger(maximumOutputTokens) || (maximumOutputTokens as number) <= 0)) ||
        !Array.isArray(rawCapabilities) ||
        !rawCapabilities.every((entry) => typeof entry === "string" && capabilities.has(entry))) {
        throw new Error("invalid model entry");
    }
    return {
        id: value["id"],
        provider: provider as ProviderId,
        upstreamModel: value["upstreamModel"],
        displayName: value["displayName"],
        oauthType: oauthType as ModelRecord["oauthType"],
        executionMode: executionMode as ModelExecutionMode,
        discoverable: value["discoverable"],
        ...(contextWindow === undefined ? {} : { contextWindow: contextWindow as number }),
        ...(maximumOutputTokens === undefined ? {} : { maximumOutputTokens: maximumOutputTokens as number }),
        capabilities: rawCapabilities as readonly Capability[],
    };
}
export function parseModelSnapshot(value: unknown): ModelSnapshot {
    if (!isRecord(value) || value["schemaVersion"] !== 1 || !isNonEmptyString(value["generatedAt"])) {
        throw new Error("invalid model snapshot header");
    }
    if (!isNonEmptyString(value["source"]) || !Array.isArray(value["models"])) {
        throw new Error("invalid model snapshot body");
    }
    const models = value["models"].map(parseModel);
    const ids = new Set<string>();
    for (const model of models) {
        if (ids.has(model.id))
            throw new Error(`duplicate model id: ${model.id}`);
        ids.add(model.id);
    }
    return {
        schemaVersion: 1,
        generatedAt: value["generatedAt"],
        source: value["source"],
        models,
    };
}
export function numericUsage(value: unknown): Readonly<Record<string, number>> | undefined {
    if (!isRecord(value))
        return undefined;
    const usage: Record<string, number> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0)
            usage[key] = entry;
    }
    return Object.keys(usage).length === 0 ? undefined : usage;
}
