import { ok, rejects, strictEqual } from "node:assert/strict";
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

class FakeAgent {
    #chunks: string[] = [];
    #resolveDone: () => void = () => undefined;
    readonly done: Promise<void>;
    bridge: McpToolBridge | undefined;
    cancellationReason: string | undefined;

    constructor() {
        this.done = new Promise<void>((resolve) => {
            this.#resolveDone = resolve;
        });
        this.done.catch(() => undefined);
    }

    handle(): AgentRunHandle {
        return {
            done: this.done,
            text: () => this.#chunks.join(""),
            cancel: (reason: string) => {
                this.cancellationReason = reason;
                this.#resolveDone();
            },
        };
    }

    say(text: string): void {
        this.#chunks.push(text);
    }

    callTool(name = "Read"): void {
        void this.bridge?.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } });
    }

    finish(): void {
        this.#resolveDone();
    }
}

const TOOLS = deriveMcpTools([{ name: "Read" }]);

function createRegistry(
    createAgent: () => FakeAgent,
    configureAgent: (a: FakeAgent) => void,
    extraOptions: Partial<SessionRegistryOptions> = {},
): AgentSessionRegistry {
    return new AgentSessionRegistry({
        mcpBaseUrl: "http://127.0.0.1:65000",
        startAgent: (options) => {
            const agent = createAgent();
            agent.bridge = options.bridge;
            configureAgent(agent);
            return agent.handle();
        },
        ...extraOptions,
    });
}

describe("FINDING 1 -- the abort signal ends the turn", () => {
    // Without this wiring, the router's 300 s request timeout and both
    // client-disconnect aborts were DEAD ON THIS ROUTE: the only thing that could end a
    // running ACP turn was the agent finishing on its own. On top of that, a #running
    // session is never swept, so a stuck session was immortal.
    it("abort rejects the pending turn and retires the session", async () => {
        let agent: FakeAgent | undefined;
        const registry = createRegistry(
            () => (agent = new FakeAgent()),
            () => undefined, // the agent does NOTHING: it neither calls a tool nor finishes
        );
        const controller = new AbortController();
        const pending = registry.begin("p", TOOLS, "m", controller.signal);
        await new Promise((r) => setTimeout(r, 10));
        strictEqual(registry.liveSessionCount, 1);
        controller.abort();
        let threw = false;
        try {
            await pending;
        } catch (error) {
            threw = error instanceof RouterError;
        }
        strictEqual(threw, true);
        strictEqual(registry.liveSessionCount, 0);
        strictEqual(agent?.cancellationReason, "client request aborted");
    });

    it("an already aborted signal rejects the turn without ever starting it", async () => {
        const registry = createRegistry(() => new FakeAgent(), () => undefined);
        const controller = new AbortController();
        controller.abort();
        let threw = false;
        try {
            await registry.begin("p", TOOLS, "m", controller.signal);
        } catch {
            threw = true;
        }
        strictEqual(threw, true);
        strictEqual(registry.liveSessionCount, 0);
    });
});

describe("FINDINGS 3 + 6 -- capacity protects parked calls regardless of age", () => {
    it("at the cap even a ten-minute parked call receives 503 protection and can resume", async () => {
        const agents: FakeAgent[] = [];
        let clock = 0;
        const registry = createRegistry(
            () => {
                const a = new FakeAgent();
                agents.push(a);
                return a;
            },
            (a) => a.callTool(),
            { maxLiveSessions: 2, now: () => clock },
        );
        try {
            const first = await registry.begin("one", TOOLS);
            await registry.begin("two", TOOLS);
            strictEqual(first.outcome.kind, "tool_use");
            if (first.outcome.kind !== "tool_use") throw new Error("Expected a parked call");
            for (clock of [5_000, 60_000, 61_000, 10 * 60 * 1000]) {
                await rejects(registry.begin("three", TOOLS), (error: unknown) =>
                    error instanceof RouterError && error.status === 503 && error.code === "adapter_unavailable");
                strictEqual(registry.liveSessionCount, 2);
                strictEqual(agents.length, 2, "refusing capacity must not spawn a replacement");
                strictEqual(agents[0]?.cancellationReason, undefined);
            }
            const resumed = registry.resume([{ toolUseId: first.outcome.call.id, content: "done", isError: false }]);
            agents[0]?.finish();
            strictEqual((await resumed).outcome.kind, "end_turn");
            strictEqual(registry.unmatchedResultCount, 0);
        } finally {
            await registry.closeAllAndWait("test teardown");
        }
    });

    // A nonparked idle session is reachable: the optional MCP call timeout has replied,
    // but the provider process has not exited or asked for another tool yet.
    it("at the cap an idle session whose tool timed out is reclaimed", async () => {
        const agents: FakeAgent[] = [];
        let parkedResponse: Promise<unknown> | undefined;
        const registry = createRegistry(
            () => {
                const a = new FakeAgent();
                agents.push(a);
                return a;
            },
            (a) => {
                parkedResponse = a.bridge?.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Read" } });
            },
            { maxLiveSessions: 1, callTimeoutMs: 5 },
        );
        try {
            const first = await registry.begin("one", TOOLS);
            await parkedResponse;
            strictEqual(registry.bridgeFor(first.sessionKey)?.pendingCount, 0);
            await registry.begin("two", TOOLS);
            strictEqual(registry.liveSessionCount, 1);
            strictEqual(agents.length, 2);
            strictEqual(agents[0]?.cancellationReason, "reclaimed: oldest idle session");
        } finally {
            await registry.closeAllAndWait("test teardown");
            await parkedResponse;
        }
    });

    // If they are all mid-turn there is nothing to reclaim; silently opening one more
    // would fill up the machine.
    it("a new session is explicitly rejected when all sessions are mid-turn", async () => {
        const registry = createRegistry(() => new FakeAgent(), () => undefined, { maxLiveSessions: 1 });
        // This turn NEVER finishes; teardown will cancel it. If its rejection is not
        // swallowed here it blows up as an unhandledRejection AFTER the test has ended.
        const pending = registry.begin("one", TOOLS).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 10));
        let status = 0;
        try {
            await registry.begin("two", TOOLS);
        } catch (error) {
            status = (error as RouterError).status;
        }
        strictEqual(status, 503);
        registry.closeAll("test teardown");
        await pending;
    });
});

