import { ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
    AGENT_MODEL_CONTRACTS,
    GROK_AUTO_COMPACT_THRESHOLD_PERCENT,
    GROK_AUTO_COMPACT_WINDOW_TOKENS,
    GROK_46_CONTEXT_WINDOW_TOKENS,
    OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS,
    OPENAI_ASTRA_AUTO_COMPACT_WINDOW_TOKENS,
    OPENAI_AUTO_COMPACT_WINDOW_TOKENS,
    OPENAI_LONG_CONTEXT_PRICING_BOUNDARY_TOKENS,
    OPENAI_MODEL_CONTRACTS,
    autoCompactWindowForModel,
} from "../src/domain/model-contracts.js";
import { claudeRouterEnvironment, requestedModelArgument } from "../src/supervisor/launcher.js";

// Case record: every external model previously fell into Claude Code's "unrecognized
// model" default auto-compaction path, so a Sol session could sail past OpenAI's long
// context pricing boundary and be billed 2x input / 1.5x output for the WHOLE request.
// The windows below are the policy; these tests pin the policy's invariants, not just
// its current numbers.

describe("auto-compaction window policy", () => {
    it("Sol/Terra compact below the OpenAI long-context pricing boundary", () => {
        strictEqual(OPENAI_AUTO_COMPACT_WINDOW_TOKENS < OPENAI_LONG_CONTEXT_PRICING_BOUNDARY_TOKENS, true);
    });

    // The turn that triggers compaction still carries its own tool results. A window
    // hugging the boundary would cross it on the very request meant to prevent that.
    it("Sol/Terra leave at least 50k of headroom for the triggering turn", () => {
        strictEqual(OPENAI_LONG_CONTEXT_PRICING_BOUNDARY_TOKENS - OPENAI_AUTO_COMPACT_WINDOW_TOKENS >= 50_000, true);
    });

    // Two compaction authorities firing near each other double-summarize the history.
    it("Grok compacts before Grok's own internal threshold fires", () => {
        const grokInternalTrigger = Math.floor(GROK_46_CONTEXT_WINDOW_TOKENS * (GROK_AUTO_COMPACT_THRESHOLD_PERCENT / 100));
        strictEqual(GROK_AUTO_COMPACT_WINDOW_TOKENS < grokInternalTrigger, true);
    });

    it("every window fits inside its own model's context window", () => {
        for (const contract of AGENT_MODEL_CONTRACTS) {
            strictEqual(contract.autoCompactWindow <= contract.contextWindow, true);
        }
    });

    // Claude Code rejects a window outside 100k-1M.
    it("every window sits inside the range Claude Code accepts", () => {
        for (const window of [...AGENT_MODEL_CONTRACTS, ...OPENAI_MODEL_CONTRACTS].map((entry) => entry.autoCompactWindow)) {
            strictEqual(window >= 100_000 && window <= 1_000_000, true);
        }
    });

    // ------------------------------------------------------------------
    // Astra (2026-09-05). Astra deliberately compacts ABOVE the 272_000 boundary that
    // governs Sol/Terra, so the first invariant above had to become a PARTITION rather
    // than a blanket rule. Both arms are here: without the positive one, "everything is
    // below the boundary" would still pass on a table where nothing ever moves.
    // ------------------------------------------------------------------
    const astra = OPENAI_MODEL_CONTRACTS.find((contract) => contract.alias === "astra");

    it("Astra sozlesmesi vardir -- yoksa asagidaki bolme anlamsizdir", () => {
        ok(astra !== undefined, "astra sozlesmesi kayip: partition olcmuyor");
    });

    it("Astra DISINDAKI her OpenAI sozlesmesi fiyat sinirinin altinda kompaktlanir", () => {
        for (const contract of OPENAI_MODEL_CONTRACTS.filter((entry) => entry.alias !== "astra")) {
            strictEqual(contract.autoCompactWindow < OPENAI_LONG_CONTEXT_PRICING_BOUNDARY_TOKENS, true, `sinirin ustunde: ${contract.id}`);
        }
    });

    // POZITIF KOL: Astra sinirin USTUNDEDIR ve bu bir kusur degil, olculmus bir istisnadir
    // (ChatGPT Enterprise rate card, "Codex long-context exception"; alinti sozlesmenin
    // contextWindowSource alaninda). Bu kol dusmeye baslarsa istisna kaybolmus demektir.
    it("Astra fiyat sinirinin USTUNDE kompaktlanir -- Codex uzun-baglam istisnasi", () => {
        strictEqual(OPENAI_ASTRA_AUTO_COMPACT_WINDOW_TOKENS > OPENAI_LONG_CONTEXT_PRICING_BOUNDARY_TOKENS, true);
        strictEqual(astra?.autoCompactWindow, OPENAI_ASTRA_AUTO_COMPACT_WINDOW_TOKENS);
        strictEqual(OPENAI_ASTRA_AUTO_COMPACT_WINDOW_TOKENS, 650_000);
    });

    it("hicbir OpenAI penceresi kendi ILAN EDILEN penceresini asmaz", () => {
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            const ilan = contract.advertisedContextWindow ?? contract.contextWindow;
            strictEqual(contract.autoCompactWindow <= ilan, true, `ilanini asiyor: ${contract.id}`);
        }
    });

    // ASIL RISK, ve tek gercek olcusu. Ilan edilen 1_000_000 bir POLITIKA sayisidir;
    // upstream'in fiilen kabul ettigi tavan config/install-lock.json'daki pindir (bugun
    // 872_000, clodex 2.11.1'in Astra tohumu). Kompaktlama penceresi ilanin altinda ama
    // pinin USTUNDE olsaydi -- ornegin 900_000 -- oturum clodex'in gercek duragini asar ve
    // bunu hicbir sey soylemezdi. Sayi burada elle yazilmaz, kilitten OKUNUR.
    it("her OpenAI kompaktlama penceresi GERCEK ust sinirin (install-lock pini) altindadir", async (t) => {
        const repoRoot = resolve(import.meta.dirname, "..", "..");
        let pin: number;
        try {
            const lock = JSON.parse(await readFile(join(repoRoot, "config", "install-lock.json"), "utf8")) as {
                readonly claudeShadow?: { readonly openAiContextWindow?: number };
            };
            const value = lock.claudeShadow?.openAiContextWindow;
            if (typeof value !== "number")
                throw new Error("claudeShadow.openAiContextWindow yok");
            pin = value;
        }
        catch (error) {
            // Kanit grameri: kosamayan kontrol sessiz gecis DEGILDIR, sebebiyle atlanir.
            t.skip(`config/install-lock.json okunamadi: ${(error as Error).message}`);
            return;
        }
        for (const contract of OPENAI_MODEL_CONTRACTS) {
            strictEqual(contract.autoCompactWindow < pin, true, `pin ${pin} asiliyor: ${contract.id} = ${contract.autoCompactWindow}`);
        }
        // Ilan pinin USTUNDE olmak zorunda, yoksa bu degisikligin sebebi yok.
        strictEqual(OPENAI_ASTRA_ADVERTISED_CONTEXT_WINDOW_TOKENS > pin, true, "ilan pinin ustunde degil: degisiklik etkisiz");
    });
});

