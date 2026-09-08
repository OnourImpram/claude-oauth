import { deepStrictEqual, ok, rejects, strictEqual, notStrictEqual } from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCaptured, spawnFailureGuard } from "../src/runtime/child-process.js";

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

describe("runCaptured timeout", () => {
    it("captures a normal child's output and exit code", async () => {
        deepStrictEqual(await runCaptured(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7;"], {
            cwd: process.cwd(), environment: process.env, timeoutMs: 5_000,
        }), { exitCode: 7, stdout: "out", stderr: "err" });
    });

    it("bounds a SIGTERM-resistant child (Linux arm meaningful, Windows kill is terminal)", async (t) => {
        await using scratch = await mkdtempDisposable(join(tmpdir(), "captured-timeout-"));
        const timeoutMs = 1_000;
        const terminationGraceMs = 100;
        const margin = 2_000;
        const script = "const fs = require('node:fs'); process.on('SIGTERM', () => fs.writeFileSync('term', 'handled')); fs.writeFileSync('ready', String(process.pid)); setInterval(() => {}, 100);";
        const started = performance.now();
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        try {
            const options = { cwd: scratch.path, environment: process.env, timeoutMs, terminationGraceMs };
            await rejects(Promise.race([
                runCaptured(process.execPath, ["-e", script], options),
                new Promise<never>((_, rejectWait) => {
                    watchdog = setTimeout(() => rejectWait(new Error("timeout did not settle")), timeoutMs + terminationGraceMs + margin);
                }),
            ]), { code: "upstream_timeout", status: 504 });
            const elapsed = performance.now() - started;
            ok(elapsed < timeoutMs + terminationGraceMs + margin, `settled after ${elapsed} ms`);
            ok(Number(await readFile(join(scratch.path, "ready"), "utf8")) > 0, "child installed its handler before the deadline");
            if (process.platform !== "win32") strictEqual(await readFile(join(scratch.path, "term"), "utf8"), "handled");
            t.diagnostic(`platform=${process.platform}, timeout=${timeoutMs} ms, grace=${terminationGraceMs} ms, elapsed=${elapsed.toFixed(1)} ms`);
        }
        finally {
            clearTimeout(watchdog);
            // The reproduction must also clean up when run against the original hanging code.
            const pid = await readFile(join(scratch.path, "ready"), "utf8").catch(() => undefined);
            if (pid !== undefined) {
                try { process.kill(Number(pid), "SIGKILL"); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            }
        }
    });

    for (const failure of ["returns false", "emits error", "throws"] as const) {
        it(`rejects at the deadline even when kill ${failure} and no exit event arrives`, async (t) => {
            const children = new Set<ChildProcess>();
            const signals: (NodeJS.Signals | number | undefined)[] = [];
            const originalKill = ChildProcess.prototype.kill;
            t.mock.method(ChildProcess.prototype, "kill", function (this: ChildProcess, signal?: NodeJS.Signals | number): boolean {
                children.add(this);
                signals.push(signal ?? "SIGTERM");
                if (failure === "emits error") this.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
                if (failure === "throws") throw new Error("kill failed");
                return false;
            });
            const options = { cwd: process.cwd(), environment: process.env, timeoutMs: 50, terminationGraceMs: 50 };
            let watchdog: ReturnType<typeof setTimeout> | undefined;
            try {
                await rejects(Promise.race([
                    runCaptured(process.execPath, ["-e", "setInterval(() => {}, 100)"], options),
                    new Promise<never>((_, rejectWait) => {
                        watchdog = setTimeout(() => rejectWait(new Error("timeout did not settle without exit")), 1_000);
                    }),
                ]), { code: "upstream_timeout", status: 504 });
                deepStrictEqual(signals, ["SIGTERM", "SIGKILL"]);
                for (const child of children) {
                    strictEqual(child.stdout?.destroyed, true);
                    strictEqual(child.stderr?.destroyed, true);
                }
            }
            finally {
                clearTimeout(watchdog);
                t.mock.restoreAll();
                for (const child of children) originalKill.call(child, "SIGKILL");
            }
        });
    }
});
