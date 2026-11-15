// alibaba / zai / openaiapi (2026-11-09): the router-owned API-key lanes. alibaba
// and zai speak Anthropic Messages natively (passthrough); openaiapi speaks OpenAI chat
// completions (translated). All three read their key from a dotenv file per call and never pass
// it to a child. They are SEPARATE from the `openai` lane (ChatGPT OAuth / clodex).
export const PROVIDER_IDS = ["anthropic", "openai", "xai", "google", "web", "alibaba", "zai", "openaiapi"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const ROUTER_ERROR_CODES = [
    "provider_auth_required",
    "provider_entitlement_denied",
    "model_not_available",
    "unsupported_feature",
    "provider_rate_limited",
    // The child could not obtain permission for a tool and stopped. Distinct from
    // entitlement (the account lacks the model), auth (a login is missing) and rate
    // limiting (quota): here the account, login and quota are all fine and the run
    // still produced nothing. A condition without a name gets the wrong remedy.
    "provider_tool_permission_denied",
    "upstream_protocol_error",
    "adapter_unavailable",
    "upstream_timeout",
    "invalid_request",
    "session_auth_required",
    // The router itself failed (a file it needs is missing, its configuration does not parse,
    // an internal error) and no provider is implicated. Without this name such a failure was
    // printed as upstream_protocol_error, "the provider returned an invalid response".
    "local_failure",
] as const;
export type RouterErrorCode = (typeof ROUTER_ERROR_CODES)[number];
// The credential classes a model row can declare. ONE list: the snapshot validator and the
// receipt reader each carried their own copy, the validator learned "chatgpt-web" and
// "api-key" and the reader did not, so `claude-oauth receipt` called a well-formed file
// malformed after any request on the newest lanes (audit D1-02, 2026-11-15).
// "api-key": the lanes that are not an OAuth session (alibaba, zai, openaiapi). The
// key is read by the router process at call time and never enters any child environment.
/**
 * The values Claude Code names for its `x-claude-code-request-class` header (MEASURED
 * 2026-11-15 in the 2.1.325 binary). A closed list: a value outside it is not recorded.
 */
export const REQUEST_CLASSES = ["main", "subagent", "workflow", "compaction", "auxiliary", "side_reply"] as const;
export type RequestClass = (typeof REQUEST_CLASSES)[number];
export const OAUTH_TYPES = ["claude.ai", "chatgpt", "xai-cli", "google-cli", "chatgpt-web", "api-key"] as const;
export type OAuthType = (typeof OAUTH_TYPES)[number];
// The supervisor IPC reader rejects a longer detailCode, and rejecting one field
// discards the WHOLE status: a running session then disappears from discovery. The
// bound lived only in the reader, so the producer was free to grow past it and did --
// a real catalog drift produced ~187 characters against a 128 limit. Raising the
// bound to 256 keeps the older, tested promise that EVERY drifting row is named --
// two contracts collided and the informative one won, with truncation left as the
// backstop for an absurd number of rows. It is one exported number now, referenced by
// both sides, and a test pins it: the sides can no longer drift apart in silence.
//
// 2026-11-15: 256 -> 512. The ChatGPT-OAuth lane grew from three contract rows to seven, and a
// drift of all seven needs ~440 characters; at 256 the code named three rows and counted the
// rest ("+4_more"), which is exactly the mute status the promise above exists to prevent
// (test/model-refresh.test.ts, "EVERY row is reported by name"). 512 names up to eight rows;
// truncation stays the backstop beyond that. The lane has four rows now (one per model family,
// see OPENAI_MODEL_CONTRACTS), so the 512 bound is headroom; the bound itself is kept because
// the IPC reader and the producer share it and a test pins it.
export const SUPERVISOR_DETAIL_CODE_LIMIT = 512;
export type Capability = "messages" | "streaming" | "tools" | "vision" | "thinking";
export const MODEL_EXECUTION_MODES = ["native-message-loop", "agent-readonly"] as const;
export type ModelExecutionMode = (typeof MODEL_EXECUTION_MODES)[number];
export interface ModelRecord {
    readonly id: string;
    readonly provider: ProviderId;
    readonly upstreamModel: string;
    readonly displayName: string;
    readonly oauthType: OAuthType;
    readonly executionMode: ModelExecutionMode;
    readonly discoverable: boolean;
    readonly contextWindow?: number;
    readonly maximumOutputTokens?: number;
    readonly capabilities: readonly Capability[];
}
export interface ProviderModelRecord {
    readonly id: string;
    readonly contextWindow?: number;
    readonly maximumOutputTokens?: number;
}
export interface ModelSnapshot {
    readonly schemaVersion: 1;
    readonly generatedAt: string;
    readonly source: string;
    readonly models: readonly ModelRecord[];
}
export interface MessageEnvelope {
    readonly model: string;
    readonly stream?: boolean;
    readonly messages?: readonly unknown[];
    readonly tools?: readonly unknown[];
    readonly thinking?: unknown;
    readonly [key: string]: unknown;
}
export interface AdapterRequest {
    readonly requestId: string;
    readonly path: "/v1/messages" | "/v1/messages/count_tokens";
    readonly query: string;
    readonly model: ModelRecord;
    readonly envelope: MessageEnvelope;
    readonly body: Uint8Array;
    readonly headers: Headers;
    readonly signal: AbortSignal;
    /**
     * For an adapter that builds the response body itself (translation, synthetic
     * keep-alives): call this each time bytes arrive from the provider. The router's silence
     * guard measures how long the PROVIDER has been quiet, and a body chunk the adapter
     * generated is not the provider speaking.
     */
    readonly upstreamActivity?: () => void;
}
export interface AdapterResponse {
    readonly status: number;
    readonly headers: Headers;
    readonly body: ReadableStream<Uint8Array> | null;
    /**
     * True when the body is the provider's own bytes, forwarded as they arrive. The router
     * then treats every chunk as the provider speaking. Leave it unset for a body the adapter
     * generates: the guard then bounds the whole response unless upstreamActivity is called.
     */
    readonly upstreamDriven?: boolean;
    readonly providerRequestId?: string;
    readonly usage?: Readonly<Record<string, number>>;
    readonly completion?: Promise<{
        readonly providerRequestId?: string;
        readonly usage?: Readonly<Record<string, number>>;
    }>;
}
export interface ProviderReadiness {
    readonly provider: ProviderId;
    readonly oauthReady: boolean;
    readonly adapterReady: boolean;
    readonly status: "ready" | "auth_required" | "unavailable" | "blocked";
    readonly expiresAt?: string;
    readonly detailCode?: string;
    /**
     * A detector ships with its remedy. A detailCode names WHAT fell; without this a
     * reader who has never seen the code has nothing to act on, and an alarm nobody
     * can act on becomes noise. Optional: only the arms that HAVE a one-move fix
     * carry it, so an empty remedy is never mistaken for "nothing to do".
     */
    readonly remedy?: string;
}
export interface ProviderAdapter {
    readonly provider: ProviderId;
    readiness(): Promise<ProviderReadiness>;
    send(request: AdapterRequest): Promise<AdapterResponse>;
}
export interface RouteReceipt {
    readonly schemaVersion: 1;
    readonly timestamp: string;
    readonly requestId: string;
    readonly requestedModel: string;
    readonly configuredModel: string;
    readonly provider: ProviderId;
    readonly oauthType: ModelRecord["oauthType"];
    readonly providerRequestId?: string;
    readonly durationMs: number;
    readonly status: "completed" | "failed" | "cancelled";
    readonly errorCode?: RouterErrorCode;
    readonly usage?: Readonly<Record<string, number>>;
    /** What kind of request the client said this was; absent when it did not say. Never routed on. */
    readonly requestClass?: RequestClass;
}
export interface HttpTransportRequest {
    readonly path: string;
    readonly method: "GET" | "POST";
    readonly headers: Headers;
    readonly body?: Uint8Array;
    readonly signal: AbortSignal;
}
export interface HttpTransport {
    send(request: HttpTransportRequest): Promise<Response>;
}
