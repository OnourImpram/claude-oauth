import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelSnapshot, ProviderModelRecord } from "../src/domain/contracts.js";
import { googleGateReady, openAiContextMismatches, openAiGateReady, openAiModelReadiness, requireAllProvidersReady, withPinnedNativeModels, withVerifiedOpenAiModels, type GoogleModelCatalogReadiness, type OpenAiModelReadiness } from "../src/domain/model-refresh.js";
import { AGENT_MODEL_CONTRACTS, OPENAI_MODEL_CONTRACTS, clodexCatalogDriftDetailCode, isVerifiedOpenAiSnapshotRoute, openAiCatalogDriftReadiness, openAiSnapshotRouteDrift } from "../src/domain/model-contracts.js";

// REGRESYON: Sol ve Terra canli katalogda VARDI ve OAuth calisiyordu, ama clodex baglam
// duragi "standard"a dusunce 258.400 raporladi; kilit 828.400 bekliyordu ve
// withVerifiedOpenAiModels modeli SESSIZCE atladi (`continue`). Ust katman ise
// "sol_or_terra_not_in_live_oauth_catalog" -- yani "katalogda yok" -- diyordu.
// Iki kez yanlis: model kataloglaydi ve sebep baglam penceresiydi.

// MEASURED 2026-09-05, clodex 2.8.2 -> 2.11.1. 2.8.2 shaved every ChatGPT-OAuth
// window by DEFAULT_EFFECTIVE_CONTEXT_PERCENT = 95 (4 occurrences in that bundle, 0 in
// 2.11.1); 2.11.1 replaced it with LEGACY_IMPOSED_CONTEXT_PERCENT + a migration that
// returns undefined -> normalizedPercent(undefined) = 100. So the "max" stop reports the
// raw maxContextWindow: 872_000 (was floor(872_000 x 0.95) = 828_400).
//
// The degraded arm is the "standard" stop, which moved the same way: 272_000
// (was floor(272_000 x 0.95) = 258_400). Both numbers must track config/install-lock.json
// -- a test carrying a different number than the pin stays green and measures nothing.
const LOCKED = 872_000;
const LIVE_DEGRADED = 272_000;

const baseline: ModelSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    source: "pinned-install-baseline",
    models: [
        {
            id: "claude-opus-5",
            provider: "anthropic",
            upstreamModel: "claude-opus-5",
            displayName: "Claude Opus 5",
            oauthType: "claude.ai",
            executionMode: "native-message-loop",
            discoverable: true,
            capabilities: ["messages"],
        },
    ],
};

function catalog(contextWindow: number): readonly ProviderModelRecord[] {
    return OPENAI_MODEL_CONTRACTS.map((contract) => ({
        id: contract.upstreamModel,
        contextWindow,
        maximumOutputTokens: contract.maximumOutputTokens,
    }));
}

