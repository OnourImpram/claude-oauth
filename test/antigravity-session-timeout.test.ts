import { rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runAntigravityHeadless, type HeadlessProcessRequest } from "../src/antigravity/headless-bridge.js";
import { startAntigravitySession } from "../src/antigravity/session.js";

// CASE RECORD (audit D2-02, 2026-11-15). The routed Google session inherited the one-shot
// default of 300 s as BOTH the runner's kill timer and agy's own --print-timeout. In that
// lane one agy process holds the whole agentic task and blocks inside the router's tool
// bridge for every parked call, so model time, every tool Claude Code ran and every
// permission prompt counted against a single five-minute budget. A task with a test run in
// it was killed at 300 s; the follow-up request then restarted agy over a compiled history
// with its in-session context gone. The session registry had already removed its own
// parked-call timeout as too short for a human-speed permission prompt, and the Grok session
// lane has no such cap. The bound that ends a stuck TURN is the router's request guard
// (session-registry FINDING 1); the bound that ends an abandoned SESSION is the registry's
// idle sweep. The process timer is only a backstop behind those two.

let home = "";
before(async () => {
    home = await mkdtemp(join(tmpdir(), "agy-session-timeout-"));
});
after(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const success = { exitCode: 0, stdout: `${JSON.stringify({ event: "result", result: { status: "success", response: "OK" } })}\n`, stderr: "" };
const printTimeout = (request: HeadlessProcessRequest): string | undefined => request.arguments[request.arguments.indexOf("--print-timeout") + 1];

describe("antigravity process timeout by lane", () => {
    it("a routed session is not bound to the one-shot five minutes", async () => {
        let seen: HeadlessProcessRequest | undefined;
        const session = startAntigravitySession({
            binary: "agy.exe",
            cwd: home,
            prompt: "Reply with exactly: OK",
            model: "gemini-3.8-flash-high",
            home,
            environment: { PATH: "C:\\Windows", USERPROFILE: home },
            toolEndpoint: { url: "http://127.0.0.1:8791/mcp/session-a", headers: {} },
            configHomeRoot: join(home, "call-homes"),
            processRunner: async (request) => {
                seen = request;
                return success;
            },
        });
        await session.done;
        strictEqual(session.text(), "OK");
        strictEqual(seen?.timeoutMs, 6 * 60 * 60 * 1000, "the runner's kill timer is the session backstop");
        strictEqual(seen === undefined ? undefined : printTimeout(seen), "21600s", "agy's own print timeout matches it");
    });

    it("NEGATIVE: a one-shot call keeps the five-minute default", async () => {
        let seen: HeadlessProcessRequest | undefined;
        await runAntigravityHeadless({
            binary: "agy.exe",
            cwd: home,
            prompt: "Reply with exactly: OK",
            model: "gemini-3.8-flash-high",
            home,
            environment: { PATH: "C:\\Windows", USERPROFILE: home },
            processRunner: async (request) => {
                seen = request;
                return success;
            },
        });
        strictEqual(seen?.timeoutMs, 300_000);
        strictEqual(seen === undefined ? undefined : printTimeout(seen), "300s");
    });

    it("NEGATIVE: a one-shot call still cannot ask for more than ten minutes", async () => {
        await rejects(runAntigravityHeadless({
            binary: "agy.exe",
            cwd: home,
            prompt: "x",
            model: "gemini-3.8-flash-high",
            home,
            environment: { PATH: "C:\\Windows", USERPROFILE: home },
            timeoutMs: 6 * 60 * 60 * 1000,
            processRunner: async () => success,
        }), /timeout must be a positive bounded integer/u);
    });
});
