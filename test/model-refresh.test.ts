import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelSnapshot, ProviderModelRecord } from "../src/domain/contracts.js";
import { googleGateReady, openAiContextMismatches, openAiGateReady, openAiModelReadiness, requireAllProvidersReady, withPinnedNativeModels, withVerifiedOpenAiModels, type GoogleModelCatalogReadiness, type OpenAiModelReadiness } from "../src/domain/model-refresh.js";
import { AGENT_MODEL_CONTRACTS, OPENAI_MODEL_CONTRACTS, clodexCatalogDriftDetailCode, isVerifiedOpenAiSnapshotRoute, openAiCatalogDriftReadiness, openAiSnapshotRouteDrift } from "../src/domain/model-contracts.js";

// REGRESSION: Sol and Terra WERE in the live catalog and OAuth was working, but when the
// clodex context stop dropped to "standard" it reported 258,400; the lock expected 828,400
// and withVerifiedOpenAiModels SILENTLY skipped the model (`continue`). The layer above
// then said "sol_or_terra_not_in_live_oauth_catalog" -- that is, "not in the catalog".
// Wrong twice over: the model was in the catalog, and the cause was the context window.

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
        // Derived from the contract: had it been hand-written as "sol and terra", this test
        // would have stayed green when astra was added and never measured the new model.
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

    // NEGATIVE ARM (astra): if the live catalog does NOT carry astra at all -- the clodex
    // 2.11.1 seed adds it, but without running `clodex providers refresh-models
    // openai-oauth` it never ENTERS the providers.json cache (applyOAuthSeedContextMetadata
    // is a models.map, not a concat) -- astra must not enter the snapshot, and sol/terra
    // must be unaffected.
    it("astra canli katalogda YOKKEN snapshot'a girmez, sol/terra dusmez", () => {
        const withoutAstra = catalog(LOCKED).filter((entry) => !entry.id.includes("astra"));
        const snapshot = withVerifiedOpenAiModels(baseline, withoutAstra, LOCKED);
        const ids = snapshot.models.map((model) => model.id);
        strictEqual(ids.includes("anthropic-openai-gpt-6-astra"), false, "katalogda olmayan model snapshot'a sizdi");
        strictEqual(ids.includes("anthropic-openai-gpt-5.6-sol"), true);
        strictEqual(ids.includes("anthropic-openai-gpt-5.6-terra"), true);
    });

    // POSITIVE ARM: if astra is in the catalog and its context equals the lock, it DOES
    // enter. On its own, all the negative arm might have proved is "nothing ever enters".
    it("astra canli katalogdaysa ve baglam esitse snapshot'a GIRER", () => {
        const snapshot = withVerifiedOpenAiModels(baseline, catalog(LOCKED), LOCKED);
        const astra = snapshot.models.find((model) => model.id === "anthropic-openai-gpt-6-astra");
        strictEqual(astra?.upstreamModel, "anthropic-openai-oauth__gpt-6-astra");
        strictEqual(astra?.contextWindow, LOCKED);
        strictEqual(astra?.oauthType, "chatgpt");
        strictEqual(astra?.executionMode, "native-message-loop");
    });

    // NEGATIVE CONTROL: a stale pin -> the model drops. Proof that the gate actually filters.
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

    // The distinction matters: NOT IN THE CATALOG and CONTEXT DOES NOT MATCH are not the
    // same thing. The previous message merged the two, so diagnosis was routed to the wrong
    // provider.
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

// A7 (2026-09-02): a native row added to models.default.json never reached the running
// snapshot (seedSnapshot only seeds when absent; refresh carries native as retained).
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

    // NEGATIVE ARM: a STALE external row in the baseline is not served -- the only source of
    // external rows is a live refresh; otherwise the pin would silently bring an external
    // model back too.
    it("baseline'daki harici satiri almaz; calisan snapshot'ta yoksa yok kalir", () => {
        const pinned: ModelSnapshot = { ...runtime, models: [native("claude-opus-5"), external("anthropic-xai-grok-4.6")] };
        const runtimeWithoutGrok: ModelSnapshot = { ...runtime, models: [native("claude-opus-5")] };
        deepStrictEqual(withPinnedNativeModels(runtimeWithoutGrok, pinned).models.map((model) => model.id), ["claude-opus-5"]);
    });
});

