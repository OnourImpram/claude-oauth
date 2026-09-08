import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ModelRegistry } from "../src/domain/registry.js";
import {
    mcpHttpServer, runGrokAcp, startGrokAcpSession, type GrokAcpOptions, type GrokAcpSession,
} from "../src/grok/acp-bridge.js";
import { AgentSessionRegistry } from "../src/mcp/session-registry.js";
import { deriveMcpTools } from "../src/mcp/tool-bridge.js";
import { startRouterServer, type RunningRouter } from "../src/router/server.js";
import { ReceiptStore } from "../src/runtime/receipt-store.js";
import { SESSION_HEADER } from "../src/security/nonce.js";

interface RpcReply {
    readonly result?: { readonly outcome: { readonly outcome: string; readonly optionId?: string } };
    readonly error?: { readonly code: number };
}
interface Journal {
    readonly environmentPermission: string;
    readonly capabilities: { readonly fs: { readonly readTextFile: boolean; readonly writeTextFile: boolean }; readonly terminal?: boolean };
    readonly beforePermission: RpcReply;
    readonly permission: RpcReply;
    readonly afterPermission: RpcReply;
    readonly terminal: RpcReply;
    readonly afterMcpDenial?: RpcReply;
    readonly mcpDeniedPermissions?: readonly RpcReply[];
    readonly mcpPermission?: RpcReply;
    readonly mcpInitialize?: { readonly status: number; readonly body: { readonly result: { readonly protocolVersion: string } } };
    readonly mcpList?: { readonly status: number; readonly body: { readonly result: { readonly tools: readonly { readonly name: string }[] } } };
    readonly mcpCall?: { readonly status: number; readonly body: { readonly result: { readonly isError: boolean; readonly content: readonly { readonly text: string }[] } } };
}

async function fixture(): Promise<{ root: string; options: GrokAcpOptions }> {
    const root = await mkdtemp(join(tmpdir(), "grok-permission-"));
    await mkdir(join(root, ".git"));
    await copyFile(new URL("../../test/fixtures/grok-permission-provider.cjs", import.meta.url), join(root, "agent"));
    return {
        root,
        options: {
            binary: process.execPath, cwd: root, home: join(root, "grok-home"),
            task: "reject-once", model: "grok-4.6", signal: AbortSignal.timeout(10_000),
            environment: { HOME: root, USERPROFILE: root, TEMP: root, TMP: root },
        },
    };
}

async function assertLocalToolsDenied(root: string, journal: Journal): Promise<void> {
    strictEqual(journal.environmentPermission, "reject", "the process must not default to allowing local tools");
    strictEqual(journal.capabilities.fs.writeTextFile, false, "ACP must advertise no local write capability");
    strictEqual(journal.capabilities.fs.readTextFile, true);
    strictEqual(journal.capabilities.terminal === true, false);
    strictEqual(journal.beforePermission.error?.code, -32601, "unsolicited writes must have no handler");
    strictEqual(journal.afterPermission.error?.code, -32601, "a permission decision must not open a write handler");
    strictEqual(journal.terminal.error?.code, -32601, "local terminal execution must have no handler");
    for (const name of ["before-permission.txt", "after-permission.txt", "mcp-write.txt", "after-mcp-denial.txt"]) {
        await rejects(access(join(root, name)), { code: "ENOENT" }, name);
    }
}

for (const mode of ["reject-once", "reject-always", "allow-only"] as const) {
    it(`B01 xAI (e): the interactive session rejects local tools with ${mode} options`, async () => {
        const { root, options } = await fixture();
        const session = startGrokAcpSession({ ...options, task: mode, bridgedToolNames: ["Write"] });
        try {
            await session.done;
            const journal = JSON.parse(session.text()) as Journal;
            deepStrictEqual(journal.permission.result?.outcome, mode === "allow-only"
                ? { outcome: "cancelled" }
                : { outcome: "selected", optionId: "fixture-reject" });
            await assertLocalToolsDenied(root, journal);
        } finally {
            session.cancel("test teardown");
            await session.done.catch(() => undefined);
            await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        }
    });
}

