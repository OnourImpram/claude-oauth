import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { SHADOW_MODEL_SURFACE_NEEDLES, verifyShadowModelSurface } from "../src/runtime/claude-shadow.js";
import { AGENT_MODEL_CONTRACTS } from "../src/domain/model-contracts.js";
import { readFile } from "node:fs/promises";


// This is the only place where the system ACTUALLY verifies the patched binary: it looks
// at the strings inside the binary, not at Clodex's own text report. Its throw sat
// commented out for months -- that is, the gate existed but never closed.
//
// If the real shadow and native binaries are present on this machine the test uses them
// too; otherwise both arms of the gate are still proven with synthetic binaries.

const SHADOW = join(process.env["LOCALAPPDATA"] ?? "", "Hezarfen", "claude-oauth", "shadow", "claude-2.1.251-8D1229A2", "claude.exe");
const NATIVE = join(process.env["USERPROFILE"] ?? "", ".local", "bin", "claude.exe");

let directory = "";

before(async () => {
    directory = await mkdtemp(join(tmpdir(), "shadow-surface-"));
});

after(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function syntheticBinary(name: string, body: string): Promise<string> {
    const path = join(directory, name);
    await writeFile(path, body, "utf8");
    return path;
}

describe("SHADOW_MODEL_SURFACE_NEEDLES", () => {
    it("bos degil ve her girdi bos olmayan bir string", () => {
        strictEqual(SHADOW_MODEL_SURFACE_NEEDLES.length > 0, true);
        for (const needle of SHADOW_MODEL_SURFACE_NEEDLES) {
            strictEqual(typeof needle === "string" && needle.length > 0, true);
        }
    });

    it("google model yuzeyi isaretcisini icerir", () => {
        strictEqual(SHADOW_MODEL_SURFACE_NEEDLES.some((needle) => needle.includes("hezarfen-google-oauth-model-surface")), true);
    });

    // DRIFT GATE: if a model is added to the contract and its picker line is forgotten, a
    // model appears that is invisible in /model but present in the snapshot -- or the
    // reverse. Both sides are tied together here.
    it("her harici model sozlesmesinin bir picker ve bir resolver needle'i vardir", () => {
        for (const contract of AGENT_MODEL_CONTRACTS) {
            const picker = `{value:${JSON.stringify(contract.alias)},`;
            const resolver = `case${JSON.stringify(contract.alias)}:return ${JSON.stringify(contract.alias)};`;
            strictEqual(SHADOW_MODEL_SURFACE_NEEDLES.some((needle) => needle.startsWith(picker)), true, `picker needle yok: ${contract.alias}`);
            strictEqual(SHADOW_MODEL_SURFACE_NEEDLES.includes(resolver), true, `resolver needle yok: ${contract.alias}`);
        }
    });
});

// The local patch file and the needle list are two copies of the same truth; if they
// diverge, the patched binary cannot pass the gate and the system never comes up at all.
// This catches that divergence at build time.
describe("yerel yama <-> needle tutarliligi", () => {
    it("needle'daki her picker satiri yama dosyasinda da tanimlidir", async () => {
        const patchPath = resolve(process.cwd(), "config", "claude-oauth-local-patches.mjs");
        const patchSource = await readFile(patchPath, "utf8");
        for (const contract of AGENT_MODEL_CONTRACTS) {
            strictEqual(patchSource.includes(`alias: ${JSON.stringify(contract.alias)}`), true, `yamada alias yok: ${contract.alias}`);
            strictEqual(patchSource.includes(`fullId: ${JSON.stringify(contract.id)}`), true, `yamada fullId yok: ${contract.id}`);
        }
    });

    it("yamadaki baglam penceresi sozlesmeyle ayni", async () => {
        const patchPath = resolve(process.cwd(), "config", "claude-oauth-local-patches.mjs");
        const patchSource = await readFile(patchPath, "utf8");
        for (const contract of AGENT_MODEL_CONTRACTS) {
            const grouped = contract.contextWindow.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, "_");
            strictEqual(patchSource.includes(`contextWindow: ${grouped}`), true, `yamada baglam penceresi yok: ${contract.alias} = ${grouped}`);
        }
    });
});

