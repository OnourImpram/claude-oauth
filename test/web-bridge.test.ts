import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WebBridgeAdapter } from "../src/adapters/web-bridge.js";
import type { AdapterRequest, HttpTransport, HttpTransportRequest, MessageEnvelope, ModelRecord, ModelSnapshot } from "../src/domain/contracts.js";
import { RouterError } from "../src/domain/errors.js";
import { WEB_MODEL_CONTRACTS, autoCompactWindowForModel } from "../src/domain/model-contracts.js";
import { withVerifiedWebModels } from "../src/domain/model-refresh.js";
import { parseModelSnapshot } from "../src/domain/validation.js";

// The ChatGPT Web lane is a proxy in front of Agent Web Bridge. Every rule below is a
// hard 400 on the bridge side (its normalize() refuses the field) or a Claude Code
// behaviour the router has to fake (count_tokens). A test here fails when the adapter
// forwards something the bridge refuses, so a bridge 400 never reaches the picker.

const model: ModelRecord = {
    id: "anthropic-web-chatgpt-high",
    provider: "web",
    upstreamModel: "chatgpt-web-high",
    displayName: "ChatGPT Web High",
    oauthType: "chatgpt-web",
    executionMode: "native-message-loop",
    discoverable: true,
    contextWindow: 111_193,
    capabilities: ["messages", "streaming", "tools"],
};

function request(envelope: MessageEnvelope, path: AdapterRequest["path"] = "/v1/messages"): AdapterRequest {
    return {
        requestId: "req-1",
        path,
        query: "",
        model,
        envelope,
        body: new Uint8Array(),
        headers: new Headers(),
        signal: AbortSignal.timeout(5_000),
    };
}

async function secretsFile(apiKey: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "hwb-secrets-"));
    const path = join(dir, "secrets.json");
    await writeFile(path, JSON.stringify(apiKey === null ? {} : { api_key: apiKey }));
    return path;
}

function capturingTransport(sink: { sent?: HttpTransportRequest }, status = 200): HttpTransport {
    return {
        send: async (sent) => {
            sink.sent = sent;
            return new Response("{}", { status, headers: { "content-type": "application/json" } });
        },
    };
}

function probeReturning(routes: Record<string, { status: number; text?: string }>): typeof fetch {
    return (async (input: string | URL | Request) => {
        const url = String(input);
        const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
        if (hit === undefined) {
            throw new TypeError("fetch failed");
        }
        return new Response(hit[1].text ?? "", { status: hit[1].status });
    }) as typeof fetch;
}

async function adapterWith(sink: { sent?: HttpTransportRequest }, apiKey: unknown = "local-test-key", status = 200): Promise<WebBridgeAdapter> {
    return new WebBridgeAdapter(capturingTransport(sink, status), {
        secretsPath: await secretsFile(apiKey),
        tunnelHealthUrlFile: join(tmpdir(), "does-not-exist.url"),
        chromeCdpUrl: "http://127.0.0.1:1",
    });
}

function sentBody(sink: { sent?: HttpTransportRequest }): Record<string, unknown> {
    ok(sink.sent?.body !== undefined);
    return JSON.parse(new TextDecoder().decode(sink.sent.body)) as Record<string, unknown>;
}

