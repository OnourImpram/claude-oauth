import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeOAuthAgentArguments, claudePatchedModelArguments, claudeRouterEnvironment } from "../src/supervisor/launcher.js";
import { presentApiKeySelectors } from "../src/security/environment.js";

// Subagent delegation (sol-delege, terra-delege, gemini-delege) works by injecting
// --agents. These functions REWRITE the user's arguments; a silent bug here either kills
// delegation or overwrites the user's own agent definitions.

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

    // The gate runs PER model: a delegate is injected only if its model is VERIFIED in the
    // snapshot. claude-opus-delege requires no external model, so it always appears.
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

    // The astra-delege agent name is DERIVED FROM THE CONTRACT (launcher.ts:
    // `${contract.alias}-delege`); it is written by hand nowhere. Two arms: it appears when
    // verified, it does NOT appear when unverified -- without the second, the first cannot
    // be told apart from "always injecting".
    it("astra dogrulaninca astra-delege gelir, dogrulanmayinca GELMEZ", () => {
        const withAstra = claudeOAuthAgentArguments([], ["anthropic-openai-gpt-6-astra"]);
        const withNames = Object.keys(JSON.parse(withAstra[withAstra.indexOf("--agents") + 1] ?? "{}") as Record<string, unknown>);
        strictEqual(withNames.includes("astra-delege"), true);
        strictEqual(withNames.includes("sol-delege"), false);

        const withoutAstra = claudeOAuthAgentArguments([], AVAILABLE);
        const withoutNames = Object.keys(JSON.parse(withoutAstra[withoutAstra.indexOf("--agents") + 1] ?? "{}") as Record<string, unknown>);
        strictEqual(withoutNames.includes("astra-delege"), false, "katalogda olmayan astra icin delege sizdi");
    });

    // In native-gateway mode the delegate carries the FULL identity: the native binary does
    // not recognise aliases and returns unrecognized_model if "astra" is sent.
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

    // If a reserved delegate's model route is altered it must not be accepted silently:
    // going to a different model under the name "sol-delege" breaks delegation invisibly.
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

    // Resolving the ambiguity silently means loading the wrong agent set; refusing is correct.
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

    // CASE RECORD: the base URL used to carry `/_session/<nonce>`, and that was the reason
    // the /model list NEVER showed external models. Claude Code keys gateway model discovery
    // to ANTHROPIC_BASE_URL VERBATIM (binary: `e.baseUrl !== a.ANTHROPIC_BASE_URL ->
    // return []`); as long as a per-session nonce sits in the path, the base URL changes
    // every session and the cache never matches.
    //
    // The secret was not lost, only its channel changed: the router accepts the nonce in
    // both the path and the header, and returns 401 when neither is present (measured).
    it("base URL SABITTIR: oturuma ozel hicbir sey tasimaz", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:5555", nonce, {});
        strictEqual(environment["ANTHROPIC_BASE_URL"], "http://127.0.0.1:5555");
        strictEqual(environment["ANTHROPIC_BASE_URL"]?.includes(nonce), false);
        strictEqual(environment["ANTHROPIC_BASE_URL"]?.includes("_session"), false);
    });

    // The condition for discovery to work: two separate sessions on the SAME port must
    // produce the SAME base URL. Even when their nonces differ.
    it("ayni port, farkli nonce -> AYNI taban URL", () => {
        const first = claudeRouterEnvironment("http://127.0.0.1:8787", "a".repeat(64), {});
        const second = claudeRouterEnvironment("http://127.0.0.1:8787", "b".repeat(64), {});
        strictEqual(first["ANTHROPIC_BASE_URL"], second["ANTHROPIC_BASE_URL"]);
    });

    // SECURITY ARM: the secret dropped from the URL must STILL be present, in full, in the header.
    it("nonce URL'den dustu ama BASLIKTA tam olarak duruyor", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:5555", nonce, {});
        strictEqual(environment["ANTHROPIC_CUSTOM_HEADERS"]?.includes(nonce), true);
    });

    // CASE RECORD (2026-08-31): because discovery demanded a credential,
    // ANTHROPIC_AUTH_TOKEN was placed here and the Claude main path BROKE -- Claude Code
    // dropped its own OAuth token and sent that value as Authorization: Bearer, the
    // AnthropicAdapter forwarded it upstream verbatim, and Anthropic returned "401 Invalid
    // bearer token". The operator's /login attempts changed nothing, because the problem was
    // not in the session but in the header.
    //
    // This test pins that day: the child environment does NOT carry this variable, even when
    // the source environment does.
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
