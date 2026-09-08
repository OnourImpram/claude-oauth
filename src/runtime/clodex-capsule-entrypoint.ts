import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RouterError } from "../domain/errors.js";
import { patchClodexCapsule } from "./clodex-capsule-patch.js";
import { readInstallLock, requireInstallChecks, sha256File, verifyClodexPackageLock, type InstallLock } from "./install-lock.js";
import { ensurePrivateDirectory } from "./paths.js";

export interface ClodexCapsuleEntrypoint {
    readonly path: string;
    close(): Promise<void>;
}

export function requireClodexCapsuleHash(actual: string, lock: InstallLock): void {
    if (actual !== lock.clodex.capsuleEntrypointSha256) {
        throw new RouterError("adapter_unavailable", "Clodex capsule patched entrypoint hash does not match the install lock.", 503);
    }
}

export async function prepareClodexCapsuleEntrypoint(root: string): Promise<ClodexCapsuleEntrypoint> {
    const lock = await readInstallLock(join(root, "config", "install-lock.json"));
    requireInstallChecks([await verifyClodexPackageLock(lock, root)], ["clodex"]);
    const upstream = join(root, "node_modules", lock.clodex.package, "dist");
    const source = await readFile(join(upstream, "cli.js"), "utf8");
    // Validate the exact bytes being transformed too, after the package-level check.
    if (createHash("sha256").update(source).digest("hex").toUpperCase() !== lock.clodex.entrypointSha256) {
        throw new RouterError("adapter_unavailable", "Clodex capsule source entrypoint changed during preparation.", 503);
    }
    const patched = patchClodexCapsule(source);
    requireClodexCapsuleHash(createHash("sha256").update(patched).digest("hex").toUpperCase(), lock);
    // Stay below the module root so bare ESM imports use this installation's dependencies.
    // Source: https://nodejs.org/download/release/v24.14.0/docs/api/esm.html#resolution-algorithm-specification
    const parent = join(root, "dist", "clodex-capsules");
    await ensurePrivateDirectory(parent);
    const directory = await mkdtemp(join(parent, "session-"));
    const close = async (): Promise<void> => { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); };
    try {
        // This single sibling is the pinned bundle's only relative import.
        await copyFile(join(upstream, "chunk-J7WXOD2K.js"), join(directory, "chunk-J7WXOD2K.js"));
        await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
        const path = join(directory, "cli.js");
        await writeFile(path, patched, { encoding: "utf8", mode: 0o600, flag: "wx" });
        requireClodexCapsuleHash(await sha256File(path), lock);
        return { path, close };
    }
    catch (error) {
        await close();
        throw error;
    }
}
