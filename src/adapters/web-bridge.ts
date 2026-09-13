import { readFile } from "node:fs/promises";
import type { AdapterRequest, AdapterResponse, HttpTransport, ProviderAdapter, ProviderReadiness } from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";

/**
 * ChatGPT Web lane. The upstream is Agent Web Bridge (operator's own project), a loopback
 * daemon that already speaks a subset of Anthropic Messages and drives a signed-in ChatGPT
 * tab through the operator's Chrome. This adapter is therefore a PROXY, not a translator:
 * it forwards the Messages body and streams the SSE back.
 *
 * What it does on top of a plain proxy, each measured against the bridge's own normalize()
 * (src/hermes_web_bridge/protocols/anthropic.py in the bridge repo, 2026-09-13):
 *
 *   1. model: Claude Code sends the router id; the bridge wants its profile name
 *      (chatgpt-web-instant, -medium, -high, -xhigh, -pro). That is model.upstreamModel.
 *   2. auth: the bridge requires its own local bearer (secrets.json -> api_key). Read from
 *      disk per call, never cached in a field that could end up in a log or receipt.
 *   3. fields the bridge refuses outright are removed before forwarding, because a refusal
 *      there is a hard 400 that Claude Code would show as an API error: `mcp_servers`,
 *      `container`, `context_management`, `output_config`, `thinking`, and any tool that
 *      carries `defer_loading`. `tool_choice` is forced to `{type:"auto"}`; anything else
 *      is refused by the bridge. `max_tokens` must be a positive integer, so a missing one
 *      gets the Claude Code default rather than a 400.
 *   4. count_tokens: the bridge's own endpoint answers with a local estimate too
 *      (protocols/__init__.py count_tokens, header x-hwb-usage: local-estimate-not-billing),
 *      so nothing is lost by answering here with the chars/4 estimate the other agent lanes
 *      use; it saves a round trip and Claude Code's context accounting keeps working.
 *
 * Readiness is three independent facts, each with its own detailCode, because "the lane is
 * down" without saying which of the three fell is an alarm nobody can act on.
 */
export interface WebBridgeAdapterOptions {
    /** Path of the bridge's secrets.json; the api_key inside is the local bearer. */
    readonly secretsPath: string;
    /** Path of the tunnel-client url_file; its content is the health base URL. */
    readonly tunnelHealthUrlFile: string;
    /** Chrome remote-debugging endpoint the bridge attaches to. */
    readonly chromeCdpUrl: string;
    /** Fetch for the readiness probes only; the message path uses the transport. */
    readonly probe?: typeof fetch;
}

const REFUSED_TOP_LEVEL = ["mcp_servers", "container", "context_management", "output_config", "thinking"] as const;

export class WebBridgeAdapter implements ProviderAdapter {
    readonly provider: "web" = "web";
    readonly #probe: typeof fetch;
    constructor(private readonly transport: HttpTransport, private readonly options: WebBridgeAdapterOptions) {
        this.#probe = options.probe ?? fetch;
    }

    async readiness(): Promise<ProviderReadiness> {
        // 1. bridge daemon: /health answers 401 when it is up (bearer required), anything
        //    else, including a refused connection, means it is not listening.
        const bridge = await this.#status(`http://127.0.0.1:8765/health`);
        if (bridge !== 401 && bridge !== 200) {
            return this.#down("web_bridge_daemon_down", "Start the bridge: agent-web-bridge serve");
        }
        // 2. tunnel-client: the url_file holds the health base; /readyz must say ready.
        let healthBase: string;
        try {
            healthBase = (await readFile(this.options.tunnelHealthUrlFile, "utf8")).trim();
        }
        catch {
            return this.#down("web_bridge_tunnel_not_started", "Start the tunnel: tunnel-client run --profile hermes-web-bridge");
        }
        const ready = await this.#text(`${healthBase}/readyz`);
        if (ready !== "ready") {
            return this.#down("web_bridge_tunnel_not_ready", "Wait for /readyz or restart: tunnel-client run --profile hermes-web-bridge");
        }
        // 3. Chrome CDP: the bridge attaches to a browser the operator runs.
        const chrome = await this.#status(`${this.options.chromeCdpUrl}/json/version`);
        if (chrome !== 200) {
            return this.#down("web_bridge_chrome_cdp_down", "Open the profile: agent-web-bridge chrome");
        }
        return { provider: this.provider, oauthReady: true, adapterReady: true, status: "ready", detailCode: "web_bridge_three_checks_passed" };
    }

