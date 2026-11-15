import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { prepareClodexCapsuleEntrypoint } from "../src/runtime/clodex-capsule-entrypoint.js";
import { patchClodexCapsule } from "../src/runtime/clodex-capsule-patch.js";
import { readInstallLock } from "../src/runtime/install-lock.js";

// The capsule copies the bundle's sibling files next to the patched entrypoint. Which files those
// are is read from the bundle's own relative imports; no file name is written down here. Every test
// builds a throwaway installation whose dist directory is a fixture, so the answer cannot depend on
// which Clodex release happens to be installed.
const root = resolve(import.meta.dirname, "../..");
const realUpstream = join(root, "node_modules/@bman654/clodex/dist");
const sha = (source: string): string => createHash("sha256").update(source).digest("hex").toUpperCase();
const fixtureChunk = "chunk-fixture-one.js";

interface Installation {
    readonly scratch: string;
    readonly dist: string;
    readonly packageRoot: string;
    readonly capsules: string;
}

/**
 * `extraImports` is appended to the real entrypoint text, so the patch anchors still match; `files`
 * maps a path relative to dist (it may climb out with "..") to the bytes written there.
 */
async function installation(extraImports: string, files: Readonly<Record<string, string>>): Promise<Installation> {
    const realSource = await readFile(join(realUpstream, "cli.js"), "utf8");
    const realChunkName = /\bfrom\s*"\.\/([^"]+)"/u.exec(realSource)?.[1];
    if (realChunkName === undefined)
        throw new Error("The installed bundle has no relative import to build a fixture from.");
    const source = `${realSource.replace(`"./${realChunkName}"`, `"./${fixtureChunk}"`)}\n${extraImports}\n`;
    const scratch = await mkdtemp(join(tmpdir(), "capsule-siblings-"));
    const lock = await readInstallLock(join(root, "config/install-lock.json"));
    const packageRoot = join(scratch, "node_modules", lock.clodex.package);
    const dist = join(packageRoot, "dist");
    await mkdir(dist, { recursive: true });
    await mkdir(join(scratch, "config"));
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: lock.clodex.version }));
    await writeFile(join(dist, "cli.js"), source);
    await writeFile(join(dist, fixtureChunk), await readFile(join(realUpstream, realChunkName)));
    for (const [relativePath, content] of Object.entries(files)) {
        const target = join(dist, relativePath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
    }
    await writeFile(join(scratch, "node_modules/.package-lock.json"), JSON.stringify({
        packages: { [`node_modules/${lock.clodex.package}`]: { integrity: lock.clodex.integrity } },
    }));
    await writeFile(join(scratch, "config/install-lock.json"), JSON.stringify({
        ...lock, clodex: { ...lock.clodex, entrypointSha256: sha(source), capsuleEntrypointSha256: sha(patchClodexCapsule(source)) },
    }));
    return { scratch, dist, packageRoot, capsules: join(scratch, ".runtime", "clodex-capsules") };
}

async function withInstallation(
    extraImports: string,
    files: Readonly<Record<string, string>>,
    body: (fixture: Installation) => Promise<void>,
): Promise<void> {
    const fixture = await installation(extraImports, files);
    try {
        await body(fixture);
    }
    finally {
        await rm(fixture.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory())
            found.push(...await listFiles(join(directory, entry.name), `${prefix}${entry.name}/`));
        else
            found.push(`${prefix}${entry.name}`);
    }
    return found.sort();
}

const fixtureFiles = (capsuleFiles: readonly string[]): string[] =>
    capsuleFiles.filter((name) => name !== ".hezarfen-owner.json" && name !== "package.json" && name !== "cli.js");

it("N05 copies the sibling the entrypoint itself imports, whatever its file name is", async () => {
    await withInstallation("", {}, async (fixture) => {
        const prepared = await prepareClodexCapsuleEntrypoint(fixture.scratch);
        try {
            deepStrictEqual(fixtureFiles(await listFiles(dirname(prepared.path))), [fixtureChunk]);
            strictEqual(
                (await readFile(join(dirname(prepared.path), fixtureChunk))).equals(await readFile(join(fixture.dist, fixtureChunk))),
                true,
            );
        }
        finally { await prepared.close(); }
    });
});

