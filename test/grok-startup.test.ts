import { strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { runCaptured } from "../src/runtime/child-process.js";

for (const mode of ["one-shot", "session"] as const) {
    it(`a missing Grok binary returns adapter_unavailable in ${mode} mode without crashing`, async () => {
        const root = await mkdtemp(join(tmpdir(), "grok-startup-"));
        try {
            await mkdir(join(root, ".git"));
            const moduleUrl = new URL("../src/grok/acp-bridge.js", import.meta.url).href;
            // An isolated process makes an unhandled ChildProcess error observable without
            // letting it abort the test runner. No installed provider is launched.
            const script = `
                import { runGrokAcp, startGrokAcpSession } from ${JSON.stringify(moduleUrl)};
                const options = ${JSON.stringify({
                    binary: join(root, "missing-provider.exe"),
                    home: join(root, "home"), cwd: root, task: "test", model: "test", environment: {},
                })};
                try {
                    ${mode === "one-shot" ? "await runGrokAcp(options)" : "await startGrokAcpSession(options).done"};
                    process.stdout.write("unexpected success");
                } catch (error) {
                    process.stdout.write(error.code ?? "unclassified");
                }
            `;
            const result = await runCaptured(process.execPath, ["--input-type=module", "-e", script], {
                cwd: root, environment: {}, timeoutMs: 5_000,
            });
            strictEqual(result.exitCode, 0);
            strictEqual(result.stdout, "adapter_unavailable");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}
