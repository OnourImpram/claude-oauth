import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createEphemeralConfigHome, sweepStaleConfigHomes, LINKED_IDENTITY_FILES, DEFAULT_TOOL_SERVER_NAME } from "../src/antigravity/config-home.js";
import { runAntigravityHeadless } from "../src/antigravity/headless-bridge.js";

// G01 / Path D. THE THREE ARMS THE DESIGN COMMITTED TO, BEFORE IT WAS BUILT
// (tasks/router-karar-20260907/g01-ana-oturum-tasarimi.md §6):
//   (a) during the call the nonce IS in the configuration the child will read,
//   (b) when the call ends it is NOT -- on the throwing path too,
//   (c) a home orphaned by a crash is swept, and a home with a LIVE owner survives.
//
// The third arm has two halves on purpose. A sweep that deleted everything would pass
// "the stale one is gone" while destroying a running call; only the second half tells
// the two apart.
//
// The live agy binary is never called here: the process runner is injected, so these
// arms measure OUR contract and not Google's availability.

const NONCE = "test-nonce-not-a-real-credential";

async function scratch(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "hezarfen-config-home-"));
}

async function sourceHome(root: string): Promise<string> {
    const home = join(root, "source");
    await mkdir(join(home, ".gemini"), { recursive: true });
    for (const name of LINKED_IDENTITY_FILES) {
        await writeFile(join(home, ".gemini", name), `{"file":"${name}"}`, "utf8");
    }
    return home;
}

async function serverEntry(home: string): Promise<Record<string, { headers?: Record<string, string>; serverUrl?: string }>> {
    const raw = await readFile(join(home, ".gemini", "config", "mcp_config.json"), "utf8");
    return (JSON.parse(raw) as { mcpServers: Record<string, { headers?: Record<string, string>; serverUrl?: string }> }).mcpServers;
}