describe("WebBridgeAdapter send", () => {
    it("forwards to /v1/messages with the bridge profile as model and the local bearer", async () => {
        const sink: { sent?: HttpTransportRequest } = {};
        const adapter = await adapterWith(sink);
        const response = await adapter.send(request({ model: "anthropic-web-chatgpt-high", max_tokens: 100, messages: [] }));
        strictEqual(response.status, 200);
        strictEqual(sink.sent?.path, "/v1/messages");
        strictEqual(sink.sent?.method, "POST");
        strictEqual(sink.sent?.headers.get("authorization"), "Bearer local-test-key");
        strictEqual(sink.sent?.headers.get("x-hwb-session"), "claude-oauth-req-1");
        strictEqual(sentBody(sink)["model"], "chatgpt-web-high");
    });

    it("strips every top-level field the bridge refuses and forces tool_choice auto", async () => {
        const sink: { sent?: HttpTransportRequest } = {};
        const adapter = await adapterWith(sink);
        await adapter.send(request({
            model: "x",
            max_tokens: 10,
            messages: [],
            mcp_servers: [{ name: "a" }],
            container: "c",
            context_management: { edits: [] },
            output_config: { effort: "high" },
            thinking: { type: "enabled", budget_tokens: 1000 },
            tool_choice: { type: "tool", name: "Read" },
        }));
        const body = sentBody(sink);
        for (const key of ["mcp_servers", "container", "context_management", "output_config", "thinking"]) {
            strictEqual(key in body, false, `${key} must not reach the bridge`);
        }
        deepStrictEqual(body["tool_choice"], { type: "auto" });
    });

    it("drops deferred tools and the defer_loading flag on the rest", async () => {
        const sink: { sent?: HttpTransportRequest } = {};
        const adapter = await adapterWith(sink);
        await adapter.send(request({
            model: "x",
            max_tokens: 10,
            messages: [],
            tools: [
                { name: "Read", input_schema: { type: "object" } },
                { name: "Lazy", input_schema: { type: "object" }, defer_loading: true },
                { name: "Eager", input_schema: { type: "object" }, defer_loading: false },
            ],
        }));
        const tools = sentBody(sink)["tools"] as Record<string, unknown>[];
        deepStrictEqual(tools.map((tool) => tool["name"]), ["Read", "Eager"]);
        ok(tools.every((tool) => !("defer_loading" in tool)));
    });

    it("supplies a positive integer max_tokens when Claude Code sent none or a bad one", async () => {
        const sink: { sent?: HttpTransportRequest } = {};
        const adapter = await adapterWith(sink);
        await adapter.send(request({ model: "x", messages: [] }));
        strictEqual(sentBody(sink)["max_tokens"], 32_000);
        await adapter.send(request({ model: "x", messages: [], max_tokens: 0 }));
        strictEqual(sentBody(sink)["max_tokens"], 32_000);
        await adapter.send(request({ model: "x", messages: [], max_tokens: 4_096 }));
        strictEqual(sentBody(sink)["max_tokens"], 4_096);
    });

    it("answers count_tokens locally without touching the transport", async () => {
        const sink: { sent?: HttpTransportRequest } = {};
        const adapter = await adapterWith(sink);
        const response = await adapter.send(request({ model: "x", messages: [{ role: "user", content: "a".repeat(400) }] }, "/v1/messages/count_tokens"));
        strictEqual(response.status, 200);
        strictEqual(sink.sent, undefined);
        const payload = JSON.parse(await new Response(response.body).text()) as { input_tokens: number };
        ok(payload.input_tokens >= 100, `chars/4 estimate, got ${payload.input_tokens}`);
    });

    it("maps the bridge's 423 pause to adapter_unavailable with the reconcile remedy", async () => {
        const sink: { sent?: HttpTransportRequest } = {};
        const adapter = await adapterWith(sink, "k", 423);
        await rejects(
            adapter.send(request({ model: "x", max_tokens: 1, messages: [] })),
            (error: unknown) => error instanceof RouterError && error.code === "adapter_unavailable" && /hwb reconcile/.test(error.message),
        );
    });

    it("maps the bridge's 413 to invalid_request naming the real limits", async () => {
        const sink: { sent?: HttpTransportRequest } = {};
        const adapter = await adapterWith(sink, "k", 413);
        await rejects(
            adapter.send(request({ model: "x", max_tokens: 1, messages: [] })),
            (error: unknown) => error instanceof RouterError && error.code === "invalid_request" && error.status === 400 && /max_body_bytes/.test(error.message),
        );
    });

    it("refuses to send without a usable local bearer", async () => {
        const sink: { sent?: HttpTransportRequest } = {};
        const missing = await adapterWith(sink, null);
        await rejects(missing.send(request({ model: "x", max_tokens: 1, messages: [] })), (error: unknown) => error instanceof RouterError && error.code === "adapter_unavailable");
        strictEqual(sink.sent, undefined);
    });
});

