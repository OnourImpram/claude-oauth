import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { GATEWAY_HINT_HEADERS, upstreamRequestHeaders } from "../src/router/headers.js";
import { claudeRouterEnvironment } from "../src/supervisor/launcher.js";

// CASE RECORD (measured 2026-11-15, Claude Code 2.1.325). The receipt field `requestClass`
// was wired to the header `x-claude-code-request-class` and never fired: 0 of 1630 receipts
// carried it, three live probes included. The binary sends that header (and three siblings)
// only when its gate `YHr()` says so: the environment value CLAUDE_CODE_GATEWAY_HINT_HEADERS
// when set, otherwise a server-side flag that defaults to false. With the variable set to 1
// the next live probe's receipt carried `"requestClass":"main"`. So the router asks for the
// hints itself, and because it asked, it also consumes them: none of the four hint headers is
// forwarded to a provider, so what Anthropic or clodex receives does not grow by this change.

const HINTS = ["x-claude-code-request-class", "x-claude-1p-request-class", "x-claude-code-agent-type", "x-claude-code-prompt-id"];

describe("gateway hint headers", () => {
    it("the launcher asks Claude Code for the hints, whatever the operator's shell says", () => {
        const nonce = "n".repeat(43);
        strictEqual(claudeRouterEnvironment("http://127.0.0.1:1", nonce, {})["CLAUDE_CODE_GATEWAY_HINT_HEADERS"], "1");
        strictEqual(claudeRouterEnvironment("http://127.0.0.1:1", nonce, { CLAUDE_CODE_GATEWAY_HINT_HEADERS: "0" })["CLAUDE_CODE_GATEWAY_HINT_HEADERS"], "1");
    });

    it("the closed list is the four headers the binary gates behind that switch", () => {
        deepStrictEqual([...GATEWAY_HINT_HEADERS].sort(), [...HINTS].sort());
    });

    for (const allowProviderAuth of [true, false]) {
        it(`none of the hints is forwarded upstream (allowProviderAuth=${allowProviderAuth})`, () => {
            const source = new Headers({
                "anthropic-version": "2023-06-01",
                "x-claude-code-agent-id": "agent-1",
                "X-Claude-Code-Request-Class": "subagent",
                "x-claude-1p-request-class": "blocking-subagent",
                "x-claude-code-agent-type": "general-purpose",
                "x-claude-code-prompt-id": "p-1",
            });
            const forwarded = upstreamRequestHeaders(source, allowProviderAuth);
            for (const hint of HINTS)
                strictEqual(forwarded.has(hint), false, hint);
            strictEqual(forwarded.get("anthropic-version"), "2023-06-01");
        });
    }

    it("NEGATIVE: headers the switch does not gate still cross, including the agent id", () => {
        const source = new Headers({
            "x-claude-code-agent-id": "agent-1",
            "x-claude-code-parent-agent-id": "agent-0",
            "x-claude-code-auxiliary-type": "title",
            "x-claude-code-request-classifier": "not-a-hint",
            "anthropic-beta": "some-beta",
        });
        const forwarded = upstreamRequestHeaders(source, true);
        deepStrictEqual([...forwarded.keys()].sort(), ["anthropic-beta", "x-claude-code-agent-id", "x-claude-code-auxiliary-type", "x-claude-code-parent-agent-id", "x-claude-code-request-classifier"]);
    });
});
