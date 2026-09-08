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
 * The window Claude Code is TOLD about -- the single surface that reaches it, since
 * gateway-models.json carries only {id, display_name} and the launcher takes the
 * auto-compaction threshold from the contract, not from here.
 *
 * WHY the override lives at this projection and NOT in the snapshot (2026-09-05, Astra).
 * clodex 2.11.1 seeds Astra with maxContextWindow 872_000 -- the GPT-5.6 family's ceiling
 * copied onto a model whose own card says 1,050,000 -- and the pin in
 * config/install-lock.json verifies that measured number. Writing 1_000_000 into the
 * snapshot instead would have advertised the same thing while destroying the evidence:
 * isVerifiedOpenAiSnapshotRoute and openAiSnapshotRouteDrift compare the SNAPSHOT number
 * against the LIVE one, so a snapshot carrying a policy constant matches itself forever and
 * a live catalogue falling 872_000 -> 272_000 (the "standard" context stop, measured on the
 * 5.6 lane on 2026-09-01) would pass verification. Here the measured number stays measured,
 * the detector keeps its anchor, and only the announcement moves.
 *
 * Returns model.contextWindow unchanged for every row without a documented override, and
 * never invents a window for a row that has none.
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
 * WHY this is a function and not two inline object literals (2026-09-05, audit BULGU 3).
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
                ...(advertised === undefined
                    ? {}
                    : { context_window: advertised, max_input_tokens: advertised }),
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
