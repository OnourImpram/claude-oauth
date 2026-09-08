// Phase 1 gate: is the rebuilt dist byte-for-byte identical to the clean reference release?
// Usage: node scripts/fidelity-diff.mjs [reference-dist-directory]
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
    "  usage: node scripts/fidelity-diff.mjs <reference-dist-dir>\n" +
    "  or set CLAUDE_OAUTH_REFERENCE_DIST to a released dist/src directory."
  );
  process.exit(3);
}
const builtRoot = join(projectRoot, "dist", "src");

// FIX: if a file is not listed here and it differs, either the build has an unwanted
// deviation or a deliberate Phase 2 change was never written into this ledger. Inspect the
// difference, then either revert the source or add it below with its reason.
// Every entry is a Phase 2 decision; the reason sits next to the entry.
const DELIBERATE_DIFFERENCES = new Map([
  ["runtime/claude-shadow.js",
    "Phase 1: reference build CANNOT BE PARSED (try/catch/finally fell outside the body, " +
    "SyntaxError: Illegal return statement). + Phase 2: model-surface gate enabled, " +
    "patch-proof throw converted to a structured warning, raw Clodex output kept out of logs."],
  ["runtime/claude-shadow.d.ts",
    "Phase 1: declaration for the same file as above."],
  ["runtime/install-lock.js",
    "Phase 2: verifyClodexPackageLock stub replaced with actual verification (version + npm SRI + " +
    "entrypoint bytes); zero hash now reported as 'placeholder, awaiting self-heal'."],
  ["runtime/log.d.ts",
    "Phase 2: 6 fields added to the SafeLogEntry allowlist (exitCode, patchOutputBytes, " +
    "patchOutputFingerprint, remedy, errorName, stackFrames). Types only -- log.js unchanged."],
  ["cli.js",
    "Phase 2: raw '!!! FATAL ERROR !!!' dump converted to a structured cli_fatal log " +
    "(error MESSAGE never printed, frame paths masked with ~); unused probeGemini " +
    "wired into doctor --live for reporting only."],
]);

async function walk(root) {
  // N2 (red team, 2026-09-07): an unreadable root returned an empty list, so a
  // missing dist and a missing reference both became "0 files, nothing differs,
  // exit 0". Absence of output is not evidence of sameness; the root itself must
  // be readable before anything below it is compared.
  try {
    await readdir(root);
  } catch (error) {
    console.error(`NOT_RUN: tree unreadable: ${root}\n  ${error && error.message ? error.message : String(error)}`); // lint-izin: this is a filesystem error (ENOENT/EACCES) whose message contains only a PATH; the rule guards URLs carrying a session nonce, which cannot occur in this channel
    process.exit(3);
  }
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

console.log(`reference files : ${referenceFiles.length}`);
console.log(`built files     : ${builtFiles.length}`);
console.log(`identical       : ${identical}`);
console.log(`DIFFERENT       : ${differing.length}`);
console.log(`deliberate      : ${deliberate.length}`);
console.log(`MISSING         : ${missing.length}`);
console.log(`EXTRA           : ${extra.length}`);
if (differing.length > 0) console.log("\n-- DIFFERENT (not recorded in the ledger) --\n" + differing.map((f) => "  " + f).join("\n"));
if (deliberate.length > 0) {
  console.log("\n-- deliberate differences --");
  for (const file of deliberate) console.log(`  ${file}\n      ${DELIBERATE_DIFFERENCES.get(file)}`);
}
if (extra.length > 0) console.log("\n-- extra --\n" + extra.map((f) => "  " + f).join("\n"));
if (missing.length > 0 && process.env["SADAKAT_LIST_MISSING"] === "1") {
  console.log("\n-- missing --\n" + missing.map((f) => "  " + f).join("\n"));
}
// N2: a file the reference has and the build never produced is a fidelity failure,
// not a footnote. It used to be counted, printed behind an env flag, and left out of
// the exit code -- the gate rejected a DIFFERENT byte and accepted an ABSENT module.
if (missing.length > 0 && process.env["SADAKAT_LIST_MISSING"] !== "1") {
  console.log("\n-- missing (first 10; set SADAKAT_LIST_MISSING=1 for all) --\n"
    + missing.slice(0, 10).map((f) => "  " + f).join("\n"));
}
process.exit(differing.length > 0 || extra.length > 0 || missing.length > 0 ? 1 : 0);
