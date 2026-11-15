import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RouterError } from "../domain/errors.js";

// The capsule runs a COPY of the pinned bundle's entrypoint from a directory of its own, so every
// file the entrypoint (transitively) imports by relative path has to be copied next to it. The file
// names are the bundler's output and change with every Clodex release (the one chunk of 2.11.1 was
// called chunk-J7WXOD2K.js, the one of 2.21.7 is called chunk-UTKSMW77.js); they are read from the
// bundle itself, never written down here.
//
// The scan is textual, because the bundle is ESM and Node ships no parser for it. Measured on the
// pinned 2.21.7 bundle (2026-11-15): exactly one relative specifier in cli.js, none in the chunk, and
// no false positive from a string. A match inside a string would fail CLOSED here (a named 503 for a
// file that is not there), never copy something unintended.
//
// Anything that is not a plain relative specifier and not a bare package or node: builtin is a way
// out of the package directory and is refused: an absolute path, a file: URL.
const staticSpecifier = /^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*(["'])([^"'\r\n]+)\1/gmu;
const bareSpecifier = /^\s*import\s*(["'])([^"'\r\n]+)\1/gmu;
const dynamicSpecifier = /\bimport\s*\(\s*(["'])([^"'\r\n]+)\1\s*[,)]/gu;
const scannedExtensions = new Set([".js", ".mjs", ".cjs"]);

function refuse(message: string): RouterError {
    return new RouterError("adapter_unavailable", message, 503);
}

function importSpecifiers(source: string): string[] {
    const found = new Set<string>();
    for (const pattern of [staticSpecifier, bareSpecifier, dynamicSpecifier]) {
        for (const match of source.matchAll(pattern)) {
            const specifier = match[2];
            if (specifier !== undefined)
                found.add(specifier);
        }
    }
    return [...found];
}

function isInside(directory: string, candidate: string): boolean {
    const path = relative(directory, candidate);
    return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function extensionOf(path: string): string {
    const dot = path.lastIndexOf(".");
    return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

/**
 * Copies every file the entrypoint imports by relative path, directly or through other copied
 * files, from `upstream` (the package's dist directory) into `capsule`, keeping the directory
 * layout. `entrypointSource` is the text the capsule will actually run; the entrypoint file itself
 * is written by the caller and is never copied from here.
 *
 * Refuses with a 503 naming the specifier when one resolves outside `upstream` (lexically or
 * through a link) or names something that is not a file there.
 */
export async function copyCapsuleSiblings(upstream: string, entrypointSource: string, capsule: string): Promise<readonly string[]> {
    const upstreamRoot = await realpath(resolve(upstream));
    const entrypoint = join(upstreamRoot, "cli.js");
    const copied: string[] = [];
    const seen = new Set<string>([process.platform === "win32" ? entrypoint.toLowerCase() : entrypoint]);
    const pending: Array<{ readonly importer: string; readonly source: string }> = [{ importer: entrypoint, source: entrypointSource }];
    for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
        const importerName = relative(upstreamRoot, next.importer);
        for (const specifier of importSpecifiers(next.source)) {
            if (specifier.startsWith("/") || /^file:/iu.test(specifier)) {
                throw refuse(`Clodex capsule sibling "${specifier}" (imported by ${importerName}) is an absolute or file: location, outside the package dist directory; refusing to build the capsule.`);
            }
            if (!specifier.startsWith("./") && !specifier.startsWith("../"))
                continue;
            // Resolve the way Node's ESM loader does (a URL against the importer), so percent-encoded
            // dot segments, a query or a fragment cannot name a different file than the one checked.
            let candidate: string;
            try {
                candidate = fileURLToPath(new URL(specifier, pathToFileURL(next.importer)));
            }
            catch {
                throw refuse(`Clodex capsule sibling "${specifier}" (imported by ${importerName}) is not a valid relative file specifier, so it is not a file in the package dist directory; refusing to build the capsule.`);
            }
            if (!isInside(upstreamRoot, candidate)) {
                throw refuse(`Clodex capsule sibling "${specifier}" (imported by ${importerName}) resolves outside the package dist directory; refusing to build the capsule.`);
            }
            let real: string;
            try {
                if (!(await stat(candidate)).isFile())
                    throw new Error("not a file");
                real = await realpath(candidate);
            }
            catch {
                throw refuse(`Clodex capsule sibling "${specifier}" (imported by ${importerName}) is not a file in the package dist directory; refusing to build the capsule.`);
            }
            if (!isInside(upstreamRoot, real)) {
                throw refuse(`Clodex capsule sibling "${specifier}" (imported by ${importerName}) resolves outside the package dist directory; refusing to build the capsule.`);
            }
            // The capsule mirrors the importer's own spelling of the path, so the next relative
            // import inside the copy resolves exactly as it did in the package.
            const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
            if (seen.has(key))
                continue;
            seen.add(key);
            const name = relative(upstreamRoot, candidate);
            const target = join(capsule, name);
            await mkdir(dirname(target), { recursive: true });
            await copyFile(real, target);
            copied.push(name.split(sep).join("/"));
            if (scannedExtensions.has(extensionOf(candidate)))
                pending.push({ importer: candidate, source: await readFile(real, "utf8") });
        }
    }
    return copied;
}
