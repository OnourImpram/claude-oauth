// Phase 9 / Path 4 -- the bridge that exposes Claude Code's tools to the ACP agent as MCP.
//
// WHY THIS EXISTS
// The agent-readonly route can only carry TEXT (adapters/agent-model.ts). The
// moment a conversation contains a tool_use or tool_result block it answers 422
// unsupported_feature in 5-6 ms, before any network call -- which is why Grok and
// Gemini could never run a tool loop and why compaction, which resends the whole
// history, could never work on those lanes.
//
// MEASURED 2026-09-01, both providers, via acp initialize:
//     Grok   mcpCapabilities = { http: true, sse: true }          (acp absent)
//     Gemini mcpCapabilities = { acp: false, http: true, sse: true }
// The common transport is HTTP, so ONE server feeds both. MCP-over-ACP would
// have been cheaper but neither provider offers it.
//
// THE SHAPE
// The agent sees Claude Code's tools in its own tool list and calls them. The
// call arrives here. We do NOT execute it -- the tool runs on the Claude Code
// side, with its permission flow and hooks, exactly as spec §6 requires. Instead
// the call is parked, the router answers Claude Code with stop_reason: tool_use,
// and the tool_result of the NEXT request releases the parked call by id.
//
// Anthropic's Messages API is stateless (the whole history arrives every turn);
// an ACP session is stateful (the agent walks its own loop). This module is the
// join between them, so every way the join can break is an explicit state here:
// unmatched result, abandoned call, cancellation, timeout. Nothing is dropped
// silently -- spec §7.3 makes "unmatched tool_result count is zero" the gate.

import { randomUUID } from "node:crypto";

import { RouterError } from "../domain/errors.js";

/** MCP protocol revision this bridge speaks. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AnthropicToolDefinition {
    readonly name: string;
    readonly description?: string;
    readonly input_schema?: unknown;
}

export interface McpToolDescriptor {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
}

/** A tool call the agent made and that Claude Code has not answered yet. */
export interface ParkedToolCall {
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
}

export type ToolCallOutcome =
    | { readonly kind: "result"; readonly content: string; readonly isError: boolean }
    | { readonly kind: "cancelled"; readonly reason: string };

interface Bekleyen {
    readonly call: ParkedToolCall;
    readonly cozumle: (outcome: ToolCallOutcome) => void;
    readonly zamanlayici: NodeJS.Timeout | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Anthropic tool definitions -> MCP tool descriptors.
 *
 * A tool with no schema still gets an object schema: MCP clients reject a tool
 * whose inputSchema is absent or not an object, and a silently dropped tool is
 * worse than a permissive one -- the agent would simply never see it.
 */
export function deriveMcpTools(
    tools: readonly AnthropicToolDefinition[] | undefined,
): readonly McpToolDescriptor[] {
    if (tools === undefined) return [];
    const gorulen = new Set<string>();
    const cikti: McpToolDescriptor[] = [];
    for (const tool of tools) {
        const name = typeof tool?.name === "string" ? tool.name.trim() : "";
        if (name === "") {
            throw new RouterError("invalid_request", "Each tool must have a non-empty name.", 400);
        }
        // Duplicate names would make a call ambiguous, and ambiguity here means
        // running the WRONG tool. Refuse rather than pick one.
        if (gorulen.has(name)) {
            throw new RouterError("invalid_request", `Duplicate tool name: ${name}.`, 400);
        }
        gorulen.add(name);
        const schema = isRecord(tool.input_schema)
            ? (tool.input_schema as Record<string, unknown>)
            : { type: "object", properties: {} };
        cikti.push({
            name,
            description: typeof tool.description === "string" ? tool.description : "",
            inputSchema: schema,
        });
    }
    return cikti;
}

export interface ToolBridgeOptions {
    /** Fires when the agent calls a tool, so the caller can end the turn. */
    readonly onToolCall: (call: ParkedToolCall) => void;
    /** How long a parked call may wait for its tool_result. */
    readonly callTimeoutMs?: number;
}

/**
 * The MCP server side of the bridge, transport-free.
 *
 * Kept free of HTTP on purpose: a defect that only shows up behind a socket is
 * a defect the suite cannot hold, which is exactly how the Gemini telemetry
 * failure survived -- it lived only in a spawned child.
 */
export class McpToolBridge {
    #tools: readonly McpToolDescriptor[] = [];
    #bekleyenler = new Map<string, Bekleyen>();
    #initialized = false;
    #kapali = false;
    #eslesmeyenSonuc = 0;
    // Calls WE timed out. A late answer to one of these is NOT COUNTED as unmatched:
    // 'work was lost' is one event, 'we gave up' is another. If both are written to the
    // same counter the gate cannot say what it measures.
    #zamanAsimiSonuc = 0;
    readonly #zamanAsimina = new Set<string>();
    readonly #onToolCall: (call: ParkedToolCall) => void;
    readonly #timeoutMs: number;

    constructor(options: ToolBridgeOptions) {
        this.#onToolCall = options.onToolCall;
        this.#timeoutMs = options.callTimeoutMs ?? 600_000;
    }

    /** Replaces the advertised tool set. Claude Code may change it per turn. */
    setTools(tools: readonly McpToolDescriptor[]): void {
        this.#tools = tools;
    }