describe("withVerifiedOpenAiModels", () => {
    it("canli baglam kilitle esitse HER OpenAI sozlesmesi snapshot'a girer", () => {
        const snapshot = withVerifiedOpenAiModels(baseline, catalog(LOCKED), LOCKED);
        const ids = snapshot.models.map((model) => model.id);
        // Sozlesmeden turer: "sol ve terra" diye elle yazilsaydi astra eklendiginde
        // bu test yesil kalir ve yeni modeli hic olcmezdi.
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            strictEqual(ids.includes(contract.id), true, `snapshot'a girmedi: ${contract.id}`);
        }
        strictEqual(ids.includes("anthropic-openai-gpt-6-astra"), true, "astra sozlesmesi kayip");
        strictEqual(snapshot.source, "live-provider-refresh");
    });

    it("kabul edilen modelin baglami CANLI degerdir, sabit degil", () => {
        const snapshot = withVerifiedOpenAiModels(baseline, catalog(LOCKED), LOCKED);
        const sol = snapshot.models.find((model) => model.id === "anthropic-openai-gpt-5.6-sol");
        strictEqual(sol?.contextWindow, LOCKED);
    });

    // NEGATIF KOL (astra): canli katalog astra'yi HIC tasimiyorsa -- clodex 2.11.1
    // tohumu ekler ama `clodex providers refresh-models openai-oauth` kosmadan
    // providers.json onbellegine GIRMEZ (applyOAuthSeedContextMetadata models.map'tir,
    // concat degil) -- astra snapshot'a girmemeli, sol/terra ise etkilenmemeli.
    it("astra canli katalogda YOKKEN snapshot'a girmez, sol/terra dusmez", () => {
        const withoutAstra = catalog(LOCKED).filter((entry) => !entry.id.includes("astra"));
        const snapshot = withVerifiedOpenAiModels(baseline, withoutAstra, LOCKED);
        const ids = snapshot.models.map((model) => model.id);
        strictEqual(ids.includes("anthropic-openai-gpt-6-astra"), false, "katalogda olmayan model snapshot'a sizdi");
        strictEqual(ids.includes("anthropic-openai-gpt-5.6-sol"), true);
        strictEqual(ids.includes("anthropic-openai-gpt-5.6-terra"), true);
    });

    // POZITIF KOL: astra katalogdaysa ve baglami kilitle esitse GIRER. Negatif kolun
    // tek basina kanitladigi sey "hicbir sey girmiyor" olabilirdi.
    it("astra canli katalogdaysa ve baglam esitse snapshot'a GIRER", () => {
        const snapshot = withVerifiedOpenAiModels(baseline, catalog(LOCKED), LOCKED);
        const astra = snapshot.models.find((model) => model.id === "anthropic-openai-gpt-6-astra");
        strictEqual(astra?.upstreamModel, "anthropic-openai-oauth__gpt-6-astra");
        strictEqual(astra?.contextWindow, LOCKED);
        strictEqual(astra?.oauthType, "chatgpt");
        strictEqual(astra?.executionMode, "native-message-loop");
    });

    // NEGATIF KONTROL: bayat pin -> model dusuyor. Kapinin fiilen elediginin kaniti.
    it("canli baglam kilitten farkliysa modeller snapshot'a GIRMEZ", () => {
        const snapshot = withVerifiedOpenAiModels(baseline, catalog(LIVE_DEGRADED), LOCKED);
        deepStrictEqual(snapshot.models.map((model) => model.id), ["claude-opus-5"]);
    });

    it("anthropic modelleri her durumda korunur", () => {
        const snapshot = withVerifiedOpenAiModels(baseline, catalog(LIVE_DEGRADED), LOCKED);
        strictEqual(snapshot.models.some((model) => model.id === "claude-opus-5"), true);
    });

    it("bos katalogda anthropic tabanina duser, cokmez", () => {
        const snapshot = withVerifiedOpenAiModels(baseline, [], LOCKED);
        deepStrictEqual(snapshot.models.map((model) => model.id), ["claude-opus-5"]);
    });
});

describe("openAiContextMismatches", () => {
    it("elenen modeli ve IKI sayiyi birden adlandirir", () => {
        const mismatches = openAiContextMismatches(catalog(LIVE_DEGRADED), LOCKED);
        strictEqual(mismatches.length, OPENAI_MODEL_CONTRACTS.length);
        const sol = mismatches.find((entry) => entry.id === "anthropic-openai-gpt-5.6-sol");
        strictEqual(sol?.liveContextWindow, LIVE_DEGRADED);
        strictEqual(sol?.lockedContextWindow, LOCKED);
    });

    it("baglam dogruyken hicbir sey bildirmez", () => {
        deepStrictEqual(openAiContextMismatches(catalog(LOCKED), LOCKED), []);
    });

    // Ayrim onemli: KATALOGDA YOK ile BAGLAMI TUTMUYOR ayni sey degil. Onceki mesaj
    // ikisini birlestirdigi icin teshis yanlis saglayiciya yonlendiriyordu.
    it("model katalogda hic yoksa uyumsuzluk olarak bildirmez", () => {
        deepStrictEqual(openAiContextMismatches([], LOCKED), []);
    });

    it("modellerden yalnizca biri sapmissa yalnizca onu bildirir", () => {
        const mixed: readonly ProviderModelRecord[] = [
            { id: "anthropic-openai-oauth__gpt-5.6-sol", contextWindow: LOCKED },
            { id: "anthropic-openai-oauth__gpt-5.6-terra", contextWindow: LIVE_DEGRADED },
        ];
        const mismatches = openAiContextMismatches(mixed, LOCKED);
        strictEqual(mismatches.length, 1);
        strictEqual(mismatches[0]?.id, "anthropic-openai-gpt-5.6-terra");
    });
});

