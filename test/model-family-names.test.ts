import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { OPENAI_MODEL_CONTRACTS, openAiFamilyNameViolations, openAiUpstreamFamily } from "../src/domain/model-contracts.js";

// Case record (2026-11-15): `sol`, `terra`, `luna` and `astra` are the NAMES of the OpenAI model
// families, not aliases of one version. When a new version arrives the name moves to it; a
// version-suffixed second name (`sol61`) or a second row for the same family is the defect this
// file exists to catch. The rule lives in openAiFamilyNameViolations (src/domain/model-contracts.ts).

const fixture = (alias: string, upstreamModel: string) => ({ alias, upstreamModel });

describe("OpenAI model names are families, not versions", () => {
    it("the shipped contracts hold one row per family and every name is its family", () => {
        const violations = openAiFamilyNameViolations(OPENAI_MODEL_CONTRACTS);
        deepStrictEqual(violations, [], `family-name violations in OPENAI_MODEL_CONTRACTS: ${JSON.stringify(violations)}`);
    });

    it("derives the family as the last dash segment of the model part", () => {
        strictEqual(openAiUpstreamFamily("anthropic-openai-oauth__gpt-6.1-sol"), "sol");
        strictEqual(openAiUpstreamFamily("anthropic-openai-oauth__gpt-6-astra"), "astra");
        strictEqual(openAiUpstreamFamily("gpt-6.1-terra"), "terra");
    });

    it("POSITIVE: a well-formed list is accepted, whatever the versions are", () => {
        const list = [
            fixture("sol", "anthropic-openai-oauth__gpt-6.2-sol"),
            fixture("terra", "anthropic-openai-oauth__gpt-7-terra"),
            fixture("luna", "anthropic-openai-oauth__gpt-6-luna"),
            fixture("astra", "anthropic-openai-oauth__gpt-6-astra"),
        ];
        deepStrictEqual(openAiFamilyNameViolations(list), []);
    });

    it("NEGATIVE: a second row of one family is reported (replace the row, do not add one beside it)", () => {
        const list = [
            fixture("sol", "anthropic-openai-oauth__gpt-6.1-sol"),
            fixture("sol", "anthropic-openai-oauth__gpt-6-sol"),
        ];
        const violations = openAiFamilyNameViolations(list);
        deepStrictEqual(violations.map((entry) => entry.rule), ["family-repeated"]);
        strictEqual(violations[0]?.upstreamModel, "anthropic-openai-oauth__gpt-6-sol");
    });

    it("NEGATIVE: the old habit (a version-suffixed name beside the family name) is reported twice over", () => {
        const list = [
            fixture("sol", "anthropic-openai-oauth__gpt-6.1-sol"),
            fixture("sol6", "anthropic-openai-oauth__gpt-6-sol"),
        ];
        const rules = openAiFamilyNameViolations(list).map((entry) => entry.rule);
        strictEqual(rules.includes("family-repeated"), true, "the second sol row must be reported");
        strictEqual(rules.includes("name-has-digit"), true, "sol6 carries a digit");
    });

    it("NEGATIVE: a name carrying a digit is reported", () => {
        const violations = openAiFamilyNameViolations([fixture("sol61", "anthropic-openai-oauth__gpt-6.1-sol")]);
        strictEqual(violations.some((entry) => entry.rule === "name-has-digit" && entry.name === "sol61"), true);
    });

    it("NEGATIVE: a name that is another family's is reported, and only for that reason", () => {
        const violations = openAiFamilyNameViolations([fixture("luna", "anthropic-openai-oauth__gpt-6.1-sol")]);
        deepStrictEqual(violations.map((entry) => entry.rule), ["name-is-not-family"]);
        strictEqual(violations[0]?.family, "sol");
    });
});