    get tools(): readonly McpToolDescriptor[] {
        return this.#tools;
    }

    get pendingCount(): number {
        return this.#bekleyenler.size;
    }

    /** spec §7.3 gate: this must be zero at the end of a healthy session. */
    get unmatchedResultCount(): number {
        return this.#eslesmeyenSonuc;
    }

    /** Late answers to calls we dropped ourselves. A SEPARATE measurement. */
    get timedOutResultCount(): number {
        return this.#zamanAsimiSonuc;
    }

    get initialized(): boolean {
        return this.#initialized;
    }

    /**
     * Answer a tool_result coming back from Claude Code.
     * Returns false when nothing was waiting for this id -- counted, never hidden.
     */
    deliverToolResult(id: string, content: string, isError: boolean): boolean {
        const bekleyen = this.#bekleyenler.get(id);
        if (bekleyen === undefined) {
            // If WE dropped this call, a late answer is not lost work.
            if (this.#zamanAsimina.delete(id)) {
                this.#zamanAsimiSonuc += 1;
                return false;
            }
            this.#eslesmeyenSonuc += 1;
            return false;
        }
        this.#bekleyenler.delete(id);
        if (bekleyen.zamanlayici !== undefined) clearTimeout(bekleyen.zamanlayici);
        bekleyen.cozumle({ kind: "result", content, isError });
        return true;
    }

    /** Releases every parked call. Used on cancel, abort and session teardown. */
    cancelAll(reason: string): number {
        const adet = this.#bekleyenler.size;
        for (const [, bekleyen] of this.#bekleyenler) {
            if (bekleyen.zamanlayici !== undefined) clearTimeout(bekleyen.zamanlayici);
            bekleyen.cozumle({ kind: "cancelled", reason });
        }
        this.#bekleyenler.clear();
        this.#kapali = true;
        return adet;
    }

    /** Handles one JSON-RPC message. Returns undefined for notifications. */
    async handle(message: unknown): Promise<Record<string, unknown> | undefined> {
        if (!isRecord(message)) {
            return this.#hata(null, -32600, "Invalid Request");
        }
        const method = message["method"];
        const id = message["id"] ?? null;
        if (typeof method !== "string") {
            return this.#hata(id, -32600, "Invalid Request");
        }
        // Notifications carry no id and must never get a response body.
        const bildirim = message["id"] === undefined;

        switch (method) {
            case "initialize": {
                this.#initialized = true;
                return this.#sonuc(id, {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: "hezarfen-claude-code-tools", version: "1.0.0" },
                });
            }
            case "notifications/initialized":
                return undefined;
            case "ping":
                return bildirim ? undefined : this.#sonuc(id, {});
            case "tools/list": {
                return this.#sonuc(id, {
                    tools: this.#tools.map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                    })),
                });
            }
            case "tools/call": {
                const outcome = await this.#cagir(message["params"]);
                if (outcome.kind === "cancelled") {
                    return this.#hata(id, -32001, `Tool call cancelled: ${outcome.reason}`);
                }
                return this.#sonuc(id, {
                    content: [{ type: "text", text: outcome.content }],
                    isError: outcome.isError,
                });
            }
            default:
                return bildirim ? undefined : this.#hata(id, -32601, `Method not found: ${method}`);
        }
    }

    async #cagir(params: unknown): Promise<ToolCallOutcome> {
        if (this.#kapali) {
            return { kind: "cancelled", reason: "bridge closed" };
        }
        if (!isRecord(params) || typeof params["name"] !== "string") {
            return { kind: "cancelled", reason: "malformed tools/call params" };
        }
        const name = params["name"];
        if (!this.#tools.some((tool) => tool.name === name)) {
            return { kind: "cancelled", reason: `unknown tool: ${name}` };
        }
        const input = isRecord(params["arguments"])
            ? (params["arguments"] as Record<string, unknown>)
            : {};
        // The id is ours, not the agent's: it becomes the tool_use.id Claude Code
        // sees and the tool_result id it sends back, so it must be unique across
        // the whole session, not just this ACP turn.
        const id = `mcp_${randomUUID().replace(/-/gu, "").slice(0, 24)}`;
        const call: ParkedToolCall = { id, name, input };

        return await new Promise<ToolCallOutcome>((cozumle) => {
            const zamanlayici =
                this.#timeoutMs > 0
                    ? setTimeout(() => {
                          if (this.#bekleyenler.delete(id)) {
                              this.#zamanAsimina.add(id);
                              cozumle({ kind: "cancelled", reason: "tool result timed out" });
                          }
                      }, this.#timeoutMs)
                    : undefined;
            zamanlayici?.unref?.();
            this.#bekleyenler.set(id, { call, cozumle, zamanlayici });
            // Told AFTER parking: the caller may answer synchronously in a test,
            // and a result arriving before the entry exists would be counted as
            // unmatched -- the very number spec §7.3 gates on.
            this.#onToolCall(call);
        });
    }

    #sonuc(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
        return { jsonrpc: "2.0", id, result };
    }

    #hata(id: unknown, code: number, message: string): Record<string, unknown> {
        return { jsonrpc: "2.0", id, error: { code, message } };
    }
}
