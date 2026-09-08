// Local CLI check only: neither arm opens a router or submits a model request.
import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
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
console.log(`command: ${basename(binary)} remote-control --help (resolved on PATH; native executable preferred)`);
let exitCode = 0;
for (const arm of ["positive", "negative"]) {
    const env = { ...environment };
    if (arm === "negative") env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
    // .cmd/.bat need cmd.exe; arguments are fixed and the resolved path is quoted.
    // https://nodejs.org/docs/latest-v24.x/api/child_process.html#spawning-bat-and-cmd-files-on-windows
    const batch = windows && /\.(cmd|bat)$/iu.test(binary);
    const result = spawnSync(batch ? (process.env.ComSpec ?? "cmd.exe") : binary,
        batch ? ["/d", "/s", "/c", `""${binary}" remote-control --help"`] : ["remote-control", "--help"],
        { env, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: batch, timeout: 60_000, maxBuffer: 1024 * 1024 });
    if (result.error || result.signal || result.status === null) {
        console.log(`${arm}: NOT_RUN reason=${result.error?.code ?? result.signal ?? "no exit status"}`);
        exitCode = 3;
        continue;
    }
    const namesNativeHost = /api\.anthropic\.com/u.test(result.stdout + result.stderr);
    const passed = arm === "positive" ? result.status === 0 : result.status !== 0 && namesNativeHost;
    console.log(`${arm}: ${passed ? "PASS" : "FAIL"} exit=${result.status} api.anthropic.com=${namesNativeHost ? "named" : "absent"}`);
    // Print measurements, never raw CLI output that might include local configuration.
    console.log(`${arm}: stdout_bytes=${Buffer.byteLength(result.stdout)} stderr_bytes=${Buffer.byteLength(result.stderr)}`);
    if (!passed && exitCode === 0) exitCode = 1;
}
process.exit(exitCode);
