import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { runtimeSessionPaths, type RuntimePaths } from "../runtime/paths.js";
import type { SupervisorStatus } from "./ipc.js";

// Audit D1-07 (2026-11-15). A session writes sessions/<id>.json and removes it in a
// `finally`. A killed router, a closed terminal window or a crash skips that `finally`, and
// nothing ever removed the file later: the leftovers accumulated without bound, and once 256
// of them existed `doctor` stopped probing the rest and could report a live session as
// stopped. A state file is written AFTER its IPC endpoint is listening, so a file whose
// endpoint does not answer belongs to a session that is gone.
const sessionStateFilePattern = /^([a-f0-9]{32})\.json$/u;
const defaultMinimumAgeMs = 30_000;

export interface SessionSweepOptions {
    /** The shared runtime paths (not a session's own). */
    readonly paths: RuntimePaths;
    readonly probe: (ipcPath: string) => Promise<SupervisorStatus | undefined>;
    readonly now?: () => number;
    /** A file younger than this is never removed: its session may be starting or stopping. */
    readonly minimumAgeMs?: number;
}
export interface SessionSweepOutcome {
    readonly removed: readonly string[];
    readonly kept: readonly string[];
}

export async function sweepStaleSessionStates(options: SessionSweepOptions): Promise<SessionSweepOutcome> {
    const now = (options.now ?? Date.now)();
    const minimumAgeMs = options.minimumAgeMs ?? defaultMinimumAgeMs;
    const directory = join(options.paths.root, "sessions");
    const removed: string[] = [];
    const kept: string[] = [];
    let names: string[];
    try {
        names = await readdir(directory);
    }
    catch {
        return { removed, kept };
    }
    for (const name of names) {
        const sessionId = sessionStateFilePattern.exec(name)?.[1];
        if (sessionId === undefined)
            continue;
        const path = join(directory, name);
        let ageMs: number;
        try {
            ageMs = now - (await stat(path)).mtimeMs;
        }
        catch {
            continue; // removed by its own session in the meantime
        }
        const status = ageMs < minimumAgeMs ? "too-young" : (await options.probe(runtimeSessionPaths(options.paths, sessionId).ipc))?.status;
        if (status === "too-young" || status === "running") {
            kept.push(path);
            continue;
        }
        try {
            await unlink(path);
            removed.push(path);
        }
        catch {
            kept.push(path);
        }
    }
    return { removed, kept };
}
