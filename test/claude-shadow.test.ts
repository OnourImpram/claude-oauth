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
    it("is non-empty and every entry is a non-empty string", () => {
        strictEqual(SHADOW_MODEL_SURFACE_NEEDLES.length > 0, true);
        for (const needle of SHADOW_MODEL_SURFACE_NEEDLES) {
            strictEqual(typeof needle === "string" && needle.length > 0, true);
        }
    });

    it("includes the Google model surface marker", () => {
        strictEqual(SHADOW_MODEL_SURFACE_NEEDLES.some((needle) => needle.includes("hezarfen-google-oauth-model-surface")), true);
    });

    // DRIFT GATE: if a model is added to the contract and its picker line is forgotten, a
    // model appears that is invisible in /model but present in the snapshot -- or the
    // reverse. Both sides are tied together here.
    it("every external model contract has a picker needle and a resolver needle", () => {
        for (const contract of AGENT_MODEL_CONTRACTS) {
            const picker = `{value:${JSON.stringify(contract.alias)},`;
            const resolver = `case${JSON.stringify(contract.alias)}:return ${JSON.stringify(contract.alias)};`;
            strictEqual(SHADOW_MODEL_SURFACE_NEEDLES.some((needle) => needle.startsWith(picker)), true, `missing picker needle: ${contract.alias}`);
            strictEqual(SHADOW_MODEL_SURFACE_NEEDLES.includes(resolver), true, `missing resolver needle: ${contract.alias}`);
        }
    });
});

