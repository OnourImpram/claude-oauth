import type { ProviderModelRecord } from "./contracts.js";
import { RouterError } from "./errors.js";
const maximumModelCount = 1_000;
const modelIdPattern = /^[!-~]{1,256}$/u;
function validateIds(values: readonly unknown[]): readonly string[] {
    if (values.length === 0 || values.length > maximumModelCount) {
        throw new RouterError("upstream_protocol_error", "The provider model catalog has an invalid size.", 502);
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (typeof value !== "string" || !modelIdPattern.test(value) || seen.has(value)) {
            throw new RouterError("upstream_protocol_error", "The provider model catalog contains an invalid ID.", 502);
        }
        seen.add(value);
        ids.push(value);
    }
    return ids;
}
function optionalPositiveInteger(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
    const values = keys
        .map((key) => record[key])
        .filter((value) => typeof value === "number");
    if (values.length === 0)
        return undefined;
    if (!values.every((value) => Number.isSafeInteger(value) && value > 0 && value <= 10_000_000)) {
        throw new RouterError("upstream_protocol_error", "The provider model catalog has invalid token limits.", 502);
    }
    if (new Set(values).size !== 1) {
        throw new RouterError("upstream_protocol_error", "The provider model catalog has conflicting token limits.", 502);
    }
    return values[0];
}
export function parseProviderModelEntries(value: unknown): readonly ProviderModelRecord[] {
    if (typeof value !== "object" || value === null || !("data" in value) || !Array.isArray(value.data)) {
        throw new RouterError("upstream_protocol_error", "The provider model catalog is malformed.", 502);
    }
    const records = value.data.map((entry: unknown) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new RouterError("upstream_protocol_error", "The provider model catalog contains an invalid entry.", 502);
        }
        return entry as Record<string, unknown>;
    });
    const ids = validateIds(records.map((entry) => entry["id"]));
    return records.map((entry, index) => {
        const contextWindow = optionalPositiveInteger(entry, ["context_window", "max_input_tokens"]);
        const maximumOutputTokens = optionalPositiveInteger(entry, ["max_output_tokens", "maximum_output_tokens"]);
        return {
            id: ids[index] as string,
            ...(contextWindow === undefined ? {} : { contextWindow }),
            ...(maximumOutputTokens === undefined ? {} : { maximumOutputTokens }),
        };
    });
}
export function parseProviderModelIds(value: unknown): readonly string[] {
    if (!Array.isArray(value)) {
        throw new RouterError("upstream_protocol_error", "The provider model ID list is malformed.", 502);
    }
    return validateIds(value);
}
