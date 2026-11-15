import type { AdapterRequest, AdapterResponse, HttpTransport, MessageEnvelope, ProviderAdapter, ProviderModelRecord, ProviderReadiness } from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";
import { apiKeyModelContract, apiKeyModelContracts } from "../domain/model-contracts.js";
import { anthropicToOpenAi } from "./openai-message-map.js";
import { openAiCompletionToAnthropic, openAiSseToAnthropic } from "./openai-sse.js";
import { resolveRouterOwnedKey } from "./router-key-file.js";

/**
 * OpenAI API-key lane (`openaiapi`, 2026-11-09, operator request). SEPARATE from the `openai`
 * lane (ChatGPT OAuth / clodex): that lane keeps its OAuth capsule; this one holds an API key
 * and calls `https://api.openai.com/v1/chat/completions` directly.
 *
 * Chat Completions -- not Responses -- ON PURPOSE: the existing translation layer
 * (openai-message-map.ts / openai-sse.ts) is chat-completions shaped end to end, so the whole
 * Messages<->chat-completions loop is reused unchanged; a Responses lane would need a second
 * translator for the same result. Both endpoints answered the quota probe identically
 * (MEASURED 2026-11-09, kanit/openai/kota/: 429 insufficient_quota / credit_balance_exhausted).
 *
 * The request carries `authorization: Bearer` and `max_completion_tokens` instead of
 * `max_tokens` (the reasoning-capable gpt-6 family rejects `max_tokens` on this API).
 *
 * Credential: FILE ONLY (see router-key-file.ts) -- OPENAI_API_KEY in the process environment
 * is an api-key selector the router refuses to start under, so the key comes from the dotenv
 * file named by OPENAI_API_KEY_FILE.
 *
 * DATA RULE: public or synthetic material only; `mcp__*` tools are never advertised upstream.
 */
export const OPENAI_API_KEY_VARIABLE = "OPENAI_API_KEY";
export const OPENAI_API_KEY_FILE_VARIABLE = "OPENAI_API_KEY_FILE";
export const OPENAI_API_MESSAGES_PATH = "/v1/chat/completions";
export const OPENAI_API_MODELS_PATH = "/v1/models";
const ERROR_SNIPPET_LIMIT = 300;
const LIST_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 30_000;
const OPENAI_API_LABEL = "OpenAI API";
function keyRemedy(): string {
    return `FIX: put an ${OPENAI_API_KEY_VARIABLE}=<key> line in the dotenv file named by ${OPENAI_API_KEY_FILE_VARIABLE}. The key is read from the FILE only; exporting ${OPENAI_API_KEY_VARIABLE} in the shell makes the router refuse to start (api-key selector guard).`;
}

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Credit exhaustion, MEASURED 2026-11-09 (kanit/openai/kota/): HTTP 429, error code "credit_balance_exhausted", type "insufficient_quota". */
function creditExhausted(body: unknown): boolean {
    const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
    if (error === undefined)
        return false;
    const type = typeof error["type"] === "string" ? error["type"] : undefined;
    const code = typeof error["code"] === "string" ? error["code"] : undefined;
    return type === "insufficient_quota" || code === "credit_balance_exhausted";
}

async function upstreamError(response: Response, key: string): Promise<RouterError> {
    let text = "";
    let body: unknown;
    try {
        text = (await response.text()).slice(0, 4_096);
        body = JSON.parse(text);
    }
    catch {
        body = undefined;
    }
    const scrubbed = text.split(key).join("[redacted]");
    const snippet = scrubbed.replace(/\s+/gu, " ").trim().slice(0, ERROR_SNIPPET_LIMIT);
    const detail = snippet === "" ? "" : ` Upstream said: ${snippet}`;
    const status = response.status;
    if (status === 401 || status === 403)
        return new RouterError("provider_auth_required", `The OpenAI API key was refused (HTTP ${status}). ${keyRemedy()}`, 401);
    if (status === 429) {
        if (creditExhausted(body))
            return new RouterError("provider_rate_limited", `OpenAI API lane openaiapi_credit_exhausted: the account has no credits remaining (HTTP 429, insufficient_quota / credit_balance_exhausted). FIX: add credits at https://platform.openai.com/settings/organization/billing/, then retry.`, 429);
        const retryAfter = response.headers.get("retry-after");
        return new RouterError("provider_rate_limited", `OpenAI API rate limit (HTTP 429).${detail}`, 429, retryAfter === null ? undefined : { retryAfter });
    }
    if (status === 404)
        return new RouterError("model_not_available", `The OpenAI API does not serve this model (HTTP 404).${detail}`, 404);
    if (status === 400 || status === 413 || status === 422)
        return new RouterError("invalid_request", `The OpenAI API rejected the request (HTTP ${status}).${detail}`, 400);
    return new RouterError("adapter_unavailable", `The OpenAI API failed (HTTP ${status}).${detail}`, 503);
}

