import { rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentModelAdapter, type AgentModelRunRequest } from "../src/adapters/agent-model.js";
import type { AdapterRequest, MessageEnvelope, ModelRecord } from "../src/domain/contracts.js";

// Gemini ve Grok "agent-readonly" modunda kosar: konusma, tek bir metin prompt'una
// DERLENIR. Bu derlemede gecmis turlar ile SIMDIKI istek birbirine karisirsa model
// onceki turu yeniden cevaplar ya da konusmayi bastan baslatir -- kullaniciya
// "model beni dinlemiyor" olarak gorunen sinif budur. Sinir bu yuzden test edilir.

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
            return { text: "CEVAP" };
        },
    });
}

async function compiledPromptFor(envelope: MessageEnvelope): Promise<string> {
    const sink: { prompt?: string } = {};
    await adapterCapturing(sink).send(request(envelope));
    return sink.prompt ?? "";
}

describe("derlenen agent prompt'u", () => {
    it("sozlesme basligiyla baslar", async () => {
        const prompt = await compiledPromptFor({ model: model.id, messages: [{ role: "user", content: "merhaba" }] });
        strictEqual(prompt.startsWith("HEZARFEN_AGENT_READONLY_V1"), true);
    });

    it("SIMDIKI istegi son bolume koyar", async () => {
        const prompt = await compiledPromptFor({ model: model.id, messages: [{ role: "user", content: "son istek" }] });
        strictEqual(prompt.trimEnd().endsWith("son istek"), true);
    });

    // Sinirin kendisi: gecmis "baglam", son mesaj "istek". Ikisi ayri basliklar altinda olmali.
    it("gecmis turlari ISTEK olarak degil BAGLAM olarak isaretler", async () => {
        const prompt = await compiledPromptFor({
            model: model.id,
            messages: [
                { role: "user", content: "eski soru" },
                { role: "assistant", content: "eski cevap" },
                { role: "user", content: "yeni soru" },
            ],
        });
        const historyIndex = prompt.indexOf("CONVERSATION HISTORY");
        const currentIndex = prompt.indexOf("CURRENT USER REQUEST:");
        strictEqual(historyIndex >= 0, true);
        strictEqual(currentIndex > historyIndex, true);
        strictEqual(prompt.slice(historyIndex, currentIndex).includes("eski soru"), true);
        strictEqual(prompt.slice(currentIndex).includes("yeni soru"), true);
        strictEqual(prompt.slice(currentIndex).includes("eski soru"), false);
    });

    it("modele onceki turu yeniden cevaplamamasini acikca soyler", async () => {
        const prompt = await compiledPromptFor({ model: model.id, messages: [{ role: "user", content: "x" }] });
        strictEqual(prompt.includes("Do not answer an earlier turn again"), true);
    });

    it("ust katman arac semalarini BILGI olarak isaretler, cagrilabilir olarak degil", async () => {
        const prompt = await compiledPromptFor({
            model: model.id,
            messages: [{ role: "user", content: "x" }],
            tools: [{ name: "Read" }, { name: "Write" }],
        });
        strictEqual(prompt.includes("informational only"), true);
        strictEqual(prompt.includes("Read"), true);
    });

    it("hic arac yoksa arac bolumunu hic yazmaz", async () => {
        const prompt = await compiledPromptFor({ model: model.id, messages: [{ role: "user", content: "x" }] });
        strictEqual(prompt.includes("Parent tool names"), false);
    });

    it("bos bir istegi REDDEDER (sessizce bos prompt gondermez)", async () => {
        await rejects(
            async () => { await compiledPromptFor({ model: model.id, messages: [{ role: "user", content: "   " }] }); },
            /non-empty current user request/u,
        );
    });
});

describe("count_tokens yolu", () => {
    it("saglayiciyi hic cagirmadan yerel ust sinir doner", async () => {
        const sink: { prompt?: string } = {};
        const response = await adapterCapturing(sink).send(request({ model: model.id, messages: [{ role: "user", content: "merhaba" }] }, "/v1/messages/count_tokens"));
        strictEqual(response.status, 200);
        strictEqual(sink.prompt, undefined);
    });
});

describe("saglayici/model eslesmesi", () => {
    it("adaptorun saglayicisi model saglayicisiyla uyusmazsa reddeder", async () => {
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

    it("pingIntervalMs pozitif tamsayi degilse kurulusu reddeder", () => {
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
