import { strictEqual, notStrictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnFailureGuard } from "../src/runtime/child-process.js";

// REGRESYON: `models refresh`, kurulu OLMAYAN grok.exe'yi spawn edince tum SUREC coktu.
// Spawn hatasi asenkron bir 'error' olayidir; dinleyicisi yoksa Node onu yakalanamayan
// hataya cevirir ve await/try/catch bunu goremez. Sonuc: kurulu olmayan tek bir istege
// bagli saglayici, calisan saglayicilarin snapshot'a yazilmasini da engelliyordu.

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
        // Muhafiz olmadan bu olayi kimse dinlemez ve Node sureci dusururdu. Burada
        // bilerek dinleyip, olayin GERCEKTEN uretildigini kanitliyoruz -- yani muhafizin
        // korudugu sey hayali degil.
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
