// Native separation probe: two arms around `claude remote-control --help`.
// Positive arm: a clean environment (no ANTHROPIC_* selectors) is accepted and the Remote
// Control usage text is printed. Negative arm: a router-style ANTHROPIC_BASE_URL is refused and
// the refusal names api.anthropic.com. The negative arm is what makes the positive arm mean
// something: the check can fail, so a pass is a measurement.
// Local CLI check only: neither arm opens a router or submits a model request.
//
// Measured 2026-09-08 with Claude Code 2.1.257: `remote-control --help` prints the usage text
// and then stays alive (from Node, PowerShell and a file-backed stdout alike), so the positive
// arm is judged on the printed text and the absence of a refusal, and a process that does not
// exit after printing is terminated and reported as exited=false rather than as a timeout.
import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import { basename, delimiter, join } from "node:path";

const windows = process.platform === "win32";
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH");
const directories = (process.env[pathKey] ?? "").split(delimiter).filter(Boolean);
// A sanitizing claude.cmd would erase the negative arm. Prefer a native executable
// on PATH, then fall back to a command wrapper if that is the only installation.
let binary;
for (const name of windows ? ["claude.exe", "claude.cmd", "claude.bat"] : ["claude"]) {
    for (const directory of directories) {
        const candidate = join(directory.replace(/^"|"$/gu, ""), name);
        try {
            accessSync(candidate, windows ? constants.F_OK : constants.X_OK);
            binary = candidate;
            break;
        } catch { /* Continue PATH lookup. */ }
    }
    if (binary) break;
}
if (!binary) {
    console.log("positive: NOT_RUN reason=claude is absent from PATH");
    console.log("negative: NOT_RUN reason=claude is absent from PATH");
    process.exit(2);
}

const environment = { ...process.env };
for (const key of Object.keys(environment)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|HEZARFEN_CLAUDE_OAUTH_)/iu.test(key)) delete environment[key];
}
const HARD_TIMEOUT_MS = 60_000;
const AFTER_OUTPUT_GRACE_MS = 5_000;
const usagePattern = /remote-control/iu;
const refusalPattern = /api\.anthropic\.com/u;

function run(env) {
    return new Promise((resolve) => {
        // .cmd/.bat need cmd.exe; arguments are fixed and the resolved path is quoted.
        // https://nodejs.org/docs/latest-v24.x/api/child_process.html#spawning-bat-and-cmd-files-on-windows
        const batch = windows && /\.(cmd|bat)$/iu.test(binary);
        const child = spawn(batch ? (process.env.ComSpec ?? "cmd.exe") : binary,
            batch ? ["/d", "/s", "/c", `""${binary}" remote-control --help"`] : ["remote-control", "--help"],
            { env, windowsHide: true, windowsVerbatimArguments: batch, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let graceTimer;
        const finish = (outcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(hardTimer);
            clearTimeout(graceTimer);
            resolve({ ...outcome, stdout, stderr });
        };
        const hardTimer = setTimeout(() => { child.kill(); finish({ error: "ETIMEDOUT", status: null, exited: false }); }, HARD_TIMEOUT_MS);
        const armGrace = () => {
            // Output is complete enough to judge; give the process a bounded chance to exit.
            if (graceTimer === undefined) graceTimer = setTimeout(() => { child.kill(); finish({ status: null, exited: false }); }, AFTER_OUTPUT_GRACE_MS);
        };
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; if (usagePattern.test(stdout) || refusalPattern.test(stdout)) armGrace(); });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; if (refusalPattern.test(stderr)) armGrace(); });
        child.once("error", (error) => finish({ error: error.code ?? "spawn_error", status: null, exited: false }));
        child.once("close", (code) => finish({ status: code, exited: true }));
    });
}

console.log(`command: ${basename(binary)} remote-control --help (resolved on PATH; native executable preferred)`);
let exitCode = 0;
for (const arm of ["positive", "negative"]) {
    const env = { ...environment };
    if (arm === "negative") env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
    const result = await run(env);
    const combined = result.stdout + result.stderr;
    const namesNativeHost = refusalPattern.test(combined);
    const printedUsage = usagePattern.test(result.stdout);
    if (result.error !== undefined || (!result.exited && !printedUsage && !namesNativeHost)) {
        console.log(`${arm}: NOT_RUN reason=${result.error ?? "no output and no exit"}`);
        exitCode = 3;
        continue;
    }
    const passed = arm === "positive"
        ? !namesNativeHost && (result.status === 0 || printedUsage)
        : result.exited && result.status !== 0 && namesNativeHost;
    console.log(`${arm}: ${passed ? "PASS" : "FAIL"} exit=${result.exited ? result.status : "none"} exited=${result.exited} usage=${printedUsage ? "printed" : "absent"} api.anthropic.com=${namesNativeHost ? "named" : "absent"}`);
    // Print measurements, never raw CLI output that might include local configuration.
    console.log(`${arm}: stdout_bytes=${Buffer.byteLength(result.stdout)} stderr_bytes=${Buffer.byteLength(result.stderr)}`);
    if (!passed && exitCode === 0) exitCode = 1;
}
process.exit(exitCode);
