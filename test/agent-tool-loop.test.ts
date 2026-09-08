import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterRequest, ModelRecord } from "../src/domain/contracts.js";
import { AgentModelAdapter, extractToolResults } from "../src/adapters/agent-model.js";
import { AgentSessionRegistry, type AgentRunHandle } from "../src/mcp/session-registry.js";
import type { McpToolBridge } from "../src/mcp/tool-bridge.js";

// Phase 9 / Path 4 -- the loop, end to end through the adapter.
//
// The claim being tested is the one the operator reported broken: Grok and
// Gemini "look selected but nothing comes back". The cause was that this route
// answered 422 the moment a conversation contained a tool block, so a tool loop
// -- and therefore compaction, which resends the whole history -- could never
// run on those lanes. These arms hold the fixed shape.

const model: ModelRecord = {
    id: "hezarfen-xai-grok-4.6",
    provider: "xai",
    upstreamModel: "grok-4.6",
    displayName: "Grok 4.6",
    oauthType: "xai-cli",
    executionMode: "agent-readonly",
    discoverable: true,
    capabilities: ["messages"],
};

class FakeAgent {
    #chunks: string[] = [];
    #resolveDone: () => void = () => undefined;
    readonly done: Promise<void>;
    bridge: McpToolBridge | undefined;

    constructor() {
        this.done = new Promise<void>((resolve) => {
            this.#resolveDone = resolve;
        });
    }

    handle(): AgentRunHandle {
        return {
            done: this.done,
            text: () => this.#chunks.join(""),
            cancel: () => this.#resolveDone(),
        };
    }

    say(text: string): void {
        this.#chunks.push(text);
    }

    callTool(name: string, args: Record<string, unknown> = {}): void {
        void this.bridge?.handle({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
        });
    }

    finish(): void {
        this.#resolveDone();
    }
}

function createRequest(envelope: Record<string, unknown>): AdapterRequest {
    const body = Buffer.from(JSON.stringify(envelope), "utf8");
    return {
        requestId: "test",
        path: "/v1/messages",
        query: "",
        model,
        envelope: envelope as AdapterRequest["envelope"],
        body,
        headers: new Headers(),
        signal: new AbortController().signal,
    };
}

async function readBody(response: { body: ReadableStream<Uint8Array> | null }): Promise<string> {
    if (response.body === null) return "";
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    for (;;) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(result.value);
    }
    return Buffer.concat(chunks.map((p) => Buffer.from(p))).toString("utf8");
}

function createAdapter(agent: FakeAgent, setup: (a: FakeAgent) => void): AgentModelAdapter {
    const sessions = new AgentSessionRegistry({
        mcpBaseUrl: "http://127.0.0.1:65000",
        startAgent: (options) => {
            agent.bridge = options.bridge;
            setup(agent);
            return agent.handle();
        },
    });
    return new AgentModelAdapter({
        provider: "xai",
        readiness: async () => ({ provider: "xai" as const, oauthReady: true, adapterReady: true, status: "ready" as const, detailCode: "test" }),
        run: async () => {
            throw new Error("the text-only runner must not be reached on the tool path");
        },
        sessions,
    });
}

const TOOLS = [{ name: "Edit", description: "edit a file", input_schema: { type: "object" } }];

describe("extractToolResults -- the session identity", () => {
    it("reads tool_use_id, string content and the error flag", () => {
        const result = extractToolResults([
            { role: "assistant", content: [{ type: "text", text: "x" }] },
            {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "mcp_a", content: "ok" },
                    { type: "tool_result", tool_use_id: "mcp_b", content: "bad", is_error: true },
                ],
            },
        ]);
        deepStrictEqual(result.map((r) => [r.toolUseId, r.content, r.isError]), [
            ["mcp_a", "ok", false],
            ["mcp_b", "bad", true],
        ]);
    });

    it("reads block-array content, which is the shape Claude Code actually sends", () => {
        const result = extractToolResults([
            {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "mcp_a",
                        content: [{ type: "text", text: "line" }],
                    },
                ],
            },
        ]);
        strictEqual(result[0]?.content, "line");
    });

    // A plain turn is NOT an error state -- it means "open a new session".
    it("a plain text turn yields no results", () => {
        strictEqual(
            extractToolResults([{ role: "user", content: [{ type: "text", text: "hi" }] }]).length,
            0,
        );
    });
});

