import { strictEqual, notStrictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnFailureGuard } from "../src/runtime/child-process.js";

// REGRESSION: `models refresh` brought down the WHOLE PROCESS when it spawned a grok.exe
// that was NOT installed. A spawn failure is an asynchronous 'error' event; with no
// listener Node turns it into an uncaught exception, and await/try/catch cannot see it.
// Result: a single provider tied to a request that was not installed also blocked the
// working providers from being written to the snapshot.

const MISSING = join("C:", "hezarfen-no-such-binary", "ghost.exe");

describe("spawnFailureGuard", () => {
    it("a missing binary DOES NOT CRASH the process; its error is captured", async () => {
        const child = spawn(MISSING, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        const failure = spawnFailureGuard(child);
        await new Promise<void>((resolveWait) => { child.once("close", () => { resolveWait(); }); });
        const captured = failure();
        notStrictEqual(captured, undefined);
        strictEqual(captured?.code, "ENOENT");
    });

    it("without the listener the same spawn produces an uncatchable 'error' (negative control)", async () => {
        const child = spawn(MISSING, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        // Without the guard nobody listens to this event and Node would drop the process.
        // Here we listen deliberately and prove the event is REALLY emitted -- so what the
        // guard protects against is not imaginary.
        const emitted = await new Promise<NodeJS.ErrnoException>((resolveWait) => {
            child.once("error", (error) => { resolveWait(error as NodeJS.ErrnoException); });
        });
        strictEqual(emitted.code, "ENOENT");
    });

    it("reports no error for a successful spawn", async () => {
        const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["ignore", "pipe", "pipe"] });
        const failure = spawnFailureGuard(child);
        const code = await new Promise<number | null>((resolveWait) => {
            child.once("exit", (exitCode) => { resolveWait(exitCode); });
        });
        strictEqual(code, 0);
        strictEqual(failure(), undefined);
    });

    it("the reader returns the same result on every call (retains state without consuming it)", async () => {
        const child = spawn(MISSING, [], { stdio: ["ignore", "pipe", "pipe"] });
        const failure = spawnFailureGuard(child);
        await new Promise<void>((resolveWait) => { child.once("close", () => { resolveWait(); }); });
        strictEqual(failure()?.code, "ENOENT");
        strictEqual(failure()?.code, "ENOENT");
    });
});
