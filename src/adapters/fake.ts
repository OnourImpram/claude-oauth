import type { AdapterRequest, AdapterResponse, ProviderAdapter, ProviderId, ProviderReadiness } from "../domain/contracts.js";
export class FakeAdapter implements ProviderAdapter {
    readonly requests: AdapterRequest[] = [];
    constructor(readonly provider: ProviderId, private readonly responseFactory: (request: AdapterRequest) => AdapterResponse | Promise<AdapterResponse>, private readonly ready = true) {
    }
    async readiness(): Promise<ProviderReadiness> {
        return {
            provider: this.provider,
            oauthReady: this.ready,
            adapterReady: this.ready,
            status: this.ready ? "ready" : "auth_required",
        };
    }
    async send(request: AdapterRequest): Promise<AdapterResponse> {
        this.requests.push(request);
        return await this.responseFactory(request);
    }
}
