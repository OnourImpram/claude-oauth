import { strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { expandLockedPath } from "../src/runtime/install-lock.js";

// P01 (2026-09-08, WSL2): the lock names Windows variables; on POSIX `doctor` died in
// expandLockedPath before reporting any component. The POSIX arm below was red before
// the repair (RouterError "Required path environment variable USERPROFILE is unavailable").
describe("expandLockedPath on POSIX", () => {
    const home = { HOME: "/home/user" };
    it("maps %USERPROFILE% to HOME and converts separators", () => {
        strictEqual(expandLockedPath("%USERPROFILE%\\.local\\bin\\claude.exe", home, "linux"), "/home/user/.local/bin/claude.exe");
    });
    it("maps %LOCALAPPDATA% to XDG_DATA_HOME when set, else ~/.local/share", () => {
        strictEqual(expandLockedPath("%LOCALAPPDATA%\\Hezarfen\\claude-oauth\\providers\\grok\\bin\\grok.exe", { ...home, XDG_DATA_HOME: "/data" }, "linux"), "/data/Hezarfen/claude-oauth/providers/grok/bin/grok.exe");
        strictEqual(expandLockedPath("%LOCALAPPDATA%\\Hezarfen\\x", home, "linux"), "/home/user/.local/share/Hezarfen/x");
    });
    it("maps %APPDATA% to XDG_CONFIG_HOME when set, else ~/.config", () => {
        strictEqual(expandLockedPath("%APPDATA%\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js", { ...home, XDG_CONFIG_HOME: "/cfg" }, "linux"), "/cfg/npm/node_modules/@google/gemini-cli/bundle/gemini.js");
        strictEqual(expandLockedPath("%APPDATA%\\npm", home, "linux"), "/home/user/.config/npm");
    });
    it("prefers an explicitly set Windows variable over the POSIX mapping", () => {
        strictEqual(expandLockedPath("%USERPROFILE%\\a", { ...home, USERPROFILE: "/mnt/c/Users/x" }, "linux"), "/mnt/c/Users/x/a");
    });
    it("still fails when neither the variable nor HOME exists", () => {
        throws(() => expandLockedPath("%USERPROFILE%\\a", {}, "linux"), /USERPROFILE is unavailable/u);
    });
    it("negative arm: on win32 the POSIX mapping is not applied", () => {
        throws(() => expandLockedPath("%USERPROFILE%\\a", home, "win32"), /USERPROFILE is unavailable/u);
    });
});
