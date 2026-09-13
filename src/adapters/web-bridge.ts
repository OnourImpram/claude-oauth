import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AdapterRequest, AdapterResponse, HttpTransport, MessageEnvelope, ProviderAdapter, ProviderReadiness } from "../domain/contracts.js";
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
 *   3. fields the bridge refuses or ignores are removed before forwarding, because a refusal
 *      there is a hard 400 that Claude Code would show as an API error: `mcp_servers`,
 *      `container`, `context_management`, `output_config` (refused when `.format` is set),
 *      `thinking` (noted, never applied), any tool that carries `defer_loading`, any tool
 *      whose `type` is set and is not `custom` (bridge: unsupported_tool_type), and any
 *      `mcp__*` tool: measured 2026-09-13 in a vault session, a plugin tool's input_schema
 *      failed the bridge's Draft 2020-12 check_schema (400 invalid_schema) and the whole
 *      turn died; the operator's bridge policy auto-approves only Claude Code's built-in
 *      tools anyway, so an MCP tool would stall on manual approval even if its schema
 *      passed. Then, when the bridge says which tools it auto-approves (`/health` ->
 *      `auto_approved_tools`), every other tool is dropped too: measured 2026-09-13 22:07,
 *      a vault turn proposed `Skill`, no bridge rule matched, the operation sat in
 *      PROPOSED for ten minutes while the model's tool call timed out twice, and the turn
 *      died of completion_contract_missing. A tool the bridge would hold for a manual
 *      approval nobody is watching is never advertised. An older bridge without that
 *      field gets the unfiltered list, as before. `tool_choice` is forced to
 *      `{type:"auto"}`; anything else is refused by the bridge. `max_tokens` must be a
 *      positive integer, so a missing one gets the Claude Code default rather than a 400.
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
    /** Bridge origin for the readiness probe; must equal the transport's origin. */
    readonly origin?: string;
}

const REFUSED_TOP_LEVEL = ["mcp_servers", "container", "context_management", "output_config", "thinking"] as const;

export class WebBridgeAdapter implements ProviderAdapter {
    readonly provider: "web" = "web";
    readonly #probe: typeof fetch;
    // One bridge session per CONVERSATION, not per HTTP request and not per process. The
    // bridge keys its ledger on x-hwb-session: a tool_result under a different session is
    // refused as foreign_result (gateway.py:81-89), so a per-request id broke every tool
    // round-trip (denetim 2026-09-13, A1); and one session holds one active conversation,
    // so a per-process id made Claude Code's side request (session title) collide with the
    // main turn (measured: 409 "Active session cannot be replaced"). The first message of a
    // conversation is stable across a tool round-trip and differs between conversations,
    // so its digest is the session; a body without messages falls back to the instance id.
    readonly #instance = `claude-oauth-${randomUUID()}`;
    readonly #origin: string;
    /** Tool names the bridge auto-approves; undefined until /health has said (or if it cannot). */
    #approved: ReadonlySet<string> | undefined;
    constructor(private readonly transport: HttpTransport, private readonly options: WebBridgeAdapterOptions) {
        this.#probe = options.probe ?? fetch;
        this.#origin = (options.origin ?? "http://127.0.0.1:8765").replace(/\/$/u, "");
    }

