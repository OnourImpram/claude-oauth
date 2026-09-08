import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
    AgentSessionRegistry,
    type AgentRunHandle,
    type SessionRegistryOptions,
} from "../src/mcp/session-registry.js";
import { McpToolBridge, deriveMcpTools } from "../src/mcp/tool-bridge.js";
import { RouterError } from "../src/domain/errors.js";

// Phase 9 / Path 4. This registry is the join between a STATELESS Messages API and
// a STATEFUL ACP session. The gate is spec §7.3: tool results that match nothing
// must be COUNTED. Everything here exists to keep that number honest, and to
// prove the two ways a turn can hang -- an outcome produced before the turn was
// armed, and a turn nothing will ever resolve -- are closed.

class FakeAgent {
    #chunks: string[] = [];
    #resolveDone: () => void = () => undefined;
    #rejectDone: (error: unknown) => void = () => undefined;
    readonly done: Promise<void>;
    bridge: McpToolBridge | undefined;
    mcpUrl = "";
    cancellationReason: string | undefined;

    constructor() {
        this.done = new Promise<void>((resolve, reject) => {
            this.#resolveDone = resolve;
            this.#rejectDone = reject;
        });
        // The registry attaches its own handler; this one only keeps Node from
        // reporting an unhandled rejection in the failure arms.
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

    /** The agent calling one of Claude Code's tools. Never awaited by the caller. */
    callTool(name: string, id = 1): Promise<Record<string, unknown> | undefined> {
        const bridge = this.bridge;
        if (bridge === undefined) throw new Error("bridge not wired");
        return bridge.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name } });
    }

    finish(): void {
        this.#resolveDone();
    }

    fail(error: unknown): void {
        this.#rejectDone(error);
    }
}

const TOOLS = deriveMcpTools([{ name: "Read" }, { name: "Edit" }]);

function createRegistry(
    agent: FakeAgent,
    configureAgent: (agent: FakeAgent) => void = () => undefined,
    extraOptions: Partial<SessionRegistryOptions> = {},
): AgentSessionRegistry {
    return new AgentSessionRegistry({
        mcpBaseUrl: "http://127.0.0.1:65000/",
        startAgent: (options) => {
            agent.bridge = options.bridge;
            agent.mcpUrl = options.mcpUrl;
            configureAgent(agent);
            return agent.handle();
        },
        ...extraOptions,
    });
}

describe("session addressing", () => {
    it("the mcp url carries the session key and normalizes the base", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => {
            a.say("done");
            a.finish();
        });
        const { sessionKey } = await registry.begin("p", TOOLS);
        strictEqual(agent.mcpUrl, `http://127.0.0.1:65000/mcp/${sessionKey}`);
        ok(!agent.mcpUrl.includes("//mcp"));
    });

    // The router does not exist when this registry is built -- the provider set
    // starts first. A base URL read too early would hand the agent a relative
    // URL it silently fails to reach, and the symptom would be "the model is
    // selected but nothing comes back": indistinguishable from a slow provider.
    // Named error instead.
    it("a base URL that is not known yet is a named error, not a broken URL", () => {
        const registry = new AgentSessionRegistry({
            mcpBaseUrl: () => "",
            startAgent: () => {
                throw new Error("must not be reached");
            },
        });
        let failure: RouterError | undefined;
        try {
            registry.mcpUrlFor("abc");
        } catch (error) {
            failure = error instanceof RouterError ? error : undefined;
        }
        strictEqual(failure?.status, 503);
        ok(String(failure?.message).includes("ONARIM:"));
    });

    it("the base URL is read lazily, so late wiring still works", () => {
        let base = "";
        const registry = new AgentSessionRegistry({
            mcpBaseUrl: () => base,
            startAgent: () => {
                throw new Error("must not be reached");
            },
        });
        base = "http://127.0.0.1:8787/";
        strictEqual(registry.mcpUrlFor("abc"), "http://127.0.0.1:8787/mcp/abc");
    });

    it("bridgeFor answers only for a live key", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => void a.callTool("Read"));
        const { sessionKey } = await registry.begin("p", TOOLS);
        ok(registry.bridgeFor(sessionKey) instanceof McpToolBridge);
        strictEqual(registry.bridgeFor("missing"), undefined);
        registry.closeAll("test teardown");
    });
});

