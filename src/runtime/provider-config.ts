import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory } from "./paths.js";
async function atomicJson(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
}
export async function ensureGeminiOAuthConfiguration(home: string): Promise<string> {
    await ensurePrivateDirectory(home);
    const userDirectory = join(home, ".gemini");
    await mkdir(userDirectory, { recursive: true, mode: 0o700 });
    const auth = { selectedType: "oauth-personal", enforcedType: "oauth-personal" };
    await atomicJson(join(userDirectory, "settings.json"), {
        security: {
            auth,
            disableYoloMode: true,
            disableAlwaysAllow: true,
            environmentVariableRedaction: { enabled: true },
        },
        general: {
            defaultApprovalMode: "plan",
            checkpointing: { enabled: false },
            enableAutoUpdate: false,
            enableAutoUpdateNotification: false,
        },
        hooksConfig: { enabled: false },
        telemetry: { enabled: false },
        privacy: { usageStatisticsEnabled: false },
        advanced: { autoConfigureMemory: false, ignoreLocalEnv: true },
    });
    const systemSettings = join(home, "system-settings.json");
    await atomicJson(systemSettings, {
        security: {
            auth,
            disableYoloMode: true,
            disableAlwaysAllow: true,
            environmentVariableRedaction: { enabled: true },
        },
        general: { defaultApprovalMode: "plan" },
        hooksConfig: { enabled: false },
        telemetry: { enabled: false },
        privacy: { usageStatisticsEnabled: false },
    });
    return systemSettings;
}
