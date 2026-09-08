// clean.mjs -- derleme ciktisini siler. tsc bayat dosyalari kaldirmaz; kaynaktan bir modul
// silindiginde eski .js dist'te kalir ve import edilmeye devam eder.
//
// ONARIM: bu betik dist/ disinda hicbir seye dokunmaz. Silme reddedilirse dist'i acik bir
// surec tutuyordur (calisan bir claude oturumu) -- once onu kapat.
import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve(import.meta.dirname, "..", "dist");
let existed = false;
try { await stat(target); existed = true; } catch { /* zaten yok */ }
await rm(target, { recursive: true, force: true });
console.log(existed ? `silindi: ${target}` : `zaten yoktu: ${target}`);