// CASE RECORD: in cli.ts, `solEnabled`/`terraEnabled` were two HAND-WRITTEN literals and
// `doctor --require-all` looked only at them. Adding a third model (astra) to the contract
// meant --require-all returning green without EVER asking about that model. The exact same
// defect was measured on the Google lane on 2026-09-02 (2 hand-written, 3 live). This block
// catches the return of an underived surface mechanically.
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

    // NEGATIVE ARM: a model absent from the snapshot cannot be "enabled". Proof that the
    // gate actually filters -- a stub returning all true goes red here.
    it("bos snapshot'ta HICBIR model etkin degildir", () => {
        strictEqual(openAiModelReadiness(snapshotOf([])).some((entry) => entry.enabled), false);
        strictEqual(openAiModelReadiness(undefined).some((entry) => entry.enabled), false);
    });

    // The real accident scenario: sol+terra verified, astra not in the catalog. The two
    // hand-written literals would say "everything is ready" here; the derived list drops
    // astra BY NAME.
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
// FINDING 2 (2026-09-05, independent audit + repeated in this run): the `doctor
// --require-all` OpenAI arm had NO MEASURE. Mutation M1 -- `every` -> `some` inside
// cli.ts -- left the suite GREEN: tests 270, pass 269, fail 0, exit 0. The reason: no test
// imports src/cli.ts. The gate expression was moved into a pure function; each of the arms
// below exists to turn one of those mutations RED.
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

    // The arm that kills M1: when a single model drops, the gate MUST go red.
    it("TEK BIR sozlesme etkisizse kirmizi (every -> some mutasyonunu oldurur)", () => {
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            const readiness = enabledRows.map((entry) => (entry.id === contract.id ? { ...entry, enabled: false } : entry));
            strictEqual(openAiGateReady(readiness), false, `dusen model yakalanmadi: ${contract.id}`);
        }
    });

    // The arm that replaces the counting tautology in the old expression: red when the row is absent entirely.
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

    // If the catalog could not be built at all, --require-all CANNOT return green.
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
// FINDING 1: in the post-release window what dropped was not the NEW model but the working
// sol/terra lane -- and the only string the operator saw ("clodex_session_catalog_drift")
// named neither the model nor either of the two numbers. Measured 2026-09-05: the live
// snapshot carries 828400 for sol/terra, the lock 872000. Below is the unit fixture of that
// same conflict.
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

    // NEGATIVE ARM: in a matching catalog there is NO drift. Without this, the arm above
    // cannot be told apart from "the function always produces rows".
    it("katalog snapshot'la uyusuyorsa surukleme YOK ve kod sade bicimine doner", () => {
        deepStrictEqual(openAiSnapshotRouteDrift(kurulu, catalog(LOCKED)), []);
        strictEqual(clodexCatalogDriftDetailCode([]), "clodex_session_catalog_drift");
    });

    // An empty catalog means "absent", it does NOT mean zero: a missing number is not invented.
    it("katalogda hic olmayan model icin sayi uydurulmaz", () => {
        const drift = openAiSnapshotRouteDrift(kurulu, []);
        strictEqual(drift.length, OPENAI_MODEL_CONTRACTS.length);
        strictEqual(drift.every((entry) => entry.liveContextWindow === undefined), true);
        strictEqual(clodexCatalogDriftDetailCode(drift).includes("=liveabsent"), true);
    });

    // EVEN WITH A 1M ADVERTISEMENT, VERIFICATION LOOKS AT THE LIVE NUMBER (2026-09-05).
    // Astra advertises 1_000_000 to Claude Code, but that number NEVER enters the snapshot
    // -- the advertisement lives only in the discovery projection (src/domain/registry.ts).
    // The price of that distinction is paid exactly here: when the live catalog drops from
    // 872_000 to 272_000 (a reset to the "standard" stop, measured on the 5.6 lane on
    // 2026-09-01) the row is not verified and the drift line writes both numbers by name.
    // Had the advertisement been written into the snapshot this arm would stay GREEN: the
    // policy number would match itself and the detector would be blind.
    it("Astra ilani 1M olsa da canli pencere dususu ADIYLA yakalanir", () => {
        const astra = kurulu.find((model) => model.id === "anthropic-openai-gpt-6-astra");
        ok(astra !== undefined, "astra snapshot satiri yok");
        strictEqual(astra.contextWindow, LOCKED, "snapshot OLCULEN sayiyi tasimali");
        strictEqual(isVerifiedOpenAiSnapshotRoute(astra, catalog(LIVE_DEGRADED)), false, "dusen canli pencere dogrulanmis sayildi");
        const kod = clodexCatalogDriftDetailCode(openAiSnapshotRouteDrift([astra], catalog(LIVE_DEGRADED)));
        strictEqual(kod.includes(`anthropic-openai-gpt-6-astra=live${LIVE_DEGRADED}_snapshot${LOCKED}`), true, kod);
        // POSITIVE ARM: with the live number in place the same row verifies -- so the arm is
        // distinguishable from "always returns false".
        strictEqual(isVerifiedOpenAiSnapshotRoute(astra, catalog(LOCKED)), true);
    });

    // A detector ships with its remedy: a signal that cannot become an action is noise.
    it("readiness caresini tasir ve durumu unavailable'dir", () => {
        const readiness = openAiCatalogDriftReadiness(kurulu, catalog(LIVE_DEGRADED));
        strictEqual(readiness.provider, "openai");
        strictEqual(readiness.status, "unavailable");
        strictEqual(readiness.detailCode?.startsWith("clodex_session_catalog_drift:"), true);
        strictEqual(readiness.remedy?.includes("models refresh"), true);
    });
});
