import type { Dirent } from "node:fs";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// A directory the router creates for one run (an Antigravity call home, a Clodex capsule)
// carries a small record of who owns it. A crash, a closed terminal or a killed process
// skips every `finally`, so the directory stays; the record is what lets a later start tell
// "left behind" from "in use by a session that is running right now".
//
// The sweep lived in antigravity/config-home.ts and served that lane alone. The Clodex
// capsule directories had no owner record and no sweep at all: every abnormal exit left one
// copied bundle behind, without bound (audit D1-07, 2026-11-15).
export const OWNER_FILE = ".hezarfen-owner.json";
const defaultStaleAfterMs = 6 * 60 * 60 * 1000;

export interface OwnerRecord {
    readonly pid: number;
    readonly createdAt: number;
}
export interface OwnedSweepOptions {
    readonly root: string;
    readonly staleAfterMs?: number;
    readonly now?: () => number;
    /** Injected in tests; production asks the OS whether the owner is still alive. */
    readonly isProcessAlive?: (pid: number) => boolean;
    /** Called once per directory that could not be removed. */
    readonly onCleanupFailed?: () => void;
}
export interface SweepOutcome {
    readonly removed: readonly string[];
    readonly kept: readonly string[];
}

export async function writeOwnerRecord(directory: string, now: number = Date.now()): Promise<void> {
    const owner: OwnerRecord = { pid: process.pid, createdAt: now };
    await writeFile(join(directory, OWNER_FILE), `${JSON.stringify(owner)}\n`, "utf8");
}

/**
 * Removes directories left behind by a crash, and KEEPS the ones still owned by a live process.
 *
 * Both halves matter. A sweep that deletes everything would pass a "the stale one is gone"
 * test while destroying a running session's files -- which is why every measure of it has a
 * second arm asserting that the live directory survives.
 */
export async function sweepOwnedDirectories(options: OwnedSweepOptions): Promise<SweepOutcome> {
    const now = (options.now ?? Date.now)();
    const staleAfterMs = options.staleAfterMs ?? defaultStaleAfterMs;
    const alive = options.isProcessAlive ?? processIsAlive;
    const removed: string[] = [];
    const kept: string[] = [];
    let entries: Dirent[];
    try {
        entries = await readdir(options.root, { withFileTypes: true });
    }
    catch {
        return { removed, kept };
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const path = join(options.root, entry.name);
        const owner = await readOwner(path);
        // An unreadable owner record means the directory is not accounted for by anyone. It
        // is swept -- but only past the TTL, so one caught mid-creation is not destroyed.
        const stale = owner === undefined
            ? await olderThan(path, now, staleAfterMs)
            : now - owner.createdAt > staleAfterMs || !alive(owner.pid);
        if (!stale) {
            kept.push(path);
            continue;
        }
        try {
            await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
            removed.push(path);
        }
        catch {
            kept.push(path);
            options.onCleanupFailed?.();
        }
    }
    return { removed, kept };
}

async function readOwner(path: string): Promise<OwnerRecord | undefined> {
    try {
        const parsed: unknown = JSON.parse(await readFile(join(path, OWNER_FILE), "utf8"));
        if (typeof parsed !== "object" || parsed === null)
            return undefined;
        const record = parsed as Record<string, unknown>;
        if (typeof record["pid"] !== "number" || typeof record["createdAt"] !== "number")
            return undefined;
        return { pid: record["pid"], createdAt: record["createdAt"] };
    }
    catch {
        return undefined;
    }
}

async function olderThan(path: string, now: number, staleAfterMs: number): Promise<boolean> {
    try {
        return now - (await stat(path)).mtimeMs > staleAfterMs;
    }
    catch {
        return false;
    }
}

export function processIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        // Signal 0 performs the permission and existence check WITHOUT delivering a signal.
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM means the process exists but belongs to someone else -- alive, not ours.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}
