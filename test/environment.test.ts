import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNoApiKeySelectors, presentApiKeySelectors, sanitizedClaudeEnvironment, sanitizedWorkerEnvironment } from "../src/security/environment.js";

// Bu sistem OAuth-only'dir: hicbir saglayici icin API-key yedegi YOKTUR. Bir anahtar
// secicisi ortamda kalirsa, kullanici OAuth kullandigini sanirken sessizce anahtarla
// faturalanabilir. Bu yuzden secici tespiti hem RAPORLANIR hem de is parcaciklarina
// gecen ortamdan SILINIR -- ikisi ayri kontroldur.

describe("presentApiKeySelectors", () => {
    it("temiz ortamda hicbir sey bildirmez", () => {
        deepStrictEqual(presentApiKeySelectors({ PATH: "/usr/bin", HOME: "/home/x" }), []);
    });

    it("saglayici anahtarlarini yakalar", () => {
        const found = presentApiKeySelectors({ ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" });
        strictEqual(found.includes("ANTHROPIC_API_KEY"), true);
        strictEqual(found.includes("OPENAI_API_KEY"), true);
    });

    it("BOS ve yalniz-bosluk degerleri secici saymaz", () => {
        deepStrictEqual(presentApiKeySelectors({ ANTHROPIC_API_KEY: "" }), []);
        deepStrictEqual(presentApiKeySelectors({ ANTHROPIC_API_KEY: "   " }), []);
    });

    it("sonucu siralar ve tekrar etmez", () => {
        const found = presentApiKeySelectors({ OPENAI_API_KEY: "y", ANTHROPIC_API_KEY: "x" });
        deepStrictEqual([...found], [...found].sort());
        strictEqual(new Set(found).size, found.length);
    });
});

describe("assertNoApiKeySelectors", () => {
    it("temiz ortamda sessizce gecer", () => {
        assertNoApiKeySelectors({ PATH: "/usr/bin" });
    });

    it("secici varsa firlatir ve ADINI soyler, DEGERINI degil", () => {
        throws(
            () => { assertNoApiKeySelectors({ ANTHROPIC_API_KEY: "sk-gizli-deger-buraya" }); },
            (error: unknown) => {
                const message = (error as Error).message;
                strictEqual(message.includes("ANTHROPIC_API_KEY"), true);
                strictEqual(message.includes("sk-gizli-deger-buraya"), false);
                return true;
            },
        );
    });
});

describe("sanitizedWorkerEnvironment", () => {
    it("GEMINI_MODEL'i siler (agy varsayilan modelini operator ortami secmesin)", () => {
        const cleaned = sanitizedWorkerEnvironment("gemini", { GEMINI_MODEL: "gemini-3.7-flash", PATH: "/usr/bin" });
        strictEqual(cleaned["GEMINI_MODEL"], undefined);
        strictEqual(cleaned["PATH"], "/usr/bin");
    });
    it("ANTHROPIC_BASE_URL'i siler", () => {
        // Bu degisken bu oturumda GERCEKTEN sorun cikardi: Claude Code'un kendi surecinden
        // miras alinip antigravity probunu OAuth-only kontrolunde dusurdu.
        const cleaned = sanitizedWorkerEnvironment("openai", { ANTHROPIC_BASE_URL: "https://ornek", PATH: "/usr/bin" });
        strictEqual(cleaned["ANTHROPIC_BASE_URL"], undefined);
        strictEqual(cleaned["PATH"], "/usr/bin");
    });

    it("saglayici anahtarlarini siler", () => {
        const cleaned = sanitizedWorkerEnvironment("openai", { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y", PATH: "/usr/bin" });
        deepStrictEqual(presentApiKeySelectors(cleaned), []);
    });

    it("cikti ortaminda hicbir secici KALMAZ (temizlemenin kendi kontrolu)", () => {
        const dirty: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b", PATH: "/usr/bin" };
        for (const provider of ["anthropic", "openai", "xai", "google", "gemini"] as const) {
            deepStrictEqual(presentApiKeySelectors(sanitizedWorkerEnvironment(provider, dirty)), [], provider);
        }
    });

    it("kaynak ortami DEGISTIRMEZ (kopya uzerinde calisir)", () => {
        const source: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "x" };
        sanitizedWorkerEnvironment("openai", source);
        strictEqual(source["ANTHROPIC_API_KEY"], "x");
    });

    // clodex 2.11.1 ile gelen uc yeni override (olculdu 2026-09-05: 2.8.2 bundle'inda
    // 0 gecis, 2.11.1'de 1'er gecis). Silme listesine yeni surumle birlikte eklenmezse
    // is oturumundan sessizce miras alinirlar; "hijyenik ortam" iddiasi olcusuz kalir.
    it("clodex 2.11.1'in yeni CLODEX_* override'larini siler", () => {
        const cleaned = sanitizedWorkerEnvironment("openai", {
            CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: "1",
            CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: "2",
            CLODEX_WS_MAX_NEW_CONNECTIONS_PER_MIN: "3",
            CLODEX_UPSTREAM_MAX_RETRIES: "4",
            PATH: "/usr/bin",
        });
        strictEqual(cleaned["CLODEX_UPSTREAM_IDLE_TIMEOUT_MS"], undefined);
        strictEqual(cleaned["CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS"], undefined);
        strictEqual(cleaned["CLODEX_WS_MAX_NEW_CONNECTIONS_PER_MIN"], undefined);
        strictEqual(cleaned["CLODEX_UPSTREAM_MAX_RETRIES"], undefined);
        // NEGATIF KOL: temizleyici "CLODEX_ ile baslayani sil" degildir -- CLODEX_HOME
        // kapsulun calismasi icin GEREKLI ve silinirse saglayici hic acilmaz.
        strictEqual(cleaned["PATH"], "/usr/bin");
    });

    it("CLODEX_HOME'u silmez (kapsul onsuz calismaz)", () => {
        const cleaned = sanitizedWorkerEnvironment("openai", { CLODEX_HOME: "C:/home", PATH: "/usr/bin" });
        strictEqual(cleaned["CLODEX_HOME"], "C:/home");
    });

    it("launcher meta degiskenlerini alt surece sizdirmaz", () => {
        const cleaned = sanitizedWorkerEnvironment("openai", {
            HEZARFEN_CLAUDE_OAUTH_RELEASE_ID: "router-v3-AAAAAAAAAAAA-BBBBBBBBBBBB",
            HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE: "embedded-release",
        });
        strictEqual(cleaned["HEZARFEN_CLAUDE_OAUTH_RELEASE_ID"], undefined);
        strictEqual(cleaned["HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE"], undefined);
    });
});

describe("sanitizedClaudeEnvironment", () => {
    it("Claude alt surecine de secici gecirmez", () => {
        deepStrictEqual(presentApiKeySelectors(sanitizedClaudeEnvironment({ ANTHROPIC_API_KEY: "x", PATH: "/usr/bin" })), []);
    });
});
