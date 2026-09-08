// Built output is not in the repository. A missing build means this gate COULD NOT RUN;
// a static import would crash module resolution and exit 1, which reads as "ran and
// failed". Import dynamically so the difference survives.
let verifyShadowModelSurface, verifyClodexPackageLock;
try {
  ({ verifyShadowModelSurface } = await import("../dist/src/runtime/claude-shadow.js"));
  ({ verifyClodexPackageLock } = await import("../dist/src/runtime/install-lock.js"));
} catch (e) {
  // N7 (red team, 2026-09-07): every import failure was reported as "build missing".
  // A module that EXISTS and throws while loading is a broken build -- a failure, not
  // an absence -- and calling it NOT_RUN turns a red result into "not measured".
  const absent = e && (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "MODULE_NOT_FOUND");
  const first = e && e.message ? e.message.split("\n")[0] : String(e);
  if (absent) {
    console.error("NOT_RUN: built output missing -- run `npm run build` first.\n  " + first);
    process.exit(3);
  }
  console.error("FAIL: built output exists but could not be loaded -- the build is broken.\n  " + first);
  process.exit(1);
}
import { mkdtemp, mkdir, writeFile, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "OK" : "FAILED"}  ${name}${detail ? "  -> " + detail : ""}`);
  ok ? pass++ : fail++;
};

console.log("== GATE 1: verifyShadowModelSurface ==");
// Both binaries live outside the repository and differ per machine. Unset means the
// arm did not run; it must not be reported as a pass. Exit 3 marks "could not run",
// distinct from exit 1 which marks "ran and failed".
const shadow = process.env["CLAUDE_OAUTH_SHADOW_EXE"];
const native = process.env["CLAUDE_OAUTH_NATIVE_EXE"];
if (!shadow || !native) {
  console.error(
    "NOT_RUN: shadow/native executables not configured.\n" +
    "  set CLAUDE_OAUTH_SHADOW_EXE  -> patched shadow claude.exe\n" +
    "  set CLAUDE_OAUTH_NATIVE_EXE  -> unpatched native claude.exe"
  );
  process.exit(3);
}
try { await verifyShadowModelSurface(shadow); check("positive arm: patched shadow ACCEPTED", true); }
catch (e) { check("positive arm: patched shadow ACCEPTED", false, e.message); }
try { await verifyShadowModelSurface(native); check("negative arm: unpatched native REJECTED", false, "did not throw!"); }
catch (e) { check("negative arm: unpatched native REJECTED", /model-picker proof/.test(e.message), "code=" + e.code); }

console.log("\n== GATE 2: verifyClodexPackageLock ==");
const real = process.cwd();
const lock = JSON.parse(await readFile(join(real, "config", "install-lock.json"), "utf8"));
const r = await verifyClodexPackageLock(lock, real);
check("positive arm: real tree is ok", r.status === "ok", r.detailCode);

async function fakeRoot(mutate) {
  const root = await mkdtemp(join(tmpdir(), "clodex-nk-"));
  const pkg = join(root, "node_modules", "@bman654", "clodex");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await copyFile(join(real, "node_modules", "@bman654", "clodex", "package.json"), join(pkg, "package.json"));
  await copyFile(join(real, "node_modules", "@bman654", "clodex", "dist", "cli.js"), join(pkg, "dist", "cli.js"));
  const pl = JSON.parse(await readFile(join(real, "node_modules", ".package-lock.json"), "utf8"));
  const slim = { packages: { "node_modules/@bman654/clodex": pl.packages["node_modules/@bman654/clodex"] } };
  await mutate({ root, pkg, slim });
  await writeFile(join(root, "node_modules", ".package-lock.json"), JSON.stringify(slim), "utf8");
  return root;
}

const cases = [
  ["version drift", async ({ pkg }) => { const m = JSON.parse(await readFile(join(pkg,"package.json"),"utf8")); m.version = "9.9.9"; await writeFile(join(pkg,"package.json"), JSON.stringify(m), "utf8"); }, "locked_package_version_mismatch"],
  ["SRI drift", async ({ slim }) => { slim.packages["node_modules/@bman654/clodex"] = { ...slim.packages["node_modules/@bman654/clodex"], integrity: "sha512-" + "A".repeat(88) }; }, "locked_package_integrity_mismatch"],
  ["entrypoint bytes changed", async ({ pkg }) => { await writeFile(join(pkg,"dist","cli.js"), "// tampered\n", "utf8"); }, "locked_package_entrypoint_hash_mismatch"],
  ["package entirely missing", async ({ root, pkg }) => { await writeFile(join(pkg,"package.json"), "", "utf8"); }, "locked_package_manifest_unreadable"],
];
for (const [name, mutate, expected] of cases) {
  const root = await fakeRoot(mutate);
  const out = await verifyClodexPackageLock(lock, root);
  check(`negative arm: ${name}`, out.status !== "ok" && out.detailCode === expected, out.detailCode);
}
console.log(`\ntotal: ${pass} succeeded, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
