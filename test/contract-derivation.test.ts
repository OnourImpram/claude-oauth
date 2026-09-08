import { ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { ModelRecord, ModelSnapshot, ProviderModelRecord } from "../src/domain/contracts.js";
import {
    AGENT_MODEL_CONTRACTS,
    OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS,
    OPENAI_CONTEXT_WINDOW_TOKENS,
    OPENAI_MODEL_CONTRACTS,
} from "../src/domain/model-contracts.js";
import { withVerifiedOpenAiModels } from "../src/domain/model-refresh.js";
import { ModelRegistry, advertisedContextWindow, claudeClientDiscoveryId, modelDetail } from "../src/domain/registry.js";
import { antigravityAllowedModels } from "../src/antigravity/headless-bridge.js";
import { claudeOAuthAgentArguments } from "../src/supervisor/launcher.js";

// CASE RECORD -- this class repeated FOUR times in one day. Every time, a surface was
// hand-written instead of being derived from AGENT_MODEL_CONTRACTS, and every time adding a
// model to the contract left that surface SILENTLY out:
//
//   1. the alias validator in the local patch -> a model visible in the picker that the
//                                                validator rejected
//   2. the Antigravity probe list in cli.ts   -> a model never probed and never entering
//                                                the snapshot
//   3. the Antigravity allow list             -> a LOCAL refusal called
//                                                "model_not_available", reported as an
//                                                upstream refusal
//   4. delegate agent naming                  -> with a third Google model, TWO agents took
//                                                the same name and one was silently
//                                                overwritten
//
// This file is that class's mechanical measure: every underived surface goes red here.

const ALL_EXTERNAL_IDS = [...AGENT_MODEL_CONTRACTS, ...OPENAI_MODEL_CONTRACTS].map((contract) => contract.id);

function injectedAgentNames(availableModelIds: readonly string[]): readonly string[] {
    const rewritten = claudeOAuthAgentArguments([], availableModelIds);
    const index = rewritten.indexOf("--agents");
    if (index === -1)
        return [];
    return Object.keys(JSON.parse(rewritten[index + 1] ?? "{}") as Record<string, unknown>);
}

describe("Antigravity izin listesi sozlesmelerden turetilir", () => {
    it("her Google sozlesmesinin upstream modeli izin listesindedir", () => {
        for (const contract of AGENT_MODEL_CONTRACTS.filter((entry) => entry.provider === "google")) {
            strictEqual(antigravityAllowedModels.includes(contract.upstreamModel), true, `izin listesinde yok: ${contract.upstreamModel}`);
        }
    });

    // NEGATIVE ARM: the list must not reach BEYOND the contracts -- that is the security check.
    it("izin listesi sozlesme kumesinin disina tasmaz", () => {
        const reviewed = new Set(AGENT_MODEL_CONTRACTS.filter((entry) => entry.provider === "google").map((entry) => entry.upstreamModel));
        for (const model of antigravityAllowedModels) {
            strictEqual(reviewed.has(model), true, `sozlesmesiz model izinli: ${model}`);
        }
    });
});

describe("delege ajan adlari", () => {
    it("her harici model sozlesmesi TAM BIR delege uretir", () => {
        const names = injectedAgentNames(ALL_EXTERNAL_IDS);
        for (const contract of [...AGENT_MODEL_CONTRACTS, ...OPENAI_MODEL_CONTRACTS]) {
            const expected = `${contract.alias}-delege`;
            strictEqual(names.includes(expected), true, `delege uretilmedi: ${expected}`);
        }
    });

    // This was the actual defect: when two contracts produce the same name,
    // Object.fromEntries silently overwrites one and that model becomes undelegatable.
    it("hicbir delege adi CAKISMAZ", () => {
        const names = injectedAgentNames(ALL_EXTERNAL_IDS);
        strictEqual(new Set(names).size, names.length, `cakisan ad var: ${names.join(", ")}`);
    });

    it("Grok da delege uretir (filtre bir zamanlar yalnizca google idi)", () => {
        const names = injectedAgentNames(ALL_EXTERNAL_IDS);
        strictEqual(names.includes("grok-delege"), true);
    });

    it("snapshot'ta dogrulanmamis modelin delegesi enjekte EDILMEZ", () => {
        const names = injectedAgentNames([]);
        for (const contract of [...AGENT_MODEL_CONTRACTS, ...OPENAI_MODEL_CONTRACTS]) {
            strictEqual(names.includes(`${contract.alias}-delege`), false, `bos snapshot'ta sizdi: ${contract.alias}`);
        }
    });
});

describe("native-gateway modu tam model kimligi kullanir", () => {
    // The native binary does not recognise aliases: values like "sol", produced for the
    // patched picker, return unrecognized_model on the native path. A delegate definition
    // must carry the FULL identity.
    it("delege tanimlari native modda tam snapshot kimligi tasir", () => {
        const rewritten = claudeOAuthAgentArguments([], ALL_EXTERNAL_IDS, "native-gateway");
        const index = rewritten.indexOf("--agents");
        strictEqual(index !== -1, true);
        const parsed = JSON.parse(rewritten[index + 1] ?? "{}") as Record<string, { model?: string }>;
        for (const contract of [...AGENT_MODEL_CONTRACTS, ...OPENAI_MODEL_CONTRACTS]) {
            strictEqual(parsed[`${contract.alias}-delege`]?.model, contract.id, `native modda alias kaldi: ${contract.alias}`);
        }
    });

    it("yamali modda alias korunur", () => {
        const rewritten = claudeOAuthAgentArguments([], ALL_EXTERNAL_IDS, "patched-shadow");
        const index = rewritten.indexOf("--agents");
        const parsed = JSON.parse(rewritten[index + 1] ?? "{}") as Record<string, { model?: string }>;
        for (const contract of [...AGENT_MODEL_CONTRACTS, ...OPENAI_MODEL_CONTRACTS]) {
            strictEqual(parsed[`${contract.alias}-delege`]?.model, contract.alias, `yamali modda kimlik sizdi: ${contract.alias}`);
        }
    });

    it("native modda --model yeniden YAZILMAZ", () => {
        const rewritten = claudeOAuthAgentArguments(["--model", "anthropic-openai-gpt-5.6-sol"], ALL_EXTERNAL_IDS, "native-gateway");
        strictEqual(rewritten[1], "anthropic-openai-gpt-5.6-sol");
    });

    it("yamali modda --model alias'a cevrilir", () => {
        const rewritten = claudeOAuthAgentArguments(["--model", "anthropic-openai-gpt-5.6-sol"], ALL_EXTERNAL_IDS, "patched-shadow");
        strictEqual(rewritten[1], "sol");
    });
});

// ============================================================================
// ADVERTISED CONTEXT WINDOW (2026-09-05, Astra 1M).
//
// The ONLY window field that reaches Claude Code is the GET /v1/models response:
// gateway-models.json carries only {id, display_name}, and CLAUDE_CODE_AUTO_COMPACT_WINDOW
// comes from the contract. This block measures that surface: the advertisement derives from
// the contract, the MEASURED number in the snapshot is left intact, and no row without a
// contract gets an advertisement.
// ============================================================================

// The Astra seed of clodex 2.11.1 and the "max" stop of the 5.6 family: 872_000. The
// MECHANICAL proof that this number equals the pin in config/install-lock.json is not here
// but in the lock-reading arm of test/auto-compact-window.test.ts; all that is needed here
// is that it DIFFERS from the advertised number -- otherwise the override would be invisible.
const CANLI_PENCERE = 872_000;

const bosBaseline: ModelSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    source: "pinned-install-baseline",
    models: [],
};

