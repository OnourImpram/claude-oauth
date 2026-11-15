type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The data rule's tool-name prefix: MCP tools reach the operator's connected accounts. */
export const MCP_TOOL_PREFIX = "mcp__";
const UNIDENTIFIED_TOOL = "an unidentified tool";

function callPlaceholder(name: string): JsonRecord {
    return { type: "text", text: `[The assistant called ${name}; the call and its result are withheld on this lane.]` };
}
function resultPlaceholder(name: string): JsonRecord {
    return { type: "text", text: `[Result of ${name} withheld by the router: MCP tool results do not cross to this lane.]` };
}

/**
 * The MCP data rule applied to REPLAYED HISTORY (audit D2-01). Withholding `mcp__*` tool
 * definitions is not enough: a conversation that read mail or Drive files under a Claude model
 * and then switched to an API-key lane (`/model`, the repository records it as a real event,
 * B12) replays the earlier `tool_use` input and the `tool_result` content verbatim -- the data
 * reaches the third-party endpoint without any tool being advertised. ONE function serves both
 * wire shapes (the Anthropic passthrough and the chat-completions translation), so the two
 * cannot drift.
 *
 *   - an assistant `tool_use` whose name starts with a withheld prefix, and a server-side
 *     `mcp_tool_use`, become a text block naming the tool (the input is not carried);
 *   - the `tool_result` answering it (matched by `tool_use_id` across the whole request), and
 *     any `mcp_tool_result`, become a text block naming the tool;
 *   - a `tool_result` that no `tool_use` in the request accounts for (or that has no usable
 *     id) cannot be proven not to be MCP data and is withheld as "an unidentified tool";
 *   - every other block, and every message without such a block, crosses untouched (the SAME
 *     array comes back when nothing is withheld).
 *
 * Order: a result placeholder that would land in front of a surviving `tool_result` is moved
 * behind the last one. Messages wants tool_result blocks first in the user turn, and the
 * chat translation emits a `role:"tool"` message per surviving result -- a user text message in
 * front of it would split the assistant's tool_calls from the tool messages that answer them.
 */
export function withholdMcpHistory(messages: unknown, withheldPrefixes: readonly string[]): unknown {
    if (!Array.isArray(messages))
        return messages;
    const isWithheldName = (name: string): boolean => withheldPrefixes.some((prefix) => name.startsWith(prefix));
    // Pass 1: every tool_use id in the request -> its name, and whether it is withheld.
    const calls = new Map<string, { readonly name: string; readonly withheld: boolean }>();
    for (const message of messages) {
        if (!isRecord(message) || !Array.isArray(message["content"]))
            continue;
        for (const block of message["content"] as unknown[]) {
            if (!isRecord(block) || typeof block["id"] !== "string")
                continue;
            const name = typeof block["name"] === "string" ? block["name"] : UNIDENTIFIED_TOOL;
            if (block["type"] === "tool_use" && typeof block["name"] === "string")
                calls.set(block["id"], { name, withheld: isWithheldName(name) || calls.get(block["id"])?.withheld === true });
            else if (block["type"] === "mcp_tool_use")
                calls.set(block["id"], { name, withheld: true });
        }
    }
    const result: unknown[] = [];
    let changed = false;
    for (const message of messages) {
        if (!isRecord(message) || !Array.isArray(message["content"])) {
            result.push(message);
            continue;
        }
        const blocks: unknown[] = [];
        const placeholderAt = new Set<number>();
        let touched = false;
        for (const block of message["content"] as unknown[]) {
            if (!isRecord(block)) {
                blocks.push(block);
                continue;
            }
            const answered = typeof block["tool_use_id"] === "string" ? calls.get(block["tool_use_id"]) : undefined;
            if (block["type"] === "tool_use" && typeof block["name"] === "string" && isWithheldName(block["name"])) {
                blocks.push(callPlaceholder(block["name"]));
                touched = true;
            }
            else if (block["type"] === "mcp_tool_use") {
                blocks.push(callPlaceholder(typeof block["name"] === "string" ? block["name"] : UNIDENTIFIED_TOOL));
                touched = true;
            }
            else if (block["type"] === "mcp_tool_result" || (block["type"] === "tool_result" && (answered === undefined || answered.withheld))) {
                placeholderAt.add(blocks.length);
                blocks.push(resultPlaceholder(answered?.name ?? UNIDENTIFIED_TOOL));
                touched = true;
            }
            else
                blocks.push(block);
        }
        if (!touched) {
            result.push(message);
            continue;
        }
        changed = true;
        let ordered = blocks;
        let lastSurvivingResult = -1;
        blocks.forEach((block, index) => {
            if (isRecord(block) && block["type"] === "tool_result")
                lastSurvivingResult = index;
        });
        const moved = blocks.filter((_, index) => placeholderAt.has(index) && index < lastSurvivingResult);
        if (moved.length > 0) {
            ordered = blocks.filter((_, index) => !(placeholderAt.has(index) && index < lastSurvivingResult));
            ordered.splice(lastSurvivingResult - moved.length + 1, 0, ...moved);
        }
        result.push({ ...message, content: ordered });
    }
    return changed ? result : messages;
}
