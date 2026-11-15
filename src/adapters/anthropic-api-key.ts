import type { AdapterRequest, AdapterResponse, HttpTransport, MessageEnvelope, ProviderAdapter, ProviderModelRecord, ProviderReadiness } from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";
import { apiKeyModelContract, apiKeyModelContracts, type ApiKeyProvider } from "../domain/model-contracts.js";
import { MCP_TOOL_PREFIX, withholdMcpHistory } from "./mcp-history.js";
import { resolveRouterOwnedKey } from "./router-key-file.js";
import { foldToolAdditions } from "./tool-addition.js";

/**
 * Anthropic-protocol API-key lanes: Alibaba Token Plan and Z.AI (2026-11-09, operator request).
 *
 * The upstream speaks Anthropic Messages itself, so the request is PASSED THROUGH -- no
 * OpenAI translation, no response rewriting. Only three things are deliberately NOT passed
 * through:
 *   - every incoming header (fresh headers are built: `x-api-key`, `anthropic-version`),
 *     so a Claude OAuth `authorization` or an `anthropic-beta` oauth flag physically cannot
 *     reach the upstream;
 *   - `metadata` (Claude Code's user identifier is not the provider's business);
 *   - `mcp__*` tool definitions (DATA RULE: a tool the provider can call is a
 *     path for connected-account data to reach the provider in the tool result).
 *
 * Credential: see src/adapters/router-key-file.ts. Read per call; logs carry the lane NAME,
 * never the value; an upstream error body is scrubbed of the key before it is quoted.
 */
export const ALIBABA_KEY_VARIABLE = "ALIBABA_TOKEN_PLAN_API_KEY";
export const ALIBABA_KEY_FILE_VARIABLE = "ALIBABA_TOKEN_PLAN_API_KEY_FILE";
export const ZAI_KEY_VARIABLE = "ZAI_API_KEY";
export const ZAI_KEY_FILE_VARIABLE = "ZAI_API_KEY_FILE";
/** Z.AI's balance-exhaustion marker, MEASURED 2026-11-09 (kanit/uc-sinama3/zai-glm-5.3.txt): HTTP 429, error code "1113". */
export const ZAI_BALANCE_CODE = "1113";
const ERROR_SNIPPET_LIMIT = 300;
const LIST_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 30_000;

export interface AnthropicApiKeyLane {
    readonly provider: Extract<ApiKeyProvider, "alibaba" | "zai">;
    /** Lane name for every error message and log line. */
    readonly label: string;
    readonly keyVariable: string;
    readonly keyFileVariable: string;
    /** POST target for Messages, absolute path on the lane's fixed origin. */
    readonly messagesPath: string;
    /** GET target for the live model list (OpenAI-shaped `{"data":[{"id":...}]}`). */
    readonly modelsPath: string;
}

export const ALIBABA_LANE: AnthropicApiKeyLane = {
    provider: "alibaba",
    label: "Alibaba Token Plan",
    keyVariable: ALIBABA_KEY_VARIABLE,
    keyFileVariable: ALIBABA_KEY_FILE_VARIABLE,
    messagesPath: "/apps/anthropic/v1/messages",
    modelsPath: "/compatible-mode/v1/models",
};
export const ZAI_LANE: AnthropicApiKeyLane = {
    provider: "zai",
    label: "Z.AI",
    keyVariable: ZAI_KEY_VARIABLE,
    keyFileVariable: ZAI_KEY_FILE_VARIABLE,
    messagesPath: "/api/anthropic/v1/messages",
    modelsPath: "/api/paas/v4/models",
};

/** The remedy names both ways to supply the key: the lane's own dotenv file, or the shell variable. */
function laneRemedy(lane: AnthropicApiKeyLane): string {
    return `FIX: put a ${lane.keyVariable}=<key> line in the dotenv file named by ${lane.keyFileVariable}, or export ${lane.keyVariable} in the shell that starts claude-oauth.`;
}

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The passthrough envelope: the client's Messages body with the model swapped for the upstream
 * id, `metadata` dropped, `mcp__*` tools withheld and the `mcp__*` tool_use / tool_result pairs
 * of earlier turns replaced by text placeholders (mcp-history.ts). Everything else (system, messages,
 * thinking, max_tokens, stream) crosses untouched -- the upstream is Anthropic-compatible.
 *
 * `tool_addition` blocks are folded out of `messages` before the passthrough (tool-addition.ts
 * carries the measurement: Alibaba answers the whole body HTTP 400 while even one is present;
 * `defer_loading`, `context_management`, `output_config` and the 1h `ttl` are all accepted with
 * them gone). Each folded definition joins the outgoing `tools` -- no duplicate names, the block's
 * `cache_control` is not copied, `mcp__*` names withheld under the same data rule as the `tools`
 * array. Unknown block types are left as-is: no semantics are invented for unmeasured shapes.
 */