    async send(request: AdapterRequest): Promise<AdapterResponse> {
        if (request.path === "/v1/messages/count_tokens") {
            return this.#countTokensLocally(request);
        }
        const bearer = await this.#bearer();
        const body = this.#conform(request);
        const headers = new Headers();
        headers.set("content-type", "application/json");
        headers.set("authorization", `Bearer ${bearer}`);
        headers.set("x-hwb-session", `claude-oauth-${request.requestId}`);
        const response = await this.transport.send({
            path: "/v1/messages",
            method: "POST",
            headers,
            body: new TextEncoder().encode(JSON.stringify(body)),
            signal: request.signal,
        });
        if (response.status === 423) {
            // The bridge holds uncertain remote work and refuses new turns until the operator
            // reconciles. Surface the one command that clears it.
            throw new RouterError("adapter_unavailable", "The ChatGPT Web bridge is paused. FIX: hwb status, then hwb reconcile <generation> --remote-stopped --note <why> and hwb resume --note <why>.", 503);
        }
        if (response.status === 413) {
            // Measured 2026-09-13: a vault session's first request exceeds the bridge's
            // max_body_bytes (2,000,000) and Claude Code then prints its own "max 32MB" text,
            // which names the wrong limit. A 400 with the real limits is what the user can act on.
            throw new RouterError("invalid_request", "The ChatGPT Web bridge refused the request as too large (bridge max_body_bytes / max_prompt_bytes; ChatGPT window 111,193 tokens). FIX: run a leaner session (claude --disable-slash-commands --tools \"\") or raise the limits in ~/.hermes-web-bridge/config.json.", 400);
        }
        return { status: response.status, headers: response.headers, body: response.body };
    }

    #conform(request: AdapterRequest): Record<string, unknown> {
        const envelope = { ...request.envelope } as Record<string, unknown>;
        envelope["model"] = request.model.upstreamModel;
        for (const key of REFUSED_TOP_LEVEL) {
            delete envelope[key];
        }
        envelope["tool_choice"] = { type: "auto" };
        if (typeof envelope["max_tokens"] !== "number" || !Number.isInteger(envelope["max_tokens"]) || (envelope["max_tokens"] as number) <= 0) {
            envelope["max_tokens"] = 32_000;
        }
        if (Array.isArray(envelope["tools"])) {
            envelope["tools"] = (envelope["tools"] as Record<string, unknown>[])
                .filter((tool) => tool["defer_loading"] !== true)
                .map((tool) => {
                    const copy = { ...tool };
                    delete copy["defer_loading"];
                    return copy;
                });
        }
        return envelope;
    }

    async #countTokensLocally(request: AdapterRequest): Promise<AdapterResponse> {
        const text = JSON.stringify(request.envelope);
        const estimate = Math.max(1, Math.ceil(text.length / 4));
        const payload = JSON.stringify({ input_tokens: estimate });
        const headers = new Headers({ "content-type": "application/json" });
        return {
            status: 200,
            headers,
            body: new Blob([payload]).stream() as ReadableStream<Uint8Array>,
        };
    }

    async #bearer(): Promise<string> {
        let raw: string;
        try {
            raw = await readFile(this.options.secretsPath, "utf8");
        }
        catch {
            throw new RouterError("adapter_unavailable", "The ChatGPT Web bridge secrets file is missing. FIX: hwb init --workspace <dir>.", 503);
        }
        const parsed = JSON.parse(raw) as { api_key?: unknown };
        if (typeof parsed.api_key !== "string" || parsed.api_key === "") {
            throw new RouterError("adapter_unavailable", "The ChatGPT Web bridge secrets file has no api_key.", 503);
        }
        return parsed.api_key;
    }

    async #status(url: string): Promise<number> {
        try {
            const response = await this.#probe(url, { signal: AbortSignal.timeout(3_000) });
            return response.status;
        }
        catch {
            return 0;
        }
    }

    async #text(url: string): Promise<string> {
        try {
            const response = await this.#probe(url, { signal: AbortSignal.timeout(3_000) });
            return (await response.text()).trim();
        }
        catch {
            return "";
        }
    }

    #down(detailCode: string, remedy: string): ProviderReadiness {
        return { provider: this.provider, oauthReady: false, adapterReady: false, status: "unavailable", detailCode, remedy };
    }
}
