import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import fs, { mkdtemp, mkdtempDisposable, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeBoundedWorkspaceText } from "../src/security/workspace-read.js";

async function workspace(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "workspace-write-"));
}

describe("writeBoundedWorkspaceText", () => {
    it("writes inside the workspace and preserves the content exactly", async () => {
        const root = await workspace();
        await writeBoundedWorkspaceText({ workspace: root, requestedPath: "notes/evidence.txt", content: "GROK-WRITE-OK\n", maximumBytes: 1024 });
        strictEqual(await readFile(join(root, "notes", "evidence.txt"), "utf8"), "GROK-WRITE-OK\n");
    });

    it("overwrites an existing file", async () => {
        const root = await workspace();
        await writeFile(join(root, "a.txt"), "old content with a longer tail", "utf8");
        await writeBoundedWorkspaceText({ workspace: root, requestedPath: "a.txt", content: "new", maximumBytes: 1024 });
        strictEqual(await readFile(join(root, "a.txt"), "utf8"), "new");
    });

    it("B04 rejects a file replaced by an outside symlink after the path check", async (t) => {
        await using scratch = await mkdtempDisposable(join(tmpdir(), "workspace-race-"));
        const root = join(scratch.path, "inside");
        await mkdir(root);
        const target = join(root, "a.txt");
        const outside = join(scratch.path, "outside.txt");
        await writeFile(target, "original");
        await writeFile(outside, "untouched");
        const replacement = join(root, "replacement");
        await symlink(outside, replacement, "file");
        const originalRealpath = fs.realpath;
        let swapped = false;
        t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
            const checked = await originalRealpath(...args);
            if (String(args[0]) === target && !swapped) {
                swapped = true;
                await rename(target, join(root, "saved.txt"));
                await rename(replacement, target);
            }
            return checked;
        });
        syncBuiltinESMExports();
        try {
            const result = await writeBoundedWorkspaceText({ workspace: root, requestedPath: target, content: "OVERWRITTEN", maximumBytes: 1024 }).then(() => undefined, (error: unknown) => error);
            strictEqual(swapped, true, "race injection must execute");
            strictEqual(await readFile(outside, "utf8"), "untouched", "outside target was modified");
            ok(result instanceof Error, "replacement must fail closed");
        }
        finally {
            t.mock.restoreAll();
            syncBuiltinESMExports();
        }
    });

    it("B04 rejects an existing file redirected by a parent junction after the path check", async (t) => {
        await using scratch = await mkdtempDisposable(join(tmpdir(), "workspace-parent-race-"));
        const root = join(scratch.path, "inside");
        const parent = join(root, "notes");
        const outside = join(scratch.path, "outside");
        await mkdir(parent, { recursive: true });
        await mkdir(outside);
        const target = join(parent, "a.txt");
        await writeFile(target, "original");
        await writeFile(join(outside, "a.txt"), "untouched");
        const originalRealpath = fs.realpath;
        let swapped = false;
        t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
            const checked = await originalRealpath(...args);
            if (String(args[0]) === target && !swapped) {
                swapped = true;
                await rename(parent, join(root, "saved"));
                await symlink(outside, parent, "junction");
            }
            return checked;
        });
        syncBuiltinESMExports();
        try {
            const result = await writeBoundedWorkspaceText({ workspace: root, requestedPath: target, content: "OVERWRITTEN", maximumBytes: 1024 }).then(() => undefined, (error: unknown) => error);
            strictEqual(swapped, true);
            strictEqual(await readFile(join(outside, "a.txt"), "utf8"), "untouched");
            ok(result instanceof Error);
        }
        finally {
            t.mock.restoreAll();
            syncBuiltinESMExports();
        }
    });

    it("B04 refuses an outside symlink inserted at a new target before creation", async (t) => {
        await using scratch = await mkdtempDisposable(join(tmpdir(), "workspace-create-race-"));
        const root = join(scratch.path, "inside");
        await mkdir(root);
        const target = join(root, "new.txt");
        const outside = join(scratch.path, "outside.txt");
        await writeFile(outside, "untouched");
        const originalMkdir = fs.mkdir;
        let swapped = false;
        t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
            const result = await originalMkdir(...args);
            if (!swapped) {
                swapped = true;
                await symlink(outside, target, "file");
            }
            return result;
        });
        syncBuiltinESMExports();
        try {
            const result = await writeBoundedWorkspaceText({ workspace: root, requestedPath: target, content: "OVERWRITTEN", maximumBytes: 1024 }).then(() => undefined, (error: unknown) => error);
            strictEqual(swapped, true);
            strictEqual(await readFile(outside, "utf8"), "untouched");
            ok(result instanceof Error);
        }
        finally {
            t.mock.restoreAll();
            syncBuiltinESMExports();
        }
    });

    it("rejects a path that ESCAPES the workspace", async () => {
        const root = await workspace();
        await rejects(() => writeBoundedWorkspaceText({ workspace: root, requestedPath: "../outside.txt", content: "x", maximumBytes: 1024 }),
            (error: Error) => /outside the allowed workspace/u.test(error.message));
    });

    it("rejects writes to a PROTECTED directory (.git)", async () => {
        const root = await workspace();
        await mkdir(join(root, ".git"), { recursive: true });
        await rejects(() => writeBoundedWorkspaceText({ workspace: root, requestedPath: ".git/config", content: "x", maximumBytes: 1024 }),
            (error: Error) => /protected workspace file/u.test(error.message));
    });

    it("rejects content exceeding the SIZE cap", async () => {
        const root = await workspace();
        await rejects(() => writeBoundedWorkspaceText({ workspace: root, requestedPath: "large.txt", content: "x".repeat(64), maximumBytes: 16 }),
            (error: Error) => /bounded text-file policy/u.test(error.message));
    });

    it("a rejected write leaves NOTHING on disk", async () => {
        const root = await workspace();
        await rejects(() => writeBoundedWorkspaceText({ workspace: root, requestedPath: "../leak.txt", content: "x", maximumBytes: 1024 }));
        const { readdir } = await import("node:fs/promises");
        deepStrictEqual(await readdir(root), []);
        ok(true);
    });

    it("rejects escape through a SYMLINKED parent directory (junction)", async () => {
        const root = await workspace();
        const outside = await workspace();
        try {
            await symlink(outside, join(root, "gate"), "junction");
        }
        catch {
            return; // if the junction cannot be created the arm is skipped; not a silent pass, it shows up in the run report
        }
        await rejects(() => writeBoundedWorkspaceText({ workspace: root, requestedPath: "gate/leak.txt", content: "x", maximumBytes: 1024 }),
            (error: Error) => /outside the allowed workspace|symlinked directory/u.test(error.message));
        const { readdir } = await import("node:fs/promises");
        deepStrictEqual(await readdir(outside), []);
    });

    it("rejects overwriting an EXISTING file under a SYMLINKED parent directory", async () => {
        const root = await workspace();
        const outside = await workspace();
        await writeFile(join(outside, "target.txt"), "untouched", "utf8");
        try {
            await symlink(outside, join(root, "gate2"), "junction");
        }
        catch {
            return;
        }
        await rejects(() => writeBoundedWorkspaceText({ workspace: root, requestedPath: "gate2/target.txt", content: "OVERWRITTEN", maximumBytes: 1024 }),
            (error: Error) => /outside the allowed workspace|symlinked directory/u.test(error.message));
        strictEqual(await readFile(join(outside, "target.txt"), "utf8"), "untouched");
    });
});
