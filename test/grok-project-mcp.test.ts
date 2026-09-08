import { ok, rejects, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { it } from "node:test";
import { prepareGrokProcessEnvironment } from "../src/grok/acp-bridge.js";

for (const nested of [false, true]) {
    it(`G02: project .mcp.json refusal names the file and remedy, nested=${nested}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "co-a-project-mcp-"));
        try {
            await mkdir(join(root, ".git"));
            await mkdir(join(root, "child"));
            await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { test: { command: "never-start" } } }));
            await rejects(prepareGrokProcessEnvironment({ home: join(root, "home"), cwd: nested ? join(root, "child") : root, environment: {} }),
                (error: unknown) => {
                    const failure = error as { code: string; status: number; message: string };
                    strictEqual(failure.code, "adapter_unavailable");
                    strictEqual(failure.status, 503);
                    ok(failure.message.includes(".mcp.json"));
                    ok(failure.message.includes("FIX:"));
                    ok(failure.message.includes("workspace"));
                    return true;
                });
        } finally {
            ok(!relative(resolve(tmpdir()), resolve(root)).startsWith(".."));
            await rm(root, { recursive: true, force: true });
        }
    });
}

for (const entry of ["hooks", "plugins"]) {
    it(`G02: .grok/${entry} remains fail-closed`, async () => {
        const root = await mkdtemp(join(tmpdir(), "co-a-project-extension-"));
        try {
            await mkdir(join(root, ".git"));
            await mkdir(join(root, ".grok", entry), { recursive: true });
            await writeFile(join(root, ".grok", entry, "fixture.txt"), "non-empty");
            await rejects(prepareGrokProcessEnvironment({ home: join(root, "home"), cwd: root, environment: {} }), /executable extension paths/u);
        } finally {
            ok(!relative(resolve(tmpdir()), resolve(root)).startsWith(".."));
            await rm(root, { recursive: true, force: true });
        }
    });
}
