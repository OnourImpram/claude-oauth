import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ReadOnlyGrokClient } from "../src/grok/acp-bridge.js";
import type { SafeLogEntry } from "../src/runtime/log.js";

// Measured 2026-09-14: grok read files through fs/read_text_file for two whole turns and the
// router log showed nothing, so the turns read as "grok did nothing". A native read and a
// native tool call must each leave one record, carrying no content and no command.
it("files grok's native reads and tool calls in the log, never their content (2026-09-14)", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-native-"));
    try {
        const body = "line one\nline two\nsecret-looking line three\n";
        await writeFile(join(workspace, "notes.md"), body, "utf8");
        const entries: SafeLogEntry[] = [];
        const client = new ReadOnlyGrokClient(workspace, (entry) => entries.push(entry));

        const read = await client.readTextFile({ sessionId: "s", path: join(workspace, "notes.md"), line: 1, limit: 2 });
        strictEqual(read.content, "line one\nline two\n");
        await client.sessionUpdate({
            sessionId: "s",
            update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run: cat notes.md", kind: "execute", status: "pending" },
        });
        await client.sessionUpdate({
            sessionId: "s",
            update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
        });
        await client.sessionUpdate({
            sessionId: "s",
            update: {
                sessionUpdate: "tool_call", toolCallId: "t2", title: "Read notes.md", kind: "other", status: "pending",
                rawInput: { variant: "UseTool", tool_name: "read_file", path: "notes.md" },
                _meta: { "x.ai/tool": { version: 1, name: "read_file", kind: "read_file", namespace: "grok_build", read_only: true } },
            },
        });
        await client.sessionUpdate({
            sessionId: "s",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
        });

        deepStrictEqual(entries.map((entry) => entry.event), ["agent_native_read", "agent_native_tool_call", "agent_native_tool_call"]);
        const [readEntry, callEntry] = entries;
        strictEqual(readEntry?.code, "notes.md");
        strictEqual(readEntry?.contentBytes, Buffer.byteLength("line one\nline two\n", "utf8"));
        strictEqual(callEntry?.code, "execute");
        strictEqual(entries[2]?.code, "read_file", "xAI descriptor name outranks the generic ACP kind");
        const serialized = JSON.stringify(entries);
        ok(!serialized.includes("secret-looking"), "file content must not reach the log");
        ok(!serialized.includes("cat notes.md"), "a tool call's title (the command) must not reach the log");
        ok(!serialized.includes("Read notes.md") && !serialized.includes("UseTool"), "neither title nor rawInput reaches the log");
        strictEqual(client.text(), "done");
    }
    finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
