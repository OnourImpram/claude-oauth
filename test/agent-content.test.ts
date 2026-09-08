import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
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

for (const trailingSystem of [false, true]) {
    it(`B03: continuation preserves session and all user instructions, trailing system=${trailingSystem}`, async () => {
        let continued = false;
        const h = harness(async (_options, result) => {
            const content = (result as { result: { content: { text?: string }[] } }).result.content;
            const text = content.map((block) => block.text ?? "").join("\n");
            ok(text.includes("Stop; do not modify any files."));
            ok(text.includes("Explain the result in Turkish."));
            ok(text.indexOf("CURRENT USER INSTRUCTION") > text.indexOf("tool finished"));
            if (trailingSystem) ok(text.includes("New session capability rule"));
            continued = true;
        });
        try {
            const id = await openCall(h.adapter);
            const continuation = request([
                { role: "user", content: [
                    { type: "text", text: "Stop; do not modify any files." },
                    { type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "tool finished" }, imageBlock] },
                    { type: "text", text: "Explain the result in Turkish." },
                ] },
                ...(trailingSystem ? [{ role: "system", content: "New session capability rule" }] : []),
            ]);
            const response = await h.adapter.send(continuation);
            strictEqual(response.status, 200);
            strictEqual(h.starts(), 1, "system records must not start a new agent");
            strictEqual(continued, true, "the parked MCP call must receive the new instruction");
            strictEqual(h.sessions.unmatchedResultCount, 0);
        } finally { await h.sessions.closeAllAndWait("test cleanup"); }
    });
}

it("B03: continuation validates incompatible controls before releasing a parked call", async () => {
    const h = harness();
    try {
        const id = await openCall(h.adapter);
        const next = request([{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "done" }] }]);
        await rejects(h.adapter.send({ ...next, envelope: { ...next.envelope, thinking: { type: "enabled", budget_tokens: 1000 } } }),
            /Explicit Anthropic thinking budgets/u);
        strictEqual(h.started()?.bridge.pendingCount, 1);
        strictEqual(h.received(), undefined);
    } finally { await h.sessions.closeAllAndWait("test cleanup"); }
});

it("B03: old results are not resumed after a newer logical user turn", () => {
    deepStrictEqual(extractToolResults([
        { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: "done" }] },
        { role: "user", content: "new instruction" },
        { role: "system", content: "catalogue" },
    ]), []);
});

for (const tools of [
    [{ name: "ToolSearch" }, { name: "mcp__playwright__browser_snapshot", description: "snapshot", input_schema: { type: "object" } }],
    [{ name: "ToolSearch", description: "updated search", input_schema: { type: "object", properties: { query: { type: "string" } } } }],
    [],
]) {
    it(`N04: resumed agent lists the current catalogue before continuing: ${JSON.stringify(tools)}`, async () => {
        const h = harness(async (options) => {
            const listing = await options.bridge.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
            deepStrictEqual((listing?.["result"] as { tools: unknown[] }).tools, tools.map((tool) => ({
                name: tool.name, description: tool.description ?? "",
                inputSchema: tool.input_schema ?? { type: "object", properties: {} },
            })));
            if (tools.length === 0) {
                const rejected = await options.bridge.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ToolSearch" } });
                ok(rejected?.["error"], "removed tools cannot be called after the parked result completes");
            }
        });
        try {
            const id = await openCall(h.adapter);
            await h.adapter.send(request([{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "found tools" }] }], tools));
            strictEqual(h.starts(), 1);
        } finally { await h.sessions.closeAllAndWait("test cleanup"); }
    });
}

it("N04: unchanged catalogue keeps the same advertised descriptors", async () => {
    const h = harness();
    try {
        const id = await openCall(h.adapter);
        const bridge = h.started()?.bridge;
        const initial = bridge?.tools;
        await h.adapter.send(request([{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "same tools" }] }]));
        strictEqual(bridge?.tools, initial);
    } finally { await h.sessions.closeAllAndWait("test cleanup"); }
});

