import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isNativeClaudeCommand, publicEntrypoint, resolveEntrypoint } from "../src/cli-routing.js";

// REGRESYON: claude.cmd / claude.ps1 giris noktasini `--hezarfen-entrypoint=claude` olarak
// bildiriyordu ama onu ayristiran hicbir sey yoktu ve ortam degiskenini set eden de yoktu.
// publicEntrypoint her zaman "oauth" donuyor, launchClaudeOAuth HIC cagrilmiyordu -- yani
// sistemin butun amaci olan kod yolu `claude` komutundan ulasilamazdi.
describe("resolveEntrypoint", () => {
    it("shim'in bayragini claude giris noktasi olarak okur ve args'tan ayiklar", () => {
        const resolved = resolveEntrypoint(["--hezarfen-entrypoint=claude", "--model", "sol"], {});
        strictEqual(resolved.entrypoint, "claude");
        deepStrictEqual([...resolved.args], ["--model", "sol"]);
    });

    it("ortam degiskeni kanalini da onurlandirir", () => {
        const resolved = resolveEntrypoint(["--model", "terra"], { HEZARFEN_CLAUDE_OAUTH_ENTRYPOINT: "claude" });
        strictEqual(resolved.entrypoint, "claude");
        deepStrictEqual([...resolved.args], ["--model", "terra"]);
    });

    it("bayrak da degisken de yoksa oauth'ta kalir", () => {
        const resolved = resolveEntrypoint(["doctor"], {});
        strictEqual(resolved.entrypoint, "oauth");
        deepStrictEqual([...resolved.args], ["doctor"]);
    });

    it("bayrak claude disinda bir deger tasiyorsa claude'a gecmez", () => {
        strictEqual(resolveEntrypoint(["--hezarfen-entrypoint=oauth"], {}).entrypoint, "oauth");
        strictEqual(resolveEntrypoint(["--hezarfen-entrypoint=whatever"], {}).entrypoint, "oauth");
    });

    it("bayragi YALNIZ ilk konumda okur; sonraki konumdaki bir metni komut sanmaz", () => {
        const resolved = resolveEntrypoint(["--print", "--hezarfen-entrypoint=claude"], {});
        strictEqual(resolved.entrypoint, "oauth");
        deepStrictEqual([...resolved.args], ["--print", "--hezarfen-entrypoint=claude"]);
    });

    it("bos argv listesinde cokmez", () => {
        const resolved = resolveEntrypoint([], {});
        strictEqual(resolved.entrypoint, "oauth");
        deepStrictEqual([...resolved.args], []);
    });

    it("argv bayragi ortam degiskenini gecersiz kilar", () => {
        const resolved = resolveEntrypoint(["--hezarfen-entrypoint=oauth"], { HEZARFEN_CLAUDE_OAUTH_ENTRYPOINT: "claude" });
        strictEqual(resolved.entrypoint, "oauth");
    });
});

describe("publicEntrypoint", () => {
    it("yalnizca tam 'claude' degerini kabul eder", () => {
        strictEqual(publicEntrypoint({ HEZARFEN_CLAUDE_OAUTH_ENTRYPOINT: "claude" }), "claude");
        strictEqual(publicEntrypoint({ HEZARFEN_CLAUDE_OAUTH_ENTRYPOINT: "Claude" }), "oauth");
        strictEqual(publicEntrypoint({ HEZARFEN_CLAUDE_OAUTH_ENTRYPOINT: "" }), "oauth");
        strictEqual(publicEntrypoint({}), "oauth");
    });
});

describe("isNativeClaudeCommand", () => {
    it("native'e devredilmesi gereken komutlari tanir", () => {
        for (const command of ["auth", "mcp", "update", "plugin", "doctor", "--version", "--help", "-h", "-v", "help"]) {
            strictEqual(isNativeClaudeCommand([command]), true, command);
        }
    });

    it("router'in kendi calistirmasi gereken cagrilari native saymaz", () => {
        for (const argumentList of [[], ["--model", "sol"], ["--print", "merhaba"], ["-p", "x"]]) {
            strictEqual(isNativeClaudeCommand(argumentList), false, JSON.stringify(argumentList));
        }
    });

    it("native komut yalniz ILK konumda gecerlidir", () => {
        strictEqual(isNativeClaudeCommand(["--print", "auth"]), false);
    });
});
