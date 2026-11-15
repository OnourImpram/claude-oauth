import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RouterError } from "../domain/errors.js";
import { patchClodexCapsule } from "./clodex-capsule-patch.js";
import { copyCapsuleSiblings } from "./clodex-capsule-siblings.js";
import { readInstallLock, requireInstallChecks, sha256File, verifyClodexPackageLock, type InstallLock } from "./install-lock.js";
import { writeSafeLog } from "./log.js";
import { sweepOwnedDirectories, writeOwnerRecord } from "./owned-directory.js";
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
    // Stay OUTSIDE the content-addressed directories (dist, config): a capsule left behind by a
    // killed session changed the release id and the next start refused the release (B09).
    const parent = join(root, ".runtime", "clodex-capsules");
    await ensurePrivateDirectory(parent);
    // A session that was killed never ran its close(): its capsule (a copied bundle) stayed
    // here for good. Capsules whose owner process is gone are removed before a new one is
    // made; a capsule owned by a session that is still running is left alone (D1-07).
    await sweepOwnedDirectories({
        root: parent,
        onCleanupFailed: () => writeSafeLog({ event: "clodex_capsule_cleanup_failed", level: "warn" }),
    });
    const directory = await mkdtemp(join(parent, "session-"));
    const close = async (): Promise<void> => { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); };
    try {
        // The siblings are whatever the bundle itself imports by relative path (its chunk names
        // change with every release), refused with a 503 when one leaves the package's dist.
        await copyCapsuleSiblings(upstream, patched, directory);
        await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
        await writeOwnerRecord(directory);
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
