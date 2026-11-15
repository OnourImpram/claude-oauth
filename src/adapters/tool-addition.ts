type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ToolAdditionFold {
    /** `messages` without any tool_addition block; the SAME value when none was present. */
    readonly messages: unknown;
    /** Definitions to join the outgoing tools: first of each name, not already known, not withheld. */
    readonly definitions: readonly JsonRecord[];
    /** At least one tool_addition block was removed (also true for a malformed or withheld one). */
    readonly sawToolAddition: boolean;
}

/**
 * Folds `tool_addition` blocks out of `messages`. Claude Code (with the
 * `mid-conversation-tool-changes-2026-07-01` / `inline-tools-2026-09-15` betas) puts them inside
 * a `role: "system"` message mixed with text. Alibaba's Anthropic endpoint answers the WHOLE body
 * HTTP 400 `InvalidParameter` while even one is present (MEASURED 2026-11-09, evidence
 * `tasks/2026-11-09-router-alibaba-zai/kanit/bisect/bisect3-router-govde.json` and
 * `bisect3-router-govde1-defer.json`: the forwarded body 400, the same body with only the
 * `tool_addition` blocks removed 200). The chat-completions lane (OpenAI API) did not
 * 400, but turned each block into the text "[tool_addition block omitted by the router]" in the
 * system prompt and never offered the tool (audit D2-03: a deferred tool Claude Code loads
 * mid-conversation was unreachable), so it folds through this same function.
 *
 * Each removed block whose `tool.definition.name` is a string yields its `definition` (the
 * block's `cache_control` is not copied), unless the name starts with a withheld prefix (the
 * data rule of the `tools` array) or is already in `knownNames` or was yielded before. A message
 * whose content array becomes empty is dropped; every other block and message crosses untouched.
 * Any other unknown block type is deliberately left as-is: no semantics are invented for shapes
 * that have not been measured.
 */
export function foldToolAdditions(messages: unknown, knownNames: ReadonlySet<string>, withheldPrefixes: readonly string[]): ToolAdditionFold {
    if (!Array.isArray(messages))
        return { messages, definitions: [], sawToolAddition: false };
    const known = new Set(knownNames);
    const definitions: JsonRecord[] = [];
    const folded: unknown[] = [];
    let sawToolAddition = false;
    for (const message of messages) {
        if (!isRecord(message) || !Array.isArray(message["content"])) {
            folded.push(message);
            continue;
        }
        const blocks = message["content"] as unknown[];
        const kept: unknown[] = [];
        for (const block of blocks) {
            if (!isRecord(block) || block["type"] !== "tool_addition") {
                kept.push(block);
                continue;
            }
            sawToolAddition = true;
            const tool = isRecord(block["tool"]) ? block["tool"] : undefined;
            const definition = tool !== undefined && isRecord(tool["definition"]) && typeof tool["definition"]["name"] === "string" ? tool["definition"] : undefined;
            if (definition !== undefined) {
                const name = definition["name"] as string;
                if (!withheldPrefixes.some((prefix) => name.startsWith(prefix)) && !known.has(name)) {
                    definitions.push(definition);
                    known.add(name);
                }
            }
        }
        if (kept.length === 0)
            continue; // a message made only of tool_addition blocks disappears
        folded.push(kept.length === blocks.length ? message : { ...message, content: kept });
    }
    return { messages: sawToolAddition ? folded : messages, definitions, sawToolAddition };
}