describe("the tool loop through the adapter", () => {
    it("a parked call becomes stop_reason tool_use with a tool_use block", async () => {
        const agent = new FakeAgent();
        const adapter = createAdapter(agent, (a) => {
            a.say("I will edit that file.");
            a.callTool("Edit", { path: "a.ts" });
        });
        const response = await adapter.send(
            createRequest({
                model: model.id,
                messages: [{ role: "user", content: [{ type: "text", text: "edit a.ts" }] }],
                tools: TOOLS,
            }),
        );
        const payload = JSON.parse(await readBody(response)) as {
            stop_reason: string;
            content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
        };
        strictEqual(payload.stop_reason, "tool_use");
        strictEqual(payload.content[0]?.type, "text");
        strictEqual(payload.content[0]?.text, "I will edit that file.");
        const call = payload.content[1];
        strictEqual(call?.type, "tool_use");
        strictEqual(call.name, "Edit");
        deepStrictEqual(call.input, { path: "a.ts" });
        ok(String(call.id).startsWith("mcp_"));
    });

    it("an empty preamble produces no empty text block", async () => {
        const agent = new FakeAgent();
        const adapter = createAdapter(agent, (a) => a.callTool("Edit"));
        const response = await adapter.send(
            createRequest({
                model: model.id,
                messages: [{ role: "user", content: "go" }],
                tools: TOOLS,
            }),
        );
        const payload = JSON.parse(await readBody(response)) as { content: { type: string }[] };
        deepStrictEqual(payload.content.map((b) => b.type), ["tool_use"]);
    });

    // THE ARM THE OPERATOR'S BUG REPORT MAPS TO. A conversation carrying tool
    // blocks used to be refused with 422 in 5-6 ms, before any network call.
    it("a turn carrying tool_result resumes the same session and finishes", async () => {
        const agent = new FakeAgent();
        const adapter = createAdapter(agent, (a) => a.callTool("Edit", { path: "a.ts" }));
        const first = await adapter.send(
            createRequest({
                model: model.id,
                messages: [{ role: "user", content: "edit a.ts" }],
                tools: TOOLS,
            }),
        );
        const opened = JSON.parse(await readBody(first)) as { content: { id?: string }[] };
        const callId = opened.content[0]?.id;
        ok(callId !== undefined);

        agent.say("Done, the file is edited.");
        agent.finish();
        const second = await adapter.send(
            createRequest({
                model: model.id,
                messages: [
                    { role: "user", content: "edit a.ts" },
                    { role: "assistant", content: [{ type: "tool_use", id: callId, name: "Edit", input: {} }] },
                    { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "written" }] },
                ],
                tools: TOOLS,
            }),
        );
        const payload = JSON.parse(await readBody(second)) as { stop_reason: string; content: { text: string }[] };
        strictEqual(payload.stop_reason, "end_turn");
        strictEqual(payload.content[0]?.text, "Done, the file is edited.");
    });

    it("streaming emits input_json_delta and closes on tool_use", async () => {
        const agent = new FakeAgent();
        const adapter = createAdapter(agent, (a) => a.callTool("Edit", { path: "b.ts" }));
        const response = await adapter.send(
            createRequest({
                model: model.id,
                stream: true,
                messages: [{ role: "user", content: "edit b.ts" }],
                tools: TOOLS,
            }),
        );
        const streamText = await readBody(response);
        ok(streamText.includes('"type":"tool_use"'));
        ok(streamText.includes("input_json_delta"));
        ok(streamText.includes('{\\"path\\":\\"b.ts\\"}') || streamText.includes('"partial_json":"{\\"path\\":\\"b.ts\\"}"'));
        ok(streamText.includes('"stop_reason":"tool_use"'));
        ok(streamText.trimEnd().endsWith('data: {"type":"message_stop"}'));
    });

    // Tool blocks left over from an earlier, retired session must not kill the
    // conversation: refusing them with 422 is what broke compaction on these
    // lanes, and dropping them silently would make the agent forget its work.
    it("stale tool blocks in history are carried as text, not refused", async () => {
        const agent = new FakeAgent();
        const adapter = createAdapter(agent, (a) => {
            a.say("continuing");
            a.finish();
        });
        const response = await adapter.send(
            createRequest({
                model: model.id,
                messages: [
                    { role: "user", content: "start" },
                    { role: "assistant", content: [{ type: "tool_use", id: "mcp_old", name: "Edit", input: {} }] },
                    { role: "user", content: [{ type: "tool_result", tool_use_id: "mcp_old", content: "old" }] },
                    { role: "user", content: "keep going" },
                ],
                tools: TOOLS,
            }),
        );
        const payload = JSON.parse(await readBody(response)) as { stop_reason: string };
        strictEqual(payload.stop_reason, "end_turn");
    });
});

describe("the text-only route is untouched without a registry", () => {
    // REGRESSION RECEIPT. Sol and Terra ride this same adapter class. If the new
    // capability leaked into the default, a tool block would stop being a 422 and
    // those lanes would silently change behaviour.
    it("a tool block is still 422 when no session registry is wired", async () => {
        const adapter = new AgentModelAdapter({
            provider: "xai",
            readiness: async () => ({ provider: "xai" as const, oauthReady: true, adapterReady: true, status: "ready" as const, detailCode: "test" }),
            run: async () => ({ text: "unused" }),
        });
        let status = 0;
        try {
            await adapter.send(
                createRequest({
                    model: model.id,
                    messages: [
                        { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "y" }] },
                    ],
                }),
            );
        } catch (error) {
            status = (error as { status: number }).status;
        }
        strictEqual(status, 422);
    });
});