describe("antigravity call-scoped configuration home", () => {
    for (const [mode, description] of [
        ["dispose", "a locked dispose can be called again after unlock and warns safely"],
        ["sweep", "a locked orphan is kept and warned while an unlocked orphan is removed"],
        ["retry-dispose", "dispose retries a transient Windows file lock within one call"],
        ["retry-sweep", "sweep retries a transient Windows file lock within one call"],
    ] as const) {
        it(`F2: ${description}`, { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
            const root = await scratch();
            try {
                const environment: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: root };
                delete environment["NODE_TEST_CONTEXT"];
                const fixture = fileURLToPath(new URL("./fixtures/config-home-lock.js", import.meta.url));
                const result = await promisify(execFile)(process.execPath, [fixture, mode], {
                    env: environment, windowsHide: true, timeout: 55_000,
                });
                strictEqual(result.stdout.trim(), "cleanup verified");
                strictEqual(result.stderr, "");
            }
            finally {
                const contained = relative(resolve(tmpdir()), resolve(root));
                ok(contained !== "" && !contained.startsWith("..") && !isAbsolute(contained), "cleanup stays inside the scratch root");
                await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
            }
        });
    }

    for (const serverName of [undefined, "custom-claude-bridge"]) {
        it(`B01 (c): permits the configured MCP server and denies native mutations (${serverName ?? "default"})`, async () => {
            const root = await scratch();
            try {
                const home = await createEphemeralConfigHome({
                    root: join(root, "homes"), sourceHome: await sourceHome(root),
                    endpoint: { url: "http://127.0.0.1:8787/mcp", headers: {} },
                    ...(serverName === undefined ? {} : { serverName }),
                });
                const settings = JSON.parse(await readFile(join(home.path, ".gemini", "antigravity-cli", "settings.json"), "utf8")) as { permissions: { deny: string[] } };
                settings.permissions.deny.sort();
                deepStrictEqual(settings, {
                    permissions: {
                        allow: [`mcp(${serverName ?? DEFAULT_TOOL_SERVER_NAME}/*)`],
                        deny: ["browser(*)", "command(*)", "execute_url(*)", "unsandboxed(*)", "write_file(*)"],
                    },
                });
                deepStrictEqual(Object.keys(await serverEntry(home.path)), [serverName ?? DEFAULT_TOOL_SERVER_NAME]);
                // Exercise the existing bounded-file/selector gate against the generated file.
                let called = false;
                await runAntigravityHeadless({
                    binary: "agy.exe", cwd: root, home: home.path, prompt: "hello",
                    model: "gemini-3.8-flash-high", environment: {},
                    processRunner: async () => {
                        called = true;
                        return { stdout: terminalStream("ok"), stderr: "", exitCode: 0 };
                    },
                });
                ok(called, "the generated settings must pass the existing readiness gate");
                await home.dispose();
            }
            finally { await rm(root, { recursive: true, force: true }); }
        });
    }

    it("B01 (a): a bridge endpoint enforces sandbox even if allowEdits is requested", async () => {
        const root = await scratch();
        try {
            for (const allowEdits of [false, true]) {
                let called = false;
                await runAntigravityHeadless({
                    binary: "agy.exe", cwd: root, home: await sourceHome(root), prompt: "hello",
                    model: "gemini-3.8-flash-high", environment: {}, allowEdits,
                    configHomeRoot: join(root, "homes"),
                    toolEndpoint: { url: "http://127.0.0.1:8787/mcp", headers: {} },
                    processRunner: async (request) => {
                        called = true;
                        ok(request.arguments.includes("--sandbox"));
                        ok(!request.arguments.includes("--dangerously-skip-permissions"));
                        ok(!request.arguments.includes("--mode"));
                        const home = request.environment["USERPROFILE"];
                        ok(home !== undefined && home !== root);
                        const settings = JSON.parse(await readFile(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8")) as { permissions: { deny: string[] } };
                        settings.permissions.deny.sort();
                        deepStrictEqual(settings, {
                            permissions: {
                                allow: [`mcp(${DEFAULT_TOOL_SERVER_NAME}/*)`],
                                deny: ["browser(*)", "command(*)", "execute_url(*)", "unsandboxed(*)", "write_file(*)"],
                            },
                        });
                        return { stdout: terminalStream("ok"), stderr: "", exitCode: 0 };
                    },
                });
                ok(called);
            }
        }
        finally { await rm(root, { recursive: true, force: true }); }
    });

    it("B01: an endpoint without a config root cannot fall back to the operator home", async () => {
        const root = await scratch();
        try {
            let called = false;
            await rejects(runAntigravityHeadless({
                binary: "agy.exe", cwd: root, home: root, prompt: "hello",
                model: "gemini-3.8-flash-high", environment: {},
                toolEndpoint: { url: "http://127.0.0.1:8787/mcp", headers: {} },
                processRunner: async () => {
                    called = true;
                    return { stdout: terminalStream("ok"), stderr: "", exitCode: 0 };
                },
            }), /requires a call-scoped configuration root/u);
            strictEqual(called, false);
        }
        finally { await rm(root, { recursive: true, force: true }); }
    });
    it("writes the nonce into a home of ours and links identity without copying", async () => {
        const root = await scratch();
        try {
            const source = await sourceHome(root);
            const home = await createEphemeralConfigHome({
                root: join(root, "homes"),
                sourceHome: source,
                endpoint: { url: "http://127.0.0.1:8787/mcp", headers: { "x-hezarfen-oauth-session": NONCE } },
            });
            const servers = await serverEntry(home.path);
            const entry = servers[DEFAULT_TOOL_SERVER_NAME];
            ok(entry !== undefined, "our server must be the one the child will read");
            strictEqual(entry.serverUrl, "http://127.0.0.1:8787/mcp");
            strictEqual(entry.headers?.["x-hezarfen-oauth-session"], NONCE);
            strictEqual(Object.keys(servers).length, 1, "the operator's own servers must NOT be inherited");

            // A hard link shares the inode: the credential is not copied to a second place.
            const linked = await stat(join(home.path, ".gemini", "oauth_creds.json"));
            const original = await stat(join(source, ".gemini", "oauth_creds.json"));
            strictEqual(linked.ino, original.ino, "identity files must be linked, never copied");
            await home.dispose();
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("leaves the source home untouched", async () => {
        const root = await scratch();
        try {
            const source = await sourceHome(root);
            const before = await readdir(join(source, ".gemini"));
            const home = await createEphemeralConfigHome({
                root: join(root, "homes"),
                sourceHome: source,
                endpoint: { url: "http://127.0.0.1:8787/mcp", headers: { "x-hezarfen-oauth-session": NONCE } },
            });
            await home.dispose();
            const after = await readdir(join(source, ".gemini"));
            strictEqual(after.sort().join(","), before.sort().join(","), "the operator's home must gain nothing");
            ok(!after.includes("config"), "no mcp_config.json may be created in the operator's home");
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("arm (a) and (b): the nonce is present during the call and gone after it", async () => {
        const root = await scratch();
        try {
            const source = await sourceHome(root);
            let observedDuringCall: string | undefined;
            let observedHome: string | undefined;
            const result = await runAntigravityHeadless({
                binary: "agy.exe",
                cwd: root,
                prompt: "hello",
                model: "gemini-3.8-flash-high",
                home: source,
                configHomeRoot: join(root, "homes"),
                toolEndpoint: { url: "http://127.0.0.1:8787/mcp", headers: { "x-hezarfen-oauth-session": NONCE } },
                environment: { PATH: process.env["PATH"] ?? "" },
                processRunner: async (request) => {
                    observedHome = request.environment?.["USERPROFILE"];
                    ok(observedHome !== undefined, "the child must be pointed at our home");
                    strictEqual(request.environment?.["HOME"], observedHome, "both variables must agree");
                    observedDuringCall = await readFile(join(observedHome, ".gemini", "config", "mcp_config.json"), "utf8");
                    return { stdout: terminalStream("ok"), stderr: "", exitCode: 0, timedOut: false };
                },
            });
            strictEqual(result.response, "ok");
            ok(observedDuringCall?.includes(NONCE) === true, "arm (a): the nonce must be readable by the child DURING the call");
            ok(await missing(observedHome ?? ""), "arm (b): the home must be gone once the call returns");
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("arm (b) also holds when the call throws", async () => {
        const root = await scratch();
        try {
            const source = await sourceHome(root);
            let observedHome: string | undefined;
            let threw = false;
            try {
                await runAntigravityHeadless({
                    binary: "agy.exe",
                    cwd: root,
                    prompt: "hello",
                    model: "gemini-3.8-flash-high",
                    home: source,
                    configHomeRoot: join(root, "homes"),
                    toolEndpoint: { url: "http://127.0.0.1:8787/mcp", headers: { "x-hezarfen-oauth-session": NONCE } },
                    environment: { PATH: process.env["PATH"] ?? "" },
                    processRunner: async (request) => {
                        observedHome = request.environment?.["USERPROFILE"];
                        throw new Error("the provider died mid-call");
                    },
                });
            }
            catch {
                threw = true;
            }
            ok(threw, "the failure must still surface");
            ok(observedHome !== undefined, "the home must have been built before the failure");
            ok(await missing(observedHome), "a failing call must not leave the nonce on disk");
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("arm (c): the sweep removes an orphaned home and KEEPS a live one", async () => {
        const root = await scratch();
        try {
            const homes = join(root, "homes");
            const source = await sourceHome(root);
            const live = await createEphemeralConfigHome({
                root: homes,
                sourceHome: source,
                endpoint: { url: "http://127.0.0.1:8787/mcp", headers: { "x-hezarfen-oauth-session": NONCE } },
                pid: 4242,
                now: () => 1_000,
            });
            const orphan = await createEphemeralConfigHome({
                root: homes,
                sourceHome: source,
                endpoint: { url: "http://127.0.0.1:8787/mcp", headers: { "x-hezarfen-oauth-session": NONCE } },
                pid: 9999,
                now: () => 1_000,
            });
            const outcome = await sweepStaleConfigHomes({
                root: homes,
                now: () => 2_000,
                staleAfterMs: 60_000,
                isProcessAlive: (pid) => pid === 4242,
            });
            ok(outcome.removed.includes(orphan.path), "a home whose owner is dead must be removed");
            ok(outcome.kept.includes(live.path), "a home whose owner is ALIVE must survive -- otherwise the sweep destroys running calls");
            ok(await missing(orphan.path));
            ok(!(await missing(live.path)));
            await live.dispose();
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("arm (c) second cause: an owner that is alive but ancient is still swept", async () => {
        const root = await scratch();
        try {
            const homes = join(root, "homes");
            const source = await sourceHome(root);
            const ancient = await createEphemeralConfigHome({
                root: homes,
                sourceHome: source,
                endpoint: { url: "http://127.0.0.1:8787/mcp", headers: { "x-hezarfen-oauth-session": NONCE } },
                pid: 4242,
                now: () => 0,
            });
            const outcome = await sweepStaleConfigHomes({
                root: homes,
                now: () => 10 * 60 * 60 * 1000,
                isProcessAlive: () => true,
            });
            ok(outcome.removed.includes(ancient.path), "a recycled PID must not keep a nonce alive forever");
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("B01 (d): without an endpoint no agy permission settings are written", async () => {
        const root = await scratch();
        try {
            const source = await sourceHome(root);
            const home = await createEphemeralConfigHome({ root: join(root, "homes"), sourceHome: source });
            const servers = await serverEntry(home.path);
            strictEqual(Object.keys(servers).length, 0);
            ok(await missing(join(home.path, ".gemini", "antigravity-cli", "settings.json")));
            await home.dispose();
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

async function missing(path: string): Promise<boolean> {
    try {
        await stat(path);
        return false;
    }
    catch {
        return true;
    }
}

function terminalStream(text: string): string {
    return `${JSON.stringify({ event: "result", result: { status: "success", response: text } })}\n`;
}
