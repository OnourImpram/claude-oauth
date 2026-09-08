import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { reportedBuildCommitMatches, reportedVersionMatches, requireInstallChecks, sideProviderInstallDrift, type InstallLock, verifyClodexPackageLock } from "../src/runtime/install-lock.js";

// REGRESYON: verifyClodexPackageLock kosulsuz { status: "ok" } donen bir STUB'di.
// lock.clodex.integrity ve entrypointSha256 hicbir zaman okunmadi -- ve olculdugunde
// entrypointSha256'nin diskteki HICBIR dosyaya karsilik gelmedigi ortaya cikti.
// Olculmeyen bir alan sessizce curur ve bunu kimseye haber vermez.

const PACKAGE = "@bman654/clodex";
let moduleRoot = "";
let lock: InstallLock;
let entrypointDigest = "";

async function writeTree(options: {
    readonly version: string;
    readonly integrity: string;
    readonly entrypointBody: string;
    readonly omitPackage?: boolean;
    readonly omitInstallerRecord?: boolean;
}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "clodex-lock-"));
    if (options.omitPackage !== true) {
        const packageRoot = join(root, "node_modules", PACKAGE, "dist");
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(root, "node_modules", PACKAGE, "package.json"), JSON.stringify({ name: PACKAGE, version: options.version }), "utf8");
        await writeFile(join(packageRoot, "cli.js"), options.entrypointBody, "utf8");
    }
    if (options.omitInstallerRecord !== true) {
        await mkdir(join(root, "node_modules"), { recursive: true });
        await writeFile(join(root, "node_modules", ".package-lock.json"), JSON.stringify({
            packages: { [`node_modules/${PACKAGE}`]: { version: options.version, integrity: options.integrity } },
        }), "utf8");
    }
    return root;
}

before(async () => {
    const { createHash } = await import("node:crypto");
    entrypointDigest = createHash("sha256").update("export const cli = 1;\n").digest("hex").toUpperCase();
    lock = {
        schemaVersion: 1,
        clodex: {
            package: PACKAGE,
            version: "2.11.1",
            integrity: `sha512-${"A".repeat(88)}`,
            entrypointSha256: entrypointDigest,
            localPatch: "config/claude-oauth-local-patches.mjs",
            localPatchSha256: "0".repeat(64),
        },
    } as unknown as InstallLock;
    moduleRoot = await writeTree({ version: "2.11.1", integrity: lock.clodex.integrity, entrypointBody: "export const cli = 1;\n" });
});

