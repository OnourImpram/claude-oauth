// Faz 1 kapisi: yeniden derlenen dist, temiz referans release ile birebir ayni mi?
// Kullanim: node scripts/sadakat-diff.mjs [referans-dist-dizini]
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
// No machine-specific default: the reference release lives outside this repository,
// so the caller must name it. Guessing a path would make this gate pass or fail for
// reasons that have nothing to do with the build being compared.
const referenceRoot = process.argv[2] ?? process.env["CLAUDE_OAUTH_REFERENCE_DIST"];
if (!referenceRoot) {
  console.error(
    "NOT_RUN: reference dist not given.\n" +
    "  usage: node scripts/sadakat-diff.mjs <reference-dist-dir>\n" +
    "  or set CLAUDE_OAUTH_REFERENCE_DIST to a released dist/src directory."
  );
  process.exit(3);
}
const builtRoot = join(projectRoot, "dist", "src");

// ONARIM: bir dosya burada listeli degilse ve fark ediyorsa, ya derlemede istenmeyen bir
// sapma vardir ya da bilincli bir Faz 2 degisikligi bu deftere yazilmamistir. Farki incele,
// sonra ya kaynagi geri al ya da asagiya gerekcesiyle ekle.
// Her girdi bir Faz 2 kararidir; gerekce girdinin yanindadir.
const DELIBERATE_DIFFERENCES = new Map([
  ["runtime/claude-shadow.js",
    "Faz 1: referans build PARSE EDILEMIYOR (try/catch/finally govde disina dusmus, " +
    "SyntaxError: Illegal return statement). + Faz 2: model-yuzeyi kapisi acildi, " +
    "patch-proof throw'u yapilandirilmis uyariya cevrildi, ham Clodex ciktisi log'a girmiyor."],
  ["runtime/claude-shadow.d.ts",
    "Faz 1: yukaridakiyle ayni dosyanin bildirimi."],
  ["runtime/install-lock.js",
    "Faz 2: verifyClodexPackageLock stub'i gercek dogrulamayla degistirildi (surum + npm SRI + " +
    "entrypoint bayti); sifir-hash artik 'placeholder, self-heal bekleniyor' olarak raporlaniyor."],
  ["runtime/log.d.ts",
    "Faz 2: SafeLogEntry izin listesine 6 alan eklendi (exitCode, patchOutputBytes, " +
    "patchOutputFingerprint, remedy, errorName, stackFrames). Yalniz tip duzeyi -- log.js degismedi."],
  ["cli.js",
    "Faz 2: ham '!!! FATAL ERROR !!!' dokumu yapilandirilmis cli_fatal log'una cevrildi " +
    "(hata MESAJI hic basilmiyor, cerceve yollari ~ ile maskeli); olu probeGemini " +
    "doctor --live'da rapor-only olarak baglandi."],
]);

async function walk(root) {
  const found = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
        found.push(relative(root, full).replaceAll("\\", "/"));
      }
    }
  }
  await visit(root);
  return found.sort();
}

const [referenceFiles, builtFiles] = await Promise.all([walk(referenceRoot), walk(builtRoot)]);
const builtSet = new Set(builtFiles);

let identical = 0;
const differing = [];
const deliberate = [];
const missing = [];

for (const file of referenceFiles) {
  if (!builtSet.has(file)) {
    missing.push(file);
    continue;
  }
  const [a, b] = await Promise.all([
    readFile(join(referenceRoot, file)),
    readFile(join(builtRoot, file)),
  ]);
  if (a.equals(b)) identical += 1;
  else if (DELIBERATE_DIFFERENCES.has(file)) deliberate.push(file);
  else differing.push(file);
}

const extra = builtFiles.filter((file) => !referenceFiles.includes(file));

console.log(`referans dosya : ${referenceFiles.length}`);
console.log(`derlenen dosya : ${builtFiles.length}`);
console.log(`birebir ayni   : ${identical}`);
console.log(`FARKLI         : ${differing.length}`);
console.log(`bilincli fark  : ${deliberate.length}`);
console.log(`HENUZ YOK      : ${missing.length}`);
console.log(`FAZLADAN       : ${extra.length}`);
if (differing.length > 0) console.log("\n-- FARKLI (deftere yazilmamis) --\n" + differing.map((f) => "  " + f).join("\n"));
if (deliberate.length > 0) {
  console.log("\n-- bilincli farklar --");
  for (const file of deliberate) console.log(`  ${file}\n      ${DELIBERATE_DIFFERENCES.get(file)}`);
}
if (extra.length > 0) console.log("\n-- fazladan --\n" + extra.map((f) => "  " + f).join("\n"));
if (missing.length > 0 && process.env["SADAKAT_LIST_MISSING"] === "1") {
  console.log("\n-- henuz yok --\n" + missing.map((f) => "  " + f).join("\n"));
}
process.exit(differing.length > 0 || extra.length > 0 ? 1 : 0);