describe("turn handoff", () => {
    it("an agent that never calls a tool ends the turn and retires the session", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => {
            a.say("plain answer");
            a.finish();
        });
        const { outcome } = await registry.begin("p", TOOLS);
        strictEqual(outcome.kind, "end_turn");
        strictEqual(outcome.text, "plain answer");
        strictEqual(registry.liveSessionCount, 0);
    });

    // REGRESSION ARM. The agent calls its tool SYNCHRONOUSLY inside startAgent,
    // before the turn exists. Without the outcome buffer this request hangs
    // forever instead of failing -- the worst shape of defect, because it looks
    // like a slow provider.
    it("a tool call made before the turn is armed is not lost", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => {
            a.say("thinking");
            void a.callTool("Read");
        });
        const { outcome } = await registry.begin("p", TOOLS);
        strictEqual(outcome.kind, "tool_use");
        strictEqual(outcome.text, "thinking");
        strictEqual(registry.liveSessionCount, 1);
        registry.closeAll("test teardown");
    });

    it("text is sliced per turn, never replayed whole", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => {
            a.say("first");
            void a.callTool("Read");
        });
        const first = await registry.begin("p", TOOLS);
        strictEqual(first.outcome.kind === "tool_use" ? first.outcome.text : "", "first");
        const call = first.outcome.kind === "tool_use" ? first.outcome.call : undefined;
        ok(call !== undefined);

        agent.say("second");
        agent.finish();
        const next = await registry.resume([
            { toolUseId: call.id, content: "file body", isError: false },
        ]);
        strictEqual(next.outcome.kind, "end_turn");
        // "first" must NOT appear again: Claude Code would render it twice.
        strictEqual(next.outcome.text, "second");
        strictEqual(registry.liveSessionCount, 0);
        strictEqual(registry.unmatchedResultCount, 0);
    });

    it("the same session serves both turns", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => void a.callTool("Read"));
        const first = await registry.begin("p", TOOLS);
        const call = first.outcome.kind === "tool_use" ? first.outcome.call : undefined;
        ok(call !== undefined);
        agent.finish();
        const next = await registry.resume([{ toolUseId: call.id, content: "x", isError: false }]);
        strictEqual(next.sessionKey, first.sessionKey);
    });
});

describe("the §7.3 gate -- unmatched results", () => {
    it("a tool result for a session that never existed is counted", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent);
        let threw = false;
        try {
            await registry.resume([{ toolUseId: "mcp_missing", content: "x", isError: false }]);
        } catch (error) {
            threw = error instanceof RouterError;
        }
        strictEqual(threw, true);
        strictEqual(registry.unmatchedResultCount, 1);
    });

    it("a result arriving after the session retired is counted, not silently dropped", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => void a.callTool("Read"));
        const first = await registry.begin("p", TOOLS);
        const call = first.outcome.kind === "tool_use" ? first.outcome.call : undefined;
        ok(call !== undefined);
        agent.finish();
        await registry.resume([{ toolUseId: call.id, content: "x", isError: false }]);
        strictEqual(registry.liveSessionCount, 0);

        let threw = false;
        try {
            await registry.resume([{ toolUseId: call.id, content: "again", isError: false }]);
        } catch {
            threw = true;
        }
        strictEqual(threw, true);
        strictEqual(registry.unmatchedResultCount, 1);
    });

    // The count must OUTLIVE the session it came from. If retiring a session
    // erased its counter, the gate would report zero for exactly the runs where
    // work was lost.
    it("a retired session's unmatched count survives retirement", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => void a.callTool("Read"));
        const first = await registry.begin("p", TOOLS);
        const call = first.outcome.kind === "tool_use" ? first.outcome.call : undefined;
        ok(call !== undefined);
        const bridge = registry.bridgeFor(first.sessionKey);
        ok(bridge !== undefined);
        strictEqual(bridge.deliverToolResult("mcp_other", "x", false), false);
        strictEqual(registry.unmatchedResultCount, 1);
        agent.finish();
        await registry.resume([{ toolUseId: call.id, content: "x", isError: false }]);
        strictEqual(registry.liveSessionCount, 0);
        strictEqual(registry.unmatchedResultCount, 1);
    });

    it("an empty result list is refused rather than opening a turn nothing resolves", async () => {
        const registry = createRegistry(new FakeAgent());
        let threw = false;
        try {
            await registry.resume([]);
        } catch (error) {
            threw = error instanceof RouterError;
        }
        strictEqual(threw, true);
    });
});

