// secret-scan.mjs -- looks for secret-shaped values in the source tree.
//
// FIX: a finding is reported as LOCATION and TYPE; the VALUE is never printed. Open the
// finding, move the value into an env variable or under 06-Altyapi/secrets/, leave a
// process.env read in its place in the source, then run this scan again.
//
// "Empty output is not evidence": --ozdenetim injects a synthetic canary and proves the
// channel actually fires. A gate does not count as valid without its negative control.

import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCAN_DIRECTORIES = ["src", "test", "scripts", "config"];
const SCAN_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".json", ".ps1", ".cmd"];

// Each rule is one secret CLASS. The name enters the report; the matched text does not.
const RULES = [
  ["openai_api_key", /\bsk-[A-Za-z0-9_-]{20,}/g],
  ["anthropic_api_key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["xai_api_key", /\bxai-[A-Za-z0-9]{20,}/g],
  ["google_api_key", /\bAIza[A-Za-z0-9_-]{30,}/g],
  ["google_oauth_token", /\bya29\.[A-Za-z0-9._-]{20,}/g],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["aws_access_key_id", /\bAKIA[0-9A-Z]{16}\b/g],
  ["private_key_block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./g],
  ["bearer_literal", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}/g],
  ["inline_credential_assignment", /\b(?:password|passwd|secret|client_secret|api_key|apikey|access_token|refresh_token)\s*[:=]\s*["'][^"'\s]{12,}["']/gi],
];

// Deliberate acceptances. Every entry states WHY it is safe; adding an entry without a
// reason is punching a silent hole in the gate.
const ACCEPTED = [
  [/^config\/install-lock\.json$/, "surum sabitleme: sha256 hex ve npm SRI -- ikisi de acik artefakt ozeti, sir degil"],
];

function isAccepted(relativePath) {
  return ACCEPTED.some(([pattern]) => pattern.test(relativePath.split("\\").join("/")));
}

async function collect(directory) {
  const found = [];
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
        await visit(path);
      }
      else if (SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(path);
    }
  }
  await visit(join(ROOT, directory));
  return found;
}

function scanText(text) {
  const hits = [];
  for (const [name, pattern] of RULES) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      hits.push({ rule: name, line: text.slice(0, match.index).split("\n").length });
    }
  }
  return hits;
}

const selfCheck = process.argv.includes("--ozdenetim");

if (selfCheck) {
  // Positive control: prove the channel fires. The canary is synthetic, not a real secret.
  const canary = ["sk-", "A".repeat(32)].join("") + "\n" + ["xai-", "B".repeat(24)].join("");
  const hits = scanText(canary);
  const rules = new Set(hits.map((hit) => hit.rule));
  const ok = rules.has("openai_api_key") && rules.has("xai_api_key");
  console.log(`ozdenetim: sentetik kanarya ${ok ? "YAKALANDI" : "KACIRILDI"} (${[...rules].join(", ") || "hicbir kural atesle" + "medi"})`);
  process.exit(ok ? 0 : 1);
}

const files = (await Promise.all(SCAN_DIRECTORIES.map(collect))).flat();
const findings = [];
let acceptedCount = 0;
for (const file of files) {
  const relativePath = relative(ROOT, file).split("\\").join("/");
  const hits = scanText(await readFile(file, "utf8"));
  if (hits.length === 0) continue;
  if (isAccepted(relativePath)) { acceptedCount += hits.length; continue; }
  for (const hit of hits) findings.push({ path: relativePath, ...hit });
}

console.log(`taranan dosya   : ${files.length}`);
console.log(`kural sayisi    : ${RULES.length}`);
console.log(`kabul edilen    : ${acceptedCount}`);
console.log(`BULGU           : ${findings.length}`);
if (findings.length > 0) {
  console.log("\n-- bulgular (KONUM ve TUR; deger basilmaz) --");
  for (const finding of findings) console.log(`  ${finding.path}:${finding.line}  [${finding.rule}]`);
}
process.exit(findings.length > 0 ? 1 : 0);
