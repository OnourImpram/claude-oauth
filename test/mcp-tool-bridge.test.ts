import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
    MCP_PROTOCOL_VERSION,
    McpToolBridge,
    deriveMcpTools,
    type ParkedToolCall,
} from "../src/mcp/tool-bridge.js";
import { RouterError } from "../src/domain/errors.js";

// Phase 9 / Path 4. The gate that matters is spec §7.3: the number of tool_result
// blocks that arrive with nothing waiting for them must be ZERO. Everything
// below exists to make that number honest -- a bridge that silently swallowed a
// mismatch would report zero while losing work.

const createBridge = (onToolCall: (call: ParkedToolCall) => void = () => {}): McpToolBridge =>
    new McpToolBridge({ onToolCall, callTimeoutMs: 0 });

describe("deriveMcpTools", () => {
    it("carries name, description and schema through", () => {
        const [tool] = deriveMcpTools([
            { name: "Read", description: "read a file", input_schema: { type: "object" } },
        ]);
        strictEqual(tool?.name, "Read");
        strictEqual(tool?.description, "read a file");
        deepStrictEqual(tool?.inputSchema, { type: "object" });
    });

    it("gives a schemaless tool an object schema instead of dropping it", () => {
        const [tool] = deriveMcpTools([{ name: "Bare" }]);
        deepStrictEqual(tool?.inputSchema, { type: "object", properties: {} });
    });

    // Ambiguity here means calling the WRONG tool, so it must be refused, not resolved.
    it("refuses duplicate tool names", () => {
        let threw = false;
        try {
            deriveMcpTools([{ name: "Read" }, { name: "Read" }]);
        } catch (error) {
            threw = error instanceof RouterError;
        }
        strictEqual(threw, true);
    });

    it("refuses an empty tool name", () => {
        let threw = false;
        try {
            deriveMcpTools([{ name: "   " }]);
        } catch (error) {
            threw = error instanceof RouterError;
        }
        strictEqual(threw, true);
    });

    it("no tools is empty, not an error", () => {
        deepStrictEqual(deriveMcpTools(undefined), []);
    });
});

describe("McpToolBridge protocol", () => {
    it("initialize answers with the pinned protocol version", async () => {
        const bridge = createBridge();
        const response = await bridge.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
        const result = response?.["result"] as Record<string, unknown>;
        strictEqual(result["protocolVersion"], MCP_PROTOCOL_VERSION);
        strictEqual(bridge.initialized, true);
    });

    it("tools/list returns exactly what was set", async () => {
        const bridge = createBridge();
        bridge.setTools(deriveMcpTools([{ name: "Edit" }, { name: "Bash" }]));
        const response = await bridge.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        const result = response?.["result"] as { tools: { name: string }[] };
        deepStrictEqual(result.tools.map((t) => t.name), ["Edit", "Bash"]);
    });

    // A notification has no id and MUST NOT get a body; answering one desyncs
    // the JSON-RPC stream and the agent stops mid-loop.
    it("a notification gets no response", async () => {
        const bridge = createBridge();
        strictEqual(await bridge.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
    });

    it("an unknown method is an error, not silence", async () => {
        const bridge = createBridge();
        const response = await bridge.handle({ jsonrpc: "2.0", id: 3, method: "no/such" });
        strictEqual((response?.["error"] as { code: number }).code, -32601);
    });
});

describe("tool call parking -- the stateless/stateful join", () => {
    it("a call parks, surfaces to the caller, and resolves on its result", async () => {
        let observedCall: ParkedToolCall | undefined;
        const bridge = createBridge((call) => {
            observedCall = call;
        });
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));

        const pending = bridge.handle({
            jsonrpc: "2.0",
            id: 9,
            method: "tools/call",
            params: { name: "Read", arguments: { path: "a.txt" } },
        });

        strictEqual(bridge.pendingCount, 1);
        strictEqual(observedCall?.name, "Read");
        deepStrictEqual(observedCall?.input, { path: "a.txt" });

        strictEqual(bridge.deliverToolResult(observedCall.id, "file body", false), true);
        const response = await pending;
        const result = response?.["result"] as { content: { text: string }[]; isError: boolean };
        strictEqual(result.content[0]?.text, "file body");
        strictEqual(result.isError, false);
        strictEqual(bridge.pendingCount, 0);
        strictEqual(bridge.unmatchedResultCount, 0);
    });

    // THE §7.3 GATE. An id nobody parked must be COUNTED, never ignored.
    it("an unmatched result is counted, not swallowed", () => {
        const bridge = createBridge();
        strictEqual(bridge.deliverToolResult("mcp_missing", "x", false), false);
        strictEqual(bridge.unmatchedResultCount, 1);
    });

    it("an error result reaches the agent as isError", async () => {
        let id = "";
        const bridge = createBridge((call) => {
            id = call.id;
        });
        bridge.setTools(deriveMcpTools([{ name: "Bash" }]));
        const pending = bridge.handle({
            jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "Bash" },
        });
        bridge.deliverToolResult(id, "command failed", true);
        const result = (await pending)?.["result"] as { isError: boolean };
        strictEqual(result.isError, true);
    });

    it("cancelAll releases every parked call and reports how many", async () => {
        const bridge = createBridge();
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        const pending = bridge.handle({
            jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "Read" },
        });
        strictEqual(bridge.cancelAll("session ended"), 1);
        const response = await pending;
        strictEqual((response?.["error"] as { code: number }).code, -32001);
        strictEqual(bridge.pendingCount, 0);
    });

    it("a tool the agent invented is refused, not parked", async () => {
        const bridge = createBridge();
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        const response = await bridge.handle({
            jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "Invented" },
        });
        strictEqual((response?.["error"] as { code: number }).code, -32001);
        strictEqual(bridge.pendingCount, 0);
    });

    it("ids are unique across calls, so results cannot cross", async () => {
        const ids: string[] = [];
        const bridge = createBridge((call) => ids.push(call.id));
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        void bridge.handle({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "Read" } });
        void bridge.handle({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "Read" } });
        strictEqual(ids.length, 2);
        strictEqual(new Set(ids).size, 2);
        bridge.cancelAll("test teardown");
    });

    it("after teardown a new call is refused instead of hanging forever", async () => {
        const bridge = createBridge();
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        bridge.cancelAll("closed");
        const response = await bridge.handle({
            jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "Read" },
        });
        strictEqual((response?.["error"] as { code: number }).code, -32001);
    });
});