    async readiness(): Promise<ProviderReadiness> {
        // 1. bridge daemon: /health answers 401 without a bearer and, with one, a JSON body
        //    carrying `paused`. Measured 2026-09-13: the daemon's CDP link drops after
        //    ~25 min and the engine pauses the account (driver_failure); a bare 401 probe
        //    then says "up" while every request 503s (denetim A2). So the probe carries the
        //    bearer and reads the pause flag, which also proves the bearer at refresh time.
        let bearer: string;
        try {
            bearer = await this.#bearer();
        }
        catch (error) {
            return this.#down("web_bridge_secrets_missing", error instanceof RouterError ? error.message : "Run hwb init.");
        }
        const health = await this.#json(`${this.#origin}/health`, bearer);
        if (health.status === 0) {
            return this.#down("web_bridge_daemon_down", "Start the bridge: agent-web-bridge up");
        }
        if (health.status === 401 || health.status === 403) {
            return this.#down("web_bridge_bearer_rejected", "The bridge rejected the local bearer. FIX: hwb init (secrets.json), then restart the bridge.");
        }
        if (health.status !== 200) {
            return this.#down("web_bridge_daemon_unhealthy", `Bridge /health answered ${health.status}. FIX: hwb status; restart the bridge.`);
        }
        this.#learnPolicy(health.body);
        if (health.body?.["paused"] === true) {
            return this.#down("web_bridge_paused", "The bridge is paused. FIX: hwb status, then hwb reconcile <generation> --remote-stopped --note <why> and hwb resume --note <why>.");
        }
        // 2. tunnel-client: the url_file holds the health base; /readyz must say ready. The
        //    base must be loopback: this probe never leaves the machine by construction, not
        //    by today's file content.
        let healthBase: string;
        try {
            healthBase = (await readFile(this.options.tunnelHealthUrlFile, "utf8")).trim();
        }
        catch {
            return this.#down("web_bridge_tunnel_not_started", "Start the tunnel: agent-web-bridge up");
        }
        if (!isLoopbackUrl(healthBase)) {
            return this.#down("web_bridge_tunnel_not_ready", "The tunnel health url_file does not point at loopback; restart tunnel-client.");
        }
        const ready = await this.#text(`${healthBase.replace(/\/$/u, "")}/readyz`);
        if (ready !== "ready") {
            return this.#down("web_bridge_tunnel_not_ready", "Wait for /readyz or restart: agent-web-bridge up");
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
        if (this.#approved === undefined) {
            this.#learnPolicy((await this.#json(`${this.#origin}/health`, bearer)).body);
        }
        const body = this.#conform(request);
        const headers = new Headers();
        headers.set("content-type", "application/json");
        headers.set("authorization", `Bearer ${bearer}`);
        headers.set("x-hwb-session", this.#sessionFor(request.envelope));
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
        if (response.status === 401) {
            throw new RouterError("provider_auth_required", "The ChatGPT Web bridge rejected the local bearer. FIX: hwb init (secrets.json), then restart the bridge.", 401);
        }
        if (response.status === 413) {
            // Measured 2026-09-13: a vault session's first request exceeds the bridge's
            // max_body_bytes (2,000,000) and Claude Code then prints its own "max 32MB" text,
            // which names the wrong limit. A 400 with the real limits is what the user can act on.
            throw new RouterError("invalid_request", "The ChatGPT Web bridge refused the request as too large (bridge max_body_bytes / max_prompt_bytes; ChatGPT window 111,193 tokens). FIX: run a leaner session (claude --disable-slash-commands --tools \"\") or raise the limits in ~/.hermes-web-bridge/config.json.", 400);
        }
        return { status: response.status, headers: response.headers, body: response.body };
    }

    #sessionFor(envelope: MessageEnvelope): string {
        const first = Array.isArray(envelope.messages) ? envelope.messages[0] : undefined;
        if (first === undefined) {
            return this.#instance;
        }
        return `claude-oauth-${createHash("sha256").update(JSON.stringify(first)).digest("hex").slice(0, 32)}`;
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
                .filter((tool) => tool["type"] === undefined || tool["type"] === "custom")
                .filter((tool) => !(typeof tool["name"] === "string" && tool["name"].startsWith("mcp__")))
                .filter((tool) => this.#approved === undefined || (typeof tool["name"] === "string" && this.#approved.has(tool["name"])))
                .map((tool) => {
                    const copy = { ...tool };
                    delete copy["defer_loading"];
                    return copy;
                });
        }
        return envelope;
    }

    #learnPolicy(body: Record<string, unknown> | undefined): void {
        const names = body?.["auto_approved_tools"];
        if (Array.isArray(names) && names.every((name) => typeof name === "string")) {
            this.#approved = new Set(names as string[]);
        }
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

    async #json(url: string, bearer: string): Promise<{ status: number; body?: Record<string, unknown> }> {
        try {
            const response = await this.#probe(url, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(3_000) });
            let body: Record<string, unknown> | undefined;
            try {
                const parsed: unknown = await response.json();
                body = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
            }
            catch {
                body = undefined;
            }
            return body === undefined ? { status: response.status } : { status: response.status, body };
        }
        catch {
            return { status: 0 };
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

function isLoopbackUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    }
    catch {
        return false;
    }
}
