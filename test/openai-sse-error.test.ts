import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { RouterError } from "../src/domain/errors.js";
import { openAiSseToAnthropic } from "../src/adapters/openai-sse.js";

// Audit D2-05: an OpenAI-style server that fails AFTER the headers are out streams
// `data: {"error":{...}}` with no `choices`. The router used to report every such record as
// "emitted an invalid chat completion chunk" (502) and drop the upstream's reason, so the
// operator could not tell a context overflow from a router bug and the client retried a
// deterministic failure. Synthetic strings only.
const KEY = "sse-error-unit-test-placeholder-not-a-key";
const CONTENT_CHUNK = { id: "chatcmpl-e1", choices: [{ index: 0, delta: { role: "assistant", content: "partial" } }] };

function sseText(events: readonly unknown[]): string {
    return events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
}
async function drain(text: string, options: Parameters<typeof openAiSseToAnthropic>[2] = {}): Promise<{ readonly out: string; readonly error?: unknown }> {
    const reader = openAiSseToAnthropic(new Response(text).body as ReadableStream<Uint8Array>, "anthropic-test", { label: "Test lane", ...options }).getReader();
    const decoder = new TextDecoder();
    let out = "";
    try {
        for (;;) {
            const result = await reader.read();
            if (result.done)
                return { out };
            out += decoder.decode(result.value, { stream: true });
        }
    }
    catch (error) {
        return { out, error };
    }
}
function routerError(error: unknown): RouterError {
    ok(error instanceof RouterError, `a RouterError was thrown (got ${String(error)})`);
    return error;
}

describe("OpenAI-style SSE: an error object inside the stream surfaces the upstream's reason (audit D2-05)", () => {
    it("an error after a content chunk names the upstream message; it is not the generic invalid-chunk error", async () => {
        const failure = routerError((await drain(sseText([CONTENT_CHUNK, { error: { message: "MARKER context length exceeded", code: 400 } }]))).error);
        ok(failure.message.includes("MARKER context length exceeded"), failure.message);
        ok(!failure.message.includes("invalid chat completion chunk"), failure.message);
    });
    for (const code of [400, 413, 422, "400", "413", "422"] as const) {
        it(`code ${JSON.stringify(code)} is a 400-class invalid_request: the client must not retry a deterministic failure`, async () => {
            const failure = routerError((await drain(sseText([CONTENT_CHUNK, { error: { message: "too long", code } }]))).error);
            strictEqual(failure.code, "invalid_request");
            strictEqual(failure.status, 400);
        });
    }
    for (const named of [{ code: "context_length_exceeded" }, { type: "invalid_request_error" }, { code: null, type: "invalid_request_error" }, { code: "string_above_max_length", type: "invalid_request_error" }]) {
        it(`an error named ${JSON.stringify(named)} (no numeric code) is a 400-class invalid_request`, async () => {
            const failure = routerError((await drain(sseText([{ error: { message: "nope", ...named } }]))).error);
            strictEqual(failure.code, "invalid_request");
            strictEqual(failure.status, 400);
        });
    }
    for (const code of [429, "429"] as const) {
        it(`code ${JSON.stringify(code)} is the lane's rate-limit error`, async () => {
            const failure = routerError((await drain(sseText([CONTENT_CHUNK, { error: { message: "slow down", code } }]))).error);
            strictEqual(failure.code, "provider_rate_limited");
            strictEqual(failure.status, 429);
            ok(failure.message.includes("slow down"));
        });
    }
    it("NEGATIVE: any other code, or none, stays a 502 upstream error that still carries the reason", async () => {
        for (const error of [{ message: "boom", code: 500 }, { message: "boom", code: "server_error" }, { message: "boom" }, { message: "boom", code: 503, type: "server_error" }]) {
            const failure = routerError((await drain(sseText([CONTENT_CHUNK, { error }]))).error);
            strictEqual(failure.code, "upstream_protocol_error", JSON.stringify(error));
            strictEqual(failure.status, 502, JSON.stringify(error));
            ok(failure.message.includes("boom"), failure.message);
        }
    });
    it("the quoted reason is bounded to 300 characters, whitespace-collapsed", async () => {
        const failure = routerError((await drain(sseText([{ error: { message: `${"x ".repeat(400)}TAIL-MARKER\n\nafter`, code: 400 } }]))).error);
        const quoted = failure.message.split("Upstream said: ")[1] ?? "";
        ok(quoted.length > 0 && quoted.length <= 300, `quoted ${quoted.length} characters`);
        ok(!failure.message.includes("TAIL-MARKER"));
        ok(!failure.message.includes("\n"));
    });
    it("a lane key echoed by the upstream is redacted before the reason is quoted", async () => {
        const failure = routerError((await drain(sseText([{ error: { message: `bad key ${KEY} rejected`, code: 400 } }]), { secrets: [KEY, "other-secret-value"] })).error);
        ok(!failure.message.includes(KEY), failure.message);
        ok(failure.message.includes("[redacted]"), failure.message);
    });
    it("an error object that is a plain string is quoted too", async () => {
        const failure = routerError((await drain(sseText([{ error: "MARKER plain string reason" }]))).error);
        ok(failure.message.includes("MARKER plain string reason"), failure.message);
        strictEqual(failure.status, 502);
    });
    it("NEGATIVE: a record that is neither a chunk nor an error object keeps the invalid-chunk error", async () => {
        for (const record of [{ unrelated: 1 }, { error: 5 }, { error: null }, { error: [] }]) {
            const failure = routerError((await drain(sseText([record]))).error);
            strictEqual(failure.code, "upstream_protocol_error", JSON.stringify(record));
            strictEqual(failure.status, 502);
            ok(failure.message.includes("invalid chat completion chunk"), failure.message);
        }
    });
    it("the completion callback fires exactly once when the stream ends in an upstream error", async () => {
        let completions = 0;
        await drain(sseText([CONTENT_CHUNK, { error: { message: "x", code: 400 } }]), { onComplete: () => { completions += 1; } });
        strictEqual(completions, 1);
    });
});
