import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

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
