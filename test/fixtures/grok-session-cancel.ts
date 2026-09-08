import { ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { mock } from "node:test";
import { RouterError } from "../../src/domain/errors.js";

const root = process.env["LOCALAPPDATA"];
const mode = process.argv[2];
ok(root !== undefined);
ok(mode === "cancel" || mode === "abort" || mode === "active");
let spawns = 0;
const spawnReached = new Error("Fixture spawn reached");
const childModule = mock.module("node:child_process", { namedExports: {
    spawn: () => { spawns += 1; throw spawnReached; },
} });
try {
    const { startGrokAcpSession } = await import("../../src/grok/acp-bridge.js");
    const controller = new AbortController();
    const run = startGrokAcpSession({
        binary: "unused", home: join(root, "home"), cwd: root, task: "fixture", model: "fixture",
        environment: {}, signal: controller.signal,
    });
    if (mode === "cancel") run.cancel("cancel during preparation");
    if (mode === "abort") controller.abort();
    const failure = await run.done.then(() => undefined, (error: unknown) => error);
    strictEqual(spawns, mode === "active" ? 1 : 0, "cancelled preparation must not create a provider process");
    if (mode === "active") strictEqual(failure, spawnReached);
    else {
        ok(failure instanceof RouterError);
        strictEqual(failure.code, "upstream_timeout");
    }
} finally {
    childModule.restore();
}
