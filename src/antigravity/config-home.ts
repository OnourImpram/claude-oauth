// G01 / Path D -- the ephemeral configuration home that gives the Google lane a
// tool surface without writing a session secret anywhere durable.
//
// THE PROBLEM THIS SOLVES
// agy has no per-call MCP flag; `agy mcp add` edits a PERSISTENT file. Writing the
// router's session nonce into the operator's own mcp_config.json is what the Security
// hard rule refuses, and it is also simply WRONG: the nonce changes every session, so a
// persistent entry carries a stale credential from the second session onward.
//
// WHAT WAS MEASURED (2026-09-08, tasks/router-karar-20260907/g01-ana-oturum-tasarimi.md)
// agy resolves its configuration home from USERPROFILE/HOME. Redirected, `agy mcp list`
// answers "No MCP servers configured" while the operator's real list still holds seven
// servers and its file's mtime does not move. With the credential files hard-linked into
// the redirected home, `agy models` still fetches the live catalogue -- OAuth survives.
// And with an http+header MCP entry written into that home, a live gemini-3.8-flash run
// CALLED the tool and returned its receipt string.
//
// SO THE SPLIT IS STRUCTURAL, NOT PROMISED
// The persistent side (the operator's config) is never opened for writing. The side that
// carries the nonce is a directory this process creates and deletes. A crash cannot leave
// a secret in a file that belongs to someone else, because we never write into one.
//
// WHY HARD LINKS AND NEVER A COPY
// A copy would put a second physical copy of the operator's OAuth credential on disk --
// a new secret at a new location, which the Security hard rule forbids. A hard link is
// the same inode: no new bytes. If linking fails (different volume), this module FAILS
// instead of falling back to copying. An honest boundary beats a convenient leak.

import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { RouterError } from "../domain/errors.js";
import { ensurePrivateDirectory } from "../runtime/paths.js";

/** Where the routed agent must reach the router's MCP endpoint, and with what. */
export interface AgentToolEndpoint {
    readonly url: string;
    /** The router session nonce, as a header. Never persisted outside the ephemeral home. */
    readonly headers: Readonly<Record<string, string>>;
}

export interface ConfigHomeOptions {
    /** Directory that holds one subdirectory per live call. */
    readonly root: string;
    /** The operator's real home; credential files are linked FROM here, never written to. */
    readonly sourceHome?: string;
    /** Omitted means: build a home with an EMPTY server map (no tool surface, no secret). */
    readonly endpoint?: AgentToolEndpoint;
    readonly serverName?: string;
    /** Injected so the sweep's ownership record is testable without spawning processes. */
    readonly pid?: number;
    readonly now?: () => number;
}

export interface EphemeralConfigHome {
    /** Value USERPROFILE/HOME must take for the child process. */
    readonly path: string;
    /** Removes the home. Safe to call twice; never throws. */
    dispose(): Promise<void>;
}

/**
 * The files agy needs in order to authenticate and address a project.
 *
 * This list is not a guess: it is exactly the set the 2026-09-08 probe linked before
 * `agy models` returned the live catalogue. Adding names speculatively would widen the
 * credential surface for no measured reason.
 */
export const LINKED_IDENTITY_FILES: readonly string[] = [
    "oauth_creds.json",
    "google_accounts.json",
    "installation_id",
    "projects.json",
    "settings.json",
    "state.json",
    "trustedFolders.json",
];

export const DEFAULT_TOOL_SERVER_NAME = "hezarfen-claude-code-tools";
const OWNER_FILE = ".hezarfen-owner.json";
const defaultStaleAfterMs = 6 * 60 * 60 * 1000;

interface OwnerRecord {
    readonly pid: number;
    readonly createdAt: number;
}

/**
 * Builds one call-scoped configuration home.
 *
 * The mcp_config.json written here is OURS: it starts empty and receives only our entry.
 * The operator's servers are deliberately absent -- a routed model gets Claude Code's tool
 * surface, not the operator's Antigravity servers, and that separation is the point.
 */
