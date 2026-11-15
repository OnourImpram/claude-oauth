import { deepStrictEqual, ok } from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

// CASE RECORD (measured 2026-11-15). A patch that inserts LF lines into a CRLF file leaves a
// working copy git itself would never check out: nine tracked files mixed CRLF with bare LF.
// git hides it (`* text=auto` normalises on commit), but tsc copies the newlines inside
// comments and template literals into dist, and the release id is a hash of dist: a release cut
// from such a tree cannot be reproduced from a fresh clone. This test is the measure.

const roots = ["src", "test", "config", "scripts"];
const extensions = new Set([".ts", ".mjs", ".js", ".json"]);

async function sourceFiles(directory: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            found.push(...await sourceFiles(full));
        }
        else if (extensions.has(path.extname(entry.name))) {
            found.push(full);
        }
    }
    return found;
}

/** Counts CRLF pairs and bare LF bytes; a file is mixed when it has both. */
export function lineEndingCounts(bytes: Buffer): { crlf: number; bareLf: number } {
    let crlf = 0;
    let bareLf = 0;
    for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0x0a)
            continue;
        if (index > 0 && bytes[index - 1] === 0x0d)
            crlf += 1;
        else
            bareLf += 1;
    }
    return { crlf, bareLf };
}

describe("line endings of the working copy", () => {
    it("no source file mixes CRLF with bare LF", async () => {
        const files = (await Promise.all(roots.map(async (root) => await sourceFiles(root)))).flat();
        ok(files.length > 100, `the scan must reach the sources; it found ${files.length} files`);
        const mixed: string[] = [];
        for (const file of files) {
            const { crlf, bareLf } = lineEndingCounts(await readFile(file));
            if (crlf > 0 && bareLf > 0)
                mixed.push(`${file.replaceAll("\\", "/")} crlf=${crlf} bare_lf=${bareLf}`);
        }
        deepStrictEqual(mixed, [], "FIX: rewrite the listed files with one line ending (git checkout does it: `git rm --cached -r . && git reset --hard` on a clean tree, or normalise the files in place).");
    });

    it("NEGATIVE: the counter sees a mixed buffer, and does not flag a pure one", () => {
        deepStrictEqual(lineEndingCounts(Buffer.from("a\r\nb\nc\r\n")), { crlf: 2, bareLf: 1 });
        deepStrictEqual(lineEndingCounts(Buffer.from("a\r\nb\r\n")), { crlf: 2, bareLf: 0 });
        deepStrictEqual(lineEndingCounts(Buffer.from("a\nb\n")), { crlf: 0, bareLf: 2 });
    });
});
