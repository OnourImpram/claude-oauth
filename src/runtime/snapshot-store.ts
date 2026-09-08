import { createHash, randomUUID } from "node:crypto";
import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname } from "node:path";
import type { ModelSnapshot } from "../domain/contracts.js";
import { parseModelSnapshot } from "../domain/validation.js";
import { writeSafeLog } from "./log.js";
import { ensurePrivateDirectory } from "./paths.js";
export async function readSnapshot(path: string): Promise<ModelSnapshot> {
    return parseModelSnapshot(JSON.parse(await readFile(path, "utf8")));
}
type SnapshotProbe =
    | { readonly state: "ok"; readonly snapshot: ModelSnapshot }
    | { readonly state: "missing" }
    | { readonly state: "unreadable" };

function pathFingerprint(path: string): string {
    return createHash("sha256").update(path, "utf8").digest("hex").slice(0, 16);
}

// The snapshot is the only source of the /model surface. Treating an unparseable or
// schema-invalid file as fatal means one bad write bricks the `claude` command with a
// raw SyntaxError -- the baseline is right there and the file is a rebuildable cache.
// It falls back, but never silently: a snapshot that had to be discarded is a real
// condition someone should see in the log.
async function probeSnapshot(path: string): Promise<SnapshotProbe> {
    try {
        return { state: "ok", snapshot: await readSnapshot(path) };
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { state: "missing" };
        writeSafeLog({
            event: "snapshot_unreadable",
            level: "warn",
            code: "snapshot_discarded",
            pathFingerprint: pathFingerprint(path),
            remedy: "The model snapshot could not be parsed and the pinned baseline was used instead. ONARIM: run \"claude-oauth models refresh\" to rebuild it from the live provider catalogues.",
        });
        return { state: "unreadable" };
    }
}

export async function readSnapshotOrDefault(runtimePath: string, defaultPath: string): Promise<ModelSnapshot> {
    const probe = await probeSnapshot(runtimePath);
    return probe.state === "ok" ? probe.snapshot : await readSnapshot(defaultPath);
}
// On Windows a rename is not the unconditional atomic swap POSIX promises. Two renames
// racing for the same destination -- or an indexer/AV holding the destination open --
// make MoveFileEx fail TRANSIENTLY with EPERM/EACCES/EBUSY. Measured here: eight
// concurrent writeSnapshot calls, one EPERM. That is a collision, not a permission
// defect, so it is retried a bounded number of times; when the budget runs out the
// error is rethrown UNCHANGED, because a genuine permission failure must never be
// swallowed by the retry that exists for the transient one.
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPT_BUDGET = 10;

async function renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            await rename(from, to);
            return;
        }
        catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? "";
            if (attempt >= RENAME_ATTEMPT_BUDGET || !TRANSIENT_RENAME_CODES.has(code))
                throw error;
            await delay(attempt);
        }
    }
}

export async function writeSnapshot(path: string, snapshot: ModelSnapshot): Promise<void> {
    parseModelSnapshot(snapshot);
    await ensurePrivateDirectory(dirname(path));
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
        await renameWithRetry(temporary, path);
    }
    finally {
        await unlink(temporary).catch(() => undefined);
    }
}
export async function seedSnapshot(runtimePath: string, defaultPath: string): Promise<void> {
    await ensurePrivateDirectory(dirname(runtimePath));
    const probe = await probeSnapshot(runtimePath);
    if (probe.state === "ok")
        return;
    if (probe.state === "unreadable") {
        // Only remove a file we actually observed to be unreadable. Unlinking on the
        // "missing" path too would open a window where a concurrent launcher's freshly
        // published good snapshot gets deleted.
        await unlink(runtimePath).catch(() => undefined);
    }
    const defaultContents = await readFile(defaultPath, "utf8");
    parseModelSnapshot(JSON.parse(defaultContents));
    const temporary = `${runtimePath}.${process.pid}.${randomUUID()}.seed`;
    await writeFile(temporary, defaultContents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
        try {
            // Publishing a hard link is atomic and never exposes a partially written
            // snapshot. Exactly one concurrent launcher wins; every other launcher
            // validates the winner instead of overwriting it.
            await link(temporary, runtimePath);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                throw error;
            await readSnapshot(runtimePath);
        }
    }
    finally {
        await unlink(temporary).catch(() => undefined);
    }
}
