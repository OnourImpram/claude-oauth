import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { openAiCompletionToAnthropic, openAiSseToAnthropic } from "../src/adapters/openai-sse.js";

// Audit D2-06: finish_reason "content_filter" (the provider cut the answer) used to collapse to
// end_turn, so a filtered, partial answer looked like a finished turn. It is Anthropic's
// stop_reason "refusal" now, on the streaming and the non-streaming path alike; every other
// mapping is unchanged.
async function streamedStopReason(finishReason: string): Promise<string | undefined> {
    const events = [
        { id: "chatcmpl-f1", choices: [{ index: 0, delta: { role: "assistant", content: "partial answer" } }] },
        { id: "chatcmpl-f1", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
        "[DONE]",
    ];
    const text = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
    const out = await new Response(openAiSseToAnthropic(new Response(text).body as ReadableStream<Uint8Array>, "anthropic-test", { label: "Test lane" })).text();
    const delta = /event: message_delta\ndata: (.*)\n/u.exec(out)?.[1];
    return delta === undefined ? undefined : (JSON.parse(delta) as { delta: { stop_reason: string } }).delta.stop_reason;
}
function completedStopReason(finishReason: string): unknown {
    return openAiCompletionToAnthropic({ id: "chatcmpl-f2", choices: [{ index: 0, message: { role: "assistant", content: "partial answer" }, finish_reason: finishReason }], usage: { prompt_tokens: 3, completion_tokens: 2 } }, "anthropic-test", "Test lane")["stop_reason"];
}

describe("finish_reason -> stop_reason (audit D2-06)", () => {
    it("content_filter is a refusal on the streaming path, not an end_turn", async () => {
        strictEqual(await streamedStopReason("content_filter"), "refusal");
    });
    it("content_filter is a refusal on the non-streaming path, not an end_turn", () => {
        strictEqual(completedStopReason("content_filter"), "refusal");
    });
    for (const [finish, expected] of [["stop", "end_turn"], ["length", "max_tokens"], ["tool_calls", "tool_use"], ["function_call", "end_turn"], ["some_future_reason", "end_turn"]] as const) {
        it(`NEGATIVE: ${finish} still maps to ${expected} on both paths (every other mapping is unchanged)`, async () => {
            strictEqual(await streamedStopReason(finish), expected);
            strictEqual(completedStopReason(finish), expected);
        });
    }
    it("NEGATIVE: a completion with no finish_reason at all stays end_turn", () => {
        strictEqual(openAiCompletionToAnthropic({ choices: [{ message: { content: "x" } }] }, "anthropic-test", "Test lane")["stop_reason"], "end_turn");
    });
});
