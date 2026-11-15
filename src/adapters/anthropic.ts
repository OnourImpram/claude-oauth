import type { AdapterRequest, AdapterResponse, HttpTransport, ProviderAdapter, ProviderReadiness } from "../domain/contracts.js";
import { upstreamRequestHeaders } from "../router/headers.js";
export class AnthropicAdapter implements ProviderAdapter {
    readonly provider: "anthropic" = "anthropic";
    constructor(private readonly transport: HttpTransport) {
    }
    async readiness(): Promise<ProviderReadiness> {
        return {
            provider: this.provider,
            oauthReady: true,
            adapterReady: true,
            status: "ready",
            detailCode: "request_scoped_claude_oauth",
        };
    }
    async send(request: AdapterRequest): Promise<AdapterResponse> {
        const response = await this.transport.send({
            path: `${request.path}${request.query}`,
            method: "POST",
            headers: upstreamRequestHeaders(request.headers, true),
            body: request.body,
            signal: request.signal,
        });
        const providerRequestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
        return {
            status: response.status,
            headers: response.headers,
            body: response.body,
            // The body is Anthropic's own bytes, forwarded as they arrive: every chunk
            // (their pings included) is the provider speaking.
            upstreamDriven: true,
            ...(providerRequestId === undefined ? {} : { providerRequestId }),
        };
    }
}
