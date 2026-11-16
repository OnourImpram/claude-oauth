// picker-cache-lock: parallel claude-oauth windows each keep their own /model list (2026-11-16).
// Measured fault: three windows, the two opened while the first held port 8791 listed only the
// native models. Each window must write its own address and the next window must wait until the
// previous Claude has read the file.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { acquirePickerCacheLock, claudeSessionRecordPath, pickerCacheLockPath, releaseWhenClaudeStarted } from "../src/runtime/picker-cache-lock.js";

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const present = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

async function waitFor(condition: () => Promise<boolean>, limitMs: number): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < limitMs) {
        if (await condition())
            return true;
        await pause(20);
    }
    return condition();
}

const directories: string[] = [];
after(async () => {
    for (const directory of directories)
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function lockPath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "picker-lock-"));
    directories.push(directory);
    return pickerCacheLockPath(join(directory, "gateway-models.json"));
}

describe("picker cache lock", () => {
    it("sits next to the cache file it protects", () => {
        assert.equal(pickerCacheLockPath(join("a", "gateway-models.json")), join("a", "gateway-models.json.claude-oauth.lock"));
    });

    it("a free lock is taken at once and released by its owner", async () => {
        const path = await lockPath();
        const lock = await acquirePickerCacheLock(path, { deadlineMs: 5_000 });
        assert.equal(lock.acquired, true);
        assert.ok(lock.waitedMs < 1_000);
        assert.ok(JSON.parse(await readFile(path, "utf8")).pid === process.pid);
        await lock.release();
        await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
        await lock.release(); // a second release is harmless
    });

    it("the measured case: a second window waits until the first releases, then writes", async () => {
        const path = await lockPath();
        const first = await acquirePickerCacheLock(path, { deadlineMs: 5_000 });
        const order: string[] = [];
        const second = acquirePickerCacheLock(path, { deadlineMs: 5_000, pollMs: 10 }).then((lock) => {
            order.push("second acquired");
            return lock;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        order.push("first releases");
        await first.release();
        const lock = await second;
        assert.deepEqual(order, ["first releases", "second acquired"]);
        assert.equal(lock.acquired, true);
        assert.ok(lock.waitedMs >= 100, `waited ${lock.waitedMs} ms`);
        await lock.release();
    });

    it("a lock whose owner died is taken over without waiting for the deadline", async () => {
        const path = await lockPath();
        await writeFile(path, JSON.stringify({ pid: 999_999, token: "dead", expiresAt: Date.now() + 60_000 }), "utf8");
        const lock = await acquirePickerCacheLock(path, { isAlive: () => false, maxWaitMs: 2_000 });
        assert.equal(lock.acquired, true);
        assert.ok(lock.waitedMs < 1_000);
        await lock.release();
    });

    it("a lock past its deadline is taken over even if its owner still runs", async () => {
        const path = await lockPath();
        await writeFile(path, JSON.stringify({ pid: process.pid, token: "old", expiresAt: Date.now() - 1 }), "utf8");
        const lock = await acquirePickerCacheLock(path, { maxWaitMs: 2_000 });
        assert.equal(lock.acquired, true);
        await lock.release();
    });

    it("an unreadable lock file counts as having no owner", async () => {
        const path = await lockPath();
        await writeFile(path, "{ not json", "utf8");
        const lock = await acquirePickerCacheLock(path, { maxWaitMs: 2_000 });
        assert.equal(lock.acquired, true);
        await lock.release();
    });

    it("a live owner past the wait limit: the window proceeds unlocked and leaves the owner's lock alone", async () => {
        const path = await lockPath();
        const owner = { pid: process.pid, token: "live", expiresAt: Date.now() + 60_000 };
        await writeFile(path, JSON.stringify(owner), "utf8");
        const lock = await acquirePickerCacheLock(path, { maxWaitMs: 200, pollMs: 20 });
        assert.equal(lock.acquired, false);
        assert.ok(lock.waitedMs >= 200);
        await lock.release();
        assert.deepEqual(JSON.parse(await readFile(path, "utf8")), owner, "release must not remove a lock it does not own");
    });

    it("an owner whose lock was taken over does not remove the new owner's lock", async () => {
        const path = await lockPath();
        const stale = await acquirePickerCacheLock(path, { deadlineMs: 5_000 });
        const fresh = await acquirePickerCacheLock(path, { isAlive: () => false, maxWaitMs: 2_000 });
        assert.equal(fresh.acquired, true);
        await stale.release();
        assert.ok(JSON.parse(await readFile(path, "utf8")).token !== undefined, "the new owner's lock survives");
        await fresh.release();
        await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
    });
});

// The release signal: Claude Code writes <config>/sessions/<pid>.json right after its startup read
// (measured 0.43 to 0.83 s after, three processes started together).
describe("release when Claude has started", () => {
    it("names the record Claude writes for its process", () => {
        assert.equal(claudeSessionRecordPath(join("c"), 4242), join("c", "sessions", "4242.json"));
    });

    it("holds the lock until the session record appears, then releases it", async () => {
        const path = await lockPath();
        const record = claudeSessionRecordPath(dirname(path), 4242);
        const lock = await acquirePickerCacheLock(path);
        const stop = releaseWhenClaudeStarted(lock, record, Date.now(), { pollMs: 10 });
        await pause(200);
        assert.equal(await present(path), true, "no record yet: the next window must still wait");
        await mkdir(dirname(record), { recursive: true });
        await writeFile(record, "{}", "utf8");
        assert.equal(await waitFor(async () => !(await present(path)), 2_000), true, "released after the record");
        stop();
    });

    it("a record left by an earlier process with the same id does not count", async () => {
        const path = await lockPath();
        const record = claudeSessionRecordPath(dirname(path), 4243);
        await mkdir(dirname(record), { recursive: true });
        await writeFile(record, "{}", "utf8");
        const old = new Date(Date.now() - 60_000);
        await utimes(record, old, old);
        const lock = await acquirePickerCacheLock(path);
        const stop = releaseWhenClaudeStarted(lock, record, Date.now(), { pollMs: 10, maxMs: 5_000 });
        await pause(200);
        assert.equal(await present(path), true, "a stale record must not release the lock");
        stop();
        await lock.release();
    });

    it("releases after the longest hold when no record ever appears", async () => {
        const path = await lockPath();
        const lock = await acquirePickerCacheLock(path);
        releaseWhenClaudeStarted(lock, claudeSessionRecordPath(dirname(path), 4244), Date.now(), { pollMs: 10, maxMs: 150 });
        assert.equal(await waitFor(async () => !(await present(path)), 2_000), true);
    });

    it("a cancelled watch leaves the release to the caller", async () => {
        const path = await lockPath();
        const record = claudeSessionRecordPath(dirname(path), 4245);
        const lock = await acquirePickerCacheLock(path);
        const stop = releaseWhenClaudeStarted(lock, record, Date.now(), { pollMs: 10 });
        stop();
        await mkdir(dirname(record), { recursive: true });
        await writeFile(record, "{}", "utf8");
        await pause(150);
        assert.equal(await present(path), true);
        await lock.release();
        assert.equal(await present(path), false);
    });
});