describe("failure states are explicit, never hangs", () => {
    it("an already aborted begin does not start an agent or reclaim an existing session", async () => {
        const agent = new FakeAgent();
        let starts = 0;
        const registry = createRegistry(agent, (a) => {
            starts += 1;
            void a.callTool("Read");
        }, { maxLiveSessions: 1 });
        try {
            const first = await registry.begin("p", TOOLS);
            const cancelled = new AbortController();
            cancelled.abort();
            await rejects(registry.begin("cancelled", TOOLS, "m", cancelled.signal), { status: 504 });
            strictEqual(starts, 1);
            strictEqual(registry.liveSessionCount, 1);
            strictEqual(registry.bridgeFor(first.sessionKey), agent.bridge);
            strictEqual(agent.cancellationReason, undefined);
        } finally {
            registry.closeAll("test teardown");
        }
    });

    it("an already aborted resume does not deliver a tool result and can be retried", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => void a.callTool("Read"));
        try {
            const first = await registry.begin("p", TOOLS);
            ok(first.outcome.kind === "tool_use");
            const results = [{ toolUseId: first.outcome.call.id, content: "result", isError: false }];
            const cancelled = new AbortController();
            cancelled.abort();
            await rejects(registry.resume(results, cancelled.signal), { status: 504 });
            strictEqual(agent.bridge?.pendingCount, 1);
            strictEqual(registry.liveSessionCount, 1);
            strictEqual(agent.cancellationReason, undefined);
            const retry = registry.resume(results);
            agent.finish();
            strictEqual((await retry).outcome.kind, "end_turn");
            strictEqual(registry.unmatchedResultCount, 0);
        } finally {
            registry.closeAll("test teardown");
        }
    });

    it("a synchronous starter failure releases parked calls and removes its session", async () => {
        let bridge: McpToolBridge | undefined;
        let call: Promise<Record<string, unknown> | undefined> | undefined;
        let key = "";
        const failure = new Error("starter failed");
        const registry = new AgentSessionRegistry({
            mcpBaseUrl: "http://127.0.0.1:65000",
            startAgent: (options) => {
                bridge = options.bridge;
                key = options.sessionKey;
                call = bridge.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Read" } });
                throw failure;
            },
        });
        try {
            await rejects(registry.begin("p", TOOLS), (error: unknown) => error === failure);
            strictEqual(registry.liveSessionCount, 0);
            strictEqual(registry.bridgeFor(key), undefined);
            strictEqual(bridge?.pendingCount, 0);
            const answer = await call;
            strictEqual((answer?.["error"] as { code: number }).code, -32001);
        } finally {
            registry.closeAll("test teardown");
        }
    });

    it("failed lazy configuration leaves no session and can be retried", async () => {
        let base = "";
        let starts = 0;
        const registry = new AgentSessionRegistry({
            mcpBaseUrl: () => base,
            startAgent: () => {
                starts += 1;
                return { done: Promise.resolve(), text: () => "done", cancel: () => undefined };
            },
        });
        try {
            await rejects(registry.begin("p", TOOLS), { status: 503 });
            strictEqual(registry.liveSessionCount, 0);
            strictEqual(starts, 0);
            base = "http://127.0.0.1:65000";
            strictEqual((await registry.begin("p", TOOLS)).outcome.kind, "end_turn");
            strictEqual(starts, 1);
            strictEqual(registry.liveSessionCount, 0);
        } finally {
            registry.closeAll("test teardown");
        }
    });

    it("an agent that exits with a call parked releases that call", async () => {
        const agent = new FakeAgent();
        const pendingCalls: Promise<Record<string, unknown> | undefined>[] = [];
        const registry = createRegistry(agent, (a) => {
            pendingCalls.push(a.callTool("Read"));
        });
        const first = await registry.begin("p", TOOLS);
        strictEqual(first.outcome.kind, "tool_use");
        // Agent dies without ever being answered.
        agent.finish();
        const response = await pendingCalls[0];
        strictEqual((response?.["error"] as { code: number }).code, -32001);
    });

    it("an agent that crashes surfaces the error instead of a silent end_turn", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => a.fail(new Error("acp connection closed")));
        let message = "";
        try {
            await registry.begin("p", TOOLS);
        } catch (error) {
            message = (error as Error).message;
        }
        strictEqual(message, "acp connection closed");
        strictEqual(registry.liveSessionCount, 0);
    });

    // FOUND BY THE MUTATION CONTROL, not by reading the code: removing the
    // cancel from the "nothing delivered" branch changed no test, which meant no
    // test reached that branch. It is reachable whenever the session is still
    // INDEXED but its parked call is already gone -- a swept or timed-out call.
    // Without the cancel, the armed turn is resolved by nobody and the request
    // hangs until the 300 s router timeout.
    it("a session whose parked call vanished fails instead of hanging", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => void a.callTool("Read"));
        const first = await registry.begin("p", TOOLS);
        const call = first.outcome.kind === "tool_use" ? first.outcome.call : undefined;
        ok(call !== undefined);
        // The bridge loses the parked call while the registry still indexes its id.
        registry.bridgeFor(first.sessionKey)?.cancelAll("call vanished");

        let threw = false;
        try {
            await registry.resume([{ toolUseId: call.id, content: "x", isError: false }]);
        } catch (error) {
            threw = error instanceof RouterError;
        }
        strictEqual(threw, true);
        strictEqual(registry.liveSessionCount, 0);
    });

    it("a result matching nothing in a live session fails loudly and retires it", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => void a.callTool("Read"));
        const first = await registry.begin("p", TOOLS);
        const call = first.outcome.kind === "tool_use" ? first.outcome.call : undefined;
        ok(call !== undefined);
        // An id from this session's neighbourhood but never parked.
        let threw = false;
        try {
            await registry.resume([{ toolUseId: "mcp_fabricated", content: "x", isError: false }]);
        } catch {
            threw = true;
        }
        strictEqual(threw, true);
        strictEqual(registry.unmatchedResultCount, 1);
        registry.closeAll("test teardown");
    });
});