// The local patch file and the needle list are two copies of the same truth; if they
// diverge, the patched binary cannot pass the gate and the system never comes up at all.
// This catches that divergence at build time.
describe("local patch <-> needle consistency", () => {
    it("every picker row in the needles is also defined in the patch file", async () => {
        const patchPath = resolve(process.cwd(), "config", "claude-oauth-local-patches.mjs");
        const patchSource = await readFile(patchPath, "utf8");
        for (const contract of AGENT_MODEL_CONTRACTS) {
            strictEqual(patchSource.includes(`alias: ${JSON.stringify(contract.alias)}`), true, `alias missing from patch: ${contract.alias}`);
            strictEqual(patchSource.includes(`fullId: ${JSON.stringify(contract.id)}`), true, `fullId missing from patch: ${contract.id}`);
        }
    });

    it("the context window in the patch matches the contract", async () => {
        const patchPath = resolve(process.cwd(), "config", "claude-oauth-local-patches.mjs");
        const patchSource = await readFile(patchPath, "utf8");
        for (const contract of AGENT_MODEL_CONTRACTS) {
            const grouped = contract.contextWindow.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, "_");
            strictEqual(patchSource.includes(`contextWindow: ${grouped}`), true, `context window missing from patch: ${contract.alias} = ${grouped}`);
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
describe("the local patch anchor matches the shape clodex ACTUALLY produces", () => {
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
        strictEqual(patch !== undefined, true, "local patch file is empty");
        return patch?.apply(source, { marker: MARKER }) ?? "";
    }

    function missingNeedles(patched: string): readonly string[] {
        return SHADOW_MODEL_SURFACE_NEEDLES
            .filter((needle) => patched.split(needle).length - 1 !== 1)
            .map((needle) => `${needle.slice(0, 48)} x${patched.split(needle).length - 1}`);
    }

    // Today's configuration: providerId "openai-oauth".
    it("every needle occurs EXACTLY ONCE in output with providerId openai-oauth", async () => {
        const patched = await applyLocalPatch(clodexPatched("openai-oauth", [SOL, TERRA]));
        deepStrictEqual(missingNeedles(patched), []);
    });

    // It must hold when Astra is added too: the anchor must not depend on the NUMBER of OpenAI aliases.
    it("the anchor still matches when a third OpenAI alias (astra) is added", async () => {
        const patched = await applyLocalPatch(clodexPatched("openai-oauth", [SOL, TERRA, ASTRA]));
        deepStrictEqual(missingNeedles(patched), []);
    });

    // ...and it must not depend on ORDER either: the order in the favourites file is the operator's to set.
    it("the anchor still matches when alias order changes (astra first)", async () => {
        const patched = await applyLocalPatch(clodexPatched("openai-oauth", [ASTRA, SOL, TERRA]));
        deepStrictEqual(missingNeedles(patched), []);
    });

    // Backwards compatible: a binary produced with the old providerId is accepted too.
    it("also matches output with the old providerId (openai)", async () => {
        const patched = await applyLocalPatch(clodexPatched("openai", [SOL, TERRA]));
        deepStrictEqual(missingNeedles(patched), []);
    });

    // NEGATIVE ARM: if clodex's own PATCH 5/6 never ran, the anchor is ABSENT and the patch
    // MUST NOT inject the picker/resolver lines. Without this arm the four above cannot be
    // told apart from "the patch writes everything into everything".
    it("picker/resolver rows ARE NOT INJECTED into source without an anchor", async () => {
        const patched = await applyLocalPatch('function r4(t5){return w2.includes(t5)}switch(n){case"best":{return "opus"}default:return n}');
        const leaked = SHADOW_MODEL_SURFACE_NEEDLES.filter((needle) => needle !== MARKER && patched.includes(needle));
        deepStrictEqual(leaked, []);
    });

    // FINDING 3 (2026-09-05): the resolver anchor demanded `case"sol":return "sol";`, which
    // tied the GOOGLE and xAI lanes to which OpenAI models the operator happened to keep
    // enabled. Probe V5 measured it: without sol, all four resolver needles went to x0.
    // Two unrelated lanes must not share the same fate.
    it("the anchor still matches when sol is ABSENT from CLODEX_HOME (astra+terra)", async () => {
        const patched = await applyLocalPatch(clodexPatched("openai-oauth", [ASTRA, TERRA]));
        deepStrictEqual(missingNeedles(patched), []);
    });

    it("also matches when only one OpenAI alias is present", async () => {
        const patched = await applyLocalPatch(clodexPatched("openai-oauth", [TERRA]));
        deepStrictEqual(missingNeedles(patched), []);
    });

    // FINDING 4: the anchor was widened and `replaceExactly` never tested the NUMBER of
    // matches. In a source carrying two clodex-shaped picker arrays all four needles land at
    // x2, and verifyShadowModelSurface only rejects that afterwards, unable to say why. Now
    // the patch fails ITSELF, and BY NAME.
    it("with TWO picker arrays the patch REJECTS instead of injecting twice", async () => {
        const twoPickerArrays = `${clodexPatched("openai-oauth", [SOL, TERRA])}\n[{value:"x",label:"X",description:"Custom model (clodex:openai-oauth:x)"}].forEach(function(_o){if(!k8.some(function(_i){return _i.value===_o.value}))k8.push(_o)});`;
        await rejects(async () => { await applyLocalPatch(twoPickerArrays); }, /anchor "model-picker" matched 2 times/u);
    });
});

describe("verifyShadowModelSurface (synthetic)", () => {
    it("accepts when every needle occurs EXACTLY ONCE", async () => {
        const path = await syntheticBinary("complete.bin", SHADOW_MODEL_SURFACE_NEEDLES.join("\n"));
        await verifyShadowModelSurface(path);
    });

    // NEGATIVE ARM: an unpatched binary. Proof that the gate can throw.
    it("REJECTS when no needles are present", async () => {
        const path = await syntheticBinary("empty.bin", "content that behaves like an unpatched binary");
        await rejects(async () => { await verifyShadowModelSurface(path); }, /model-picker proof/u);
    });

    it("rejects even when only ONE needle is missing", async () => {
        const path = await syntheticBinary("missing.bin", SHADOW_MODEL_SURFACE_NEEDLES.slice(1).join("\n"));
        await rejects(async () => { await verifyShadowModelSurface(path); }, /model-picker proof/u);
    });

    // Occurring twice is a defect as well: applying the patch twice duplicates the picker.
    it("rejects when a needle occurs TWICE", async () => {
        const first = SHADOW_MODEL_SURFACE_NEEDLES[0] ?? "";
        const path = await syntheticBinary("duplicate.bin", [...SHADOW_MODEL_SURFACE_NEEDLES, first].join("\n"));
        await rejects(async () => { await verifyShadowModelSurface(path); }, /model-picker proof/u);
    });

    it("the error message identifies the missing needle and the ONARIM remedy path", async () => {
        const path = await syntheticBinary("diagnosis.bin", "nothing");
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

describe("verifyShadowModelSurface (real binaries)", () => {
    // This arm measures the ENVIRONMENT, not the code's contract: the synthetic arms
    // already prove both directions of the gate. If the installed shadow was produced from
    // a VALID local patch it MUST carry the needles, and if it does not, that is a real
    // defect. But if the manifest says it is stale, it is waiting to be re-patched; turning
    // the test red in that case destroys the meaning of the alarm -- so it is skipped with
    // its reason.
    it("accepts the installed patched shadow", async (t) => {
        const { access, readFile } = await import("node:fs/promises");
        try { await access(SHADOW); }
        catch { t.skip("patched shadow is not installed on this machine"); return; }
        const lock = JSON.parse(await readFile(resolve(process.cwd(), "config", "install-lock.json"), "utf8")) as { clodex: { localPatchSha256: string } };
        let installedPatchSha = "";
        try {
            const manifest = JSON.parse(await readFile(join(process.env["LOCALAPPDATA"] ?? "", "Hezarfen", "claude-oauth", "shadow", "current.json"), "utf8")) as { clodex?: { localPatchSha256?: string } };
            installedPatchSha = manifest.clodex?.localPatchSha256 ?? "";
        }
        catch { installedPatchSha = ""; }
        if (installedPatchSha.toUpperCase() !== lock.clodex.localPatchSha256.toUpperCase()) {
            t.skip(`installed shadow was built from a stale local patch (manifest=${installedPatchSha.slice(0, 12)} lock=${lock.clodex.localPatchSha256.slice(0, 12)}); awaiting re-patching`);
            return;
        }
        await verifyShadowModelSurface(SHADOW);
    });

    it("the unpatched native binary IS REJECTED", async (t) => {
        const { access } = await import("node:fs/promises");
        try { await access(NATIVE); }
        catch { t.skip("native Claude is not installed on this machine"); return; }
        await rejects(async () => { await verifyShadowModelSurface(NATIVE); }, /model-picker proof/u);
    });
});
