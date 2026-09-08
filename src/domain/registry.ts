import type { ModelRecord, ModelSnapshot, ProviderAdapter, ProviderId } from "./contracts.js";
import { RouterError } from "./errors.js";
import { agentModelContract, openAiModelContract } from "./model-contracts.js";
export function claudeClientDiscoveryId(model: ModelRecord): string {
    const contract = openAiModelContract(model.id);
    const reviewedLongContext = contract !== undefined &&
        model.provider === "openai" &&
        model.upstreamModel === contract.upstreamModel &&
        model.contextWindow === contract.contextWindow;
    const reviewedAgentLongContext = model.executionMode === "agent-readonly" &&
        model.contextWindow !== undefined &&
        model.contextWindow >= 1_000_000;
    return reviewedLongContext || reviewedAgentLongContext ? `${model.id}[1m]` : model.id;
}
/**
 * Presentation value for discovery's context_window and modelDetail's advertisement.
 * This override does not establish accepted input capacity. max_input_tokens is bounded
 * separately by model.contextWindow, which refresh verifies against the transport pin.
 * The snapshot remains unchanged so live catalogue drift can still be detected.
 * Rows without a documented override retain their snapshot value.
 */
export function advertisedContextWindow(model: ModelRecord): number | undefined {
    if (model.contextWindow === undefined)
        return undefined;
    const contract = openAiModelContract(model.id);
    if (contract?.advertisedContextWindow !== undefined &&
        model.provider === "openai" &&
        model.upstreamModel === contract.upstreamModel)
        return contract.advertisedContextWindow;
    return model.contextWindow;
}
/**
 * The one row `claude-oauth models --refresh` and `claude-oauth doctor` print per model.
 *
 * WHY this is a function and not two inline object literals (2026-09-05, audit FINDING 3).
 * Both surfaces built the identical object by hand and both printed model.contextWindow
 * alone -- the MEASURED number. For Astra that is 872_000 while Claude Code is told
 * 1_000_000, so the operator who pins a correct release and then runs `doctor` out of habit
 * reads 872_000 and concludes the change did not ship. It did; no operator surface was
 * showing the announced number, and the only place it appeared was a live router's
 * GET /v1/models.
 *
 * The announced number now travels beside the measured one and ONLY when the two differ, so
 * every row without an override prints exactly what it printed before and the measured number
 * never loses its own name. This is a projection, not a snapshot field: nothing here is
 * written back, and the verification chain still never sees it.
 */
export function modelDetail(model: ModelRecord): Readonly<Record<string, unknown>> {
    const advertised = advertisedContextWindow(model);
    return {
        id: model.id,
        provider: model.provider,
        executionMode: model.executionMode,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(advertised === undefined || advertised === model.contextWindow
            ? {}
            : { advertisedContextWindow: advertised }),
        ...(model.maximumOutputTokens === undefined
            ? {}
            : { maximumOutputTokens: model.maximumOutputTokens }),
    };
}
export class ModelRegistry {
    #models: ReadonlyMap<string, ModelRecord>;
    #aliases: ReadonlyMap<string, string>;
    #adapters: ReadonlyMap<ProviderId, ProviderAdapter>;
    constructor(snapshot: ModelSnapshot, adapters: ReadonlyMap<ProviderId, ProviderAdapter>) {
        this.#models = new Map(snapshot.models.map((model) => [
            model.id,
            Object.freeze({
                ...model,
                capabilities: Object.freeze([...model.capabilities]),
            }),
        ]));
        this.#aliases = new Map(snapshot.models.flatMap((model) => {
            const aliases: [string, string][] = [];
            const discoveryId = claudeClientDiscoveryId(model);
            if (discoveryId !== model.id)
                aliases.push([discoveryId, model.id]);
            const agentContract = agentModelContract(model.id);
            if (agentContract !== undefined && model.executionMode === "agent-readonly") {
                aliases.push([agentContract.alias, model.id]);
            }
            const contract = openAiModelContract(model.id);
            if (contract === undefined ||
                model.provider !== "openai" ||
                model.oauthType !== "chatgpt" ||
                model.upstreamModel !== contract.upstreamModel ||
                model.contextWindow === undefined ||
                model.contextWindow <= 0 ||
                model.contextWindow > contract.contextWindow) {
                return aliases;
            }
            aliases.push([contract.alias, model.id]);
            return aliases;
        }));
        this.#adapters = new Map(adapters);
    }
    resolve(modelId: string): {
        readonly model: ModelRecord;
        readonly adapter: ProviderAdapter;
    } {
        const targetId = this.#aliases.get(modelId) ?? modelId;
        const model = this.#models.get(targetId);
        if (model === undefined) {
            throw new RouterError("model_not_available", `Model is not present in the immutable session snapshot.`, 404);
        }
        const adapter = this.#adapters.get(model.provider);
        if (adapter === undefined) {
            throw new RouterError("adapter_unavailable", `The ${model.provider} adapter is unavailable.`, 503);
        }
        return { model, adapter };
    }
    discoveryPayload(): Readonly<Record<string, unknown>> {
        const models = [...this.#models.values()].filter((model) => model.discoverable);
        const entries = models.map((model) => ({
            model,
            clientId: claudeClientDiscoveryId(model),
            advertised: advertisedContextWindow(model),
        }));
        return {
            data: entries.map(({ model, clientId, advertised }) => ({
                type: "model",
                id: clientId,
                display_name: model.displayName,
                ...(advertised === undefined || model.contextWindow === undefined
                    ? {}
                    : { context_window: advertised, max_input_tokens: Math.min(advertised, model.contextWindow) }),
                ...(model.maximumOutputTokens === undefined
                    ? {}
                    : { max_output_tokens: model.maximumOutputTokens }),
            })),
            has_more: false,
            first_id: entries.at(0)?.clientId ?? null,
            last_id: entries.at(-1)?.clientId ?? null,
        };
    }
    list(): readonly ModelRecord[] {
        return [...this.#models.values()];
    }
}
