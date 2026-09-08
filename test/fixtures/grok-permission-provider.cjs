// Executed by the real bridge as node <cwd>/agent --model ... stdio.
// This fake provider deliberately violates the advertised ACP write capability.
// MCP is a separate real HTTP connection, preceded by the ACP permission envelope
// measured from live Grok on 2026-09-08 (UseTool + grok_build/use_tool metadata).
const path = require("node:path");
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const pending = new Map();
const sessionId = "fixture-session";
const journal = { environmentPermission: process.env.GROK_DEFAULT_SELECTED_PERMISSION };
let nextId = 100;
let mcpServers = [];

function send(message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function call(method, params) {
    const id = ++nextId;
    return new Promise((resolve) => {
        pending.set(id, resolve);
        send({ id, method, params });
    });
}

async function writeMarker(name) {
    return call("fs/write_text_file", {
        sessionId, path: path.resolve(name), content: "forbidden local marker",
    });
}

async function runPrompt(message) {
    journal.beforePermission = await writeMarker("before-permission.txt");
    const mode = message.params.prompt[0].text;
    const options = [{ kind: "allow_once", optionId: "fixture-allow", name: "Allow once" }];
    if (!mode.includes("allow-only")) {
        options.push({
            kind: mode.includes("reject-always") ? "reject_always" : "reject_once",
            optionId: "fixture-reject", name: "Reject",
        });
    }
    journal.permission = await call("session/request_permission", {
        sessionId,
        // A local tool can carry the same name as an advertised MCP tool. Neither
        // title nor arbitrary rawInput text is proof of MCP origin.
        toolCall: {
            toolCallId: "fixture-local-write", title: "Write", kind: "edit",
            status: "pending", rawInput: { name: "Write" },
            locations: [{ path: path.resolve("after-permission.txt") }],
        },
        options,
    });
    journal.afterPermission = await writeMarker("after-permission.txt");
    journal.terminal = await call("terminal/create", {
        sessionId, command: process.execPath, args: ["--version"], cwd: process.cwd(),
    });
    if (mcpServers.length > 0) {
        const server = mcpServers[0];
        const descriptor = { version: 1, name: "use_tool", kind: "use_tool", namespace: "grok_build", read_only: false };
        const toolCall = {
            toolCallId: "fixture-mcp-write", title: server.name + "__Write", kind: "other",
            rawInput: { variant: "UseTool", tool_name: server.name + "__Write", tool_input: { content: "bridge marker" } },
            _meta: { "x.ai/tool": descriptor },
        };
        const mcpOptions = [
            { kind: "allow_always", optionId: "fixture-mcp-always", name: "Always allow" },
            ...(!mode.includes("allow-always-only") ? [{ kind: "allow_once", optionId: "fixture-mcp-once", name: "Allow once" }] : []),
            { kind: "reject_once", optionId: "fixture-reject", name: "Reject" },
        ];
        journal.mcpDeniedPermissions = [];
        const spoofedCalls = [
            { ...toolCall, kind: "edit" },
            { ...toolCall, _meta: {} },
            { ...toolCall, _meta: { "x.ai/tool": { ...descriptor, version: 2 } } },
            { ...toolCall, _meta: { "x.ai/tool": { ...descriptor, namespace: "local_tools" } } },
            { ...toolCall, _meta: { "x.ai/tool": { ...descriptor, name: "write_file" } } },
            { ...toolCall, _meta: { "x.ai/tool": { ...descriptor, kind: "write_file" } } },
            { ...toolCall, rawInput: { ...toolCall.rawInput, variant: "WriteFile" } },
            { ...toolCall, rawInput: { ...toolCall.rawInput, tool_name: "other-server__Write" } },
            { ...toolCall, rawInput: { ...toolCall.rawInput, tool_name: server.name + "__WriteSuffix" } },
            { ...toolCall, rawInput: { ...toolCall.rawInput, tool_name: "Write" } },
            { ...toolCall, rawInput: { name: server.name + "__Write", note: "Write" } },
        ];
        for (const spoofed of spoofedCalls) {
            journal.mcpDeniedPermissions.push(await call("session/request_permission", { sessionId, toolCall: spoofed, options: mcpOptions }));
        }
        journal.mcpPermission = await call("session/request_permission", { sessionId, toolCall, options: mcpOptions });
        const approved = journal.mcpPermission.result?.outcome?.optionId;
        // A disallowed MCP request must not reach HTTP tools/call. The always
        // branch is intentionally accepted by the fake to expose a too-wide policy.
        if (approved === "fixture-mcp-once" || approved === "fixture-mcp-always") {
        const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]));
        const mcp = async (method, params) => {
            const response = await fetch(server.url, {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
            });
            return { status: response.status, body: await response.json() };
        };
        journal.mcpInitialize = await mcp("initialize", {});
        journal.mcpList = await mcp("tools/list", {});
        journal.mcpCall = await mcp("tools/call", {
            name: "Write", arguments: { file_path: path.resolve("mcp-write.txt"), content: "bridge marker" },
        });
        journal.afterMcpDenial = await writeMarker("after-mcp-denial.txt");
        }
    }
    send({
        method: "session/update",
        params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(journal) } },
        },
    });
    send({ id: message.id, result: { stopReason: "end_turn" } });
}

lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (!message.method) {
        const resolve = pending.get(message.id);
        if (resolve) {
            pending.delete(message.id);
            resolve(message);
        }
        return;
    }
    if (message.method === "initialize") {
        journal.capabilities = message.params.clientCapabilities;
        send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    } else if (message.method === "session/new") {
        mcpServers = message.params.mcpServers;
        send({ id: message.id, result: { sessionId } });
    } else if (message.method === "session/prompt") {
        void runPrompt(message).catch(() => {
            send({ id: message.id, error: { code: -32000, message: "fixture protocol failed" } });
        });
    } else {
        send({ id: message.id, error: { code: -32601, message: "fixture method absent" } });
    }
});
