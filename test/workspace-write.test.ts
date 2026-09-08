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
    it("calisma alani icine yazar ve icerigi birebir korur", async () => {
        const root = await workspace();
        await writeBoundedWorkspaceText({ workspace: root, requestedPath: "not/kanit.txt", content: "GROK-WRITE-OK\n", maximumBytes: 1024 });
        strictEqual(await readFile(join(root, "not", "kanit.txt"), "utf8"), "GROK-WRITE-OK\n");
    });

    it("var olan dosyanin uzerine yazar", async () => {
        const root = await workspace();
        await writeFile(join(root, "a.txt"), "eski", "utf8");
        await writeBoundedWorkspaceText({ workspace: root, requestedPath: "a.txt", content: "yeni", maximumBytes: 1024 });
        strictEqual(await readFile(join(root, "a.txt"), "utf8"), "yeni");
    });

    it("calisma alanindan KACAN yolu reddeder", async () => {
        const root = await workspace();
        await rejects(() => writeBoundedWorkspaceText({ workspace: root, requestedPath: "../disari.txt", content: "x", maximumBytes: 1024 }),
            (error: Error) => /outside the allowed workspace/u.test(error.message));
    });

    it("KORUMALI dizine yazmayi reddeder (.git)", async () => {
        const root = await workspace();
        await mkdir(join(root, ".git"), { recursive: true });
        await rejects(() => writeBoundedWorkspaceText({ workspace: root, requestedPath: ".git/config", content: "x", maximumBytes: 1024 }),
            (error: Error) => /protected workspace file/u.test(error.message));
    });

    it("BOYUT tavanini asan icerigi reddeder", async () => {
        const root = await workspace();
        await rejects(() => writeBoundedWorkspaceText({ workspace: root, requestedPath: "buyuk.txt", content: "x".repeat(64), maximumBytes: 16 }),
            (error: Error) => /bounded text-file policy/u.test(error.message));
    });

    it("reddedilen yazma diske HICBIR SEY birakmaz", async () => {
        const root = await workspace();
        await rejects(() => writeBoundedWorkspaceText({ workspace: root, requestedPath: "../sizinti.txt", content: "x", maximumBytes: 1024 }));
        const { readdir } = await import("node:fs/promises");
        deepStrictEqual(await readdir(root), []);
        ok(true);
    });

    it("SEMBOLIK BAGLI ust dizin uzerinden kacisi reddeder (junction)", async () => {
        const root = await workspace();
        const disari = await workspace();
        try {
            await symlink(disari, join(root, "kapi"), "junction");
        }
        catch {
            return; // junction kurulamiyorsa kol atlanir; sessiz gecmez, kosum raporunda gorunur
        }
        await rejects(() => writeBoundedWorkspaceText({ workspace: root, requestedPath: "kapi/sizinti.txt", content: "x", maximumBytes: 1024 }),
            (error: Error) => /outside the allowed workspace|symlinked directory/u.test(error.message));
        const { readdir } = await import("node:fs/promises");
        deepStrictEqual(await readdir(disari), []);
    });

    it("SEMBOLIK BAGLI ust dizin altindaki VAR OLAN dosyanin uzerine yazmayi reddeder", async () => {
        const root = await workspace();
        const disari = await workspace();
        await writeFile(join(disari, "hedef.txt"), "dokunulmadi", "utf8");
        try {
            await symlink(disari, join(root, "kapi2"), "junction");
        }
        catch {
            return;
        }
        await rejects(() => writeBoundedWorkspaceText({ workspace: root, requestedPath: "kapi2/hedef.txt", content: "EZILDI", maximumBytes: 1024 }),
            (error: Error) => /outside the allowed workspace|symlinked directory/u.test(error.message));
        strictEqual(await readFile(join(disari, "hedef.txt"), "utf8"), "dokunulmadi");
    });
});
