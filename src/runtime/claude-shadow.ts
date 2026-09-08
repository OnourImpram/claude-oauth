import { createHash, randomUUID } from "node:crypto";
import {
    copyFile,
    mkdtemp,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { RouterError } from "../domain/errors.js";
import { sanitizedWorkerEnvironment } from "../security/environment.js";
import { runCaptured, type CapturedProcess, type ProcessOptions } from "./child-process.js";
import {
    expandLockedPath,
    readInstallLock,
    requireInstallChecks,
    sha256File,
    verifyClodexPackageLock,
    verifyInstallLock,
    resolveClaudeClientMode,
    type ClaudeClientMode,
    type InstallCheck,
    type InstallLock,
} from "./install-lock.js";
import { writeSafeLog } from "./log.js";
import { ensurePrivateDirectory, runtimePaths, type RuntimePaths } from "./paths.js";
import { verifyReleaseIdentity, type ReleaseIdentity } from "./release-identity.js";
type ProcessRunner = (command: string, args: readonly string[], options: ProcessOptions) => Promise<CapturedProcess>;
export interface ClaudeShadowState {
    readonly status: "current" | "rebuilt" | "repatched" | "bypassed-native";
    readonly nativeVersion: string;
    readonly nativeSha256: string;
    readonly shadowSha256: string;
    readonly manifestPath: string;
}
export interface PreparedInstallation {
    readonly installLock: InstallLock;
    readonly installChecks: readonly InstallCheck[];
    readonly shadow: ClaudeShadowState;
    readonly releaseIdentity: ReleaseIdentity;
    readonly clientMode: ClaudeClientMode;
}
export interface EnsureClaudeShadowOptions {
    readonly root: string;
    readonly baseLock: InstallLock;
    readonly environment?: NodeJS.ProcessEnv;
    readonly paths?: RuntimePaths;
    readonly runner?: ProcessRunner;
    readonly lockWaitMs?: number;
}
interface RuntimeManifest {
    readonly schemaVersion: 1;
    readonly generatedAt: string;
    readonly native: {
        readonly version: string;
        readonly executable: string;
        readonly sha256: string;
    };
    readonly shadow: {
        readonly version: string;
        readonly executable: string;
        readonly sha256: string;
    };
    readonly clodex: {
        readonly version: string;
        readonly configHash: string;
        readonly localPatchSha256: string;
        readonly requiredPatchCount: number;
    };
}
interface ClodexPatchManifest {
    readonly binaryPath: string;
    readonly claudeVersion: string;
    readonly configHash: string;
    readonly patchedSize: number;
    readonly patchedSha256: string;
    readonly backupPath: string;
    readonly pristineSha256: string;
}
// NOT a measured count of clodex's patches, and it never was: this is a GENERATION
// LABEL for this router's OWN runtime manifest. Nothing compares it to clodex output --
// it is written into current.json and read back for equality, so a manifest produced
// under an older local-patch contract is rejected and the shadow is repatched. That
// round trip is the only thing this number measures, and the name now says so.
//
// MEASURED 2026-09-05 in clodex 2.11.1 dist/cli.js (this run), because "12 verified
// patches" was a claim the file could not support: `applyOnce(` occurs 13 times (1
// definition + 12 call sites), but two of those call sites live inside
// patchEffortCapability, which is itself called three times (8a/8b/8c), and inside it
// the "(refresh)" arm and the fresh arm exclude each other (same shape in PATCH 7 and
// 9). Distinct PATCH identities in the bundle: 11 -- 1,3,4,5,6,7,8a,8b,8c,9,10, with no
// PATCH 2. So 12 is neither the call-site count nor the identity count.
//
// The on-disk key stays `requiredPatchCount`: renaming it would invalidate every
// installed manifest and force a repatch for a cosmetic gain. Bumping this number is
// how you DELIBERATELY invalidate them.
const SHADOW_MANIFEST_GENERATION = 12;
const PATCH_LOCK_WAIT_MS = 120_000;
const SHA256_PATTERN = /^[A-F0-9]{64}$/u;
const CONFIG_HASH_PATTERN = /^[a-f0-9]{64}$/u;
// One needle per surface the local patch is supposed to have rewritten. Each must
// appear EXACTLY once: zero means the patch did not apply, twice means it applied
// twice and the picker is doubled.
//
// The validator needle exists because that arm used to hardcode two aliases while
// the rest of the patch was array-driven -- a new picker row was offered and then
// rejected. Only the array literal is pinned; the surrounding parameter name is
// minified and varies per Claude build.
export const SHADOW_MODEL_SURFACE_NEEDLES = [
    "/*clodex-local:hezarfen-google-oauth-model-surface*/",
    '{value:"gemini",label:"Gemini",description:"Gemini 3.8 Flash High (Google OAuth, 1M context)"}',
    '{value:"gemini-pro",label:"Gemini Pro",description:"Gemini 3.1 Pro High (Google OAuth, 1M context)"}',
    '{value:"opus-google",label:"Opus Google",description:"Claude Opus 4.6 Thinking (Google OAuth, 1M context)"}',
    '{value:"grok",label:"Grok",description:"Grok 4.6 (xAI OAuth, 500K context)"}',
    'case"gemini":return "gemini";',
    'case"gemini-pro":return "gemini-pro";',
    'case"opus-google":return "opus-google";',
    'case"grok":return "grok";',
    '["gemini","gemini-pro","opus-google","grok"].indexOf(',
];
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizedPath(path: string): string {
    const resolved = resolve(path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function samePath(left: string, right: string): boolean {
    return normalizedPath(left) === normalizedPath(right);
}
function assertPathInside(parent: string, candidate: string): void {
    const relativePath = relative(resolve(parent), resolve(candidate));
    if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || resolve(relativePath) === relativePath) {
        throw new RouterError("adapter_unavailable", "Claude shadow path escaped its private runtime directory.", 503);
    }
}
function parseClaudeVersion(output: string): string {
    const matches: readonly string[] = output.match(/(?<![0-9.])\d+\.\d+\.\d+(?![0-9.])/gu) ?? [];
    const distinct = [...new Set(matches)];
    if (distinct.length !== 1) {
        throw new RouterError("adapter_unavailable", "Claude Code returned an ambiguous version during shadow verification.", 503);
    }
    return distinct[0] as string;
}
function requiredString(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || value.trim() === "")
        throw new Error(`invalid ${key}`);
    return value;
}
function parseRuntimeManifest(value: unknown): RuntimeManifest {
    if (!isRecord(value) || value["schemaVersion"] !== 1)
        throw new Error("invalid runtime manifest header");
    const native = value["native"];
    const shadow = value["shadow"];
    const clodex = value["clodex"];
    if (!isRecord(native) || !isRecord(shadow) || !isRecord(clodex))
        throw new Error("invalid runtime manifest body");
    const nativeSha256 = requiredString(native, "sha256").toUpperCase();
    const shadowSha256 = requiredString(shadow, "sha256").toUpperCase();
    const configHash = requiredString(clodex, "configHash").toLowerCase();
    const localPatchSha256 = requiredString(clodex, "localPatchSha256").toUpperCase();
    if (!SHA256_PATTERN.test(nativeSha256) ||
        !SHA256_PATTERN.test(shadowSha256) ||
        !SHA256_PATTERN.test(localPatchSha256) ||
        !CONFIG_HASH_PATTERN.test(configHash)) {
        throw new Error("invalid runtime manifest digest");
    }
    if (clodex["requiredPatchCount"] !== SHADOW_MANIFEST_GENERATION)
        throw new Error("invalid patch count");
    return {
        schemaVersion: 1,
        generatedAt: requiredString(value, "generatedAt"),
        native: {
            version: requiredString(native, "version"),
            executable: requiredString(native, "executable"),
            sha256: nativeSha256,
        },
        shadow: {
            version: requiredString(shadow, "version"),
            executable: requiredString(shadow, "executable"),
            sha256: shadowSha256,
        },
        clodex: {
            version: requiredString(clodex, "version"),
            configHash,
            localPatchSha256,
            requiredPatchCount: SHADOW_MANIFEST_GENERATION,
        },
    };
}
function parseClodexPatchManifest(value: unknown): ClodexPatchManifest {
    if (!isRecord(value))
        throw new Error("invalid Clodex patch manifest");
    const patchedSha256 = requiredString(value, "patchedSha256").toUpperCase();
    const pristineSha256 = requiredString(value, "pristineSha256").toUpperCase();
    const configHash = requiredString(value, "configHash").toLowerCase();
    const patchedSize = value["patchedSize"];
    if (!SHA256_PATTERN.test(patchedSha256) ||
        !SHA256_PATTERN.test(pristineSha256) ||
        !CONFIG_HASH_PATTERN.test(configHash) ||
        typeof patchedSize !== "number" ||
        !Number.isSafeInteger(patchedSize) ||
        patchedSize <= 0) {
        throw new Error("invalid Clodex patch proof");
    }
    return {
        binaryPath: requiredString(value, "binaryPath"),
        claudeVersion: requiredString(value, "claudeVersion"),
        configHash,
        patchedSize,
        patchedSha256,
        backupPath: requiredString(value, "backupPath"),
        pristineSha256,
    };
}
async function readRuntimeManifest(path: string): Promise<RuntimeManifest | undefined> {
    try {
        return parseRuntimeManifest(JSON.parse(await readFile(path, "utf8")));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
        return undefined;
    }
}
async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return false;
        throw error;
    }
}
function countBufferOccurrences(buffer: Buffer, needle: string): number {
    const bytes = Buffer.from(needle, "utf8");
    let count = 0;
    let offset = 0;
    while ((offset = buffer.indexOf(bytes, offset)) >= 0) {
        count += 1;
        offset += bytes.byteLength;
    }
    return count;
}
export async function verifyShadowModelSurface(target: string): Promise<void> {
    const binary = await readFile(target);
    const failures: string[] = [];
    for (const [index, needle] of SHADOW_MODEL_SURFACE_NEEDLES.entries()) {
        const occurrences = countBufferOccurrences(binary, needle);
        if (occurrences !== 1) {
            failures.push(`needle[${index}] x${occurrences}`);
        }
    }
    if (failures.length > 0) {
        throw new RouterError("adapter_unavailable", `Claude shadow did not contain the exact required OAuth model-picker proof (${failures.join(", ")}). FIX: relaunch -- a stale local patch now resets the shadow to pristine and repatches automatically. If it repeats, the pinned Clodex could not apply config/claude-oauth-local-patches.mjs to this Claude build.`, 503);
    }
}
async function installTrustedLocalPatch(root: string, lock: InstallLock, paths: RuntimePaths): Promise<string> {
    const source = resolve(root, lock.clodex.localPatch);
    const expectedSha256 = lock.clodex.localPatchSha256;
    const destination = join(paths.clodexHome, "local-patches.mjs");
    assertPathInside(paths.clodexHome, destination);
    if (await pathExists(destination)) {
        if ((await sha256File(destination)) === expectedSha256)
            return expectedSha256;
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    assertPathInside(paths.clodexHome, temporary);
    await copyFile(source, temporary);
    try {
        if ((await sha256File(temporary)) !== expectedSha256) {
            throw new RouterError("adapter_unavailable", "Staged Claude local patch failed integrity verification.", 503);
        }
        await rm(destination, { force: true });
        await rename(temporary, destination);
    }
    finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
    return expectedSha256;
}
async function delay(milliseconds: number): Promise<void> {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
async function shadowLockEndpoint(path: string): Promise<string> {
    const physicalParent = await realpath(dirname(path));
    const physicalPath = join(physicalParent, basename(path));
    const canonical = process.platform === "win32" ? physicalPath.toLowerCase() : physicalPath;
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    if (process.platform === "win32")
        return `\\\\.\\pipe\\hezarfen-claude-shadow-${digest}`;
    if (process.platform === "linux")
        return `\0hezarfen-claude-shadow-${digest}`;
    throw new RouterError("adapter_unavailable", "Owner-safe Claude shadow locking is unavailable on this platform.", 503);
}
async function tryAcquireShadowLock(endpoint: string): Promise<Server | undefined> {
    const server = createServer((socket) => socket.destroy());
    server.unref();
    return await new Promise((resolveLock, rejectLock) => {
        const onError = (error: NodeJS.ErrnoException): void => {
            server.removeListener("listening", onListening);
            if (error.code === "EADDRINUSE") {
                resolveLock(undefined);
                return;
            }
            rejectLock(error);
        };
        const onListening = (): void => {
            server.removeListener("error", onError);
            resolveLock(server);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(endpoint);
    });
}
async function releaseShadowLock(server: Server): Promise<void> {
    await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
            if (error !== undefined) {
                rejectClose(error);
                return;
            }
            resolveClose();
        });
    });
}
async function acquireShadowLock(path: string, waitMs: number): Promise<() => Promise<void>> {
    await ensurePrivateDirectory(dirname(path));
    const endpoint = await shadowLockEndpoint(path);
    const deadline = Date.now() + waitMs;
    while (true) {
        const server = await tryAcquireShadowLock(endpoint);
        if (server !== undefined)
            return async () => await releaseShadowLock(server);
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            break;
        await delay(Math.min(100, remaining));
    }
    throw new RouterError("adapter_unavailable", "Timed out waiting for Claude shadow self-heal.", 503);
}
async function probeVersion(executable: string, root: string, environment: NodeJS.ProcessEnv, runner: ProcessRunner): Promise<string> {
    const result = await runner(executable, ["--version"], {
        cwd: root,
        environment,
        timeoutMs: 45_000,
        maximumOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) {
        throw new RouterError("adapter_unavailable", `${basename(executable)} version verification failed.`, 503);
    }
    return parseClaudeVersion(`${result.stdout}\n${result.stderr}`);
}
async function installPristineTarget(nativeExecutable: string, nativeSha256: string, target: string, paths: RuntimePaths, force = false): Promise<void> {
    if (await pathExists(target)) {
        if (!force)
            return;
        // Reset an already-patched shadow back to pristine. Clodex only patches a
        // pristine binary, so without this a stale patch can never be replaced.
        await rm(target, { force: true });
    }
    const stagingDirectory = await mkdtemp(join(paths.shadowRoot, ".install-"));
    assertPathInside(paths.shadowRoot, stagingDirectory);
    const staged = join(stagingDirectory, "claude.exe");
    try {
        await copyFile(nativeExecutable, staged);
        if ((await sha256File(staged)) !== nativeSha256 || (await sha256File(nativeExecutable)) !== nativeSha256) {
            throw new RouterError("adapter_unavailable", "Claude Code changed while its shadow copy was being prepared.", 503);
        }
        // Fast path: publish the whole staging directory atomically. It only works
        // when the shadow directory does not exist yet. On the reset path it does,
        // and Windows reports that as EEXIST, ENOTEMPTY or EPERM depending on the
        // filesystem -- so the fallback is keyed on the observed result, not on
        // guessing the error code.
        try {
            await rename(stagingDirectory, dirname(target));
        }
        catch (error) {
            if (!(await pathExists(dirname(target))))
                throw error;
        }
        if (!(await pathExists(target)))
            await copyFile(staged, target);
    }
    finally {
        if (await pathExists(stagingDirectory)) {
            assertPathInside(paths.shadowRoot, stagingDirectory);
            await rm(stagingDirectory, { recursive: true, force: true });
        }
    }
}
function runtimeManifestMatches(manifest: RuntimeManifest | undefined, nativeVersion: string, nativeExecutable: string, nativeSha256: string, target: string, targetSha256: string, clodexVersion: string, localPatchSha256: string): boolean {
    return (manifest !== undefined &&
        manifest.native.version === nativeVersion &&
        samePath(manifest.native.executable, nativeExecutable) &&
        manifest.native.sha256 === nativeSha256 &&
        manifest.shadow.version === nativeVersion &&
        samePath(manifest.shadow.executable, target) &&
        manifest.shadow.sha256 === targetSha256 &&
        manifest.clodex.version === clodexVersion &&
        manifest.clodex.localPatchSha256 === localPatchSha256);
}
async function writeRuntimeManifest(path: string, manifest: RuntimeManifest): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    assertPathInside(dirname(path), temporary);
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
        await rename(temporary, path);
    }
    finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}