export function passthroughEnvelope(envelope: MessageEnvelope, upstreamModel: string): MessageEnvelope {
    const result: JsonRecord = { ...envelope, model: upstreamModel };
    delete result["metadata"];
    // Outgoing tools: the envelope's own, minus the mcp__* data rule; folded definitions join it.
    const outgoingTools: JsonRecord[] = Array.isArray(envelope.tools)
        ? envelope.tools.filter((tool): tool is JsonRecord => !(isRecord(tool) &&
            typeof tool["name"] === "string" &&
            (tool["name"] as string).startsWith("mcp__")))
        : [];
    const knownNames = new Set(outgoingTools
        .map((tool) => isRecord(tool) && typeof tool["name"] === "string" ? tool["name"] : undefined)
        .filter((name): name is string => name !== undefined));
    const fold = foldToolAdditions(envelope.messages, knownNames, [MCP_TOOL_PREFIX]);
    const sawToolAddition = fold.sawToolAddition;
    outgoingTools.push(...fold.definitions);
    if (fold.messages !== envelope.messages)
        result["messages"] = fold.messages;
    // DATA RULE on replayed history (audit D2-01): the same rule as the tools array, applied to
    // the mcp__ tool_use / tool_result pairs an earlier turn left in `messages`.
    const history = withholdMcpHistory(result["messages"], [MCP_TOOL_PREFIX]);
    if (history !== result["messages"])
        result["messages"] = history;
    if (Array.isArray(envelope.tools) || sawToolAddition) {
        if (outgoingTools.length === 0) {
            // tool_choice without tools is invalid Messages; a lane with no tools to advertise
            // is not offered a tool choice.
            delete result["tools"];
            delete result["tool_choice"];
        }
        else
            result["tools"] = outgoingTools;
    }
    return result as MessageEnvelope;
}

/** Reads a streaming Anthropic SSE body unchanged while extracting the receipt facts (id, usage). */
export function tapAnthropicSse(upstream: ReadableStream<Uint8Array>, onProviderEvent?: () => void): {
    readonly stream: ReadableStream<Uint8Array>;
    readonly completion: Promise<{ readonly providerRequestId?: string; readonly usage?: Readonly<Record<string, number>> }>;
} {
    let settle: (value: { readonly providerRequestId?: string; readonly usage?: Readonly<Record<string, number>> }) => void = () => undefined;
    const completion = new Promise<{ readonly providerRequestId?: string; readonly usage?: Readonly<Record<string, number>> }>((resolve) => {
        settle = resolve;
    });
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let providerRequestId: string | undefined;
    let usage: Readonly<Record<string, number>> | undefined;
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for (;;) {
                    const result = await reader.read();
                    if (result.done)
                        break;
                    controller.enqueue(result.value);
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
                        let parsed: unknown;
                        try {
                            parsed = JSON.parse(data);
                        }
                        catch {
                            continue;
                        }
                        if (!isRecord(parsed))
                            continue;
                        // Audit D3-02: every Messages event except `ping` is the provider speaking.
                        // A ping (and an SSE comment, which never gets here) only proves the
                        // connection is open, so it does not re-arm the router's silence guard.
                        if (parsed["type"] !== "ping")
                            onProviderEvent?.();
                        if (parsed["type"] === "message_start" && isRecord(parsed["message"]) && typeof parsed["message"]["id"] === "string")
                            providerRequestId = parsed["message"]["id"];
                        if (parsed["type"] === "message_delta" && isRecord(parsed["usage"])) {
                            const input = parsed["usage"]["input_tokens"];
                            const output = parsed["usage"]["output_tokens"];
                            if (typeof input === "number" && typeof output === "number")
                                usage = { input_tokens: input, output_tokens: output };
                        }
                    }
                }
                controller.close();
            }
            catch (error) {
                controller.error(error);
            }
            finally {
                reader.releaseLock();
                settle({ ...(providerRequestId === undefined ? {} : { providerRequestId }), ...(usage === undefined ? {} : { usage }) });
            }
        },
        async cancel(reason) {
            settle({ ...(providerRequestId === undefined ? {} : { providerRequestId }), ...(usage === undefined ? {} : { usage }) });
            await reader.cancel(reason);
        },
    });
    return { stream, completion };
}