it("B01 xAI: one-shot delegation retains its local-tool denial", async () => {
    const { root, options } = await fixture();
    try {
        const result = await runGrokAcp(options);
        const journal = JSON.parse(result.text) as Journal;
        deepStrictEqual(journal.permission.result?.outcome, { outcome: "selected", optionId: "fixture-reject" });
        await assertLocalToolsDenied(root, journal);
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
});

it("B01 xAI (f): after local denial the real MCP route parks and resumes with Claude Code's denial", async () => {
    const { root, options } = await fixture();
    const nonce = "x".repeat(43);
    let router: RunningRouter | undefined;
    let session: GrokAcpSession | undefined;
    const sessions = new AgentSessionRegistry({
        mcpBaseUrl: () => {
            ok(router);
            return router.baseUrl;
        },
        mcpHeaders: () => ({ [SESSION_HEADER]: nonce }),
        startAgent: (request) => {
            session = startGrokAcpSession({
                ...options,
                task: request.prompt,
                mcpServers: [mcpHttpServer("claude-code-tools", request.mcpUrl, request.mcpHeaders)],
                bridgedToolNames: request.bridge.tools.map((tool) => tool.name),
            });
            return session;
        },
    });
    try {
        router = await startRouterServer({
            nonce,
            registry: new ModelRegistry({
                schemaVersion: 1, generatedAt: "2026-09-08T00:00:00.000Z",
                source: "pinned-install-baseline", models: [],
            }, new Map()),
            receipts: new ReceiptStore(join(root, "receipts.jsonl")),
            mcpBridge: (key) => sessions.bridgeFor(key),
        });
        const first = await sessions.begin("reject-once", deriveMcpTools([{ name: "Write" }]), options.model, options.signal);
        strictEqual(first.outcome.kind, "tool_use");
        ok(first.outcome.kind === "tool_use");
        strictEqual(first.outcome.call.name, "Write");
        deepStrictEqual(first.outcome.call.input, { file_path: join(root, "mcp-write.txt"), content: "bridge marker" });
        strictEqual(sessions.bridgeFor(first.sessionKey)?.pendingCount, 1);
        strictEqual(sessions.liveSessionCount, 1);
        await rejects(access(join(root, "mcp-write.txt")), { code: "ENOENT" });

        const second = await sessions.resume([{
            toolUseId: first.outcome.call.id, content: "Claude Code denied Write", isError: true,
        }], options.signal);
        strictEqual(second.outcome.kind, "end_turn");
        const journal = JSON.parse(second.outcome.text) as Journal;
        deepStrictEqual(journal.permission.result?.outcome, { outcome: "selected", optionId: "fixture-reject" });
        await assertLocalToolsDenied(root, journal);
        strictEqual(journal.mcpDeniedPermissions?.length, 11);
        for (const denied of journal.mcpDeniedPermissions ?? []) {
            deepStrictEqual(denied.result?.outcome, { outcome: "selected", optionId: "fixture-reject" });
        }
        deepStrictEqual(journal.mcpPermission?.result?.outcome, { outcome: "selected", optionId: "fixture-mcp-once" });
        strictEqual(journal.afterMcpDenial?.error?.code, -32601);
        strictEqual(journal.mcpInitialize?.status, 200);
        strictEqual(journal.mcpInitialize?.body.result.protocolVersion, "2025-06-18");
        strictEqual(journal.mcpList?.status, 200);
        deepStrictEqual(journal.mcpList?.body.result.tools.map((tool) => tool.name), ["Write"]);
        strictEqual(journal.mcpCall?.status, 200);
        strictEqual(journal.mcpCall?.body.result.isError, true);
        strictEqual(journal.mcpCall?.body.result.content[0]?.text, "Claude Code denied Write");
        strictEqual(sessions.liveSessionCount, 0);
        strictEqual(sessions.unmatchedResultCount, 0);
    } finally {
        session?.cancel("test teardown");
        await session?.done.catch(() => undefined);
        await router?.close();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
});

it("B01 xAI: a matching MCP request cannot select a persistent allow option", async () => {
    const { root, options } = await fixture();
    const session = startGrokAcpSession({
        ...options, task: "allow-always-only", bridgedToolNames: ["Write"],
        mcpServers: [mcpHttpServer("claude-code-tools", "http://127.0.0.1:1/not-contacted", {})],
    });
    try {
        await session.done;
        const journal = JSON.parse(session.text()) as Journal;
        await assertLocalToolsDenied(root, journal);
        deepStrictEqual(journal.mcpPermission?.result?.outcome, { outcome: "selected", optionId: "fixture-reject" });
        strictEqual(journal.mcpCall, undefined);
    } finally {
        session.cancel("test teardown");
        await session.done.catch(() => undefined);
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
});
