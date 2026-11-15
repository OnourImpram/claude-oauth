import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { OWNER_FILE } from "../src/runtime/owned-directory.js";
import { prepareClodexCapsuleEntrypoint } from "../src/runtime/clodex-capsule-entrypoint.js";
import { runtimePaths, runtimeSessionPaths } from "../src/runtime/paths.js";
import { readActiveSupervisorStatuses, startSupervisorIpc, type SupervisorStatus } from "../src/supervisor/ipc.js";
import { sweepStaleSessionStates } from "../src/supervisor/session-sweep.js";

// Audit D1-07 (2026-11-15): per-session artefacts survived every non-graceful exit and
// nothing swept them. Three measures: the session state files, the discovery that reads
// them, and the Clodex capsule directories.

const repositoryRoot = resolve(import.meta.dirname, "../..");
let scratch = "";
before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "session-sweep-"));
});
after(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const hourAgo = (): Date => new Date(Date.now() - 60 * 60 * 1000);
const running = (pid: number): SupervisorStatus => ({ schemaVersion: 1, status: "running", pid, startedAt: new Date().toISOString(), models: [], providers: [] });

describe("sweepStaleSessionStates", () => {
    it("removes the state file of a session whose endpoint no longer answers, and keeps a live one", async () => {
        const paths = runtimePaths({ LOCALAPPDATA: join(scratch, "sweep-a") });
        const sessions = join(paths.root, "sessions");
        await mkdir(sessions, { recursive: true });
        const dead = "a".repeat(32);
        const live = "b".repeat(32);
        for (const id of [dead, live]) {
            await writeFile(join(sessions, `${id}.json`), "{}", "utf8");
            await utimes(join(sessions, `${id}.json`), hourAgo(), hourAgo());
        }
        await writeFile(join(sessions, "notes.txt"), "not a session file", "utf8");
        const outcome = await sweepStaleSessionStates({
            paths,
            probe: async (ipcPath) => (ipcPath === runtimeSessionPaths(paths, live).ipc ? running(1234) : undefined),
        });
        deepStrictEqual(outcome.removed.map((path) => basename(path)), [`${dead}.json`]);
        deepStrictEqual(outcome.kept.map((path) => basename(path)), [`${live}.json`]);
        deepStrictEqual((await readdir(sessions)).sort(), [`${live}.json`, "notes.txt"]);
    });

    it("NEGATIVE: a file written a moment ago is kept even if nothing answers yet", async () => {
        const paths = runtimePaths({ LOCALAPPDATA: join(scratch, "sweep-b") });
        const sessions = join(paths.root, "sessions");
        await mkdir(sessions, { recursive: true });
        const starting = "c".repeat(32);
        await writeFile(join(sessions, `${starting}.json`), "{}", "utf8");
        const outcome = await sweepStaleSessionStates({ paths, probe: async () => undefined });
        deepStrictEqual(outcome.removed, []);
        strictEqual(outcome.kept.length, 1);
    });

    it("a missing sessions directory is not an error", async () => {
        const paths = runtimePaths({ LOCALAPPDATA: join(scratch, "sweep-none") });
        deepStrictEqual(await sweepStaleSessionStates({ paths, probe: async () => undefined }), { removed: [], kept: [] });
    });
});

describe("readActiveSupervisorStatuses", () => {
    it("finds a live session even when more than 256 dead state files sort before it", async () => {
        const paths = runtimePaths({ LOCALAPPDATA: join(scratch, "discovery") });
        const sessions = join(paths.root, "sessions");
        await mkdir(sessions, { recursive: true });
        for (let index = 0; index < 300; index += 1) {
            const id = index.toString(16).padStart(32, "0");
            await writeFile(join(sessions, `${id}.json`), "{}", "utf8");
            await utimes(join(sessions, `${id}.json`), hourAgo(), hourAgo());
        }
        const liveId = "f".repeat(32); // sorts after every dead file
        const livePaths = runtimeSessionPaths(paths, liveId);
        const status = running(process.pid);
        const ipc = await startSupervisorIpc(livePaths.ipc, () => status);
        try {
            await writeFile(join(sessions, `${liveId}.json`), "{}", "utf8");
            const found = await readActiveSupervisorStatuses(paths);
            strictEqual(found.length, 1, "the live session must be discovered");
            strictEqual(found[0]?.pid, process.pid);
        }
        finally {
            await ipc.close();
        }
    });
});

describe("Clodex capsule directories", () => {
    it("a capsule records its owner, a dead owner's capsule is swept at the next start, a live owner's survives", async () => {
        const parent = join(repositoryRoot, ".runtime", "clodex-capsules");
        await mkdir(parent, { recursive: true });
        const orphan = join(parent, "session-orphan-test");
        const inUse = join(parent, "session-in-use-test");
        await mkdir(orphan, { recursive: true });
        await mkdir(inUse, { recursive: true });
        // No process has this id: the largest 32-bit value is far above any pid the OS hands out.
        await writeFile(join(orphan, OWNER_FILE), JSON.stringify({ pid: 2_147_483_646, createdAt: Date.now() }), "utf8");
        await writeFile(join(inUse, OWNER_FILE), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
        const prepared = await prepareClodexCapsuleEntrypoint(repositoryRoot);
        try {
            const owner = JSON.parse(await readFile(join(dirname(prepared.path), OWNER_FILE), "utf8")) as { pid: number };
            strictEqual(owner.pid, process.pid, "the new capsule names this process as its owner");
            await access(orphan).then(() => { throw new Error("the orphaned capsule was not swept"); }, (error: NodeJS.ErrnoException) => strictEqual(error.code, "ENOENT"));
            await access(inUse);
            ok(true);
        }
        finally {
            await prepared.close();
            await rm(orphan, { recursive: true, force: true });
            await rm(inUse, { recursive: true, force: true });
        }
    });
});
