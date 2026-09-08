import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProviderId } from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";
import { runCaptured, type CapturedProcess, type ProcessOptions } from "./child-process.js";
export type InstallComponent = "node" | "claude" | "claude-shadow" | "clodex" | "grok" | "gemini" | "antigravity";
interface LockedExecutable {
    readonly version: string;
    readonly executable: string;
    readonly sha256: string;
}
export interface InstallLock {
    readonly schemaVersion: 1;
    readonly node: {
        readonly version: string;
    };
    readonly claude: LockedExecutable;
    readonly claudeShadow: LockedExecutable & {
        readonly openAiContextWindow: number;
    };
    readonly clodex: {
        readonly package: "@bman654/clodex";
        readonly version: string;
        readonly integrity: string;
        readonly entrypointSha256: string;
        readonly capsuleEntrypointSha256: string;
        readonly localPatch: "config/claude-oauth-local-patches.mjs";
        readonly localPatchSha256: string;
    };
    readonly claudeClient: {
        readonly mode: "native-gateway" | "patched-shadow";
    };
    readonly grok: LockedExecutable & {
        readonly sourceCommit: string;
        readonly installerSha256: string;
    };
    readonly gemini: LockedExecutable & {
        readonly entrypoint: string;
        readonly entrypointSha256: string;
    };
    readonly antigravity: LockedExecutable & {
        readonly sourceManifest: string;
    };
}
// Which Claude client is launched. "native-gateway" uses the signed, UNMODIFIED claude.exe
// and serves external models through gateway model discovery; "patched-shadow" uses a copy
// patched with clodex. The patched copy can be blocked by Windows Application Control; the
// native path cannot, because it never touches the signed binary.
export type ClaudeClientMode = "native-gateway" | "patched-shadow";
export function resolveClaudeClientMode(lock: InstallLock, environment: NodeJS.ProcessEnv = process.env): ClaudeClientMode {
    const override = environment["HEZARFEN_CLAUDE_CLIENT_MODE"];
    if (override === "native-gateway" || override === "patched-shadow")
        return override;
    return lock.claudeClient.mode;
}
export interface InstallCheck {
    readonly component: InstallComponent;
    readonly expectedVersion: string;
    readonly status: "ok" | "missing" | "drift";
    readonly detailCode: string;
}
export interface InstallVerificationOptions {
    readonly versionRunner?: (command: string, args: readonly string[], options: ProcessOptions) => Promise<CapturedProcess>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || value.trim() === "")
        throw new Error(`install lock field ${key} is invalid`);
    return value;
}
function requiredPositiveInteger(record: Record<string, unknown>, key: string): number {
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`install lock field ${key} is invalid`);
    }
    return value;
}
function parseExecutable(value: unknown): LockedExecutable {
    if (!isRecord(value))
        throw new Error("install lock executable entry is invalid");
    const sha256 = requiredString(value, "sha256").toUpperCase();
    if (!/^[A-F0-9]{64}$/u.test(sha256))
        throw new Error("install lock SHA-256 is invalid");
    return {
        version: requiredString(value, "version"),
        executable: requiredString(value, "executable"),
        sha256,
    };
}
function parseInstallLock(value: unknown): InstallLock {
    if (!isRecord(value) || value["schemaVersion"] !== 1)
        throw new Error("install lock header is invalid");
    const node = value["node"];
    const clodex = value["clodex"];
    const grok = value["grok"];
    const claudeShadow = value["claudeShadow"];
    if (!isRecord(node) || !isRecord(clodex) || !isRecord(grok) || !isRecord(claudeShadow)) {
        throw new Error("install lock body is invalid");
    }
    if (requiredString(clodex, "package") !== "@bman654/clodex") {
        throw new Error("install lock Clodex package is invalid");
    }
    const parsedGrok = parseExecutable(grok);
    const installerSha256 = requiredString(grok, "installerSha256").toUpperCase();
    if (!/^[A-F0-9]{64}$/u.test(installerSha256))
        throw new Error("installer SHA-256 is invalid");
    // Short form accepted: the binary announces an abbreviated commit and the vendor
    // publishes no source tree, so a full 40-char value could only ever be invented.
    // When the field is absent, native is assumed: the patched path is now the exception,
    // not the rule.
    const clientRecord = value["claudeClient"];
    const declaredMode = isRecord(clientRecord) ? clientRecord["mode"] : undefined;
    if (declaredMode !== undefined && declaredMode !== "native-gateway" && declaredMode !== "patched-shadow")
        throw new Error("Claude client mode is invalid");
    const parsedClientMode: "native-gateway" | "patched-shadow" = declaredMode ?? "native-gateway";
    const parsedGrokCommit = requiredString(grok, "sourceCommit").toLowerCase();
    if (!/^[0-9a-f]{7,40}$/u.test(parsedGrokCommit))
        throw new Error("Grok source commit is invalid");
    const clodexEntrypointSha256 = requiredString(clodex, "entrypointSha256").toUpperCase();
    if (!/^[A-F0-9]{64}$/u.test(clodexEntrypointSha256))
        throw new Error("Clodex entrypoint SHA-256 is invalid");
    const capsuleEntrypointSha256 = requiredString(clodex, "capsuleEntrypointSha256").toUpperCase();
    if (!/^[A-F0-9]{64}$/u.test(capsuleEntrypointSha256))
        throw new Error("Clodex capsule entrypoint SHA-256 is invalid");
    const localPatch = requiredString(clodex, "localPatch");
    if (localPatch !== "config/claude-oauth-local-patches.mjs")
        throw new Error("Clodex local patch path is invalid");
    const localPatchSha256 = requiredString(clodex, "localPatchSha256").toUpperCase();
    if (!/^[A-F0-9]{64}$/u.test(localPatchSha256))
        throw new Error("Clodex local patch SHA-256 is invalid");
    const gemini = value["gemini"];
    if (!isRecord(gemini))
        throw new Error("Gemini install lock entry is invalid");
    const parsedGemini = parseExecutable(gemini);
    const geminiEntrypointSha256 = requiredString(gemini, "entrypointSha256").toUpperCase();
    if (!/^[A-F0-9]{64}$/u.test(geminiEntrypointSha256))
        throw new Error("Gemini entrypoint SHA-256 is invalid");
    const antigravity = value["antigravity"];
    if (!isRecord(antigravity))
        throw new Error("Antigravity install lock entry is invalid");
    const parsedAntigravity = parseExecutable(antigravity);
    return {
        schemaVersion: 1,
        node: { version: requiredString(node, "version") },
        claude: parseExecutable(value["claude"]),
        claudeShadow: {
            ...parseExecutable(claudeShadow),
            openAiContextWindow: requiredPositiveInteger(claudeShadow, "openAiContextWindow"),
        },
        clodex: {
            package: "@bman654/clodex",
            version: requiredString(clodex, "version"),
            integrity: requiredString(clodex, "integrity"),
            entrypointSha256: clodexEntrypointSha256,
            capsuleEntrypointSha256,
            localPatch,
            localPatchSha256,
        },
        claudeClient: { mode: parsedClientMode },
        grok: {
            ...parsedGrok,
            sourceCommit: parsedGrokCommit,
            installerSha256,
        },
        gemini: {
            ...parsedGemini,
            entrypoint: requiredString(gemini, "entrypoint"),
            entrypointSha256: geminiEntrypointSha256,
        },
        antigravity: {
            ...parsedAntigravity,
            sourceManifest: requiredString(antigravity, "sourceManifest"),
        },
    };
}
export async function readInstallLock(path: string): Promise<InstallLock> {
    return parseInstallLock(JSON.parse(await readFile(path, "utf8")));
}
export function expandLockedPath(template: string, environment: NodeJS.ProcessEnv = process.env): string {
    const expanded = template.replace(/%([^%]+)%/gu, (_match: string, rawName: string) => {
        const name = rawName.toUpperCase();
        const value = environment[name] ?? environment[rawName];
        if (value === undefined || value.trim() === "") {
            throw new RouterError("adapter_unavailable", `Required path environment variable ${name} is unavailable.`, 503);
        }
        return value;
    });
    if (/%[^%]+%/u.test(expanded)) {
        throw new RouterError("adapter_unavailable", "A locked executable path could not be resolved.", 503);
    }
    return resolve(expanded);
}
export async function sha256File(path: string): Promise<string> {
    return await new Promise<string>((resolveHash, rejectHash) => {
        const hash = createHash("sha256");
        const stream = createReadStream(path);
        stream.on("data", (chunk) => hash.update(chunk as Buffer));
        stream.once("error", rejectHash);
        stream.once("end", () => resolveHash(hash.digest("hex").toUpperCase()));
    });
}
function isUnrecordedHash(sha256: string): boolean {
    return /^0+$/u.test(sha256);
}
async function executableCheck(component: InstallComponent, entry: LockedExecutable, environment: NodeJS.ProcessEnv): Promise<InstallCheck> {
    if (isUnrecordedHash(entry.sha256)) {
        return {
            component,
            expectedVersion: entry.version,
            status: "missing",
            detailCode: "locked_hash_placeholder_pending_self_heal",
        };
    }
    try {
        const actual = await sha256File(expandLockedPath(entry.executable, environment));
        return {
            component,
            expectedVersion: entry.version,
            status: actual === entry.sha256 ? "ok" : "drift",
            detailCode: actual === entry.sha256 ? "locked_hash_match" : "locked_hash_mismatch",
        };
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { component, expectedVersion: entry.version, status: "missing", detailCode: "locked_binary_missing" };
        }
        throw error;
    }
}
export function reportedVersionMatches(output: string, expectedVersion: string): boolean {
    const versions: readonly string[] = output.match(/(?<![0-9.])\d+\.\d+\.\d+(?![0-9.])/gu) ?? [];
    return versions.includes(expectedVersion);
}
// Grok reports its build commit beside its version ("grok 1.0.13 (5e9a58528b76)").
// The lock carried a sourceCommit field that NOTHING ever read -- shape checked,
// never compared. Two builds can share a version string; the commit is what tells
// them apart, so it is a gate now instead of a decorative record.
export function reportedBuildCommitMatches(output: string, expectedCommit: string): boolean {
    const commits: readonly string[] = output.match(/\b[0-9a-f]{7,40}\b/gu) ?? [];
    const expected = expectedCommit.toLowerCase();
    return commits.some((commit) => commit === expected || commit.startsWith(expected) || expected.startsWith(commit));
}
async function reportedVersionCheck(component: InstallComponent, expectedVersion: string, command: string, args: readonly string[], moduleRoot: string, environment: NodeJS.ProcessEnv, versionRunner: NonNullable<InstallVerificationOptions["versionRunner"]>, expectedBuildCommit?: string): Promise<InstallCheck> {
    try {
        const result = await versionRunner(command, args, {
            cwd: moduleRoot,
            environment,
            timeoutMs: 30_000,
            maximumOutputBytes: 64 * 1024,
        });
        const output = `${result.stdout}\n${result.stderr}`;
        const versionMatches = result.exitCode === 0 && reportedVersionMatches(output, expectedVersion);
        const commitMatches = expectedBuildCommit === undefined || reportedBuildCommitMatches(output, expectedBuildCommit);
        if (!versionMatches) {
            return { component, expectedVersion, status: "drift", detailCode: "locked_reported_version_mismatch" };
        }
        if (!commitMatches) {
            return { component, expectedVersion, status: "drift", detailCode: "locked_reported_build_commit_mismatch" };
        }
        return { component, expectedVersion, status: "ok", detailCode: "locked_reported_version_match" };
    }
    catch (error) {
        return {
            component,
            expectedVersion,
            status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "drift",
            detailCode: (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "locked_version_probe_missing"
                : "locked_version_probe_failed",
        };
    }
}
function combineChecks(primary: InstallCheck, version: InstallCheck): InstallCheck {
    if (primary.status !== "ok")
        return primary;
    if (version.status !== "ok")
        return version;
    return {
        component: primary.component,
        expectedVersion: primary.expectedVersion,
        status: "ok",
        detailCode: "locked_bytes_and_reported_version_match",
    };
}
export async function verifyClodexPackageLock(lock: InstallLock, moduleRoot: string): Promise<InstallCheck> {
    const expectedVersion = lock.clodex.version;
    const outcome = (status: InstallCheck["status"], detailCode: string): InstallCheck => ({
        component: "clodex",
        expectedVersion,
        status,
        detailCode,
    });
    const packageRoot = resolve(moduleRoot, "node_modules", lock.clodex.package);
    let manifest: unknown;
    try {
        manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    }
    catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
            ? outcome("missing", "locked_package_missing")
            : outcome("drift", "locked_package_manifest_unreadable");
    }
    if (!isRecord(manifest) || manifest["version"] !== expectedVersion) {
        return outcome("drift", "locked_package_version_mismatch");
    }
    let installerRecord: unknown;
    try {
        installerRecord = JSON.parse(await readFile(resolve(moduleRoot, "node_modules", ".package-lock.json"), "utf8"));
    }
    catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
            ? outcome("missing", "locked_package_installer_record_missing")
            : outcome("drift", "locked_package_installer_record_unreadable");
    }
    const packages = isRecord(installerRecord) ? installerRecord["packages"] : undefined;
    const entry = isRecord(packages) ? packages[`node_modules/${lock.clodex.package}`] : undefined;
    if (!isRecord(entry) || entry["integrity"] !== lock.clodex.integrity) {
        return outcome("drift", "locked_package_integrity_mismatch");
    }
    try {
        if ((await sha256File(resolve(packageRoot, "dist", "cli.js"))) !== lock.clodex.entrypointSha256) {
            return outcome("drift", "locked_package_entrypoint_hash_mismatch");
        }
    }
    catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
            ? outcome("missing", "locked_package_entrypoint_missing")
            : outcome("drift", "locked_package_entrypoint_unreadable");
    }
    return outcome("ok", "locked_bytes_and_reported_version_match");
}
export async function verifyInstallLock(lock: InstallLock, moduleRoot: string, environment: NodeJS.ProcessEnv = process.env, options: InstallVerificationOptions = {}): Promise<readonly InstallCheck[]> {
    const versionRunner = options.versionRunner ?? runCaptured;
    const nodeVersion = process.version.replace(/^v/u, "");
    const nodeCheck: InstallCheck = {
        component: "node",
        expectedVersion: lock.node.version,
        status: nodeVersion === lock.node.version ? "ok" : "drift",
        detailCode: nodeVersion === lock.node.version ? "locked_version_match" : "locked_version_mismatch",
    };
    const clodexEntrypoint = resolve(moduleRoot, "node_modules", "@bman654", "clodex", "dist", "cli.js");
    const claudeExecutable = expandLockedPath(lock.claude.executable, environment);
    const claudeShadowExecutable = expandLockedPath(lock.claudeShadow.executable, environment);
    const grokExecutable = expandLockedPath(lock.grok.executable, environment);
    const geminiEntrypointPath = expandLockedPath(lock.gemini.entrypoint, environment);
    const [claudeBytes, claudeShadowBytes, clodexBytes, grokBytes, geminiLauncher, geminiEntrypoint, antigravityBytes, claudeVersion, claudeShadowVersion, clodexVersion, grokVersion, geminiVersion,] = await Promise.all([
        executableCheck("claude", lock.claude, environment),
        executableCheck("claude-shadow", lock.claudeShadow, environment),
        verifyClodexPackageLock(lock, moduleRoot),
        executableCheck("grok", lock.grok, environment),
        executableCheck("gemini", lock.gemini, environment),
        executableCheck("gemini", {
            version: lock.gemini.version,
            executable: lock.gemini.entrypoint,
            sha256: lock.gemini.entrypointSha256,
        }, environment),
        executableCheck("antigravity", lock.antigravity, environment),
        reportedVersionCheck("claude", lock.claude.version, claudeExecutable, ["--version"], moduleRoot, environment, versionRunner),
        reportedVersionCheck("claude-shadow", lock.claudeShadow.version, claudeShadowExecutable, ["--version"], moduleRoot, environment, versionRunner),
        reportedVersionCheck("clodex", lock.clodex.version, process.execPath, [clodexEntrypoint, "--version"], moduleRoot, environment, versionRunner),
        reportedVersionCheck("grok", lock.grok.version, grokExecutable, ["--version"], moduleRoot, environment, versionRunner, lock.grok.sourceCommit),
        reportedVersionCheck("gemini", lock.gemini.version, process.execPath, [geminiEntrypointPath, "--version"], moduleRoot, environment, versionRunner),
    ]);
    const claude = combineChecks(claudeBytes, claudeVersion);
    const claudeShadow = combineChecks(claudeShadowBytes, claudeShadowVersion);
    const clodex = combineChecks(clodexBytes, clodexVersion);
    const grok = combineChecks(grokBytes, grokVersion);
    const geminiBytes: InstallCheck = geminiLauncher.status === "ok" && geminiEntrypoint.status === "ok"
        ? geminiEntrypoint
        : {
            component: "gemini",
            expectedVersion: lock.gemini.version,
            status: geminiLauncher.status === "missing" || geminiEntrypoint.status === "missing" ? "missing" : "drift",
            detailCode: geminiLauncher.status === "missing" || geminiEntrypoint.status === "missing"
                ? "locked_gemini_surface_missing"
                : "locked_gemini_surface_mismatch",
        };
    const gemini = combineChecks(geminiBytes, geminiVersion);
    const antigravity: InstallCheck = antigravityBytes.status === "ok"
        ? {
            component: "antigravity",
            expectedVersion: lock.antigravity.version,
            status: "ok",
            detailCode: "locked_manifest_hash_match",
        }
        : antigravityBytes;
    return [nodeCheck, claude, claudeShadow, clodex, grok, gemini, antigravity];
}
/**
 * A4 (2026-09-02). Side-provider nails: their violations do NOT CLOSE THE MAIN PATH. This
 * happened three times in one day -- antigravity drifted and `claude` never started at all.
 * For these two components a violation disables the provider for this session (provider-set:
 * install_lock_drift) and is logged by name; node/claude/claude-shadow/clodex stay HARD
 * through requireInstallChecks.
 */
