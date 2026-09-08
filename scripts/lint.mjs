// lint.mjs -- there is no eslint in this repository; the rule set is narrowed to the
// patterns the compiler does not catch and that ACTUALLY did damage in this incident.
// Every rule is a case record, not a style preference.
//
// FIX: a finding is shown in the output as file:line. If you are doing it deliberately,
// append `// lint-izin: <reason>` to the line -- an exemption without a reason is not accepted.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCAN = ["src", "test", "scripts"];

const RULES = [
  {
    id: "ham-hata-dokumu",
    // cli.ts once did console.error("!!! FATAL ERROR !!!", caught). Error MESSAGES can
    // contain URLs carrying the session nonce; use structured logging instead.
    pattern: /console\.(?:error|log|warn)\s*\([^)]*\b(?:caught|error|err)\b\s*\)/g,
    message: "ham hata nesnesi konsola basiliyor; writeSafeLog kullan (mesaj sizdirabilir)",
    kanarya: 'console.error("bir sey oldu", caught)',
  },
  {
    id: "yoruma-alinmis-kapi",
    // The verifyShadowModelSurface and patch-proof throws stayed commented out for
    // months and nothing reported it.
    pattern: /^\s*\/\/\s*throw new RouterError/gm,
    message: "yorum satirina alinmis throw: kapi sessizce devre disi",
    kanarya: "    // throw new RouterError(\"x\", \"y\", 503);",
  },
  {
    id: "korumasiz-spawn",
    // A spawn failure is an asynchronous 'error' event; with no listener it DROPS THE PROCESS.
    pattern: /\bspawn\s*\(/g,
    message: "spawn: ayni modulde spawnFailureGuard ya da child.once(\"error\") olmali",
    check: (source) => !/spawnFailureGuard|\.once\("error"/.test(source),
    kanarya: "const child = spawn(binary, args, options);",
  },
  {
    id: "kosulsuz-ok-donduren-dogrulayici",
    // verifyClodexPackageLock was a stub returning status:"ok" unconditionally; the field
    // was never measured.
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

// The rule table contains the text of the rules themselves; scanning this file would
// produce one false finding per new rule. "A scan can match its own pattern" -- the
// scanner does not scan itself.
// Positive control: empty output is not evidence. No rule counts as valid until it has
// proven it can catch its own synthetic canary.
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