export async function createEphemeralConfigHome(options: ConfigHomeOptions): Promise<EphemeralConfigHome> {
    const source = options.sourceHome ?? homedir();
    // 0o700, not a plain mkdir. The nonce spends the call inside this tree; an independent
    // review of this design was right that "it is under TEMP" is not an access control.
    // On Windows the mode is advisory, which is why the home is also short-lived and swept.
    await ensurePrivateDirectory(options.root);
    const path = await mkdtemp(join(options.root, "call-"));
    await ensurePrivateDirectory(path);
    let created = true;
    const dispose = async (): Promise<void> => {
        if (!created)
            return;
        created = false;
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
    };
    try {
        const gemini = join(path, ".gemini");
        await mkdir(join(gemini, "config"), { recursive: true });
        for (const name of LINKED_IDENTITY_FILES) {
            await linkIdentityFile(join(source, ".gemini", name), join(gemini, name));
        }
        await writeFile(join(gemini, "config", "mcp_config.json"), `${JSON.stringify(serverMap(options), undefined, 2)}\n`, "utf8");
        if (options.endpoint !== undefined) {
            const settingsDirectory = join(gemini, "antigravity-cli");
            await mkdir(settingsDirectory, { recursive: true });
            // Measured with agy 1.1.27 on 2026-09-08: headless permissions use
            // mcp(server/tool), not a colon. This grants only our MCP server;
            // agy's implicit workspace file permissions are a separate policy.
            const settings = { permissions: { allow: [`mcp(${options.serverName ?? DEFAULT_TOOL_SERVER_NAME}/*)`] } };
            await writeFile(join(settingsDirectory, "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
        }
        const owner: OwnerRecord = { pid: options.pid ?? process.pid, createdAt: (options.now ?? Date.now)() };
        await writeFile(join(path, OWNER_FILE), `${JSON.stringify(owner)}\n`, "utf8");
    }
    catch (error) {
        await dispose();
        if (error instanceof RouterError)
            throw error;
        throw new RouterError("adapter_unavailable", "The Antigravity configuration home could not be built.", 503);
    }
    return { path, dispose };
}

function serverMap(options: ConfigHomeOptions): { readonly mcpServers: Record<string, unknown> } {
    if (options.endpoint === undefined)
        return { mcpServers: {} };
    return {
        mcpServers: {
            [options.serverName ?? DEFAULT_TOOL_SERVER_NAME]: {
                disabled: false,
                headers: { ...options.endpoint.headers },
                serverUrl: options.endpoint.url,
            },
        },
    };
}

async function linkIdentityFile(from: string, to: string): Promise<void> {
    let source: Awaited<ReturnType<typeof stat>>;
    try {
        source = await stat(from);
    }
    catch {
        // A missing optional file is not a failure: a fresh install has no projects.json,
        // and agy writes one itself. A MISSING CREDENTIAL is caught later, by the auth
        // error the provider returns -- inventing a check here would guess at agy's
        // requirements instead of measuring them.
        return;
    }
    if (!source.isFile())
        return;
    try {
        await link(from, to);
    }
    catch {
        throw new RouterError("adapter_unavailable", "Antigravity credentials could not be linked into the call-scoped home; copying them is refused.", 503);
    }
}

export interface SweepOptions {
    readonly root: string;
    readonly staleAfterMs?: number;
    readonly now?: () => number;
    /** Injected in tests; production asks the OS whether the owner is still alive. */
    readonly isProcessAlive?: (pid: number) => boolean;
}

export interface SweepOutcome {
    readonly removed: readonly string[];
    readonly kept: readonly string[];
}

/**
 * Removes homes left behind by a crash, and KEEPS the ones still owned by a live process.
 *
 * Both halves matter. A sweep that deletes everything would pass a "the stale one is gone"
 * test while destroying a running call's configuration -- which is why the measure has a
 * second arm asserting the live home survives.
 */
export async function sweepStaleConfigHomes(options: SweepOptions): Promise<SweepOutcome> {
    const now = (options.now ?? Date.now)();
    const staleAfterMs = options.staleAfterMs ?? defaultStaleAfterMs;
    const alive = options.isProcessAlive ?? processIsAlive;
    const removed: string[] = [];
    const kept: string[] = [];
    let entries: Dirent[];
    try {
        entries = await readdir(options.root, { withFileTypes: true });
    }
    catch {
        return { removed, kept };
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const path = join(options.root, entry.name);
        const owner = await readOwner(path);
        // An unreadable owner record means the home is not accounted for by anyone. It is
        // swept -- but only past the TTL, so a home caught mid-creation is not destroyed.
        const stale = owner === undefined
            ? await olderThan(path, now, staleAfterMs)
            : now - owner.createdAt > staleAfterMs || !alive(owner.pid);
        if (!stale) {
            kept.push(path);
            continue;
        }
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
        removed.push(path);
    }
    return { removed, kept };
}

async function readOwner(path: string): Promise<OwnerRecord | undefined> {
    try {
        const parsed: unknown = JSON.parse(await readFile(join(path, OWNER_FILE), "utf8"));
        if (typeof parsed !== "object" || parsed === null)
            return undefined;
        const record = parsed as Record<string, unknown>;
        if (typeof record["pid"] !== "number" || typeof record["createdAt"] !== "number")
            return undefined;
        return { pid: record["pid"], createdAt: record["createdAt"] };
    }
    catch {
        return undefined;
    }
}

async function olderThan(path: string, now: number, staleAfterMs: number): Promise<boolean> {
    try {
        return now - (await stat(path)).mtimeMs > staleAfterMs;
    }
    catch {
        return false;
    }
}

function processIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        // Signal 0 performs the permission and existence check WITHOUT delivering a signal.
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM means the process exists but belongs to someone else -- alive, not ours.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}
