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

// VAKA KAYDI -- bu sinif bir gunde DORT kez tekrarladi. Her seferinde bir yuzey
// AGENT_MODEL_CONTRACTS'tan turetilmek yerine elle yazilmisti, ve her seferinde
// sozlesmeye model eklemek o yuzeyi SESSIZCE disarida birakti:
//
//   1. yerel yamadaki alias dogrulayicisi  -> picker'da gorunen, dogrulayicinin reddettigi model
//   2. cli.ts'teki Antigravity yoklama listesi -> hic yoklanmayan, snapshot'a hic giren model
//   3. Antigravity izin listesi            -> "model_not_available" diye YEREL bir ret,
//                                             upstream reddi gibi raporlanan
//   4. delege ajan adlandirmasi            -> ucuncu Google modelinde IKI ajan ayni adi alip
//                                             biri sessizce eziliyordu
//
// Bu dosya o sinifin mekanik olcusudur: turetilmemis her yuzey burada kirmizi yanar.

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

    // NEGATIF KOL: liste sozlesmelerin OTESINE gecmemeli -- guvenlik kontrolu odur.
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

    // Asil defekt buydu: iki sozlesme ayni adi uretince Object.fromEntries birini
    // sessizce eziyor ve o model delege edilemez hale geliyordu.
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
    // Native binary alias tanimaz: yamali picker icin uretilen "sol" gibi degerler
    // native yolda unrecognized_model verir. Delege tanimi TAM kimlik tasimalidir.
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
// ILAN EDILEN BAGLAM PENCERESI (2026-09-05, Astra 1M).
//
// Claude Code'a ulasan TEK pencere alani GET /v1/models cevabidir: gateway-models.json
// yalniz {id, display_name} tasir ve CLAUDE_CODE_AUTO_COMPACT_WINDOW sozlesmeden gelir.
// Bu blok o yuzeyi olcer: ilan sozlesmeden turer, snapshot'taki OLCULEN sayi bozulmadan
// kalir, ve sozlesmesiz hicbir satir ilan almaz.
// ============================================================================

// clodex 2.11.1'in Astra tohumu ve 5.6 ailesinin "max" duragi: 872_000. Bu sayinin
// config/install-lock.json'daki pinle ayni oldugunun MEKANIK kaniti burada degil,
// test/auto-compact-window.test.ts'in kilit-okuyan kolundadir; burada gereken tek sey
// ilan edilen sayidan FARKLI olmasi -- yoksa ustune yazma gorunmez olurdu.
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