describe("WebBridgeAdapter readiness", () => {
    const bridgeUp = { "http://127.0.0.1:8765/health": { status: 401 } };

    async function adapterFor(routes: Record<string, { status: number; text?: string }>, healthUrlFile?: string): Promise<WebBridgeAdapter> {
        return new WebBridgeAdapter(capturingTransport({}), {
            secretsPath: await secretsFile("k"),
            tunnelHealthUrlFile: healthUrlFile ?? join(tmpdir(), "hwb-no-such-file.url"),
            chromeCdpUrl: "http://127.0.0.1:9222",
            probe: probeReturning(routes),
        });
    }

    async function healthUrlFile(base: string): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), "hwb-health-"));
        const path = join(dir, "hermes-web-bridge.url");
        await writeFile(path, `${base}\n`);
        return path;
    }

    it("names the bridge daemon when nothing listens on 8765", async () => {
        const adapter = await adapterFor({});
        const readiness = await adapter.readiness();
        strictEqual(readiness.status, "unavailable");
        strictEqual(readiness.detailCode, "web_bridge_daemon_down");
        ok(readiness.remedy?.includes("serve"));
    });

    it("names the tunnel when the url_file is absent", async () => {
        const adapter = await adapterFor(bridgeUp);
        const readiness = await adapter.readiness();
        strictEqual(readiness.detailCode, "web_bridge_tunnel_not_started");
    });

    it("names the tunnel when /readyz does not say ready", async () => {
        const adapter = await adapterFor({ ...bridgeUp, "http://127.0.0.1:7000/readyz": { status: 503, text: "not ready" } }, await healthUrlFile("http://127.0.0.1:7000"));
        const readiness = await adapter.readiness();
        strictEqual(readiness.detailCode, "web_bridge_tunnel_not_ready");
    });

    it("names Chrome when CDP is closed", async () => {
        const adapter = await adapterFor({ ...bridgeUp, "http://127.0.0.1:7000/readyz": { status: 200, text: "ready" } }, await healthUrlFile("http://127.0.0.1:7000"));
        const readiness = await adapter.readiness();
        strictEqual(readiness.detailCode, "web_bridge_chrome_cdp_down");
    });

    it("is ready only when all three answer", async () => {
        const adapter = await adapterFor({
            ...bridgeUp,
            "http://127.0.0.1:7000/readyz": { status: 200, text: "ready" },
            "http://127.0.0.1:9222/json/version": { status: 200, text: "{}" },
        }, await healthUrlFile("http://127.0.0.1:7000"));
        const readiness = await adapter.readiness();
        strictEqual(readiness.status, "ready");
        strictEqual(readiness.detailCode, "web_bridge_three_checks_passed");
    });
});

describe("withVerifiedWebModels", () => {
    const baseline: ModelSnapshot = {
        schemaVersion: 1,
        generatedAt: "2026-09-13T00:00:00.000Z",
        source: "default",
        models: [
            { ...model, id: "anthropic-web-chatgpt-pro", upstreamModel: "chatgpt-web-pro", displayName: "stale" },
            { id: "claude-opus-5", provider: "anthropic", upstreamModel: "claude-opus-5", displayName: "Opus", oauthType: "claude.ai", executionMode: "native-message-loop", discoverable: true, capabilities: ["messages"] },
        ],
    };

    it("adds the five contract rows when the lane is ready and replaces stale web rows", () => {
        const snapshot = withVerifiedWebModels(baseline, true);
        const web = snapshot.models.filter((entry) => entry.provider === "web");
        strictEqual(web.length, WEB_MODEL_CONTRACTS.length);
        deepStrictEqual(web.map((entry) => entry.upstreamModel), WEB_MODEL_CONTRACTS.map((entry) => entry.upstreamModel));
        strictEqual(web.find((entry) => entry.id === "anthropic-web-chatgpt-pro")?.displayName, "ChatGPT Web Pro");
        ok(web.every((entry) => entry.contextWindow !== undefined && entry.contextWindow < 200_000), "window must be the measured ChatGPT limit, not Claude Code's 200k default");
        ok(snapshot.models.some((entry) => entry.id === "claude-opus-5"));
    });

    it("drops every web row when the lane is down", () => {
        const snapshot = withVerifiedWebModels(baseline, false);
        strictEqual(snapshot.models.some((entry) => entry.provider === "web"), false);
        ok(snapshot.models.some((entry) => entry.id === "claude-opus-5"));
    });

    it("produces rows the snapshot validator accepts", () => {
        const snapshot = withVerifiedWebModels(baseline, true);
        const parsed = parseModelSnapshot(JSON.parse(JSON.stringify(snapshot)));
        strictEqual(parsed.models.filter((entry) => entry.provider === "web").length, WEB_MODEL_CONTRACTS.length);
    });

    it("gives each web id the contract's auto-compact window", () => {
        for (const contract of WEB_MODEL_CONTRACTS) {
            strictEqual(autoCompactWindowForModel(contract.id), contract.autoCompactWindow);
            strictEqual(autoCompactWindowForModel(contract.alias), contract.autoCompactWindow);
        }
    });
});
