import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentSessionRegistry } from "../src/mcp/session-registry.js";

// B12 (reported 2026-09-10 on the xAI lane): the Google and xAI lanes each hold their own
// registry. After a `/model` switch from Gemini to Grok the conversation still carried Gemini's
// tool_result blocks; Grok's registry had never minted those ids and refused the turn with 409
// "no live agent session", 44 times in one session, /compact included. Claude Code cannot strip
// tool_result blocks from its own history, so the refusal was a dead end. A result set the
// registry never parked is not a continuation and not an orphan to refuse: ownsLiveSession says
// so, and the adapter runs the turn afresh.
describe("B12 foreign tool results", () => {
    it("ids minted elsewhere own no live session; a pending id does", async () => {
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
            strictEqual(registry.ownsLiveSession(["toolu_from_the_google_lane"]), false, "another lane's id is foreign here");
            strictEqual(registry.isReplay(["toolu_from_the_google_lane"]), false, "and it is not a replay either");
            const begun = await registry.begin("read a", [{ name: "Read", description: "t", inputSchema: { type: "object" } }]);
            strictEqual(begun.outcome.kind, "tool_use");
            const id = (begun.outcome as { kind: "tool_use"; call: { id: string } }).call.id;
            ok(typeof id === "string" && id !== "", "the parked call has an id");
            strictEqual(registry.ownsLiveSession([id]), true, "a pending id of a live session is a continuation");
            strictEqual(registry.ownsLiveSession([id, "toolu_from_the_google_lane"]), true, "one owned id among foreign ones keeps the continuation");
            const resumed = registry.resume([{ toolUseId: id, content: "ALPHA", isError: false }]);
            await parked;
            finish();
            const outcome = await resumed;
            strictEqual(outcome.outcome.kind, "end_turn");
            strictEqual(registry.ownsLiveSession([id]), false, "a retired session owns nothing; the delivered id is a replay, handled by B08");
            strictEqual(registry.isReplay([id]), true);
        }
        finally {
            // `finish` stays the initial no-op until startAgent runs, so a body that throws before
            // begin() would leave `done` forever pending and the test would time out instead of
            // reporting the assertion. Measured 2026-09-13 while running the B12 mutation control:
            // node counts a timeout as `cancelled`, not `fail`, so the arm read as inconclusive.
            // Resolving is idempotent; calling it after closeAll costs nothing when cancel() ran.
            registry.closeAll("test cleanup");
            finish();
            await done;
        }
    });
});