it("G04: the session lane and token counter accept mixed legacy history", async () => {
    const h = harness();
    try {
        const next = request([
            { role: "assistant", content: [
                { type: "thinking", thinking: "private thought" },
                { type: "redacted_thinking", data: "private signature" },
                imageBlock,
                { type: "document", source: { type: "text", media_type: "text/plain", data: "hello" } },
                { type: "server_tool_use", name: "web_search" },
                { type: "mcp_tool_use", name: "browser_snapshot" },
            ] },
            { role: "user", content: "Continue." },
        ]);
        strictEqual((await h.adapter.send(next)).status, 200);
        strictEqual((await h.adapter.send({ ...next, path: "/v1/messages/count_tokens" })).status, 200);
        const prompt = h.started()?.prompt ?? "";
        ok(prompt.includes("[document: media_type=text/plain, bytes=5]"));
        ok(prompt.includes("[image: media_type=image/png, bytes=3]"));
        ok(prompt.includes("[tool call: web_search]"));
        ok(prompt.includes("[tool call: browser_snapshot]"));
        strictEqual(prompt.includes("private thought"), false);
        strictEqual(prompt.includes("private signature"), false);
    } finally { await h.sessions.closeAllAndWait("test cleanup"); }
});

for (const mimeType of ["image/png", "IMAGE/PNG"]) {
    it(`N01: native MCP images retain their payload on the live bridge (${mimeType})`, async () => {
        const h = harness();
        try {
            const id = await openCall(h.adapter);
            await h.adapter.send(request([{ role: "user", content: [{ type: "tool_result", tool_use_id: id,
                content: [{ type: "image", mimeType, data: "AQID" }],
            }] }]));
            deepStrictEqual(h.received(), { jsonrpc: "2.0", id: 1, result: { isError: false, content: [
                { type: "text", text: `[image: media_type=${mimeType}, bytes=3]` },
                { type: "image", mimeType, data: "AQID" },
            ] } });
        } finally { await h.sessions.closeAllAndWait("test cleanup"); }
    });
}

it("N01: embedded resources report known MIME type and payload bytes", () => {
    for (const resource of [
        { mimeType: "text/plain", text: "üç" },
        { mimeType: "text/plain", blob: "AQIDBA==" },
    ]) {
        const result = extractToolResults([{ role: "user", content: [{ type: "tool_result", tool_use_id: "resource-call",
            content: [{ type: "resource", resource }],
        }] }]);
        strictEqual(result[0]?.content, "[resource: media_type=text/plain, bytes=4]");
    }
});

it("B03: continuation usage bounds the full delivered result, not its truncated history summary", async () => {
    const h = harness();
    try {
        const id = await openCall(h.adapter);
        const next = request([{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "result".repeat(10_000) }] }]);
        const response = await h.adapter.send(next);
        const body = await new Response(response.body).json() as { usage: { input_tokens: number } };
        strictEqual(response.headers.get("x-hezarfen-usage-source"), "local-upper-bound");
        ok(body.usage.input_tokens >= Math.ceil(next.body.length / 3), "a truncated summary cannot bound the untruncated MCP payload (B08: three bytes per token)");
    } finally { await h.sessions.closeAllAndWait("test cleanup"); }
});

it("B03: trailing blank text does not reject a valid parked result", async () => {
    for (const text of ["", " \n "]) {
        const h = harness();
        try {
            const id = await openCall(h.adapter);
            const response = await h.adapter.send(request([{ role: "user", content: [
                { type: "tool_result", tool_use_id: id, content: "done" }, { type: "text", text },
            ] }]));
            strictEqual(response.status, 200);
            strictEqual(h.starts(), 1);
            strictEqual(h.sessions.liveSessionCount, 0);
        } finally { await h.sessions.closeAllAndWait("test cleanup"); }
    }
});
