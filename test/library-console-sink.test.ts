import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { routeConsoleToLog, type SafeLogEntry } from "../src/runtime/log.js";

describe("routeConsoleToLog", () => {
    it("files library console output instead of writing it to the terminal", () => {
        const entries: SafeLogEntry[] = [];
        let stderrBytes = 0;
        const originalWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: string | Uint8Array) => { stderrBytes += chunk.length; return true; }) as typeof process.stderr.write;
        const restore = routeConsoleToLog((entry) => entries.push(entry));
        try {
            // The exact call the ACP SDK makes when grok answers with an invented id.
            console.error("Got response to unknown request", "skills-reload");
            console.warn({ nested: true });
            console.log("plain", 3);
        }
        finally {
            restore();
            process.stderr.write = originalWrite;
        }
        strictEqual(stderrBytes, 0, "nothing may reach the terminal");
        deepStrictEqual(entries.map((entry) => [entry.event, entry.level, entry.code]), [
            ["library_console", "warn", "Got response to unknown request skills-reload"],
            ["library_console", "warn", '{"nested":true}'],
            ["library_console", "info", "plain 3"],
        ]);
    });

    it("restores the original console after the returned function runs", () => {
        const before = console.error;
        const restore = routeConsoleToLog(() => undefined);
        strictEqual(console.error === before, false);
        restore();
        strictEqual(console.error, before);
    });
});
