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

// Phase 9 HARDENING. Every arm pins a SURVIVING finding from the adversarial review. The
// findings were located by MEASUREMENT, not by reading; unmeasured, their remedies would
// have stayed claims.

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
    // Without this wiring, the router's 300 s request timeout and both
    // client-disconnect aborts were DEAD ON THIS ROUTE: the only thing that could end a
    // running ACP turn was the agent finishing on its own. On top of that, a #running
    // session is never swept, so a stuck session was immortal.
    it("abort, bekleyen turu dusurur ve oturumu emekli eder", async () => {
        let ajan: SahteAjan | undefined;
        const registry = defter(
            () => (ajan = new SahteAjan()),
            () => undefined, // the agent does NOTHING: it neither calls a tool nor finishes
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
    // Because identity is tool_use.id, a new conversation opened with a plain turn leaves
    // the old session UNADDRESSABLE: nobody can reach it, yet its process lives on.
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

    // If they are all mid-turn there is nothing to reclaim; silently opening one more
    // would fill up the machine.
    it("hepsi tur ortasindaysa yeni oturum acikca reddedilir", async () => {
        const registry = defter(() => new SahteAjan(), () => undefined, { maxLiveSessions: 1 });
        // This turn NEVER finishes; teardown will cancel it. If its rejection is not
        // swallowed here it blows up as an unhandledRejection AFTER the test has ended.
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
    // If "work was lost" and "we gave up" collapse into the same counter, the §7.3 gate
    // cannot say what it measures.
    it("bizim dusurdugumuz cagrinin gec cevabi eslesmeyen SAYILMAZ", async () => {
        const bridge = new McpToolBridge({ onToolCall: () => undefined, callTimeoutMs: 5 });
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        const bekleyen = bridge.handle({
            jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Read" },
        });
        const cevap = await bekleyen;
        strictEqual((cevap?.["error"] as { code: number }).code, -32001);
        // Claude Code sends the answer LATE.
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

    // A counter that always returns zero is worse than no counter at all.
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

    // The same body, still 422 when there is NO registry -- the old behaviour is preserved.
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
