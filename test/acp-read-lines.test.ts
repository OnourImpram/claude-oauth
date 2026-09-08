import { ok, rejects, strictEqual } from "node:assert/strict";
import { ChildProcess, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { RouterError } from "../src/domain/errors.js";

type ReadParams = acp.ClientRequestParamsByMethod[typeof acp.methods.client.fs.readTextFile];
type ReadResult = acp.ClientRequestResponsesByMethod[typeof acp.methods.client.fs.readTextFile];
type ReadHandler = (context: { readonly params: ReadParams }) => Promise<ReadResult>;
interface ReadCase {
    readonly name: string;
    readonly text: string;
    readonly range: { readonly line?: number | null; readonly limit?: number | null };
    readonly expected: string;
}

// A selected line retains its original terminator. No range returns the exact file.
const cases: readonly ReadCase[] = [
    { name: "unrestricted CRLF", text: "alpha\r\nbeta\r\n", range: {}, expected: "alpha\r\nbeta\r\n" },
    { name: "nullable range", text: "alpha\r\nbeta\r\n", range: { line: null, limit: null }, expected: "alpha\r\nbeta\r\n" },
    { name: "middle LF line", text: "alpha\nbeta\ngamma", range: { line: 2, limit: 1 }, expected: "beta\n" },
    { name: "middle CRLF line", text: "alpha\r\nbeta\r\ngamma", range: { line: 2, limit: 1 }, expected: "beta\r\n" },
    { name: "last unterminated line", text: "alpha\nbeta", range: { line: 2, limit: 1 }, expected: "beta" },
    { name: "zero is first line", text: "alpha\nbeta", range: { line: 0, limit: 1 }, expected: "alpha\n" },
    { name: "missing start", text: "alpha\nbeta", range: { limit: 1 }, expected: "alpha\n" },
    { name: "null start", text: "alpha\nbeta", range: { line: null, limit: 1 }, expected: "alpha\n" },
    { name: "missing limit", text: "alpha\nbeta\ngamma", range: { line: 2 }, expected: "beta\ngamma" },
    { name: "null limit", text: "alpha\r\nbeta\r\n", range: { line: 2, limit: null }, expected: "beta\r\n" },
    { name: "zero limit", text: "alpha\nbeta", range: { line: 1, limit: 0 }, expected: "" },
    { name: "start beyond EOF", text: "alpha\nbeta", range: { line: 3, limit: 1 }, expected: "" },
    { name: "limit beyond EOF", text: "alpha\nbeta\n", range: { line: 2, limit: 20 }, expected: "beta\n" },
    { name: "blank line", text: "alpha\n\nbeta", range: { line: 2, limit: 1 }, expected: "\n" },
    { name: "empty file", text: "", range: { line: 1, limit: 1 }, expected: "" },
];

async function checkReadHandler(lane: "grok" | "gemini"): Promise<void> {
    // All fixture files live below dist/test (or test when run from source), inside the repo.
    const root = await mkdtemp(join(import.meta.dirname, ".acp-read-lines-"));
    const workspace = join(root, "workspace");
    const home = join(root, "worker-home");
    await mkdir(join(workspace, ".git"), { recursive: true });
    let readHandler: ReadHandler | undefined;
    const client = {
        onRequest(method: string, handler: ReadHandler) {
            if (method === acp.methods.client.fs.readTextFile)
                readHandler = handler;
            return client;
        },
        onNotification() { return client; },
        // Only transport/handshake is mocked. Reads below invoke the actual registered
        // production handler and the actual workspace security checks.
        async connectWith() { return { sessionId: "fixture-session", stopReason: "end_turn" }; },
    };
    const child = new ChildProcess();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    Object.defineProperty(child, "exitCode", { value: 0 });
    // This ChildProcess was never spawned, so its libuv handle carries no pid. On POSIX a
    // kill() on that handle still reaches the kernel, with an indeterminate pid -- measured
    // 2026-09-07 on Linux: the Gemini bridge's cleanup kill() SIGTERMed the whole process
    // group, the outer test process and the shell included, and the suite could not run at
    // all. On Windows the same call fails with EBADF, which is why it never showed there. A
    // fake child must not be able to signal the operating system.
    child.kill = () => false;
    const childModule = mock.module("node:child_process", { namedExports: { spawn: () => child } });
    const protocolModule = mock.module("@agentclientprotocol/sdk", { namedExports: { ...acp, client: () => client } });
    const configurationModule = mock.module(new URL("../src/runtime/provider-config.js", import.meta.url), {
        namedExports: { ensureGeminiOAuthConfiguration: async () => join(home, "settings.json") },
    });
    try {
        const options = { cwd: workspace, home, task: "Read the fixture.", binary: "unused-provider" };
        if (lane === "grok") {
            const { runGrokAcp } = await import("../src/grok/acp-bridge.js");
            await runGrokAcp({ ...options, model: "fixture-model", environment: {} });
        }
        else {
            const { runGeminiAcp } = await import("../src/gemini/acp-bridge.js");
            await runGeminiAcp(options);
        }
        ok(readHandler !== undefined, "The provider must register its ACP file reader.");
        const handler = readHandler;
        const path = join(workspace, "fixture.txt");
        for (const entry of cases) {
            await writeFile(path, entry.text, "utf8");
            const result = await handler({ params: { sessionId: "fixture-session", path, ...entry.range } });
            strictEqual(result.content, entry.expected, `${lane}: ${entry.name}`);
        }
        const protectedPath = join(workspace, ".env");
        await writeFile(protectedPath, "fixture", "utf8");
        await rejects(handler({ params: { sessionId: "fixture-session", path: protectedPath, limit: 0 } }),
            (error: unknown) => error instanceof RouterError && error.code === "unsupported_feature",
            "An empty slice must still pass the existing whole-file security check.");
    }
    finally {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        configurationModule.restore();
        protocolModule.restore();
        childModule.restore();
        ok(relative(import.meta.dirname, root).startsWith(".acp-read-lines-"), "Fixture cleanup stays inside the repository.");
        await rm(root, { recursive: true, force: true });
    }
}

const scenarioVariable = "HEZARFEN_ACP_READ_LINES_LANE";
const childLane = process.env[scenarioVariable];
if (childLane === undefined) {
    for (const lane of ["grok", "gemini"] as const) {
        it(`ACP file reader honors line ranges: ${lane}`, () => {
            const child = spawnSync(process.execPath, [
                "--experimental-test-module-mocks", fileURLToPath(import.meta.url),
            ], {
                cwd: import.meta.dirname,
                env: { ...process.env, [scenarioVariable]: lane },
                encoding: "utf8",
                timeout: 15_000,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            });
            strictEqual(child.error === undefined, true, "The ACP fixture must finish within its timeout.");
            strictEqual(child.status, 0, `The ${lane} ACP fixture failed; status=${child.status}, signal=${child.signal}.`);
        });
    }
}
else {
    if (childLane !== "grok" && childLane !== "gemini")
        throw new Error("Unknown ACP read fixture lane.");
    await checkReadHandler(childLane);
}
