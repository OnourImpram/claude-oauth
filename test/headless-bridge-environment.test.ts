import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAntigravityHeadless, type HeadlessProcessRequest } from "../src/antigravity/headless-bridge.js";

// agy'ye giden ortam. 2026-09-05: agy her print baslatilisinda arka planda kendini guncelliyor ve
// civi (install-lock antigravity.sha256) dusuyordu; IsReadOnly bayragi yeniden-adlandirmayi
// durdurmaz. Olculen calisan onlem AGY_CLI_DISABLE_AUTO_UPDATE="true" (deger "1" ISE YARAMAZ --
// deneyde "1" ile guncelledi). Bu test o degiskenin agy surecine TAM DEGERIYLE ulastigini sinar;
// negatif kol: degisken yanlis degerle ya da hic konmadiginda test kirmizi olur.
async function agyOrtami(source: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const home = mkdtempSync(join(tmpdir(), "agy-env-"));
    let seen: HeadlessProcessRequest | undefined;
    try {
        const result = await runAntigravityHeadless({
            binary: "agy.exe",
            cwd: home,
            prompt: "Reply with exactly: OK",
            model: "gemini-3.8-flash-high",
            home,
            environment: source,
            processRunner: async (request) => {
                seen = request;
                // agy stream-json: tek satirlik NDJSON, terminal "result" olayi (parseResponse'un bekledigi sekil)
                return { exitCode: 0, stdout: JSON.stringify({ event: "result", result: { status: "success", response: "OK" } }) + "\n", stderr: "" };
            },
        });
        strictEqual(result.response, "OK");
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
    if (seen === undefined)
        throw new Error("sahte kosucu hic cagrilmadi");
    return seen.environment;
}

describe("antigravity surec ortami", () => {
    it("AGY_CLI_DISABLE_AUTO_UPDATE agy'ye TAM olarak \"true\" degeriyle gider", async () => {
        const environment = await agyOrtami({ PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\test" });
        strictEqual(environment["AGY_CLI_DISABLE_AUTO_UPDATE"], "true");
        strictEqual(environment["AGY_CLI_HIDE_ACCOUNT_INFO"], "1");
    });
    it("kaynak ortamdaki yanlis deger (\"1\" / \"0\") EZILIR -- guncelleyici yine kapali", async () => {
        for (const kotu of ["1", "0", "false", ""]) {
            const environment = await agyOrtami({ PATH: "C:\\Windows", AGY_CLI_DISABLE_AUTO_UPDATE: kotu });
            strictEqual(environment["AGY_CLI_DISABLE_AUTO_UPDATE"], "true", `kaynak deger ${JSON.stringify(kotu)} ezilmedi`);
        }
    });
    it("negatif kol: degisken listesi kendi adiyla dogrulanir (yanlis ad gecmez)", async () => {
        const environment = await agyOrtami({ PATH: "C:\\Windows" });
        deepStrictEqual(Object.keys(environment).filter((key) => /AUTO_UPDATE/u.test(key)), ["AGY_CLI_DISABLE_AUTO_UPDATE"]);
    });
});
