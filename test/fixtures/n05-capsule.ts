import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startClodexCapsule, type RunningClodexCapsule } from "../../src/workers/clodex-capsule.js";
import { prepareClodexCapsuleEntrypoint } from "../../src/runtime/clodex-capsule-entrypoint.js";
import { allocateLoopbackPort } from "../../src/runtime/loopback-port.js";

export interface N05Observation {
    readonly path: string;
    readonly arm: "absent" | "wrong" | "correct";
    readonly status: number;
    readonly healthBody: boolean;
    readonly catalogBody: boolean;
    readonly modelCount: number;
    readonly invalidJsonBody: boolean;
}
export interface N05Result {
    readonly completed: boolean;
    readonly rejected: boolean;
    readonly adapterUnavailable: boolean;
    readonly readinessWorks: boolean;
    readonly catalogWorks: boolean;
    readonly closed: boolean;
    readonly observations: readonly N05Observation[];
    readonly childGuard?: { readonly spawned: boolean; readonly exitedNonzero: boolean; readonly listenerResponded: boolean };
}

async function exerciseChildGuard(home: string, missing: boolean): Promise<NonNullable<N05Result["childGuard"]>> {
    const root = resolve(import.meta.dirname, "..", "..", "..");
    const entrypoint = await prepareClodexCapsuleEntrypoint(root);
    try {
        const port = await allocateLoopbackPort();
        // Inheritance here is only from the fixture's explicit OS allowlist.
        const env: NodeJS.ProcessEnv = { ...process.env, CLODEX_HOME: home, CLODEX_NO_DISCOVERY: "1" };
        if (!missing)
            env["HEZARFEN_CLODEX_TRANSPORT_NONCE"] = "";
        const child = spawn(process.execPath, [entrypoint.path, "server", "--endpoint", "--quick",
            "--listen", "local", "--port", String(port), "--providers", "openai-oauth",
            "--no-mask-gateway-ids", "--no-discovery"], {
            cwd: root, env, windowsHide: true, shell: false, stdio: "ignore",
        });
        let spawned = false;
        let finished = false;
        let code: number | null = null;
        child.once("spawn", () => { spawned = true; });
        child.once("error", () => { spawned = false; });
        const closed = new Promise<void>((resolveClose) => child.once("close", (exitCode) => {
            finished = true;
            code = exitCode;
            resolveClose();
        }));
        let listenerResponded = false;
        try {
            const deadline = Date.now() + 8_000;
            do {
                try {
                    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) });
                    await response.body?.cancel();
                    // Any HTTP response, including 401, proves the forbidden listener opened.
                    listenerResponded = true;
                }
                catch { /* A guarded child must never accept a connection. */ }
                if (!finished && !listenerResponded)
                    await delay(100);
            } while (!finished && !listenerResponded && Date.now() < deadline);
            return { spawned, exitedNonzero: finished && code !== null && code !== 0, listenerResponded };
        }
        finally {
            if (!finished)
                child.kill("SIGKILL");
            await closed;
        }
    }
    finally {
        await entrypoint.close();
    }
}

// Only this worker sees the generated secrets. IPC carries status and body-class
// observations; neither arbitrary provider output nor exception text is returned.
async function exercise(): Promise<N05Result> {
    const home = join(process.cwd(), "capsule");
    await mkdir(home, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(join(home, "providers.json"), JSON.stringify({
        schemaVersion: 1,
        providers: [{
            id: "openai-oauth", templateId: "custom-openai", name: "N05 anonymous catalog fixture",
            enabled: true, authType: "none", authRef: "none:anonymous", addedAt: now,
            api: { type: "openai-compatible", npm: "@ai-sdk/openai-compatible", url: "http://127.0.0.1:1" },
            modelsCache: { fetchedAt: now, models: [{ id: "n05-local-model", name: "N05 local model", contextWindow: 8192 }] },
        }],
    }));
    if (process.argv[2] === "child-missing-nonce" || process.argv[2] === "child-empty-nonce") {
        const childGuard = await exerciseChildGuard(home, process.argv[2] === "child-missing-nonce");
        return { completed: true, rejected: false, adapterUnavailable: false, readinessWorks: false,
            catalogWorks: false, closed: true, observations: [], childGuard };
    }
    const emptyNonce = process.argv[2] === "empty-nonce";
    const nonce = emptyNonce ? "" : randomBytes(32).toString("base64url");
    let wrong = randomBytes(32).toString("base64url");
    while (wrong === nonce)
        wrong = randomBytes(32).toString("base64url");
    let capsule: RunningClodexCapsule | undefined;
    let rejected = false;
    let adapterUnavailable = false;
    let readinessWorks = false;
    let catalogWorks = false;
    let closed = false;
    const observations: N05Observation[] = [];
    try {
        try {
            // Exercise the production factory and pinned listener, with no fake binary.
            capsule = await startClodexCapsule({ home }, nonce);
        }
        catch (error: unknown) {
            rejected = true;
            adapterUnavailable = typeof error === "object" && error !== null
                && "code" in error && error.code === "adapter_unavailable";
            if (!emptyNonce)
                throw new Error("N05 listener startup failed");
        }
        if (capsule !== undefined && !emptyNonce) {
            for (const path of ["/health", "/anthropic/v1/models", "/anthropic/v1/messages"]) {
                for (const arm of ["absent", "wrong", "correct"] as const) {
                    const headers = new Headers();
                    if (arm !== "absent")
                        headers.set("x-api-key", arm === "correct" ? nonce : wrong);
                    const messages = path.endsWith("/messages");
                    if (messages)
                        headers.set("content-type", "application/json");
                    const response = await fetch(new URL(path, capsule.origin), {
                        method: messages ? "POST" : "GET", headers,
                        ...(messages ? { body: "{" } : {}), signal: AbortSignal.timeout(4_000),
                    });
                    const body: unknown = await response.json().catch(() => null);
                    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
                    const problem = record["error"];
                    observations.push({
                        path, arm, status: response.status,
                        healthBody: record["ok"] === true,
                        catalogBody: Array.isArray(record["data"]),
                        modelCount: Array.isArray(record["data"]) ? record["data"].length : 0,
                        invalidJsonBody: typeof problem === "object" && problem !== null
                            && "message" in problem && problem.message === "Invalid JSON body",
                    });
                }
            }
            const readiness = await capsule.readiness();
            readinessWorks = readiness.adapterReady && readiness.oauthReady && readiness.status === "ready";
            const catalog = await capsule.catalog();
            catalogWorks = catalog.length === 1 && catalog[0]?.id === "anthropic-openai-oauth__n05-local-model";
        }
    }
    finally {
        if (capsule !== undefined) {
            await capsule.close();
            try {
                await fetch(new URL("/health", capsule.origin), { signal: AbortSignal.timeout(1_000) });
            }
            catch {
                closed = true;
            }
        }
    }
    return { completed: true, rejected, adapterUnavailable, readinessWorks, catalogWorks, closed, observations };
}

try {
    const result = await exercise();
    process.send?.(result);
}
catch {
    process.send?.({ completed: false });
    process.exitCode = 1;
}
finally {
    process.disconnect?.();
}
