import { describe, it } from "node:test";
import { ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAntigravityHeadless } from "../src/antigravity/headless-bridge.js";
import { RouterError } from "../src/domain/errors.js";

// Measured 2026-09-07. A delegation to the Google lane came back with nothing and the
// router said only "Antigravity did not complete the request." The child had in fact
// written the whole reason to stderr -- a tool required a permission headless mode
// cannot prompt for, so it was auto-denied -- and the bridge collected that text and
// then dropped it at the throw. A second shape was worse: the terminal event said
// SUCCESS while the response was empty, so an entirely empty run was reported as a
// healthy one.
//
// The first repair was then red-teamed (report tasks/router-karar-20260907/
// astra-red-team.md) and three of its claims broke. Every arm below that names a
// channel, a credential class or a classification edge exists because that pass
// produced a counter-example for it -- including the mutation gaps it found, where
// deleting a whole redaction rule or widening the limit killed no test at all.

const MARKER = "child diagnostic marker";

function terminalEvent(result: Record<string, unknown>): string {
    return `${JSON.stringify({ event: "result", result })}\n`;
}

function success(response: string): string {
    return terminalEvent({ status: "success", response });
}

interface ChildOutput {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

async function bridgeFailure(output: ChildOutput, allowEdits = false): Promise<RouterError> {
    const home = mkdtempSync(join(tmpdir(), "agy-detail-"));
    try {
        await runAntigravityHeadless({
            binary: "agy.exe",
            cwd: home,
            home,
            allowEdits,
            prompt: "Reply with exactly: OK",
            model: "gemini-3.8-flash-high",
            environment: { PATH: "C:\\Windows", USERPROFILE: home },
            processRunner: async () => output,
        });
    }
    catch (error) {
        if (error instanceof RouterError)
            return error;
        throw error;
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
    throw new Error("the bridge returned instead of throwing");
}

// Every redaction arm sends its class through the real bridge and asks one question:
// did the value travel? The value never enters this file as a literal -- a
// secret-shaped string here would be a true finding for scripts/secret-scan.mjs, and
// a test must not punch a hole in a gate to prove a point.
async function redactedMessage(stderr: string): Promise<string> {
    const error = await bridgeFailure({ exitCode: 1, stdout: success(""), stderr });
    return error.message;
}

describe("antigravity failure detail -- the child's explanation survives", () => {
    it("stderr reaches the thrown message, with the exit code", async () => {
        const error = await bridgeFailure({
            exitCode: 1,
            stdout: terminalEvent({ status: "failure", response: "" }),
            stderr: `no output produced -- ${MARKER}`,
        });
        strictEqual(error.code, "upstream_protocol_error");
        ok(error.message.includes(MARKER), `the reason did not survive: ${error.message}`);
        ok(error.message.includes("exit 1"), "the exit code is not in the message");
    });

    it("the terminal event's own error field is a second channel, not a silent one", async () => {
        // Counter-example from the red team: the child explained itself in the
        // terminal `error` field with an empty stderr, and the message answered
        // "child wrote nothing to stderr".
        const error = await bridgeFailure({
            exitCode: 1,
            stdout: terminalEvent({ status: "failure", response: "", error: `disk full: ${MARKER}` }),
            stderr: "",
        });
        ok(error.message.includes(MARKER), `the terminal channel was dropped: ${error.message}`);
        ok(!error.message.includes("no diagnostic"), "the message claims silence while the child spoke");
    });

    it("a malformed stream keeps its own code AND carries the diagnosis", async () => {
        const error = await bridgeFailure({ exitCode: 1, stdout: "{", stderr: `parser died -- ${MARKER}` });
        strictEqual(error.code, "upstream_protocol_error");
        ok(error.message.includes("NDJSON"), "the parse failure lost its own message");
        ok(error.message.includes(MARKER), "the parse path still discards the child's text");
    });

    it("the auth branch carries the diagnosis too", async () => {
        const error = await bridgeFailure({ exitCode: 1, stdout: "", stderr: `login failed -- ${MARKER}` });
        strictEqual(error.code, "provider_auth_required");
        ok(error.message.includes(MARKER), "the auth path still discards the child's text");
    });

    it("a classified provider failure keeps its class and gains the child's words", async () => {
        const error = await bridgeFailure({
            exitCode: 1,
            stdout: terminalEvent({ status: "ERROR", response: "", error: `quota exhausted -- ${MARKER}` }),
            stderr: "",
        });
        strictEqual(error.code, "provider_rate_limited");
        strictEqual(error.status, 429);
        ok(error.message.includes(MARKER), "the classified path still discards the child's text");
    });
});

describe("antigravity failure detail -- the diagnostic channel does not leak", () => {
    it("a provider-prefixed credential is redacted", async () => {
        const value = ["sk", "A".repeat(24)].join("-");
        const message = await redactedMessage(`auth failed for ${value} while starting the tool`);
        ok(!message.includes(value), "a prefixed credential left through the diagnostic channel");
        ok(message.includes("[REDACTED]"), "the redaction never fired");
    });

    it("a Bearer VALUE is redacted, not just the word Bearer", async () => {
        // No field name in front of it on purpose. The first version of this arm wrote
        // "Authorization: Bearer ...", which the named-field rule redacts on its own --
        // so deleting the Bearer rule outright killed no test. An arm that passes
        // because a different rule caught the value measures that other rule.
        const value = "Zq".repeat(12);
        const message = await redactedMessage(`retrying with Bearer ${value} produced nothing`);
        ok(!message.includes(value), "the token stood while only the scheme word was redacted");
        ok(message.includes("Bearer"), "the scheme word is diagnosis, not secret; it should survive");
    });

    it("a named field's value is redacted to the end of the line, spaces included", async () => {
        const first = "Wm".repeat(6);
        const second = "Xn".repeat(6);
        const message = await redactedMessage(`config load failed: password = ${first} ${second}`);
        ok(!message.includes(first), "the first fragment of the value survived");
        ok(!message.includes(second), "a space-separated fragment of the value survived");
    });

    it("a query-string token is redacted", async () => {
        const value = "Qv".repeat(10);
        const message = await redactedMessage(`request to https://example.invalid/x?key=${value} failed`);
        ok(!message.includes(value), "a token carried in a URL query survived");
    });

    it("an AWS access key id is redacted although it is shorter than the opaque-run limit", async () => {
        const value = `AKIA${"Q7ZK2MB4XC9TLVD3".slice(0, 16)}`;
        const message = await redactedMessage(`profile rejected for ${value} during startup`);
        ok(!message.includes(value), "a 20-character key id fell between two rules");
    });

    it("a JWT is redacted whole -- the header and payload carry claims", async () => {
        const token = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "S".repeat(24)].join(".");
        const message = await redactedMessage(`token refresh failed: ${token}`);
        ok(!message.includes("eyJzdWIiOiIxIn0"), "the payload segment survived redaction");
    });

    it("a long opaque run is redacted in any script, not only ASCII", async () => {
        const latin = "z".repeat(40);
        const cyrillic = "ж".repeat(40);
        const message = await redactedMessage(`opaque ${latin} and ${cyrillic} in a nameless diagnostic`);
        ok(!message.includes(latin), "a long ASCII run survived");
        ok(!message.includes(cyrillic), "a long non-ASCII run survived");
    });

    it("an early prefix match does not eat the field name the later rule needs", async () => {
        // Counter-example from the second adversarial pass: "api-signature-token" was
        // swallowed by the provider-prefix rule, which removed the field name the
        // field rule was going to key on, and the value behind it then walked out.
        const value = "correct-horse-battery-staple";
        const message = await redactedMessage(`Configuration error on api-signature-token: ${value}`);
        ok(!message.includes(value), "the value survived because its field name was redacted first");
    });

    it("a base64-shaped secret survives neither / nor + splitting it", async () => {
        const value = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY1"].join("/");
        const message = await redactedMessage(`Signature validation failed: ${value}`);
        ok(!message.includes(value), "a slash-bearing key fell between the opaque-run boundaries");
    });

    it("a POSIX source path is NOT eaten by the base64 rule", async () => {
        // Measured counter-example: "/home/runner/work/MyApp123/src/index" satisfied
        // mixed case AND a digit, so the reader got "ENOENT open '[REDACTED].ts'".
        // The path is the diagnosis; losing it defeats the channel.
        const path = "/home/runner/work/MyApp123/src/index";
        const message = await redactedMessage(`ENOENT open '${path}.ts'`);
        ok(message.includes(path), `the path was redacted away: ${message}`);
    });

    it("an operating-system EACCES is not called a tool-permission denial", async () => {
        // "command" was in the tool-context list for agy's own wording and matched
        // every "command failed: permission denied" the OS produces, answering an
        // EACCES with a permissions.allow remedy.
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: success(""),
            stderr: "command failed: permission denied for /etc/passwd",
        });
        strictEqual(error.code, "upstream_protocol_error");
    });

