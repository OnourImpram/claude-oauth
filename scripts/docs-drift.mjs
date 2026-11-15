// docs-drift.mjs -- the defect ledger is told in four places (the README's "Known gaps"
// table, the project page's defect table, SECURITY.md and docs/llms.txt), and for two
// months they told different stories: the page and SECURITY.md still described repaired
// defects as open, the page's table lacked the three newest rows, and the README banner
// said "not ready to use" while every High defect was closed (corrected 2026-11-15).
// A sentence promising the surfaces "cannot drift apart" did not stop them. This gate does:
// the README table is the source, and any surface that disagrees with it fails the check.
//
//   node scripts/docs-drift.mjs               0 = the surfaces agree, 1 = drift (each named)
//   node scripts/docs-drift.mjs --ozdenetim   every rule shown catching its own canary
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ID = "[A-Z]\\d{2}";

// README: `| ~~B01~~ | ~~High~~ | **Repaired ...` is repaired, `| N07 | Low | **Open ...` is open.
function readmeLedger(readme) {
  const start = readme.indexOf("\n## Known gaps");
  if (start < 0) return new Map();
  const rest = readme.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const ledger = new Map();
  for (const line of (end < 0 ? rest : rest.slice(0, end)).split("\n")) {
    const row = new RegExp(`^\\|\\s*(~~)?(${ID})(~~)?\\s*\\|([^|]*)\\|\\s*(.*)$`).exec(line.trim());
    if (row === null) continue;
    ledger.set(row[2], {
      repaired: row[1] !== undefined && row[3] !== undefined,
      severity: row[4].replaceAll("~~", "").trim(),
      text: row[5],
    });
  }
  return ledger;
}

function pageLedger(page) {
  const ledger = new Map();
  for (const row of page.matchAll(new RegExp(`<span class="id">(${ID})</span></td><td class="sev[^"]*">([^<]+)<`, "g"))) {
    ledger.set(row[1], row[2].trim().toLowerCase());
  }
  return ledger;
}

function securityRows(security) {
  const rows = new Map();
  for (const line of security.split("\n")) {
    const row = new RegExp(`^\\|\\s*\\*\\*(?:~~)?(${ID})(?:~~)?\\*\\*\\s*\\|(.*)$`).exec(line.trim());
    if (row !== null) rows.set(row[1], row[2]);
  }
  return rows;
}

function drift({ readme, page, security, llms }) {
  const ledger = readmeLedger(readme);
  if (ledger.size === 0) return ["README.md: the Known gaps table was not found, so nothing could be compared"];
  const found = [];
  for (const [id, row] of ledger) {
    const saysRepaired = /^\*\*(?:Found and repaired|Repaired)\b/.test(row.text);
    const saysOpen = /^\*\*Open\b/.test(row.text);
    if (row.repaired && !saysRepaired) found.push(`README.md ${id}: the id is struck through, the row does not open with a repair statement`);
    if (!row.repaired && !saysOpen) found.push(`README.md ${id}: the id is not struck through, the row does not open with "Open"`);
  }
  const onPage = pageLedger(page);
  for (const [id, row] of ledger) {
    const status = onPage.get(id);
    if (status === undefined) found.push(`docs/index.html: ${id} is in the README table and missing from the page table`);
    else if ((status === "fixed") !== row.repaired) found.push(`docs/index.html: ${id} is "${status}" on the page and ${row.repaired ? "repaired" : "open"} in the README`);
  }
  for (const id of onPage.keys()) {
    if (!ledger.has(id)) found.push(`docs/index.html: ${id} is in the page table and missing from the README table`);
  }
  for (const [id, text] of securityRows(security)) {
    const row = ledger.get(id);
    if (row === undefined) found.push(`SECURITY.md: ${id} has a row here and none in the README table`);
    else if (row.repaired !== /\bRepaired\b/.test(text)) found.push(`SECURITY.md: ${id} is ${row.repaired ? "repaired" : "open"} in the README and the row here says otherwise`);
  }
  // "Not ready to use" is a claim about the ledger. It needs an open High or Critical row to stand on.
  const blocking = [...ledger.values()].some((row) => !row.repaired && /^(?:High|Critical)/i.test(row.severity));
  if (!blocking) {
    for (const [name, text] of [["README.md", readme], ["docs/index.html", page], ["SECURITY.md", security], ["docs/llms.txt", llms]]) {
      if (/not ready to use/i.test(text)) found.push(`${name}: says "not ready to use" while no High or Critical defect is open in the README table`);
    }
  }
  return found;
}

