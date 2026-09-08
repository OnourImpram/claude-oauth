import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
    MCP_PROTOCOL_VERSION,
    McpToolBridge,
    deriveMcpTools,
    type ParkedToolCall,
} from "../src/mcp/tool-bridge.js";
import { RouterError } from "../src/domain/errors.js";

// Faz 9 / Yol 4. The gate that matters is spec §7.3: the number of tool_result
// blocks that arrive with nothing waiting for them must be ZERO. Everything
// below exists to make that number honest -- a bridge that silently swallowed a
// mismatch would report zero while losing work.

const kopru = (onToolCall: (call: ParkedToolCall) => void = () => {}): McpToolBridge =>
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
        let atildi = false;
        try {
            deriveMcpTools([{ name: "Read" }, { name: "Read" }]);
        } catch (error) {
            atildi = error instanceof RouterError;
        }
        strictEqual(atildi, true);
    });

    it("refuses an empty tool name", () => {
        let atildi = false;
        try {
            deriveMcpTools([{ name: "   " }]);
        } catch (error) {
            atildi = error instanceof RouterError;
        }
        strictEqual(atildi, true);
    });

    it("no tools is empty, not an error", () => {
        deepStrictEqual(deriveMcpTools(undefined), []);
    });
});

describe("McpToolBridge protocol", () => {
    it("initialize answers with the pinned protocol version", async () => {
        const bridge = kopru();
        const cevap = await bridge.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
        const result = cevap?.["result"] as Record<string, unknown>;
        strictEqual(result["protocolVersion"], MCP_PROTOCOL_VERSION);
        strictEqual(bridge.initialized, true);
    });

    it("tools/list returns exactly what was set", async () => {
        const bridge = kopru();
        bridge.setTools(deriveMcpTools([{ name: "Edit" }, { name: "Bash" }]));
        const cevap = await bridge.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        const result = cevap?.["result"] as { tools: { name: string }[] };
        deepStrictEqual(result.tools.map((t) => t.name), ["Edit", "Bash"]);
    });

    // A notification has no id and MUST NOT get a body; answering one desyncs
    // the JSON-RPC stream and the agent stops mid-loop.
    it("a notification gets no response", async () => {
        const bridge = kopru();
        strictEqual(await bridge.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
    });

    it("an unknown method is an error, not silence", async () => {
        const bridge = kopru();
        const cevap = await bridge.handle({ jsonrpc: "2.0", id: 3, method: "no/such" });
        strictEqual((cevap?.["error"] as { code: number }).code, -32601);
    });
});

describe("tool call parking -- the stateless/stateful join", () => {
    it("a call parks, surfaces to the caller, and resolves on its result", async () => {
        let gorulen: ParkedToolCall | undefined;
        const bridge = kopru((call) => {
            gorulen = call;
        });
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));

        const bekleyen = bridge.handle({
            jsonrpc: "2.0",
            id: 9,
            method: "tools/call",
            params: { name: "Read", arguments: { path: "a.txt" } },
        });

        strictEqual(bridge.pendingCount, 1);
        strictEqual(gorulen?.name, "Read");
        deepStrictEqual(gorulen?.input, { path: "a.txt" });

        strictEqual(bridge.deliverToolResult(gorulen.id, "file body", false), true);
        const cevap = await bekleyen;
        const result = cevap?.["result"] as { content: { text: string }[]; isError: boolean };
        strictEqual(result.content[0]?.text, "file body");
        strictEqual(result.isError, false);
        strictEqual(bridge.pendingCount, 0);
        strictEqual(bridge.unmatchedResultCount, 0);
    });

    // THE §7.3 GATE. An id nobody parked must be COUNTED, never ignored.
    it("an unmatched result is counted, not swallowed", () => {
        const bridge = kopru();
        strictEqual(bridge.deliverToolResult("mcp_yok", "x", false), false);
        strictEqual(bridge.unmatchedResultCount, 1);
    });

    it("an error result reaches the agent as isError", async () => {
        let id = "";
        const bridge = kopru((call) => {
            id = call.id;
        });
        bridge.setTools(deriveMcpTools([{ name: "Bash" }]));
        const bekleyen = bridge.handle({
            jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "Bash" },
        });
        bridge.deliverToolResult(id, "command failed", true);
        const result = (await bekleyen)?.["result"] as { isError: boolean };
        strictEqual(result.isError, true);
    });

    it("cancelAll releases every parked call and reports how many", async () => {
        const bridge = kopru();
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        const bekleyen = bridge.handle({
            jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "Read" },
        });
        strictEqual(bridge.cancelAll("session ended"), 1);
        const cevap = await bekleyen;
        strictEqual((cevap?.["error"] as { code: number }).code, -32001);
        strictEqual(bridge.pendingCount, 0);
    });

    it("a tool the agent invented is refused, not parked", async () => {
        const bridge = kopru();
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        const cevap = await bridge.handle({
            jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "Uydurma" },
        });
        strictEqual((cevap?.["error"] as { code: number }).code, -32001);
        strictEqual(bridge.pendingCount, 0);
    });

    it("ids are unique across calls, so results cannot cross", async () => {
        const idler: string[] = [];
        const bridge = kopru((call) => idler.push(call.id));
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        void bridge.handle({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "Read" } });
        void bridge.handle({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "Read" } });
        strictEqual(idler.length, 2);
        strictEqual(new Set(idler).size, 2);
        bridge.cancelAll("test teardown");
    });

    it("after teardown a new call is refused instead of hanging forever", async () => {
        const bridge = kopru();
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        bridge.cancelAll("closed");
        const cevap = await bridge.handle({
            jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "Read" },
        });
        strictEqual((cevap?.["error"] as { code: number }).code, -32001);
    });
});
