import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterRequest, ModelRecord } from "../src/domain/contracts.js";
import { AgentModelAdapter } from "../src/adapters/agent-model.js";
import {
    AgentSessionRegistry,
    type AgentRunHandle,
    type SessionRegistryOptions,
} from "../src/mcp/session-registry.js";
import { McpToolBridge, deriveMcpTools } from "../src/mcp/tool-bridge.js";
import { RouterError } from "../src/domain/errors.js";

// Faz 9 SERTLESTIRME. Her kol, adversaryal incelemenin AYAKTA KALAN bir
// bulgusunu civiliyor. Bulgular okunarak degil OLCULEREK bulundu; onarimlari da
// olculmeden iddia olarak kalirdi.

class SahteAjan {
    #parcalar: string[] = [];
    #bitir: () => void = () => undefined;
    readonly done: Promise<void>;
    bridge: McpToolBridge | undefined;
    iptalSebebi: string | undefined;

    constructor() {
        this.done = new Promise<void>((resolve) => {
            this.#bitir = resolve;
        });
        this.done.catch(() => undefined);
    }

    handle(): AgentRunHandle {
        return {
            done: this.done,
            text: () => this.#parcalar.join(""),
            cancel: (reason: string) => {
                this.iptalSebebi = reason;
                this.#bitir();
            },
        };
    }

    soyle(text: string): void {
        this.#parcalar.push(text);
    }

    aracCagir(name = "Read"): void {
        void this.bridge?.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } });
    }

    bitti(): void {
        this.#bitir();
    }
}

const ARACLAR = deriveMcpTools([{ name: "Read" }]);

function defter(
    uret: () => SahteAjan,
    kur: (a: SahteAjan) => void,
    ek: Partial<SessionRegistryOptions> = {},
): AgentSessionRegistry {
    return new AgentSessionRegistry({
        mcpBaseUrl: "http://127.0.0.1:65000",
        startAgent: (options) => {
            const ajan = uret();
            ajan.bridge = options.bridge;
            kur(ajan);
            return ajan.handle();
        },
        ...ek,
    });
}

describe("BULGU 1 -- iptal sinyali turu bitirir", () => {
    // Bu baglanti olmadan router'in 300 sn istek zaman asimi ve iki
    // client-disconnect abort'u BU ROTADA OLUYDU: kosan bir ACP turunu
    // bitirecek tek sey ajanin kendiliginden bitmesiydi. Ustelik #running bir
    // oturum sweep edilmez, yani takilan oturum olumsuzdu.
    it("abort, bekleyen turu dusurur ve oturumu emekli eder", async () => {
        let ajan: SahteAjan | undefined;
        const registry = defter(
            () => (ajan = new SahteAjan()),
            () => undefined, // ajan HICBIR SEY yapmaz: ne arac cagirir ne biter
        );
        const kontrol = new AbortController();
        const bekleyen = registry.begin("p", ARACLAR, "m", kontrol.signal);
        await new Promise((r) => setTimeout(r, 10));
        strictEqual(registry.liveSessionCount, 1);
        kontrol.abort();
        let atildi = false;
        try {
            await bekleyen;
        } catch (error) {
            atildi = error instanceof RouterError;
        }
        strictEqual(atildi, true);
        strictEqual(registry.liveSessionCount, 0);
        strictEqual(ajan?.iptalSebebi, "client request aborted");
    });

    it("zaten abort edilmis bir sinyal, turu hic baslatmadan dusurur", async () => {
        const registry = defter(() => new SahteAjan(), () => undefined);
        const kontrol = new AbortController();
        kontrol.abort();
        let atildi = false;
        try {
            await registry.begin("p", ARACLAR, "m", kontrol.signal);
        } catch {
            atildi = true;
        }
        strictEqual(atildi, true);
        strictEqual(registry.liveSessionCount, 0);
    });
});

describe("BULGU 3 + 6 -- adressiz oturumlar geri alinir, tavan var", () => {
    // Kimlik tool_use.id oldugu icin, duz bir turla acilan yeni konusma eski
    // oturumu ADRESSIZ birakir: kimse ona ulasamaz ama sureci yasar.
    it("tavana varinca en eski BOSTA oturum geri alinir, istek 503 almaz", async () => {
        const ajanlar: SahteAjan[] = [];
        const registry = defter(
            () => {
                const a = new SahteAjan();
                ajanlar.push(a);
                return a;
            },
            (a) => a.aracCagir(),
            { maxLiveSessions: 2 },
        );
        await registry.begin("bir", ARACLAR);
        await registry.begin("iki", ARACLAR);
        strictEqual(registry.liveSessionCount, 2);
        await registry.begin("uc", ARACLAR);
        strictEqual(registry.liveSessionCount, 2);
        strictEqual(ajanlar[0]?.iptalSebebi, "reclaimed: oldest idle session");
        registry.closeAll("test teardown");
    });

    // Hepsi tur ortasindaysa geri alinacak bir sey yoktur; sessizce bir tane
    // daha acmak makineyi doldururdu.
    it("hepsi tur ortasindaysa yeni oturum acikca reddedilir", async () => {
        const registry = defter(() => new SahteAjan(), () => undefined, { maxLiveSessions: 1 });
        // Bu tur ASLA bitmez; teardown onu iptal edecek. Reddi burada
        // yutulmazsa test bittikten SONRA unhandledRejection olarak patlar.
        const askida = registry.begin("bir", ARACLAR).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 10));
        let durum = 0;
        try {
            await registry.begin("iki", ARACLAR);
        } catch (error) {
            durum = (error as RouterError).status;
        }
        strictEqual(durum, 503);
        registry.closeAll("test teardown");
        await askida;
    });
});

