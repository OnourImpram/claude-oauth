import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeOAuthAgentArguments, claudePatchedModelArguments, claudeRouterEnvironment } from "../src/supervisor/launcher.js";
import { presentApiKeySelectors } from "../src/security/environment.js";

// Alt-ajan delegasyonu (sol-delege, terra-delege, gemini-delege) --agents enjeksiyonuyla
// calisir. Bu fonksiyonlar kullanicinin argumanlarini YENIDEN YAZAR; sessiz bir hata
// burada ya delegasyonu oldurur ya da kullanicinin kendi ajan tanimlarini ezer.

const AVAILABLE = ["anthropic-openai-gpt-5.6-sol", "anthropic-openai-gpt-5.6-terra", "anthropic-google-gemini-3.8-flash-high"];

describe("claudePatchedModelArguments", () => {
    it("--model degerini yamali alias'a cevirir", () => {
        const rewritten = claudePatchedModelArguments(["--model", "sol"]);
        strictEqual(rewritten.length, 2);
        strictEqual(rewritten[0], "--model");
    });

    it("--model=deger bicimini de cevirir", () => {
        const rewritten = claudePatchedModelArguments(["--model=sol"]);
        strictEqual(rewritten.length, 1);
        strictEqual(rewritten[0]?.startsWith("--model="), true);
    });

    it("model disindaki argumanlara dokunmaz", () => {
        deepStrictEqual([...claudePatchedModelArguments(["--print", "merhaba", "-c"])], ["--print", "merhaba", "-c"]);
    });

    it("degeri olmayan sondaki --model'de cokmez", () => {
        deepStrictEqual([...claudePatchedModelArguments(["--model"])], ["--model"]);
    });

    it("girdi dizisini DEGISTIRMEZ (kopya uzerinde calisir)", () => {
        const original = ["--model", "sol"];
        claudePatchedModelArguments(original);
        deepStrictEqual(original, ["--model", "sol"]);
    });
});

