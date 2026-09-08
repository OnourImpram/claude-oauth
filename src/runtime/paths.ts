import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
export interface RuntimePaths {
    readonly root: string;
    readonly snapshot: string;
    readonly receipts: string;
    readonly state: string;
    readonly ipc: string;
    readonly shadowRoot: string;
    readonly shadowManifest: string;
    readonly shadowLock: string;
    readonly shadowPatchBackups: string;
    readonly clodexHome: string;
    readonly grokHome: string;
    readonly geminiHome: string;
}
export function runtimePaths(environment: NodeJS.ProcessEnv = process.env): RuntimePaths {
    const base = environment["LOCALAPPDATA"] ?? join(homedir(), ".local", "share");
    const root = join(base, "Hezarfen", "claude-oauth");
    const discriminator = createHash("sha256").update(root).digest("hex").slice(0, 16);
    return {
        root,
        snapshot: join(root, "models.snapshot.json"),
        receipts: join(root, "receipts.jsonl"),
        state: join(root, "state.json"),
        ipc: process.platform === "win32" ? `\\\\.\\pipe\\hezarfen-claude-oauth-${discriminator}` : join(root, "supervisor.sock"),
        shadowRoot: join(root, "shadow"),
        shadowManifest: join(root, "shadow", "current.json"),
        shadowLock: join(root, "shadow", "self-heal.lock"),
        // TWEAKCC_CONFIG_DIR. Its name used to be "patch-state-2.8.2": a version number
        // embedded in a path LIES at the first upgrade, and a lying path silently mixes up
        // the backups. The version lives in the lock, not in the path.
        //
        // ITS MEASURE: test/runtime-paths.test.ts -- (a) this path's name carries no version,
        // (b) no RuntimePaths value carries a version, (c) the instrument is proved by a
        // positive arm that ACTUALLY catches the old name. The rename itself was unmeasured
        // until 2026-09-05 (FINDING 6): `grep -rn shadowPatchBackups test/` returned zero
        // results. Migration note: the pristine backup in the old directory is ORPHANED;
        // deleting it is the operator's decision, this code does not delete it.
        shadowPatchBackups: join(root, "shadow", "patch-state"),
        clodexHome: join(root, "providers", "clodex"),
        grokHome: join(root, "providers", "grok"),
        geminiHome: join(root, "providers", "gemini"),
    };
}
const runtimeSessionIdPattern = /^[a-f0-9]{32}$/u;
export function runtimeSessionPaths(paths: RuntimePaths, sessionId: string): RuntimePaths {
    if (!runtimeSessionIdPattern.test(sessionId))
        throw new Error("runtime session ID is invalid");
    const sessionRoot = join(paths.root, "sessions");
    const discriminator = createHash("sha256").update(paths.root).digest("hex").slice(0, 16);
    return {
        ...paths,
        state: join(sessionRoot, `${sessionId}.json`),
        ipc: process.platform === "win32"
            ? `\\\\.\\pipe\\hezarfen-claude-oauth-${discriminator}-${sessionId}`
            : join(sessionRoot, `${sessionId}.sock`),
    };
}
export async function ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    try {
        await chmod(path, 0o700);
    }
    catch (error) {
        if (process.platform !== "win32")
            throw error;
    }
}