    it("a short status code behind a weak field name survives, a long lowercase token does not", async () => {
        const kept = await redactedMessage("key: Error1 while starting the child");
        ok(kept.includes("Error1"), "a six-character status code was treated as a credential");
        const token = "abcdefghijklmnopqrs";
        const gone = await redactedMessage(`key: ${token} rejected`);
        ok(!gone.includes(token), "a nineteen-character token slipped under the length floor");
    });

    it("a quoted value after a scheme word is redacted", async () => {
        const value = "sec_token_9988776655";
        const message = await redactedMessage(`Rejected handshake for Bearer "${value}" from peer`);
        ok(!message.includes(value), "a quoted token stood because the rule expected a bare value");
    });

    it("over-redaction guard: a weak field name does not swallow the error message", async () => {
        // The other direction of the same defect. A diagnostic channel that deletes
        // the diagnosis is not safe, it is useless: `"key": "spawn_failed"` must not
        // take the rest of the line with it.
        const message = await redactedMessage(
            '{"level":"error","key":"spawn_failed","message":"permission denied for /bin/sandbox-exec"}');
        ok(message.includes("sandbox-exec"), "the actual error message was redacted away");
        ok(message.includes("spawn_failed"), "a short non-credential value was redacted");
    });

    it("ANSI escape sequences are stripped before the excerpt is cut", async () => {
        // Built from an escape sequence rather than a raw control byte: an invisible
        // character in a source file is one careless copy away from silently becoming
        // something else.
        const esc = "\u001b";
        const message = await redactedMessage(`${esc}[31mfatal:${esc}[0m the child stopped`);
        ok(!message.includes(esc), "an escape sequence reached the reader's terminal");
        ok(message.includes("fatal:"), "the text inside the escapes was lost");
    });

