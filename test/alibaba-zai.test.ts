import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import {
    ALIBABA_KEY_FILE_VARIABLE,
    ALIBABA_KEY_VARIABLE,
    ALIBABA_LANE,
    ZAI_BALANCE_CODE,
    ZAI_KEY_FILE_VARIABLE,
    ZAI_KEY_VARIABLE,
    ZAI_LANE,
    AnthropicApiKeyAdapter,
    passthroughEnvelope,
} from "../src/adapters/anthropic-api-key.js";
import { resolveRouterOwnedKey } from "../src/adapters/router-key-file.js";
import type { HttpTransport, HttpTransportRequest, MessageEnvelope, ModelRecord, ModelSnapshot, ProviderAdapter, ProviderId } from "../src/domain/contracts.js";
import { PROVIDER_IDS } from "../src/domain/contracts.js";
import { RouterError } from "../src/domain/errors.js";
import { ALIBABA_MODEL_CONTRACTS, ZAI_MODEL_CONTRACTS, autoCompactWindowForModel } from "../src/domain/model-contracts.js";
import { withVerifiedAlibabaModels, withVerifiedZaiModels } from "../src/domain/model-refresh.js";
import { ModelRegistry, claudeClientDiscoveryId } from "../src/domain/registry.js";
import { API_KEY_PROVIDERS, parseModelSnapshot } from "../src/domain/validation.js";
import { ROUTER_OWNED_SECRET_VARIABLES, sanitizedClaudeEnvironment, sanitizedWorkerEnvironment } from "../src/security/environment.js";
import { FixedOriginFetchTransport } from "../src/ports/fetch-transport.js";
import { MARKER_INPUT, MARKER_RESULT, MCP_TOOL, PLAIN_RESULT, callPlaceholder, mcpHistory, resultPlaceholder } from "./mcp-history-fixture.js";

// Synthetic credentials: not real keys, exist only in this file.
const TEST_KEY = "alibaba-unit-test-placeholder-not-a-key";
const TEST_KEY_ZAI = "zai-unit-test-placeholder-not-a-key";

const ALIBABA_UPSTREAM_IDS = ALIBABA_MODEL_CONTRACTS.map((entry) => entry.upstreamModel);
const ZAI_UPSTREAM_IDS = ZAI_MODEL_CONTRACTS.map((entry) => entry.upstreamModel);

const baseline: ModelSnapshot = { schemaVersion: 1, generatedAt: "2026-11-09T00:00:00.000Z", source: "test", models: [] };

function alibabaRow(upstreamModel: string): ModelRecord {
    const snapshot = withVerifiedAlibabaModels(baseline, ALIBABA_UPSTREAM_IDS);
    const row = snapshot.models.find((entry) => entry.upstreamModel === upstreamModel);
    if (row === undefined)
        throw new Error(`no row for ${upstreamModel}`);
    return row;
}

function zaiRow(upstreamModel: string): ModelRecord {
    const snapshot = withVerifiedZaiModels(baseline, ZAI_UPSTREAM_IDS);
    const row = snapshot.models.find((entry) => entry.upstreamModel === upstreamModel);
    if (row === undefined)
        throw new Error(`no row for ${upstreamModel}`);
    return row;
}

function request(model: ModelRecord, envelope: Partial<MessageEnvelope>, path: "/v1/messages" | "/v1/messages/count_tokens" = "/v1/messages", headers: Headers = new Headers()): AdapterRequestish {
    return {
        requestId: "req-1",
        path,
        query: "",
        model,
        envelope: { model: model.id, messages: [{ role: "user", content: "hi" }], stream: true, ...envelope } as MessageEnvelope,
        body: new Uint8Array(),
        headers,
        signal: AbortSignal.timeout(5_000),
    };
}
type AdapterRequestish = Parameters<AnthropicApiKeyAdapter["send"]>[0];

// The client request arrives carrying Claude OAuth credentials; the lane must NOT forward them.
const OAUTH_HEADERS = new Headers({
    authorization: "Bearer fake-oauth-token",
    "anthropic-beta": "oauth-2025-04-20,context-1m-2025-08-07",
    "content-type": "application/json",
});

function capturingTransport(sink: { sent: HttpTransportRequest[] }, reply: () => Response): HttpTransport {
    return {
        send: async (sent) => {
            sink.sent.push(sent);
            return reply();
        },
    };
}

