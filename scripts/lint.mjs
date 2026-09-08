// lint.mjs -- bu depoda eslint yok; kural setini derleyicinin yakalamadigi ve bu olayda
// FIILEN zarar vermis desenlere daralttik. Her kural bir vaka kaydidir, stil tercihi degil.
//
// ONARIM: bir bulgu ciktida dosya:satir olarak gosterilir. Bilerek yapiyorsan satirin
// sonuna `// lint-izin: <gerekce>` ekle -- gerekcesiz izin kabul edilmez.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCAN = ["src", "test", "scripts"];

const RULES = [
  {
    id: "ham-hata-dokumu",
    // cli.ts bir zamanlar console.error("!!! FATAL ERROR !!!", caught) yapiyordu. Hata
    // MESAJLARI oturum nonce'u tasiyan URL'ler icerebilir; yapilandirilmis log kullan.
    pattern: /console\.(?:error|log|warn)\s*\([^)]*\b(?:caught|error|err)\b\s*\)/g,
    message: "ham hata nesnesi konsola basiliyor; writeSafeLog kullan (mesaj sizdirabilir)",
    kanarya: 'console.error("bir sey oldu", caught)',
  },
  {
    id: "yoruma-alinmis-kapi",
    // verifyShadowModelSurface ve patch-proof throw'lari aylarca yorumda kaldi ve
    // hicbir sey bunu bildirmedi.
    pattern: /^\s*\/\/\s*throw new RouterError/gm,
    message: "yorum satirina alinmis throw: kapi sessizce devre disi",
    kanarya: "    // throw new RouterError(\"x\", \"y\", 503);",
  },
  {
    id: "korumasiz-spawn",
    // spawn hatasi asenkron 'error' olayidir; dinleyicisiz kalirsa SURECI DUSURUR.
    pattern: /\bspawn\s*\(/g,
    message: "spawn: ayni modulde spawnFailureGuard ya da child.once(\"error\") olmali",
    check: (source) => !/spawnFailureGuard|\.once\("error"/.test(source),
    kanarya: "const child = spawn(binary, args, options);",
  },
  {
    id: "kosulsuz-ok-donduren-dogrulayici",
    // verifyClodexPackageLock kosulsuz status:"ok" donen bir stub'di; alan hic olculmedi.
    pattern: /function\s+verify[A-Z]\w*\([^)]*\)\s*:\s*Promise<InstallCheck>\s*\{\s*return\s*\{[^}]*status:\s*"ok"/g,
    message: "dogrulayici kosulsuz ok donuyor: stub kapi",
    kanarya: 'function verifyThing(lock: InstallLock): Promise<InstallCheck> { return { component: "x", status: "ok" };',
  },
];

async function collect(directory) {
  const found = [];
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith(".")) await visit(path); }
      else if (/\.(?:ts|mts|mjs|js)$/.test(entry.name)) found.push(path);
    }
  }
  await visit(join(ROOT, directory));
  return found;
}

// Kural tablosu kurallarin kendi metnini icerir; bu dosyayi taramak her yeni kural icin
// bir yalanci bulgu uretir. "Bir tarama kendi desenini eslesebilir" -- tarayici kendini taramaz.
// Pozitif kontrol: bos cikti kanit degildir. Her kural, kendi sentetik kanaryasini
// yakalayabildigini kanitlamadan gecerli sayilmaz.
if (process.argv.includes("--ozdenetim")) {
  let failed = 0;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const fires = (rule.check === undefined || rule.check(rule.kanarya)) && rule.pattern.test(rule.kanarya);
    console.log(`  ${fires ? "GECTI" : "DUSTU"}  ${rule.id}`);
    if (!fires) failed += 1;
  }
  console.log(`ozdenetim: ${RULES.length - failed}/${RULES.length} kural kanaryasini yakaladi`);
  process.exit(failed === 0 ? 0 : 1);
}

const SELF = join(ROOT, "scripts", "lint.mjs");
const files = (await Promise.all(SCAN.map(collect))).flat().filter((path) => path !== SELF);
const findings = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  const lines = source.split("\n");
  for (const rule of RULES) {
    if (rule.check && !rule.check(source)) continue;
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(source)) !== null) {
      const line = source.slice(0, match.index).split("\n").length;
      if ((lines[line - 1] ?? "").includes("lint-izin:")) continue;
      findings.push({ path: relative(ROOT, file).split(sep).join("/"), line, rule: rule.id, message: rule.message });
    }
  }
}

console.log(`taranan dosya : ${files.length}`);
console.log(`kural         : ${RULES.length}`);
console.log(`BULGU         : ${findings.length}`);
for (const finding of findings) console.log(`  ${finding.path}:${finding.line}  [${finding.rule}] ${finding.message}`);
process.exit(findings.length > 0 ? 1 : 0);
