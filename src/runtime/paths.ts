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
        // TWEAKCC_CONFIG_DIR. Adi eskiden "patch-state-2.8.2" idi: yola gomulen bir
        // surum numarasi ilk yukseltmede YALAN soyler, ve yalan soyleyen bir yol
        // yedekleri sessizce karistirir. Surum kilitte yasar, yolda degil.
        //
        // OLCUSU: test/runtime-paths.test.ts -- (a) bu yolun adi surum tasimaz,
        // (b) hicbir RuntimePaths degeri surum tasimaz, (c) enstrumanin eski adi
        // FIILEN yakaladigi pozitif kolla kanitlanir. Yeniden adlandirmanin kendisi
        // 2026-09-05'e kadar olcusuzdu (BULGU 6): `grep -rn shadowPatchBackups test/`
        // sifir sonuc veriyordu. Gecis notu: eski dizindeki pristine yedek OKSUZ kalir;
        // silinmesi operatorun karari, bu kod onu silmez.
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