function anthropicSse(events: readonly unknown[]): string {
    return `${events.map((event) => {
        const kind = typeof event === "string" ? event : (event as { type: string })["type"];
        return `event: ${kind}\ndata: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;
    }).join("")}`;
}

const PONG_SSE = anthropicSse([
    { type: "message_start", message: { id: "msg_alibaba_1", type: "message", role: "assistant", model: "x", content: [], usage: { input_tokens: 17, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 17, output_tokens: 5 } },
    { type: "message_stop" },
]);

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
    ok(stream !== null);
    return await new Response(stream).text();
}

function adapter(sink: { sent: HttpTransportRequest[] }, lane: typeof ALIBABA_LANE | typeof ZAI_LANE, reply: () => Response = () => new Response(PONG_SSE, { status: 200, headers: { "content-type": "text/event-stream" } }), key: string = TEST_KEY): AnthropicApiKeyAdapter {
    return new AnthropicApiKeyAdapter(capturingTransport(sink, reply), lane, { [lane.keyVariable]: key });
}

describe("alibaba / zai: pin pattern and contracts", () => {
    it("PIN: the provider id list carries the three new API-key lanes", () => {
        for (const id of ["alibaba", "zai", "openaiapi"] as const)
            ok((PROVIDER_IDS as readonly string[]).includes(id), id);
    });
    it("PIN: the api-key credential class is exactly alibaba, zai and openaiapi", () => {
        deepStrictEqual([...API_KEY_PROVIDERS].sort(), ["alibaba", "openaiapi", "zai"]);
    });
    // Curated 2026-11-15 (operator: keep the lane to models worth routing to). The live list
    // still carries the seven removed ids; they are older generations or dated snapshots of rows
    // that stay. qwen4-max-preview is new in the live list and answered a live probe.
    it("alibaba carries exactly the seven curated chat models, zai exactly the two requested", () => {
        deepStrictEqual(ALIBABA_UPSTREAM_IDS, [
            "qwen4-max-preview", "qwen3.8-max", "qwen3.8-flash",
            "glm-5.3", "deepseek-v4-pro", "deepseek-v4.1-flash", "auto",
        ]);
        deepStrictEqual(ZAI_UPSTREAM_IDS, ["glm-5.3", "glm-5.3-flash"]);
    });
    it("display names name the provider; glm-5.3 stays distinguishable across Alibaba and Z.AI", () => {
        for (const contract of ALIBABA_MODEL_CONTRACTS)
            ok(contract.displayName.endsWith("(Alibaba)"), contract.id);
        strictEqual(ZAI_MODEL_CONTRACTS.find((entry) => entry.upstreamModel === "glm-5.3")?.displayName, "GLM 5.3 Max (Z.AI)");
        strictEqual(ZAI_MODEL_CONTRACTS.find((entry) => entry.upstreamModel === "glm-5.3-flash")?.displayName, "GLM 5.3 Flash (Z.AI)");
        const ids = new Set([...ALIBABA_MODEL_CONTRACTS.map((entry) => entry.id), ...ZAI_MODEL_CONTRACTS.map((entry) => entry.id)]);
        strictEqual(ids.size, ALIBABA_MODEL_CONTRACTS.length + ZAI_MODEL_CONTRACTS.length, "no id collision across the two glm-5.3 lanes");
        strictEqual(ids.has("anthropic-alibaba-glm-5.3"), true);
        strictEqual(ids.has("anthropic-zai-glm-5.3"), true);
    });
    it("every unsourced window is the [UNVERIFIED] conservative default and says so", () => {
        for (const contract of [...ALIBABA_MODEL_CONTRACTS, ...ZAI_MODEL_CONTRACTS]) {
            strictEqual(contract.contextWindow, 262_144, contract.id);
            strictEqual(contract.autoCompactWindow, 200_000, contract.id);
            ok(contract.contextWindowSource.includes("[UNVERIFIED]"), contract.id);
            ok(autoCompactWindowForModel(contract.id) !== undefined && autoCompactWindowForModel(contract.id)! < contract.contextWindow, contract.id);
        }
    });
});

describe("alibaba / zai: snapshot derivation (catalog validation)", () => {
    it("a full live model list yields 7 + 2 rows with contract windows and the api-key credential", () => {
        const alibaba = withVerifiedAlibabaModels(baseline, [...ALIBABA_UPSTREAM_IDS, "wan2.7-image", "qwen3.7-max", "glm-5.2", "deepseek-v4-pro-0813"]);
        strictEqual(alibaba.models.length, 7);
        strictEqual(alibaba.models.some((row) => ["qwen3.7-max", "glm-5.2", "deepseek-v4-pro-0813"].includes(row.upstreamModel)), false, "a live id without a contract row is not admitted");
        ok(alibaba.models.every((row) => row.provider === "alibaba" && row.oauthType === "api-key" && row.executionMode === "native-message-loop" && row.discoverable && row.contextWindow === 262_144));
        const zai = withVerifiedZaiModels(baseline, [...ZAI_UPSTREAM_IDS, "glm-4.7"]);
        strictEqual(zai.models.length, 2);
        // The 7 media models on Alibaba's list are NOT admitted: only contracted chat rows enter.
        strictEqual(alibaba.models.some((row) => row.upstreamModel === "wan2.7-image"), false);
        strictEqual(zai.models.some((row) => row.upstreamModel === "glm-4.7"), false);
    });
    it("NEGATIVE: an empty live list (no key, no answer) produces NO rows and drops stale ones", () => {
        const stale = withVerifiedAlibabaModels(baseline, ALIBABA_UPSTREAM_IDS);
        strictEqual(withVerifiedAlibabaModels(stale, []).models.length, 0);
    });
    it("NEGATIVE: a model missing from the live list is not admitted", () => {
        const snapshot = withVerifiedAlibabaModels(baseline, ALIBABA_UPSTREAM_IDS.filter((id) => id !== "auto"));
        strictEqual(snapshot.models.some((row) => row.upstreamModel === "auto"), false);
        strictEqual(snapshot.models.length, ALIBABA_UPSTREAM_IDS.length - 1);
    });
    it("rows survive the snapshot parser (disk round trip); the parser refuses credential mix-ups", () => {
        const snapshot = withVerifiedAlibabaModels(withVerifiedZaiModels(baseline, ZAI_UPSTREAM_IDS), ALIBABA_UPSTREAM_IDS);
        strictEqual(parseModelSnapshot(JSON.parse(JSON.stringify(snapshot))).models.length, ALIBABA_UPSTREAM_IDS.length + ZAI_UPSTREAM_IDS.length);
        const row = JSON.parse(JSON.stringify(alibabaRow("glm-5.3"))) as Record<string, unknown>;
        const wrap = (model: Record<string, unknown>): unknown => ({ ...baseline, models: [model] });
        let threw = false;
        try { parseModelSnapshot(wrap({ ...row, oauthType: "claude.ai" })); } catch { threw = true; }
        strictEqual(threw, true, "alibaba with an OAuth credential must be refused");
        threw = false;
        try { parseModelSnapshot(wrap({ ...row, provider: "openai" })); } catch { threw = true; }
        strictEqual(threw, true, "an OAuth lane claiming the api-key credential must be refused");
    });
});

describe("alibaba / zai: discovery (/model picker)", () => {
    const snapshot = withVerifiedZaiModels(withVerifiedAlibabaModels(baseline, ALIBABA_UPSTREAM_IDS), ZAI_UPSTREAM_IDS);
    const adapters = new Map<ProviderId, ProviderAdapter>([["alibaba", adapter({ sent: [] }, ALIBABA_LANE)], ["zai", adapter({ sent: [] }, ZAI_LANE, undefined as never, TEST_KEY_ZAI)]]);
    const registry = new ModelRegistry(snapshot, adapters);
    it("lists all 15 rows; no unverified row takes the [1m] suffix (262k is below the 1M bucket)", () => {
        const payload = registry.discoveryPayload() as { data: { id: string }[] };
        deepStrictEqual(payload.data.map((entry) => entry.id).sort(), [...ALIBABA_MODEL_CONTRACTS, ...ZAI_MODEL_CONTRACTS].map((entry) => entry.id).sort());
        ok(payload.data.every((entry) => !entry.id.includes("[1m]")));
    });
    it("full ids resolve to their own lane's row", () => {
        strictEqual(registry.resolve("anthropic-alibaba-glm-5.3").model.provider, "alibaba");
        strictEqual(registry.resolve("anthropic-zai-glm-5.3").model.provider, "zai");
        strictEqual(claudeClientDiscoveryId(alibabaRow("glm-5.3")), "anthropic-alibaba-glm-5.3");
    });
});

describe("alibaba / zai adapter: passthrough, auth header, data rule", () => {
    it("sends the key as x-api-key with a fresh header set: no authorization, no anthropic-beta, anthropic-version set", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const response = await adapter(sink, ALIBABA_LANE).send(request(alibabaRow("glm-5.3"), {}));
        await readAll(response.body);
        const sent = sink.sent[0];
        strictEqual(sent?.path, "/apps/anthropic/v1/messages");
        strictEqual(sent?.method, "POST");
        strictEqual(sent?.headers.get("x-api-key"), TEST_KEY);
        strictEqual(sent?.headers.get("authorization"), null, "OAuth authorization must not leak");
        strictEqual(sent?.headers.get("anthropic-beta"), null, "client beta flags (oauth) must not leak");
        strictEqual(sent?.headers.get("anthropic-version"), "2023-06-01");
    });
    it("NEGATIVE (OAuth leak arm): a request carrying Claude OAuth headers forwards none of them", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const carrying = request(alibabaRow("qwen3.8-max"), {}, "/v1/messages", OAUTH_HEADERS);
        await readAll((await adapter(sink, ALIBABA_LANE).send(carrying)).body);
        const sent = sink.sent[0];
        strictEqual(sent?.headers.get("authorization"), null);
        strictEqual(sent?.headers.get("anthropic-beta"), null);
        deepStrictEqual([...(sent?.headers.keys() ?? [])].sort(), ["accept", "anthropic-version", "content-type", "x-api-key"]);
    });
    it("the envelope passes through with the model swapped and metadata dropped", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const envelope: Partial<MessageEnvelope> = { system: [{ type: "text", text: "sys" }], metadata: { user_id: "user_abc" }, max_tokens: 512 };
        await readAll((await adapter(sink, ZAI_LANE, undefined as never, TEST_KEY_ZAI).send(request(zaiRow("glm-5.3"), envelope))).body);
        const body = JSON.parse(Buffer.from(sink.sent[0]?.body ?? "").toString("utf8")) as Record<string, unknown>;
        strictEqual(body["model"], "glm-5.3");
        strictEqual(body["metadata"], undefined, "client metadata (user id) must not reach the provider");
        deepStrictEqual(body["system"], [{ type: "text", text: "sys" }]);
        strictEqual(body["max_tokens"], 512);
        strictEqual(body["stream"], true);
    });
    it("passthroughEnvelope swaps the model, drops metadata and keeps everything else", () => {
        const mapped = passthroughEnvelope({ model: "anthropic-zai-glm-5.3", metadata: { user_id: "x" }, max_tokens: 8, messages: [{ role: "user", content: "hi" }] } as MessageEnvelope, "glm-5.3-flash");
        strictEqual(mapped.model, "glm-5.3-flash");
        strictEqual(mapped["metadata"], undefined);
        strictEqual(mapped["max_tokens"], 8);
    });
    it("DATA RULE: mcp__* tools are never advertised; other tools pass through untouched", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const tools = [
            { name: "Read", description: "read", input_schema: { type: "object", properties: {} } },
            { name: "mcp__claude_ai_Gmail__search_threads", input_schema: { type: "object", properties: {} } },
            { name: "mcp__playwright__browser_snapshot", input_schema: { type: "object", properties: {} } },
        ];
        await readAll((await adapter(sink, ALIBABA_LANE).send(request(alibabaRow("deepseek-v4-pro"), { tools, tool_choice: { type: "auto" } }))).body);
        const body = JSON.parse(Buffer.from(sink.sent[0]?.body ?? "").toString("utf8")) as Record<string, unknown>;
        const sentTools = body["tools"] as { name: string; description: string }[];
        deepStrictEqual(sentTools.map((tool) => tool.name), ["Read"]);
        strictEqual(sentTools[0]?.description, "read", "the tool definition is not rewritten on a passthrough lane");
    });
    it("NEGATIVE: with only mcp__* tools, tools and tool_choice are dropped entirely", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const tools = [{ name: "mcp__claude_ai_Google_Drive__search_files", input_schema: { type: "object" } }];
        await readAll((await adapter(sink, ZAI_LANE, undefined as never, TEST_KEY_ZAI).send(request(zaiRow("glm-5.3-flash"), { tools, tool_choice: { type: "any" } }))).body);
        const body = JSON.parse(Buffer.from(sink.sent[0]?.body ?? "").toString("utf8")) as Record<string, unknown>;
        strictEqual(body["tools"], undefined);
        strictEqual(body["tool_choice"], undefined);
    });
    it("streaming passes the SSE bytes through unchanged while the completion settles id and usage", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const response = await adapter(sink, ALIBABA_LANE).send(request(alibabaRow("glm-5.3"), {}));
        const text = await readAll(response.body);
        strictEqual(text, PONG_SSE, "byte-identical passthrough");
        const completion = await response.completion;
        strictEqual(completion?.providerRequestId, "msg_alibaba_1");
        deepStrictEqual(completion?.usage, { input_tokens: 17, output_tokens: 5 });
    });
    it("non-streaming passes the body through and reports id and usage", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const body = { id: "msg_zai_9", type: "message", role: "assistant", model: "glm-5.3", content: [{ type: "text", text: "pong" }], stop_reason: "end_turn", usage: { input_tokens: 11, output_tokens: 3 } };
        const response = await adapter(sink, ZAI_LANE, () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }), TEST_KEY_ZAI)
            .send(request(zaiRow("glm-5.3"), { stream: false }));
        strictEqual(await readAll(response.body), JSON.stringify(body));
        strictEqual(response.providerRequestId, "msg_zai_9");
        deepStrictEqual(response.usage, { input_tokens: 11, output_tokens: 3 });
    });
    it("count_tokens is answered locally, nothing is sent", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const response = await adapter(sink, ALIBABA_LANE).send(request(alibabaRow("auto"), {}, "/v1/messages/count_tokens"));
        ok((JSON.parse(await readAll(response.body)) as { input_tokens: number }).input_tokens > 0);
        strictEqual(sink.sent.length, 0);
    });
    it("a model from another lane is refused by name (no cross-lane send)", async () => {
        await rejects(adapter({ sent: [] }, ALIBABA_LANE).send(request(zaiRow("glm-5.3"), {})), (error: unknown) => error instanceof RouterError && error.code === "model_not_available");
    });
});

describe("alibaba / zai: MCP data in replayed history never reaches the wire (audit D2-01)", () => {
    for (const [name, lane, row, key] of [
        ["alibaba", ALIBABA_LANE, () => alibabaRow("glm-5.3"), TEST_KEY],
        ["zai", ZAI_LANE, () => zaiRow("glm-5.3"), TEST_KEY_ZAI],
    ] as const) {
        it(`${name}: an mcp__ tool_use and its tool_result become text blocks in place; the ordinary Read pair crosses unchanged`, async () => {
            const sink = { sent: [] as HttpTransportRequest[] };
            await readAll((await adapter(sink, lane, undefined as never, key).send(request(row(), { messages: mcpHistory() }))).body);
            const wire = Buffer.from(sink.sent[0]?.body ?? "").toString("utf8");
            strictEqual(wire.includes(MARKER_INPUT), false, "the MCP call input is not on the wire");
            strictEqual(wire.includes(MARKER_RESULT), false, "the MCP result is not on the wire");
            strictEqual(wire.includes("toolu_mcp_1"), false, "no tool_use id of the withheld pair is on the wire");
            const body = JSON.parse(wire) as { messages: { role: string; content: unknown }[] };
            deepStrictEqual(body.messages[1]?.content, [
                { type: "text", text: "Searching." },
                { type: "text", text: callPlaceholder(MCP_TOOL) },
                { type: "tool_use", id: "toolu_read_1", name: "Read", input: { file_path: "notes.txt" } },
            ]);
            deepStrictEqual(body.messages[2]?.content, [
                { type: "tool_result", tool_use_id: "toolu_read_1", content: PLAIN_RESULT },
                { type: "text", text: resultPlaceholder(MCP_TOOL) },
                { type: "text", text: "go on" },
            ], "the surviving tool_result stays first in the user turn; the placeholder follows it");
        });
    }
});

describe("alibaba / zai: tool_addition blocks are folded out of messages (the measured 400)", () => {
    // MEASURED 2026-11-09 (kanit/bisect/bisect3-router-govde{,1-defer}.json): Claude Code with the
    // mid-conversation-tool-changes / inline-tools betas puts a role:"system" message INSIDE
    // messages whose content mixes text with tool_addition blocks; Alibaba answers the whole
    // forwarded body HTTP 400 InvalidParameter. Only tool_addition removal turns the 400 into 200.
    const toolAddition = (name: string, withCacheControl: boolean = false): Record<string, unknown> => ({
        type: "tool_addition",
        tool: { type: "tool_definition", definition: { name, description: `${name} description`, input_schema: { type: "object", properties: {} } } },
        ...(withCacheControl ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}),
    });
    const fixture = (): { messages: Record<string, unknown>[]; tools: Record<string, unknown>[] } => ({
        messages: [
            { role: "user", content: [{ type: "text", text: "first user turn" }] },
            {
                role: "system",
                content: [
                    { type: "text", text: "skill catalogue and reminders" },
                    toolAddition("mcp__claude_ai_Gmail__search_threads"),
                    toolAddition("Lookup"),
                    toolAddition("LookupAgain", true),
                ],
            },
            { role: "assistant", content: [{ type: "text", text: "assistant turn" }] },
            { role: "system", content: [toolAddition("OnlyToolsHere")] },
        ],
        tools: [
            { name: "Bash", description: "bash", input_schema: { type: "object", properties: {} } },
            { name: "mcp__playwright__browser_snapshot", input_schema: { type: "object", properties: {} } },
        ],
    });
    it("no tool_addition block survives anywhere; folded non-mcp definitions join tools exactly once, mcp__ ones are withheld", () => {
        const source = fixture();
        const mapped = passthroughEnvelope({ model: "anthropic-alibaba-glm-5.3", messages: source.messages, tools: source.tools, tool_choice: { type: "auto" } } as MessageEnvelope, "glm-5.3");
        strictEqual(JSON.stringify(mapped).includes("tool_addition"), false, "no block of type tool_addition anywhere in the output");
        const tools = mapped["tools"] as { name: string; description?: string; cache_control?: unknown }[];
        deepStrictEqual(tools.map((tool) => tool.name), ["Bash", "Lookup", "LookupAgain", "OnlyToolsHere"]);
        strictEqual(tools.filter((tool) => tool.name === "Lookup").length, 1, "Lookup appears exactly once");
        strictEqual(tools.some((tool) => tool.name.startsWith("mcp__")), false, "no mcp__ name in tools");
        strictEqual(tools.find((tool) => tool.name === "LookupAgain")?.description, "LookupAgain description", "the tool's definition is folded, not the block");
        strictEqual(tools.find((tool) => tool.name === "LookupAgain")?.cache_control, undefined, "the block's cache_control is not copied");
        strictEqual(mapped["tool_choice"] !== undefined, true, "tool_choice survives while tools remain");
    });
    it("the system text block survives in place; a message made only of tool_addition blocks disappears; other messages are untouched", () => {
        const source = fixture();
        const mapped = passthroughEnvelope({ model: "anthropic-alibaba-glm-5.3", messages: source.messages, tools: source.tools } as MessageEnvelope, "glm-5.3");
        const messages = mapped["messages"] as { role: string; content: unknown }[];
        deepStrictEqual(messages.map((message) => message.role), ["user", "system", "assistant"], "the all-tool_addition message is dropped, order preserved");
        deepStrictEqual(messages[1]?.content, [{ type: "text", text: "skill catalogue and reminders" }], "the system text block survives in place");
        deepStrictEqual(messages[0]?.content, [{ type: "text", text: "first user turn" }], "untouched message crosses untouched");
        deepStrictEqual(messages[2]?.content, [{ type: "text", text: "assistant turn" }], "untouched message crosses untouched");
        strictEqual(JSON.stringify(messages[1]).includes("cache_control"), false, "cache_control lived only on a removed block");
    });
    it("a duplicate-name tool_addition does not create a second tools entry", () => {
        const messages: Record<string, unknown>[] = [
            { role: "system", content: [{ type: "text", text: "s" }, toolAddition("Bash"), toolAddition("Bash")] },
        ];
        const mapped = passthroughEnvelope({ model: "anthropic-alibaba-glm-5.3", messages, tools: [{ name: "Bash", input_schema: { type: "object" } }] } as MessageEnvelope, "glm-5.3");
        const tools = mapped["tools"] as { name: string }[];
        strictEqual(tools.filter((tool) => tool.name === "Bash").length, 1);
        deepStrictEqual((mapped["messages"] as { content: unknown }[])[0]?.content, [{ type: "text", text: "s" }]);
    });
    it("NEGATIVE: when everything is withheld, tools and tool_choice are still deleted (the existing rule)", () => {
        const messages: Record<string, unknown>[] = [
            { role: "user", content: [{ type: "text", text: "hi" }] },
            { role: "system", content: [{ type: "text", text: "s" }, toolAddition("mcp__claude_ai_Gmail__search_threads")] },
        ];
        const mapped = passthroughEnvelope({ model: "anthropic-alibaba-glm-5.3", messages, tools: [{ name: "mcp__playwright__browser_snapshot", input_schema: { type: "object" } }], tool_choice: { type: "auto" } } as MessageEnvelope, "glm-5.3");
        strictEqual(mapped["tools"], undefined);
        strictEqual(mapped["tool_choice"], undefined);
        deepStrictEqual((mapped["messages"] as { content: unknown }[])[1]?.content, [{ type: "text", text: "s" }]);
    });
    it("a tool_addition with no tools array still folds its definition into a new tools array", () => {
        const messages: Record<string, unknown>[] = [
            { role: "user", content: [{ type: "text", text: "hi" }] },
            { role: "system", content: [{ type: "text", text: "s" }, toolAddition("Lookup")] },
        ];
        const mapped = passthroughEnvelope({ model: "anthropic-alibaba-glm-5.3", messages } as MessageEnvelope, "glm-5.3");
        deepStrictEqual((mapped["tools"] as { name: string }[]).map((tool) => tool.name), ["Lookup"]);
    });
    it("a malformed tool_addition (no definition) is removed without inventing a tool and without failing", () => {
        const messages: Record<string, unknown>[] = [
            { role: "system", content: [{ type: "tool_addition", tool: "not-a-record" }, { type: "text", text: "s" }] },
        ];
        const mapped = passthroughEnvelope({ model: "anthropic-alibaba-glm-5.3", messages } as MessageEnvelope, "glm-5.3");
        strictEqual(JSON.stringify(mapped).includes("tool_addition"), false);
        deepStrictEqual((mapped["messages"] as { content: unknown }[])[0]?.content, [{ type: "text", text: "s" }]);
        strictEqual(mapped["tools"], undefined);
    });
    it("messages without tool_addition blocks pass byte-identically (no rewriting when nothing is folded)", () => {
        const messages: Record<string, unknown>[] = [
            { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
        ];
        const mapped = passthroughEnvelope({ model: "anthropic-alibaba-glm-5.3", messages, tools: [{ name: "Bash", input_schema: { type: "object" } }] } as MessageEnvelope, "glm-5.3");
        strictEqual(mapped["messages"], messages, "the messages array is not even copied");
    });
    it("an unknown block type is NOT folded, withheld or dropped (no invented semantics)", () => {
        const messages: Record<string, unknown>[] = [
            { role: "user", content: [{ type: "future_unknown_block", payload: 1 }] },
        ];
        const mapped = passthroughEnvelope({ model: "anthropic-alibaba-glm-5.3", messages } as MessageEnvelope, "glm-5.3");
        deepStrictEqual(mapped["messages"], messages);
    });

    // Fake upstream: rejects with the MEASURED Alibaba 400 body whenever the body still contains
    // a tool_addition block; otherwise answers a normal Anthropic message. No network leaves the
    // machine (loopback http server, same pattern as the adapter's other tests).
    it("fake upstream: the 400 InvalidParameter upstream accepts the folded body (adapter-level, loopback http)", async () => {
        type SeenRequest = { url: string | undefined; body: string };
        const seen: SeenRequest[] = [];
        const server = createServer((incoming, response) => {
            let body = "";
            incoming.on("data", (chunk) => { body += String(chunk); });
            incoming.on("end", () => {
                seen.push({ url: incoming.url, body });
                if (body.includes("tool_addition")) {
                    response.writeHead(400, { "content-type": "application/json" });
                    response.end(JSON.stringify({ code: "InvalidParameter", message: "Request body format invalid" }));
                    return;
                }
                const message = { id: "msg_folded_1", type: "message", role: "assistant", model: "glm-5.3", content: [{ type: "text", text: "pong" }], stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 2 } };
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify(message));
            });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            const transport = new FixedOriginFetchTransport(new URL(`http://127.0.0.1:${port}`));
            const alibaba = new AnthropicApiKeyAdapter(transport, ALIBABA_LANE, { ALIBABA_TOKEN_PLAN_API_KEY: TEST_KEY });
            const source = fixture();
            const response = await alibaba.send(request(alibabaRow("glm-5.3"), { messages: source.messages, tools: source.tools, stream: false }));
            const text = await readAll(response.body);
            strictEqual(seen.length, 1);
            strictEqual(seen[0]?.body.includes("tool_addition"), false, "the wire body carries no tool_addition");
            const sent = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
            deepStrictEqual((sent["tools"] as { name: string }[]).map((tool) => tool.name), ["Bash", "Lookup", "LookupAgain", "OnlyToolsHere"]);
            strictEqual((JSON.parse(text) as { id: string }).id, "msg_folded_1", "the adapter call with the fixture succeeds");
        }
        finally {
            server.close();
            server.closeAllConnections();
            await once(server, "close");
        }
    });
    it("fake upstream control arm: a body that still carries tool_addition IS refused (the 400 arm is live)", async () => {
        // Probe control: an always-200 fake upstream would make the previous test pass vacuously.
        // A direct fetch (no adapter, so no folding) with the raw fixture must take the 400 arm.
        const server = createServer((incoming, response) => {
            let body = "";
            incoming.on("data", (chunk) => { body += String(chunk); });
            incoming.on("end", () => {
                if (body.includes("tool_addition")) {
                    response.writeHead(400, { "content-type": "application/json" });
                    response.end(JSON.stringify({ code: "InvalidParameter", message: "Request body format invalid" }));
                    return;
                }
                response.writeHead(200, { "content-type": "application/json" });
                response.end("{}");
            });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            const source = fixture();
            const raw = JSON.stringify({ model: "glm-5.3", messages: source.messages, tools: source.tools, stream: false });
            const answer = await fetch(`http://127.0.0.1:${port}/apps/anthropic/v1/messages`, { method: "POST", body: raw });
            strictEqual(answer.status, 400, "the un-folded body takes the 400 arm");
            const clean = await fetch(`http://127.0.0.1:${port}/apps/anthropic/v1/messages`, { method: "POST", body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }], stream: false }) });
            strictEqual(clean.status, 200, "the folded/clean body takes the 200 arm");
        }
        finally {
            server.close();
            server.closeAllConnections();
            await once(server, "close");
        }
    });
});

