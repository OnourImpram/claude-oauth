import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentModelAdapter, type AgentModelRunRequest } from "../src/adapters/agent-model.js";
import type { AdapterRequest, MessageEnvelope, ModelRecord } from "../src/domain/contracts.js";

// B02, measured 2026-09-07 and the reason routed models could not see skills or the
// Agent tool. Claude Code delivers the skill catalogue, the agent catalogue, the MCP
// instructions and the output style in a role:"system" message placed AFTER the last
// user message when it does not recognise the model identity -- about 77,500
// characters in the measured session. The compiler had a branch for a system message
// BEFORE the request and a refusal for a developer message after it, and a system
// message after it matched neither: it was dropped in silence. No error, no warning,
// no detector, and the capability simply was not there.
//
// These arms are the detector that was missing. The first one fails the moment that
// content stops reaching the model again.

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

function request(envelope: MessageEnvelope): AdapterRequest {
    return {
        requestId: "test-request",
        path: "/v1/messages",
        query: "",
        model,
        envelope,
        body: new Uint8Array(),
        headers: new Headers(),
        signal: AbortSignal.timeout(5_000),
    };
}

async function compiledPromptFor(envelope: MessageEnvelope): Promise<string> {
    const sink: { prompt?: string } = {};
    const adapter = new AgentModelAdapter({
        provider: "google",
        readiness: async () => ({ provider: "google", oauthReady: true, adapterReady: true, status: "ready", detailCode: "test" }),
        run: async (runRequest: AgentModelRunRequest) => {
            sink.prompt = runRequest.prompt;
            return { text: "ANSWER" };
        },
    });
    await adapter.send(request(envelope));
    return sink.prompt ?? "";
}

const CATALOGUE = "Available skills: pdf-forms, web-design-craft. Available agents: reviewer, planner.";

describe("a system message after the current request is carried, not dropped", () => {
    it("the catalogue reaches the compiled prompt", async () => {
        const prompt = await compiledPromptFor({
            model: model.id,
            messages: [
                { role: "user", content: "review this file" },
                { role: "system", content: CATALOGUE },
            ],
        });
        ok(prompt.includes(CATALOGUE), "the trailing system message was dropped again");
        ok(prompt.includes("SESSION CAPABILITY CONTEXT"), "the section that carries it is missing");
    });

    it("the operator's request still comes last", async () => {
        // Wire order put the catalogue last; meaning puts it with the system context.
        // If it ended up after CURRENT USER REQUEST the model would answer the
        // catalogue instead of the operator.
        const prompt = await compiledPromptFor({
            model: model.id,
            messages: [
                { role: "user", content: "review this file" },
                { role: "system", content: CATALOGUE },
            ],
        });
        ok(prompt.indexOf(CATALOGUE) < prompt.indexOf("CURRENT USER REQUEST:"),
            "the capability context landed after the operator's request");
        ok(prompt.trimEnd().endsWith("review this file"), "the prompt does not end with the operator's request");
    });

    it("a system message BEFORE the request still lands in the binding block", async () => {
        // The pre-existing path must not regress: this arm is what tells the two
        // sections apart rather than assuming one covers the other.
        const prompt = await compiledPromptFor({
            model: model.id,
            messages: [
                { role: "system", content: "operator rule: answer in Turkish" },
                { role: "user", content: "review this file" },
            ],
        });
        ok(prompt.includes("BINDING SYSTEM AND PROJECT CONTEXT:"), "the binding block is gone");
        ok(prompt.indexOf("operator rule") < prompt.indexOf("CURRENT USER REQUEST:"), "the binding rule moved");
        ok(!prompt.includes("SESSION CAPABILITY CONTEXT"), "an empty capability section was emitted");
    });

    it("an empty trailing system message adds no empty section", async () => {
        const prompt = await compiledPromptFor({
            model: model.id,
            messages: [
                { role: "user", content: "review this file" },
                { role: "system", content: "   " },
            ],
        });
        ok(!prompt.includes("SESSION CAPABILITY CONTEXT"), "a blank message produced a section header");
    });

    it("several trailing system messages are all carried", async () => {
        const second = "MCP servers: playwright, filesystem.";
        const prompt = await compiledPromptFor({
            model: model.id,
            messages: [
                { role: "user", content: "review this file" },
                { role: "system", content: CATALOGUE },
                { role: "system", content: second },
            ],
        });
        ok(prompt.includes(CATALOGUE), "the first trailing message was dropped");
        ok(prompt.includes(second), "the second trailing message was dropped");
    });

    it("negative control: a trailing developer message is still refused, not silently carried", async () => {
        // The refusal is deliberate: a developer message after the request cannot be
        // mapped onto this route safely. Carrying system context must not turn that
        // explicit refusal into a silent acceptance.
        const sink: { prompt?: string } = {};
        const adapter = new AgentModelAdapter({
            provider: "google",
            readiness: async () => ({ provider: "google", oauthReady: true, adapterReady: true, status: "ready", detailCode: "test" }),
            run: async (runRequest: AgentModelRunRequest) => {
                sink.prompt = runRequest.prompt;
                return { text: "ANSWER" };
            },
        });
        let code = "";
        try {
            await adapter.send(request({
                model: model.id,
                messages: [
                    { role: "user", content: "review this file" },
                    { role: "developer", content: "do something else" },
                ],
            }));
        }
        catch (error) {
            code = (error as { code?: string }).code ?? "";
        }
        strictEqual(code, "unsupported_feature");
        strictEqual(sink.prompt, undefined);
    });
});