/**
 * Reasoning effort: low/medium/high pass through; Claude Code's xhigh/max become "high"
 * (the API accepts exactly these three on the gpt-6 family).
 */
export function openAiApiKeyReasoning(envelope: MessageEnvelope): JsonRecord {
    const outputConfig = envelope["output_config"];
    const raw = isRecord(outputConfig) && outputConfig["effort"] !== undefined ? outputConfig["effort"] : envelope["reasoning_effort"];
    const effort = typeof raw === "string" ? raw.toLowerCase() : undefined;
    if (effort === undefined)
        return {};
    if (["low", "medium", "high"].includes(effort))
        return { reasoning_effort: effort };
    if (effort === "xhigh" || effort === "max")
        return { reasoning_effort: "high" };
    return {};
}

/** max_tokens is clamped only where a primary source gives a ceiling (Astra: 128,000, model card). */
function clampMaxTokens(contractMaximum: number | undefined, requested: unknown): number | undefined {
    const value = typeof requested === "number" && Number.isInteger(requested) && requested > 0 ? requested : undefined;
    if (value === undefined)
        return undefined;
    return contractMaximum === undefined ? value : Math.min(contractMaximum, value);
}

export class OpenAiApiKeyAdapter implements ProviderAdapter {
    readonly provider: "openaiapi" = "openaiapi";
    constructor(private readonly transport: HttpTransport, private readonly environment: NodeJS.ProcessEnv) {
    }

    /** Serving-time readiness: key resolvable, NO network call. */
    async readiness(): Promise<ProviderReadiness> {
        const key = (await resolveRouterOwnedKey(this.environment, OPENAI_API_KEY_VARIABLE, OPENAI_API_KEY_FILE_VARIABLE)).value;
        return key === undefined
            ? this.#down("auth_required", "openaiapi_key_missing", keyRemedy())
            : { provider: "openaiapi", oauthReady: true, adapterReady: true, status: "ready", detailCode: "openaiapi_api_key_present" };
    }

