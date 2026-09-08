// Offline ACP peer, launched as node <scratch>/agent by the real Grok bridge.
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let servers;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
        send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] } });
    } else if (message.method === "session/new") {
        servers = message.params.mcpServers;
        send({ id: message.id, result: { sessionId: "shape-fixture" } });
    } else if (message.method === "session/prompt") {
        send({ method: "session/update", params: { sessionId: "shape-fixture", update: {
            sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(servers) },
        } } });
        send({ id: message.id, result: { stopReason: "end_turn" } });
    }
});
