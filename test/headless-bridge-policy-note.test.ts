import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGED_TOOL_POLICY_NOTE, processInput, runAntigravityHeadless } from "../src/antigravity/headless-bridge.js";

// B07 (2026-09-08): on the bridged lane the model's native tools are denied; the prompt says so
// once, so the model has a reason to pick the bridged tools. Positive arm: with a tool endpoint the
// process input carries the note ahead of the prompt. Negative arm: without an endpoint (the legacy
// delegate lane) the prompt travels untouched.
describe("B07 bridged tool policy note", () => {
    it("processInput prepends the note only when bridged", () => {
        const plain = JSON.parse(processInput("hello")) as { message: { content: string } };
        strictEqual(plain.message.content, "hello");
        const bridged = JSON.parse(processInput("hello", true)) as { message: { content: string } };
        ok(bridged.message.content.startsWith(BRIDGED_TOOL_POLICY_NOTE), "the note leads");
        ok(bridged.message.content.endsWith("\n\nhello"), "the prompt follows, unchanged");
        ok(BRIDGED_TOOL_POLICY_NOTE.includes("hezarfen-claude-code-tools"), "the note names the bridge server");
    });
    it("the bridged lane sends the note, the legacy lane does not", async () => {
        const root = await mkdtemp(join(tmpdir(), "b07-note-"));
        try {
            const home = join(root, "home");
            await mkdir(join(home, ".gemini"), { recursive: true });
            await writeFile(join(home, ".gemini", "settings.json"), "{}\n");
            const seen: string[] = [];
            const run = async (bridged: boolean): Promise<void> => {
                await runAntigravityHeadless({
                    binary: "agy.exe", cwd: root, home, prompt: "hello", model: "gemini-3.8-flash-high", environment: {},
                    ...(bridged ? { configHomeRoot: join(root, "homes"), toolEndpoint: { url: "http://127.0.0.1:8787/mcp", headers: {} } } : {}),
                    processRunner: async (request) => {
                        seen.push((JSON.parse(request.input) as { message: { content: string } }).message.content);
                        return { stdout: `${JSON.stringify({ event: "result", result: { status: "success", response: "ok" } })}\n`, stderr: "", exitCode: 0 };
                    },
                });
            };
            await run(true);
            await run(false);
            strictEqual(seen.length, 2);
            ok(seen[0]?.startsWith(BRIDGED_TOOL_POLICY_NOTE), "bridged lane carries the note");
            strictEqual(seen[1], "hello", "legacy lane prompt is untouched");
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