// A7 (2026-09-02): models.default.json'a eklenen native satir calisan snapshot'a
// ulasmiyordu (seedSnapshot yalniz yokken tohumlar; refresh native'i retained tasir).
describe("withPinnedNativeModels", () => {
    const native = (id: string) => ({
        id, provider: "anthropic" as const, upstreamModel: id, displayName: id, oauthType: "claude.ai" as const,
        executionMode: "native-message-loop" as const, discoverable: false, capabilities: ["messages" as const],
    });
    const external = (id: string) => ({
        id, provider: "xai" as const, upstreamModel: "grok-4.6", displayName: id, oauthType: "xai-cli" as const,
        executionMode: "agent-readonly" as const, discoverable: true, capabilities: ["messages" as const],
    });
    const runtime: ModelSnapshot = { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", source: "live-provider-refresh", models: [native("claude-opus-5"), external("anthropic-xai-grok-4.6")] };

    it("native satirlari pinli baseline'dan alir, harici satirlari calisan snapshot'tan korur", () => {
        const pinned: ModelSnapshot = { ...runtime, source: "pinned-install-baseline", models: [native("claude-fable-5-1"), native("claude-opus-5")] };
        const merged = withPinnedNativeModels(runtime, pinned);
        deepStrictEqual(merged.models.map((model) => model.id), ["claude-fable-5-1", "claude-opus-5", "anthropic-xai-grok-4.6"]);
        strictEqual(merged.source, "live-provider-refresh", "snapshot kimligi calisan snapshot'in");
    });

    // NEGATIF KOL: baseline'daki BAYAT harici satir servis edilmez -- harici satirlarin
    // tek kaynagi canli refresh'tir; yoksa pin, harici modeli de sessizce geri getirirdi.
    it("baseline'daki harici satiri almaz; calisan snapshot'ta yoksa yok kalir", () => {
        const pinned: ModelSnapshot = { ...runtime, models: [native("claude-opus-5"), external("anthropic-xai-grok-4.6")] };
        const runtimeWithoutGrok: ModelSnapshot = { ...runtime, models: [native("claude-opus-5")] };
        deepStrictEqual(withPinnedNativeModels(runtimeWithoutGrok, pinned).models.map((model) => model.id), ["claude-opus-5"]);
    });
});

// VAKA KAYDI: cli.ts'te `solEnabled`/`terraEnabled` ELLE yazilmis iki literaldi ve
// `doctor --require-all` yalnizca onlara bakiyordu. Sozlesmeye ucuncu bir model
// (astra) eklemek, --require-all'un o modeli HIC sormadan yesil vermesi demekti.
// Google kolunda birebir ayni defekt 2026-09-02'de olculdu (elle yazilan 2, canli 3).
// Bu blok, turetilmemis yuzeyin geri gelmesini mekanik olarak yakalar.
describe("openAiModelReadiness", () => {
    const snapshotOf = (ids: readonly string[]): ModelSnapshot => ({
        ...baseline,
        models: ids.map((id) => ({
            id,
            provider: "openai" as const,
            upstreamModel: id,
            displayName: id,
            oauthType: "chatgpt" as const,
            executionMode: "native-message-loop" as const,
            discoverable: true,
            capabilities: ["messages" as const],
        })),
    });

    it("satir sayisi SOZLESME LISTESINDEN gelir, elle yazilmaz", () => {
        strictEqual(openAiModelReadiness(snapshotOf([])).length, OPENAI_MODEL_CONTRACTS.length);
        deepStrictEqual(
            openAiModelReadiness(snapshotOf([])).map((entry) => entry.id),
            OPENAI_MODEL_CONTRACTS.map((contract) => contract.id),
        );
    });

    it("astra sozlesmesi de bir satir uretir (alias astra)", () => {
        const astra = openAiModelReadiness(snapshotOf([])).find((entry) => entry.alias === "astra");
        strictEqual(astra?.id, "anthropic-openai-gpt-6-astra");
    });

    // NEGATIF KOL: snapshot'ta olmayan model "enabled" olamaz. Kapinin fiilen
    // elediginin kaniti -- hepsi true donen bir stub burada kirmizi yanar.
    it("bos snapshot'ta HICBIR model etkin degildir", () => {
        strictEqual(openAiModelReadiness(snapshotOf([])).some((entry) => entry.enabled), false);
        strictEqual(openAiModelReadiness(undefined).some((entry) => entry.enabled), false);
    });

    // Asil kaza senaryosu: sol+terra dogrulandi, astra katalogda yok. Elle yazilan
    // iki literal burada "her sey hazir" derdi; turetilmis liste astra'yi ADIYLA dusurur.
    it("yalnizca astra eksikse onu ADIYLA dusurur, digerlerini etkin birakir", () => {
        const readiness = openAiModelReadiness(snapshotOf(["anthropic-openai-gpt-5.6-sol", "anthropic-openai-gpt-5.6-terra"]));
        const missing = readiness.filter((entry) => !entry.enabled).map((entry) => entry.id);
        deepStrictEqual(missing, ["anthropic-openai-gpt-6-astra"]);
        strictEqual(readiness.every((entry) => entry.enabled), false, "--require-all bu durumda yesil VEREMEZ");
    });

    it("her sozlesme dogrulandiysa hepsi etkindir", () => {
        const readiness = openAiModelReadiness(snapshotOf(OPENAI_MODEL_CONTRACTS.map((contract) => contract.id)));
        strictEqual(readiness.every((entry) => entry.enabled), true);
    });
});

// ============================================================================
// BULGU 2 (2026-09-05, bagimsiz denetim + bu kosumda tekrar): `doctor --require-all`
// OpenAI kolu OLCUSUZDU. Mutasyon M1 -- cli.ts icindeki `every` -> `some` -- takimi
// YESIL biraktu: tests 270, pass 269, fail 0, exit 0. Sebep: hicbir test src/cli.ts'i
// import etmiyor. Kapi ifadesi saf fonksiyona tasindi; asagidaki kollarin her biri o
// mutasyonlardan birini KIRMIZI yakmak icin var.
// ============================================================================
const enabledRows: readonly OpenAiModelReadiness[] = OPENAI_MODEL_CONTRACTS.map((contract) => ({
    alias: contract.alias,
    id: contract.id,
    enabled: true,
}));
const googleContracts = AGENT_MODEL_CONTRACTS.filter((entry) => entry.provider === "google");
const googleReadyRows: readonly GoogleModelCatalogReadiness[] = googleContracts.map((contract) => ({
    provider: "google",
    model: contract.upstreamModel,
    oauthReady: true,
    adapterReady: true,
    status: "ready",
}));

describe("openAiGateReady -- doctor --require-all OpenAI kolu", () => {
    it("her sozlesme etkinse yesil", () => {
        strictEqual(openAiGateReady(enabledRows), true);
    });

    // M1'in oldurucu kolu: tek bir model dusunce kapi kirmizi olmak ZORUNDA.
    it("TEK BIR sozlesme etkisizse kirmizi (every -> some mutasyonunu oldurur)", () => {
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            const readiness = enabledRows.map((entry) => (entry.id === contract.id ? { ...entry, enabled: false } : entry));
            strictEqual(openAiGateReady(readiness), false, `dusen model yakalanmadi: ${contract.id}`);
        }
    });

    // Eski ifadedeki sayim totolojisinin yerine gecen kol: satir HIC yoksa da kirmizi.
    it("sozlesme satiri listede hic yoksa kirmizi", () => {
        strictEqual(openAiGateReady(enabledRows.slice(1)), false);
        strictEqual(openAiGateReady([]), false);
    });

    it("yabanci ama etkin bir satir eksik sozlesmenin yerini tutmaz", () => {
        const kacak = [...enabledRows.slice(1), { alias: "yok", id: "anthropic-openai-boyle-bir-model-yok", enabled: true }];
        strictEqual(openAiGateReady(kacak), false);
    });
});