// An anchor always goes stale SILENTLY: the patcher's output changes, the regex stops
// matching, the patch injects nothing, and a 503 arrives the day someone switches to
// `patched-shadow` mode. This block breaks that silence: it runs the patch against the
// shape clodex ACTUALLY produces.
//
// The shapes were READ from clodex 2.11.1 dist/cli.js (2026-09-05):
//   PATCH 6 -> `"case" + q(alias) + ":return " + q(alias) + ";"`
//   PATCH 5 -> `"{value:"+q(alias)+",label:"+q(Cap)+",description:"+q(display)+"}"`,
//              joined with `,` into `[...]`, then `.forEach(function(_o){...});`
//   display default -> `Custom model (clodex:${providerId}:${modelId})`
// providerId comes from CLODEX_HOME/config.json and TODAY it is "openai-oauth"; the anchor
// expected "openai", and the value measured in the installed shadow confirmed this
// ("clodex:openai:gpt-5.6-sol" x1, "clodex:openai-oauth:..." x0).
describe("yerel yama capasi clodex'in FIILEN urettigi bicime tutunur", () => {
    function clodexPatched(providerId: string, aliases: readonly (readonly [string, string])[]): string {
        const cases = aliases.map(([alias]) => `case"${alias}":return "${alias}";`).join("");
        const rows = aliases
            .map(([alias, model]) => `{value:"${alias}",label:"${alias[0]?.toUpperCase() ?? ""}${alias.slice(1)}",description:"Custom model (clodex:${providerId}:${model})"}`)
            .join(",");
        return [
            `z.enum(["sonnet","opus","haiku","fable",${aliases.map(([alias]) => `"${alias}"`).join(",")}]).optional().describe(\`Optional model override\`)`,
            `var q9=["sonnet","opus","haiku","fable","opusplan"],w2=["sonnet","opus","haiku","fable","opusplan"];var e3="x";function r4(t5){return w2.includes(t5)}`,
            `switch(n){case"best":{return "opus"}${cases}default:return n}`,
            `[${rows}].forEach(function(_o){if(!k7.some(function(_i){return _i.value===_o.value}))k7.push(_o)});`,
            `function ctxw(e){/*ccpatch:ctx*/return 200000}`,
        ].join("\n");
    }

    const MARKER = "/*clodex-local:hezarfen-google-oauth-model-surface*/";
    const SOL: readonly [string, string] = ["sol", "gpt-5.6-sol"];
    const TERRA: readonly [string, string] = ["terra", "gpt-5.6-terra"];
    const ASTRA: readonly [string, string] = ["astra", "gpt-6-astra"];

    async function applyLocalPatch(source: string): Promise<string> {
        const patchPath = resolve(process.cwd(), "config", "claude-oauth-local-patches.mjs");
        const loaded = (await import(pathToFileURL(patchPath).href)) as { default: readonly { apply(source: string, context: { marker: string }): string }[] };
        const patch = loaded.default[0];
        strictEqual(patch !== undefined, true, "yerel yama dosyasi bos");
        return patch?.apply(source, { marker: MARKER }) ?? "";
    }

    function missingNeedles(patched: string): readonly string[] {
        return SHADOW_MODEL_SURFACE_NEEDLES
            .filter((needle) => patched.split(needle).length - 1 !== 1)
            .map((needle) => `${needle.slice(0, 48)} x${patched.split(needle).length - 1}`);
    }

    // Today's configuration: providerId "openai-oauth".
    it("providerId openai-oauth ciktisinda her needle TAM BIR KEZ olusur", async () => {
        const patched = await applyLocalPatch(clodexPatched("openai-oauth", [SOL, TERRA]));
        deepStrictEqual(missingNeedles(patched), []);
    });

    // It must hold when Astra is added too: the anchor must not depend on the NUMBER of OpenAI aliases.
    it("ucuncu OpenAI alias'i (astra) eklenince capa hala tutar", async () => {
        const patched = await applyLocalPatch(clodexPatched("openai-oauth", [SOL, TERRA, ASTRA]));
        deepStrictEqual(missingNeedles(patched), []);
    });

    // ...and it must not depend on ORDER either: the order in the favourites file is the operator's to set.
    it("alias sirasi degisince (astra once) capa hala tutar", async () => {
        const patched = await applyLocalPatch(clodexPatched("openai-oauth", [ASTRA, SOL, TERRA]));
        deepStrictEqual(missingNeedles(patched), []);
    });

    // Backwards compatible: a binary produced with the old providerId is accepted too.
    it("eski providerId (openai) ciktisinda da tutar", async () => {
        const patched = await applyLocalPatch(clodexPatched("openai", [SOL, TERRA]));
        deepStrictEqual(missingNeedles(patched), []);
    });

    // NEGATIVE ARM: if clodex's own PATCH 5/6 never ran, the anchor is ABSENT and the patch
    // MUST NOT inject the picker/resolver lines. Without this arm the four above cannot be
    // told apart from "the patch writes everything into everything".
    it("capasiz kaynakta picker/resolver satiri ENJEKTE EDILMEZ", async () => {
        const patched = await applyLocalPatch('function r4(t5){return w2.includes(t5)}switch(n){case"best":{return "opus"}default:return n}');
        const leaked = SHADOW_MODEL_SURFACE_NEEDLES.filter((needle) => needle !== MARKER && patched.includes(needle));
        deepStrictEqual(leaked, []);
    });

    // FINDING 3 (2026-09-05): the resolver anchor demanded `case"sol":return "sol";`, which
    // tied the GOOGLE and xAI lanes to which OpenAI models the operator happened to keep
    // enabled. Probe V5 measured it: without sol, all four resolver needles went to x0.
    // Two unrelated lanes must not share the same fate.
    it("sol CLODEX_HOME'da YOKKEN (astra+terra) capa yine tutar", async () => {
        const patched = await applyLocalPatch(clodexPatched("openai-oauth", [ASTRA, TERRA]));
        deepStrictEqual(missingNeedles(patched), []);
    });

    it("tek bir OpenAI alias'i varken de tutar", async () => {
        const patched = await applyLocalPatch(clodexPatched("openai-oauth", [TERRA]));
        deepStrictEqual(missingNeedles(patched), []);
    });

    // FINDING 4: the anchor was widened and `replaceExactly` never tested the NUMBER of
    // matches. In a source carrying two clodex-shaped picker arrays all four needles land at
    // x2, and verifyShadowModelSurface only rejects that afterwards, unable to say why. Now
    // the patch fails ITSELF, and BY NAME.
    it("IKI picker dizisi varsa yama cift enjeksiyon yapmak yerine REDDEDER", async () => {
        const iki = `${clodexPatched("openai-oauth", [SOL, TERRA])}\n[{value:"x",label:"X",description:"Custom model (clodex:openai-oauth:x)"}].forEach(function(_o){if(!k8.some(function(_i){return _i.value===_o.value}))k8.push(_o)});`;
        await rejects(async () => { await applyLocalPatch(iki); }, /anchor "model-picker" matched 2 times/u);
    });
});