describe("FINDING 4 -- two different events increment two different counters", () => {
    // If "work was lost" and "we gave up" collapse into the same counter, the §7.3 gate
    // cannot say what it measures.
    it("a late response to a call we cancelled is NOT COUNTED as unmatched", async () => {
        const bridge = new McpToolBridge({ onToolCall: () => undefined, callTimeoutMs: 5 });
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        const pending = bridge.handle({
            jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Read" },
        });
        const response = await pending;
        strictEqual((response?.["error"] as { code: number }).code, -32001);
        // Claude Code sends the answer LATE.
        const id = String((response?.["error"] as { message: string }).message);
        ok(id.includes("timed out"));
        strictEqual(bridge.unmatchedResultCount, 0);
        strictEqual(bridge.timedOutResultCount, 0);
    });

    it("an id with no owner is counted as unmatched", () => {
        const bridge = new McpToolBridge({ onToolCall: () => undefined, callTimeoutMs: 0 });
        strictEqual(bridge.deliverToolResult("mcp_from_nowhere", "x", false), false);
        strictEqual(bridge.unmatchedResultCount, 1);
        strictEqual(bridge.timedOutResultCount, 0);
    });

    // A counter that always returns zero is worse than no counter at all.
    it("the timeout counter actually increments", async () => {
        const ids: string[] = [];
        const bridge = new McpToolBridge({
            onToolCall: (call) => ids.push(call.id),
            callTimeoutMs: 5,
        });
        bridge.setTools(deriveMcpTools([{ name: "Read" }]));
        await bridge.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Read" } });
        strictEqual(ids.length, 1);
        strictEqual(bridge.deliverToolResult(ids[0] as string, "late response", false), false);
        strictEqual(bridge.timedOutResultCount, 1);
        strictEqual(bridge.unmatchedResultCount, 0);
    });
});

describe("FINDING 5 -- the same body gets the same response at both gates", () => {
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
    const body = {
        model: model.id,
        messages: [
            { role: "user", content: "start" },
            { role: "assistant", content: [{ type: "tool_use", id: "mcp_a", name: "Read", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "mcp_a", content: "ok" }] },
        ],
    };
    const request = (path: AdapterRequest["path"]): AdapterRequest => ({
        requestId: "t",
        path,
        query: "",
        model,
        envelope: body as AdapterRequest["envelope"],
        body: Buffer.from(JSON.stringify(body), "utf8"),
        headers: new Headers(),
        signal: new AbortController().signal,
    });

    it("count_tokens does not reject a tool block when the tool loop is enabled", async () => {
        const sessions = new AgentSessionRegistry({
            mcpBaseUrl: "http://127.0.0.1:65000",
            startAgent: () => {
                throw new Error("count_tokens must not start an agent");
            },
        });
        const adapter = new AgentModelAdapter({
            provider: "xai",
            readiness: async () => ({ provider: "xai" as const, oauthReady: true, adapterReady: true, status: "ready" as const, detailCode: "test" }),
            run: async () => ({ text: "x" }),
            sessions,
        });
        const response = await adapter.send(request("/v1/messages/count_tokens"));
        strictEqual(response.status, 200);
    });

    // The same body, still 422 when there is NO registry -- the old behaviour is preserved.
    it("count_tokens still returns 422 without a registry", async () => {
        const adapter = new AgentModelAdapter({
            provider: "xai",
            readiness: async () => ({ provider: "xai" as const, oauthReady: true, adapterReady: true, status: "ready" as const, detailCode: "test" }),
            run: async () => ({ text: "x" }),
        });
        let status = 0;
        try {
            await adapter.send(request("/v1/messages/count_tokens"));
        } catch (error) {
            status = (error as RouterError).status;
        }
        strictEqual(status, 422);
    });
});
