import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ModelSnapshot } from "../src/domain/contracts.js";
import { ModelRegistry } from "../src/domain/registry.js";
import { ReceiptStore } from "../src/runtime/receipt-store.js";
import { startRouterServer, type RunningRouter } from "../src/router/server.js";
import { SESSION_HEADER } from "../src/security/nonce.js";
import { McpToolBridge, deriveMcpTools, type ParkedToolCall } from "../src/mcp/tool-bridge.js";

// Phase 9 / Path 4 -- the MCP endpoint served on the router's OWN loopback server.
//
// The whole security argument for this design is that the endpoint sits BEHIND the
// existing nonce gate: no new listener, no new port, no new credential class
// (spec §6). An argument is not a measurement, so the first test here is the one
// that would catch someone "fixing" the endpoint by exempting it from the gate.

const snapshot: ModelSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    source: "pinned-install-baseline",
    models: [
        {
            id: "claude-opus-5",
            provider: "anthropic",
            upstreamModel: "claude-opus-5",
            displayName: "Claude Opus 5",
            oauthType: "claude.ai",
            executionMode: "native-message-loop",
            discoverable: true,
            capabilities: ["messages"],
        },
    ],
};

const nonce = "m".repeat(43);
const LIVE_SESSION_KEY = "liveSession";
let directory = "";
let router: RunningRouter | undefined;
let bridge: McpToolBridge | undefined;
const parkedCalls: ParkedToolCall[] = [];

before(async () => {
    directory = await mkdtemp(join(tmpdir(), "router-mcp-"));
    bridge = new McpToolBridge({
        onToolCall: (call) => parkedCalls.push(call),
        callTimeoutMs: 0,
    });
    bridge.setTools(deriveMcpTools([{ name: "Read", description: "read a file" }]));
    router = await startRouterServer({
        nonce,
        registry: new ModelRegistry(snapshot, new Map()),
        receipts: new ReceiptStore(join(directory, "receipts.jsonl")),
        mcpBridge: (sessionKey) => (sessionKey === LIVE_SESSION_KEY ? bridge : undefined),
    });
});

after(async () => {
    bridge?.cancelAll("test teardown");
    await router?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function sendMcp(
    body: unknown,
    { sessionKey = LIVE_SESSION_KEY, authenticated = true }: { sessionKey?: string; authenticated?: boolean } = {},
): Promise<{ status: number; json: Record<string, unknown> | undefined; text: string }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authenticated) headers[SESSION_HEADER] = nonce;
    const response = await fetch(`${router?.baseUrl}/mcp/${sessionKey}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let json: Record<string, unknown> | undefined;
    try {
        json = text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>);
    } catch {
        json = undefined;
    }
    return { status: response.status, json, text };
}

describe("the MCP endpoint sits behind the existing gate", () => {
    // THE ARM THAT MATTERS. If someone exempts /mcp from the nonce check to make
    // a provider CLI work, this fails. Any local process could otherwise drive
    // Claude Code's tools.
    it("refuses a caller with no session nonce", async () => {
        const { status, json } = await sendMcp(
            { jsonrpc: "2.0", id: 1, method: "initialize" },
            { authenticated: false },
        );
        strictEqual(status, 401);
        strictEqual((json?.["error"] as { type: string }).type, "session_auth_required");
    });

    it("accepts the same nonce through the URL path door", async () => {
        const response = await fetch(`${router?.baseUrl}/_session/${nonce}/mcp/${LIVE_SESSION_KEY}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
        });
        strictEqual(response.status, 200);
    });

    it("a wrong nonce is refused like no nonce at all", async () => {
        const response = await fetch(`${router?.baseUrl}/mcp/${LIVE_SESSION_KEY}`, {
            method: "POST",
            headers: { "content-type": "application/json", [SESSION_HEADER]: "x".repeat(43) },
            body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
        });
        strictEqual(response.status, 401);
    });
});

describe("MCP protocol over HTTP", () => {
    it("initialize and tools/list answer through the route", async () => {
        const init = await sendMcp({ jsonrpc: "2.0", id: 10, method: "initialize" });
        strictEqual(init.status, 200);
        strictEqual((init.json?.["result"] as { protocolVersion: string }).protocolVersion, "2025-06-18");

        const list = await sendMcp({ jsonrpc: "2.0", id: 11, method: "tools/list" });
        const tools = (list.json?.["result"] as { tools: { name: string }[] }).tools;
        deepStrictEqual(tools.map((tool) => tool.name), ["Read"]);
    });

    // A notification MUST get no body. Answering one desyncs the JSON-RPC stream
    // and the agent stops mid-loop -- which reaches the operator as "the model is
    // selected but no answer comes back", the exact symptom Phase 9 exists to end.
    it("a notification gets 202 and an empty body", async () => {
        const { status, text } = await sendMcp({ jsonrpc: "2.0", method: "notifications/initialized" });
        strictEqual(status, 202);
        strictEqual(text, "");
    });

    it("malformed JSON is a JSON-RPC parse error, not a crash", async () => {
        const response = await fetch(`${router?.baseUrl}/mcp/${LIVE_SESSION_KEY}`, {
            method: "POST",
            headers: { "content-type": "application/json", [SESSION_HEADER]: nonce },
            body: "{ not json",
        });
        strictEqual(response.status, 400);
        const json = (await response.json()) as { error: { code: number } };
        strictEqual(json.error.code, -32700);
    });

    // Batching was removed in MCP 2025-06-18. Quietly taking the first element
    // would strand the rest, and a stranded call becomes an unmatched
    // tool_result -- the number spec §7.3 gates on.
    it("a batched request is refused rather than half-processed", async () => {
        const { status, json } = await sendMcp([{ jsonrpc: "2.0", id: 20, method: "ping" }]);
        strictEqual(status, 400);
        strictEqual((json?.["error"] as { code: number }).code, -32600);
    });

    it("GET is refused; this endpoint is POST only", async () => {
        const response = await fetch(`${router?.baseUrl}/mcp/${LIVE_SESSION_KEY}`, {
            headers: { [SESSION_HEADER]: nonce },
        });
        strictEqual(response.status, 405);
    });
});

describe("session addressing on the route", () => {
    it("an unknown session key gets a named error, not a bare 404", async () => {
        const { status, json } = await sendMcp(
            { jsonrpc: "2.0", id: 30, method: "ping" },
            { sessionKey: "unknownSession" },
        );
        strictEqual(status, 409);
        ok(String((json?.["error"] as { message: string }).message).includes("ONARIM:"));
    });

    it("a tool call arriving over HTTP parks instead of executing", async () => {
        parkedCalls.length = 0;
        const pending = sendMcp({
            jsonrpc: "2.0",
            id: 40,
            method: "tools/call",
            params: { name: "Read", arguments: { path: "a.txt" } },
        });
        // The call must NOT resolve on its own: the tool runs on the Claude Code
        // side. Proving that means answering it here, from the other end.
        await new Promise((resolve) => setTimeout(resolve, 30));
        strictEqual(parkedCalls.length, 1);
        const call = parkedCalls[0] as ParkedToolCall;
        deepStrictEqual(call.input, { path: "a.txt" });
        strictEqual(bridge?.deliverToolResult(call.id, "file body", false), true);
        const { status, json } = await pending;
        strictEqual(status, 200);
        const result = json?.["result"] as { content: { text: string }[]; isError: boolean };
        strictEqual(result.content[0]?.text, "file body");
        strictEqual(result.isError, false);
        strictEqual(bridge?.unmatchedResultCount, 0);
    });
});
