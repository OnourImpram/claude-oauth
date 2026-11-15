import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAntigravityTaskArguments } from "../src/antigravity/task-arguments.js";

// CASE RECORD (2026-11-15). A delegated one-shot task on a slow reasoning tier was killed at
// 302.6 s with upstream_timeout although its caller had asked for 1800 s. The one-shot
// commands (`gemini`, `opus-google`, `sonnet-google`, `antigravity --model`) took no time
// budget at all, so the caller's number only steered the caller's own watchdog and the bridge
// fell back to its five-minute default. D2-02 had lifted that default for the routed session
// lane only. The command now reads `--timeout <seconds>` and hands it to the bridge.
//
// `--task` and `--cwd` values are skipped, not inspected: a task whose whole text is a flag
// name must stay a task.

const invalid = /--timeout requires whole seconds/u;

describe("one-shot Antigravity command arguments", () => {
    it("reads --timeout as whole seconds and leaves the task arguments alone", () => {
        const parsed = parseAntigravityTaskArguments(["--model", "gemini-4-carbon-high", "--timeout", "1800", "--task", "x", "--cwd", "."]);
        strictEqual(parsed.model, "gemini-4-carbon-high");
        strictEqual(parsed.timeoutMs, 1_800_000);
        deepStrictEqual([...parsed.taskArguments], ["--task", "x", "--cwd", "."]);
    });

    it("accepts the flag after the task as well", () => {
        const parsed = parseAntigravityTaskArguments(["--task", "x", "--timeout", "900"], "gemini-3.8-flash-high");
        strictEqual(parsed.timeoutMs, 900_000);
        deepStrictEqual([...parsed.taskArguments], ["--task", "x"]);
    });

    it("NEGATIVE: without the flag no budget is named, so the bridge default applies", () => {
        const parsed = parseAntigravityTaskArguments(["--task", "x"], "gemini-3.8-flash-high");
        strictEqual(parsed.timeoutMs, undefined);
        strictEqual("timeoutMs" in parsed, false);
    });

    it("NEGATIVE: a value that is not whole positive seconds is refused, never swallowed", () => {
        for (const value of ["0", "-5", "1.5", "abc", "1800s", "", " 60"]) {
            throws(() => parseAntigravityTaskArguments(["--timeout", value, "--task", "x"], "gemini-3.8-flash-high"), invalid, `value ${JSON.stringify(value)}`);
        }
        throws(() => parseAntigravityTaskArguments(["--task", "x", "--timeout"], "gemini-3.8-flash-high"), invalid, "missing value");
    });

    it("NEGATIVE: a task whose text is the flag name stays a task", () => {
        const parsed = parseAntigravityTaskArguments(["--task", "--timeout", "--cwd", "--model"], "gemini-3.8-flash-high");
        strictEqual(parsed.timeoutMs, undefined);
        strictEqual(parsed.model, "gemini-3.8-flash-high");
        deepStrictEqual([...parsed.taskArguments], ["--task", "--timeout", "--cwd", "--model"]);
    });

    it("keeps the model rules: a fixed model cannot be replaced and a free command needs one", () => {
        throws(() => parseAntigravityTaskArguments(["--model", "gemini-4-argon-high", "--task", "x"], "gemini-3.8-flash-high"), /fixed Antigravity model/u);
        throws(() => parseAntigravityTaskArguments(["--task", "x"]), /requires --model/u);
        strictEqual(parseAntigravityTaskArguments(["--model", "gemini-3.8-flash-high", "--task", "x"], "gemini-3.8-flash-high").model, "gemini-3.8-flash-high");
    });

    // The parser being right is not enough: the command has to hand the budget on. The
    // command needs a verified installation to run, so this arm reads its source, the way
    // antigravity-probe-budget.test.ts holds the probe budget.
    it("the one-shot command hands the parsed budget to the bridge", () => {
        const source = readFileSync(fileURLToPath(new URL("../../src/cli.ts", import.meta.url)), "utf8");
        const start = source.indexOf("async function antigravityTask");
        ok(start >= 0, "command located");
        const body = source.slice(start, start + 1_500);
        match(body, /parseAntigravityTaskArguments\(args, fixedModel\)/u);
        match(body, /runAntigravityHeadless\(\{[^}]*\.\.\.\(timeoutMs === undefined \? \{\} : \{ timeoutMs \}\)/su);
    });
});