interface UpstreamQuotaMarker {
    readonly detailCode?: string;
    readonly balanceExhausted: boolean;
}

/** The 429 body is inspected for the lane's named quota states (Z.AI code 1113 today). */
function quotaMarker(lane: AnthropicApiKeyLane, body: unknown): UpstreamQuotaMarker {
    const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
    const code = error !== undefined && typeof error["code"] === "string" ? error["code"] : undefined;
    const message = error !== undefined && typeof error["message"] === "string" ? error["message"] : undefined;
    if (lane.provider === "zai" && (code === ZAI_BALANCE_CODE || (message ?? "").includes(`[${ZAI_BALANCE_CODE}]`)))
        return { detailCode: "zai_balance_insufficient", balanceExhausted: true };
    return { balanceExhausted: false };
}

async function upstreamError(lane: AnthropicApiKeyLane, response: Response, key: string): Promise<RouterError> {
    let text = "";
    let body: unknown;
    try {
        text = (await response.text()).slice(0, 4_096);
        body = JSON.parse(text);
    }
    catch {
        body = undefined;
    }
    // No key value is ever quoted back, even if an upstream error body were to echo a header.
    const scrubbed = text.split(key).join("[redacted]");
    const snippet = scrubbed.replace(/\s+/gu, " ").trim().slice(0, ERROR_SNIPPET_LIMIT);
    const detail = snippet === "" ? "" : ` Upstream said: ${snippet}`;
    const status = response.status;
    const marker = quotaMarker(lane, body);
    if (status === 401 || status === 403)
        return new RouterError("provider_auth_required", `${lane.label} refused the key (HTTP ${status}). ${laneRemedy(lane)}`, 401);
    if (status === 429) {
        if (marker.balanceExhausted)
            return new RouterError("provider_rate_limited", `${lane.label} lane ${marker.detailCode}: the account has no balance or resource package left (upstream code ${ZAI_BALANCE_CODE}).${detail} FIX: top up the ${lane.label} account, then retry.`, 429);
        const retryAfter = response.headers.get("retry-after");
        return new RouterError("provider_rate_limited", `${lane.label} rate limit (HTTP 429).${detail}`, 429, retryAfter === null ? undefined : { retryAfter });
    }
    if (status === 404)
        return new RouterError("model_not_available", `${lane.label} does not serve this model or endpoint (HTTP 404).${detail}`, 404);
    if (status === 400 || status === 413 || status === 422)
        return new RouterError("invalid_request", `${lane.label} rejected the request (HTTP ${status}).${detail}`, 400);
    return new RouterError("adapter_unavailable", `${lane.label} failed (HTTP ${status}).${detail}`, 503);
}

export class AnthropicApiKeyAdapter implements ProviderAdapter {
    readonly provider: "alibaba" | "zai";
    constructor(private readonly transport: HttpTransport, private readonly lane: AnthropicApiKeyLane, private readonly environment: NodeJS.ProcessEnv) {
        this.provider = lane.provider;
    }

    /**
     * Serving-time readiness: the key is resolvable. Deliberately NO network call -- session
     * start must not wait on a remote service; membership was verified
     * live at refresh and a request that fails carries its own named remedy.
     */
    async readiness(): Promise<ProviderReadiness> {
        const key = (await resolveRouterOwnedKey(this.environment, this.lane.keyVariable, this.lane.keyFileVariable, this.lane.keyVariable)).value;
        return key === undefined
            ? this.#down("auth_required", `${this.lane.provider}_key_missing`, laneRemedy(this.lane))
            : { provider: this.lane.provider, oauthReady: true, adapterReady: true, status: "ready", detailCode: `${this.lane.provider}_api_key_present` };
    }

