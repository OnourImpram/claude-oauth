import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isNativeClaudeCommand, publicEntrypoint, resolveEntrypoint } from "../src/cli-routing.js";

// REGRESSION: claude.cmd / claude.ps1 declared their entrypoint as
// `--hezarfen-entrypoint=claude`, but nothing parsed that flag and nothing set the
// environment variable either. publicEntrypoint always returned "oauth" and
// launchClaudeOAuth was NEVER called -- meaning the code path that is the whole point of
// the system was unreachable from the `claude` command.
describe("resolveEntrypoint", () => {
    it("reads the shim's flag as the claude entrypoint and removes it from args", () => {
        const resolved = resolveEntrypoint(["--hezarfen-entrypoint=claude", "--model", "sol"], {});
        strictEqual(resolved.entrypoint, "claude");
        deepStrictEqual([...resolved.args], ["--model", "sol"]);
    });

    it("also honors the environment-variable channel", () => {
        const resolved = resolveEntrypoint(["--model", "terra"], { HEZARFEN_CLAUDE_OAUTH_ENTRYPOINT: "claude" });
        strictEqual(resolved.entrypoint, "claude");
        deepStrictEqual([...resolved.args], ["--model", "terra"]);
    });

    it("stays on oauth when neither the flag nor the variable is present", () => {
        const resolved = resolveEntrypoint(["doctor"], {});
        strictEqual(resolved.entrypoint, "oauth");
        deepStrictEqual([...resolved.args], ["doctor"]);
    });

    it("does not switch to claude when the flag carries a different value", () => {
        strictEqual(resolveEntrypoint(["--hezarfen-entrypoint=oauth"], {}).entrypoint, "oauth");
        strictEqual(resolveEntrypoint(["--hezarfen-entrypoint=whatever"], {}).entrypoint, "oauth");
    });

    it("reads the flag ONLY in the first position; does not mistake later text for a command", () => {
        const resolved = resolveEntrypoint(["--print", "--hezarfen-entrypoint=claude"], {});
        strictEqual(resolved.entrypoint, "oauth");
        deepStrictEqual([...resolved.args], ["--print", "--hezarfen-entrypoint=claude"]);
    });

    it("does not crash on an empty argv list", () => {
        const resolved = resolveEntrypoint([], {});
        strictEqual(resolved.entrypoint, "oauth");
        deepStrictEqual([...resolved.args], []);
    });

    it("the argv flag overrides the environment variable", () => {
        const resolved = resolveEntrypoint(["--hezarfen-entrypoint=oauth"], { HEZARFEN_CLAUDE_OAUTH_ENTRYPOINT: "claude" });
        strictEqual(resolved.entrypoint, "oauth");
    });
});

describe("publicEntrypoint", () => {
    it("accepts only the exact value 'claude'", () => {
        strictEqual(publicEntrypoint({ HEZARFEN_CLAUDE_OAUTH_ENTRYPOINT: "claude" }), "claude");
        strictEqual(publicEntrypoint({ HEZARFEN_CLAUDE_OAUTH_ENTRYPOINT: "Claude" }), "oauth");
        strictEqual(publicEntrypoint({ HEZARFEN_CLAUDE_OAUTH_ENTRYPOINT: "" }), "oauth");
        strictEqual(publicEntrypoint({}), "oauth");
    });
});

describe("isNativeClaudeCommand", () => {
    it("recognizes commands that must be handed off to native", () => {
        for (const command of ["auth", "mcp", "update", "plugin", "doctor", "--version", "--help", "-h", "-v", "help"]) {
            strictEqual(isNativeClaudeCommand([command]), true, command);
        }
    });

    it("does not classify calls the router must run itself as native", () => {
        for (const argumentList of [[], ["--model", "sol"], ["--print", "hello"], ["-p", "x"]]) {
            strictEqual(isNativeClaudeCommand(argumentList), false, JSON.stringify(argumentList));
        }
    });

    it("a native command is valid only in the FIRST position", () => {
        strictEqual(isNativeClaudeCommand(["--print", "auth"]), false);
    });
});
