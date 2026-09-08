import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { computeReleaseId } from "../src/runtime/release-identity.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = ["claude-oauth.ps1", "claude-oauth-launcher.ps1", "claude-launcher.ps1", "claude-oauth.sh", "invoke-claude-process.ps1"];
const routingVariables = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE", "HEZARFEN_CLAUDE_OAUTH_RELEASE_ID"];

async function assertStreaming(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    const child = spawn(binary, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    try {
        await new Promise<void>((resolveFrame, rejectFrame) => {
            const timer = setTimeout(() => rejectFrame(new Error("No output arrived before stdin EOF")), 10_000);
            child.once("error", (error) => { clearTimeout(timer); rejectFrame(error); });
            child.stderr.resume();
            let output = "";
            child.stdout.on("data", (chunk: Buffer) => {
                output += chunk.toString();
                if (output.includes("stream frame")) { clearTimeout(timer); resolveFrame(); }
            });
            child.stdin.write("stream frame\n");
        });
        const exit = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
        child.stdin.end();
        strictEqual(await exit, 0);
    } finally {
        child.stdin.end();
        if (child.exitCode === null) child.kill();
    }
}

it("B05 ships portable launchers with no operator paths or literal release identity", async () => {
    for (const script of scripts) {
        const source = await readFile(join(repo, "shim", script), "utf8");
        doesNotMatch(source, /[A-Z]:[\\/]Users[\\/]|router-v3-[A-F0-9]{12}-[A-F0-9]{12}/u);
    }
});

it("B05 probe reports both NOT_RUN arms with a distinct exit when claude is absent", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "probe-no-path-"));
    try {
        const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
        const result = spawnSync(process.execPath, [join(repo, "scripts/native-separation-probe.mjs")], {
            env: { ...environment, PATH: scratch }, encoding: "utf8", timeout: 10_000,
        });
        strictEqual(result.status, 2, result.stderr);
        match(result.stdout, /positive: NOT_RUN.*claude.*PATH/u);
        match(result.stdout, /negative: NOT_RUN.*claude.*PATH/u);
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
});

it("B05 release verifier rejects an artifact that disagrees with the installed release", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "shim-identity-"));
    try {
        let release = join(scratch, "seed");
        await mkdir(join(release, "dist"), { recursive: true });
        await mkdir(join(release, "config"));
        const id = await computeReleaseId(release);
        const namedRelease = join(scratch, id);
        await rename(release, namedRelease);
        release = namedRelease;
        await writeFile(join(release, "release-id"), id + "\n");
        const verify = () => spawnSync(process.execPath, [join(repo, "scripts/release-id.mjs"), "--verify", release], { encoding: "utf8" });
        strictEqual(verify().status, 0);
        await writeFile(join(release, "release-id"), "invalid\n");
        const drifted = verify();
        strictEqual(drifted.status, 1, drifted.stdout);
        match(drifted.stdout, /DRIFTED/u);
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
});

