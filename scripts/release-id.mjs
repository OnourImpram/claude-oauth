// release-id.mjs -- COMPUTES and VERIFIES the content-addressed release identity.
//
// FIX: if "computed" and "declared" have drifted apart, the release was edited in place.
// Rebuild the directory (a clean copy) or rename it with the new identity; never accept an
// edited release on the strength of its name -- that was exactly the root cause of this incident.
//
// Usage:
//   node scripts/release-id.mjs --compute <directory>
//   node scripts/release-id.mjs --verify  <release-directory>    (checks name, content and optional release-id artifact)
//   node scripts/release-id.mjs --ozdenetim                      (negative control)

import { createHash } from "node:crypto";
import { readdir, readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

const HASHED_DIRECTORIES = ["dist", "config"];
const RELEASE_ID_PATTERN = /^router-v3-([A-F0-9]{12})-([A-F0-9]{12})$/u;

async function collectFiles(directory) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else found.push(path);
    }
  }
  await visit(directory);
  return found;
}

async function directoryDigest(root, subdirectory) {
  const base = resolve(root, subdirectory);
  const files = (await collectFiles(base))
    .map((path) => ({ path, key: relative(base, path).split(sep).join("/") }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.key);
    digest.update("\n");
    digest.update(createHash("sha256").update(await readFile(file.path)).digest("hex"));
    digest.update("\n");
  }
  return digest.digest("hex").toUpperCase().slice(0, 12);
}

export async function computeReleaseId(root) {
  const parts = [];
  for (const name of HASHED_DIRECTORIES) parts.push(await directoryDigest(root, name));
  return `router-v3-${parts[0]}-${parts[1]}`;
}

const [mode, target] = process.argv.slice(2);

if (mode === "--ozdenetim") {
  // Positive arm: the same tree yields the same identity. Negative arm: change one byte
  // and the identity changes.
  const root = await mkdtemp(join(tmpdir(), "relid-"));
  for (const d of HASHED_DIRECTORIES) await mkdir(join(root, d), { recursive: true });
  await writeFile(join(root, "dist", "a.js"), "export const a = 1;\n", "utf8");
  await writeFile(join(root, "config", "c.json"), "{}\n", "utf8");
  const first = await computeReleaseId(root);
  const again = await computeReleaseId(root);
  await writeFile(join(root, "dist", "a.js"), "export const a = 2;\n", "utf8");
  const after = await computeReleaseId(root);
  await rm(root, { recursive: true, force: true });
  const stable = first === again;
  const sensitive = first !== after;
  console.log(`self-check: stability ${stable ? "OK" : "FAILED"} · single-byte sensitivity ${sensitive ? "OK" : "FAILED"}`);
  process.exit(stable && sensitive ? 0 : 1);
}

if (mode === "--compute" && target) {
  console.log(await computeReleaseId(resolve(target)));
  process.exit(0);
}

if (mode === "--verify" && target) {
  const root = resolve(target);
  const declared = basename(root);
  const computed = await computeReleaseId(root);
  const shaped = RELEASE_ID_PATTERN.test(declared);
  let artifact;
  try {
    artifact = (await readFile(join(root, "release-id"), "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // Legacy releases may lack this file; portable shims require it. If present it
  // must agree with both the directory and content, never silently override them.
  const artifactMatches = artifact === undefined || artifact === computed;
  console.log(`directory name (declared) : ${declared}`);
  console.log(`content        (computed) : ${computed}`);
  console.log(`valid format              : ${shaped ? "yes" : "NO"}`);
  console.log(`release-id artifact       : ${artifact === undefined ? "absent (legacy)" : artifactMatches ? "MATCHED" : "DRIFTED"}`);
  const matched = shaped && declared === computed && artifactMatches;
  console.log(`RESULT                    : ${matched ? "MATCHED" : "DRIFTED"}`);
  process.exit(matched ? 0 : 1);
}

console.log("usage: --compute <directory> | --verify <release-directory> | --ozdenetim");
process.exit(2);