    it("the excerpt is bounded in BYTES, says exactly how many were dropped, and cuts on a character", async () => {
        // Words, not one long run: a 2,000-character run of letters is itself
        // secret-shaped, so redaction collapses it to a single token and the
        // truncation never gets exercised. The first version of this test made
        // exactly that mistake and passed for the wrong reason.
        const stderr = `head marker ${"noise ".repeat(400)}`;
        const dropped = Buffer.byteLength(stderr.trim(), "utf8") - 600;
        const error = await bridgeFailure({ exitCode: 1, stdout: success(""), stderr });
        ok(error.message.includes("head marker"), "the beginning of stderr was lost");
        ok(error.message.includes(`[${dropped} more bytes]`),
            `the limit or the count moved: ${error.message.slice(-60)}`);
    });

    it("a multi-byte character is never cut in half", async () => {
        // The first version sliced UTF-16 units and called them bytes; 400 emoji is
        // 1,600 UTF-8 bytes in 800 units, so the cut landed inside a surrogate pair.
        const error = await bridgeFailure({
            exitCode: 1,
            stdout: success(""),
            stderr: `x${"\u{1F9F1}".repeat(400)}`,
        });
        ok(!/[\uD800-\uDFFF]/u.test(error.message), "the excerpt ends in an unpaired surrogate");
        const excerpt = error.message.slice(error.message.indexOf("stderr: ") + 8).split("...[")[0] ?? "";
        ok(Buffer.byteLength(excerpt, "utf8") <= 600, "the limit is not being measured in bytes");
    });
});