describe("alibaba / zai: credential handling", () => {
    it("reads the key from the lane's own dotenv file", async () => {
        const dir = await mkdtemp(join(tmpdir(), "alibaba-key-"));
        const own = join(dir, "own.env");
        await writeFile(own, `OTHER=1\n${ALIBABA_KEY_VARIABLE}="${TEST_KEY}"\n${ZAI_KEY_VARIABLE}=${TEST_KEY_ZAI}\n`);
        strictEqual((await resolveRouterOwnedKey({ [ALIBABA_KEY_FILE_VARIABLE]: own }, ALIBABA_KEY_VARIABLE, ALIBABA_KEY_FILE_VARIABLE, ALIBABA_KEY_VARIABLE)).value, TEST_KEY);
        strictEqual((await resolveRouterOwnedKey({ [ZAI_KEY_FILE_VARIABLE]: own }, ZAI_KEY_VARIABLE, ZAI_KEY_FILE_VARIABLE, ZAI_KEY_VARIABLE)).value, TEST_KEY_ZAI);
        // NEGATIVE: no file variable, no source; and another lane's file variable is not this lane's source.
        strictEqual((await resolveRouterOwnedKey({}, ALIBABA_KEY_VARIABLE, ALIBABA_KEY_FILE_VARIABLE, ALIBABA_KEY_VARIABLE)).value, undefined);
        strictEqual((await resolveRouterOwnedKey({ [ZAI_KEY_FILE_VARIABLE]: own }, ALIBABA_KEY_VARIABLE, ALIBABA_KEY_FILE_VARIABLE, ALIBABA_KEY_VARIABLE)).value, undefined);
    });
    it("NEGATIVE: no key -> readiness auth_required with the named state and remedy; send refuses before any network call", async () => {
        for (const [lane, code] of [[ALIBABA_LANE, "alibaba_key_missing"], [ZAI_LANE, "zai_key_missing"]] as const) {
            const sink = { sent: [] as HttpTransportRequest[] };
            const missing = new AnthropicApiKeyAdapter(capturingTransport(sink, () => new Response("{}")), lane, { [lane.keyFileVariable]: join(tmpdir(), "no-such-file.env") });
            const readiness = await missing.readiness();
            strictEqual(readiness.status, "auth_required");
            strictEqual(readiness.detailCode, code);
            ok((readiness.remedy ?? "").startsWith("FIX:"), code);
            await rejects(missing.send(request(lane === ALIBABA_LANE ? alibabaRow("glm-5.3") : zaiRow("glm-5.3"), {})), (error: unknown) => error instanceof RouterError && error.code === "provider_auth_required");
            strictEqual(sink.sent.length, 0);
        }
    });
    it("an upstream error body that echoes the key is quoted with the key redacted", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const echo = adapter(sink, ALIBABA_LANE, () => new Response(`bad request for key ${TEST_KEY}`, { status: 400 }));
        await rejects(echo.send(request(alibabaRow("glm-5.3"), {})), (error: unknown) => error instanceof RouterError &&
            error.code === "invalid_request" && !error.message.includes(TEST_KEY) && error.message.includes("[redacted]"));
    });
    it("401 from upstream maps to provider_auth_required", async () => {
        await rejects(adapter({ sent: [] }, ZAI_LANE, () => new Response("no", { status: 401 }), TEST_KEY_ZAI).send(request(zaiRow("glm-5.3"), {})), (error: unknown) => error instanceof RouterError && error.code === "provider_auth_required");
    });
});