function canliKatalog(pencere: number): readonly ProviderModelRecord[] {
    return OPENAI_MODEL_CONTRACTS.map((contract) => ({
        id: contract.upstreamModel,
        contextWindow: pencere,
        maximumOutputTokens: contract.maximumOutputTokens,
    }));
}

function kesifSatirlari(snapshot: ModelSnapshot): readonly Record<string, unknown>[] {
    const payload = new ModelRegistry(snapshot, new Map()).discoveryPayload();
    return payload["data"] as readonly Record<string, unknown>[];
}

const dogrulanmisSnapshot = withVerifiedOpenAiModels(bosBaseline, canliKatalog(CANLI_PENCERE), CANLI_PENCERE);

// A single Astra row factory: both describes use it. `contextWindow` has to be overridable
// -- that is the REAL trigger of the `[1m]` suffix (see below).
function astraSatiri(over: {
    readonly id?: string;
    readonly provider?: ModelRecord["provider"];
    readonly upstreamModel?: string;
    readonly contextWindow?: number;
} = {}): ModelRecord {
    return {
        id: over.id ?? "anthropic-openai-gpt-6-astra",
        provider: over.provider ?? "openai",
        upstreamModel: over.upstreamModel ?? "anthropic-openai-oauth__gpt-6-astra",
        displayName: "GPT-6 Astra via ChatGPT OAuth",
        oauthType: "chatgpt",
        executionMode: "native-message-loop",
        discoverable: true,
        contextWindow: over.contextWindow ?? CANLI_PENCERE,
        capabilities: ["messages"],
    };
}