// Tek Astra satiri fabrikasi: iki describe de bunu kullanir. `contextWindow` ustune
// yazilabilir olmak zorunda -- `[1m]` ekinin GERCEK tetikleyicisi odur (asagi bak).
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

    // KANIT GRAMERI: ilan bir POLITIKA sayisidir, olcum degil. Snapshot olcumun kaydidir
    // ve ustune yazilmaz -- yazilsaydi surukleme dedektoru kendi kendisiyle eslesirdi.
    it("snapshot'taki Astra satiri OLCULEN canli sayiyi korur, ilan edileni degil", () => {
        const astra = dogrulanmisSnapshot.models.find((model) => model.id === "anthropic-openai-gpt-6-astra");
        strictEqual(astra?.contextWindow, CANLI_PENCERE);
    });

    // NEGATIF KOL: ustune yazma Astra'ya OZELDIR. Sol/Terra ilan edilen sayiyi degil
    // olculen sayiyi gosterir; sizsaydi iki model yanlis butceyle calisirdi.
    //
    // ONARIM 2026-09-05 (denetim BULGU 2). Dongu eskiden
    // `.filter((entry) => entry.advertisedContextWindow === undefined)` uzerinde donuyordu --
    // yani tam olarak KORUDUGU degisiklik sinifi filtreyi bosaltiyordu. OLCULDU (bu kosum,
    // staging): ilan Sol ve Terra sozlesmelerine de eklendiginde dongu boyu 0'a dustu, kol
    // YESIL kaldi ve uc modelin ucu birden 1_000_000 ilan eder oldu. Sizintiyi yakalayan tek
    // kol tablo BICIMINI denetleyendi; davranisi denetleyen bu kol degildi.
    //
    // Iki degisiklik: suzgec ALIAS'tan tureniyor (ilan sizsa da dongu ayni satirlari gezer)
    // ve kapsam iddiasi one yaziliyor -- bos kume artik sessiz gecis degil, kirmizi.
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

    // ONARIM 2026-09-05 (denetim BULGU 1). Bu kolun eski yorumu "birisi ilani tavana
    // esitlerse picker satirinin adi sessizce degisir ve bu kol kirmizi yanar" diyordu.
    // OLCULDU (bu kosum, staging): ilan 1_050_000'e cikarildi, kimlik
    // `anthropic-openai-gpt-6-astra` KALDI, kol YESIL yandi. claudeClientDiscoveryId
    // `model.contextWindow`a -- yani SNAPSHOT sayisina -- bakar; ilan edilen sayiyi hic
    // gormez, ve gormedigi icin de degistiremez.
    //
    // Kolun simdi olctugu sey gercek olan degismezdir: kimlik snapshot penceresinden turer.
    // Uc negatif arti BIR POZITIF kol; pozitif olmadan "ek takilmadi" ile "alet bozuk"
    // ayni goruntuyu verirdi. Ilanin 1_000_000'da tutulmasi ayri bir kolun isi ("Astra
    // 1_000_000 ilan eder"), cunku gerekcesi picker degil: yuvarlak sayi ve tavan altinda pay.
    it("picker kimligi SNAPSHOT penceresinden turer, ilan edilenden DEGIL", () => {
        const kimlikler = kesifSatirlari(dogrulanmisSnapshot).map((entry) => String(entry["id"]));
        strictEqual(kimlikler.includes("anthropic-openai-gpt-6-astra"), true);
        strictEqual(kimlikler.includes("anthropic-openai-gpt-6-astra[1m]"), false);
        strictEqual(claudeClientDiscoveryId(astraSatiri()), "anthropic-openai-gpt-6-astra");

        // POZITIF KOL -- ek GERCEKTEN takilabiliyor, ve tetikleyicisi snapshot penceresinin
        // sozlesme tavanina esitlenmesi. Bu kol dusmezse yukaridaki uc negatif kol bir sey
        // olcmuyor demektir.
        strictEqual(claudeClientDiscoveryId(astraSatiri({ contextWindow: OPENAI_CONTEXT_WINDOW_TOKENS })), "anthropic-openai-gpt-6-astra[1m]");
    });

    // NEGATIF KOL: snapshot'a girmemis model ILAN DA EDILEMEZ. Sozlesmedeki sabit tek
    // basina bir picker satiri uretemez -- dogrulama hala kapinin kendisidir.
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

    // Penceresi olmayan satira pencere UYDURULMAZ: eksik olcum sifir degildir.
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

    // NEGATIF KOL: kimlik yetmez. Sozlesmenin upstream modeline yonlenmeyen bir satir
    // Astra'nin ilanini devralamaz -- devralsaydi, baska bir yere giden bir istek
    // Astra'nin butcesiyle kurulurdu.
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

    // Kaynaksiz bir ustune yazma folklordur: sayiyi kimse dogrulayamaz, kimse silemez.
    it("ilan eden her sozlesme KAYNAGINI tasir, etmeyen tasimaz", () => {
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            const ilanVar = contract.advertisedContextWindow !== undefined;
            strictEqual((contract.contextWindowSource ?? "").length > 0, ilanVar, `kaynak/ilan eslesmiyor: ${contract.id}`);
        }
    });

    // Kaynak notu bir dize degil ALINTIDIR: birincil sayfayi ve alinan atomu adiyla anar.
    it("Astra'nin kaynak notu birincil sayfayi ve alintiyi tasir", () => {
        const astra = OPENAI_MODEL_CONTRACTS.find((contract) => contract.alias === "astra");
        const kaynak = astra?.contextWindowSource ?? "";
        strictEqual(kaynak.includes("developers.openai.com/api/docs/models/gpt-6-astra"), true, "model karti yok");
        strictEqual(kaynak.includes("1,050,000 context window"), true, "model kartindan alinti yok");
        strictEqual(kaynak.includes("272K input tokens"), true, "fiyat siniri istisnasi yok");
    });

    // ONARIM 2026-09-05 (denetim BULGU 4). Rate card cumlesindeki em dash ASCII "--"ye
    // indirilmisti ve indirgeme TIRNAK ICINDE, isaretlenmeden yapilmisti. Depo ASCII-only
    // degil (olculdu: src/ test/ scripts/ altinda 11 dosya zaten U+A7/U+B7/U+FC tasiyor),
    // yani dogru onarim dipnot degil karakterin kendisi. Kol iki yonlu: dogru karakter VAR
    // ve indirgenmis bicim YOK -- tek yonlu olsaydi "ikisi de yok" durumu sessizce gecerdi.
    it("rate card alintisi em dash'i BIREBIR tasir, ASCII'ye indirilmemis", () => {
        const astra = OPENAI_MODEL_CONTRACTS.find((contract) => contract.alias === "astra");
        const kaynak = astra?.contextWindowSource ?? "";
        strictEqual(kaynak.includes("GPT-6 Astra \u2014 Codex long-context exception"), true, "em dash ASCII'ye indirilmis");
        strictEqual(kaynak.includes("GPT-6 Astra -- Codex long-context exception"), false, "ASCII indirgemesi geri gelmis");
    });

    // Ilan sozlesmenin TAVANINI asamaz: openAiCatalogEntry canli sayiyi o tavanla eler,
    // ve tavanin ustunde bir ilan Claude Code'a modelin reddedecegi bir butce verirdi.
    it("hicbir ilan sozlesme tavanini asmaz", () => {
        // SINIF SUPURGESI (BULGU 2 ile ayni kalip): `continue` iceren bir dongu de bos
        // kumede sessizce gecer. Sayac, kolun neyi olctugunu iddia eder.
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
// OPERATOR YUZEYI (denetim BULGU 3, 2026-09-05)
//
// `claude-oauth models --refresh` ve `claude-oauth doctor` model satirlarini ELLE, iki
// ayri yerde ve birbirinin ayni kurup YALNIZ olculen pencereyi basiyordu. Astra icin o
// sayi 872_000; Claude Code'a soylenen 1_000_000. Somut kaza: dogru bir release civilenir,
// ana oturum refleksle `doctor` kosar, 872_000 gorur ve "degisiklik girmemis" sonucuna
// varir. Ilan edilen sayinin gorunur oldugu tek yer calisan routerin GET /v1/models ucuydu.
// ============================================================================

describe("operator yuzeyi olculen ve ilan edilen sayiyi AYRI adlarla gosterir", () => {
    it("Astra satiri iki sayiyi da tasir", () => {
        const astra = dogrulanmisSnapshot.models.find((model) => model.id === "anthropic-openai-gpt-6-astra");
        ok(astra !== undefined, "astra snapshot satiri yok");
        const satir = modelDetail(astra);
        strictEqual(satir["contextWindow"], CANLI_PENCERE, "olculen sayi kayboldu");
        strictEqual(satir["advertisedContextWindow"], OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS, "ilan edilen sayi basilmiyor");
    });

    // Alan YALNIZ iki sayi farkliyken yazilir. "872000 = 872000" tekrari operatore hicbir
    // sey soylemez ve gurultuyle birlikte gelen sey korluktur.
    it("ilani olmayan satirda alan HIC yazilmaz", () => {
        const sol = dogrulanmisSnapshot.models.find((model) => model.id === "anthropic-openai-gpt-5.6-sol");
        ok(sol !== undefined, "sol snapshot satiri yok");
        const satir = modelDetail(sol);
        strictEqual(satir["contextWindow"], CANLI_PENCERE);
        strictEqual("advertisedContextWindow" in satir, false, "gereksiz alan yazildi");
    });

    // MEKANIK KOL. Yukaridaki iki kol yardimciyi olcer; bu kol cli.ts'in onu FIILEN
    // kullandigini olcer. Satirlar bir kez elle yazilmisti ve iki yerde birden bozuldu --
    // yeniden elle yazilirsa burasi kirmizi yanar, sessizce eski davranisa donmez.
    it("cli.ts her modelDetails satirini bu yardimcidan uretir", async (t) => {
        const cliPath = resolve(import.meta.dirname, "..", "..", "src", "cli.ts");
        let kaynak: string;
        try {
            kaynak = await readFile(cliPath, "utf8");
        }
        catch (error) {
            // Kanit grameri: kosamayan kontrol sessiz gecis DEGILDIR, sebebiyle atlanir.
            t.skip(`src/cli.ts okunamadi: ${(error as Error).message}`);
            return;
        }
        const satirlar = [...kaynak.matchAll(/modelDetails:\s*([^\r\n]*)/g)].map((eslesme) => eslesme[1] ?? "");
        ok(satirlar.length >= 2, `kapsam: modelDetails satiri beklenenden az (${satirlar.length})`);
        for (const satir of satirlar)
            strictEqual(satir.includes("map(modelDetail)"), true, `elle yazilmis modelDetails satiri: ${satir}`);
    });
});
