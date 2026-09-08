// gateway-models-cache.ts -- Claude Code'un picker onbellegini ROUTER yazar.
//
// NEDEN VAR (2026-09-02, olculdu)
// Claude Code /model listesi icin ~/.claude/cache/gateway-models.json okur. O
// dosyayi normalde kendi kesfi yazar: ANTHROPIC_BASE_URL'e GET /v1/models atar ve
// sonucu BASE URL'E ANAHTARLAYARAK saklar. Iki kusur birlesince picker bosaliyor:
//   (1) Sabit port (8791) doluysa router efemeral porta duser; kesif onbellegi o
//       portla yazar; router olunce onbellek OLU bir adrese civili kalir.
//   (2) Kesif KIMLIK ister (ANTHROPIC_AUTH_TOKEN / apiKeyHelper / API key). Kimlik
//       bilerek verilmiyor -- verildiginde Claude Code kendi OAuth tokenini birakip
//       onu Bearer olarak gonderiyor ve ana yol 401 ile kiriliyor (2026-08-31 dersi).
//       Yani bayat onbellek KENDILIGINDEN yenilenemez.
// Olculen durum: baseUrl=http://127.0.0.1:51654 (olu), modeller icinde ama
// ulasilamaz; router.log'da loopback_pinned_port_unavailable x5.
//
// COZUM: kesfin yazacagi dosyayi router kendisi yazar -- Claude'u baslatmadan
// hemen once, FIILEN bagli oldugu adresle ve kendi model listesiyle. Kimlik
// gerekmez, olu adres kendiliginden onarilir, efemeral port picker icin zararsiz
// hale gelir. Icerik, discoveryPayload()'un birebir izdusumudur: kesif ne
// yazacaksa o.
//
// SINIR: bu dosya Claude Code'un onbellegidir, sozlesmesi degil. Sema olculen
// gercek dosyadan alindi ({baseUrl, fetchedAt, models:[{id, display_name}]});
// Claude Code semayi degistirirse readGatewayModelsCache "unreadable" doner ve
// doctor bunu ADIYLA raporlar -- sessiz bir bos liste degil.
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

/** Claude Code'un yapilandirma koku: CLAUDE_CONFIG_DIR varsa o, yoksa ~/.claude. */
export function claudeConfigDirectory(environment: NodeJS.ProcessEnv = process.env): string {
    const explicit = environment["CLAUDE_CONFIG_DIR"];
    if (explicit !== undefined && explicit.trim() !== "")
        return explicit;
    return join(homedir(), ".claude");
}

export function gatewayModelsCachePath(environment: NodeJS.ProcessEnv = process.env): string {
    return join(claudeConfigDirectory(environment), "cache", "gateway-models.json");
}

/** discoveryPayload() ciktisini onbellek satirlarina izdusur: kesif ne yazacaksa o. */
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
 * Onbellegi ATOMIK yazar (gecici dosya + rename): Claude Code ayni anda okuyorsa
 * yarim bir JSON gormez. Yazma hatasi CAGIRANA doner -- launcher bunu loglar ama
 * baslatmayi durdurmaz; picker onbellegi ana yolun bedeli olamaz.
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
 * Doctor kolu: onbellek CANLI adrese esit mi? "stale" picker'in bos oldugu
 * durumdur; "missing" hic kesif kosmadigi; "unreadable" sema degistigi.
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
 * A1/A3 kurali (plan 2026-09-02): onbellek YALNIZ sabit porta baglaninca yazilir.
 * Claude Code tek bir dosya tutar; efemeral porttaki ikinci oturum yazarsa sabit
 * porttaki oturumun picker'ini ezer. Ikinci oturum yazmaz: orada harici modeller
 * kimlikleriyle (--model ...) yine ulasilabilir, yalniz /model listesi bos kalir ve
 * bu, gateway_models_cache_skipped olayiyla ADIYLA loglanir -- sessiz degil.
 */
export function shouldWriteGatewayModelsCache(livePort: number, preferredPort: number): boolean {
    return livePort === preferredPort;
}

/** Doctor'un pickerCache kolu: dedektor caresiyle gelir; "matches" care tasimaz. */
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