after(async () => {
    await rm(moduleRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("verifyClodexPackageLock", () => {
    it("surum, SRI ve entrypoint bayti tutuyorsa ok doner", async () => {
        const check = await verifyClodexPackageLock(lock, moduleRoot);
        strictEqual(check.status, "ok");
        strictEqual(check.detailCode, "locked_bytes_and_reported_version_match");
    });

    // Asagidaki dordu, stub'in HIC yapmadigi kontrollerdir. Her biri bir negatif kontrol.
    it("paket surumu sapinca drift bildirir", async () => {
        const root = await writeTree({ version: "9.9.9", integrity: lock.clodex.integrity, entrypointBody: "export const cli = 1;\n" });
        const check = await verifyClodexPackageLock(lock, root);
        strictEqual(check.status, "drift");
        strictEqual(check.detailCode, "locked_package_version_mismatch");
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("npm SRI sapinca drift bildirir", async () => {
        const root = await writeTree({ version: "2.11.1", integrity: `sha512-${"B".repeat(88)}`, entrypointBody: "export const cli = 1;\n" });
        const check = await verifyClodexPackageLock(lock, root);
        strictEqual(check.status, "drift");
        strictEqual(check.detailCode, "locked_package_integrity_mismatch");
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("entrypoint bayti degisince drift bildirir", async () => {
        const root = await writeTree({ version: "2.11.1", integrity: lock.clodex.integrity, entrypointBody: "export const cli = 2;\n" });
        const check = await verifyClodexPackageLock(lock, root);
        strictEqual(check.status, "drift");
        strictEqual(check.detailCode, "locked_package_entrypoint_hash_mismatch");
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("paket hic yoksa missing bildirir", async () => {
        const root = await writeTree({ version: "2.11.1", integrity: lock.clodex.integrity, entrypointBody: "", omitPackage: true });
        const check = await verifyClodexPackageLock(lock, root);
        strictEqual(check.status, "missing");
        strictEqual(check.detailCode, "locked_package_missing");
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("kurulum kaydi yoksa missing bildirir", async () => {
        const root = await writeTree({ version: "2.11.1", integrity: lock.clodex.integrity, entrypointBody: "export const cli = 1;\n", omitInstallerRecord: true });
        const check = await verifyClodexPackageLock(lock, root);
        strictEqual(check.status, "missing");
        strictEqual(check.detailCode, "locked_package_installer_record_missing");
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("hicbir dalda hata firlatmaz: bozuk manifest bile rapora donusur", async () => {
        const root = await writeTree({ version: "2.11.1", integrity: lock.clodex.integrity, entrypointBody: "export const cli = 1;\n" });
        await writeFile(join(root, "node_modules", PACKAGE, "package.json"), "bu JSON degil", "utf8");
        const check = await verifyClodexPackageLock(lock, root);
        strictEqual(check.status, "drift");
        strictEqual(check.detailCode, "locked_package_manifest_unreadable");
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
});

describe("reportedVersionMatches", () => {
    it("cikti icindeki tam surumu bulur", () => {
        strictEqual(reportedVersionMatches("clodex v2.11.1", "2.11.1"), true);
        strictEqual(reportedVersionMatches("2.1.251 (Claude Code)", "2.1.251"), true);
    });

    it("kismi eslesmeyi surum saymaz", () => {
        strictEqual(reportedVersionMatches("2.11.10", "2.11.1"), false);
        strictEqual(reportedVersionMatches("12.11.1", "2.11.1"), false);
        strictEqual(reportedVersionMatches("", "2.11.1"), false);
        // Yukseltmenin kendi negatif kolu: eski surum artik ESLESMEZ. Kurgu agac
        // surumle birlikte tasinmazsa kapi "her surumu kabul ediyor" olabilir ve
        // bunu kimse fark etmez.
        strictEqual(reportedVersionMatches("clodex v2.8.2", "2.11.1"), false);
    });
});

describe("kurulu agac", () => {
    // Bu, birim testi degil, kilidin GERCEK agaci tarif ettiginin kanitidir.
    // entrypointSha256 tam olarak boyle bir kontrol olmadigi icin bayatlamisti.
    it("depodaki config/install-lock.json gercek node_modules ile tutarlidir", async (t) => {
        const repoRoot = resolve(import.meta.dirname, "..", "..");
        let real: InstallLock;
        try {
            real = JSON.parse(await readFile(join(repoRoot, "config", "install-lock.json"), "utf8")) as InstallLock;
            await access(join(repoRoot, "node_modules", PACKAGE, "package.json"));
        }
        catch {
            t.skip("kurulu node_modules yok (temiz checkout)");
            return;
        }
        const check = await verifyClodexPackageLock(real, repoRoot);
        strictEqual(check.status, "ok", check.detailCode);
    });
});

// Vaka kaydi: kilitteki `sourceCommit` aylarca ZORUNLU ama HIC OKUNMAYAN bir alandi --
// bicimi dogrulaniyor, degeri hicbir kapiyla karsilastirilmiyordu. Grok kendi build
// commit'ini `--version` ciktisinda duyurdugu icin alan aslinda olculebilirdi.
// Ayni surum etiketini tasiyan iki farkli build'i ayiran sey tam olarak budur.
describe("reportedBuildCommitMatches", () => {
    const output = "grok 1.0.13 (5e9a58528b76)";

    it("kilitteki kisa commit'i tanir", () => {
        strictEqual(reportedBuildCommitMatches(output, "5e9a58528b76"), true);
    });

    it("kilit tam commit tasiyorsa kisa cikti yine eslesir", () => {
        strictEqual(reportedBuildCommitMatches(output, "5e9a58528b76aaaaaaaaaaaaaaaaaaaaaaaaaaaa"), true);
    });

    // NEGATIF KOL: kapinin firlayabildiginin kaniti. Ayni surum, baska build.
    it("BASKA bir commit'i reddeder", () => {
        strictEqual(reportedBuildCommitMatches(output, "77cd7eb675ba"), false);
    });

    it("commit tasimayan ciktiyi reddeder", () => {
        strictEqual(reportedBuildCommitMatches("grok 1.0.13", "5e9a58528b76"), false);
    });

    it("buyuk/kucuk harf farkini yok sayar", () => {
        strictEqual(reportedBuildCommitMatches(output, "5E9A58528B76"), true);
    });
});

// A4 (2026-09-02): yan saglayici civisi ana yolu kapatmaz. Ayni gun uc kez yasanan
// olayin birim kaniti: antigravity surukledi -> eskiden adapter_unavailable, claude yok.
describe("sideProviderInstallDrift", () => {
    const check = (component: "node" | "claude" | "claude-shadow" | "clodex" | "grok" | "gemini" | "antigravity", status: "ok" | "missing" | "drift", detailCode = "x") =>
        ({ component, expectedVersion: "1", status, detailCode });

    it("yan saglayici ihlalini saglayici adiyla dondurur, firlatmaz", () => {
        const drift = sideProviderInstallDrift(
            [check("claude", "ok"), check("antigravity", "drift", "locked_manifest_hash_mismatch"), check("grok", "ok")],
            ["antigravity", "grok"],
        );
        deepStrictEqual(drift, [{ component: "antigravity", provider: "google", status: "drift", detailCode: "locked_manifest_hash_mismatch" }]);
    });

    it("istenmeyen bileseni saymaz; temiz kurulumda bos doner", () => {
        deepStrictEqual(sideProviderInstallDrift([check("grok", "drift")], ["antigravity"]), []);
        deepStrictEqual(sideProviderInstallDrift([check("grok", "ok"), check("antigravity", "ok")], ["grok", "antigravity"]), []);
    });

    // NEGATIF KOL: ana yol bileseni yan saglayici DEGILDIR -- burada yumusamaz,
    // requireInstallChecks hala firlatir. Iki kapinin ayrimi tam olarak budur.
    it("ana yol bilesenini (claude/clodex) asla yumusatmaz", () => {
        deepStrictEqual(sideProviderInstallDrift([check("claude", "drift"), check("clodex", "missing")], ["claude", "clodex"]), []);
        throws(() => requireInstallChecks([check("claude", "drift")], ["claude"]), /Pinned installation verification failed: claude/u);
    });
});

// VAKA KAYDI (2026-09-05): kilitteki `localPatchSha256` ile DEPODAKI yerel yama
// dosyasini karsilastiran hicbir kontrol yoktu. Yamayi duzeltip kilidi guncellemeyi
// unutmak `npm run check`ten YESIL geciyordu; sapma ancak calisan kurulumda 503 olarak
// goruluyordu. 06-Altyapi/scripts/civi-surukleme-kontrolu.py RELEASE'i olcer, depoyu
// degil -- yani bu bosluk baska hicbir kapinin kapsaminda degildi.
describe("depo kilidi <-> depo yerel yamasi", () => {
    it("install-lock.json localPatchSha256 depodaki yama dosyasinin ozetidir", async () => {
        const { createHash } = await import("node:crypto");
        const repoRoot = resolve(import.meta.dirname, "..", "..");
        const real = JSON.parse(await readFile(join(repoRoot, "config", "install-lock.json"), "utf8")) as InstallLock;
        const bytes = await readFile(join(repoRoot, real.clodex.localPatch));
        const digest = createHash("sha256").update(bytes).digest("hex").toUpperCase();
        strictEqual(digest, real.clodex.localPatchSha256.toUpperCase(), "kilit ile yama dosyasi ayrismis");
        // POZITIF KONTROL: enstruman fiilen ayirt ediyor mu? Bos cikti kanit degildir.
        const mutated = createHash("sha256").update(Buffer.concat([bytes, Buffer.from("\n")])).digest("hex").toUpperCase();
        strictEqual(mutated === real.clodex.localPatchSha256.toUpperCase(), false, "ozet degisiklige duyarsiz");
    });
});