describe("zai: the measured 429 / 1113 balance state", () => {
    // MEASURED 2026-11-09, kanit/uc-sinama3/zai-glm-5.3.txt (verbatim, key already redacted upstream):
    const ZAI_1113_BODY = JSON.stringify({ type: "error", error: { type: "rate_limit_error", code: "1113", message: "[1113][Insufficient balance or no resource package. Please recharge.][20261110001705fe489c724ee14e95]" }, request_id: "20261110001705fe489c724ee14e95" });
    it("a send-time 429/1113 is a named provider_rate_limited error that never quotes the key", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        // Code arm ONLY (no [1113] marker in the message): the error code is the detector here,
        // with the key echoed into the message text to prove scrubbing.
        const echoing = JSON.stringify({ type: "error", error: { type: "rate_limit_error", code: "1113", message: `key ${TEST_KEY_ZAI} balance exhausted` }, request_id: "r" });
        const lane = adapter(sink, ZAI_LANE, () => new Response(echoing, { status: 429, headers: { "content-type": "application/json" } }), TEST_KEY_ZAI);
        await rejects(lane.send(request(zaiRow("glm-5.3"), {})), (error: unknown) => error instanceof RouterError &&
            error.code === "provider_rate_limited" &&
            error.message.includes("zai_balance_insufficient") &&
            !error.message.includes(TEST_KEY_ZAI));
    });
    it("the live probe 429/1113 yields readiness blocked zai_balance_insufficient, never green, with the recharge remedy", async () => {
        const listing = { object: "list", data: ZAI_UPSTREAM_IDS.map((id) => ({ id, object: "model" })) };
        const sink = { sent: [] as HttpTransportRequest[] };
        let call = 0;
        const zai = adapter(sink, ZAI_LANE, () => {
            call += 1;
            return call === 1
                ? new Response(JSON.stringify(listing), { status: 200, headers: { "content-type": "application/json" } })
                : new Response(ZAI_1113_BODY, { status: 429, headers: { "content-type": "application/json" } });
        }, TEST_KEY_ZAI);
        const result = await zai.catalog();
        strictEqual(result.readiness.status, "blocked", "never shown green");
        strictEqual(result.readiness.detailCode, "zai_balance_insufficient");
        ok((result.readiness.remedy ?? "").includes("recharge"), "remedy names the one move");
        deepStrictEqual(result.models.map((entry) => entry.id), ZAI_UPSTREAM_IDS, "membership still comes from the live list");
    });
    it("NEGATIVE: a plain 429 without code 1113 is NOT the balance state", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const zai = adapter(sink, ZAI_LANE, () => new Response("Too Many Requests", { status: 429, headers: { "retry-after": "30" } }), TEST_KEY_ZAI);
        await rejects(zai.send(request(zaiRow("glm-5.3"), {})), (error: unknown) => error instanceof RouterError &&
            error.code === "provider_rate_limited" && !error.message.includes("zai_balance_insufficient") && error.retryAfter === "30");
        strictEqual((await new AnthropicApiKeyAdapter(capturingTransport(sink, () => new Response("Too Many Requests", { status: 429 })), ZAI_LANE, { ZAI_API_KEY: TEST_KEY_ZAI }).readiness()).detailCode, "zai_api_key_present");
    });
});