it("B05 probe measures both arms and fails if either expected outcome is missing", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "probe-stub-"));
    try {
        const stub = join(scratch, "stub.cjs");
        const binary = join(scratch, process.platform === "win32" ? "claude.cmd" : "claude");
        await writeFile(binary, process.platform === "win32"
            ? `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`
            : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${stub.replaceAll("'", "'\\''")}' "$@"\n`);
        await chmod(binary, 0o755);
        const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
        for (const mode of ["correct", "always-accept", "always-reject"]) {
            await writeFile(stub, `if (process.argv.slice(2).join(' ') !== 'remote-control --help') process.exit(8);
if (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_CUSTOM_HEADERS) process.exit(9);
if (${JSON.stringify(mode)} === 'always-accept') process.exit(0);
if (${JSON.stringify(mode)} === 'always-reject' || process.env.ANTHROPIC_BASE_URL) {console.error('Remote Control is only available when using Claude via api.anthropic.com.');process.exit(1);}
console.log('Usage: claude remote-control');`);
            const result = spawnSync(process.execPath, [join(repo, "scripts/native-separation-probe.mjs")], {
                env: { ...environment, PATH: scratch, ANTHROPIC_AUTH_TOKEN: "inherited", ANTHROPIC_CUSTOM_HEADERS: "inherited", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, encoding: "utf8", timeout: 10_000,
            });
            strictEqual(result.status, mode === "correct" ? 0 : 1, result.stderr + result.stdout);
            match(result.stdout, mode === "always-reject" ? /positive: FAIL/u : /positive: PASS/u);
            match(result.stdout, mode === "always-accept" ? /negative: FAIL/u : /negative: PASS/u);
        }
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
});

for (const shell of process.platform === "win32" ? ["powershell", "sh"] : ["sh"]) {
    it(`B05 ${shell} separates router and native entries and forwards arguments`, async () => {
        const scratch = await mkdtemp(join(tmpdir(), "shim spaced-"));
        try {
            const release = join(scratch, "release");
            await mkdir(join(release, "dist/src"), { recursive: true });
            await mkdir(join(release, "config"));
            const stub = `console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),present:${JSON.stringify(routingVariables)}.filter(k=>process.env[k]),id:process.env.HEZARFEN_CLAUDE_OAUTH_RELEASE_ID}));process.exit(7);`;
            await writeFile(join(release, "dist/src/cli.js"), stub);
            await writeFile(join(scratch, "native.js"), stub);
            const id = await computeReleaseId(release);
            await writeFile(join(release, "release-id"), id + "\n");
            await cp(join(repo, "shim"), join(release, "shim"), { recursive: true });
            const native = join(scratch, shell === "sh" ? "native.sh" : "native.ps1");
            const nodePath = process.execPath.replaceAll("\\", "/");
            await writeFile(native, shell === "sh"
                ? `#!/bin/sh\nexec '${nodePath.replaceAll("'", "'\\''")}' '${join(scratch, "native.js").replaceAll("\\", "/").replaceAll("'", "'\\''")}' "$@"\n`
                : `$incoming = @($input)\n$incoming | & '${join(release, "shim/invoke-claude-process.ps1").replaceAll("'", "''")}' '${nodePath.replaceAll("'", "''")}' '${join(scratch, "native.js").replaceAll("'", "''")}' @args\nexit $LASTEXITCODE\n`);
            await chmod(native, 0o755);
            const environment = { ...process.env, CLAUDE_OAUTH_NODE: process.execPath, CLAUDE_OAUTH_NATIVE_BINARY: native,
                ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_AUTH_TOKEN: "inherited", ANTHROPIC_CUSTOM_HEADERS: "inherited" };
            const script = join(release, "shim", shell === "sh" ? "claude-oauth.sh" : "claude-oauth.ps1");
            const prefix = shell === "sh" ? [script] : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
            const shellBinary = shell === "sh" ? "sh" : "powershell.exe";
            const complex = ["--agents", '{"custom":{"prompt":"do task","model":"sol","tools":["Read"]}}', "", 'a"b', "space tail\\"];
            const routerArgs = [["--print", "space argument"], ["--print", ...complex], ["--print", "remote-control"], ["--print", "--hezarfen-entrypoint=claude"], ["--print", "--", "--rc"], ["--system-prompt", "--rc"], ["--model", "remote-control", "--print", "hello"]];
            const nativeArgs = [["remote-control", "--help"], ["--rc"], ["--remote-control"], ["--print", "--rc"], ["--model", "opus", "--rc"], ["--hezarfen-entrypoint=claude", "--print", "space argument"], ["--hezarfen-entrypoint=claude", ...complex], ["--hezarfen-entrypoint=claude", "--print", "--hezarfen-entrypoint=claude"]];
            for (const args of [...routerArgs, ...nativeArgs]) {
                const result = spawnSync(shellBinary, [...prefix, ...args], { env: environment, cwd: scratch, encoding: "utf8", timeout: 15_000 });
                strictEqual(result.status, 7, result.stderr || result.stdout);
                const output = JSON.parse(result.stdout.trim());
                const isRouter = routerArgs.includes(args);
                deepStrictEqual(output.args, args[0] === "--hezarfen-entrypoint=claude" ? args.slice(1) : args);
                strictEqual(resolve(output.cwd), resolve(scratch));
                deepStrictEqual(output.present, isRouter ? routingVariables : []);
                strictEqual(output.id, isRouter ? id : undefined);
            }
            // Native entry must not need an installed router or Node override.
            const missingRelease = { ...environment, CLAUDE_OAUTH_RELEASE_ROOT: join(scratch, "absent"), CLAUDE_OAUTH_NODE: "missing-node" };
            const nativeResult = spawnSync(shellBinary, [...prefix, "remote-control", "--help"], { env: missingRelease, encoding: "utf8", timeout: 15_000 });
            strictEqual(nativeResult.status, 7, nativeResult.stderr);
            await writeFile(join(release, "dist/src/cli.js"), "process.stdin.on('data',chunk=>process.stdout.write(chunk));");
            await assertStreaming(shellBinary, [...prefix, "--print", "--input-format", "stream-json"], environment);
            for (const code of [0, 7]) {
                const diagnostic = `console.error('fixture stderr');process.exit(${code});`;
                await writeFile(join(release, "dist/src/cli.js"), diagnostic);
                await writeFile(join(scratch, "native.js"), diagnostic);
                for (const args of [["--print", "prompt"], ["--hezarfen-entrypoint=claude", "--print", "prompt"]]) {
                    const result = spawnSync(shellBinary, [...prefix, ...args], { env: environment, encoding: "utf8", timeout: 15_000 });
                    strictEqual(result.status, code, result.stderr);
                    match(result.stderr, /fixture stderr/u);
                }
            }
            if (shell === "powershell") {
                const reader = "process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>console.log(JSON.stringify({input})));";
                await writeFile(join(release, "dist/src/cli.js"), reader);
                await writeFile(join(scratch, "native.js"), reader);
                const pipeline = join(scratch, "pipeline.ps1");
                await writeFile(pipeline, `$ErrorActionPreference = 'Stop'\nforeach ($mode in @('router', 'native')) {\n$argv = @('--print', 'prompt')\nif ($mode -eq 'native') { $argv = @('--hezarfen-entrypoint=claude') + $argv }\n$captured = 'PowerShell input' | & '${script.replaceAll("'", "''")}' @argv\n$parsed = $captured | ConvertFrom-Json\nif ($parsed.input.Trim() -ne 'PowerShell input') { throw 'pipeline input lost' }\n}\nWrite-Output 'PIPELINES_OK'\n`);
                const piped = spawnSync(shellBinary, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", pipeline], { env: environment, encoding: "utf8", timeout: 20_000 });
                strictEqual(piped.status, 0, piped.stderr);
                strictEqual(piped.stdout.trim(), "PIPELINES_OK");
            }
        } finally {
            await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
}

if (process.platform === "win32") {
    it("B05 PowerShell process helper preserves pipe EOF and refuses batch targets", () => {
        const helper = join(repo, "shim/invoke-claude-process.ps1");
        const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, process.execPath, "-e",
            "process.stdin.setEncoding('utf8');let data='';process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>{console.log(data);console.error('stderr preserved');process.exitCode=7;});"],
        { input: "piped input", encoding: "utf8", timeout: 10_000 });
        strictEqual(result.status, 7, result.stderr);
        strictEqual(result.stdout.trim(), "piped input");
        match(result.stderr, /stderr preserved/u);
        const refused = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "unsupported.cmd"], { encoding: "utf8", timeout: 10_000 });
        strictEqual(refused.status, 1);
        match(refused.stderr, /batch wrappers cannot preserve/u);
    });
    it("B05 PowerShell native stream-json responds while stdin remains open", async () => {
        await assertStreaming("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repo, "shim/claude-oauth.ps1"),
            "--hezarfen-entrypoint=claude", "-e", "process.stdin.on('data',chunk=>process.stdout.write(chunk));", "--", "--input-format=stream-json"],
        { ...process.env, CLAUDE_OAUTH_NATIVE_BINARY: process.execPath, CLAUDE_OAUTH_RELEASE_ROOT: "missing-release" });
    });
    it("B05 PowerShell resolves relative executable overrides against its current location", async () => {
        const scratch = await mkdtemp(join(tmpdir(), "relative-node-"));
        try {
            const script = join(scratch, "relative.ps1");
            await writeFile(script, `Set-Location -LiteralPath '${dirname(process.execPath).replaceAll("'", "''")}'\n$captured = & '${join(repo, "shim/invoke-claude-process.ps1").replaceAll("'", "''")}' './node.exe' '-e' 'console.log(42)'\nif ($captured -ne '42') { throw 'capture lost' }\n$longArg = 'x' * 25000\n$length = & '${join(repo, "shim/invoke-claude-process.ps1").replaceAll("'", "''")}' './node.exe' '-e' 'if (process.env.HEZARFEN_CLAUDE_OAUTH_ARGV) process.exit(9);console.log(process.argv[1].length)' $longArg\nif ($length -ne '25000') { throw 'long argument lost or payload leaked' }\nWrite-Output 'RELATIVE_OK'\n`);
            const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { cwd: scratch, encoding: "utf8", timeout: 10_000 });
            strictEqual(result.status, 0, result.stderr);
            strictEqual(result.stdout.trim(), "RELATIVE_OK");
        } finally {
            await rm(scratch, { recursive: true, force: true });
        }
    });
}
