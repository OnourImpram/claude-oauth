import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_MODEL_CONTRACTS, OPENAI_MODEL_CONTRACTS } from "../src/domain/model-contracts.js";
import { claudeOAuthAgentArguments } from "../src/supervisor/launcher.js";

const contracts = [...AGENT_MODEL_CONTRACTS, ...OPENAI_MODEL_CONTRACTS];
const available = contracts.map((contract) => contract.id);

describe("N03 delegate surface", () => {
    for (const mode of ["patched-shadow", "native-gateway"] as const) {
        for (const contract of contracts) {
            const name = `${contract.alias}-delege`;
            const model = mode === "patched-shadow" ? contract.alias : contract.id;
            it(`${mode} ${name} generates the lane tool contract without a turn cap`, () => {
                const args = claudeOAuthAgentArguments([], available, mode);
                const definitions = JSON.parse(args[args.indexOf("--agents") + 1] ?? "{}");
                const definition = definitions[name];
                strictEqual(definition.model, model);
                strictEqual(Object.hasOwn(definition, "maxTurns"), false);
                if (!("provider" in contract)) {
                    deepStrictEqual(definition.tools, ["Read", "Write", "Edit", "Grep", "Glob", "PowerShell", "Skill"]);
                } else {
                    strictEqual(Object.hasOwn(definition, "tools"), false);
                    strictEqual(/read-only|no side effects/i.test(definition.prompt + definition.description), false);
                }
            });
            for (const limits of [{ tools: ["Read", "Skill", "mcp__browser__snapshot"], maxTurns: 12 }, { tools: [], maxTurns: 1 }, {}]) {
                it(`${mode} ${name} accepts user tools and maxTurns ${JSON.stringify(limits)}`, () => {
                    const definition = { description: "custom", prompt: "custom task", model, ...limits };
                    for (const argv of [["--agents", JSON.stringify({ [name]: definition })], [`--agents=${JSON.stringify({ [name]: definition })}`]]) {
                        const args = claudeOAuthAgentArguments(argv, available, mode);
                        const json = args[0] === "--agents" ? args[1] : args[0]?.slice("--agents=".length);
                        deepStrictEqual(JSON.parse(json ?? "{}")[name], definition);
                    }
                });
            }
            it(`${mode} ${name} rejects a changed or removed model and a removed definition`, () => {
                for (const definition of [{ model: "haiku" }, { tools: ["Read"] }, null]) {
                    throws(() => claudeOAuthAgentArguments(["--agents", JSON.stringify({ [name]: definition })], available, mode),
                        { status: 400 });
                }
            });
        }
    }
});