describe("Claude Code'a ilan edilen pencere sozlesmeden turer", () => {
    it("Astra 1_000_000 ilan eder -- context_window ve max_input_tokens birlikte", () => {
        const satir = kesifSatirlari(dogrulanmisSnapshot).find((entry) => String(entry["id"]).startsWith("anthropic-openai-gpt-6-astra"));
        ok(satir !== undefined, "astra kesif satiri yok");
        strictEqual(satir["context_window"], OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS);
        strictEqual(satir["max_input_tokens"], OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS);
        strictEqual(OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS, 1_000_000);
    });

    // EVIDENCE GRAMMAR: the advertisement is a POLICY number, not a measurement. The
    // snapshot is the record of the measurement and is not overwritten -- were it
    // overwritten, the drift detector would be matching against itself.
    it("snapshot'taki Astra satiri OLCULEN canli sayiyi korur, ilan edileni degil", () => {
        const astra = dogrulanmisSnapshot.models.find((model) => model.id === "anthropic-openai-gpt-6-astra");
        strictEqual(astra?.contextWindow, CANLI_PENCERE);
    });

    // NEGATIVE ARM: the override is SPECIFIC to Astra. Sol/Terra show the measured number,
    // not the advertised one; had it leaked, two models would run on the wrong budget.
    //
    // FIX 2026-09-05 (audit FINDING 2). The loop used to iterate over
    // `.filter((entry) => entry.advertisedContextWindow === undefined)` -- that is, exactly
    // the class of change it PROTECTED against emptied the filter. MEASURED (this run,
    // staging): when the advertisement was added to the Sol and Terra contracts too, the
    // loop length fell to 0, the arm stayed GREEN, and all three models started advertising
    // 1_000_000. The only arm that caught the leak was the one auditing the table's SHAPE;
    // it was not this arm, which audits behaviour.
    //
    // Two changes: the filter now derives from the ALIAS (the loop walks the same rows even
    // if the advertisement leaks) and the scope claim is stated up front -- an empty set is
    // now red, not a silent pass.
    it("Sol/Terra ilani degismez: canli sayi ne ise o", () => {
        const satirlar = kesifSatirlari(dogrulanmisSnapshot);
        const ilansizlar = OPENAI_MODEL_CONTRACTS.filter((entry) => entry.alias !== "astra");
        strictEqual(ilansizlar.length, OPENAI_MODEL_CONTRACTS.length - 1, "kapsam: astra disindaki her satir olculmeli");
        ok(ilansizlar.length >= 2, `kapsam bos ya da eksik: ${ilansizlar.length} sozlesme`);
        for (const contract of ilansizlar) {
            const satir = satirlar.find((entry) => String(entry["id"]).startsWith(contract.id));
            ok(satir !== undefined, `kesif satiri yok: ${contract.id}`);
            strictEqual(satir["context_window"], CANLI_PENCERE, `ilan sizdi: ${contract.id}`);
        }
    });

    // FIX 2026-09-05 (audit FINDING 1). This arm's old comment claimed "if someone sets the
    // advertisement equal to the ceiling, the picker row's name changes silently and this
    // arm goes red". MEASURED (this run, staging): the advertisement was raised to
    // 1_050_000, the identity STAYED `anthropic-openai-gpt-6-astra`, and the arm went GREEN.
    // claudeClientDiscoveryId looks at `model.contextWindow` -- that is, at the SNAPSHOT
    // number; it never sees the advertised number, and cannot change with what it does not
    // see.
    //
    // What the arm now measures is the real invariant: identity derives from the snapshot
    // window. Three negative arms plus ONE POSITIVE; without the positive, "the suffix was
    // not attached" and "the instrument is broken" would look identical. Keeping the
    // advertisement at 1_000_000 is another arm's job ("Astra advertises 1_000_000"),
    // because its rationale is not the picker: a round number and headroom under the ceiling.
    it("picker kimligi SNAPSHOT penceresinden turer, ilan edilenden DEGIL", () => {
        const kimlikler = kesifSatirlari(dogrulanmisSnapshot).map((entry) => String(entry["id"]));
        strictEqual(kimlikler.includes("anthropic-openai-gpt-6-astra"), true);
        strictEqual(kimlikler.includes("anthropic-openai-gpt-6-astra[1m]"), false);
        strictEqual(claudeClientDiscoveryId(astraSatiri()), "anthropic-openai-gpt-6-astra");

        // POSITIVE ARM -- the suffix CAN in fact be attached, and its trigger is the
        // snapshot window becoming equal to the contract ceiling. If this arm does not fall,
        // the three negative arms above are measuring nothing.
        strictEqual(claudeClientDiscoveryId(astraSatiri({ contextWindow: OPENAI_CONTEXT_WINDOW_TOKENS })), "anthropic-openai-gpt-6-astra[1m]");
    });

    // NEGATIVE ARM: a model that never entered the snapshot CANNOT BE ADVERTISED either. The
    // constant in the contract cannot produce a picker row on its own -- verification is
    // still the gate itself.
    it("canli katalog Astra'yi tasimazsa hicbir sey ilan edilmez", () => {
        const astrasiz = canliKatalog(CANLI_PENCERE).filter((entry) => !entry.id.includes("astra"));
        const kimlikler = kesifSatirlari(withVerifiedOpenAiModels(bosBaseline, astrasiz, CANLI_PENCERE))
            .map((entry) => String(entry["id"]));
        strictEqual(kimlikler.some((id) => id.startsWith("anthropic-openai-gpt-6-astra")), false);
        strictEqual(kimlikler.includes("anthropic-openai-gpt-5.6-sol"), true, "diger serit dusmemeli");
    });
});