describe("alibaba: catalog refresh against a fake upstream", () => {
    const listing = { object: "list", data: [...ALIBABA_UPSTREAM_IDS, "wan2.7-image", "wan3.0-video"].map((id) => ({ id, object: "model" })) };
    const pong = { id: "msg_probe", type: "message", role: "assistant", model: "qwen3.8-max", content: [{ type: "text", text: "pong" }], stop_reason: "end_turn", usage: { input_tokens: 68, output_tokens: 30 } };
    it("list 200 + probe 200 -> ready with the live model ids; the probe hits the measured /apps/anthropic path", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        let call = 0;
        const alibaba = new AnthropicApiKeyAdapter(capturingTransport(sink, () => {
            call += 1;
            return call === 1
                ? new Response(JSON.stringify(listing), { status: 200, headers: { "content-type": "application/json" } })
                : new Response(JSON.stringify(pong), { status: 200, headers: { "content-type": "application/json" } });
        }), ALIBABA_LANE, { ALIBABA_TOKEN_PLAN_API_KEY: TEST_KEY });
        const result = await alibaba.catalog();
        strictEqual(result.readiness.status, "ready");
        strictEqual(result.readiness.detailCode, `alibaba_live_verified:${ALIBABA_UPSTREAM_IDS.length}_models`);
        deepStrictEqual(result.models.map((entry) => entry.id), [...ALIBABA_UPSTREAM_IDS, "wan2.7-image", "wan3.0-video"]);
        strictEqual(sink.sent[0]?.path, "/compatible-mode/v1/models");
        strictEqual(sink.sent[0]?.headers.get("x-api-key"), TEST_KEY);
        strictEqual(sink.sent[1]?.path, "/apps/anthropic/v1/messages");
        strictEqual(sink.sent[1]?.method, "POST");
    });
    it("NEGATIVE: a rejected key at refresh yields auth_required and an empty catalog", async () => {
        const result = await adapter({ sent: [] }, ALIBABA_LANE, () => new Response("no", { status: 403 })).catalog();
        strictEqual(result.readiness.detailCode, "alibaba_key_rejected");
        strictEqual(result.models.length, 0);
    });
    it("NEGATIVE: a live list without any contracted model is named, not empty-silent", async () => {
        const result = await adapter({ sent: [] }, ZAI_LANE, () => new Response(JSON.stringify({ object: "list", data: [{ id: "glm-4.7" }] }), { status: 200 }), TEST_KEY_ZAI).catalog();
        strictEqual(result.readiness.status, "unavailable");
        ok(result.readiness.detailCode?.startsWith("zai_models_not_in_live_catalog"), result.readiness.detailCode);
    });
});

