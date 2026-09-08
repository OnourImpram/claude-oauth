export const PROVIDER_IDS = ["anthropic", "openai", "xai", "google"] as const;
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
] as const;
export type RouterErrorCode = (typeof ROUTER_ERROR_CODES)[number];
// The supervisor IPC reader rejects a longer detailCode, and rejecting one field
// discards the WHOLE status: a running session then disappears from discovery. The
// bound lived only in the reader, so the producer was free to grow past it and did --
// a real catalog drift produced ~187 characters against a 128 limit. Raising the
// bound to 256 keeps the older, tested promise that EVERY drifting row is named --
// two contracts collided and the informative one won, with truncation left as the
// backstop for an absurd number of rows. It is one exported number now, referenced by
// both sides, and a test pins it: the sides can no longer drift apart in silence.
export const SUPERVISOR_DETAIL_CODE_LIMIT = 256;
export type Capability = "messages" | "streaming" | "tools" | "vision" | "thinking";
export const MODEL_EXECUTION_MODES = ["native-message-loop", "agent-readonly"] as const;
export type ModelExecutionMode = (typeof MODEL_EXECUTION_MODES)[number];
export interface ModelRecord {
    readonly id: string;
    readonly provider: ProviderId;
    readonly upstreamModel: string;
    readonly displayName: string;
    readonly oauthType: "claude.ai" | "chatgpt" | "xai-cli" | "google-cli";
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
}
export interface AdapterResponse {
    readonly status: number;
    readonly headers: Headers;
    readonly body: ReadableStream<Uint8Array> | null;
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
