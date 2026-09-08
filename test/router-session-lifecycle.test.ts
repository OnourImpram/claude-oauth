import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runAntigravityHeadless, runAntigravityProcess } from "../src/antigravity/headless-bridge.js";
import type { ModelSnapshot } from "../src/domain/contracts.js";
import { AGENT_MODEL_CONTRACTS } from "../src/domain/model-contracts.js";
import { AgentSessionRegistry, type AgentRunHandle } from "../src/mcp/session-registry.js";
import { deriveMcpTools } from "../src/mcp/tool-bridge.js";
import { runtimePaths } from "../src/runtime/paths.js";
import { routerSessionLifecycle } from "../src/supervisor/launcher.js";
import { startProviderSet } from "../src/supervisor/provider-set.js";

it("router shutdown closes four Google sessions and waits for children and homes", { timeout: 15_000 }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "router-session-close-"));
    const homes = join(scratch, "homes");
    const children: number[] = [];
    const handles: AgentRunHandle[] = [];
    const pending: Promise<unknown>[] = [];
    const contract = AGENT_MODEL_CONTRACTS.find((entry) => entry.provider === "google");
    ok(contract);
    const googleSessions = new AgentSessionRegistry({
        mcpBaseUrl: "http://127.0.0.1:1",
        startAgent: ({ bridge }) => {
            const controller = new AbortController();
            const done = runAntigravityHeadless({
                binary: process.execPath, cwd: scratch, home: join(scratch, "source"),
                prompt: "fixture", model: contract.upstreamModel, environment: {}, timeoutMs: 10_000,
                configHomeRoot: homes, toolEndpoint: { url: "http://127.0.0.1:1/mcp", headers: {} }, signal: controller.signal,
                processRunner: async (request) => {
                    // Substitute only the executable arguments; run the real OS runner,
                    // abort handling and headless configuration-home finalizer.
                    const run = runAntigravityProcess({ ...request,
                        arguments: [fileURLToPath(new URL("./fixtures/lifecycle-agent.js", import.meta.url))],
                    });
                    void run.catch(() => undefined);
                    const ready = join(request.environment["USERPROFILE"] as string, "fixture-child.json");
                    for (let attempt = 0; ; attempt += 1) {
                        const metadata = await readFile(ready, "utf8").catch(() => undefined);
                        if (metadata !== undefined) {
                            children.push((JSON.parse(metadata) as { pid: number }).pid);
                            break;
                        }
                        if (attempt === 500) {
                            controller.abort();
                            await run.catch(() => undefined);
                            throw new Error("Fixture child did not become ready");
                        }
                        await delay(10);
                    }
                    pending.push(bridge.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Read" } }));
                    return await run;
                },
            }).then(() => undefined);
            const handle = { done, text: () => "", cancel: (): void => { controller.abort(); } };
            handles.push(handle);
            return handle;
        },
    });
    const grokSessions = new AgentSessionRegistry({ mcpBaseUrl: "http://127.0.0.1:1", startAgent: () => { throw new Error("Unused lane"); } });
    const snapshot: ModelSnapshot = {
        schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", source: "lifecycle-fixture",
        models: [{ ...contract, executionMode: "agent-readonly", discoverable: true, capabilities: ["messages", "streaming"] }],
    };
    const providers = await startProviderSet(snapshot, runtimePaths({ LOCALAPPDATA: scratch }), "", {
        cwd: scratch, environment: {}, antigravityBinary: "unused", grokBinary: "unused", grokSessions, googleSessions,
    });
    try {
        strictEqual(providers.adapters.has("google"), true);
        for (let index = 0; index < 4; index += 1)
            strictEqual((await googleSessions.begin("fixture", deriveMcpTools([{ name: "Read" }]))).outcome.kind, "tool_use");
        const state = async (): Promise<{ live: number; children: number; homes: number }> => ({
            live: googleSessions.liveSessionCount,
            children: children.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }).length,
            homes: (await readdir(homes)).length,
        });
        deepStrictEqual(await state(), { live: 4, children: 4, homes: 4 });
        await routerSessionLifecycle(grokSessions, googleSessions).close();
        await providers.close();
        // No extra run.done wait here: that is the production shutdown contract itself.
        deepStrictEqual(await state(), { live: 0, children: 0, homes: 0 });
    } finally {
        for (const handle of handles) handle.cancel("test teardown");
        await Promise.allSettled(handles.map((handle) => handle.done));
        googleSessions.closeAll("test teardown");
        await Promise.allSettled(pending);
        await providers.close();
        const childPath = relative(resolve(tmpdir()), resolve(scratch));
        ok(childPath.startsWith("router-session-close-") && !isAbsolute(childPath) && !childPath.startsWith(".."));
        await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
});

it("shutdown waits for retired run cleanup, handles rejection and refuses new sessions", async () => {
    let finish = (): void => undefined;
    const done = new Promise<void>((_resolve, reject) => { finish = () => { reject(new Error("Cancelled fixture")); }; });
    const registry = new AgentSessionRegistry({
        mcpBaseUrl: "http://127.0.0.1:1",
        startAgent: ({ bridge }) => {
            void bridge.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Read" } });
            return { done, text: () => "", cancel: () => undefined };
        },
    });
    await registry.begin("fixture", deriveMcpTools([{ name: "Read" }]));
    registry.closeAll("retire before cleanup finishes");
    strictEqual(registry.liveSessionCount, 0);
    let closed = false;
    const closing = registry.closeAllAndWait("router shutdown").then(() => { closed = true; });
    try {
        await new Promise<void>((settle) => setImmediate(settle));
        strictEqual(closed, false, "shutdown must wait for done even after closeAll retired the session");
        await rejects(registry.begin("new request", []), { status: 503 });
    } finally {
        finish();
        await closing;
    }
    strictEqual(closed, true);
    await registry.closeAllAndWait("idempotent shutdown");
});
