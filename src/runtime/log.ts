import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export type LogLevel = "info" | "warn" | "error";
export interface SafeLogEntry {
    readonly event: string;
    readonly level: LogLevel;
    readonly requestId?: string;
    readonly provider?: string;
    readonly code?: string;
    readonly durationMs?: number;
    readonly route?: "hello" | "models" | "messages" | "count_tokens" | "mcp" | "other";
    readonly method?: "GET" | "POST" | "HEAD" | "OTHER";
    readonly pathFingerprint?: string;
    readonly messageRoles?: readonly string[];
    readonly messageBlockTypes?: readonly (readonly string[])[];
    readonly toolUseCount?: number;
    readonly toolResultCount?: number;
    readonly unmatchedToolResultCount?: number;
    readonly upstreamErrorBytes?: number;
    readonly upstreamErrorFingerprint?: string;
    readonly upstreamErrorKeys?: readonly string[];
    readonly upstreamErrorHints?: readonly string[];
    readonly upstreamRequestBytes?: number;
    readonly toolDefinitionCount?: number;
    readonly removedUnicodeSchemaPatterns?: number;
    readonly exitCode?: number;
    readonly patchOutputBytes?: number;
    readonly patchOutputFingerprint?: string;
    readonly remedy?: string;
    readonly errorName?: string;
    readonly stackFrames?: readonly string[];
    readonly requestedModel?: string;
    readonly authChannels?: readonly string[];
    readonly contentBlockType?: string;
    readonly contentMediaType?: string;
    readonly contentBytes?: number;
}
// The router runs as the supervisor of an interactive TUI, and anything written to stderr
// lands in the middle of that TUI -- measured: warn-level lines appeared inside the
// operator's prompt area and made the session look broken. Diagnostics therefore go to a
// file, and only "error" stays on stderr, where a failure the operator must see belongs.
//
// A log nobody can find is as bad as one that shouts, so the path is fixed and printable:
// <runtime root>/router.log.
function logFilePath(): string {
    const base = process.env["LOCALAPPDATA"] ?? join(homedir(), ".local", "share");
    return join(base, "Hezarfen", "claude-oauth", "router.log");
}

export function writeSafeLog(entry: SafeLogEntry): void {
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`;
    if (entry.level === "error")
        process.stderr.write(line);
    // Measured right after the sink moved to a file: test runs began appending to the
    // operator's own router.log. A diagnostic log polluted by test fixtures stops being
    // readable as a record of what the running system did. node:test sets this variable
    // in its child processes itself, so no extra wiring is needed.
    if (process.env["NODE_TEST_CONTEXT"] !== undefined)
        return;
    try {
        appendFileSync(logFilePath(), line, { encoding: "utf8", mode: 0o600 });
    }
    catch {
        // The log file is a convenience, never a dependency: a router that cannot write its
        // diagnostics must still route. Errors already reached stderr above.
    }
}

/**
 * Sends every `console.*` call made inside the router process to the file sink instead of
 * the terminal. The router's own diagnostics learned this in writeSafeLog; third-party code
 * did not: measured 2026-09-14, grok 1.0.30 answers with a JSON-RPC id it invented
 * ("skills-reload", "workflows-reload") and the ACP SDK's console.error("Got response to
 * unknown request", id) landed on the bottom line of the operator's Claude Code TUI. The
 * text is kept, truncated, under event `library_console`; nothing is dropped, nothing is
 * shouted. Returns a restore function for tests.
 */
export function routeConsoleToLog(sink: (entry: SafeLogEntry) => void = writeSafeLog): () => void {
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const forward = (level: LogLevel) => (...args: unknown[]): void => {
        const text = args.map((arg) => (typeof arg === "string" ? arg : safeStringify(arg))).join(" ");
        sink({ event: "library_console", level, code: text.slice(0, 300) });
    };
    console.log = forward("info");
    console.info = forward("info");
    console.debug = forward("info");
    console.warn = forward("warn");
    // "error" would reach stderr through writeSafeLog by design; a library's console.error is
    // a diagnostic, not an operator-facing failure, so it is filed at warn.
    console.error = forward("warn");
    return () => {
        console.log = original.log;
        console.info = original.info;
        console.warn = original.warn;
        console.error = original.error;
        console.debug = original.debug;
    };
}

function safeStringify(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}

