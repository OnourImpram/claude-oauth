import { ok, strictEqual } from "node:assert/strict";
import { ChildProcess, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { RouterError } from "../src/domain/errors.js";

const scenarioVariable = "HEZARFEN_GROK_SESSION_CLOSE";
const scenarios = ["success", "cancel"] as const;
type Scenario = typeof scenarios[number];

async function checkClose(scenario: Scenario): Promise<void> {
    const scratch = process.env["LOCALAPPDATA"];
    ok(scratch !== undefined, "The isolated fixture requires its scratch directory.");
    const workspace = join(scratch, "workspace");
    await mkdir(join(workspace, ".git"), { recursive: true });
    const child = new ChildProcess();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let resolvePrompt = (): void => undefined;
    let rejectPrompt = (_error: Error): void => undefined;
    const prompt = new Promise<void>((resolveCall, rejectCall) => {
        resolvePrompt = resolveCall;
        rejectPrompt = rejectCall;
    });
    let markPrompted = (): void => undefined;
    const prompted = new Promise<void>((resolveReady) => { markPrompted = resolveReady; });
    let markKilled = (): void => undefined;
    const killed = new Promise<void>((resolveKill) => { markKilled = resolveKill; });
    // This fake handle never reaches the OS. Cancellation only ends the fake
    // ACP transport; exit and close remain separate, controlled observations.
    child.kill = () => {
        markKilled();
        if (scenario === "cancel") rejectPrompt(new Error("Synthetic ACP cancellation"));
        return true;
    };
    let closed = false;
    const close = (): void => {
        if (closed) return;
        closed = true;
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.emit("close", scenario === "success" ? 0 : 1, null);
    };
    const client = {
        onRequest() { return client; },
        onNotification() { return client; },
        async connectWith(_stream: acp.Stream, run: (context: {
            request(method: string): Promise<unknown>;
        }) => Promise<void>) {
            await run({
                async request(method: string): Promise<unknown> {
                    if (method === acp.methods.agent.initialize) return {};
                    if (method === acp.methods.agent.session.new) return { sessionId: randomUUID() };
                    strictEqual(method, acp.methods.agent.session.prompt);
                    markPrompted();
                    return await prompt;
                },
            });
        },
    };
    const childModule = mock.module("node:child_process", { namedExports: { spawn: () => child } });
    const protocolModule = mock.module("@agentclientprotocol/sdk", {
        namedExports: { ...acp, client: () => client },
    });
    let observed: Promise<{ kind: "success" } | { kind: "failure"; error: unknown }> | undefined;
    try {
        const { startGrokAcpSession } = await import("../src/grok/acp-bridge.js");
        const session = startGrokAcpSession({
            binary: "unused-provider", home: join(scratch, "grok-home"), cwd: workspace,
            task: "Fixture task", model: "fixture-model", environment: {},
        });
        let finished = false;
        observed = session.done.then(
            () => { finished = true; return { kind: "success" } as const; },
            (error: unknown) => { finished = true; return { kind: "failure", error } as const; },
        );
        await prompted;
        if (scenario === "cancel") session.cancel("fixture cancellation");
        else resolvePrompt();
        await killed;
        await nextTurn();
        strictEqual(finished, false, "Ending ACP or sending kill must not settle session.done.");
        Object.defineProperty(child, "exitCode", { value: scenario === "success" ? 0 : 1 });
        child.emit("exit", child.exitCode, null);
        await nextTurn();
        strictEqual(finished, false,
            "Grok session.done must remain pending after exit while stdio is still open.");
        close();
        const result = await observed;
        strictEqual(finished, true, "Child close must release session.done.");
        if (scenario === "success") strictEqual(result.kind, "success");
        else ok(result.kind === "failure" && result.error instanceof RouterError);
    }
    finally {
        resolvePrompt();
        close();
        await observed;
        protocolModule.restore();
        childModule.restore();
    }
}

const childScenario = process.env[scenarioVariable];
if (childScenario === undefined) {
    for (const scenario of scenarios) {
        it(`F1: Grok session waits for child close (${scenario})`, async () => {
            const temporaryRoot = resolve(tmpdir());
            const scratch = resolve(await mkdtemp(join(temporaryRoot, "claude-oauth-grok-close-")));
            try {
                const child = spawnSync(process.execPath, [
                    "--experimental-test-module-mocks", fileURLToPath(import.meta.url),
                ], {
                    cwd: scratch,
                    env: {
                        ...process.env, [scenarioVariable]: scenario,
                        LOCALAPPDATA: scratch, HOME: scratch, USERPROFILE: scratch,
                    },
                    windowsHide: true, encoding: "utf8", timeout: 15_000,
                    killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
                });
                strictEqual(child.error === undefined, true,
                    "The Grok close fixture must start and finish within its timeout.");
                strictEqual(child.status, 0,
                    `The ${scenario} Grok close fixture failed; status=${child.status}, signal=${child.signal}.`);
            }
            finally {
                const target = relative(temporaryRoot, scratch);
                ok(target !== "" && !target.startsWith("..") && !isAbsolute(target),
                    "Fixture cleanup must stay inside the temporary directory.");
                await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            }
        });
    }
}
else {
    if (!scenarios.includes(childScenario as Scenario)) throw new Error("Unknown Grok close scenario.");
    await checkClose(childScenario as Scenario);
}
