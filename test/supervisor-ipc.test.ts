import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { readSupervisorStatus, startSupervisorIpc, type SupervisorStatus } from "../src/supervisor/ipc.js";

const status: SupervisorStatus = {
    schemaVersion: 1, status: "running", pid: 1,
    startedAt: "2026-01-01T00:00:00.000Z", models: [], providers: [],
};

function socketPath(): string {
    const name = `astra-ipc-${randomUUID()}`;
    return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

it("IPC shutdown completes while a connected client sends no request", async () => {
    const path = socketPath();
    const server = await startSupervisorIpc(path, () => status);
    const client = createConnection(path);
    let closing: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
        await once(client, "connect");
        // Wait for the listener to accept this idle connection. A separate status
        // request is an observable server-side round trip, not a guessed sleep.
        deepStrictEqual(await readSupervisorStatus(path), status);
        closing = server.close();
        const outcome = await Promise.race([
            closing.then(() => "closed"),
            new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still waiting"), 1_000); }),
        ]);
        strictEqual(outcome, "closed");
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        client.destroy();
        await (closing ?? server.close());
    }
});

it("a normal IPC status request still returns the complete status", async () => {
    const path = socketPath();
    const server = await startSupervisorIpc(path, () => status);
    try {
        deepStrictEqual(await readSupervisorStatus(path), status);
    } finally {
        await server.close();
    }
});