if (process.argv.includes("--ozdenetim")) {
  const row = (id, repaired, severity = "High") => repaired
    ? `| ~~${id}~~ | ~~${severity}~~ | **Repaired 2026-01-01.** Text. |`
    : `| ${id} | ${severity} | **Open, recorded 2026-01-01.** Text. |`;
  const readmeOf = (...rows) => `# x\n\n## Known gaps\n\n| Id | Severity | What is wrong |\n|---|---|---|\n${rows.join("\n")}\n\n## Requirements\n`;
  const cell = (id, status) => `<tr><td class="cell-id"><span class="id">${id}</span></td><td class="sev">${status}</td>`;
  const clean = {
    readme: readmeOf(row("B01", true), row("N07", false, "Low")),
    page: cell("B01", "fixed") + cell("N07", "open"),
    security: "| **~~B01~~** | Repaired | Text. | `src/a.ts` |\n| **N07** | Low, open | Text. | `src/b.ts` |",
    llms: "> Summary.",
  };
  let failed = 0;
  const arm = (name, ok) => {
    console.log(`  ${ok ? "OK" : "FAILED"}  ${name}`);
    if (!ok) failed += 1;
  };
  const caught = (docs, needle) => drift(docs).some((finding) => finding.includes(needle));
  arm("agreeing surfaces PASS", drift(clean).length === 0);
  arm("a missing README table is REPORTED, not passed", caught({ ...clean, readme: "# x\n" }, "was not found"));
  arm("page calls an open defect fixed: CAUGHT", caught({ ...clean, page: cell("B01", "fixed") + cell("N07", "fixed") }, 'N07 is "fixed" on the page'));
  arm("page lacks a README row: CAUGHT", caught({ ...clean, page: cell("B01", "fixed") }, "N07 is in the README table and missing"));
  arm("page has a row the README lacks: CAUGHT", caught({ ...clean, page: clean.page + cell("G09", "fixed") }, "G09 is in the page table"));
  arm("SECURITY.md describes a repaired defect as open: CAUGHT", caught({ ...clean, security: "| **B01** | Critical | Not applied. | `src/a.ts` |" }, "SECURITY.md: B01"));
  arm("SECURITY.md describes an open defect as repaired: CAUGHT", caught({ ...clean, security: "| **N07** | Repaired | Text. | `src/b.ts` |" }, "SECURITY.md: N07"));
  arm("struck-through id whose row says Open: CAUGHT", caught({ ...clean, readme: readmeOf("| ~~B01~~ | ~~High~~ | **Open, recorded 2026-01-01.** Text. |") , page: cell("B01", "fixed"), security: "" }, "does not open with a repair statement"));
  arm('"not ready to use" with no open High defect: CAUGHT', caught({ ...clean, llms: "> Pre-release, not ready to use." }, 'docs/llms.txt: says "not ready to use"'));
  arm('"not ready to use" with an open High defect: ALLOWED', !caught({
    readme: readmeOf(row("B01", false, "High")) + "Not ready to use.\n",
    page: cell("B01", "open"), security: "| **B01** | High, open | Text. | `src/a.ts` |", llms: "",
  }, "not ready to use"));
  console.log(`self-check: ${failed === 0 ? "all succeeded" : failed + " arms failed"}`);
  process.exit(failed === 0 ? 0 : 1);
}

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8").replaceAll("\r\n", "\n");
const docs = { readme: read("README.md"), page: read("docs", "index.html"), security: read("SECURITY.md"), llms: read("docs", "llms.txt") };
const ledger = readmeLedger(docs.readme);
const open = [...ledger.values()].filter((row) => !row.repaired).length;
const findings = drift(docs);
console.log(`README ledger : ${ledger.size} ids (${ledger.size - open} repaired, ${open} open)`);
console.log(`compared with : docs/index.html (${pageLedger(docs.page).size} rows), SECURITY.md (${securityRows(docs.security).size} rows), docs/llms.txt`);
console.log(`drift         : ${findings.length}`);
for (const finding of findings) console.log(`  ${finding}`);
process.exit(findings.length === 0 ? 0 : 1);
