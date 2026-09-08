import { ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

// P01 (2026-09-08, measured on WSL2): with the native binary absent, `doctor` died in the
// `claude auth status` probe (spawn error) after the install check had already reported the
// component as missing. Doctor must finish and name the missing component. This arm runs on
// every platform: an empty profile directory makes every locked path point at nothing.
describe("doctor with the native binary missing", () => {
    let profile = "";
    before(async () => { profile = await mkdtemp(join(tmpdir(), "claude-oauth-doctor-")); });
    after(async () => { await rm(profile, { recursive: true, force: true }); });
    it("finishes with a component report instead of a fatal", async () => {
        const cli = resolve("dist", "src", "cli.js");
        const environment = { ...process.env, USERPROFILE: profile, LOCALAPPDATA: join(profile, "local"), APPDATA: join(profile, "roaming"), HOME: profile, XDG_DATA_HOME: join(profile, "local"), XDG_CONFIG_HOME: join(profile, "roaming") };
        const child = spawn(process.execPath, [cli, "doctor"], { env: environment, cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        const code = await new Promise<number>((resolveCode, rejectCode) => {
            child.once("error", rejectCode);
            child.once("close", (value) => resolveCode(value ?? -1));
        });
        const combined = `${stdout}\n${stderr}`;
        strictEqual(combined.includes("cli_fatal"), false, `doctor died: ${combined.slice(0, 400)}`);
        ok(/"component":\s*"claude"/u.test(combined), "the claude component is reported");
        ok(/"locked_binary_missing"/u.test(combined), "the missing binary is named by its detail code");
        // 0 = ok, 2 = components not ready (the verdict this arm expects); -1 = no exit at all.
        ok(code === 0 || code === 2, `doctor exits with a verdict, got ${code}`);
    });
});
