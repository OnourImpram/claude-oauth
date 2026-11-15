import { readFile } from "node:fs/promises";

/**
 * Router-owned API-key resolution for the non-OAuth lanes (alibaba / zai / openaiapi, added
 * 2026-11-09).
 *
 * The key is resolved on EVERY call from the router process environment:
 * a dotenv file named by the lane's own `<KEY>_FILE` variable.
 * For alibaba and zai the direct `<KEY>` environment variable is honoured first.
 * openaiapi reads the FILE ONLY: OPENAI_API_KEY in the process
 * environment is an api-key selector the router refuses to start under
 * (assertNoApiKeySelectors), so an adapter that read it would contradict its own guard.
 *
 * The value is never stored in a field longer than the call, never logged, never part of an
 * error message (an upstream error body is scrubbed of it before it is quoted), and every
 * variable involved is stripped from every child environment
 * (src/security/environment.ts ROUTER_OWNED_SECRET_VARIABLES).
 */
export function dotenvValue(text: string, variable: string): string | undefined {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=\\s*(.*?)\\s*$`, "u");
    for (const line of text.split(/\r?\n/u)) {
        const match = pattern.exec(line);
        if (match === null)
            continue;
        const value = (match[1] ?? "").replace(/^(["'])(.*)\1$/u, "$2").trim();
        return value === "" ? undefined : value;
    }
    return undefined;
}

async function readKeyFileText(file: string): Promise<string | undefined> {
    try {
        return await readFile(file, "utf8");
    }
    catch {
        return undefined;
    }
}

export interface RouterKeyResolution {
    readonly value: string | undefined;
    /** The variable the file came from, for the remedy text (never the path's contents). */
    readonly fileVariable: string;
}

/**
 * Resolves one lane's key. `directVariable` may be undefined (openaiapi: file only, see the
 * module comment). Returns the KEY NAME side of the remedy, never the value.
 */
export async function resolveRouterOwnedKey(environment: NodeJS.ProcessEnv, keyVariable: string, laneFileVariable: string, directVariable?: string): Promise<RouterKeyResolution> {
    const direct = directVariable === undefined ? undefined : environment[directVariable]?.trim();
    if (direct !== undefined && direct !== "")
        return { value: direct, fileVariable: laneFileVariable };
    const file = environment[laneFileVariable]?.trim();
    if (file === undefined || file === "")
        return { value: undefined, fileVariable: laneFileVariable };
    const text = await readKeyFileText(file);
    return { value: text === undefined ? undefined : dotenvValue(text, keyVariable), fileVariable: laneFileVariable };
}
