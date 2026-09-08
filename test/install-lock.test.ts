import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { reportedBuildCommitMatches, reportedVersionMatches, requireInstallChecks, sideProviderInstallDrift, type InstallLock, verifyClodexPackageLock } from "../src/runtime/install-lock.js";

// REGRESSION: verifyClodexPackageLock was a STUB that returned { status: "ok" }
// unconditionally. lock.clodex.integrity and entrypointSha256 were never read -- and once
// measured, it turned out entrypointSha256 corresponded to NO file on disk. An unmeasured
// field rots silently, and it tells nobody.

const PACKAGE = "@bman654/clodex";
let moduleRoot = "";
let lock: InstallLock;
let entrypointDigest = "";

async function writeTree(options: {
    readonly version: string;
    readonly integrity: string;
    readonly entrypointBody: string;
    readonly omitPackage?: boolean;
    readonly omitInstallerRecord?: boolean;
}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "clodex-lock-"));
    if (options.omitPackage !== true) {
        const packageRoot = join(root, "node_modules", PACKAGE, "dist");
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(root, "node_modules", PACKAGE, "package.json"), JSON.stringify({ name: PACKAGE, version: options.version }), "utf8");
        await writeFile(join(packageRoot, "cli.js"), options.entrypointBody, "utf8");
    }
    if (options.omitInstallerRecord !== true) {
        await mkdir(join(root, "node_modules"), { recursive: true });
        await writeFile(join(root, "node_modules", ".package-lock.json"), JSON.stringify({
            packages: { [`node_modules/${PACKAGE}`]: { version: options.version, integrity: options.integrity } },
        }), "utf8");
    }
    return root;
}

before(async () => {
    const { createHash } = await import("node:crypto");
    entrypointDigest = createHash("sha256").update("export const cli = 1;\n").digest("hex").toUpperCase();
    lock = {
        schemaVersion: 1,
        clodex: {
            package: PACKAGE,
            version: "2.11.1",
            integrity: `sha512-${"A".repeat(88)}`,
            entrypointSha256: entrypointDigest,
            localPatch: "config/claude-oauth-local-patches.mjs",
            localPatchSha256: "0".repeat(64),
        },
    } as unknown as InstallLock;
    moduleRoot = await writeTree({ version: "2.11.1", integrity: lock.clodex.integrity, entrypointBody: "export const cli = 1;\n" });
});