describe("claudeOAuthAgentArguments", () => {
    it("kullanici hic --agents vermediyse delegasyon tanimlarini ENJEKTE eder", () => {
        const rewritten = claudeOAuthAgentArguments(["--print", "x"], AVAILABLE);
        const index = rewritten.indexOf("--agents");
        strictEqual(index >= 0, true);
        strictEqual(typeof rewritten[index + 1], "string");
    });

    it("enjekte edilen tanim gecerli JSON'dur ve delege ajanlari icerir", () => {
        const rewritten = claudeOAuthAgentArguments([], AVAILABLE);
        const definitions = rewritten[rewritten.indexOf("--agents") + 1] ?? "";
        const parsed: unknown = JSON.parse(definitions);
        strictEqual(typeof parsed, "object");
        strictEqual(Object.keys(parsed as Record<string, unknown>).some((name) => name.endsWith("-delege")), true);
    });

    // Kapi model BASINA calisir: bir delege ancak modeli snapshot'ta DOGRULANMISSA
    // enjekte edilir. claude-opus-delege harici model gerektirmedigi icin her zaman gelir.
    it("harici model yokken yalnizca claude-opus-delege enjekte edilir", () => {
        const rewritten = claudeOAuthAgentArguments(["--print", "x"], []);
        const names = Object.keys(JSON.parse(rewritten[rewritten.indexOf("--agents") + 1] ?? "{}") as Record<string, unknown>);
        deepStrictEqual(names, ["claude-opus-delege"]);
    });

    it("yalnizca snapshot'ta DOGRULANMIS modellerin delegesi enjekte edilir", () => {
        const onlySol = claudeOAuthAgentArguments([], ["anthropic-openai-gpt-5.6-sol"]);
        const names = Object.keys(JSON.parse(onlySol[onlySol.indexOf("--agents") + 1] ?? "{}") as Record<string, unknown>);
        strictEqual(names.includes("sol-delege"), true);
        strictEqual(names.includes("terra-delege"), false);
        strictEqual(names.includes("astra-delege"), false);
        strictEqual(names.includes("gemini-delege"), false);
    });

    // astra-delege ajan adi SOZLESMEDEN turer (launcher.ts: `${contract.alias}-delege`);
    // elle bir yere yazilmaz. Iki kol: dogrulanmissa gelir, dogrulanmamissa GELMEZ --
    // ikincisi olmadan birincisi "her zaman enjekte ediyor" ile ayirt edilemez.
    it("astra dogrulaninca astra-delege gelir, dogrulanmayinca GELMEZ", () => {
        const withAstra = claudeOAuthAgentArguments([], ["anthropic-openai-gpt-6-astra"]);
        const withNames = Object.keys(JSON.parse(withAstra[withAstra.indexOf("--agents") + 1] ?? "{}") as Record<string, unknown>);
        strictEqual(withNames.includes("astra-delege"), true);
        strictEqual(withNames.includes("sol-delege"), false);

        const withoutAstra = claudeOAuthAgentArguments([], AVAILABLE);
        const withoutNames = Object.keys(JSON.parse(withoutAstra[withoutAstra.indexOf("--agents") + 1] ?? "{}") as Record<string, unknown>);
        strictEqual(withoutNames.includes("astra-delege"), false, "katalogda olmayan astra icin delege sizdi");
    });

    // native-gateway modunda delege TAM kimlik tasir: native binary alias tanimaz ve
    // "astra" gonderilirse unrecognized_model doner.
    it("astra-delege native modda tam snapshot kimligi tasir", () => {
        const rewritten = claudeOAuthAgentArguments([], ["anthropic-openai-gpt-6-astra"], "native-gateway");
        const parsed = JSON.parse(rewritten[rewritten.indexOf("--agents") + 1] ?? "{}") as Record<string, { model?: string }>;
        strictEqual(parsed["astra-delege"]?.model, "anthropic-openai-gpt-6-astra");
    });

    it("google modeli dogrulaninca gemini-delege gelir", () => {
        const withGoogle = claudeOAuthAgentArguments([], ["anthropic-google-gemini-3.8-flash-high"]);
        const names = Object.keys(JSON.parse(withGoogle[withGoogle.indexOf("--agents") + 1] ?? "{}") as Record<string, unknown>);
        strictEqual(names.includes("gemini-delege"), true);
    });

    // Rezerve bir delegenin model rotasi degistirilirse sessizce kabul edilmemeli:
    // "sol-delege" adiyla baska bir modele gitmek delegasyonu goze gorunmez sekilde bozar.
    it("rezerve bir delegenin model rotasi degistirilirse REDDEDER", () => {
        const tampered = JSON.stringify({ "sol-delege": { description: "d", prompt: "p", model: "haiku" } });
        throws(
            () => claudeOAuthAgentArguments(["--agents", tampered], AVAILABLE),
            /must keep its exact model route/u,
        );
    });

    it("kullanicinin --agents tanimini EZMEZ, birlestirir", () => {
        const mine = JSON.stringify({ "benim-ajanim": { description: "d", prompt: "p" } });
        const rewritten = claudeOAuthAgentArguments(["--agents", mine], AVAILABLE);
        const merged = JSON.parse(rewritten[rewritten.indexOf("--agents") + 1] ?? "{}") as Record<string, unknown>;
        strictEqual("benim-ajanim" in merged, true);
        strictEqual(Object.keys(merged).some((name) => name.endsWith("-delege")), true);
    });

    it("--agents=deger bicimini de birlestirir", () => {
        const mine = JSON.stringify({ "benim-ajanim": { description: "d", prompt: "p" } });
        const rewritten = claudeOAuthAgentArguments([`--agents=${mine}`], AVAILABLE);
        const argument = rewritten.find((entry) => entry.startsWith("--agents=")) ?? "";
        const merged = JSON.parse(argument.slice("--agents=".length)) as Record<string, unknown>;
        strictEqual("benim-ajanim" in merged, true);
    });

    // Belirsizligi sessizce cozmek yanlis ajan setini yuklemek demektir; reddetmek dogrudur.
    it("birden fazla --agents argumanini REDDEDER", () => {
        throws(
            () => claudeOAuthAgentArguments(["--agents", "{}", "--agents", "{}"], AVAILABLE),
            /multiple ambiguous --agents/u,
        );
    });

    it("--version ve --safe-mode yollarina hic dokunmaz", () => {
        for (const flag of ["--version", "-v", "--safe-mode"]) {
            strictEqual(claudeOAuthAgentArguments([flag], AVAILABLE).includes("--agents"), false, flag);
        }
    });
});