describe("advertisedContextWindow -- ustune yazmanin sinirlari", () => {
    it("sozlesmeli satirda ilan edilen sayiyi verir", () => {
        strictEqual(advertisedContextWindow(astraSatiri()), OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS);
    });

    // A window is NOT invented for a row that has none: a missing measurement is not zero.
    it("penceresi olmayan satir icin undefined doner", () => {
        const penceresiz: ModelRecord = {
            id: "anthropic-openai-gpt-6-astra",
            provider: "openai",
            upstreamModel: "anthropic-openai-oauth__gpt-6-astra",
            displayName: "GPT-6 Astra via ChatGPT OAuth",
            oauthType: "chatgpt",
            executionMode: "native-message-loop",
            discoverable: true,
            capabilities: ["messages"],
        };
        strictEqual(advertisedContextWindow(penceresiz), undefined);
    });

    // NEGATIVE ARM: identity is not enough. A row that does not route to the contract's
    // upstream model cannot inherit Astra's advertisement -- if it could, a request going
    // somewhere else would be set up with Astra's budget.
    it("upstream modeli ya da saglayicisi uyusmayan satir ilani DEVRALMAZ", () => {
        strictEqual(advertisedContextWindow(astraSatiri({ upstreamModel: "baska-bir-model" })), CANLI_PENCERE);
        strictEqual(advertisedContextWindow(astraSatiri({ provider: "anthropic" })), CANLI_PENCERE);
    });

    it("sozlesmesiz model kendi olculen penceresiyle ilan edilir", () => {
        strictEqual(advertisedContextWindow(astraSatiri({ id: "claude-opus-5", provider: "anthropic", upstreamModel: "claude-opus-5" })), CANLI_PENCERE);
    });
});

describe("ilan edilen pencere sozlesme tablosunda TEK yerde yasar", () => {
    it("advertisedContextWindow yalniz Astra'da tanimlidir", () => {
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            const beklenen = contract.alias === "astra" ? OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS : undefined;
            strictEqual(contract.advertisedContextWindow, beklenen, `beklenmeyen ilan: ${contract.id}`);
        }
    });

    // An override with no source is folklore: nobody can verify the number, nobody can delete it.
    it("ilan eden her sozlesme KAYNAGINI tasir, etmeyen tasimaz", () => {
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            const ilanVar = contract.advertisedContextWindow !== undefined;
            strictEqual((contract.contextWindowSource ?? "").length > 0, ilanVar, `kaynak/ilan eslesmiyor: ${contract.id}`);
        }
    });

    // The source note is not a string but a QUOTE: it names the primary page and the atom taken from it.
    it("Astra'nin kaynak notu birincil sayfayi ve alintiyi tasir", () => {
        const astra = OPENAI_MODEL_CONTRACTS.find((contract) => contract.alias === "astra");
        const kaynak = astra?.contextWindowSource ?? "";
        strictEqual(kaynak.includes("developers.openai.com/api/docs/models/gpt-6-astra"), true, "model karti yok");
        strictEqual(kaynak.includes("1,050,000 context window"), true, "model kartindan alinti yok");
        strictEqual(kaynak.includes("272K input tokens"), true, "fiyat siniri istisnasi yok");
    });

    // FIX 2026-09-05 (audit FINDING 4). The em dash in the rate card sentence had been
    // downgraded to ASCII "--", and the downgrade was done INSIDE THE QUOTE, unmarked. The
    // repository is not ASCII-only (measured: 11 files under src/ test/ scripts/ already
    // carry U+A7/U+B7/U+FC), so the correct fix is the character itself, not a footnote. The
    // arm runs both ways: the correct character IS present and the downgraded form is NOT --
    // one-way, the "neither is present" state would pass silently.
    it("rate card alintisi em dash'i BIREBIR tasir, ASCII'ye indirilmemis", () => {
        const astra = OPENAI_MODEL_CONTRACTS.find((contract) => contract.alias === "astra");
        const kaynak = astra?.contextWindowSource ?? "";
        strictEqual(kaynak.includes("GPT-6 Astra \u2014 Codex long-context exception"), true, "em dash ASCII'ye indirilmis");
        strictEqual(kaynak.includes("GPT-6 Astra -- Codex long-context exception"), false, "ASCII indirgemesi geri gelmis");
    });

    // An advertisement cannot exceed the contract's CEILING: openAiCatalogEntry filters the
    // live number against that ceiling, and an advertisement above it would hand Claude Code
    // a budget the model would reject.
    it("hicbir ilan sozlesme tavanini asmaz", () => {
        // CLASS SWEEP (same pattern as FINDING 2): a loop containing `continue` also passes
        // silently on an empty set. The counter asserts what the arm measures.
        let olculen = 0;
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            if (contract.advertisedContextWindow === undefined)
                continue;
            olculen += 1;
            strictEqual(contract.advertisedContextWindow <= contract.contextWindow, true, `tavan asildi: ${contract.id}`);
        }
        ok(olculen >= 1, "kapsam: ilan eden sozlesme yok, kol vakumda gecti");
    });
});