after(async () => {
    await rm(moduleRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("verifyClodexPackageLock", () => {
    it("returns ok when the version, SRI and entrypoint bytes match", async () => {
        const check = await verifyClodexPackageLock(lock, moduleRoot);
        strictEqual(check.status, "ok");
        strictEqual(check.detailCode, "locked_bytes_and_reported_version_match");
    });

    // The four below are the checks the stub NEVER performed. Each one is a negative control.
    it("reports drift when the package version diverges", async () => {
        const root = await writeTree({ version: "9.9.9", integrity: lock.clodex.integrity, entrypointBody: "export const cli = 1;\n" });
        const check = await verifyClodexPackageLock(lock, root);
        strictEqual(check.status, "drift");
        strictEqual(check.detailCode, "locked_package_version_mismatch");
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("reports drift when the npm SRI diverges", async () => {
        const root = await writeTree({ version: "2.11.1", integrity: `sha512-${"B".repeat(88)}`, entrypointBody: "export const cli = 1;\n" });
        const check = await verifyClodexPackageLock(lock, root);
        strictEqual(check.status, "drift");
        strictEqual(check.detailCode, "locked_package_integrity_mismatch");
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("reports drift when the entrypoint bytes change", async () => {
        const root = await writeTree({ version: "2.11.1", integrity: lock.clodex.integrity, entrypointBody: "export const cli = 2;\n" });
        const check = await verifyClodexPackageLock(lock, root);
        strictEqual(check.status, "drift");
        strictEqual(check.detailCode, "locked_package_entrypoint_hash_mismatch");
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("reports missing when the package is absent", async () => {
        const root = await writeTree({ version: "2.11.1", integrity: lock.clodex.integrity, entrypointBody: "", omitPackage: true });
        const check = await verifyClodexPackageLock(lock, root);
        strictEqual(check.status, "missing");
        strictEqual(check.detailCode, "locked_package_missing");
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("reports missing when the installation record is absent", async () => {
        const root = await writeTree({ version: "2.11.1", integrity: lock.clodex.integrity, entrypointBody: "export const cli = 1;\n", omitInstallerRecord: true });
        const check = await verifyClodexPackageLock(lock, root);
        strictEqual(check.status, "missing");
        strictEqual(check.detailCode, "locked_package_installer_record_missing");
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("no branch throws: even a corrupt manifest becomes a report", async () => {
        const root = await writeTree({ version: "2.11.1", integrity: lock.clodex.integrity, entrypointBody: "export const cli = 1;\n" });
        await writeFile(join(root, "node_modules", PACKAGE, "package.json"), "this is not JSON", "utf8");
        const check = await verifyClodexPackageLock(lock, root);
        strictEqual(check.status, "drift");
        strictEqual(check.detailCode, "locked_package_manifest_unreadable");
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
});

describe("reportedVersionMatches", () => {
    it("finds the exact version in the output", () => {
        strictEqual(reportedVersionMatches("clodex v2.11.1", "2.11.1"), true);
        strictEqual(reportedVersionMatches("2.1.251 (Claude Code)", "2.1.251"), true);
    });

    it("does not accept a partial match as the version", () => {
        strictEqual(reportedVersionMatches("2.11.10", "2.11.1"), false);
        strictEqual(reportedVersionMatches("12.11.1", "2.11.1"), false);
        strictEqual(reportedVersionMatches("", "2.11.1"), false);
        // The upgrade's own negative arm: the old version no longer MATCHES. If the fixture
        // tree is not moved along with the version, the gate may be "accepting every
        // version" and nobody would notice.
        strictEqual(reportedVersionMatches("clodex v2.8.2", "2.11.1"), false);
    });
});

describe("installed tree", () => {
    // This is not a unit test but the proof that the lock describes the REAL tree.
    // entrypointSha256 had gone stale precisely because no such check existed.
    it("the repository config/install-lock.json matches the actual node_modules", async (t) => {
        const repoRoot = resolve(import.meta.dirname, "..", "..");
        let real: InstallLock;
        try {
            real = JSON.parse(await readFile(join(repoRoot, "config", "install-lock.json"), "utf8")) as InstallLock;
            await access(join(repoRoot, "node_modules", PACKAGE, "package.json"));
        }
        catch {
            t.skip("no installed node_modules (clean checkout)");
            return;
        }
        const check = await verifyClodexPackageLock(real, repoRoot);
        strictEqual(check.status, "ok", check.detailCode);
    });
});

// Case record: the lock's `sourceCommit` was for months a REQUIRED but NEVER READ field --
// its format was validated, its value compared against no gate. Since Grok announces its
// own build commit in `--version` output, the field was in fact measurable. This is exactly
// what separates two different builds carrying the same version tag.
describe("reportedBuildCommitMatches", () => {
    const output = "grok 1.0.13 (5e9a58528b76)";

    it("recognizes the short commit in the lock", () => {
        strictEqual(reportedBuildCommitMatches(output, "5e9a58528b76"), true);
    });

    it("short output still matches when the lock carries the full commit", () => {
        strictEqual(reportedBuildCommitMatches(output, "5e9a58528b76aaaaaaaaaaaaaaaaaaaaaaaaaaaa"), true);
    });

    // NEGATIVE ARM: proof that the gate can throw. Same version, different build.
    it("rejects a DIFFERENT commit", () => {
        strictEqual(reportedBuildCommitMatches(output, "77cd7eb675ba"), false);
    });

    it("rejects output that carries no commit", () => {
        strictEqual(reportedBuildCommitMatches("grok 1.0.13", "5e9a58528b76"), false);
    });

    it("ignores case differences", () => {
        strictEqual(reportedBuildCommitMatches(output, "5E9A58528B76"), true);
    });
});

// A4 (2026-09-02): a side provider's pin does not shut down the main path. The unit
// evidence for an event that happened three times in one day: antigravity drifted -> it
// used to mean adapter_unavailable, no claude.
describe("sideProviderInstallDrift", () => {
    const check = (component: "node" | "claude" | "claude-shadow" | "clodex" | "grok" | "gemini" | "antigravity", status: "ok" | "missing" | "drift", detailCode = "x") =>
        ({ component, expectedVersion: "1", status, detailCode });

    it("returns side-provider drift with the provider name without throwing", () => {
        const drift = sideProviderInstallDrift(
            [check("claude", "ok"), check("antigravity", "drift", "locked_manifest_hash_mismatch"), check("grok", "ok")],
            ["antigravity", "grok"],
        );
        deepStrictEqual(drift, [{ component: "antigravity", provider: "google", status: "drift", detailCode: "locked_manifest_hash_mismatch" }]);
    });

    it("ignores an unrequested component; returns an empty list for a clean installation", () => {
        deepStrictEqual(sideProviderInstallDrift([check("grok", "drift")], ["antigravity"]), []);
        deepStrictEqual(sideProviderInstallDrift([check("grok", "ok"), check("antigravity", "ok")], ["grok", "antigravity"]), []);
    });

    // NEGATIVE ARM: a main-path component is NOT a side provider -- it is not softened
    // here, requireInstallChecks still throws. That is exactly what separates the two gates.
    it("never downgrades a main-path component failure (claude/clodex)", () => {
        deepStrictEqual(sideProviderInstallDrift([check("claude", "drift"), check("clodex", "missing")], ["claude", "clodex"]), []);
        throws(() => requireInstallChecks([check("claude", "drift")], ["claude"]), /Pinned installation verification failed: claude/u);
    });
});

// CASE RECORD (2026-09-05): no check compared the lock's `localPatchSha256` against the
// local patch file IN THE REPOSITORY. Fixing the patch and forgetting to update the lock
// passed `npm run check` GREEN; the divergence only showed up as a 503 on a running
// installation. 06-Altyapi/scripts/civi-surukleme-kontrolu.py measures the RELEASE, not the
// repository -- so this gap fell within no other gate's scope.
describe("repository lock <-> repository local patch", () => {
    it("install-lock.json localPatchSha256 is the digest of the repository patch file", async () => {
        const { createHash } = await import("node:crypto");
        const repoRoot = resolve(import.meta.dirname, "..", "..");
        const real = JSON.parse(await readFile(join(repoRoot, "config", "install-lock.json"), "utf8")) as InstallLock;
        const bytes = await readFile(join(repoRoot, real.clodex.localPatch));
        const digest = createHash("sha256").update(bytes).digest("hex").toUpperCase();
        strictEqual(digest, real.clodex.localPatchSha256.toUpperCase(), "the lock and the patch file have diverged");
        // POSITIVE CONTROL: does the instrument actually discriminate? Empty output is not evidence.
        const mutated = createHash("sha256").update(Buffer.concat([bytes, Buffer.from("\n")])).digest("hex").toUpperCase();
        strictEqual(mutated === real.clodex.localPatchSha256.toUpperCase(), false, "the digest is insensitive to a change");
    });
});
