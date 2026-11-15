import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentModelAdapter } from "../src/adapters/agent-model.js";
import type { AdapterRequest, ModelRecord } from "../src/domain/contracts.js";
import { AgentSessionRegistry, type AgentRunHandle } from "../src/mcp/session-registry.js";
import type { McpToolBridge } from "../src/mcp/tool-bridge.js";

// CASE RECORD (measured 2026-11-15, Claude Code 2.1.325). `claude-oauth --model grok -p "..."`
// answered HTTP 422 "contains an unsupported tool_addition block". With the
// mid-conversation-tool-changes / inline-tools betas Claude Code puts a `role: "system"`
// message inside `messages` whose content mixes text with `tool_addition` blocks. The API-key
// lanes fold those blocks (audit D2-03); the agent lanes (Google, xAI) still refused the whole
// request, so every -p call and every session that loaded a deferred tool failed there. The
// operator's own receipts carry the trace: two xAI requests, both `unsupported_feature`.

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
    prompt = "";

    constructor() {
        this.done = new Promise<void>((resolve) => {
            this.#resolveDone = resolve;
        });
    }

    handle(): AgentRunHandle {
        return { done: this.done, text: () => this.#chunks.join(""), cancel: () => this.#resolveDone() };
    }

    say(text: string): void {
        this.#chunks.push(text);
    }

    finish(): void {
        this.#resolveDone();
    }
}

function adapterFor(agent: FakeAgent): AgentModelAdapter {
    return new AgentModelAdapter({
        provider: "xai",
        readiness: async () => ({ provider: "xai" as const, oauthReady: true, adapterReady: true, status: "ready" as const, detailCode: "test" }),
        run: async () => {
            throw new Error("the text-only runner must not be reached on the tool path");
        },
        sessions: new AgentSessionRegistry({
            mcpBaseUrl: "http://127.0.0.1:65000",
            startAgent: (options) => {
                agent.bridge = options.bridge;
                agent.say("pong");
                agent.finish();
                return agent.handle();
            },
        }),
    });
}

function request(envelope: Record<string, unknown>, path: AdapterRequest["path"] = "/v1/messages"): AdapterRequest {
    return {
        requestId: "test",
        path,
        query: "",
        model,
        envelope: envelope as AdapterRequest["envelope"],
        body: Buffer.from(JSON.stringify(envelope), "utf8"),
        headers: new Headers(),
        signal: new AbortController().signal,
    };
}

async function bodyText(response: { body: ReadableStream<Uint8Array> | null }): Promise<string> {
    return response.body === null ? "" : await new Response(response.body).text();
}

const addition = (name: string): Record<string, unknown> => ({
    type: "tool_addition",
    tool: { definition: { name, description: `${name} tool`, input_schema: { type: "object", properties: {} } } },
    cache_control: { type: "ephemeral" },
});

const withAdditions = {
    model: model.id,
    stream: false,
    tools: [{ name: "Edit", description: "edit a file", input_schema: { type: "object" } }],
    messages: [
        { role: "system", content: [{ type: "text", text: "Tools changed." }, addition("Lookup"), addition("mcp__drive__read")] },
        { role: "user", content: "Reply with the single word: pong" },
    ],
};

async function offeredToolNames(agent: FakeAgent): Promise<string[]> {
    const listed = await agent.bridge?.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) as { result?: { tools?: { name: string }[] } } | undefined;
    return (listed?.result?.tools ?? []).map((tool) => tool.name);
}

describe("tool_addition on the agent lanes", () => {
    it("a request carrying tool_addition blocks runs the turn instead of answering 422", async () => {
        const agent = new FakeAgent();
        const response = await adapterFor(agent).send(request(withAdditions));
        strictEqual(response.status, 200);
        ok((await bodyText(response)).includes("pong"));
    });

    it("the folded definitions are offered to the agent, mcp__ ones included (the operator's own OAuth lane)", async () => {
        const agent = new FakeAgent();
        await bodyText(await adapterFor(agent).send(request(withAdditions)));
        const names = await offeredToolNames(agent);
        deepStrictEqual(names, ["Edit", "Lookup", "mcp__drive__read"]);
    });

    it("a definition the envelope already offers is not offered twice (the bridge refuses a duplicate with 400)", async () => {
        const agent = new FakeAgent();
        const repeated = { ...withAdditions, messages: [{ role: "system", content: [addition("Edit"), addition("Lookup"), addition(" Lookup ")] }, withAdditions.messages[1]] };
        const response = await adapterFor(agent).send(request(repeated));
        strictEqual(response.status, 200);
        await bodyText(response);
        deepStrictEqual(await offeredToolNames(agent), ["Edit", "Lookup"]);
    });

    it("the text-only path (no session registry) accepts the same conversation and names the folded tool", async () => {
        let prompt = "";
        const adapter = new AgentModelAdapter({
            provider: "xai",
            readiness: async () => ({ provider: "xai" as const, oauthReady: true, adapterReady: true, status: "ready" as const, detailCode: "test" }),
            run: async (run) => {
                prompt = run.prompt;
                return { text: "pong" };
            },
        });
        const response = await adapter.send(request(withAdditions));
        strictEqual(response.status, 200);
        ok((await bodyText(response)).includes("pong"));
        ok(prompt.includes("Parent tool names, informational only: Edit, Lookup, mcp__drive__read"), "the folded names join the informational list");
        ok(!prompt.includes("tool_addition"), "no trace of the block type reaches the agent");
    });

    it("count_tokens accepts the same conversation (the two gates must agree)", async () => {
        const agent = new FakeAgent();
        const response = await adapterFor(agent).send(request(withAdditions, "/v1/messages/count_tokens"));
        strictEqual(response.status, 200);
        ok(JSON.parse(await bodyText(response)).input_tokens > 0);
    });

    it("NEGATIVE: a block type nobody has measured is still refused, not guessed at", async () => {
        const agent = new FakeAgent();
        const unknown = { ...withAdditions, messages: [{ role: "user", content: [{ type: "some_future_block", data: 1 }] }] };
        let status = 0;
        try {
            await adapterFor(agent).send(request(unknown));
        }
        catch (error) {
            status = (error as { status?: number }).status ?? -1;
        }
        strictEqual(status, 422);
    });
});
