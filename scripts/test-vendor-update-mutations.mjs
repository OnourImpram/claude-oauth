// Mutation evidence for the vendor-signature update policy (2026-11-15).
// Run from an idle checkout. Each mutant is applied to ONE source file, the project is
// rebuilt, and ONLY test/claude-vendor-update.test.ts runs: every arm of that file has to be
// able to fail, otherwise a green run measures nothing. Several arms were written after the
// code they cover, so they were never seen red by hand; this script is their red.
// Backups stay in memory and are restored in a finally block, never via git checkout; the
// restoration is verified byte-exact before exit.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? join(root, ".astra-review", "vendor-update-mutations"));
const POLICY = "src/runtime/claude-vendor-update.ts";
const LOCK = "src/runtime/install-lock.ts";
const targets = [POLICY, LOCK];
const originals = new Map(await Promise.all(targets.map(async (path) => [path, await readFile(join(root, path))])));
const results = [];
await mkdir(output, { recursive: true });

function replaceOnce(source, anchor, replacement) {
    // Source files mix LF and CRLF; try the anchor in both conventions.
    for (const [needle, patch] of [
        [anchor, replacement],
        [anchor.replaceAll("\n", "\r\n"), replacement.replaceAll("\n", "\r\n")],
    ]) {
        if (source.split(needle).length === 2)
            return source.replace(needle, () => patch);
    }
    throw new Error(`Mutation anchor must match exactly once: ${anchor.slice(0, 60)}`);
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
    if (run.code !== 0) throw new Error(`Mutation build failed; no test result is claimed.\n${run.stdout}`);
}
async function restore() {
    for (const [path, bytes] of originals) await writeFile(join(root, path), bytes);
}
async function suite(name, expectedFailure) {
    const run = await runNode(["--test", "--test-reporter=tap", "dist/test/claude-vendor-update.test.js"]);
    await writeFile(join(output, `${name}.tap`), run.stdout);
    const summary = Object.fromEntries([...run.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)].map((match) => [match[1], Number(match[2])]));
    const expected = expectedFailure === undefined ? "" : expectedFailure.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const expectedTestFailed = expectedFailure === undefined ? undefined : new RegExp(`^[ ]*not ok [^\\n]*${expected}`, "mu").test(run.stdout);
    const accepted = expectedFailure === undefined ? run.code === 0 : run.code !== 0 && expectedTestFailed;
    const row = { name, exitCode: run.code, ...summary, ...(expectedTestFailed === undefined ? {} : { expectedTestFailed }), accepted };
    results.push(row);
    await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(JSON.stringify(row));
    if (!accepted) throw new Error(`Mutation ${name} did not satisfy its expected test outcome.`);
}

const policy = originals.get(POLICY).toString("utf8");
const lock = originals.get(LOCK).toString("utf8");

