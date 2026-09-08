// release-id.mjs -- icerik-adresli release kimligini HESAPLAR ve DOGRULAR.
//
// ONARIM: "computed" ile "declared" ayrisiyorsa release yerinde duzenlenmis demektir.
// Dizini yeniden kur (temiz kopya) ya da yeni kimlikle yeniden adlandir; elle duzenlenmis
// bir release'i adiyla kabul etme -- bu olayin kok sebebi tam olarak buydu.
//
// Kullanim:
//   node scripts/release-id.mjs --compute <dizin>
//   node scripts/release-id.mjs --verify  <release-dizini>       (ad ile icerigi karsilastirir)
//   node scripts/release-id.mjs --ozdenetim                      (negatif kontrol)

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
  // Pozitif kol: ayni agac ayni kimligi verir. Negatif kol: tek bayt degisince kimlik degisir.
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
  console.log(`ozdenetim: kararlilik ${stable ? "GECTI" : "DUSTU"} · tek-bayt duyarliligi ${sensitive ? "GECTI" : "DUSTU"}`);
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
  console.log(`dizin adi (declared) : ${declared}`);
  console.log(`icerik   (computed)  : ${computed}`);
  console.log(`bicim gecerli        : ${shaped ? "evet" : "HAYIR"}`);
  console.log(`SONUC                : ${shaped && declared === computed ? "ESLESTI" : "AYRISTI"}`);
  process.exit(shaped && declared === computed ? 0 : 1);
}

console.log("kullanim: --compute <dizin> | --verify <release-dizini> | --ozdenetim");
process.exit(2);
