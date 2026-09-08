// gateway-models-cache.ts -- the ROUTER writes Claude Code's picker cache.
//
// WHY IT EXISTS (2026-09-02, measured)
// Claude Code reads ~/.claude/cache/gateway-models.json for the /model list. Normally its
// own discovery writes that file: it sends GET /v1/models to ANTHROPIC_BASE_URL and stores
// the result KEYED BY THE BASE URL. Two defects combine to empty the picker:
//   (1) If the fixed port (8791) is taken, the router falls back to an ephemeral port;
//       discovery writes the cache with that port; once the router dies the cache stays
//       nailed to a DEAD address.
//   (2) Discovery demands a CREDENTIAL (ANTHROPIC_AUTH_TOKEN / apiKeyHelper / API key). The
//       credential is deliberately withheld -- when it is supplied, Claude Code drops its own
//       OAuth token and sends it as Bearer instead, and the main path breaks with 401 (the
//       2026-08-31 lesson). So a stale cache CANNOT refresh ITSELF.
// Measured state: baseUrl=http://127.0.0.1:51654 (dead), the models present in it but
// unreachable; loopback_pinned_port_unavailable x5 in router.log.
//
// SOLUTION: the router writes the file discovery would have written itself -- immediately
// before starting Claude, with the address it is ACTUALLY bound to and its own model list. No
// credential is needed, a dead address repairs itself, and an ephemeral port becomes harmless
// for the picker. The content is an exact projection of discoveryPayload(): whatever
// discovery would have written.
//
// LIMIT: this file is Claude Code's cache, not its contract. The schema was taken from the
// measured real file ({baseUrl, fetchedAt, models:[{id, display_name}]}); if Claude Code
// changes the schema, readGatewayModelsCache returns "unreadable" and doctor reports it BY
// NAME -- not as a silent empty list.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface GatewayModelsCacheEntry {
    readonly id: string;
    readonly display_name: string;
}

export interface GatewayModelsCache {
    readonly baseUrl: string;
    readonly fetchedAt: number;
    readonly models: readonly GatewayModelsCacheEntry[];
}

export type GatewayModelsCacheStatus =
    | { readonly status: "matches"; readonly baseUrl: string; readonly modelCount: number }
    | { readonly status: "stale"; readonly cachedBaseUrl: string; readonly liveBaseUrl: string; readonly modelCount: number }
    | { readonly status: "missing"; readonly path: string }
    | { readonly status: "unreadable"; readonly path: string; readonly reason: string };

/** Claude Code's configuration root: CLAUDE_CONFIG_DIR when set, otherwise ~/.claude. */
export function claudeConfigDirectory(environment: NodeJS.ProcessEnv = process.env): string {
    const explicit = environment["CLAUDE_CONFIG_DIR"];
    if (explicit !== undefined && explicit.trim() !== "")
        return explicit;
    return join(homedir(), ".claude");
}

export function gatewayModelsCachePath(environment: NodeJS.ProcessEnv = process.env): string {
    return join(claudeConfigDirectory(environment), "cache", "gateway-models.json");
}

/** Projects discoveryPayload()'s output onto cache rows: whatever discovery would write. */
export function projectDiscoveryPayload(payload: Readonly<Record<string, unknown>>): GatewayModelsCacheEntry[] {
    const data = payload["data"];
    if (!Array.isArray(data))
        return [];
    const entries: GatewayModelsCacheEntry[] = [];
    for (const item of data) {
        if (typeof item !== "object" || item === null)
            continue;
        const record = item as Record<string, unknown>;
        const id = record["id"];
        const displayName = record["display_name"];
        if (typeof id !== "string" || typeof displayName !== "string")
            continue;
        entries.push({ id, display_name: displayName });
    }
    return entries;
}

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/$/u, "");
}

/**
 * Writes the cache ATOMICALLY (temporary file + rename): if Claude Code is reading at the
 * same moment it never sees half a JSON document. A write error is returned to the CALLER --
 * the launcher logs it but does not stop startup; the picker cache cannot cost the main path.
 */
export async function writeGatewayModelsCache(
    path: string,
    baseUrl: string,
    models: readonly GatewayModelsCacheEntry[],
    now: () => number = Date.now,
): Promise<GatewayModelsCache> {
    const cache: GatewayModelsCache = {
        baseUrl: normalizeBaseUrl(baseUrl),
        fetchedAt: now(),
        models: models.map((model) => ({ id: model.id, display_name: model.display_name })),
    };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(cache), "utf8");
    await rename(temporary, path);
    return cache;
}

export async function readGatewayModelsCache(path: string): Promise<GatewayModelsCache | undefined> {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
        throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null)
        throw new Error("gateway-models cache is not an object");
    const record = parsed as Record<string, unknown>;
    if (typeof record["baseUrl"] !== "string" || typeof record["fetchedAt"] !== "number" || !Array.isArray(record["models"]))
        throw new Error("gateway-models cache is missing baseUrl, fetchedAt or models");
    return {
        baseUrl: record["baseUrl"],
        fetchedAt: record["fetchedAt"],
        models: projectDiscoveryPayload({ data: record["models"] }),
    };
}

/**
 * Doctor arm: does the cache match the LIVE address? "stale" is the state in which the picker
 * is empty; "missing" that discovery never ran; "unreadable" that the schema changed.
 */
export async function gatewayModelsCacheStatus(path: string, liveBaseUrl: string): Promise<GatewayModelsCacheStatus> {
    let cache: GatewayModelsCache | undefined;
    try {
        cache = await readGatewayModelsCache(path);
    }
    catch (error) {
        return { status: "unreadable", path, reason: (error as Error).message };
    }
    if (cache === undefined)
        return { status: "missing", path };
    const live = normalizeBaseUrl(liveBaseUrl);
    if (cache.baseUrl === live)
        return { status: "matches", baseUrl: live, modelCount: cache.models.length };
    return { status: "stale", cachedBaseUrl: cache.baseUrl, liveBaseUrl: live, modelCount: cache.models.length };
}

/**
 * A1/A3 rule (plan of 2026-09-02): the cache is written ONLY when bound to the fixed port.
 * Claude Code keeps a single file; if a second session on an ephemeral port writes it, it
 * overwrites the picker of the session on the fixed port. The second session does not write:
 * there the external models are still reachable by their identities (--model ...), only the
 * /model list stays empty, and that is logged BY NAME through the
 * gateway_models_cache_skipped event -- not silently.
 */
export function shouldWriteGatewayModelsCache(livePort: number, preferredPort: number): boolean {
    return livePort === preferredPort;
}

/** Doctor's pickerCache arm: a detector ships with its remedy; "matches" carries none. */
export function gatewayModelsCacheRemedy(status: GatewayModelsCacheStatus): string | undefined {
    switch (status.status) {
        case "matches":
            return undefined;
        case "stale":
            return `Picker cache is keyed to ${status.cachedBaseUrl} but the router listens on ${status.liveBaseUrl}: relaunch through the launcher on the pinned port; the router rewrites this file at launch.`;
        case "missing":
            return `No picker cache at ${status.path}: launch once through the launcher; the router writes it.`;
        case "unreadable":
            return `Picker cache unreadable (${status.reason}): delete ${status.path}; the launcher rewrites it. If it repeats, Claude Code changed the cache schema -- update gateway-models-cache.ts.`;
    }
}
