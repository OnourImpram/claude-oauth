import { ok, strictEqual } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentSessionRegistry } from "../../src/mcp/session-registry.js";

const mode = process.env["HEZARFEN_MCP_PARK_LOG_MODE"];
ok(mode === "plain" || mode === "node-test", "The fixture requires an explicit logging mode.");
strictEqual(process.env["NODE_TEST_CONTEXT"] !== undefined, mode === "node-test",
    "The plain child must exercise the production sink outside node:test.");
const scratch = process.env["LOCALAPPDATA"];
ok(scratch !== undefined, "The fixture requires an isolated log root.");
const privateInput = randomUUID();
let finish = (): void => undefined;
const done = new Promise<void>((resolve) => { finish = resolve; });
let parkedCall: Promise<Record<string, unknown> | undefined> | undefined;
const registry = new AgentSessionRegistry({
    mcpBaseUrl: "http://127.0.0.1:1",
    startAgent: ({ bridge }) => {
        parkedCall = bridge.handle({
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "Read", arguments: { content: privateInput } },
        });
        return { done, text: () => "", cancel: () => finish() };
    },
});
try {
    const { sessionKey, outcome } = await registry.begin(privateInput, [{
        name: "Read", description: "Fixture tool", inputSchema: { type: "object" },
    }]);
    strictEqual(outcome.kind, "tool_use");
    strictEqual(registry.liveSessionCount, 1);
    strictEqual(registry.bridgeFor(sessionKey)?.pendingCount, 1,
        "The log assertion requires a real pending call, not a fabricated log entry.");
    const raw = await readFile(join(scratch, "Hezarfen", "claude-oauth", "router.log"), "utf8")
        .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return "";
        });
    // Compare in memory and report only booleans, so a failed assertion cannot
    // print the generated private input or session key.
    strictEqual(raw.includes(privateInput), false, "The park event must omit prompt and tool arguments.");
    strictEqual(raw.includes(sessionKey), false, "The park event must omit the session key.");
    strictEqual(raw.includes(scratch), false, "The park event must omit local paths.");
}
finally {
    registry.closeAll("park log fixture cleanup");
    await done;
    await parkedCall;
}
