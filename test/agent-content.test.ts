import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { AgentModelAdapter, extractToolResults } from "../src/adapters/agent-model.js";
import type { AdapterRequest, ModelRecord } from "../src/domain/contracts.js";
import { AgentSessionRegistry, type StartAgentOptions } from "../src/mcp/session-registry.js";

const model: ModelRecord = {
    id: "hezarfen-xai-grok-4.6", provider: "xai", upstreamModel: "grok-4.6",
    displayName: "Grok", oauthType: "xai-cli", executionMode: "agent-readonly",
    discoverable: true, capabilities: ["messages"],
};
const imageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } };

function request(messages: unknown[], tools: unknown[] = [{ name: "ToolSearch" }]): AdapterRequest {
    const envelope = { model: model.id, messages, tools };
    return {
        requestId: "content-test", path: "/v1/messages", query: "", model, envelope,
        body: Buffer.from(JSON.stringify(envelope)), headers: new Headers(), signal: AbortSignal.timeout(5_000),
    };
}

function harness(afterResult: (options: StartAgentOptions, result: unknown) => Promise<void> = async () => undefined) {
    let starts = 0;
    let started: StartAgentOptions | undefined;
    let received: unknown;
    const sessions = new AgentSessionRegistry({
        mcpBaseUrl: "http://127.0.0.1:65000",
        startAgent: (options) => {
            starts += 1;
            started = options;
            const done = options.bridge.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ToolSearch" } })
                .then(async (result) => { received = result; await afterResult(options, result); });
            return { done, text: () => "finished", cancel: () => options.bridge.cancelAll("test cleanup") };
        },
    });
    const adapter = new AgentModelAdapter({
        provider: "xai", sessions,
        readiness: async () => ({ provider: "xai", status: "ready", oauthReady: true, adapterReady: true, detailCode: "test" }),
        run: async () => { throw new Error("unexpected text runner"); },
    });
    return { adapter, sessions, starts: () => starts, started: () => started, received: () => received };
}

async function openCall(adapter: AgentModelAdapter): Promise<string> {
    const response = await adapter.send(request([{ role: "user", content: "search tools" }]));
    const body = await new Response(response.body).json() as { content: { type: string; id?: string }[] };
    const id = body.content.find((block) => block.type === "tool_use")?.id;
    ok(id);
    return id;
}

it("N01: image-only and mixed results retain deterministic media summaries", () => {
    for (const content of [[imageBlock], [{ type: "text", text: "screenshot" }, imageBlock]]) {
        const result = extractToolResults([{ role: "user", content: [{ type: "tool_result", tool_use_id: "image-call", content }] }]);
        strictEqual(result[0]?.content, content.length === 1
            ? "[image: media_type=image/png, bytes=3]"
            : "screenshot\n\n[image: media_type=image/png, bytes=3]");
    }
});

it("N01: unsupported structured blocks retain their type without exposing payloads", () => {
    const result = extractToolResults([{ role: "user", content: [{
        type: "tool_result", tool_use_id: "structured-call",
        content: [{ type: "resource", resource: { text: "private payload" } }],
    }] }]);
    ok(result[0]?.content.startsWith("[resource:"));
    strictEqual(result[0]?.content.includes("private payload"), false);
});

it("N01: base64 screenshot crosses adapter, registry and MCP response with its error flag", async () => {
    const h = harness();
    try {
        const id = await openCall(h.adapter);
        await h.adapter.send(request([{ role: "user", content: [{
            type: "tool_result", tool_use_id: id, is_error: true,
            content: [{ type: "text", text: "partial screenshot" }, imageBlock],
        }] }]));
        deepStrictEqual(h.received(), { jsonrpc: "2.0", id: 1, result: {
            content: [
                { type: "text", text: "partial screenshot" },
                { type: "text", text: "[image: media_type=image/png, bytes=3]" },
                { type: "image", mimeType: "image/png", data: "AQID" },
            ], isError: true,
        } });
    } finally { await h.sessions.closeAllAndWait("test cleanup"); }
});
