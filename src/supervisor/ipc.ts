import { SUPERVISOR_DETAIL_CODE_LIMIT } from "../domain/contracts.js";
import { createServer, createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runtimeSessionPaths, type RuntimePaths } from "../runtime/paths.js";
export interface SupervisorStatus {
    readonly schemaVersion: 1;
    readonly status: "running" | "stopped";
    readonly pid: number;
    readonly startedAt: string;
    readonly baseUrl?: string;
    readonly models: readonly string[];
    readonly providers: readonly {
        readonly provider: string;
        readonly status: string;
        readonly oauthReady: boolean;
        readonly adapterReady: boolean;
        readonly detailCode?: string;
    }[];
}
export async function startSupervisorIpc(path: string, status: () => SupervisorStatus): Promise<{
    close(): Promise<void>;
}> {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.once("error", () => socket.destroy());
        handleSocket(socket, status);
    });
    server.listen(path);
    await once(server, "listening");
    return {
        close: async () => {
            const closed = once(server, "close");
            server.close();
            for (const socket of sockets) socket.destroy();
            await closed;
        },
    };
}
function handleSocket(socket: Socket, status: () => SupervisorStatus): void {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
        input += chunk;
        if (input.length > 4_096) {
            socket.destroy();
            return;
        }
        const newline = input.indexOf("\n");
        if (newline < 0)
            return;
        try {
            const request: unknown = JSON.parse(input.slice(0, newline));
            if (typeof request !== "object" || request === null || !("command" in request) || request.command !== "status") {
                throw new Error("invalid IPC command");
            }
            socket.end(`${JSON.stringify(status())}\n`);
        }
        catch {
            socket.end(`${JSON.stringify({ error: "invalid_request" })}\n`);
        }
    });
}
export async function readSupervisorStatus(path: string): Promise<SupervisorStatus | undefined> {
    return await new Promise((resolveStatus) => {
        const socket = createConnection(path);
        socket.setEncoding("utf8");
        let input = "";
        const timeout = setTimeout(() => {
            socket.destroy();
            resolveStatus(undefined);
        }, 1_500);
        socket.once("connect", () => socket.write(`${JSON.stringify({ command: "status" })}\n`));
        socket.on("data", (chunk: string) => {
            input += chunk;
            const newline = input.indexOf("\n");
            if (newline < 0)
                return;
            clearTimeout(timeout);
            socket.end();
            try {
                resolveStatus(parseSupervisorStatus(JSON.parse(input.slice(0, newline))));
            }
            catch {
                resolveStatus(undefined);
            }
        });
        socket.once("error", () => {
            clearTimeout(timeout);
            resolveStatus(undefined);
        });
    });
}
const sessionStateFilePattern = /^([a-f0-9]{32})\.json$/u;
const maximumSessionCandidates = 256;
export async function readActiveSupervisorStatuses(paths: RuntimePaths): Promise<readonly SupervisorStatus[]> {
    const candidates = [paths.ipc];
    try {
        const entries = await readdir(join(paths.root, "sessions"), { withFileTypes: true });
        const sessionIds = entries
            .filter((entry) => entry.isFile())
            .flatMap((entry) => sessionStateFilePattern.exec(entry.name)?.[1] ?? [])
            .slice(0, maximumSessionCandidates);
        candidates.push(...sessionIds.map((sessionId) => runtimeSessionPaths(paths, sessionId).ipc));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw error;
    }
    const discovered = (await Promise.all(candidates.map(async (path) => await readSupervisorStatus(path))))
        .filter((status): status is SupervisorStatus => status?.status === "running");
    const unique = new Map<string, SupervisorStatus>();
    for (const status of discovered)
        unique.set(`${status.pid}:${status.startedAt}:${status.baseUrl ?? ""}`, status);
    return [...unique.values()];
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseSupervisorStatus(value: unknown): SupervisorStatus {
    if (!isRecord(value) || value["schemaVersion"] !== 1)
        throw new Error("invalid supervisor status header");
    const status = value["status"];
    const baseUrl = value["baseUrl"];
    const models = value["models"];
    const providers = value["providers"];
    if ((status !== "running" && status !== "stopped") ||
        typeof value["pid"] !== "number" ||
        !Number.isSafeInteger(value["pid"]) ||
        value["pid"] < 1 ||
        typeof value["startedAt"] !== "string" ||
        Number.isNaN(new Date(value["startedAt"]).valueOf()) ||
        !Array.isArray(models) ||
        models.length > 5_000 ||
        !models.every((model) => typeof model === "string" && model.length > 0 && model.length <= 256) ||
        !Array.isArray(providers) ||
        providers.length > 16) {
        throw new Error("invalid supervisor status body");
    }
    if (baseUrl !== undefined) {
        if (typeof baseUrl !== "string")
            throw new Error("invalid supervisor base URL");
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
            throw new Error("supervisor base URL is not loopback");
        }
    }
    const safeProviders = providers.map((provider: unknown) => {
        if (!isRecord(provider) ||
            typeof provider["provider"] !== "string" ||
            provider["provider"].length > 32 ||
            typeof provider["status"] !== "string" ||
            provider["status"].length > 32 ||
            typeof provider["oauthReady"] !== "boolean" ||
            typeof provider["adapterReady"] !== "boolean" ||
            (provider["detailCode"] !== undefined &&
                (typeof provider["detailCode"] !== "string" || provider["detailCode"].length > SUPERVISOR_DETAIL_CODE_LIMIT))) {
            throw new Error("invalid supervisor provider status");
        }
        return {
            provider: provider["provider"],
            status: provider["status"],
            oauthReady: provider["oauthReady"],
            adapterReady: provider["adapterReady"],
            ...(provider["detailCode"] === undefined ? {} : { detailCode: provider["detailCode"] as string }),
        };
    });
    return {
        schemaVersion: 1,
        status,
        pid: value["pid"],
        startedAt: value["startedAt"],
        ...(baseUrl === undefined ? {} : { baseUrl }),
        models,
        providers: safeProviders,
    };
}
