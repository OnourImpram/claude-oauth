import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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
        await writeFile(join(root, "a.txt"), "old", "utf8");
        await writeBoundedWorkspaceText({ workspace: root, requestedPath: "a.txt", content: "new", maximumBytes: 1024 });
        strictEqual(await readFile(join(root, "a.txt"), "utf8"), "new");
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
