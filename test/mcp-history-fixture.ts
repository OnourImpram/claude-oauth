// Shared fixture for the MCP-history data rule (audit D2-01). Not a test file: the lane test
// files import it so all four API-key lanes are checked against ONE history and ONE set of
// placeholder strings. Every string below is synthetic.
export const MCP_TOOL = "mcp__claude_ai_Gmail__search_threads";
export const MARKER_INPUT = "MARKER-MCP-INPUT-3f9a1c";
export const MARKER_RESULT = "MARKER-MCP-RESULT-7b2d4e";
export const PLAIN_RESULT = "NOTES-CONTENT-OK";

export function callPlaceholder(name: string): string {
    return `[The assistant called ${name}; the call and its result are withheld on this lane.]`;
}
export function resultPlaceholder(name: string): string {
    return `[Result of ${name} withheld by the router: MCP tool results do not cross to this lane.]`;
}
export const UNIDENTIFIED = "an unidentified tool";

/**
 * An operator who read mail under a Claude model and then switched models mid-conversation:
 * one MCP pair carrying markers, one ordinary Read pair that must survive, and a trailing text
 * block in the same user turn (Claude Code puts tool_result blocks first, text after).
 */
export function mcpHistory(): Record<string, unknown>[] {
    return [
        { role: "user", content: "summarise my unread mail, then read notes.txt" },
        {
            role: "assistant",
            content: [
                { type: "text", text: "Searching." },
                { type: "tool_use", id: "toolu_mcp_1", name: MCP_TOOL, input: { query: MARKER_INPUT } },
                { type: "tool_use", id: "toolu_read_1", name: "Read", input: { file_path: "notes.txt" } },
            ],
        },
        {
            role: "user",
            content: [
                { type: "tool_result", tool_use_id: "toolu_mcp_1", content: [{ type: "text", text: MARKER_RESULT }] },
                { type: "tool_result", tool_use_id: "toolu_read_1", content: PLAIN_RESULT },
                { type: "text", text: "go on" },
            ],
        },
    ];
}
