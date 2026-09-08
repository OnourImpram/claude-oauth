import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SupervisorStatus } from "../supervisor/ipc.js";
import { ensurePrivateDirectory } from "./paths.js";
export async function writeSupervisorState(path: string, status: SupervisorStatus): Promise<void> {
    await ensurePrivateDirectory(dirname(path));
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
}
export async function removeSupervisorState(path: string): Promise<void> {
    try {
        await unlink(path);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw error;
    }
}