describe("BULGU 4 -- iki farkli olay iki farkli sayaca yazilir", () => {
    // "Is kayboldu" ile "biz vazgectik" ayni sayida cokerse, §7.3 kapisi neyi
    // olctugunu soyleyemez.
    it("bizim dusurdugumuz cagrinin gec cevabi eslesmeyen SAYILMAZ", async () => {
        const bridge = new McpToolBridge({ onToolCall: () => undefined, callTimeoutMs: 5 });
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        const bekleyen = bridge.handle({
            jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Read" },
        });
        const cevap = await bekleyen;
        strictEqual((cevap?.["error"] as { code: number }).code, -32001);
        // Claude Code cevabi GEC gonderiyor.
        const id = String((cevap?.["error"] as { message: string }).message);
        ok(id.includes("timed out"));
        strictEqual(bridge.unmatchedResultCount, 0);
        strictEqual(bridge.timedOutResultCount, 0);
    });

    it("gercekten sahipsiz bir id eslesmeyen sayilir", () => {
        const bridge = new McpToolBridge({ onToolCall: () => undefined, callTimeoutMs: 0 });
        strictEqual(bridge.deliverToolResult("mcp_hicbiryerden", "x", false), false);
        strictEqual(bridge.unmatchedResultCount, 1);
        strictEqual(bridge.timedOutResultCount, 0);
    });

    // Her zaman sifir donen bir sayac, olmayan bir sayactan daha kotudur.
    it("zaman asimi sayaci gercekten hareket eder", async () => {
        const idler: string[] = [];
        const bridge = new McpToolBridge({
            onToolCall: (call) => idler.push(call.id),
            callTimeoutMs: 5,
        });
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        await bridge.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Read" } });
        strictEqual(idler.length, 1);
        strictEqual(bridge.deliverToolResult(idler[0] as string, "gec cevap", false), false);
        strictEqual(bridge.timedOutResultCount, 1);
        strictEqual(bridge.unmatchedResultCount, 0);
    });
});

describe("BULGU 5 -- ayni govde iki kapida ayni cevabi alir", () => {
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
    const govde = {
        model: model.id,
        messages: [
            { role: "user", content: "start" },
            { role: "assistant", content: [{ type: "tool_use", id: "mcp_a", name: "Read", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "mcp_a", content: "ok" }] },
        ],
    };
    const istek = (path: AdapterRequest["path"]): AdapterRequest => ({
        requestId: "t",
        path,
        query: "",
        model,
        envelope: govde as AdapterRequest["envelope"],
        body: Buffer.from(JSON.stringify(govde), "utf8"),
        headers: new Headers(),
        signal: new AbortController().signal,
    });

    it("count_tokens, arac dongusu acikken tool blogunu reddetmez", async () => {
        const sessions = new AgentSessionRegistry({
            mcpBaseUrl: "http://127.0.0.1:65000",
            startAgent: () => {
                throw new Error("count_tokens ajan baslatmamali");
            },
        });
        const adapter = new AgentModelAdapter({
            provider: "xai",
            readiness: async () => ({ provider: "xai" as const, oauthReady: true, adapterReady: true, status: "ready" as const, detailCode: "test" }),
            run: async () => ({ text: "x" }),
            sessions,
        });
        const response = await adapter.send(istek("/v1/messages/count_tokens"));
        strictEqual(response.status, 200);
    });

    // Ayni govde, defter YOKKEN hala 422 -- eski davranis korunuyor.
    it("defter yokken count_tokens hala 422 doner", async () => {
        const adapter = new AgentModelAdapter({
            provider: "xai",
            readiness: async () => ({ provider: "xai" as const, oauthReady: true, adapterReady: true, status: "ready" as const, detailCode: "test" }),
            run: async () => ({ text: "x" }),
        });
        let durum = 0;
        try {
            await adapter.send(istek("/v1/messages/count_tokens"));
        } catch (error) {
            durum = (error as RouterError).status;
        }
        strictEqual(durum, 422);
    });
});
