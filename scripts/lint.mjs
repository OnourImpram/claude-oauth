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
// An exemption is a deliberate, signed decision. It has to look like one: a real
// trailing comment carrying a reason a reader can weigh. Measured 2026-09-07 (red
// team N3): a bare `// lint-izin:` and the bare string "lint-izin:" inside the
// offending call both silenced findings, so the gate could be switched off by
// accident and, in the second case, without even a comment.
function exemptionAccepted(lineText) {
  const exemption = /\/\/[^\n]*\blint-izin:[ \t]*(\S[^\n]*)/.exec(lineText);
  return exemption !== null && (exemption[1] ?? "").trim().length >= 8;
}

if (process.argv.includes("--ozdenetim")) {
  let failed = 0;
  const arm = (name, ok) => {
    console.log(`  ${ok ? "GECTI" : "DUSTU"}  ${name}`);
    if (!ok) failed += 1;
  };
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const fires = (rule.check === undefined || rule.check(rule.kanarya)) && rule.pattern.test(rule.kanarya);
    arm(rule.id, fires);
  }
  // Negative controls for the exemption format itself. Each arm is a shape that
  // used to silence a finding and must no longer.
  arm("muafiyet: gerekceli yorum KABUL", exemptionAccepted('  foo(); // lint-izin: burada hata nesnesi degil yol basiliyor'));
  arm("muafiyet: bos gerekce RED", !exemptionAccepted("  foo(); // lint-izin:"));
  arm("muafiyet: tek kelimelik gerekce RED", !exemptionAccepted("  foo(); // lint-izin: ok"));
  arm("muafiyet: dize icindeki etiket RED", !exemptionAccepted('  console.error("lint-izin: bu bir dize, yorum degil", caught)'));
  // And for the comment blanking: a rule condition must not be satisfiable by a
  // comment that installs nothing.
  arm("koruma: yorum icindeki spawnFailureGuard SAYILMAZ",
    !/spawnFailureGuard/.test(codeOnly("const c = spawn(x);\n// spawnFailureGuard\n")));
  arm("koruma: gercek cagri SAYILIR",
    /spawnFailureGuard/.test(codeOnly("const c = spawn(x);\nspawnFailureGuard(c);\n")));
  arm("koruma: dize icindeki .once(\"error\") KORUNUR (dedektor kor edilmedi)",
    /\.once\("error"/.test(codeOnly('child.once("error", handler);')));
  arm("bosaltma satir hizasini bozmaz",
    codeOnly("a();\n/* iki\nsatir */\nb();").split("\n").length === "a();\n/* iki\nsatir */\nb();".split("\n").length);
  console.log(`ozdenetim: ${failed === 0 ? "hepsi gecti" : failed + " kol dustu"}`);
  process.exit(failed === 0 ? 0 : 1);
}

// N3/N4 (red team, 2026-09-07): both holes were the same hole. A bare
// `// lint-izin:` with no reason silenced a finding, the literal string
// "lint-izin:" inside the offending call silenced it too, and a lone
// `// spawnFailureGuard` comment satisfied the spawn rule without installing a
// listener. A gate that a COMMENT can switch off is a gate that switches itself
// off. Comments are therefore blanked before a rule's file-level condition is
// evaluated. String bodies are NOT blanked: the spawn rule recognises its guard
// by the literal `.once("error"`, and blanking that string blinded a detector
// that worked -- the string-shaped hole is closed by the exemption format below
// instead. Blanked, not deleted, so every line and column still lines up with
// the source.
function codeOnly(source) {
  let out = "";
  let index = 0;
  const blank = (text) => text.replace(/[^\n]/g, " ");
  while (index < source.length) {
    const rest = source.slice(index);
    const line = /^\/\/[^\n]*/.exec(rest);
    if (line) { out += blank(line[0]); index += line[0].length; continue; }
    const block = /^\/\*[\s\S]*?\*\//.exec(rest);
    if (block) { out += blank(block[0]); index += block[0].length; continue; }
    out += source[index];
    index += 1;
  }
  return out;
}

const SELF = join(ROOT, "scripts", "lint.mjs");
const files = (await Promise.all(SCAN.map(collect))).flat().filter((path) => path !== SELF);
const findings = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  const code = codeOnly(source);
  const lines = source.split("\n");
  for (const rule of RULES) {
    if (rule.check && !rule.check(code)) continue;
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(source)) !== null) {
      const line = source.slice(0, match.index).split("\n").length;
      if (exemptionAccepted(lines[line - 1] ?? "")) continue;
      findings.push({ path: relative(ROOT, file).split(sep).join("/"), line, rule: rule.id, message: rule.message });
    }
  }
}

console.log(`taranan dosya : ${files.length}`);
console.log(`kural         : ${RULES.length}`);
console.log(`BULGU         : ${findings.length}`);
for (const finding of findings) console.log(`  ${finding.path}:${finding.line}  [${finding.rule}] ${finding.message}`);
process.exit(findings.length > 0 ? 1 : 0);