    /** Live catalogue for refresh: the model list, then ONE tiny chat probe. */
    async catalog(): Promise<{ readonly readiness: ProviderReadiness; readonly models: readonly ProviderModelRecord[] }> {
        const key = (await resolveRouterOwnedKey(this.environment, this.lane.keyVariable, this.lane.keyFileVariable, this.lane.keyVariable)).value;
        if (key === undefined) {
            return { readiness: this.#down("auth_required", `${this.lane.provider}_key_missing`, laneRemedy(this.lane)), models: [] };
        }
        let response: Response;
        try {
            response = await this.transport.send({
                path: this.lane.modelsPath,
                method: "GET",
                headers: new Headers({ accept: "application/json", "x-api-key": key }),
                signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
            });
        }
        catch {
            return { readiness: this.#down("unavailable", `${this.lane.provider}_unreachable`, `${this.lane.label} did not answer GET ${this.lane.modelsPath} within ${LIST_TIMEOUT_MS / 1_000} s. FIX: check the network, then claude-oauth models refresh.`), models: [] };
        }
        if (response.status === 401 || response.status === 403) {
            await response.body?.cancel();
            return { readiness: this.#down("auth_required", `${this.lane.provider}_key_rejected`, `${this.lane.label} refused the key (HTTP ${response.status}). ${laneRemedy(this.lane)}`), models: [] };
        }
        if (response.status !== 200) {
            await response.body?.cancel();
            return { readiness: this.#down("unavailable", `${this.lane.provider}_models_http_${response.status}`, `FIX: retry claude-oauth models refresh later; ${this.lane.label}'s catalogue endpoint is failing.`), models: [] };
        }
        let parsed: unknown;
        try {
            parsed = await response.json();
        }
        catch {
            return { readiness: this.#down("unavailable", `${this.lane.provider}_models_invalid_json`, `${this.lane.label} answered the model list with a body that is not JSON.`), models: [] };
        }
        const data = isRecord(parsed) && Array.isArray(parsed["data"]) ? parsed["data"] : [];
        const ids = data.flatMap((row): string[] => isRecord(row) && typeof row["id"] === "string" && row["id"] !== "" ? [row["id"]] : []);
        const matched = apiKeyModelContracts(this.lane.provider).filter((contract) => ids.includes(contract.upstreamModel));
        if (matched.length === 0) {
            return {
                readiness: this.#down("unavailable", `${this.lane.provider}_models_not_in_live_catalog:${apiKeyModelContracts(this.lane.provider).map((entry) => entry.upstreamModel).join(",")}`, `${this.lane.label} lists none of this lane's contracted models. FIX: the contract list and the live catalogue have drifted; refresh cannot invent rows that cannot answer.`),
                models: ids.map((id) => ({ id })),
            };
        }
        // One tiny chat probe: the list alone does not prove the lane can serve (Z.AI lists its
        // models with an empty balance). MEASURED shape of the probe answers is in kanit/.
        const probe = await this.#probe(key, matched[0]!.upstreamModel);
        if (probe !== undefined)
            return { readiness: probe, models: ids.map((id) => ({ id })) };
        return {
            readiness: { provider: this.lane.provider, oauthReady: true, adapterReady: true, status: "ready", detailCode: `${this.lane.provider}_live_verified:${matched.length}_models` },
            models: ids.map((id) => ({ id })),
        };
    }

    /** Readiness for a failed probe, or undefined when the probe answered 200. */
    async #probe(key: string, upstreamModel: string): Promise<ProviderReadiness | undefined> {
        let response: Response;
        try {
            response = await this.transport.send({
                path: this.lane.messagesPath,
                method: "POST",
                headers: new Headers({ "content-type": "application/json", accept: "application/json", "anthropic-version": "2023-06-01", "x-api-key": key }),
                body: new TextEncoder().encode(JSON.stringify({ model: upstreamModel, max_tokens: 64, messages: [{ role: "user", content: "Reply with the single word: pong" }] })),
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            });
        }
        catch {
            return this.#down("unavailable", `${this.lane.provider}_probe_failed`, `${this.lane.label} did not answer the one-call live probe within ${PROBE_TIMEOUT_MS / 1_000} s. FIX: check the network, then claude-oauth models refresh.`);
        }
        let body: unknown;
        try {
            body = await response.json();
        }
        catch {
            body = undefined;
        }
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 200)
            return undefined;
        const marker = quotaMarker(this.lane, body);
        if (response.status === 429 && marker.balanceExhausted)
            return {
                provider: this.lane.provider,
                oauthReady: true,
                adapterReady: false,
                status: "blocked",
                detailCode: "zai_balance_insufficient",
                remedy: `${this.lane.label} lists its models but every chat call is refused: HTTP 429 upstream code ${ZAI_BALANCE_CODE} (Insufficient balance or no resource package). FIX: recharge the ${this.lane.label} account, then claude-oauth models refresh. Rows stay in the picker; requests fail with this named state until then.`,
            };
        if (response.status === 429)
            return this.#down("unavailable", `${this.lane.provider}_probe_rate_limited`, `${this.lane.label} answered the live probe with HTTP 429 (not the balance code). FIX: retry claude-oauth models refresh later.`);
        if (response.status === 401 || response.status === 403)
            return this.#down("auth_required", `${this.lane.provider}_key_rejected`, `${this.lane.label} refused the key at the chat endpoint (HTTP ${response.status}). ${laneRemedy(this.lane)}`);
        return this.#down("unavailable", `${this.lane.provider}_probe_http_${response.status}`, `${this.lane.label} answered the live probe with HTTP ${response.status}. FIX: retry claude-oauth models refresh later.`);
    }

    async send(request: AdapterRequest): Promise<AdapterResponse> {
        const contract = apiKeyModelContract(this.lane.provider, request.model.id);
        if (contract === undefined || request.model.upstreamModel !== contract.upstreamModel || request.model.provider !== this.lane.provider) {
            throw new RouterError("model_not_available", `This model is not an ${this.lane.label} contract row.`, 404);
        }
        if (request.path === "/v1/messages/count_tokens") {
            // The upstream is not asked: chars/4 is the same local estimate the other lanes give.
            const estimate = Math.max(1, Math.ceil(JSON.stringify(request.envelope).length / 4));
            return { status: 200, headers: new Headers({ "content-type": "application/json" }), body: new Blob([JSON.stringify({ input_tokens: estimate })]).stream() as ReadableStream<Uint8Array> };
        }
        const key = (await resolveRouterOwnedKey(this.environment, this.lane.keyVariable, this.lane.keyFileVariable, this.lane.keyVariable)).value;
        if (key === undefined) {
            throw new RouterError("provider_auth_required", `The ${this.lane.label} API key is not available to the router. ${laneRemedy(this.lane)}`, 401);
        }
        const streaming = request.envelope.stream === true;
        // FRESH headers only: the client's authorization / anthropic-beta (Claude OAuth flags)
        // physically cannot reach the upstream because they are never copied.
        const headers = new Headers({
            "content-type": "application/json",
            accept: streaming ? "text/event-stream" : "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": key,
        });
        const encoded = new TextEncoder().encode(JSON.stringify(passthroughEnvelope(request.envelope, contract.upstreamModel)));
        const response = await this.transport.send({
            path: this.lane.messagesPath,
            method: "POST",
            headers,
            body: encoded,
            signal: request.signal,
        });
        if (response.status >= 400) {
            throw await upstreamError(this.lane, response, key);
        }
        if (response.body === null) {
            throw new RouterError("upstream_protocol_error", `${this.lane.label} returned an empty body.`, 502);
        }
        const providerRequestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
        if (!streaming) {
            // True passthrough of the bytes; the copy is only read for the receipt facts.
            const text = await response.text();
            let payload: unknown;
            try {
                payload = JSON.parse(text);
            }
            catch {
                payload = undefined;
            }
            const id = isRecord(payload) && typeof payload["id"] === "string" ? payload["id"] : undefined;
            const resolvedId = id ?? providerRequestId;
            const inputTokens = isRecord(payload) && isRecord(payload["usage"]) && typeof payload["usage"]["input_tokens"] === "number" ? payload["usage"]["input_tokens"] : undefined;
            const outputTokens = isRecord(payload) && isRecord(payload["usage"]) && typeof payload["usage"]["output_tokens"] === "number" ? payload["usage"]["output_tokens"] : undefined;
            return {
                status: 200,
                headers: new Headers({ "content-type": "application/json" }),
                body: new Blob([text]).stream() as ReadableStream<Uint8Array>,
                ...(resolvedId === undefined ? {} : { providerRequestId: resolvedId }),
                ...(inputTokens === undefined && outputTokens === undefined ? {} : { usage: { ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }), ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }) } }),
            };
        }
        const tapped = tapAnthropicSse(response.body, request.upstreamActivity);
        return {
            status: 200,
            headers: new Headers({ "content-type": "text/event-stream", "cache-control": "no-cache" }),
            body: tapped.stream,
            completion: tapped.completion,
            // The tap forwards the upstream's own bytes unchanged. It is NOT declared
            // upstream-driven any more (audit D3-02): that re-armed the silence guard on every
            // chunk, keep-alive pings included, so a stream with no content never ended. The tap
            // reports the events that carry something through `request.upstreamActivity` instead.
        };
    }

    #down(status: ProviderReadiness["status"], detailCode: string, remedy: string): ProviderReadiness {
        return { provider: this.lane.provider, oauthReady: false, adapterReady: false, status, detailCode, remedy };
    }
}
