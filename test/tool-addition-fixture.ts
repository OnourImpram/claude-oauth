// Shared fixture for the tool_addition fold on the chat-completions lane (audit D2-03):
// the OpenAI API lane is checked against this history and these expectations.
export function toolAddition(name: string, withCacheControl: boolean = false): Record<string, unknown> {
    return {
        type: "tool_addition",
        tool: { type: "tool_definition", definition: { name, description: `${name} description`, input_schema: { type: "object", properties: {} } } },
        ...(withCacheControl ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}),
    };
}

/** Claude Code's mid-conversation tool change: a system message mixing text with tool_addition blocks, then one made only of them. */
export function toolAdditionHistory(): Record<string, unknown>[] {
    return [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
            role: "system",
            content: [
                { type: "text", text: "skill catalogue" },
                toolAddition("mcp__claude_ai_Gmail__search_threads"),
                toolAddition("Lookup", true),
                toolAddition("Bash"),
            ],
        },
        { role: "system", content: [toolAddition("OnlyToolsHere")] },
    ];
}

export const TOOL_ADDITION_ENVELOPE_TOOLS = [
    { name: "Bash", description: "bash", input_schema: { type: "object", properties: {} } },
    { name: "mcp__playwright__browser_snapshot", input_schema: { type: "object", properties: {} } },
];

export type WireBody = {
    messages: { role: string; content: unknown }[];
    tools?: { type: string; function: { name: string; description?: string } }[];
    tool_choice?: unknown;
};
