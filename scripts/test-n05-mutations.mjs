// Run from an idle checkout: each mutant exercises the ENTIRE test suite.
// Backups stay in memory and are restored in finally, never via git checkout.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? join(root, ".astra-review", "n05-mutations"));
const patchPath = join(root, "src/runtime/clodex-capsule-patch.ts");
const guardPath = join(root, "src/runtime/clodex-capsule-entrypoint.ts");
const lockPath = join(root, "config/install-lock.json");
const originals = new Map(await Promise.all([patchPath, guardPath, lockPath].map(async (path) => [path, await readFile(path)])));
const upstream = await readFile(join(root, "node_modules/@bman654/clodex/dist/cli.js"), "utf8");
const upstreamHash = createHash("sha256").update(upstream).digest("hex");
const results = [];
await mkdir(output, { recursive: true });

function replaceOnce(source, anchor, replacement) {
    if (source.split(anchor).length !== 2) throw new Error("Mutation anchor must match exactly once.");
    return source.replace(anchor, () => replacement);
}
async function runNode(args) {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    return await new Promise((resolveRun, rejectRun) => {
        child.once("error", rejectRun);
        child.once("close", (code) => resolveRun({ code, stdout, stderr }));
    });
}
async function build() {
    const run = await runNode(["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
    if (run.code !== 0) throw new Error("Mutation build failed; no test result is claimed.");
}
async function restore() {
    for (const [path, bytes] of originals) await writeFile(path, bytes);
}
async function suite(name, expectedFailure) {
    const run = await runNode(["--test", "--test-reporter=tap", "dist/test/*.test.js"]);
    await writeFile(join(output, `${name}.tap`), run.stdout);
    const summary = Object.fromEntries([...run.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)].map((match) => [match[1], Number(match[2])]));
    const expectedTestFailed = expectedFailure === undefined ? undefined : new RegExp(`not ok [^\n]*${expectedFailure}`, "u").test(run.stdout);
    const accepted = expectedFailure === undefined ? run.code === 0 : run.code !== 0 && expectedTestFailed;
    const row = { name, exitCode: run.code, ...summary, ...(expectedTestFailed === undefined ? {} : { expectedTestFailed }), accepted };
    results.push(row);
    await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(JSON.stringify(row));
    if (!accepted) throw new Error("N05 mutation evidence did not satisfy its expected test outcome.");
}

const patchSource = originals.get(patchPath).toString("utf8");
const guardSource = originals.get(guardPath).toString("utf8");
const finalPatch = 'return replaceUnique(withPassword, "health-authorization", health + authorization, authorization + health);';
const mutants = [
    {
        name: "auth-comparison-removed", path: patchPath, repin: true,
        source: replaceOnce(patchSource, finalPatch,
            finalPatch.slice(0, -1) + '.replace("function isAuthorized(request3, serverPassword) {", "function isAuthorized(request3, serverPassword) { return true;");'),
        failure: "the real Clodex listener authenticates",
    },
    {
        name: "empty-nonce-guard-removed", path: patchPath, repin: true,
        source: replaceOnce(patchSource, '    if (!password || !password.trim()) throw new Error("Clodex capsule transport nonce is required.");', ""),
        failure: "the prepared Clodex child exits before listening: child-empty-nonce",
    },
    {
        name: "patched-hash-guard-removed", path: guardPath, repin: false,
        source: replaceOnce(guardSource, "    if (actual !== lock.clodex.capsuleEntrypointSha256) {", "    if (false) {"),
        failure: "N05 mismatched patched hash prevents entrypoint preparation",
    },
];

try {
    await build();
    await suite("baseline");
    for (const mutant of mutants) {
        await restore();
        await writeFile(mutant.path, mutant.source);
        await build();
        if (mutant.repin) {
            // Deliberately admit the mutant bytes to the hash gate, so the HTTP or
            // startup regression test must detect the fault independently of hashes.
            const module = await import(pathToFileURL(join(root, "dist/src/runtime/clodex-capsule-patch.js")).href + `?mutant=${mutant.name}`);
            const lock = JSON.parse(originals.get(lockPath).toString("utf8"));
            lock.clodex.capsuleEntrypointSha256 = createHash("sha256").update(module.patchClodexCapsule(upstream)).digest("hex").toUpperCase();
            await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
        }
        await suite(mutant.name, mutant.failure);
    }
}
finally {
    await restore();
    await build();
    for (const [path, bytes] of originals) {
        if (!(await readFile(path)).equals(bytes)) throw new Error("In-memory restoration did not restore the exact original bytes.");
    }
    if (createHash("sha256").update(await readFile(join(root, "node_modules/@bman654/clodex/dist/cli.js"))).digest("hex") !== upstreamHash) {
        throw new Error("The installed dependency changed during the mutation run.");
    }
    console.log("Original source, lock and build restored; installed entrypoint unchanged.");
}
await suite("restored");
