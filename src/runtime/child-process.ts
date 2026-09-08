import { spawn, type ChildProcess } from "node:child_process";
import { basename, extname } from "node:path";
import { RouterError } from "../domain/errors.js";
export interface CapturedProcess {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}
export interface ProcessOptions {
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    /** Grace after SIGTERM before SIGKILL and unconditional timeout rejection. Defaults to 100 ms. */
    readonly terminationGraceMs?: number;
    readonly maximumOutputBytes?: number;
}
function needsShell(command: string): boolean {
    return process.platform === "win32" && [".cmd", ".bat"].includes(extname(command).toLowerCase());
}
export async function runInteractive(command: string, args: readonly string[], options: ProcessOptions): Promise<number> {
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.environment,
        shell: needsShell(command),
        stdio: "inherit",
        windowsHide: false,
    });
    return await new Promise((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, signal) => {
            if (signal !== null) {
                rejectExit(new RouterError("adapter_unavailable", `${basename(command)} exited after signal ${signal}.`, 503));
                return;
            }
            resolveExit(code ?? 1);
        });
    });
}
// A spawned child emits its launch failure asynchronously on the "error" event.
// With no listener attached, Node turns that into an unhandled 'error' and kills the
// process -- so one uninstalled provider binary takes down the whole CLI instead of
// degrading. This attaches the listener at spawn time and hands the caller a reader,
// so the catch path can tell "binary is absent" from "provider rejected us".
export function spawnFailureGuard(child: ChildProcess): () => NodeJS.ErrnoException | undefined {
    let failure: NodeJS.ErrnoException | undefined;
    child.once("error", (error: Error) => {
        failure = error as NodeJS.ErrnoException;
    });
    return () => failure;
}
export async function runCaptured(command: string, args: readonly string[], options: ProcessOptions): Promise<CapturedProcess> {
    const maximumOutputBytes = options.maximumOutputBytes ?? 1024 * 1024;
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.environment,
        shell: needsShell(command),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const collect = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maximumOutputBytes) {
            child.kill();
            return;
        }
        target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new RouterError("upstream_timeout", `${basename(command)} exceeded the process timeout.`, 504);
    try {
        const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
            // Retain an error listener for a late kill failure after the deadline has settled.
            child.on("error", (error) => {
                if (!timedOut) rejectExit(error);
            });
            child.once("exit", (code) => resolveExit(code ?? 1));
            const terminate = (signal: NodeJS.Signals): void => {
                try { child.kill(signal); }
                catch { /* A failed signal must not cancel escalation or deadline settlement. */ }
            };
            timeout = setTimeout(() => {
                timedOut = true;
                escalation = setTimeout(() => {
                    terminate("SIGKILL");
                    rejectExit(timeoutError);
                }, options.terminationGraceMs ?? 100);
                // Windows terminates on SIGTERM, so exit clears the grace timer there.
                // Source: https://nodejs.org/download/release/v24.14.0/docs/api/child_process.html#subprocesskillsignal
                terminate("SIGTERM");
            }, options.timeoutMs ?? 30_000);
        });
        if (outputBytes > maximumOutputBytes) {
            throw new RouterError("upstream_protocol_error", `${basename(command)} exceeded the safe output limit.`, 502);
        }
        if (timedOut) {
            throw timeoutError;
        }
        return {
            exitCode,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
        };
    }
    finally {
        clearTimeout(timeout);
        clearTimeout(escalation);
        if (timedOut) {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
        }
    }
}