describe("alibaba / zai: local loopback http server (no network leaves the machine)", () => {
    it("the adapter drives a real FixedOriginFetchTransport against a loopback server", async () => {
        type SeenRequest = { method: string | undefined; url: string | undefined; headers: IncomingMessage["headers"]; body: string };
        const seen: SeenRequest[] = [];
        const server = createServer((incoming, response) => {
            let body = "";
            incoming.on("data", (chunk) => { body += String(chunk); });
            incoming.on("end", () => {
                seen.push({ method: incoming.method, url: incoming.url, headers: incoming.headers, body });
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.end(PONG_SSE);
            });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            const transport = new FixedOriginFetchTransport(new URL(`http://127.0.0.1:${port}`));
            const zai = new AnthropicApiKeyAdapter(transport, ZAI_LANE, { ZAI_API_KEY: TEST_KEY_ZAI });
            const carrying = request(zaiRow("glm-5.3"), { stream: true }, "/v1/messages", OAUTH_HEADERS);
            const response = await zai.send(carrying);
            const text = await readAll(response.body);
            const completion = await response.completion;
            strictEqual(seen.length, 1);
            strictEqual(seen[0]?.method, "POST");
            strictEqual(seen[0]?.url, "/api/anthropic/v1/messages");
            strictEqual(seen[0]?.headers["x-api-key"], TEST_KEY_ZAI);
            strictEqual(seen[0]?.headers["authorization"], undefined, "OAuth bearer must not reach the wire");
            strictEqual(seen[0]?.headers["anthropic-beta"], undefined, "beta oauth flags must not reach the wire");
            strictEqual((JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>)["model"], "glm-5.3");
            strictEqual(text, PONG_SSE);
            strictEqual(completion?.providerRequestId, "msg_alibaba_1");
        }
        finally {
            server.close();
            server.closeAllConnections();
            await once(server, "close");
        }
    });
});

describe("alibaba / zai: the key never reaches a child environment", () => {
    it("every lane variable is in ROUTER_OWNED_SECRET_VARIABLES and stripped from Claude Code and worker children", () => {
        const names = [ALIBABA_KEY_VARIABLE, ALIBABA_KEY_FILE_VARIABLE, ZAI_KEY_VARIABLE, ZAI_KEY_FILE_VARIABLE];
        for (const name of names)
            ok((ROUTER_OWNED_SECRET_VARIABLES as readonly string[]).includes(name), `${name} missing from ROUTER_OWNED_SECRET_VARIABLES`);
        const source: NodeJS.ProcessEnv = {
            PATH: "x",
            [ALIBABA_KEY_VARIABLE]: TEST_KEY,
            [ALIBABA_KEY_FILE_VARIABLE]: "C:/s.env",
            [ZAI_KEY_VARIABLE]: TEST_KEY_ZAI,
            [ZAI_KEY_FILE_VARIABLE]: "C:/s.env",
        };
        for (const child of [sanitizedClaudeEnvironment(source), sanitizedWorkerEnvironment("google", source), sanitizedWorkerEnvironment("openai", source)]) {
            for (const name of names)
                strictEqual(child[name], undefined, name);
            strictEqual(Object.values(child).includes(TEST_KEY), false);
            strictEqual(Object.values(child).includes(TEST_KEY_ZAI), false);
            strictEqual(child["PATH"], "x", "NEGATIVE: unrelated variables survive");
        }
    });
    it("NEGATIVE: a lowercase alias of a lane variable is stripped too (the strip is case-insensitive)", () => {
        const child = sanitizedClaudeEnvironment({ PATH: "x", zai_api_key: TEST_KEY_ZAI });
        strictEqual(Object.values(child).includes(TEST_KEY_ZAI), false);
    });
    it("the lane code name ZAI_BALANCE_CODE is pinned to the measured 1113", () => {
        strictEqual(ZAI_BALANCE_CODE, "1113");
    });
});