const mutants = [
    {
        // The platform's verdict is ignored: an unsigned or tampered binary is accepted.
        name: "signature-status-ignored",
        path: POLICY,
        source: replaceOnce(policy, `if (report.status !== "Valid")`, `if (false)`),
        failure: "refuses an unsigned binary",
    },
    {
        // Any publisher with a valid certificate is accepted.
        name: "signer-check-removed",
        path: POLICY,
        source: replaceOnce(policy, `if (!signerMatchesPolicy(report.subject, policy))`, `if (false)`),
        failure: "refuses a valid signature from a different publisher",
    },
    {
        // The organization attribute stops being part of the identity.
        name: "organization-not-compared",
        path: POLICY,
        source: replaceOnce(policy, `commonNames[0] === policy.signerCommonName && organizations[0] === policy.signerOrganization;`, `commonNames[0] === policy.signerCommonName;`),
        failure: "refuses the right common name under a different organization",
    },
    {
        // "Contains the vendor name" replaces "is exactly the vendor": a second CN slips through.
        name: "ambiguous-subject-accepted",
        path: POLICY,
        source: replaceOnce(policy, `return commonNames.length === 1 && organizations.length === 1
        && commonNames[0] === policy.signerCommonName`, `return commonNames.includes(policy.signerCommonName) && organizations.length === 1
        && commonNames[0] === policy.signerCommonName`),
        failure: "refuses a subject that names the vendor twice",
    },
    {
        // Quoted attribute values are no longer parsed: the measured vendor subject fails to
        // parse, so the positive arm (and the parser arm) must go red.
        name: "quoted-values-unparsed",
        path: POLICY,
        source: replaceOnce(policy, `        if (subject[index] === '"') {
            index += 1;
            let closed = false;`, `        if (subject[index] === "\\u0000") {
            index += 1;
            let closed = false;`),
        failure: "reads the subject Windows prints for the measured vendor certificate",
    },
    {
        // No rollback protection: an older signed build is accepted. (A literal `if (false)`
        // does not compile here: the narrowing of the version text is lost in dead code.)
        name: "version-floor-removed",
        path: POLICY,
        source: replaceOnce(policy, `if (compareVersions(observedVersion, pinnedVersion) < 0)`, `if (compareVersions(observedVersion, pinnedVersion) < -Infinity)`),
        failure: "refuses a downgrade below the pinned version",
    },
    {
        // Versions compared as text: "2.1.99" sorts above "2.1.319".
        name: "version-compared-as-text",
        path: POLICY,
        source: replaceOnce(policy, `if (compareVersions(observedVersion, pinnedVersion) < 0)`, `if (observedVersionText < pinned.version)`),
        failure: "compares versions numerically",
    },
    {
        // The bytes are not re-read after the verdict: a swap during verification goes unseen.
        name: "rehash-after-verdict-removed",
        path: POLICY,
        source: replaceOnce(policy, `    if (confirmedSha256 !== observedSha256)
        return unchanged("refused", "vendor_update_binary_changed_during_verification", verdictContext);`, `    void confirmedSha256;`),
        failure: "refuses when the bytes change between the hash and the signature verdict",
    },
    {
        // A record for any bytes vouches for the bytes on disk.
        name: "record-hash-not-compared",
        path: POLICY,
        source: replaceOnce(policy, `        && remembered.sha256 === observedSha256
`, ``),
        failure: "a record for other bytes never accepts the bytes on disk",
    },
    {
        // A record made under another signer policy is reused.
        name: "record-policy-not-compared",
        path: POLICY,
        source: replaceOnce(policy, `        && remembered.signerCommonName === policy.signerCommonName
        && remembered.signerOrganization === policy.signerOrganization) {`, `        ) {`),
        failure: "a record made under another signer policy is not reused",
    },
    {
        // The acceptance is never recorded: every launch pays for the probe again.
        name: "record-never-written",
        path: POLICY,
        source: replaceOnce(policy, `    await writeAcceptance(options.cachePath, record);`, `    void writeAcceptance;`),
        failure: "the second launch on the same accepted binary does not pay for a signature probe again",
    },
    {
        // The pinned-bytes short circuit is gone: the pinned binary is treated as an update.
        name: "pinned-short-circuit-removed",
        path: POLICY,
        source: replaceOnce(policy, `    if (observedSha256 === pinned.sha256)
        return unchanged("pinned", "locked_hash_match");`, ``),
        failure: "leaves the pin alone when the bytes on disk are the pinned bytes",
    },
    {
        // The policy applies on every platform, including ones it does not name.
        name: "platform-scope-ignored",
        path: POLICY,
        source: replaceOnce(policy, `if (policy.platform !== platform)`, `if (false)`),
        failure: "does nothing on a platform the policy does not name",
    },
    {
        // A lock without a policy is treated as if it trusted the measured vendor.
        name: "absent-policy-defaulted",
        path: POLICY,
        source: replaceOnce(policy, `    const policy = pinned.vendorSignature;
    if (policy === undefined)
        return unchanged("not_applicable", "vendor_signature_policy_absent", { observedSha256 });`, `    const policy = pinned.vendorSignature ?? { platform: "win32", signerCommonName: "Anthropic, PBC", signerOrganization: "Anthropic, PBC" };`),
        failure: "does nothing when the lock carries no vendor-signature policy",
    },
    {
        // A failing signature probe is read as consent.
        name: "probe-failure-accepted",
        path: POLICY,
        source: replaceOnce(policy, `    catch {
        return unchanged("refused", "vendor_update_signature_probe_failed", { observedSha256, observedVersion: observedVersionText });
    }`, `    catch {
        report = { status: "Valid", subject: 'CN="Anthropic, PBC", O="Anthropic, PBC"', thumbprint: "" };
    }`),
        failure: "refuses when the signature probe itself fails",
    },
    {
        // Doctor relabels the check for every decision except an accepted one.
        name: "annotation-inverted",
        path: POLICY,
        source: replaceOnce(policy, `    if (decision.status !== "accepted")
        return checks;`, `    if (decision.status === "accepted")
        return checks;`),
        failure: "relabels only the claude check, and only when the update was accepted",
    },
    {
        // A failed claude check is relabelled as accepted.
        name: "annotation-ignores-check-status",
        path: POLICY,
        source: replaceOnce(policy, `check.component === "claude" && check.status === "ok"`, `check.component === "claude"`),
        failure: "a claude check that failed anyway is never relabelled as accepted",
    },
    {
        // The lock parser accepts any platform string in the policy.
        name: "lock-policy-platform-unchecked",
        path: LOCK,
        source: replaceOnce(lock, `if (!isRecord(value) || value["platform"] !== "win32")`, `if (!isRecord(value))`),
        failure: "an unknown platform is a broken lock",
    },
    {
        // The lock parser drops the policy on the floor.
        name: "lock-policy-dropped",
        path: LOCK,
        source: replaceOnce(lock, `            ...(vendorSignature === undefined ? {} : { vendorSignature }),`, ``),
        failure: "is carried through the parser when present",
    },
];

try {
    await build();
    await suite("baseline");
    for (const mutant of mutants) {
        await restore();
        await writeFile(join(root, mutant.path), mutant.source);
        await build();
        await suite(mutant.name, mutant.failure);
    }
}
finally {
    await restore();
    await build();
    for (const [path, bytes] of originals) {
        if (!(await readFile(join(root, path))).equals(bytes)) throw new Error("In-memory restoration did not restore the exact original bytes.");
    }
    console.log("Original sources restored byte-exact and rebuilt.");
}
await suite("restored");
