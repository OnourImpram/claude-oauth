import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentSessionRegistry } from "../src/mcp/session-registry.js";

// B08 (measured live 2026-09-08 on the Google lane): Claude Code's compaction request replays the
// last user turn, tool results included. The registry had already delivered those results and
// forgotten their ids, so the replay was refused as "no live agent session" (409); Claude Code
// retried the compaction ten times into the same refusal and gave up the turn. A replayed result
// is neither pending nor an orphan: isReplay says so, and the adapter runs the turn afresh.
describe("B08 replayed tool results", () => {
    it("a delivered id is a replay, a pending id is not, an unknown id is not", async () => {
        let finish = (): void => undefined;
        const done = new Promise<void>((resolve) => { finish = resolve; });
        let parked: Promise<unknown> | undefined;
        const registry = new AgentSessionRegistry({
            mcpBaseUrl: "http://127.0.0.1:1",
            startAgent: ({ bridge }) => {
                parked = bridge.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Read", arguments: { path: "a" } } });
                return { done, text: () => "", cancel: () => finish() };
            },
        });
        try {
            const begun = await registry.begin("read a", [{ name: "Read", description: "t", inputSchema: { type: "object" } }]);
            strictEqual(begun.outcome.kind, "tool_use");
            const id = (begun.outcome as { kind: "tool_use"; call: { id: string } }).call.id;
            ok(typeof id === "string" && id !== "", "the parked call has an id");
            strictEqual(registry.isReplay([id]), false, "a pending id is a live continuation, not a replay");
            strictEqual(registry.isReplay(["never-minted"]), false, "an unknown id is an orphan, not a replay");
            // Deliver; the fake agent then ends its turn.
            const resumed = registry.resume([{ toolUseId: id, content: "ALPHA", isError: false }]);
            await parked;
            finish();
            const outcome = await resumed;
            strictEqual(outcome.outcome.kind, "end_turn");
            strictEqual(registry.isReplay([id]), true, "an already delivered id is a replay even after the session retired");
            strictEqual(registry.isReplay([id, "never-minted"]), true, "one delivered id among unknowns still marks a replay");
        }
        finally {
            registry.closeAll("test cleanup");
            await done;
        }
    });
});