// ============================================================================
// OPERATOR SURFACE (audit FINDING 3, 2026-09-05)
//
// `claude-oauth models --refresh` and `claude-oauth doctor` built their model lines BY HAND,
// in two separate places and identically to each other, and printed ONLY the measured
// window. For Astra that number is 872_000; the one told to Claude Code is 1_000_000. The
// concrete accident: a correct release is pinned, the main session reflexively runs
// `doctor`, sees 872_000 and concludes "the change did not land". The only place the
// advertised number was visible was the running router's GET /v1/models endpoint.
// ============================================================================

describe("operator yuzeyi olculen ve ilan edilen sayiyi AYRI adlarla gosterir", () => {
    it("Astra satiri iki sayiyi da tasir", () => {
        const astra = dogrulanmisSnapshot.models.find((model) => model.id === "anthropic-openai-gpt-6-astra");
        ok(astra !== undefined, "astra snapshot satiri yok");
        const satir = modelDetail(astra);
        strictEqual(satir["contextWindow"], CANLI_PENCERE, "olculen sayi kayboldu");
        strictEqual(satir["advertisedContextWindow"], OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS, "ilan edilen sayi basilmiyor");
    });

    // The field is written ONLY when the two numbers differ. Repeating "872000 = 872000"
    // tells the operator nothing, and what comes with noise is blindness.
    it("ilani olmayan satirda alan HIC yazilmaz", () => {
        const sol = dogrulanmisSnapshot.models.find((model) => model.id === "anthropic-openai-gpt-5.6-sol");
        ok(sol !== undefined, "sol snapshot satiri yok");
        const satir = modelDetail(sol);
        strictEqual(satir["contextWindow"], CANLI_PENCERE);
        strictEqual("advertisedContextWindow" in satir, false, "gereksiz alan yazildi");
    });

    // MECHANICAL ARM. The two arms above measure the helper; this arm measures that cli.ts
    // ACTUALLY uses it. The lines were hand-written once and broke in both places at once --
    // if they are hand-written again this goes red, rather than silently returning to the
    // old behaviour.
    it("cli.ts her modelDetails satirini bu yardimcidan uretir", async (t) => {
        const cliPath = resolve(import.meta.dirname, "..", "..", "src", "cli.ts");
        let kaynak: string;
        try {
            kaynak = await readFile(cliPath, "utf8");
        }
        catch (error) {
            // Evidence grammar: a check that could not run is NOT a silent pass, it is skipped with its reason.
            t.skip(`src/cli.ts okunamadi: ${(error as Error).message}`);
            return;
        }
        const satirlar = [...kaynak.matchAll(/modelDetails:\s*([^\r\n]*)/g)].map((eslesme) => eslesme[1] ?? "");
        ok(satirlar.length >= 2, `kapsam: modelDetails satiri beklenenden az (${satirlar.length})`);
        for (const satir of satirlar)
            strictEqual(satir.includes("map(modelDetail)"), true, `elle yazilmis modelDetails satiri: ${satir}`);
    });
});
