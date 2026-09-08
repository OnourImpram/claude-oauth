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

const MISSING = join("C:", "hezarfen-boyle-bir-ikili-yok", "hayalet.exe");

describe("spawnFailureGuard", () => {
    it("var olmayan bir ikili suereci DUSURMEZ, hatayi yakalar", async () => {
        const child = spawn(MISSING, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        const failure = spawnFailureGuard(child);
        await new Promise<void>((resolveWait) => { child.once("close", () => { resolveWait(); }); });
        const captured = failure();
        notStrictEqual(captured, undefined);
        strictEqual(captured?.code, "ENOENT");
    });

    it("dinleyici olmadan ayni spawn yakalanamayan 'error' uretir (negatif kontrol)", async () => {
        const child = spawn(MISSING, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        // Without the guard nobody listens to this event and Node would drop the process.
        // Here we listen deliberately and prove the event is REALLY emitted -- so what the
        // guard protects against is not imaginary.
        const emitted = await new Promise<NodeJS.ErrnoException>((resolveWait) => {
            child.once("error", (error) => { resolveWait(error as NodeJS.ErrnoException); });
        });
        strictEqual(emitted.code, "ENOENT");
    });

    it("basarili spawn'da hicbir hata bildirmez", async () => {
        const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["ignore", "pipe", "pipe"] });
        const failure = spawnFailureGuard(child);
        const code = await new Promise<number | null>((resolveWait) => {
            child.once("exit", (exitCode) => { resolveWait(exitCode); });
        });
        strictEqual(code, 0);
        strictEqual(failure(), undefined);
    });

    it("okuyucu her cagrildiginda ayni sonucu verir (durum saklar, tuketmez)", async () => {
        const child = spawn(MISSING, [], { stdio: ["ignore", "pipe", "pipe"] });
        const failure = spawnFailureGuard(child);
        await new Promise<void>((resolveWait) => { child.once("close", () => { resolveWait(); }); });
        strictEqual(failure()?.code, "ENOENT");
        strictEqual(failure()?.code, "ENOENT");
    });
});