async function validatedPatchManifest(paths: RuntimePaths, target: string, nativeVersion: string, nativeSha256: string, expectedLocalPatchSha256?: string): Promise<ClodexPatchManifest> {
    const manifest = parseClodexPatchManifest(JSON.parse(await readFile(join(paths.clodexHome, "patch-state.json"), "utf8")));
    assertPathInside(paths.shadowRoot, manifest.binaryPath);
    assertPathInside(paths.shadowPatchBackups, manifest.backupPath);
    if (!samePath(manifest.binaryPath, target) ||
        manifest.claudeVersion !== nativeVersion ||
        manifest.pristineSha256 !== nativeSha256 ||
        manifest.patchedSha256 !== (await sha256File(target)) ||
        manifest.patchedSize !== (await stat(target)).size ||
        (await sha256File(manifest.backupPath)) !== nativeSha256) {
        throw new RouterError("adapter_unavailable", "Clodex patch proof did not match the current Claude shadow.", 503);
    }
    if (expectedLocalPatchSha256 !== undefined) {
        const localPatch = join(paths.clodexHome, "local-patches.mjs");
        const config: unknown = JSON.parse(await readFile(join(paths.clodexHome, "config.json"), "utf8"));
        if ((await sha256File(localPatch)) !== expectedLocalPatchSha256 ||
            !isRecord(config) ||
            config["localPatchesEnabled"] !== true) {
            throw new RouterError("adapter_unavailable", "Clodex local patch state did not match the pinned model surface.", 503);
        }
    }
    return manifest;
}
export async function ensureClaudeShadow(options: EnsureClaudeShadowOptions): Promise<{
    readonly installLock: InstallLock;
    readonly shadow: ClaudeShadowState;
}> {
    const environment = options.environment ?? process.env;
    const paths = options.paths ?? runtimePaths(environment);
    const runner = options.runner ?? runCaptured;
    await Promise.all([
        ensurePrivateDirectory(paths.root),
        ensurePrivateDirectory(paths.shadowRoot),
        ensurePrivateDirectory(paths.shadowPatchBackups),
        ensurePrivateDirectory(paths.clodexHome),
    ]);
    const release = await acquireShadowLock(paths.shadowLock, options.lockWaitMs ?? PATCH_LOCK_WAIT_MS);
    try {
        const localPatchSha256 = await installTrustedLocalPatch(options.root, options.baseLock, paths);
        const nativeExecutable = expandLockedPath(options.baseLock.claude.executable, environment);
        const nativeVersion = await probeVersion(nativeExecutable, options.root, sanitizedWorkerEnvironment("anthropic", environment), runner);
        const nativeSha256 = await sha256File(nativeExecutable);
        const targetDirectory = join(paths.shadowRoot, `claude-${nativeVersion}-${nativeSha256.slice(0, 8)}`);
        const target = join(targetDirectory, "claude.exe");
        assertPathInside(paths.shadowRoot, targetDirectory);
        await installPristineTarget(nativeExecutable, nativeSha256, target, paths);
        let beforeSha256 = await sha256File(target);
        const previousManifest = await readRuntimeManifest(paths.shadowManifest);
        let manifestIsCurrent = runtimeManifestMatches(previousManifest, nativeVersion, nativeExecutable, nativeSha256, target, beforeSha256, options.baseLock.clodex.version, localPatchSha256);
        // REGRESSION GUARD: the reuse decision used to look ONLY at "is the target
        // already patched", and manifestIsCurrent was computed but used solely to
        // decide whether to rewrite the manifest file. Editing the local patch --
        // adding a model row, for instance -- therefore never took effect: the stale
        // shadow was reused, verifyShadowModelSurface then refused it, and the system
        // became unlaunchable while its own FIX line pointed at a command that does
        // not repatch. A stale manifest now forces a pristine reset and a real repatch.
        if (beforeSha256 !== nativeSha256 && !manifestIsCurrent) {
            await installPristineTarget(nativeExecutable, nativeSha256, target, paths, true);
            beforeSha256 = await sha256File(target);
            manifestIsCurrent = false;
        }
        if (beforeSha256 !== nativeSha256) {
            const patchManifest = await validatedPatchManifest(paths, target, nativeVersion, nativeSha256, localPatchSha256);
            await verifyShadowModelSurface(target);
            if ((await probeVersion(target, options.root, sanitizedWorkerEnvironment("anthropic", environment), runner)) !== nativeVersion) {
                throw new RouterError("adapter_unavailable", "Claude shadow version differs from the native installation.", 503);
            }
            if ((await sha256File(nativeExecutable)) !== nativeSha256) {
                throw new RouterError("adapter_unavailable", "Native Claude Code changed during shadow verification. Retry the launch.", 503);
            }
            const manifest: RuntimeManifest = {
                schemaVersion: 1,
                generatedAt: new Date().toISOString(),
                native: { version: nativeVersion, executable: nativeExecutable, sha256: nativeSha256 },
                shadow: { version: nativeVersion, executable: target, sha256: beforeSha256 },
                clodex: {
                    version: options.baseLock.clodex.version,
                    configHash: patchManifest.configHash,
                    localPatchSha256,
                    requiredPatchCount: SHADOW_MANIFEST_GENERATION,
                },
            };
            if (!manifestIsCurrent || previousManifest?.clodex.configHash !== patchManifest.configHash) {
                await writeRuntimeManifest(paths.shadowManifest, manifest);
            }
            return {
                installLock: {
                    ...options.baseLock,
                    claude: {
                        version: nativeVersion,
                        executable: nativeExecutable,
                        sha256: nativeSha256,
                    },
                    claudeShadow: {
                        ...options.baseLock.claudeShadow,
                        version: nativeVersion,
                        executable: target,
                        sha256: beforeSha256,
                    },
                },
                shadow: {
                    status: "current",
                    nativeVersion,
                    nativeSha256,
                    shadowSha256: beforeSha256,
                    manifestPath: paths.shadowManifest,
                },
            };
        }
        const patchEnvironment = sanitizedWorkerEnvironment("openai", environment);
        patchEnvironment["CLODEX_HOME"] = paths.clodexHome;
        patchEnvironment["TWEAKCC_CC_INSTALLATION_PATH"] = target;
        patchEnvironment["TWEAKCC_CONFIG_DIR"] = paths.shadowPatchBackups;
        patchEnvironment["NO_COLOR"] = "1";
        const patchResult = await runner(process.execPath, [join(options.root, "node_modules", "@bman654", "clodex", "dist", "cli.js"), "patch", "--trace", "--enable-local-patches"], {
            cwd: options.root,
            environment: patchEnvironment,
            timeoutMs: 120_000,
            maximumOutputBytes: 1024 * 1024,
        });
        const patchOutput = `${patchResult.stdout}\n${patchResult.stderr}`;
        const unchanged = patchOutput.includes("nothing to do");
        const completePatch = patchOutput.includes("0 failed") && !patchOutput.includes("FAILED patches:");
        if (patchResult.exitCode !== 0 && !completePatch) {
            throw new RouterError("adapter_unavailable", "Pinned Clodex could not rebuild the Claude shadow.", 503);
        }
        if (!unchanged && !completePatch) {
            writeSafeLog({
                event: "clodex_patch_proof_incomplete",
                level: "warn",
                provider: "anthropic",
                code: "patch_proof_missing",
                exitCode: patchResult.exitCode,
                patchOutputBytes: Buffer.byteLength(patchOutput, "utf8"),
                patchOutputFingerprint: createHash("sha256").update(patchOutput, "utf8").digest("hex").slice(0, 16),
                remedy: "Clodex reported no complete patch proof; the decisive check is verifyShadowModelSurface below, which throws when the binary lacks the model-picker strings.",
            });
        }
        const patchManifest = await validatedPatchManifest(paths, target, nativeVersion, nativeSha256, localPatchSha256);
        const shadowSha256 = await sha256File(target);
        if (shadowSha256 === nativeSha256) {
            throw new RouterError("adapter_unavailable", "Claude shadow remained pristine after patching.", 503);
        }
        await verifyShadowModelSurface(target);
        if ((await probeVersion(target, options.root, sanitizedWorkerEnvironment("anthropic", environment), runner)) !== nativeVersion) {
            throw new RouterError("adapter_unavailable", "Claude shadow version differs from the native installation.", 503);
        }
        if ((await sha256File(nativeExecutable)) !== nativeSha256) {
            throw new RouterError("adapter_unavailable", "Native Claude Code changed during shadow verification. Retry the launch.", 503);
        }
        const manifest: RuntimeManifest = {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            native: { version: nativeVersion, executable: nativeExecutable, sha256: nativeSha256 },
            shadow: { version: nativeVersion, executable: target, sha256: shadowSha256 },
            clodex: {
                version: options.baseLock.clodex.version,
                configHash: patchManifest.configHash,
                localPatchSha256,
                requiredPatchCount: SHADOW_MANIFEST_GENERATION,
            },
        };
        await writeRuntimeManifest(paths.shadowManifest, manifest);
        const status = beforeSha256 === nativeSha256 ? "rebuilt" : beforeSha256 === shadowSha256 ? "current" : "repatched";
        return {
            installLock: {
                ...options.baseLock,
                claude: {
                    version: nativeVersion,
                    executable: nativeExecutable,
                    sha256: nativeSha256,
                },
                claudeShadow: {
                    ...options.baseLock.claudeShadow,
                    version: nativeVersion,
                    executable: target,
                    sha256: shadowSha256,
                },
            },
            shadow: {
                status,
                nativeVersion,
                nativeSha256,
                shadowSha256,
                manifestPath: paths.shadowManifest,
            },
        };
    }
    finally {
        await release();
    }
}
export async function prepareEffectiveInstallation(root: string, environment: NodeJS.ProcessEnv = process.env): Promise<PreparedInstallation> {
    // Every entry point funnels through here -- the CLI commands via context() and the
    // bare `claude` launch via launchClaudeOAuth -- so this is the only place the
    // release-identity check cannot be routed around.
    const releaseIdentity = await verifyReleaseIdentity(root, environment);
    if (releaseIdentity.status === "mismatch") {
        throw new RouterError("adapter_unavailable", `Refusing to run release ${releaseIdentity.declaredId ?? "?"}: its contents no longer hash to its own id (${releaseIdentity.detailCode}). A content-addressed release that was edited in place is not the release it claims to be. FIX: reinstall the release, or run "node scripts/release-id.mjs --verify <release-directory>" to see the computed id.`, 503);
    }
    const baseLock = await readInstallLock(resolve(root, "config", "install-lock.json"));
    const nodeVersion = process.version.replace(/^v/u, "");
    if (nodeVersion !== baseLock.node.version) {
        throw new RouterError("adapter_unavailable", "Pinned Node.js verification failed before Claude shadow self-heal.", 503);
    }
    const clientMode = resolveClaudeClientMode(baseLock, environment);
    if (clientMode === "native-gateway") {
        // NO patching. The client is the signed native binary itself; external models
        // arrive through Claude Code's own gateway model discovery and their full model
        // identities. Clodex is never run on this path, so the clodex package check is not
        // a precondition either.
        const nativeExecutable = expandLockedPath(baseLock.claude.executable, environment);
        const nativeSha256 = await sha256File(nativeExecutable);
        const nativeLock: InstallLock = {
            ...baseLock,
            claudeShadow: {
                ...baseLock.claudeShadow,
                version: baseLock.claude.version,
                executable: nativeExecutable,
                sha256: nativeSha256,
            },
        };
        const nativeChecks = await verifyInstallLock(nativeLock, root, environment);
        return {
            installLock: nativeLock,
            installChecks: nativeChecks,
            shadow: {
                status: "bypassed-native",
                nativeVersion: baseLock.claude.version,
                nativeSha256,
                shadowSha256: nativeSha256,
                manifestPath: "(native-gateway: no shadow)",
            },
            releaseIdentity,
            clientMode,
        };
    }
    const clodexCheck = await verifyClodexPackageLock(baseLock, root);
    requireInstallChecks([clodexCheck], ["clodex"]);
    const effective = await ensureClaudeShadow({ root, baseLock, environment });
    const installChecks = await verifyInstallLock(effective.installLock, root, environment);
    return { installLock: effective.installLock, installChecks, shadow: effective.shadow, releaseIdentity, clientMode };
}