it("N05 copies siblings named by static, bare and dynamic imports and leaves bare package imports alone", async () => {
    const imports = [
        'export { staticName } from "./forms/static.js";',
        'import "./forms/bare.js";',
        'const lazy = () => import("./forms/dynamic.js");',
        'import { somewhere } from "ws";',
        'import { readFileSync } from "node:fs";',
    ].join("\n");
    await withInstallation(imports, {
        "forms/static.js": "export const staticName = 1;\n",
        "forms/bare.js": "\n",
        "forms/dynamic.js": "export default 3;\n",
    }, async (fixture) => {
        const prepared = await prepareClodexCapsuleEntrypoint(fixture.scratch);
        try {
            deepStrictEqual(fixtureFiles(await listFiles(dirname(prepared.path))),
                [fixtureChunk, "forms/bare.js", "forms/dynamic.js", "forms/static.js"]);
        }
        finally { await prepared.close(); }
    });
});

it("N05 follows relative imports through the copied chunks, keeping their directory layout", async () => {
    await withInstallation('import "./first.js";', {
        "first.js": 'import "./nested/second.js";\n',
        "nested/second.js": 'export * from "../third.js";\n',
        "third.js": 'import "./first.js";\nexport const third = 3;\n',
    }, async (fixture) => {
        const prepared = await prepareClodexCapsuleEntrypoint(fixture.scratch);
        try {
            // third.js imports first.js back: a cycle is legal ESM and must neither loop nor fail.
            deepStrictEqual(fixtureFiles(await listFiles(dirname(prepared.path))),
                [fixtureChunk, "first.js", "nested/second.js", "third.js"]);
        }
        finally { await prepared.close(); }
    });
});

for (const [name, entryImports, files] of [
    ["the entrypoint climbs out of dist", 'import "../outside.js";', { "../outside.js": "export {};\n" }],
    ["a chunk climbs out of dist", 'import "./a/inner.js";', { "a/inner.js": 'import "../../escape.js";\n', "../escape.js": "export {};\n" }],
    // Nothing exists at the target: the refusal is about where it points, so the loader never even
    // looks at a path outside dist (no "does it exist" answer leaks about the rest of the disk).
    ["the entrypoint climbs out of dist towards a path that does not exist", 'import "../absent-outside.js";', {}],
    ["the specifier names an absolute path", 'import "/absolute-sibling.js";', {}],
    ["the specifier names a file: URL", 'import "file:///elsewhere/sibling.js";', {}],
] as const) {
    it(`N05 refuses to build a capsule when ${name}`, async () => {
        await withInstallation(entryImports, files, async (fixture) => {
            await rejects(prepareClodexCapsuleEntrypoint(fixture.scratch), (error: unknown) => {
                strictEqual((error as { code?: string }).code, "adapter_unavailable");
                strictEqual((error as { status?: number }).status, 503);
                strictEqual(/outside the package dist directory/u.test((error as Error).message), true, (error as Error).message);
                return true;
            });
            // The half-built capsule is removed: no session directory survives the refusal.
            deepStrictEqual(await readdir(fixture.capsules), []);
        });
    });
}

it("N05 refuses to build a capsule when an imported sibling is not on disk", async () => {
    await withInstallation('import "./gone.js";', {}, async (fixture) => {
        await rejects(prepareClodexCapsuleEntrypoint(fixture.scratch), (error: unknown) => {
            strictEqual((error as { code?: string }).code, "adapter_unavailable");
            strictEqual((error as { status?: number }).status, 503);
            strictEqual(/gone\.js/u.test((error as Error).message), true, (error as Error).message);
            strictEqual(/is not a file in the package dist directory/u.test((error as Error).message), true, (error as Error).message);
            return true;
        });
        deepStrictEqual(await readdir(fixture.capsules), []);
    });
});

it("N05 refuses a sibling that is a directory, because a directory is not a module file", async () => {
    await withInstallation('import "./folder";', { "folder/index.js": "export {};\n" }, async (fixture) => {
        await rejects(prepareClodexCapsuleEntrypoint(fixture.scratch), /is not a file in the package dist directory/u);
        deepStrictEqual(await readdir(fixture.capsules), []);
    });
});

it("N05 refuses a sibling that is lexically inside dist but resolves through a link to somewhere else", async (t) => {
    await withInstallation('import "./linked/payload.js";', {}, async (fixture) => {
        const elsewhere = join(fixture.scratch, "elsewhere");
        await mkdir(elsewhere);
        await writeFile(join(elsewhere, "payload.js"), "export {};\n");
        try {
            // A junction on Windows (no privilege needed), a plain symlink elsewhere.
            await symlink(elsewhere, join(fixture.dist, "linked"), "junction");
        }
        catch (error) {
            t.skip(`could not create a directory link here: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
            return;
        }
        await rejects(prepareClodexCapsuleEntrypoint(fixture.scratch), /outside the package dist directory/u);
        deepStrictEqual(await readdir(fixture.capsules), []);
    });
});
