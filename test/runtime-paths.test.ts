import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runtimePaths } from "../src/runtime/paths.js";

// VAKA KAYDI (BULGU 6, 2026-09-05, bagimsiz denetim): `shadow/patch-state-2.8.2` ->
// `shadow/patch-state` yeniden adlandirmasinin HICBIR olcusu yoktu --
// `grep -rn shadowPatchBackups test/` sifir sonuc veriyordu. Yola gomulen bir surum
// numarasi ilk yukseltmede yalan soyler: kurulu `patch-state.json` hala eski dizini
// gosteriyor ve claude-shadow.ts assertPathInside onu artik DISARIDA sayiyor (503).
// Kod okumasi kendini onaran bir yol gosteriyor (bayat manifest -> pristine reset ->
// yeniden yamalama), ama kural olculmediginde curur ve bunu haber vermez.
//
// Eski dizindeki pristine yedek OKSUZ kalir. Silmek OPERATORUN karari: bu test onu
// olcmez, silme de onermez.

const BASE = process.platform === "win32" ? "C:\\hezarfen-olcum" : "/hezarfen-olcum";
const paths = runtimePaths({ LOCALAPPDATA: BASE });

// Bir yol parcasina gomulmus surum numarasi: "patch-state-2.8.2", "claude-2.1.251"...
const YOLDA_SURUM = /(?:^|[^0-9])\d+\.\d+\.\d+(?:[^0-9]|$)/u;

describe("runtimePaths -- surum yola gomulmez", () => {
    it("TWEAKCC yedek dizini surum tasimayan sabit addir", () => {
        strictEqual(paths.shadowPatchBackups, join(paths.root, "shadow", "patch-state"));
    });

    it("hicbir calisma-zamani yolu surum numarasi tasimaz", () => {
        const tasiyanlar = Object.entries(paths)
            .filter(([, value]) => typeof value === "string" && YOLDA_SURUM.test(value))
            .map(([key]) => key);
        deepStrictEqual(tasiyanlar, []);
    });

    // POZITIF KONTROL: yukaridaki kol bos cikti uretiyor olabilir. Olcut, kaldirilan
    // ADI FIILEN yakaliyor mu? Yakalamiyorsa test kuralin adini olcuyor demektir,
    // kuralin kendisini degil.
    it("olcut kaldirilan eski adi (patch-state-2.8.2) yakalar", () => {
        strictEqual(YOLDA_SURUM.test(join(paths.root, "shadow", "patch-state-2.8.2")), true);
        strictEqual(YOLDA_SURUM.test(paths.shadowPatchBackups), false);
    });

    it("her yol calisma-zamani kokunun altinda kalir", () => {
        for (const [key, value] of Object.entries(paths)) {
            if (typeof value !== "string" || key === "root" || key === "ipc")
                continue;
            strictEqual(value.startsWith(paths.root), true, `kok disina cikan yol: ${key}`);
        }
    });
});