describe("verifyShadowModelSurface (sentetik)", () => {
    it("her needle TAM BIR KEZ varsa kabul eder", async () => {
        const path = await syntheticBinary("tam.bin", SHADOW_MODEL_SURFACE_NEEDLES.join("\n"));
        await verifyShadowModelSurface(path);
    });

    // NEGATIVE ARM: an unpatched binary. Proof that the gate can throw.
    it("hicbir needle yoksa REDDEDER", async () => {
        const path = await syntheticBinary("bos.bin", "yamasiz bir ikili gibi davranan icerik");
        await rejects(async () => { await verifyShadowModelSurface(path); }, /model-picker proof/u);
    });

    it("TEK BIR needle eksikse bile reddeder", async () => {
        const path = await syntheticBinary("eksik.bin", SHADOW_MODEL_SURFACE_NEEDLES.slice(1).join("\n"));
        await rejects(async () => { await verifyShadowModelSurface(path); }, /model-picker proof/u);
    });

    // Occurring twice is a defect as well: applying the patch twice duplicates the picker.
    it("bir needle IKI kez geciyorsa reddeder", async () => {
        const first = SHADOW_MODEL_SURFACE_NEEDLES[0] ?? "";
        const path = await syntheticBinary("ikili.bin", [...SHADOW_MODEL_SURFACE_NEEDLES, first].join("\n"));
        await rejects(async () => { await verifyShadowModelSurface(path); }, /model-picker proof/u);
    });

    it("hata mesaji hangi needle'in kactigini ve ONARIM yolunu soyler", async () => {
        const path = await syntheticBinary("teshis.bin", "hicbir sey");
        await rejects(
            async () => { await verifyShadowModelSurface(path); },
            (error: unknown) => {
                const message = (error as Error).message;
                strictEqual(/needle\[\d+\] x0/u.test(message), true);
                strictEqual(message.includes("ONARIM:"), true);
                return true;
            },
        );
    });
});

describe("verifyShadowModelSurface (gercek ikililer)", () => {
    // This arm measures the ENVIRONMENT, not the code's contract: the synthetic arms
    // already prove both directions of the gate. If the installed shadow was produced from
    // a VALID local patch it MUST carry the needles, and if it does not, that is a real
    // defect. But if the manifest says it is stale, it is waiting to be re-patched; turning
    // the test red in that case destroys the meaning of the alarm -- so it is skipped with
    // its reason.
    it("kurulu yamali shadow kabul edilir", async (t) => {
        const { access, readFile } = await import("node:fs/promises");
        try { await access(SHADOW); }
        catch { t.skip("yamali shadow bu makinede kurulu degil"); return; }
        const lock = JSON.parse(await readFile(resolve(process.cwd(), "config", "install-lock.json"), "utf8")) as { clodex: { localPatchSha256: string } };
        let installedPatchSha = "";
        try {
            const manifest = JSON.parse(await readFile(join(process.env["LOCALAPPDATA"] ?? "", "Hezarfen", "claude-oauth", "shadow", "current.json"), "utf8")) as { clodex?: { localPatchSha256?: string } };
            installedPatchSha = manifest.clodex?.localPatchSha256 ?? "";
        }
        catch { installedPatchSha = ""; }
        if (installedPatchSha.toUpperCase() !== lock.clodex.localPatchSha256.toUpperCase()) {
            t.skip(`kurulu shadow bayat yerel yamadan uretilmis (manifest=${installedPatchSha.slice(0, 12)} kilit=${lock.clodex.localPatchSha256.slice(0, 12)}); yeniden yamalama bekliyor`);
            return;
        }
        await verifyShadowModelSurface(SHADOW);
    });

    it("yamasiz native REDDEDILIR", async (t) => {
        const { access } = await import("node:fs/promises");
        try { await access(NATIVE); }
        catch { t.skip("native claude bu makinede kurulu degil"); return; }
        await rejects(async () => { await verifyShadowModelSurface(NATIVE); }, /model-picker proof/u);
    });
});
