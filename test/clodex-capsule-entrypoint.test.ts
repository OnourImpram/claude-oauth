import { strictEqual, rejects, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { patchClodexCapsule } from "../src/runtime/clodex-capsule-patch.js";
import { prepareClodexCapsuleEntrypoint } from "../src/runtime/clodex-capsule-entrypoint.js";
import { readInstallLock, sha256File } from "../src/runtime/install-lock.js";

const root = resolve(import.meta.dirname, "../..");
const upstream = join(root, "node_modules/@bman654/clodex/dist");
const sha = (source: string): string => createHash("sha256").update(source).digest("hex").toUpperCase();

async function isolatedInstallation(source: string, capsuleHash?: string): Promise<string> {
    const scratch = await mkdtemp(join(tmpdir(), "n05-install-"));
    const lock = await readInstallLock(join(root, "config/install-lock.json"));
    const packageRoot = join(scratch, "node_modules", lock.clodex.package);
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(join(scratch, "config"));
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: lock.clodex.version }));
    await writeFile(join(packageRoot, "dist/cli.js"), source);
    await copyFile(join(upstream, "chunk-J7WXOD2K.js"), join(packageRoot, "dist/chunk-J7WXOD2K.js"));
    await writeFile(join(scratch, "node_modules/.package-lock.json"), JSON.stringify({
        packages: { [`node_modules/${lock.clodex.package}`]: { integrity: lock.clodex.integrity } },
    }));
    await writeFile(join(scratch, "config/install-lock.json"), JSON.stringify({
        ...lock, clodex: { ...lock.clodex, entrypointSha256: sha(source), capsuleEntrypointSha256: capsuleHash ?? lock.clodex.capsuleEntrypointSha256 },
    }));
    return scratch;
}

it("N05 prepares a pinned copy, preserves upstream bytes and removes the copy on close", async () => {
    const before = await sha256File(join(upstream, "cli.js"));
    const prepared = await prepareClodexCapsuleEntrypoint(root);
    try {
        strictEqual(await sha256File(prepared.path), (await readInstallLock(join(root, "config/install-lock.json"))).clodex.capsuleEntrypointSha256);
        strictEqual(await sha256File(join(upstream, "cli.js")), before);
        strictEqual(prepared.path.startsWith(join(root, ".runtime", "clodex-capsules")), true);
        // B09: the capsule must never land inside a content-addressed directory of the release.
        strictEqual(prepared.path.startsWith(join(root, "dist")), false);
        strictEqual(prepared.path.startsWith(join(root, "config")), false);
    }
    finally {
        await prepared.close();
    }
    await rejects(access(dirname(prepared.path)));
});

for (const anchor of ["getServerPasswordForQuickMode", 'pathname === "/health"']) {
    it(`N05 missing patch anchor ${anchor} prevents entrypoint preparation`, async () => {
        const source = (await readFile(join(upstream, "cli.js"), "utf8")).replace(anchor, "n05_missing_anchor");
        const scratch = await isolatedInstallation(source);
        try {
            await rejects(prepareClodexCapsuleEntrypoint(scratch), /patch anchor .* matched 0 times/u);
            await rejects(access(join(scratch, ".runtime/clodex-capsules")));
        }
        finally { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    });
}

it("N05 ambiguous anchors and already patched bundles are rejected", async () => {
    const source = await readFile(join(upstream, "cli.js"), "utf8");
    throws(() => patchClodexCapsule(source + source), /matched 2 times/u);
    throws(() => patchClodexCapsule(patchClodexCapsule(source)), /matched 0 times/u);
});

it("N05 mismatched patched hash prevents entrypoint preparation", async () => {
    const source = await readFile(join(upstream, "cli.js"), "utf8");
    const wrongHash = sha(patchClodexCapsule(source) + "\n// changed bytes");
    const scratch = await isolatedInstallation(source, wrongHash);
    try {
        // Both sides are real digests of different bytes, never a placeholder hash.
        await rejects(async () => {
            const prepared = await prepareClodexCapsuleEntrypoint(scratch);
            await prepared.close();
        }, /patched entrypoint hash/u);
        await rejects(access(join(scratch, ".runtime/clodex-capsules")));
    }
    finally { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

it("N05 install lock requires a valid patched entrypoint digest", async () => {
    const lock = JSON.parse(await readFile(join(root, "config/install-lock.json"), "utf8")) as { clodex: Record<string, unknown> };
    const scratch = await mkdtemp(join(tmpdir(), "n05-lock-shape-"));
    try {
        for (const invalid of [undefined, "", "not-a-digest"]) {
            lock.clodex["capsuleEntrypointSha256"] = invalid;
            const path = join(scratch, "lock.json");
            await writeFile(path, JSON.stringify(lock));
            await rejects(readInstallLock(path), /capsuleEntrypointSha256|capsule entrypoint SHA-256/u);
        }
    }
    finally { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