describe("claudeRouterEnvironment", () => {
    const nonce = "a".repeat(64);

    // VAKA KAYDI: base URL eskiden `/_session/<nonce>` tasiyordu ve bu, /model
    // listesinin harici modelleri HIC gostermemesinin sebebiydi. Claude Code ag
    // gecidi model kesfini ANTHROPIC_BASE_URL'e BIREBIR anahtarlar (binary:
    // `e.baseUrl !== a.ANTHROPIC_BASE_URL -> return []`); oturuma ozel bir nonce
    // yolda oldugu surece taban URL her oturumda degisir ve onbellek asla eslesmez.
    //
    // Sir kaybolmadi, yalnizca kanal degisti: router hem yol hem baslik nonce'unu
    // kabul eder ve ikisi de yoksa 401 doner (olculdu).
    it("base URL SABITTIR: oturuma ozel hicbir sey tasimaz", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:5555", nonce, {});
        strictEqual(environment["ANTHROPIC_BASE_URL"], "http://127.0.0.1:5555");
        strictEqual(environment["ANTHROPIC_BASE_URL"]?.includes(nonce), false);
        strictEqual(environment["ANTHROPIC_BASE_URL"]?.includes("_session"), false);
    });

    // Kesfin calismasinin sarti: AYNI port ile iki ayri oturum AYNI taban URL'i
    // uretmeli. Nonce'lar farkli olsa bile.
    it("ayni port, farkli nonce -> AYNI taban URL", () => {
        const first = claudeRouterEnvironment("http://127.0.0.1:8787", "a".repeat(64), {});
        const second = claudeRouterEnvironment("http://127.0.0.1:8787", "b".repeat(64), {});
        strictEqual(first["ANTHROPIC_BASE_URL"], second["ANTHROPIC_BASE_URL"]);
    });

    // GUVENLIK KOLU: URL'den dusen sir, baslikta HALA tam olarak duruyor olmali.
    it("nonce URL'den dustu ama BASLIKTA tam olarak duruyor", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:5555", nonce, {});
        strictEqual(environment["ANTHROPIC_CUSTOM_HEADERS"]?.includes(nonce), true);
    });

    // VAKA KAYDI (2026-08-31): kesif kimlik istedigi icin buraya ANTHROPIC_AUTH_TOKEN
    // konuldu ve Claude ana yolu KIRILDI -- Claude Code kendi OAuth tokenini birakip o
    // degeri Authorization: Bearer olarak gonderdi, AnthropicAdapter onu yukari akisa
    // aynen iletti, Anthropic "401 Invalid bearer token" dondu. Operatorun /login
    // denemeleri sonucu degistirmedi, cunku sorun oturumda degil basliktaydi.
    //
    // Bu test o gunu pinler: cocuk ortami bu degiskeni TASIMAZ, kaynak ortam tasisa bile.
    it("ANTHROPIC_AUTH_TOKEN cocuk ortamina ASLA girmez", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:5555", nonce, {});
        strictEqual(environment["ANTHROPIC_AUTH_TOKEN"], undefined);
    });

    it("kaynak ortamdaki ANTHROPIC_AUTH_TOKEN cocuga SIZMAZ", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:5555", nonce, { ANTHROPIC_AUTH_TOKEN: "kaynaktan-gelen" });
        strictEqual(environment["ANTHROPIC_AUTH_TOKEN"], undefined);
    });

    it("sondaki egik cizgiyi ikilemez", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:5555/", nonce, {});
        strictEqual(environment["ANTHROPIC_BASE_URL"], "http://127.0.0.1:5555");
    });

    it("oturum basligini nonce ile kurar", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:5555", nonce, {});
        strictEqual(environment["ANTHROPIC_CUSTOM_HEADERS"]?.includes(nonce), true);
    });

    it("loopback'i proxy'den muaf tutar", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:5555", nonce, {});
        strictEqual(environment["NO_PROXY"]?.includes("127.0.0.1"), true);
    });

    it("kaynakta API anahtari olsa bile Claude'a gecirmez", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:5555", nonce, { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" });
        deepStrictEqual(presentApiKeySelectors(environment), []);
    });
});