describe("googleGateReady -- ayni sinif, google kolu", () => {
    it("her google sozlesmesi ready ise yesil", () => {
        strictEqual(googleGateReady(googleReadyRows), true);
    });

    it("TEK BIR model ready degilse kirmizi", () => {
        for (const contract of googleContracts) {
            const readiness = googleReadyRows.map((entry) => (entry.model === contract.upstreamModel
                ? { ...entry, status: "blocked" as const }
                : entry));
            strictEqual(googleGateReady(readiness), false, `dusen model yakalanmadi: ${contract.upstreamModel}`);
        }
    });

    it("satir eksikse kirmizi", () => {
        strictEqual(googleGateReady(googleReadyRows.slice(1)), false);
        strictEqual(googleGateReady([]), false);
    });
});

describe("requireAllProvidersReady -- uc kolun birlesimi", () => {
    const tam = { openAiModels: enabledRows, grokEnabled: true, googleModels: googleReadyRows };

    it("uc kol da tamsa yesil", () => {
        strictEqual(requireAllProvidersReady(tam), true);
    });

    // Katalog hic kurulamadiysa --require-all yesil VEREMEZ.
    it("katalog yoksa kirmizi", () => {
        strictEqual(requireAllProvidersReady(undefined), false);
    });

    it("her kol tek basina kapiyi dusurur", () => {
        strictEqual(requireAllProvidersReady({ ...tam, grokEnabled: false }), false, "grok kolu");
        strictEqual(requireAllProvidersReady({ ...tam, openAiModels: enabledRows.map((entry, index) => (index === 0 ? { ...entry, enabled: false } : entry)) }), false, "openai kolu");
        strictEqual(requireAllProvidersReady({ ...tam, googleModels: googleReadyRows.slice(1) }), false, "google kolu");
    });
});