describe("autoCompactWindowForModel", () => {
    it("resolves a picker alias", () => {
        strictEqual(autoCompactWindowForModel("sol"), OPENAI_AUTO_COMPACT_WINDOW_TOKENS);
        strictEqual(autoCompactWindowForModel("grok"), GROK_AUTO_COMPACT_WINDOW_TOKENS);
    });

    it("resolves a full snapshot id", () => {
        strictEqual(autoCompactWindowForModel("anthropic-openai-gpt-5.6-terra"), OPENAI_AUTO_COMPACT_WINDOW_TOKENS);
    });

    // Astra artik AILE sabitini paylasmiyor: alias da tam kimlik de kendi sayisini vermeli.
    // Paylasilan sabite geri dusen bir cozumleyici sessizce 220_000 dondururdu.
    it("Astra kendi penceresini cozer, aile sabitini degil", () => {
        strictEqual(autoCompactWindowForModel("astra"), OPENAI_ASTRA_AUTO_COMPACT_WINDOW_TOKENS);
        strictEqual(autoCompactWindowForModel("anthropic-openai-gpt-6-astra"), OPENAI_ASTRA_AUTO_COMPACT_WINDOW_TOKENS);
        strictEqual(autoCompactWindowForModel("astra") === OPENAI_AUTO_COMPACT_WINDOW_TOKENS, false);
    });

    it("resolves the [1m] suffixed form the picker emits", () => {
        strictEqual(autoCompactWindowForModel("sol[1m]"), OPENAI_AUTO_COMPACT_WINDOW_TOKENS);
    });

    it("resolves the new Gemini 3.1 Pro row", () => {
        strictEqual(autoCompactWindowForModel("gemini-pro") !== undefined, true);
    });

    // THE point of returning undefined: this variable OVERRIDES the operator's own
    // autoCompactWindow setting. Answering for a Claude model would silently disable it.
    it("returns undefined for Claude models so the operator's setting still governs", () => {
        for (const model of ["opus", "sonnet", "haiku", "fable", "claude-opus-5", "opus[1m]"]) {
            strictEqual(autoCompactWindowForModel(model), undefined);
        }
    });

    it("returns undefined for an unknown or empty model", () => {
        strictEqual(autoCompactWindowForModel("no-such-model"), undefined);
        strictEqual(autoCompactWindowForModel("   "), undefined);
    });
});

