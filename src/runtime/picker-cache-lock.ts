// picker-cache-lock.ts -- lets parallel claude-oauth windows each keep their own /model list.
//
// WHY (2026-11-16, measured on Claude Code 2.1.325)
// Claude Code reads ~/.claude/cache/gateway-models.json ONCE, during startup (the gateway prime runs
// before discovery), keeps the result in memory for the life of the process, and lists the external
// models only when the cached baseUrl equals its own ANTHROPIC_BASE_URL. A window that has started is
// therefore never hurt when the file changes later. What breaks parallel windows is a second launcher
// writing its own address in the gap between the first launcher's write and the first Claude's read.
//
// SOLUTION: every launcher writes the cache with its own address, under this lock, and keeps the lock
// until its Claude has read the file. The signal is Claude's own session record,
// <config>/sessions/<pid>.json: measured 0.43 to 0.83 s AFTER the read, for three processes started
// together (a fixed hold failed that test: under load the read came 10.8 s after the write). The next
// window waits for the lock, so each Claude reads its own address. A lock whose owner died, or whose
// deadline passed, is taken over; after PICKER_LOCK_MAX_WAIT_MS a window proceeds without it.
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Longest hold when Claude's session record never appears (an older Claude, a shell wrapper). */
export const PICKER_PRIME_MAX_HOLD_MS = 30_000;
/** How long a window waits for the lock before it writes anyway. */
export const PICKER_LOCK_MAX_WAIT_MS = 45_000;
/** Lock record lifetime: the longest hold plus the launcher's own setup before spawn. */
const LOCK_DEADLINE_MS = PICKER_PRIME_MAX_HOLD_MS + 10_000;

export interface PickerCacheLock {
    readonly acquired: boolean;
    readonly waitedMs: number;
    /** Removes the lock if this window still owns it; safe to call more than once. */
    release(): Promise<void>;
}

export interface PickerCacheLockOptions {
    readonly deadlineMs?: number;
    readonly maxWaitMs?: number;
    readonly pollMs?: number;
    readonly now?: () => number;
    readonly isAlive?: (pid: number) => boolean;
}

interface LockRecord {
    readonly pid: number;
    readonly token: string;
    readonly expiresAt: number;
}

/** The lock sits next to the cache file it protects, so a different CLAUDE_CONFIG_DIR gets its own. */
export function pickerCacheLockPath(cachePath: string): string {
    return `${cachePath}.claude-oauth.lock`;
}

/** The record Claude Code writes for its process right after the startup read (see header). */
export function claudeSessionRecordPath(configDirectory: string, pid: number): string {
    return join(configDirectory, "sessions", `${pid}.json`);
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

async function readRecord(path: string): Promise<LockRecord | undefined> {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
        if (typeof parsed.pid === "number" && typeof parsed.token === "string" && typeof parsed.expiresAt === "number")
            return { pid: parsed.pid, token: parsed.token, expiresAt: parsed.expiresAt };
    }
    catch {
        // Missing or unreadable: treated as no valid owner.
    }
    return undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function acquirePickerCacheLock(lockPath: string, options: PickerCacheLockOptions = {}): Promise<PickerCacheLock> {
    const deadlineMs = options.deadlineMs ?? LOCK_DEADLINE_MS;
    const maxWaitMs = options.maxWaitMs ?? PICKER_LOCK_MAX_WAIT_MS;
    const pollMs = options.pollMs ?? 100;
    const now = options.now ?? Date.now;
    const isAlive = options.isAlive ?? processIsAlive;
    const token = `${process.pid}-${randomUUID()}`;
    const started = now();
    const unlocked = (): PickerCacheLock => ({ acquired: false, waitedMs: now() - started, release: async () => undefined });
    try {
        await mkdir(dirname(lockPath), { recursive: true });
    }
    catch {
        return unlocked();
    }
    for (;;) {
        // The record is written to a private file and hard-linked into place: the lock file never
        // exists without its content, so a waiter can never mistake a half-written lock for a dead one.
        const draft = `${lockPath}.${token}`;
        const record: LockRecord = { pid: process.pid, token, expiresAt: now() + deadlineMs };
        let linked = false;
        let failure: string | undefined;
        try {
            await writeFile(draft, JSON.stringify(record), "utf8");
            await link(draft, lockPath);
            linked = true;
        }
        catch (error) {
            failure = (error as NodeJS.ErrnoException).code ?? "lock_failed";
        }
        finally {
            await unlink(draft).catch(() => undefined);
        }
        if (linked) {
            return {
                acquired: true,
                waitedMs: now() - started,
                release: async () => {
                    const current = await readRecord(lockPath);
                    if (current?.token === token)
                        await unlink(lockPath).catch(() => undefined);
                },
            };
        }
        if (failure !== "EEXIST")
            return unlocked();
        const holder = await readRecord(lockPath);
        if (holder === undefined || holder.expiresAt <= now() || !isAlive(holder.pid)) {
            const removed = await unlink(lockPath).then(() => true, () => false);
            if (removed)
                continue;
        }
        if (now() - started >= maxWaitMs)
            return unlocked();
        await sleep(pollMs);
    }
}

/**
 * Releases the lock once Claude's session record for `pid` has been written after `spawnedAt`, or
 * after `maxMs`. A record older than the spawn belongs to an earlier process with the same id and
 * does not count. Returns a cancel function; cancelling stops the watch without releasing.
 */
export function releaseWhenClaudeStarted(
    lock: PickerCacheLock,
    sessionRecord: string,
    spawnedAt: number,
    options: { readonly maxMs?: number; readonly pollMs?: number } = {},
): () => void {
    const maxMs = options.maxMs ?? PICKER_PRIME_MAX_HOLD_MS;
    const pollMs = options.pollMs ?? 100;
    let stopped = false;
    const fresh = (): Promise<boolean> =>
        stat(sessionRecord).then((info) => info.mtimeMs >= spawnedAt - 2_000, () => false);
    void (async () => {
        while (!stopped) {
            if (Date.now() - spawnedAt >= maxMs || (await fresh())) {
                if (!stopped)
                    await lock.release();
                return;
            }
            await sleep(pollMs);
        }
    })();
    return () => {
        stopped = true;
    };
}
