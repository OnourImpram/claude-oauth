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
  // N5 (red team, 2026-09-07): the field name in JSON carries a closing quote
  // ("refresh_token": "..."), and the rule demanded whitespace or the separator
  // straight after the name -- so the single most common on-disk shape of a
  // credential was the one shape the scan could not see.
  ["inline_credential_assignment", /\b(?:password|passwd|secret|client_secret|api_key|apikey|access_token|refresh_token)"?\s*[:=]\s*["'][^"'\s]{12,}["']/gi],
];

// Deliberate acceptances. Every entry states WHY it is safe; adding an entry without a
// reason is punching a silent hole in the gate.
//
// N6 (red team, 2026-09-07): the acceptance was keyed on the FILE, so the reason it
// gave ("sha256 hex and npm SRI are public digests") covered every future line of
// that file too -- a real credential added to install-lock.json in any other field
// would have been accepted with a reason that did not apply to it. The acceptance is
// now keyed on the VALUE: it must actually look like the digest the reason describes.
const HASH_SHAPED = /^(?:[a-f0-9]{64}|sha(?:256|512)-[A-Za-z0-9+/=]{20,})$/;

const ACCEPTED = [
  [/^config\/install-lock\.json$/, HASH_SHAPED, "version pinning: sha256 hex and npm SRI -- both are public artifact digests, not secrets"],
];

function isAccepted(relativePath, matchedText) {
  const path = relativePath.split("\\").join("/");
  return ACCEPTED.some(([pattern, shape]) => pattern.test(path) && shape.test(matchedText));
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
      // The matched text stays in memory for the acceptance decision only; it is
      // never printed. A finding is reported as LOCATION and TYPE.
      hits.push({ rule: name, line: text.slice(0, match.index).split("\n").length, matched: match[0] });
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
  console.log(`self-check: synthetic canary ${ok ? "CAUGHT" : "MISSED"} (${[...rules].join(", ") || "no rule fire" + "d"})`);

  // The acceptance arm. Until 2026-09-07 the install-lock exemption was keyed on the
  // FILE, so it covered lines its stated reason did not describe; it is now keyed on
  // the VALUE. On this tree the exemption never fires against real content, which
  // means it would sit unmeasured -- so it is measured here, synthetically, on both
  // arms: a digest is accepted, a credential in the same file is NOT.
  const digest = "a".repeat(64);
  const credential = ["sk-", "C".repeat(32)].join("");
  const arms = [
    ["hash-shaped value in install-lock ACCEPTED", isAccepted("config/install-lock.json", digest) === true],
    ["secret-shaped value in install-lock REJECTED", isAccepted("config/install-lock.json", credential) === false],
    ["the same digest in another file REJECTED", isAccepted("config/ordinary.json", digest) === false],
  ];
  let armFailed = 0;
  for (const [name, pass] of arms) {
    console.log(`  ${pass ? "OK" : "FAILED"}  ${name}`);
    if (!pass) armFailed += 1;
  }
  // The JSON field shape the scan used to miss entirely.
  const jsonShaped = scanText(`{"refresh_token": "${"D".repeat(28)}"}`);
  const jsonCaught = jsonShaped.some((hit) => hit.rule === "inline_credential_assignment");
  console.log(`  ${jsonCaught ? "OK" : "FAILED"}  JSON quoted field name IS CAUGHT`);
  if (!jsonCaught) armFailed += 1;

  process.exit(ok && armFailed === 0 ? 0 : 1);
}

const files = (await Promise.all(SCAN_DIRECTORIES.map(collect))).flat();
const findings = [];
let acceptedCount = 0;
for (const file of files) {
  const relativePath = relative(ROOT, file).split("\\").join("/");
  const hits = scanText(await readFile(file, "utf8"));
  if (hits.length === 0) continue;
  for (const hit of hits) {
    if (isAccepted(relativePath, hit.matched)) { acceptedCount += 1; continue; }
    findings.push({ path: relativePath, rule: hit.rule, line: hit.line });
  }
}

console.log(`files scanned   : ${files.length}`);
console.log(`rule count      : ${RULES.length}`);
console.log(`accepted        : ${acceptedCount}`);
console.log(`FINDINGS        : ${findings.length}`);
if (findings.length > 0) {
  console.log("\n-- findings (LOCATION and TYPE; value not printed) --");
  for (const finding of findings) console.log(`  ${finding.path}:${finding.line}  [${finding.rule}]`);
}
process.exit(findings.length > 0 ? 1 : 0);
