import { deepStrictEqual, ok } from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { it } from "node:test";
import type { McpServerHttp } from "@agentclientprotocol/sdk";
import { mcpHttpServer, startGrokAcpSession } from "../src/grok/acp-bridge.js";
import { SESSION_HEADER } from "../src/security/nonce.js";

it("G08: real bridge sends the installed SDK McpServerHttp shape to an offline ACP peer", async () => {
    const schema = createRequire(import.meta.url)("@agentclientprotocol/sdk/schema/schema.json") as {
        $defs: { McpServerHttp: { required: string[]; properties: { headers: { type: string } } }; HttpHeader: { required: string[] } };
    };
    deepStrictEqual([...schema.$defs.McpServerHttp.required].sort(), ["headers", "name", "url"]);
    deepStrictEqual([...schema.$defs.HttpHeader.required].sort(), ["name", "value"]);
    deepStrictEqual(schema.$defs.McpServerHttp.properties.headers.type, "array");
    // This assignment is a compile-time regression test against the pinned SDK.
    const definition: McpServerHttp & { type: "http" } = mcpHttpServer(
        "claude-code-tools", "http://127.0.0.1:65000/mcp/shape-fixture", { [SESSION_HEADER]: "offline-fixture" },
    );
    const root = await mkdtemp(join(tmpdir(), "co-a-grok-shape-"));
    try {
        await mkdir(join(root, ".git"));
        await copyFile(new URL("../../test/fixtures/grok-mcp-shape.cjs", import.meta.url), join(root, "agent"));
        const session = startGrokAcpSession({
            binary: process.execPath, home: join(root, "home"), cwd: root, task: "echo shape", model: "grok-4.6",
            environment: { HOME: root, USERPROFILE: root, TEMP: root, TMP: root },
            signal: AbortSignal.timeout(5_000), mcpServers: [definition],
        });
        try {
            await session.done;
            deepStrictEqual(JSON.parse(session.text()), [{
                type: "http", name: "claude-code-tools", url: "http://127.0.0.1:65000/mcp/shape-fixture",
                headers: [{ name: SESSION_HEADER, value: "offline-fixture" }],
            }]);
        } finally { session.cancel("test cleanup"); await session.done.catch(() => undefined); }
    } finally {
        ok(!relative(resolve(tmpdir()), resolve(root)).startsWith(".."));
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
});