    /** Live catalogue for refresh: the model list (works even with no credits), then ONE tiny chat probe. */
    async catalog(): Promise<{ readonly readiness: ProviderReadiness; readonly models: readonly ProviderModelRecord[] }> {
        const key = (await resolveRouterOwnedKey(this.environment, OPENAI_API_KEY_VARIABLE, OPENAI_API_KEY_FILE_VARIABLE)).value;
        if (key === undefined) {
            return { readiness: this.#down("auth_required", "openaiapi_key_missing", keyRemedy()), models: [] };
        }
        let response: Response;
        try {
            response = await this.transport.send({
                path: OPENAI_API_MODELS_PATH,
                method: "GET",
                headers: new Headers({ accept: "application/json", authorization: `Bearer ${key}` }),
                signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
            });
        }
        catch {
            return { readiness: this.#down("unavailable", "openaiapi_unreachable", `The OpenAI API did not answer GET ${OPENAI_API_MODELS_PATH} within ${LIST_TIMEOUT_MS / 1_000} s. FIX: check the network, then claude-oauth models refresh.`), models: [] };
        }
        if (response.status === 401 || response.status === 403) {
            await response.body?.cancel();
            return { readiness: this.#down("auth_required", "openaiapi_key_rejected", `The OpenAI API refused the key (HTTP ${response.status}). ${keyRemedy()}`), models: [] };
        }
        if (response.status !== 200) {
            await response.body?.cancel();
            return { readiness: this.#down("unavailable", `openaiapi_models_http_${response.status}`, `FIX: retry claude-oauth models refresh later; the OpenAI API catalogue endpoint is failing.`), models: [] };
        }
        let parsed: unknown;
        try {
            parsed = await response.json();
        }
        catch {
            return { readiness: this.#down("unavailable", "openaiapi_models_invalid_json", "The OpenAI API answered the model list with a body that is not JSON."), models: [] };
        }
        const data = isRecord(parsed) && Array.isArray(parsed["data"]) ? parsed["data"] : [];
        const ids = data.flatMap((row): string[] => isRecord(row) && typeof row["id"] === "string" && row["id"] !== "" ? [row["id"]] : []);
        const matched = apiKeyModelContracts("openaiapi").filter((contract) => ids.includes(contract.upstreamModel));
        if (matched.length === 0) {
            return {
                readiness: this.#down("unavailable", `openaiapi_models_not_in_live_catalog:${apiKeyModelContracts("openaiapi").map((entry) => entry.upstreamModel).join(",")}`, "The OpenAI API lists none of this lane's contracted models. FIX: the contract list and the live catalogue have drifted; refresh cannot invent rows that cannot answer."),
                models: ids.map((id) => ({ id })),
            };
        }
        // MEASURED 2026-11-09: GET /v1/models answers 200 with a key that has NO credits, while
        // the chat probe answers 429 insufficient_quota -- the probe is what names the state.
        let probe: Response;
        try {
            probe = await this.transport.send({
                path: OPENAI_API_MESSAGES_PATH,
                method: "POST",
                headers: new Headers({ "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` }),
                body: new TextEncoder().encode(JSON.stringify({
                    model: matched[0]!.upstreamModel,
                    max_completion_tokens: 16,
                    messages: [{ role: "user", content: "Reply with the single word: pong" }],
                })),
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            });
        }
        catch {
            return { readiness: this.#down("unavailable", "openaiapi_probe_failed", `The OpenAI API did not answer the one-call live probe within ${PROBE_TIMEOUT_MS / 1_000} s. FIX: check the network, then claude-oauth models refresh.`), models: ids.map((id) => ({ id })) };
        }
        let body: unknown;
        try {
            body = await probe.json();
        }
        catch {
            body = undefined;
        }
        await probe.body?.cancel().catch(() => undefined);
        if (probe.status === 200) {
            return {
                readiness: { provider: "openaiapi", oauthReady: true, adapterReady: true, status: "ready", detailCode: `openaiapi_live_verified:${matched.length}_models` },
                models: ids.map((id) => ({ id })),
            };
        }
        if (probe.status === 429 && creditExhausted(body)) {
            return {
                readiness: {
                    provider: "openaiapi",
                    oauthReady: true,
                    adapterReady: false,
                    status: "blocked",
                    detailCode: "openaiapi_credit_exhausted",
                    remedy: "The key is valid and the model list answers, but every chat call is refused: HTTP 429 insufficient_quota / credit_balance_exhausted. FIX: add credits at https://platform.openai.com/settings/organization/billing/ (budget: 120 USD/month), then claude-oauth models refresh. Rows stay in the picker; requests fail with this named state until then.",
                },
                models: ids.map((id) => ({ id })),
            };
        }
        if (probe.status === 429)
            return { readiness: this.#down("unavailable", "openaiapi_probe_rate_limited", "The OpenAI API answered the live probe with HTTP 429 (not the credit code). FIX: retry claude-oauth models refresh later."), models: ids.map((id) => ({ id })) };
        if (probe.status === 401 || probe.status === 403)
            return { readiness: this.#down("auth_required", "openaiapi_key_rejected", `The OpenAI API refused the key at the chat endpoint (HTTP ${probe.status}). ${keyRemedy()}`), models: ids.map((id) => ({ id })) };
        return { readiness: this.#down("unavailable", `openaiapi_probe_http_${probe.status}`, `The OpenAI API answered the live probe with HTTP ${probe.status}. FIX: retry claude-oauth models refresh later.`), models: ids.map((id) => ({ id })) };
    }

    async send(request: AdapterRequest): Promise<AdapterResponse> {
        const contract = apiKeyModelContract("openaiapi", request.model.id);
        if (contract === undefined || request.model.upstreamModel !== contract.upstreamModel || request.model.provider !== "openaiapi") {
            throw new RouterError("model_not_available", "This model is not an OpenAI API contract row.", 404);
        }
        if (request.path === "/v1/messages/count_tokens") {
            const estimate = Math.max(1, Math.ceil(JSON.stringify(request.envelope).length / 4));
            return { status: 200, headers: new Headers({ "content-type": "application/json" }), body: new Blob([JSON.stringify({ input_tokens: estimate })]).stream() as ReadableStream<Uint8Array> };
        }
        const key = (await resolveRouterOwnedKey(this.environment, OPENAI_API_KEY_VARIABLE, OPENAI_API_KEY_FILE_VARIABLE)).value;
        if (key === undefined) {
            throw new RouterError("provider_auth_required", `The OpenAI API key is not available to the router. ${keyRemedy()}`, 401);
        }
        const streaming = request.envelope.stream === true;
        const maxTokens = clampMaxTokens(contract.maximumOutputTokens, request.envelope["max_tokens"]);
        const body = anthropicToOpenAi(request, {
            label: OPENAI_API_LABEL,
            stream: streaming,
            ...(maxTokens === undefined ? {} : { maxTokens }),
            maxTokensField: "max_completion_tokens",
            thinkingReplay: "drop",
            clientToolsOnly: true,
            // DATA RULE: MCP tools reach connected accounts; none is advertised.
            withheldToolPrefixes: ["mcp__"],
            reasoning: openAiApiKeyReasoning,
        });
        const encoded = new TextEncoder().encode(JSON.stringify(body));
        // FRESH headers only: the client's Claude OAuth `authorization` never reaches the
        // upstream; the one authorization on the wire is this lane's Bearer key.
        const response = await this.transport.send({
            path: OPENAI_API_MESSAGES_PATH,
            method: "POST",
            headers: new Headers({
                "content-type": "application/json",
                accept: streaming ? "text/event-stream" : "application/json",
                authorization: `Bearer ${key}`,
            }),
            body: encoded,
            signal: request.signal,
        });
        if (response.status >= 400) {
            throw await upstreamError(response, key);
        }
        if (response.body === null) {
            throw new RouterError("upstream_protocol_error", "The OpenAI API returned an empty body.", 502);
        }
        const configuredModel = request.envelope.model;
        if (!streaming) {
            const payload = openAiCompletionToAnthropic(await response.json(), configuredModel, OPENAI_API_LABEL);
            const bytes = Buffer.from(JSON.stringify(payload), "utf8");
            const usage = isRecord(payload["usage"]) ? payload["usage"] as Readonly<Record<string, number>> : undefined;
            return {
                status: 200,
                headers: new Headers({ "content-type": "application/json" }),
                body: new Blob([bytes]).stream() as ReadableStream<Uint8Array>,
                ...(typeof payload["id"] === "string" ? { providerRequestId: payload["id"] } : {}),
                ...(usage === undefined ? {} : { usage }),
            };
        }
        let settle: (value: { readonly providerRequestId?: string; readonly usage?: Readonly<Record<string, number>> }) => void = () => undefined;
        const completion = new Promise<{ readonly providerRequestId?: string; readonly usage?: Readonly<Record<string, number>> }>((resolve) => {
            settle = resolve;
        });
        const stream = openAiSseToAnthropic(response.body, configuredModel, {
            label: OPENAI_API_LABEL,
            emitReasoning: false,
            secrets: [key],
            ...(request.upstreamActivity === undefined ? {} : { onUpstreamRead: request.upstreamActivity }),
            onComplete: (outcome) => settle(outcome),
        });
        return {
            status: 200,
            headers: new Headers({ "content-type": "text/event-stream", "cache-control": "no-cache" }),
            body: stream,
            completion,
        };
    }

    #down(status: ProviderReadiness["status"], detailCode: string, remedy: string): ProviderReadiness {
        return { provider: "openaiapi", oauthReady: false, adapterReady: false, status, detailCode, remedy };
    }
}