export const SIDE_PROVIDER_COMPONENTS: Readonly<Partial<Record<InstallComponent, ProviderId>>> = {
    grok: "xai",
    antigravity: "google",
};
export interface SideProviderInstallDrift {
    readonly component: InstallComponent;
    readonly provider: ProviderId;
    readonly status: InstallCheck["status"];
    readonly detailCode: string;
}
export function sideProviderInstallDrift(checks: readonly InstallCheck[], components: readonly InstallComponent[]): SideProviderInstallDrift[] {
    const drift: SideProviderInstallDrift[] = [];
    for (const check of checks) {
        const provider = SIDE_PROVIDER_COMPONENTS[check.component];
        if (provider === undefined || !components.includes(check.component) || check.status === "ok")
            continue;
        drift.push({ component: check.component, provider, status: check.status, detailCode: check.detailCode });
    }
    return drift;
}
export function requireInstallChecks(checks: readonly InstallCheck[], components: readonly InstallComponent[]): void {
    const failed = checks.filter((check) => components.includes(check.component) && check.status !== "ok");
    if (failed.length > 0) {
        throw new RouterError("adapter_unavailable", `Pinned installation verification failed: ${failed.map((check) => check.component).join(", ")}. Run claude-oauth doctor.`, 503);
    }
}
