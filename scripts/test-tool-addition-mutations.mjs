// Mutation evidence for the tool_addition folding fix (2026-11-09 task, worker brief 2), kept
// current through the D2 audit repairs (2026-11-15): the fold lives in ONE module shared by the
// passthrough lanes and the chat-completions lane (D2-03), and the MCP-history rule (D2-01) is
// mutated beside it. Run from an idle checkout. Each mutant is applied to ONE source file, the
// project is rebuilt, and ONLY the touched test files run: every new arm must fail against a
// deliberate mutant. Backups stay in memory and are restored in a finally block, never via git
// checkout; the restoration is verified byte-exact before exit.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? join(root, ".astra-review", "tool-addition-mutations"));
const targets = [
    "src/adapters/anthropic-api-key.ts",
    "src/adapters/openai-message-map.ts",
    "src/adapters/tool-addition.ts",
    "src/adapters/mcp-history.ts",
];
const originals = new Map(await Promise.all(targets.map(async (path) => [path, await readFile(join(root, path))])));
const results = [];
await mkdir(output, { recursive: true });

function replaceOnce(source, anchor, replacement) {
    // Source files mix LF and CRLF; try the anchor in both conventions.
    for (const [needle, patch] of [
        [anchor, replacement],
        [anchor.replaceAll("\n", "\r\n"), replacement.replaceAll("\n", "\r\n")],
    ]) {
        if (source.split(needle).length === 2)
            return source.replace(needle, () => patch);
    }
    throw new Error("Mutation anchor must match exactly once.");
}
async function runNode(args) {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    return await new Promise((resolveRun, rejectRun) => {
        child.once("error", rejectRun);
        child.once("close", (code) => resolveRun({ code, stdout, stderr }));
    });
}
async function build() {
    const run = await runNode(["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
    if (run.code !== 0) throw new Error(`Mutation build failed; no test result is claimed.\n${run.stdout}`);
}
async function restore() {
    for (const [path, bytes] of originals) await writeFile(join(root, path), bytes);
}
async function suite(name, expectedFailure) {
    const run = await runNode(["--test", "--test-reporter=tap", "dist/test/alibaba-zai.test.js", "dist/test/openaiapi.test.js", "dist/test/mcp-history.test.js"]);
    await writeFile(join(output, `${name}.tap`), run.stdout);
    const summary = Object.fromEntries([...run.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)].map((match) => [match[1], Number(match[2])]));
    // Subtests are indented in TAP; a failing arm also fails its parent suite line.
    const expected = expectedFailure === undefined ? "" : expectedFailure.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const expectedTestFailed = expectedFailure === undefined ? undefined : new RegExp(`^[ ]*not ok [^\\n]*${expected}`, "mu").test(run.stdout);
    const accepted = expectedFailure === undefined ? run.code === 0 : run.code !== 0 && expectedTestFailed;
    const row = { name, exitCode: run.code, ...summary, ...(expectedTestFailed === undefined ? {} : { expectedTestFailed }), accepted };
    results.push(row);
    await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(JSON.stringify(row));
    if (!accepted) throw new Error(`Mutation ${name} did not satisfy its expected test outcome.`);
}

const anthropic = originals.get(targets[0]).toString("utf8");
const messageMap = originals.get(targets[1]).toString("utf8");
const fold = originals.get(targets[2]).toString("utf8");
const history = originals.get(targets[3]).toString("utf8");

const mutants = [
    {
        // Step 1 skipped entirely: the type guard never matches a real tool_addition block, so
        // none is removed and none is folded -- the measured upstream 400 stays reachable.
        // (A literal `if (true)` does not compile: it also drops the isRecord narrowing.)
        name: "tool-addition-removal-skipped",
        path: targets[2],
        source: replaceOnce(fold, `if (!isRecord(block) || block["type"] !== "tool_addition") {`, `if (!isRecord(block) || block["type"] !== "tool_addition_never") {`),
        failure: "no tool_addition block survives anywhere",
    },
    {
        // The data rule does not apply to folded additions: mcp__ definitions are advertised.
        name: "mcp-tool-addition-folded",
        path: targets[2],
        source: replaceOnce(fold, `if (!withheldPrefixes.some((prefix) => name.startsWith(prefix)) && !known.has(name)) {`, `if (!known.has(name)) {`),
        failure: "mcp__ ones are withheld",
    },
    {
        // Duplicate names are allowed: the same tool can appear twice in outgoing tools.
        name: "duplicate-fold-allowed",
        path: targets[2],
        source: replaceOnce(fold, `if (!withheldPrefixes.some((prefix) => name.startsWith(prefix)) && !known.has(name)) {`, `if (!withheldPrefixes.some((prefix) => name.startsWith(prefix))) {`),
        failure: "does not create a second tools entry",
    },
    {
        // A message whose content became empty is kept (with its original tool_addition blocks).
        name: "empty-message-kept",
        path: targets[2],
        source: replaceOnce(fold, `        if (kept.length === 0)
            continue; // a message made only of tool_addition blocks disappears
        folded.push(kept.length === blocks.length ? message : { ...message, content: kept });`, `        if (kept.length === 0)
            folded.push(message);
        else
            folded.push(kept.length === blocks.length ? message : { ...message, content: kept });`),
        failure: "a message made only of tool_addition blocks disappears",
    },
    {
        // The block's cache_control is copied onto the folded tool definition.
        name: "cache-control-copied",
        path: targets[2],
        source: replaceOnce(fold, `definitions.push(definition);`, `definitions.push({ ...definition, ...(isRecord(block["cache_control"]) ? { cache_control: block["cache_control"] } : {}) });`),
        failure: "no tool_addition block survives anywhere",
    },
    {
        // Removed blocks are dropped outright instead of folded: no definition joins tools.
        name: "fold-into-tools-dropped",
        path: targets[2],
        source: replaceOnce(fold, `definitions.push(definition);`, `/* nothing folded */;`),
        failure: "no tool_addition block survives anywhere",
    },
    {
        // Step 4 reverted: an empty outgoing tools array is sent as `tools: []` and tool_choice
        // survives (also caught by the pre-existing only-mcp__ negative arms).
        name: "empty-tools-deletion-removed",
        path: targets[0],
        source: replaceOnce(anthropic, `if (outgoingTools.length === 0) {`, `if (false) {`),
        failure: "when everything is withheld",
    },
    {
        // Semantics invented for unknown shapes: every non-tool_addition block is dropped too.
        name: "unknown-blocks-dropped",
        path: targets[2],
        source: replaceOnce(fold, `kept.push(block);`, `/* dropped */;`),
        failure: "the system text block survives in place",
    },
    {
        // openai-message-map: the omission placeholder for non-text blocks is dropped. Since the
        // chat lanes fold tool_addition (D2-03) the placeholder's live producer is a non-text
        // block (a screenshot) inside a tool_result, which has its own arm.
        name: "omitted-placeholder-dropped",
        path: targets[1],
        source: replaceOnce(messageMap, `return \`[\${type} block omitted by the router]\`;`, `return "";`),
        failure: "a non-text block inside a tool_result is named by the omission placeholder",
    },
    {
        // D2-03: the chat translation reads the UNFOLDED messages again -- the placeholder text
        // returns to the system prompt.
        name: "chat-fold-skipped",
        path: targets[1],
        source: replaceOnce(messageMap, `fold.messages : withholdMcpHistory(fold.messages, withheldPrefixes)`, `envelope.messages : withholdMcpHistory(envelope.messages, withheldPrefixes)`),
        failure: "tool_addition on the chat lane: non-mcp definitions join tools once",
    },
    {
        // D2-03: the fold removes the blocks but the definitions never join the chat tools.
        name: "chat-folded-definitions-dropped",
        path: targets[1],
        source: replaceOnce(messageMap, `mapTools([...(offered ?? []), ...folded])`, `mapTools([...(offered ?? [])])`),
        failure: "tool_addition on the chat lane: non-mcp definitions join tools once",
    },
    {
        // D2-03: names already known come from the RAW envelope tools, so a deferred stub (not
        // offered on a chat lane) hides the full definition a tool_addition brings.
        name: "chat-deferred-stub-hides-definition",
        path: targets[1],
        source: replaceOnce(messageMap, `new Set((offered ?? []).flatMap(`, `new Set((Array.isArray(envelope.tools) ? envelope.tools : []).flatMap(`),
        failure: "a deferred stub in tools does not hide the folded full definition",
    },
    {
        // D2-01: the passthrough lanes stop withholding MCP history.
        name: "history-withheld-passthrough-skipped",
        path: targets[0],
        source: replaceOnce(anthropic, `const history = withholdMcpHistory(result["messages"], [MCP_TOOL_PREFIX]);`, `const history = result["messages"];`),
        failure: "an mcp__ tool_use and its tool_result become text blocks in place",
    },
    {
        // D2-01: the chat lanes stop withholding MCP history.
        name: "history-withheld-chat-skipped",
        path: targets[1],
        source: replaceOnce(messageMap, `fold.messages : withholdMcpHistory(fold.messages, withheldPrefixes)`, `fold.messages : fold.messages`),
        failure: "an mcp__ tool_use and its tool_result are replaced by placeholders",
    },
    {
        // D2-01: an orphan tool_result (no tool_use accounts for it) is trusted and crosses.
        name: "history-orphan-result-trusted",
        path: targets[3],
        source: replaceOnce(history, `(answered === undefined || answered.withheld)`, `(answered?.withheld === true)`),
        failure: "a tool_result whose tool_use_id matches no tool_use anywhere is withheld",
    },
    {
        // D2-01: a result placeholder is left in front of the surviving tool_result.
        name: "history-placeholder-not-reordered",
        path: targets[3],
        source: replaceOnce(history, `if (moved.length > 0) {`, `if (false) {`),
        failure: "a surviving tool_result stays first in its user turn",
    },
];

try {
    await build();
    await suite("baseline");
    for (const mutant of mutants) {
        await restore();
        await writeFile(join(root, mutant.path), mutant.source);
        await build();
        await suite(mutant.name, mutant.failure);
    }
}
finally {
    await restore();
    await build();
    for (const [path, bytes] of originals) {
        if (!(await readFile(join(root, path))).equals(bytes)) throw new Error("In-memory restoration did not restore the exact original bytes.");
    }
    console.log("Original sources restored byte-exact and rebuilt.");
}
await suite("restored");