describe("sweeping", () => {
    it("an idle session is swept and its agent is cancelled", async () => {
        const agent = new FakeAgent();
        let clock = 1_000;
        const registry = createRegistry(agent, (a) => void a.callTool("Read"), {
            idleTimeoutMs: 100,
            now: () => clock,
        });
        await registry.begin("p", TOOLS);
        strictEqual(registry.liveSessionCount, 1);
        clock += 50;
        strictEqual(registry.sweep(), 0);
        strictEqual(registry.liveSessionCount, 1);
        clock += 200;
        strictEqual(registry.sweep(), 1);
        strictEqual(registry.liveSessionCount, 0);
        strictEqual(agent.cancellationReason, "idle session swept");
    });

    it("closeAll reports how many sessions it tore down", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => void a.callTool("Read"));
        await registry.begin("p", TOOLS);
        strictEqual(registry.closeAll("router shutdown"), 1);
        strictEqual(registry.liveSessionCount, 0);
    });
});

describe("tool surface", () => {
    it("the agent is offered exactly Claude Code's tools", async () => {
        const agent = new FakeAgent();
        const registry = createRegistry(agent, (a) => void a.callTool("Read"));
        const { sessionKey } = await registry.begin("p", TOOLS);
        const bridge = registry.bridgeFor(sessionKey);
        deepStrictEqual(bridge?.tools.map((tool) => tool.name), ["Read", "Edit"]);
        registry.closeAll("test teardown");
    });
});
