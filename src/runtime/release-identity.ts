import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { RouterError } from "../domain/errors.js";

// A release directory named router-v3-<distHash>-<configHash> claimed to be
// content-addressed, but nothing ever recomputed those hashes -- so a release could
// be hand-edited in place and keep its name. That is exactly how the active release
// came to launch the unpatched binary while still calling itself immutable.
// Hashing dist + config costs ~11 ms, so every start can afford to prove it.
export const RELEASE_ID_PATTERN = /^router-v3-([A-F0-9]{12})-([A-F0-9]{12})$/u;
const HASHED_DIRECTORIES = ["dist", "config"] as const;

export type ReleaseIdentityStatus = "verified" | "unverified" | "mismatch" | "unreadable";

export interface ReleaseIdentity {
    readonly status: ReleaseIdentityStatus;
    readonly declaredId?: string;
    readonly computedId?: string;
    readonly detailCode: string;
}

async function collectFiles(directory: string): Promise<readonly string[]> {
    const found: string[] = [];
    const visit = async (current: string): Promise<void> => {
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const path = join(current, entry.name);
            if (entry.isDirectory())
                await visit(path);
            else
                found.push(path);
        }
    };
    await visit(directory);
    return found;
}

// Canonical form, so the same tree always yields the same digest regardless of
// filesystem ordering or path separator: POSIX relative path, then the file digest.
async function directoryDigest(root: string, subdirectory: string): Promise<string> {
    const base = resolve(root, subdirectory);
    const files = [...(await collectFiles(base))]
        .map((path) => ({ path, key: relative(base, path).split(sep).join("/") }))
        .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    const digest = createHash("sha256");
    for (const file of files) {
        digest.update(file.key);
        digest.update("\n");
        digest.update(createHash("sha256").update(await readFile(file.path)).digest("hex"));
        digest.update("\n");
    }
    return digest.digest("hex").toUpperCase().slice(0, 12);
}

export async function computeReleaseId(root: string): Promise<string> {
    const [dist, config] = await Promise.all(HASHED_DIRECTORIES.map(async (name) => await directoryDigest(root, name)));
    return `router-v3-${dist as string}-${config as string}`;
}

export async function verifyReleaseIdentity(root: string, environment: NodeJS.ProcessEnv): Promise<ReleaseIdentity> {
    const source = environment["HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE"];
    const declaredId = environment["HEZARFEN_CLAUDE_OAUTH_RELEASE_ID"];
    if (source !== "embedded-release" || declaredId === undefined) {
        return { status: "unverified", detailCode: "not_launched_from_embedded_release" };
    }
    if (!RELEASE_ID_PATTERN.test(declaredId)) {
        return { status: "mismatch", declaredId, detailCode: "release_id_malformed" };
    }
    let computedId: string;
    try {
        computedId = await computeReleaseId(root);
    }
    catch {
        return { status: "unreadable", declaredId, detailCode: "release_contents_unreadable" };
    }
    if (computedId !== declaredId) {
        return { status: "mismatch", declaredId, computedId, detailCode: "release_contents_do_not_match_release_id" };
    }
    return { status: "verified", declaredId, computedId, detailCode: "release_contents_match_release_id" };
}
/**
 * The gate every entry point passes. "mismatch" was the only refusal; a release that could
 * not be hashed at all ("unreadable": a junction or directory link under dist/ or config/, a
 * locked or denied file) was launched anyway, although an entry the walker cannot read is
 * exactly what an in-place edit looks like (audit D1-06, 2026-11-15). Both are refused now.
 * "unverified" is a launch that never claimed to be a release (a development checkout).
 */
export function requireReleaseIdentity(identity: ReleaseIdentity): void {
    if (identity.status === "mismatch") {
        throw new RouterError("adapter_unavailable", `Refusing to run release ${identity.declaredId ?? "?"}: its contents no longer hash to its own id (${identity.detailCode}). A content-addressed release that was edited in place is not the release it claims to be. FIX: reinstall the release, or run "node scripts/release-id.mjs --verify <release-directory>" to see the computed id.`, 503);
    }
    if (identity.status === "unreadable") {
        throw new RouterError("adapter_unavailable", `Refusing to run release ${identity.declaredId ?? "?"}: its dist/ or config/ could not be read to verify it (${identity.detailCode}). A release that cannot be hashed cannot be told apart from an edited one. FIX: look for a junction, a directory link or a locked file under dist/ and config/, or reinstall the release; "node scripts/release-id.mjs --verify <release-directory>" names the failure.`, 503);
    }
}