describe("antigravity failure detail -- an empty success is named by evidence", () => {
    it("an evidenced empty run is a permission denial, and the remedy names the lane actually run", async () => {
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: success("   "),
            stderr: "jetski: no output produced -- the permission was auto-denied in headless mode",
        });
        strictEqual(error.code, "provider_tool_permission_denied");
        ok(error.message.includes("FIX:"), "an actionable code shipped without its remedy");
        ok(error.message.includes("--mode plan --sandbox"), "the remedy does not name this lane's flags");
    });

    it("on an edit-enabled lane the remedy names THAT lane, not the plan-mode one", async () => {
        // The red team's counter-example: provider-set.ts passes allowEdits: true, and
        // the message still claimed "--mode plan --sandbox" -- a remedy describing a
        // command that was never run.
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: success(""),
            stderr: "tool call denied: permission could not be granted",
        }, true);
        strictEqual(error.code, "provider_tool_permission_denied");
        ok(error.message.includes("--mode accept-edits"), "the remedy describes a command this call never ran");
        ok(!error.message.includes("--mode plan"), "the remedy names a lane that was not used");
    });

    it("negative arm: an empty response WITHOUT that evidence is not called a permission denial", async () => {
        const error = await bridgeFailure({ exitCode: 0, stdout: success(""), stderr: "" });
        strictEqual(error.code, "upstream_protocol_error");
        ok(error.message.includes("no diagnostic"), "the silence of both channels is not stated");
    });

    it("negative arm: a settings line that merely NAMES the permission surface is not a denial", async () => {
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: success(""),
            stderr: "INFO permissions.allow loaded; provider output stream disconnected",
        });
        strictEqual(error.code, "upstream_protocol_error");
    });

    it("negative arm: an explicit negation is not a denial", async () => {
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: success(""),
            stderr: "permission was not denied; response decoder failed",
        });
        strictEqual(error.code, "upstream_protocol_error");
    });

    it("an unrelated authorisation failure is NOT reported as a tool-permission denial", async () => {
        // Counter-example from the second adversarial pass: a Google IAM refusal puts
        // "permission" and "denied" next to each other, and the old signature sent its
        // reader to permissions.allow -- the wrong afternoon entirely.
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: success(""),
            stderr: "Google API error: IAM permission denied for project my-proj",
        });
        strictEqual(error.code, "upstream_protocol_error");
    });

    it("a --help line elsewhere in the output does not disqualify a real denial", async () => {
        // The negation used to be tested against the whole channel, so one help line
        // anywhere in stderr silenced the classification of a genuine denial.
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: success(""),
            stderr: "Tool command was auto-denied in headless mode.\nFor options, see agy --help",
        });
        strictEqual(error.code, "provider_tool_permission_denied");
    });

    it("negative arm: a usage line advertising the skip flag is not a denial", async () => {
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: success(""),
            stderr: "Usage: --dangerously-skip-permissions enables editing. Server unavailable",
        });
        strictEqual(error.code, "upstream_protocol_error");
    });

    it("the denial is recognised with the verb BEFORE the noun", async () => {
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: success(""),
            stderr: "Tool shell execution rejected: approval could not be obtained in noninteractive mode",
        });
        strictEqual(error.code, "provider_tool_permission_denied");
    });

    it("the denial is recognised across a line break", async () => {
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: success(""),
            // The break is what this arm measures; the tool context has to be there
            // too, because "permission ... denied" on its own is also what an IAM
            // refusal looks like and that must NOT be classified as this condition.
            stderr: "tool permission\nwas denied by policy in headless mode",
        });
        strictEqual(error.code, "provider_tool_permission_denied");
    });

    it("the denial is recognised when the child reports it in the terminal event", async () => {
        const error = await bridgeFailure({
            exitCode: 0,
            stdout: terminalEvent({ status: "success", response: "", error: "tool permission denied by policy" }),
            stderr: "",
        });
        strictEqual(error.code, "provider_tool_permission_denied");
    });

    it("allowEdits decides the child's actual permission flags -- and nothing else did", async () => {
        // Found by the mutation control, not by reading: replacing
        // `options.allowEdits === true` in the processArguments call with `false`
        // killed no test at all. The flag that decides whether the child may edit
        // files and skip permission prompts was measured by nothing.
        const seen: string[][] = [];
        for (const allowEdits of [false, true]) {
            const home = mkdtempSync(join(tmpdir(), "agy-detail-args-"));
            try {
                await runAntigravityHeadless({
                    binary: "agy.exe",
                    cwd: home,
                    home,
                    allowEdits,
                    prompt: "Reply with exactly: OK",
                    model: "gemini-3.8-flash-high",
                    environment: { PATH: "C:\\Windows", USERPROFILE: home },
                    processRunner: async (request) => {
                        seen.push([...request.arguments]);
                        return { exitCode: 0, stdout: success("OK"), stderr: "" };
                    },
                });
            }
            finally {
                rmSync(home, { recursive: true, force: true });
            }
        }
        const [planned, editing] = seen;
        ok(planned?.includes("plan"), "the delegation lane must stay in plan mode");
        ok(planned?.includes("--sandbox"), "the delegation lane must stay sandboxed");
        ok(!planned?.includes("--dangerously-skip-permissions"), "plan mode must not skip permissions");
        ok(editing?.includes("accept-edits"), "an edit-enabled lane must reach accept-edits mode");
        ok(editing?.includes("--dangerously-skip-permissions"), "an edit-enabled lane must carry its own flag");
        ok(!editing?.includes("--sandbox"), "accept-edits and --sandbox must not be sent together");
    });

    it("negative arm: a non-empty response still succeeds", async () => {
        const home = mkdtempSync(join(tmpdir(), "agy-detail-ok-"));
        try {
            const result = await runAntigravityHeadless({
                binary: "agy.exe",
                cwd: home,
                home,
                prompt: "Reply with exactly: OK",
                model: "gemini-3.8-flash-high",
                environment: { PATH: "C:\\Windows", USERPROFILE: home },
                processRunner: async () => ({ exitCode: 0, stdout: success("OK"), stderr: "warning: noise" }),
            });
            strictEqual(result.response, "OK");
        }
        finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("negative arm: rejects is exercised at least once so the helper cannot silently stop throwing", async () => {
        const home = mkdtempSync(join(tmpdir(), "agy-detail-reject-"));
        try {
            await rejects(async () => await runAntigravityHeadless({
                binary: "agy.exe",
                cwd: home,
                home,
                prompt: "Reply with exactly: OK",
                model: "gemini-3.8-flash-high",
                environment: { PATH: "C:\\Windows", USERPROFILE: home },
                processRunner: async () => ({ exitCode: 0, stdout: success(""), stderr: "" }),
            }), RouterError);
        }
        finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});
