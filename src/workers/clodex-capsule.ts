import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpTransport, ProviderModelRecord, ProviderReadiness } from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";
import { parseProviderModelEntries } from "../domain/model-catalog.js";
import { spawnFailureGuard } from "../runtime/child-process.js";
import { FixedOriginFetchTransport } from "../ports/fetch-transport.js";
import { sanitizedWorkerEnvironment } from "../security/environment.js";
import { readBoundedJson } from "../runtime/http-body.js";
import { allocateLoopbackPort } from "../runtime/loopback-port.js";
import { ensurePrivateDirectory } from "../runtime/paths.js";
export interface ClodexCapsuleOptions {
    readonly home: string;
    readonly binary?: string;
    readonly binaryArguments?: readonly string[];
}
export interface RunningClodexCapsule {
    readonly origin: URL;
    readonly transportNonce: string;
    readiness(): Promise<ProviderReadiness>;
    catalog(): Promise<readonly ProviderModelRecord[]>;
    close(): Promise<void>;
}
const startupTimeoutMs = 20_000;
function moduleRoot(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
function defaultBinary(): string {
    return process.execPath;
}
function defaultArguments(): readonly string[] {
    return [join(moduleRoot(), "node_modules", "@bman654", "clodex", "dist", "cli.js")];
}
function delay(milliseconds: number): Promise<void> {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
export async function startClodexCapsule(options: ClodexCapsuleOptions, transportNonce: string): Promise<RunningClodexCapsule> {
    await ensurePrivateDirectory(options.home);
    const port = await allocateLoopbackPort();
    const binary = options.binary ?? defaultBinary();
    const environment = sanitizedWorkerEnvironment("openai");
    environment["CLODEX_HOME"] = options.home;
    environment["CLODEX_NO_DISCOVERY"] = "1";
    const child = spawn(binary, [
        ...(options.binaryArguments ?? defaultArguments()),
        "server",
        "--endpoint",
        "--quick",
        "--listen",
        "local",
        "--port",
        String(port),
        "--providers",
        "openai-oauth",
        "--no-mask-gateway-ids",
        "--no-discovery",
    ], {
        cwd: moduleRoot(),
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    const spawnFailure = spawnFailureGuard(child);
    child.stdout?.resume();
    child.stderr?.resume();
    const origin = new URL(`http://127.0.0.1:${port}`);
    const transport = new FixedOriginFetchTransport(origin);
    try {
        await waitForHealth(child, transport);
    }
    catch (error) {
        child.kill();
        const failure = spawnFailure();
        if (failure !== undefined) {
            throw new RouterError("adapter_unavailable", `Clodex could not be started from its pinned path (${failure.code ?? "spawn failed"}). FIX: reinstall the pinned Clodex package, then re-run claude-oauth doctor.`, 503, { cause: failure });
        }
        throw error;
    }
    return {
        origin,
        transportNonce,
        readiness: async () => {
            if (child.exitCode !== null) {
                return {
                    provider: "openai",
                    oauthReady: false,
                    adapterReady: false,
                    status: "unavailable",
                    detailCode: "clodex_process_exited",
                };
            }
            try {
                const response = await transport.send({
                    path: "/health",
                    method: "GET",
                    headers: new Headers(),
                    signal: AbortSignal.timeout(2_000),
                });
                return {
                    provider: "openai",
                    oauthReady: response.ok,
                    adapterReady: response.ok,
                    status: response.ok ? "ready" : "auth_required",
                    detailCode: response.ok ? "clodex_endpoint_ready" : "clodex_health_failed",
                };
            }
            catch {
                return {
                    provider: "openai",
                    oauthReady: false,
                    adapterReady: false,
                    status: "unavailable",
                    detailCode: "clodex_health_unreachable",
                };
            }
        },
        catalog: async () => await readCatalog(transport, transportNonce),
        close: async () => await closeChild(child),
    };
}
async function waitForHealth(child: ChildProcess, transport: HttpTransport): Promise<void> {
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new RouterError("adapter_unavailable", "The pinned Clodex capsule exited during startup.", 503);
        }
        try {
            const response = await transport.send({
                path: "/health",
                method: "GET",
                headers: new Headers(),
                signal: AbortSignal.timeout(1_000),
            });
            if (response.ok)
                return;
        }
        catch {
            await delay(200);
        }
    }
    throw new RouterError("adapter_unavailable", "The pinned Clodex capsule did not become ready.", 503);
}
async function readCatalog(transport: HttpTransport, transportNonce: string): Promise<readonly ProviderModelRecord[]> {
    const response = await transport.send({
        path: "/anthropic/v1/models?limit=1000",
        method: "GET",
        headers: new Headers({ "x-api-key": transportNonce }),
        signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok || response.body === null) {
        throw new RouterError("provider_auth_required", "Clodex could not return the ChatGPT OAuth model catalog.", 401);
    }
    return parseProviderModelEntries(await readBoundedJson(response, 2 * 1024 * 1024));
}
async function closeChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null)
        return;
    child.kill();
    await Promise.race([
        new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
        delay(3_000),
    ]);
    if (child.exitCode === null)
        child.kill("SIGKILL");
}
