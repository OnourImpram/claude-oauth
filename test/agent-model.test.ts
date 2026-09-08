import { rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentModelAdapter, type AgentModelRunRequest } from "../src/adapters/agent-model.js";
import type { AdapterRequest, MessageEnvelope, ModelRecord } from "../src/domain/contracts.js";

// Gemini and Grok run in "agent-readonly" mode: the conversation is COMPILED into a
// single text prompt. If that compilation lets past turns and the CURRENT request blur
// into each other, the model answers the previous turn again or restarts the
// conversation from scratch -- this is the class the user sees as "the model is not
// listening to me". That is why the boundary is tested.

const model: ModelRecord = {
    id: "anthropic-google-gemini-3.8-flash-high",
    provider: "google",
    upstreamModel: "gemini-3.8-flash-high",
    displayName: "Gemini 3.8 Flash High",
    oauthType: "google-cli",
    executionMode: "agent-readonly",
    discoverable: true,
    capabilities: ["messages"],
};

function request(envelope: MessageEnvelope, path: AdapterRequest["path"] = "/v1/messages"): AdapterRequest {
    return {
        requestId: "test-request",
        path,
        query: "",
        model,
        envelope,
        body: new Uint8Array(),
        headers: new Headers(),
        signal: AbortSignal.timeout(5_000),
    };
}

function adapterCapturing(sink: { prompt?: string }): AgentModelAdapter {
    return new AgentModelAdapter({
        provider: "google",
        readiness: async () => ({ provider: "google", oauthReady: true, adapterReady: true, status: "ready", detailCode: "test" }),
        run: async (runRequest: AgentModelRunRequest) => {
            sink.prompt = runRequest.prompt;
            return { text: "ANSWER" };
        },
    });
}

async function compiledPromptFor(envelope: MessageEnvelope): Promise<string> {
    const sink: { prompt?: string } = {};
    await adapterCapturing(sink).send(request(envelope));
    return sink.prompt ?? "";
}

describe("compiled agent prompt", () => {
    it("starts with the contract header", async () => {
        const prompt = await compiledPromptFor({ model: model.id, messages: [{ role: "user", content: "hello" }] });
        strictEqual(prompt.startsWith("HEZARFEN_AGENT_READONLY_V1"), true);
    });

    it("places the CURRENT request in the final section", async () => {
        const prompt = await compiledPromptFor({ model: model.id, messages: [{ role: "user", content: "latest request" }] });
        strictEqual(prompt.trimEnd().endsWith("latest request"), true);
    });

    // The boundary itself: history is "context", the last message is the "request". The two
    // must sit under separate headings.
    it("marks earlier turns as CONTEXT, not as the REQUEST", async () => {
        const prompt = await compiledPromptFor({
            model: model.id,
            messages: [
                { role: "user", content: "earlier question" },
                { role: "assistant", content: "earlier answer" },
                { role: "user", content: "new question" },
            ],
        });
        const historyIndex = prompt.indexOf("CONVERSATION HISTORY");
        const currentIndex = prompt.indexOf("CURRENT USER REQUEST:");
        strictEqual(historyIndex >= 0, true);
        strictEqual(currentIndex > historyIndex, true);
        strictEqual(prompt.slice(historyIndex, currentIndex).includes("earlier question"), true);
        strictEqual(prompt.slice(currentIndex).includes("new question"), true);
        strictEqual(prompt.slice(currentIndex).includes("earlier question"), false);
    });

    it("explicitly tells the model not to answer an earlier turn again", async () => {
        const prompt = await compiledPromptFor({ model: model.id, messages: [{ role: "user", content: "x" }] });
        strictEqual(prompt.includes("Do not answer an earlier turn again"), true);
    });

    it("marks parent tool schemas as INFORMATIONAL, not callable", async () => {
        const prompt = await compiledPromptFor({
            model: model.id,
            messages: [{ role: "user", content: "x" }],
            tools: [{ name: "Read" }, { name: "Write" }],
        });
        strictEqual(prompt.includes("informational only"), true);
        strictEqual(prompt.includes("Read"), true);
    });

    it("omits the tool section entirely when there are no tools", async () => {
        const prompt = await compiledPromptFor({ model: model.id, messages: [{ role: "user", content: "x" }] });
        strictEqual(prompt.includes("Parent tool names"), false);
    });

    it("REJECTS an empty request (does not silently send an empty prompt)", async () => {
        await rejects(
            async () => { await compiledPromptFor({ model: model.id, messages: [{ role: "user", content: "   " }] }); },
            /non-empty current user request/u,
        );
    });
});

describe("count_tokens path", () => {
    it("returns a local upper bound without calling the provider", async () => {
        const sink: { prompt?: string } = {};
        const response = await adapterCapturing(sink).send(request({ model: model.id, messages: [{ role: "user", content: "hello" }] }, "/v1/messages/count_tokens"));
        strictEqual(response.status, 200);
        strictEqual(sink.prompt, undefined);
    });
});

describe("provider/model matching", () => {
    it("rejects when the adapter's provider does not match the model's provider", async () => {
        const adapter = new AgentModelAdapter({
            provider: "xai",
            readiness: async () => ({ provider: "xai", oauthReady: true, adapterReady: true, status: "ready", detailCode: "test" }),
            run: async () => ({ text: "x" }),
        });
        await rejects(
            async () => { await adapter.send(request({ model: model.id, messages: [{ role: "user", content: "x" }] })); },
            /Provider adapter and model do not match/u,
        );
    });

    it("rejects initialization when pingIntervalMs is not a positive integer", () => {
        for (const bad of [0, -1, 1.5, Number.NaN]) {
            let threw = false;
            try {
                void new AgentModelAdapter({
                    provider: "google",
                    readiness: async () => ({ provider: "google", oauthReady: true, adapterReady: true, status: "ready", detailCode: "t" }),
                    run: async () => ({ text: "x" }),
                    pingIntervalMs: bad,
                });
            }
            catch { threw = true; }
            strictEqual(threw, true, String(bad));
        }
    });
});