describe("requestedModelArgument", () => {
    it("reads the separated form", () => {
        strictEqual(requestedModelArgument(["--print", "--model", "sol", "hi"]), "sol");
    });

    it("reads the joined form", () => {
        strictEqual(requestedModelArgument(["--model=grok"]), "grok");
    });

    it("takes the last --model, matching the CLI's own behaviour", () => {
        strictEqual(requestedModelArgument(["--model", "sol", "--model", "terra"]), "terra");
    });

    it("returns undefined when no model was requested", () => {
        strictEqual(requestedModelArgument(["--print", "hello"]), undefined);
    });

    // "--model --print" must not swallow the next flag as a model name.
    it("does not treat a following flag as the model value", () => {
        strictEqual(requestedModelArgument(["--model", "--print"]), undefined);
    });
});

describe("claudeRouterEnvironment auto-compaction wiring", () => {
    const base = (): NodeJS.ProcessEnv => ({ PATH: process.env["PATH"] ?? "" });

    it("sets the window for an external model", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:1/", "n".repeat(64), base(), "sol");
        strictEqual(environment["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], String(OPENAI_AUTO_COMPACT_WINDOW_TOKENS));
    });

    it("sets Grok's own window, not a shared one", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:1/", "n".repeat(64), base(), "grok");
        strictEqual(environment["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], String(GROK_AUTO_COMPACT_WINDOW_TOKENS));
    });

    it("leaves the variable unset for a Claude model", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:1/", "n".repeat(64), base(), "opus");
        strictEqual(environment["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], undefined);
    });

    it("leaves the variable unset when no model was requested", () => {
        const environment = claudeRouterEnvironment("http://127.0.0.1:1/", "n".repeat(64), base(), undefined);
        strictEqual(environment["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], undefined);
    });

    // REGRESSION ARM: an inherited value must be removed, not left standing. Launching
    // Claude from a shell that had run Sol would otherwise retarget the Claude session
    // to Sol's 200k threshold without anything saying so.
    it("deletes an inherited value when the model does not define one", () => {
        const source = { ...base(), CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" };
        const environment = claudeRouterEnvironment("http://127.0.0.1:1/", "n".repeat(64), source, "opus");
        strictEqual(environment["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], undefined);
    });
});