// ============================================================================
// BULGU 1: yayin sonrasi pencerede dusen sey YENI model degil, calisan sol/terra
// seridiydi -- ve operatorun gordugu tek dize ("clodex_session_catalog_drift") ne
// modeli ne de iki sayidan birini soyluyordu. Olculdu 2026-09-05: canli snapshot
// sol/terra icin 828400 tasiyor, kilit 872000. Asagisi ayni catismanin birim kurgusu.
// ============================================================================
describe("openAiSnapshotRouteDrift -- 'neden dustu' sorusunun cevabi", () => {
    const kurulu = withVerifiedOpenAiModels(baseline, catalog(LOCKED), LOCKED).models.filter((model) => model.provider === "openai");

    it("canli pencere snapshot'takinden farkliysa HER satir adiyla ve IKI sayiyla raporlanir", () => {
        const drift = openAiSnapshotRouteDrift(kurulu, catalog(LIVE_DEGRADED));
        strictEqual(drift.length, OPENAI_MODEL_CONTRACTS.length);
        const code = clodexCatalogDriftDetailCode(drift);
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            strictEqual(code.includes(contract.id), true, `kod modeli adiyla yazmiyor: ${contract.id}`);
        }
        strictEqual(code.includes(`live${LIVE_DEGRADED}`), true, "canli sayi kodda yok");
        strictEqual(code.includes(`snapshot${LOCKED}`), true, "snapshot sayisi kodda yok");
    });

    // NEGATIF KOL: uyusan katalogda surukleme YOKTUR. Bu olmadan yukaridaki kol
    // "fonksiyon her zaman satir uretiyor" ile ayirt edilemez.
    it("katalog snapshot'la uyusuyorsa surukleme YOK ve kod sade bicimine doner", () => {
        deepStrictEqual(openAiSnapshotRouteDrift(kurulu, catalog(LOCKED)), []);
        strictEqual(clodexCatalogDriftDetailCode([]), "clodex_session_catalog_drift");
    });

    // Bos katalog "yok" demektir, sifir demek DEGILDIR: eksik sayi uydurulmaz.
    it("katalogda hic olmayan model icin sayi uydurulmaz", () => {
        const drift = openAiSnapshotRouteDrift(kurulu, []);
        strictEqual(drift.length, OPENAI_MODEL_CONTRACTS.length);
        strictEqual(drift.every((entry) => entry.liveContextWindow === undefined), true);
        strictEqual(clodexCatalogDriftDetailCode(drift).includes("=liveabsent"), true);
    });

    // ILAN 1M OLSA DA DOGRULAMA CANLI SAYIYA BAKAR (2026-09-05). Astra Claude Code'a
    // 1_000_000 ilan eder, ama o sayi snapshot'a HIC girmez -- ilan yalnizca kesif
    // izdusumunde yasar (src/domain/registry.ts). Bu ayrimin bedeli tam olarak burada
    // odenir: canli katalog 872_000'den 272_000'e dustugunde ("standard" duragina
    // sifirlanma, 5.6 seridinde 2026-09-01'de olculdu) satir dogrulanmaz ve surukleme
    // satiri iki sayiyi da adiyla yazar. Ilan snapshot'a yazilsaydi bu kol YESIL kalirdi:
    // politika sayisi kendisiyle eslesir, dedektor kor olurdu.
    it("Astra ilani 1M olsa da canli pencere dususu ADIYLA yakalanir", () => {
        const astra = kurulu.find((model) => model.id === "anthropic-openai-gpt-6-astra");
        ok(astra !== undefined, "astra snapshot satiri yok");
        strictEqual(astra.contextWindow, LOCKED, "snapshot OLCULEN sayiyi tasimali");
        strictEqual(isVerifiedOpenAiSnapshotRoute(astra, catalog(LIVE_DEGRADED)), false, "dusen canli pencere dogrulanmis sayildi");
        const kod = clodexCatalogDriftDetailCode(openAiSnapshotRouteDrift([astra], catalog(LIVE_DEGRADED)));
        strictEqual(kod.includes(`anthropic-openai-gpt-6-astra=live${LIVE_DEGRADED}_snapshot${LOCKED}`), true, kod);
        // POZITIF KOL: canli sayi yerindeyken ayni satir dogrulanir -- kol "her zaman
        // false donuyor" ile ayirt edilebilir olsun.
        strictEqual(isVerifiedOpenAiSnapshotRoute(astra, catalog(LOCKED)), true);
    });

    // Bir detektor caresiyle birlikte gelir: sinyal eyleme donusemezse gurultudur.
    it("readiness caresini tasir ve durumu unavailable'dir", () => {
        const readiness = openAiCatalogDriftReadiness(kurulu, catalog(LIVE_DEGRADED));
        strictEqual(readiness.provider, "openai");
        strictEqual(readiness.status, "unavailable");
        strictEqual(readiness.detailCode?.startsWith("clodex_session_catalog_drift:"), true);
        strictEqual(readiness.remedy?.includes("models refresh"), true);
    });
});
