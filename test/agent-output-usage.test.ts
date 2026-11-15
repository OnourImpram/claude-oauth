import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentModelAdapter } from "../src/adapters/agent-model.js";
import type { AdapterRequest, ModelRecord } from "../src/domain/contracts.js";
import { AgentSessionRegistry } from "../src/mcp/session-registry.js";

// Audit D2-08: the agent lanes (Grok, Gemini) estimate usage locally. B08 bounded INPUT at
// ceil(bytes / 3) because Claude Code read bytes as tokens and compacted early; OUTPUT was still
// the raw UTF-8 byte count -- about 3-4 times the real token count, feeding the same context
// gauge. Output now carries the same bound, minimum 1.
const model: ModelRecord = {
    id: "hezarfen-xai-grok-4.6", provider: "xai", upstreamModel: "grok-4.6",
    displayName: "Grok", oauthType: "xai-cli", executionMode: "agent-readonly",
    discoverable: true, capabilities: ["messages"],
};
function request(stream: boolean): AdapterRequest {
    const envelope = { model: model.id, stream, messages: [{ role: "user", content: "answer at length" }] };
    return { requestId: "usage-test", path: "/v1/messages", query: "", model, envelope, body: Buffer.from(JSON.stringify(envelope)), headers: new Headers(), signal: AbortSignal.timeout(5_000) };
}
const readiness = async () => ({ provider: "xai" as const, status: "ready" as const, oauthReady: true, adapterReady: true, detailCode: "test" });

function textOnly(answer: string): AgentModelAdapter {
    return new AgentModelAdapter({ provider: "xai", readiness, run: async () => ({ text: answer }) });
}
function withSessions(answer: string): { adapter: AgentModelAdapter; sessions: AgentSessionRegistry } {
    const sessions = new AgentSessionRegistry({
        mcpBaseUrl: "http://127.0.0.1:65000",
        startAgent: () => ({ done: Promise.resolve(), text: () => answer, cancel: () => undefined }),
    });
    return { adapter: new AgentModelAdapter({ provider: "xai", sessions, readiness, run: async () => { throw new Error("unexpected text runner"); } }), sessions };
}
async function outputTokens(adapter: AgentModelAdapter, stream: boolean): Promise<number> {
    const response = await adapter.send(request(stream));
    const text = await new Response(response.body).text();
    if (!stream)
        return (JSON.parse(text) as { usage: { output_tokens: number } }).usage.output_tokens;
    const delta = /event: message_delta\ndata: (.*)\n/u.exec(text)?.[1];
    ok(delta !== undefined, "the stream carries a message_delta");
    return (JSON.parse(delta) as { usage: { output_tokens: number } }).usage.output_tokens;
}

describe("agent lanes: output_tokens uses the same ceil(bytes / 3) bound as input (audit D2-08)", () => {
    for (const stream of [false, true]) {
        it(`text-only path, ${stream ? "streaming" : "non-streaming"}: a 3,000-byte answer reports at most 1,000 output tokens`, async () => {
            strictEqual(await outputTokens(textOnly("a".repeat(3_000)), stream), 1_000);
        });
        it(`tool-loop path, ${stream ? "streaming" : "non-streaming"}: a 3,000-byte answer reports at most 1,000 output tokens`, async () => {
            const { adapter, sessions } = withSessions("a".repeat(3_000));
            try {
                strictEqual(await outputTokens(adapter, stream), 1_000);
            }
            finally {
                await sessions.closeAllAndWait("test cleanup");
            }
        });
    }
    it("the bound counts UTF-8 bytes, not characters: 3,000 two-byte characters are 6,000 bytes -> 2,000", async () => {
        strictEqual(await outputTokens(textOnly("ç".repeat(3_000)), false), 2_000);
    });
    it("rounds up, and the minimum stays 1", async () => {
        strictEqual(await outputTokens(textOnly("a".repeat(4)), false), 2);
        strictEqual(await outputTokens(textOnly("a"), false), 1);
    });
});
