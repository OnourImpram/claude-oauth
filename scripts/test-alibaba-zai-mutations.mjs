// Mutation evidence for the alibaba / zai / openaiapi lanes (2026-11-09 task).
// Run from an idle checkout. Each mutant is applied to ONE source file, the project is
// rebuilt, and ONLY the two new test files run: the brief requires every new arm to fail
// against a deliberate mutant. Backups stay in memory and are restored in a finally block,
// never via git checkout; the restoration is verified byte-exact before the script exits.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? join(root, ".astra-review", "alibaba-zai-mutations"));
const targets = [
    "src/adapters/anthropic-api-key.ts",
    "src/adapters/openai-api-key.ts",
    "src/adapters/router-key-file.ts",
    "src/domain/model-refresh.ts",
    "src/domain/registry.ts",
    "src/domain/validation.ts",
    "src/security/environment.ts",
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
    const run = await runNode(["--test", "--test-reporter=tap", "dist/test/alibaba-zai.test.js", "dist/test/openaiapi.test.js"]);
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
const openai = originals.get(targets[1]).toString("utf8");
const keyFile = originals.get(targets[2]).toString("utf8");
const refresh = originals.get(targets[3]).toString("utf8");
const registry = originals.get(targets[4]).toString("utf8");
const validation = originals.get(targets[5]).toString("utf8");
const environment = originals.get(targets[6]).toString("utf8");

const mutants = [
    {
        // The fresh-header rule is dropped: the client's OAuth authorization is copied upstream.
        name: "oauth-authorization-forwarded",
        path: targets[0],
        source: replaceOnce(anthropic, `            "anthropic-version": "2023-06-01",\n            "x-api-key": key,\n        });`,
            `            "anthropic-version": "2023-06-01",\n            "x-api-key": key,\n            authorization: request.headers.get("authorization") ?? "leaked-oauth-header",\n        });`),
        failure: "forwards none of them",
    },
    {
        // The DATA RULE filter is disabled: mcp__* tools are advertised upstream.
        name: "mcp-withholding-removed",
        path: targets[0],
        source: replaceOnce(anthropic, `startsWith("mcp__")`, `startsWith("mcp__never-matches")`),
        failure: "tools are never advertised",
    },
    {
        // The measured 1113 code no longer selects the balance state (message arm still live).
        name: "zai-balance-code-ignored",
        path: targets[0],
        source: replaceOnce(anthropic, `code === ZAI_BALANCE_CODE`, `code === "0000"`),
        failure: "a send-time 429/1113 is a named",
    },
    {
        // The whole zai balance marker is gone: neither arm can name the state.
        name: "zai-balance-branch-removed",
        path: targets[0],
        source: replaceOnce(anthropic, `if (lane.provider === "zai" && (code === ZAI_BALANCE_CODE || (message ?? "").includes(\`[\${ZAI_BALANCE_CODE}]\`)))`, `if (false)`),
        failure: "never green, with the recharge remedy",
    },
    {
        // The upstream model swap is dropped: the router id is sent to the provider.
        name: "model-swap-dropped",
        path: targets[0],
        source: replaceOnce(anthropic, `const result: JsonRecord = { ...envelope, model: upstreamModel };`, `const result: JsonRecord = { ...envelope };`),
        failure: "with the model swapped",
    },
    {
        // Live-list admission is ignored: every contracted row enters regardless of the answer.
        name: "live-list-admission-ignored",
        path: targets[3],
        source: replaceOnce(refresh, `.filter((entry) => live.has(entry.upstreamModel))`, `.filter(() => true)`),
        failure: "produces NO rows",
    },
    {
        // The lane's Bearer key is replaced by whatever authorization the client sent.
        name: "openaiapi-bearer-replaced-by-client-oauth",
        path: targets[1],
        source: replaceOnce(openai, `                accept: streaming ? "text/event-stream" : "application/json",\n                authorization: \`Bearer \${key}\`,`,
            `                accept: streaming ? "text/event-stream" : "application/json",\n                authorization: request.headers.get("authorization") ?? \`Bearer \${key}\`,`),
        failure: "forwards none of them",
    },
    {
        // The measured credit codes no longer select the named state.
        name: "openaiapi-credit-code-ignored",
        path: targets[1],
        source: replaceOnce(openai, `return type === "insufficient_quota" || code === "credit_balance_exhausted";`, `return false;`),
        failure: "openaiapi_credit_exhausted, never green",
    },
    {
        // The gpt-6 field requirement is reverted to max_tokens.
        name: "max-completion-tokens-reverted",
        path: targets[1],
        source: replaceOnce(openai, `maxTokensField: "max_completion_tokens",`, `maxTokensField: "max_tokens",`),
        failure: "travels as max_completion_tokens",
    },
    {
        // Astra loses its [1m] discovery bucket on the openaiapi lane.
        name: "registry-1m-openaiapi-branch-removed",
        path: targets[4],
        source: replaceOnce(registry, `(model.provider === "alibaba" || model.provider === "zai" || model.provider === "openaiapi") &&`,
            `(model.provider === "alibaba" || model.provider === "zai") &&`),
        failure: "takes the [1m] suffix",
    },
    {
        // The new lane variables are no longer stripped from child environments.
        name: "secret-strip-removed",
        path: targets[6],
        source: replaceOnce(environment, `    "ALIBABA_TOKEN_PLAN_API_KEY",\n    "ALIBABA_TOKEN_PLAN_API_KEY_FILE",\n    "ZAI_API_KEY",\n    "ZAI_API_KEY_FILE",\n    "OPENAI_API_KEY_FILE",\n`, ""),
        failure: "never reaches a child environment",
    },
    {
        // openaiapi leaves the api-key credential class: the parser must refuse its rows.
        name: "api-key-class-openaiapi-removed",
        path: targets[5],
        source: replaceOnce(validation, `new Set<string>(["alibaba", "zai", "openaiapi"])`, `new Set<string>(["alibaba", "zai"])`),
        failure: "refuses credential mix-ups",
    },
    {
        // The lane's own dotenv file is no longer read: a file-only lane can never find its key.
        name: "lane-key-file-ignored",
        path: targets[2],
        source: replaceOnce(keyFile, `const file = environment[laneFileVariable]?.trim();`, `const file = undefined as string | undefined;`),
        failure: "reads the key from the lane's own dotenv file",
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
