import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { passthroughEnvelope } from "../src/adapters/anthropic-api-key.js";
import { anthropicToOpenAi } from "../src/adapters/openai-message-map.js";
import type { AdapterRequest, MessageEnvelope } from "../src/domain/contracts.js";
import { MARKER_INPUT, MARKER_RESULT, MCP_TOOL, PLAIN_RESULT, UNIDENTIFIED, callPlaceholder, mcpHistory, resultPlaceholder } from "./mcp-history-fixture.js";

// Edge shapes of the MCP-history data rule (audit D2-01), asserted on BOTH wire translations
// with the same inputs: the Anthropic passthrough (Alibaba, Z.AI) and the chat-completions
// translation (OpenAI API). The per-lane arms with the full adapter live in
// alibaba-zai / openaiapi tests; here the shapes that need no adapter.
type Block = Record<string, unknown>;
type Message = { role: string; content: unknown };

function viaPassthrough(messages: unknown[]): Message[] {
    return passthroughEnvelope({ model: "anthropic-test", messages } as MessageEnvelope, "upstream")["messages"] as Message[];
}
function viaChat(messages: unknown[]): Record<string, unknown>[] {
    const request = {
        requestId: "req-1",
        path: "/v1/messages",
        query: "",
        model: { upstreamModel: "upstream" },
        envelope: { model: "anthropic-test", stream: true, messages },
        body: new Uint8Array(),
        headers: new Headers(),
        signal: AbortSignal.timeout(5_000),
    } as unknown as AdapterRequest;
    const body = anthropicToOpenAi(request, { label: "Test lane", stream: true, thinkingReplay: "drop", clientToolsOnly: true, withheldToolPrefixes: ["mcp__"] });
    return body["messages"] as Record<string, unknown>[];
}

describe("MCP-history data rule: edge shapes (passthrough and chat translation)", () => {
    it("a tool_result whose tool_use_id matches no tool_use anywhere is withheld as 'an unidentified tool' (both translations)", () => {
        const messages = [
            { role: "user", content: "go" },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_nowhere", content: [{ type: "text", text: MARKER_RESULT }] }] },
        ];
        const passthrough = viaPassthrough(messages);
        strictEqual(JSON.stringify(passthrough).includes(MARKER_RESULT), false);
        deepStrictEqual(passthrough[1]?.content, [{ type: "text", text: resultPlaceholder(UNIDENTIFIED) }]);
        const chat = viaChat(messages);
        strictEqual(JSON.stringify(chat).includes(MARKER_RESULT), false);
        deepStrictEqual(chat.map((message) => message["role"]), ["user", "user"], "no role:tool message without a tool_call to answer");
        strictEqual(chat[1]?.["content"], resultPlaceholder(UNIDENTIFIED));
    });
    it("a tool_result with no usable tool_use_id is withheld the same way (it cannot be proven not to be MCP data)", () => {
        const messages = [{ role: "user", content: [{ type: "tool_result", content: MARKER_RESULT }] }];
        strictEqual(JSON.stringify(viaPassthrough(messages)).includes(MARKER_RESULT), false);
        strictEqual(JSON.stringify(viaChat(messages)).includes(MARKER_RESULT), false);
    });
    it("server-side MCP connector blocks (mcp_tool_use / mcp_tool_result) are replaced the same way", () => {
        const messages = [
            { role: "user", content: "go" },
            { role: "assistant", content: [{ type: "mcp_tool_use", id: "mcptoolu_1", name: "search_threads", server_name: "gmail", input: { query: MARKER_INPUT } }] },
            { role: "user", content: [{ type: "mcp_tool_result", tool_use_id: "mcptoolu_1", is_error: false, content: [{ type: "text", text: MARKER_RESULT }] }] },
        ];
        const passthrough = viaPassthrough(messages);
        const wire = JSON.stringify(passthrough);
        strictEqual(wire.includes(MARKER_INPUT) || wire.includes(MARKER_RESULT), false);
        deepStrictEqual(passthrough[1]?.content, [{ type: "text", text: callPlaceholder("search_threads") }]);
        deepStrictEqual(passthrough[2]?.content, [{ type: "text", text: resultPlaceholder("search_threads") }]);
        const chat = viaChat(messages);
        const chatWire = JSON.stringify(chat);
        strictEqual(chatWire.includes(MARKER_INPUT) || chatWire.includes(MARKER_RESULT), false);
        deepStrictEqual(chat.map((message) => message["role"]), ["user", "assistant", "user"]);
        strictEqual(chat[1]?.["content"], callPlaceholder("search_threads"));
        strictEqual(chat[1]?.["tool_calls"], undefined, "no tool_calls entry for a withheld call");
    });
    it("a history with no MCP data crosses untouched: same messages array, ordinary pair intact (passthrough) and a normal tool message (chat)", () => {
        const messages = mcpHistory().map((message) => JSON.parse(JSON.stringify(message).replaceAll(MCP_TOOL, "Grep").replaceAll("toolu_mcp_1", "toolu_grep_1")) as Record<string, unknown>);
        const envelope = { model: "anthropic-test", messages } as MessageEnvelope;
        strictEqual(passthroughEnvelope(envelope, "upstream")["messages"], messages, "nothing withheld, nothing rewritten, not even copied");
        const chat = viaChat(messages);
        deepStrictEqual(chat.map((message) => message["role"]), ["user", "assistant", "tool", "tool", "user"]);
        strictEqual(chat[2]?.["tool_call_id"], "toolu_grep_1");
    });
    it("the caller's envelope is never mutated", () => {
        const messages = mcpHistory();
        const snapshot = JSON.stringify(messages);
        viaPassthrough(messages);
        viaChat(messages);
        strictEqual(JSON.stringify(messages), snapshot);
    });
    it("only withheld results in a user turn: the turn stays a valid user turn of text blocks, in place", () => {
        const messages = [
            { role: "user", content: "go" },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: MCP_TOOL, input: {} }, { type: "tool_use", id: "toolu_b", name: "mcp__claude_ai_Google_Drive__search_files", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "A" }, { type: "tool_result", tool_use_id: "toolu_b", content: "B" }] },
        ];
        const passthrough = viaPassthrough(messages);
        deepStrictEqual(passthrough[1]?.content, [
            { type: "text", text: callPlaceholder(MCP_TOOL) },
            { type: "text", text: callPlaceholder("mcp__claude_ai_Google_Drive__search_files") },
        ]);
        deepStrictEqual(passthrough[2]?.content, [
            { type: "text", text: resultPlaceholder(MCP_TOOL) },
            { type: "text", text: resultPlaceholder("mcp__claude_ai_Google_Drive__search_files") },
        ]);
        const chat = viaChat(messages);
        deepStrictEqual(chat.map((message) => message["role"]), ["user", "assistant", "user"]);
        ok(!JSON.stringify(chat).includes("tool_call"));
    });
    it("a surviving tool_result stays first in its user turn even when a withheld one preceded it (Messages order, and tool messages follow their assistant turn)", () => {
        const blocks = (viaPassthrough(mcpHistory())[2]?.content ?? []) as Block[];
        deepStrictEqual(blocks.map((block) => block["type"]), ["tool_result", "text", "text"]);
        strictEqual(blocks[0]?.["content"], PLAIN_RESULT);
    });
});
