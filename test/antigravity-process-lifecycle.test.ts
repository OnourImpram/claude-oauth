import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { ChildProcess, spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { RouterError } from "../src/domain/errors.js";

const scenarioVariable = "HEZARFEN_ANTIGRAVITY_PROCESS_LIFECYCLE";
const scenarios = ["abort", "timeout", "output-limit", "stdin-error", "spawn-error", "success", "pre-aborted"] as const;
type Scenario = typeof scenarios[number];

async function checkLifecycle(scenario: Scenario): Promise<void> {
    const child = new ChildProcess();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let kills = 0;
    let spawns = 0;
    let closed = false;
    // A fake handle must never signal an OS process. Emitting a secondary error here
    // also measures that cancellation/limit/transport failures retain their first cause.
    child.kill = () => {
        kills += 1;
        child.emit("error", new Error("Synthetic signal failure"));
        return false;
    };
    const close = (): void => {
        if (closed)
            return;
        closed = true;
        child.emit("close", scenario === "success" ? 0 : 1);
    };
    // References imported before mock.module stay real; only the runner's spawn changes.
    // https://nodejs.org/download/release/v24.14.0/docs/api/test.html#mockmodulespecifier-options
    const childModule = mock.module("node:child_process", {
        namedExports: { spawn: () => { spawns += 1; return child; } },
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const { runAntigravityProcess } = await import("../src/antigravity/headless-bridge.js");
        const controller = new AbortController();
        if (scenario === "pre-aborted")
            controller.abort();
        let finished = false;
        const observed = runAntigravityProcess({
            command: "unused-provider", arguments: [], input: "", cwd: import.meta.dirname,
            environment: {}, timeoutMs: 1_000, maximumOutputBytes: 32,
            signal: controller.signal, shell: false, windowsHide: true,
        }).then(
            (output) => { finished = true; return { kind: "success", output } as const; },
            (error: unknown) => { finished = true; return { kind: "failure", error } as const; },
        );
        if (scenario === "pre-aborted") {
            const result = await observed;
            strictEqual(spawns, 0, "a pre-aborted request must not create a child");
            ok(result.kind === "failure" && result.error instanceof RouterError);
            strictEqual(result.error.code, "upstream_timeout");
            strictEqual(result.error.status, 504);
            strictEqual(kills, 0);
            return;
        }
        strictEqual(spawns, 1);
        if (scenario === "abort")
            controller.abort();
        else if (scenario === "timeout")
            mock.timers.tick(1_000);
        else if (scenario === "output-limit")
            child.stdout.emit("data", Buffer.alloc(33));
        else if (scenario === "stdin-error")
            child.stdin.emit("error", new Error("Synthetic stdin failure"));
        else if (scenario === "spawn-error")
            child.emit("error", new Error("Synthetic spawn failure"));
        else {
            child.stdout.emit("data", Buffer.from("before"));
            child.stderr.emit("data", Buffer.from("diagnostic"));
        }
        await nextTurn();
        strictEqual(finished, false, "kill/error is not close: the runner must remain pending");
        strictEqual(kills, scenario === "success" || scenario === "spawn-error" ? 0 : 1);
        if (scenario !== "spawn-error") {
            child.emit("exit", scenario === "success" ? 0 : 1);
            await nextTurn();
            strictEqual(finished, false, "exit still permits open stdio; only close ends the run");
        }
        if (scenario === "success")
            child.stdout.emit("data", Buffer.from("-after"));
        else {
            // Output may still arrive during termination; it must not replace the first error.
            child.stdout.emit("data", Buffer.alloc(64));
            controller.abort();
        }
        close();
        const result = await observed;
        strictEqual(getEventListeners(controller.signal, "abort").length, 0);
        if (scenario === "success") {
            ok(result.kind === "success");
            deepStrictEqual(result.output, { exitCode: 0, stdout: "before-after", stderr: "diagnostic" });
        }
        else {
            ok(result.kind === "failure" && result.error instanceof RouterError);
            const expected = {
                abort: ["upstream_timeout", 504, "Antigravity request was cancelled."],
                timeout: ["upstream_timeout", 504, "Antigravity exceeded the process timeout."],
                "output-limit": ["upstream_protocol_error", 502, "Antigravity exceeded the safe output limit."],
                "stdin-error": ["adapter_unavailable", 503, "Antigravity stdin transport failed."],
                "spawn-error": ["adapter_unavailable", 503, "Antigravity could not be started."],
            }[scenario];
            deepStrictEqual([result.error.code, result.error.status, result.error.message], expected);
        }
    }
    finally {
        close();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        mock.timers.reset();
        childModule.restore();
    }
}

const childScenario = process.env[scenarioVariable];
if (childScenario === undefined) {
    for (const scenario of scenarios) {
        it(`F1: Antigravity process waits for close (${scenario})`, () => {
            const child = spawnSync(process.execPath, [
                "--experimental-test-module-mocks", fileURLToPath(import.meta.url),
            ], {
                env: { ...process.env, [scenarioVariable]: scenario }, windowsHide: true,
                encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
            });
            strictEqual(child.error === undefined, true, "the isolated lifecycle fixture must finish within its timeout");
            strictEqual(child.status, 0, `The ${scenario} lifecycle fixture failed; status=${child.status}, signal=${child.signal}.`);
        });
    }
}
else {
    if (!scenarios.includes(childScenario as Scenario))
        throw new Error("Unknown Antigravity process lifecycle scenario.");
    await checkLifecycle(childScenario as Scenario);
}
