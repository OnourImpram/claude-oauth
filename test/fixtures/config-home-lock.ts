import { ok, rejects, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createEphemeralConfigHome, sweepStaleConfigHomes } from "../../src/antigravity/config-home.js";

// Run outside node:test so cleanup warnings reach an isolated real router.log.
const root = process.env["LOCALAPPDATA"];
const mode = process.argv[2];
ok(root !== undefined);
ok(mode === "dispose" || mode === "sweep" || mode === "retry-dispose" || mode === "retry-sweep");
strictEqual(process.env["NODE_TEST_CONTEXT"], undefined);
const homes = join(root, "homes");
const source = join(root, "source");
await mkdir(source);
await mkdir(join(root, "Hezarfen", "claude-oauth"), { recursive: true });
const home = await createEphemeralConfigHome({ root: homes, sourceHome: source });
const config = join(home.path, ".gemini", "config", "mcp_config.json");
const release = await lockFile(config);
try {
    // Positive control: the real file is locked; failure here belongs to the fixture.
    await rejects(rm(config), (error: NodeJS.ErrnoException) => error.code === "EPERM" || error.code === "EBUSY");
    const sweep = () => sweepStaleConfigHomes({ root: homes, isProcessAlive: () => false, staleAfterMs: 0 });
    if (mode === "dispose") {
        await home.dispose();
        ok((await stat(config)).isFile(), "dispose cannot remove a FileShare.None locked file");
        assertSafeWarning(await readFile(join(root, "Hezarfen", "claude-oauth", "router.log"), "utf8"));
        await release();
        await home.dispose();
        await rejects(stat(home.path), { code: "ENOENT" }, "a failed dispose must allow a second call after unlock");
        await home.dispose();
    }
    else if (mode === "sweep") {
        const unlocked = await createEphemeralConfigHome({ root: homes, sourceHome: source });
        const outcome = await sweep();
        strictEqual(outcome.removed.includes(home.path), false, "failed removal must not inflate the removed count");
        strictEqual(outcome.kept.includes(home.path), true, "failed removal belongs in kept");
        strictEqual(outcome.removed.includes(unlocked.path), true, "an unlocked orphan must still be removed");
        strictEqual(outcome.kept.includes(unlocked.path), false);
        ok((await stat(config)).isFile());
        await rejects(stat(unlocked.path), { code: "ENOENT" });
        assertSafeWarning(await readFile(join(root, "Hezarfen", "claude-oauth", "router.log"), "utf8"));
        await release();
        const retried = await sweep();
        strictEqual(retried.removed.includes(home.path), true);
        strictEqual(retried.kept.includes(home.path), false);
        await rejects(stat(home.path), { code: "ENOENT" });
    }
    else {
        let released = false;
        let settledBeforeRelease = false;
        const cleanup = (mode === "retry-dispose" ? home.dispose() : sweep()).then((outcome) => {
            settledBeforeRelease = !released;
            return outcome;
        });
        // Keep the lock across the first failed attempts, then release while rm retries.
        await delay(500);
        released = true;
        await release();
        const outcome = await cleanup;
        strictEqual(settledBeforeRelease, false, "cleanup must retry a transient lock rather than return early");
        if (outcome !== undefined) {
            strictEqual(outcome.removed.includes(home.path), true);
            strictEqual(outcome.kept.includes(home.path), false);
        }
        await rejects(stat(home.path), { code: "ENOENT" }, "one cleanup call must recover after the lock releases");
        await rejects(stat(join(root, "Hezarfen", "claude-oauth", "router.log")), { code: "ENOENT" }, "successful retries must not emit failure warnings");
    }
    process.stdout.write("cleanup verified\n");
}
finally {
    await release();
}

function assertSafeWarning(raw: string): void {
    const rows = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    strictEqual(rows.length, 1);
    const warning = rows[0];
    ok(warning !== undefined);
    strictEqual(warning["event"], "antigravity_config_home_cleanup_failed");
    strictEqual(warning["level"], "warn");
    strictEqual(typeof warning["timestamp"], "string");
    strictEqual(Object.keys(warning).sort().join(","), "event,level,timestamp", "no path, exception message, or credential may enter the warning");
}

async function lockFile(path: string): Promise<() => Promise<void>> {
    const script = fileURLToPath(new URL("../../../test/fixtures/config-home-lock.ps1", import.meta.url));
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-LockPath", path], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
    });
    // Install lifecycle handlers immediately; startup failures never leave an unhandled event.
    const closed = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
    let released = false;
    const release = async (): Promise<void> => {
        if (released)
            return;
        released = true;
        if (child.exitCode === null && child.signalCode === null)
            child.stdin.end("\n");
        const deadline = setTimeout(() => { child.kill(); }, 2_000);
        try { await closed; }
        finally { clearTimeout(deadline); }
    };
    try {
        await new Promise<void>((resolve, reject) => {
            let output = "";
            const deadline = setTimeout(() => reject(new Error("lock fixture readiness timeout")), 5_000);
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
                output += chunk;
                if (output.includes("ready")) {
                    clearTimeout(deadline);
                    resolve();
                }
            });
            child.once("error", () => {
                clearTimeout(deadline);
                reject(new Error("lock fixture spawn failed"));
            });
            child.once("close", () => {
                clearTimeout(deadline);
                reject(new Error("lock fixture exited before readiness"));
            });
        });
    }
    catch (error) {
        await release();
        throw error;
    }
    return release;
}
