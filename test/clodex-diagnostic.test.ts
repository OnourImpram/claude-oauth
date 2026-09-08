import { rejects, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { ClodexAdapter } from "../src/adapters/clodex.js";
import type { AdapterRequest } from "../src/domain/contracts.js";

const request: AdapterRequest = {
    requestId: "diagnostic-test", path: "/v1/messages", query: "",
    model: {
        id: "test", provider: "openai", upstreamModel: "test", displayName: "Test",
        oauthType: "chatgpt", executionMode: "native-message-loop", discoverable: true, capabilities: ["messages"],
    },
    envelope: { model: "test", messages: [{ role: "user", content: "test" }] },
    body: new Uint8Array(), headers: new Headers(), signal: new AbortController().signal,
};

for (const declared of [undefined, "1", "32769"]) {
    it(`Clodex bounds a streamed error body with content-length ${declared ?? "absent"}`, async () => {
        let pulls = 0;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls += 1;
                if (pulls <= 8) controller.enqueue(new Uint8Array(16 * 1024));
                else controller.close();
            },
            cancel() { cancelled = true; },
        }, { highWaterMark: 0 });
        const response = new Response(body, {
            status: 400,
            ...(declared === undefined ? {} : { headers: { "content-length": declared } }),
        });
        const adapter = new ClodexAdapter({ send: async () => response }, "", async () => ({
            provider: "openai", oauthReady: true, adapterReady: true, status: "ready",
        }));
        await rejects(adapter.send(request), { code: "invalid_request", status: 400 });
        strictEqual(cancelled, true);
        strictEqual(pulls, declared === "32769" ? 0 : 3);
        strictEqual(body.locked, false);
    });
}

it("a small Clodex error body is read to completion without changing the HTTP classification", async () => {
    const adapter = new ClodexAdapter({
        send: async () => new Response(JSON.stringify({ error: { message: "invalid tool result" } }), { status: 400 }),
    }, "", async () => ({ provider: "openai", oauthReady: true, adapterReady: true, status: "ready" }));
    await rejects(adapter.send(request), { code: "invalid_request", status: 400 });
});
