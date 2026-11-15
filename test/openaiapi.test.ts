import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import {
    OPENAI_API_KEY_FILE_VARIABLE,
    OPENAI_API_KEY_VARIABLE,
    OPENAI_API_MESSAGES_PATH,
    OPENAI_API_MODELS_PATH,
    OpenAiApiKeyAdapter,
    openAiApiKeyReasoning,
} from "../src/adapters/openai-api-key.js";
import type { AdapterRequest, HttpTransport, HttpTransportRequest, MessageEnvelope, ModelRecord, ModelSnapshot, ProviderAdapter, ProviderId } from "../src/domain/contracts.js";
import { PROVIDER_IDS } from "../src/domain/contracts.js";
import { RouterError } from "../src/domain/errors.js";
import {
    OPENAI_API_ASTRA_CONTEXT_WINDOW_TOKENS,
    OPENAI_API_ASTRA_MAXIMUM_OUTPUT_TOKENS,
    OPENAI_API_BASE_URL,
    OPENAI_API_MODEL_CONTRACTS,
    UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS,
    UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS,
    autoCompactWindowForModel,
    openAiModelContract,
} from "../src/domain/model-contracts.js";
import { withVerifiedOpenAiApiModels } from "../src/domain/model-refresh.js";
import { ModelRegistry, claudeClientDiscoveryId } from "../src/domain/registry.js";
import { API_KEY_PROVIDERS, parseModelSnapshot } from "../src/domain/validation.js";
import { ROUTER_OWNED_SECRET_VARIABLES, assertNoApiKeySelectors, sanitizedClaudeEnvironment, sanitizedWorkerEnvironment } from "../src/security/environment.js";
import { FixedOriginFetchTransport } from "../src/ports/fetch-transport.js";
import { MARKER_INPUT, MARKER_RESULT, MCP_TOOL, PLAIN_RESULT, callPlaceholder, mcpHistory, resultPlaceholder } from "./mcp-history-fixture.js";
import { TOOL_ADDITION_ENVELOPE_TOOLS, toolAddition, toolAdditionHistory, type WireBody } from "./tool-addition-fixture.js";

// Synthetic credential: not a real key, exists only in this file.
const TEST_KEY = "openaiapi-unit-test-placeholder-not-a-key";

const OPENAI_API_UPSTREAM_IDS = OPENAI_API_MODEL_CONTRACTS.map((entry) => entry.upstreamModel);

const baseline: ModelSnapshot = { schemaVersion: 1, generatedAt: "2026-11-09T00:00:00.000Z", source: "test", models: [] };

function openaiRow(upstreamModel: string): ModelRecord {
    const snapshot = withVerifiedOpenAiApiModels(baseline, OPENAI_API_UPSTREAM_IDS);
    const row = snapshot.models.find((entry) => entry.upstreamModel === upstreamModel);
    if (row === undefined)
        throw new Error(`no row for ${upstreamModel}`);
    return row;
}

function request(model: ModelRecord, envelope: Partial<MessageEnvelope>, path: AdapterRequest["path"] = "/v1/messages", headers: Headers = new Headers()): AdapterRequest {
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

// The client request arrives carrying Claude OAuth credentials; the lane must NOT forward them.
const OAUTH_HEADERS = new Headers({
    authorization: "Bearer fake-oauth-token",
    "anthropic-beta": "oauth-2025-04-20",
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

function sseBody(events: readonly unknown[]): string {
    return `${events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("")}`;
}

const TEXT_STREAM = sseBody([
    { id: "chatcmpl-text-1", choices: [{ index: 0, delta: { role: "assistant", content: "PONG" } }] },
    { id: "chatcmpl-text-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id: "chatcmpl-text-1", choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
    "[DONE]",
]);

const TOOL_STREAM = sseBody([
    { id: "chatcmpl-tool-1", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_weather_1", type: "function", function: { name: "get_weather", arguments: "" } }] } }] },
    { id: "chatcmpl-tool-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"city\":\"Istanbul\"}" } }] } }] },
    { id: "chatcmpl-tool-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: "chatcmpl-tool-1", choices: [], usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 } },
    "[DONE]",
]);

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
    ok(stream !== null);
    return await new Response(stream).text();
}

function sentJson(sink: { sent: HttpTransportRequest[] }): Record<string, unknown> {
    const last = sink.sent.at(-1);
    ok(last?.body !== undefined, "a body was sent");
    return JSON.parse(Buffer.from(last.body).toString("utf8")) as Record<string, unknown>;
}

async function keyFile(key: string = TEST_KEY): Promise<{ readonly path: string }> {
    const dir = await mkdtemp(join(tmpdir(), "openaiapi-key-"));
    const path = join(dir, "key.env");
    await writeFile(path, `OTHER=1\n${OPENAI_API_KEY_VARIABLE}="${key}"\n`);
    return { path };
}

function adapter(sink: { sent: HttpTransportRequest[] }, keyPath: string, reply: () => Response = () => new Response(TEXT_STREAM, { status: 200, headers: { "content-type": "text/event-stream" } })): OpenAiApiKeyAdapter {
    return new OpenAiApiKeyAdapter(capturingTransport(sink, reply), { [OPENAI_API_KEY_FILE_VARIABLE]: keyPath });
}

describe("openaiapi: pin pattern, contracts, and separation from the `openai` OAuth lane", () => {
    it("PIN: provider id and credential class carry openaiapi", () => {
        ok((PROVIDER_IDS as readonly string[]).includes("openaiapi"));
        ok(API_KEY_PROVIDERS.has("openaiapi"));
    });
    it("carries exactly the three requested models under the pinned id pattern", () => {
        deepStrictEqual(OPENAI_API_MODEL_CONTRACTS.map((entry) => entry.id), ["anthropic-openaiapi-gpt-6-astra", "anthropic-openaiapi-gpt-6.1-sol", "anthropic-openaiapi-gpt-6.1-terra"]);
        ok(OPENAI_API_MODEL_CONTRACTS.every((entry) => entry.id.startsWith("anthropic-openaiapi-")));
        deepStrictEqual(OPENAI_API_UPSTREAM_IDS, ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"]);
    });
    it("NEGATIVE: the openaiapi rows do not exist in the ChatGPT-OAuth (clodex) contract table and vice versa", () => {
        for (const contract of OPENAI_API_MODEL_CONTRACTS)
            strictEqual(openAiModelContract(contract.id), undefined, contract.id);
        const astraOauth = openAiModelContract("anthropic-openai-gpt-6-astra");
        ok(astraOauth !== undefined, "the OAuth lane's astra row stays where it was");
        strictEqual(OPENAI_API_MODEL_CONTRACTS.some((entry) => entry.id === "anthropic-openai-gpt-6-astra"), false);
    });
    it("astra carries the model-card numbers; sol and terra carry the [UNVERIFIED] conservative default", () => {
        const astra = OPENAI_API_MODEL_CONTRACTS[0]!;
        strictEqual(astra.contextWindow, OPENAI_API_ASTRA_CONTEXT_WINDOW_TOKENS);
        strictEqual(OPENAI_API_ASTRA_CONTEXT_WINDOW_TOKENS, 1_050_000);
        strictEqual(astra.maximumOutputTokens, OPENAI_API_ASTRA_MAXIMUM_OUTPUT_TOKENS);
        strictEqual(OPENAI_API_ASTRA_MAXIMUM_OUTPUT_TOKENS, 128_000);
        ok(!astra.contextWindowSource.includes("[UNVERIFIED]") && astra.contextWindowSource.includes("Model card"));
        for (const contract of OPENAI_API_MODEL_CONTRACTS.slice(1)) {
            strictEqual(contract.contextWindow, UNVERIFIED_API_KEY_CONTEXT_WINDOW_TOKENS, contract.id);
            strictEqual(contract.autoCompactWindow, UNVERIFIED_API_KEY_AUTO_COMPACT_WINDOW_TOKENS, contract.id);
            ok(contract.contextWindowSource.includes("[UNVERIFIED]"), contract.id);
        }
        for (const contract of OPENAI_API_MODEL_CONTRACTS) {
            const compact = autoCompactWindowForModel(contract.id);
            ok(compact !== undefined && compact < contract.contextWindow, contract.id);
        }
    });
    it("the lane's endpoints and origin are pinned", () => {
        strictEqual(OPENAI_API_BASE_URL, "https://api.openai.com");
        strictEqual(OPENAI_API_MESSAGES_PATH, "/v1/chat/completions");
        strictEqual(OPENAI_API_MODELS_PATH, "/v1/models");
    });
});

describe("openaiapi: snapshot derivation (catalog validation)", () => {
    it("a full live model list yields the 3 contracted rows; unrelated live models are not admitted", () => {
        const snapshot = withVerifiedOpenAiApiModels(baseline, [...OPENAI_API_UPSTREAM_IDS, "text-embedding-3-small", "dall-e-3"]);
        strictEqual(snapshot.models.length, 3);
        ok(snapshot.models.every((row) => row.provider === "openaiapi" && row.oauthType === "api-key" && row.executionMode === "native-message-loop" && row.discoverable));
        strictEqual(snapshot.models.some((row) => row.upstreamModel === "text-embedding-3-small"), false);
        strictEqual(openaiRow("gpt-6-astra").capabilities.includes("thinking"), false, "no thinking replay on a translated lane");
    });
    it("NEGATIVE: an empty live list (no key, no answer) produces NO rows and drops stale ones", () => {
        const stale = withVerifiedOpenAiApiModels(baseline, OPENAI_API_UPSTREAM_IDS);
        strictEqual(withVerifiedOpenAiApiModels(stale, []).models.length, 0);
    });
    it("NEGATIVE: a model missing from the live list is not admitted", () => {
        const snapshot = withVerifiedOpenAiApiModels(baseline, ["gpt-6-astra", "gpt-6.1-sol"]);
        strictEqual(snapshot.models.some((row) => row.upstreamModel === "gpt-6.1-terra"), false);
        strictEqual(snapshot.models.length, 2);
    });
    it("rows survive the snapshot parser (disk round trip); the parser refuses credential mix-ups", () => {
        const snapshot = withVerifiedOpenAiApiModels(baseline, OPENAI_API_UPSTREAM_IDS);
        strictEqual(parseModelSnapshot(JSON.parse(JSON.stringify(snapshot))).models.length, 3);
        const row = JSON.parse(JSON.stringify(openaiRow("gpt-6-astra"))) as Record<string, unknown>;
        const wrap = (model: Record<string, unknown>): unknown => ({ ...baseline, models: [model] });
        let threw = false;
        try { parseModelSnapshot(wrap({ ...row, oauthType: "chatgpt" })); } catch { threw = true; }
        strictEqual(threw, true, "openaiapi with a chatgpt credential must be refused");
        threw = false;
        try { parseModelSnapshot(wrap({ ...row, provider: "openai" })); } catch { threw = true; }
        strictEqual(threw, true, "the openai OAuth lane must not claim an openaiapi row");
    });
});

describe("openaiapi: discovery (/model picker)", () => {
    const snapshot = withVerifiedOpenAiApiModels(baseline, OPENAI_API_UPSTREAM_IDS);
    // A stub adapter: discovery tests never call send(); the registry only needs the lane present.
    const stub: ProviderAdapter = {
        provider: "openaiapi",
        readiness: async () => ({ provider: "openaiapi", oauthReady: true, adapterReady: true, status: "ready", detailCode: "openaiapi_api_key_present" }),
        send: () => Promise.reject(new Error("not called")),
    };
    const adapters = new Map<ProviderId, ProviderAdapter>([["openaiapi", stub]]);
    const registry = new ModelRegistry(snapshot, adapters);
    it("astra (1,050,000 from the model card) takes the [1m] suffix; sol and terra do not", () => {
        const payload = registry.discoveryPayload() as { data: { id: string; max_output_tokens?: number }[] };
        deepStrictEqual(payload.data.map((entry) => entry.id).sort(), ["anthropic-openaiapi-gpt-6-astra[1m]", "anthropic-openaiapi-gpt-6.1-sol", "anthropic-openaiapi-gpt-6.1-terra"]);
        strictEqual(payload.data.find((entry) => entry.id === "anthropic-openaiapi-gpt-6-astra[1m]")?.max_output_tokens, OPENAI_API_ASTRA_MAXIMUM_OUTPUT_TOKENS);
        strictEqual(claudeClientDiscoveryId(openaiRow("gpt-6-astra")), "anthropic-openaiapi-gpt-6-astra[1m]");
        strictEqual(claudeClientDiscoveryId(openaiRow("gpt-6.1-sol")), "anthropic-openaiapi-gpt-6.1-sol");
    });
    it("the [1m] picker id resolves to the row", () => {
        strictEqual(registry.resolve("anthropic-openaiapi-gpt-6-astra[1m]").model.upstreamModel, "gpt-6-astra");
    });
});

describe("openaiapi adapter: auth header, translation request, data rule", () => {
    it("sends the key as authorization: Bearer to /v1/chat/completions, never as x-api-key", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const response = await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), {}));
        await readAll(response.body);
        const sent = sink.sent[0];
        strictEqual(sent?.path, "/v1/chat/completions");
        strictEqual(sent?.method, "POST");
        strictEqual(sent?.headers.get("authorization"), `Bearer ${TEST_KEY}`);
        strictEqual(sent?.headers.get("x-api-key"), null);
        strictEqual(sent?.headers.get("anthropic-beta"), null);
        strictEqual(sentJson(sink)["model"], "gpt-6-astra");
    });
    it("NEGATIVE (OAuth leak arm): a request carrying Claude OAuth headers forwards none of them", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const carrying = request(openaiRow("gpt-6-astra"), {}, "/v1/messages", OAUTH_HEADERS);
        await readAll((await adapter(sink, (await keyFile()).path).send(carrying)).body);
        const sent = sink.sent[0];
        strictEqual(sent?.headers.get("authorization"), `Bearer ${TEST_KEY}`, "the only authorization on the wire is the lane's own key");
        strictEqual(sent?.headers.get("anthropic-beta"), null);
    });
    it("the output cap travels as max_completion_tokens, never max_tokens, and is clamped to astra's 128,000", async () => {
        const path = (await keyFile()).path;
        const clamped = { sent: [] as HttpTransportRequest[] };
        await readAll((await adapter(clamped, path).send(request(openaiRow("gpt-6-astra"), { max_tokens: 500_000 }))).body);
        const clampedBody = sentJson(clamped);
        strictEqual(clampedBody["max_completion_tokens"], 128_000, "the model card's output ceiling is enforced");
        strictEqual(clampedBody["max_tokens"], undefined);
        const passthrough = { sent: [] as HttpTransportRequest[] };
        await readAll((await adapter(passthrough, path).send(request(openaiRow("gpt-6.1-sol"), { max_tokens: 32_000 }))).body);
        strictEqual(sentJson(passthrough)["max_completion_tokens"], 32_000, "sol has no measured ceiling; the request passes");
    });
    it("NEGATIVE: no max_tokens in the envelope -> no cap field on the wire", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6.1-sol"), { max_tokens: undefined }))).body);
        const body = sentJson(sink);
        strictEqual(body["max_completion_tokens"], undefined);
        strictEqual(body["max_tokens"], undefined);
    });
    it("the request body is chat-completions shaped: system folded in, stream_options present", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { system: "be terse" }))).body);
        const body = sentJson(sink) as { model: string; messages: { role: string; content: string }[]; stream: boolean; stream_options: unknown };
        strictEqual(body.messages[0]?.role, "system");
        strictEqual(body.messages[0]?.content, "be terse");
        deepStrictEqual(body.stream_options, { include_usage: true });
        strictEqual(body.stream, true);
    });
    it("DATA RULE: mcp__* tools are never advertised; other tools map to chat-completions functions", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const tools = [
            { name: "Read", description: "read a file", input_schema: { type: "object", properties: {} } },
            { name: "mcp__claude_ai_Gmail__search_threads", input_schema: { type: "object" } },
            { name: "mcp__playwright__browser_snapshot", input_schema: { type: "object" } },
        ];
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { tools, tool_choice: { type: "auto" } }))).body);
        const body = sentJson(sink) as { tools: { type: string; function: { name: string } }[]; tool_choice: string };
        deepStrictEqual(body.tools.map((tool) => tool.function.name), ["Read"]);
        strictEqual(body.tools[0]?.type, "function");
        strictEqual(body.tool_choice, "auto");
    });
    it("NEGATIVE: with only mcp__* tools, no tools and no tool_choice are sent", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const tools = [{ name: "mcp__claude_ai_Google_Drive__search_files", input_schema: { type: "object" } }];
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { tools, tool_choice: { type: "any" } }))).body);
        const body = sentJson(sink);
        strictEqual(body["tools"], undefined);
        strictEqual(body["tool_choice"], undefined);
    });
    // Audit D2-03: this lane used to turn a tool_addition block into the text
    // "[tool_addition block omitted by the router]" inside the system prompt and never offer the
    // added tool -- a deferred tool Claude Code loads mid-conversation was unreachable. The
    // lane now folds exactly like the passthrough lanes (anthropic-api-key.ts).
    it("tool_addition on the chat lane: non-mcp definitions join tools once, mcp__ ones are withheld, no placeholder is left in the system prompt, cache_control is not copied", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { messages: toolAdditionHistory(), tools: TOOL_ADDITION_ENVELOPE_TOOLS, tool_choice: { type: "auto" } }))).body);
        const body = sentJson(sink) as unknown as WireBody;
        deepStrictEqual(body.tools?.map((tool) => tool.function.name), ["Bash", "Lookup", "OnlyToolsHere"], "Bash is not duplicated, mcp__ names are not offered");
        strictEqual(body.tools?.find((tool) => tool.function.name === "Lookup")?.function.description, "Lookup description", "the definition is folded, not the block");
        deepStrictEqual(body.messages.map((message) => message.role), ["system", "user"]);
        strictEqual(body.messages[0]?.content, "skill catalogue", "no tool_addition placeholder text in the system prompt");
        const wire = JSON.stringify(body);
        for (const leaked of ["tool_addition", "omitted by the router", "cache_control"])
            strictEqual(wire.includes(leaked), false, leaked);
        strictEqual(body.tool_choice, "auto", "tool_choice survives while tools remain");
    });
    it("tool_addition on the chat lane: a message made only of tool_addition blocks disappears; a tool_addition with no tools array still creates the tools", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "system", content: [toolAddition("Lookup")] }];
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { messages, tool_choice: { type: "auto" } }))).body);
        const body = sentJson(sink) as unknown as WireBody;
        deepStrictEqual(body.messages.map((message) => message.role), ["user"], "no system message is built from a block that carried no text");
        deepStrictEqual(body.tools?.map((tool) => tool.function.name), ["Lookup"]);
        strictEqual(body.tool_choice, "auto");
    });
    it("NEGATIVE: tool_addition of mcp__ tools only -> no tools and no tool_choice are sent, and no placeholder either", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const messages = [{ role: "user", content: "hi" }, { role: "system", content: [{ type: "text", text: "s" }, toolAddition("mcp__claude_ai_Gmail__search_threads")] }];
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { messages, tool_choice: { type: "any" } }))).body);
        const body = sentJson(sink) as unknown as WireBody;
        strictEqual(body.tools, undefined);
        strictEqual(body.tool_choice, undefined);
        strictEqual(body.messages[0]?.content, "s");
    });
    it("a deferred stub in tools does not hide the folded full definition (the stub is not offered on this lane, so the name is not yet known)", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const tools = [{ name: "Lookup", description: "stub", defer_loading: true, input_schema: { type: "object", properties: {} } }];
        const messages = [{ role: "user", content: "hi" }, { role: "system", content: [toolAddition("Lookup")] }];
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { messages, tools }))).body);
        const body = sentJson(sink) as unknown as WireBody;
        deepStrictEqual(body.tools?.map((tool) => `${tool.function.name}:${tool.function.description}`), ["Lookup:Lookup description"]);
    });
    it("a malformed tool_addition (no definition) is removed without inventing a tool and without failing", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const messages = [{ role: "user", content: "hi" }, { role: "system", content: [{ type: "tool_addition", tool: "not-a-record" }, { type: "text", text: "s" }] }];
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { messages }))).body);
        const body = sentJson(sink) as unknown as WireBody;
        strictEqual(body.tools, undefined);
        strictEqual(body.messages[0]?.content, "s");
    });
    it("a non-text block inside a tool_result is named by the omission placeholder, never refused and never forwarded", async () => {
        // The one remaining producer of "[<type> block omitted by the router]": a screenshot or
        // document in a tool result. Pinned so the placeholder has a live arm of its own.
        const sink = { sent: [] as HttpTransportRequest[] };
        const messages = [
            { role: "user", content: "hi" },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_shot_1", name: "Screenshot", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_shot_1", content: [{ type: "text", text: "caption" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] },
        ];
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { messages }))).body);
        const body = sentJson(sink) as unknown as WireBody;
        strictEqual(body.messages.find((message) => message.role === "tool")?.content, "caption\n[image block omitted by the router]");
        strictEqual(JSON.stringify(body).includes("AAAA"), false);
    });
    it("reasoning effort passes low/medium/high; xhigh and max fold to high; none sends nothing", () => {
        deepStrictEqual(openAiApiKeyReasoning({ model: "x" } as MessageEnvelope), {});
        deepStrictEqual(openAiApiKeyReasoning({ model: "x", reasoning_effort: "low" } as MessageEnvelope), { reasoning_effort: "low" });
        deepStrictEqual(openAiApiKeyReasoning({ model: "x", reasoning_effort: "high" } as MessageEnvelope), { reasoning_effort: "high" });
        deepStrictEqual(openAiApiKeyReasoning({ model: "x", reasoning_effort: "xhigh" } as MessageEnvelope), { reasoning_effort: "high" });
        deepStrictEqual(openAiApiKeyReasoning({ model: "x", reasoning_effort: "max" } as MessageEnvelope), { reasoning_effort: "high" });
    });
    it("count_tokens is answered locally, nothing is sent", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const response = await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), {}, "/v1/messages/count_tokens"));
        ok((JSON.parse(await readAll(response.body)) as { input_tokens: number }).input_tokens > 0);
        strictEqual(sink.sent.length, 0);
    });
    it("a model from another lane is refused by name (no cross-lane send)", async () => {
        const otherLaneShaped = { ...openaiRow("gpt-6-astra"), provider: "alibaba" as ProviderId };
        await rejects(adapter({ sent: [] }, (await keyFile()).path).send(request(otherLaneShaped, {})), (error: unknown) => error instanceof RouterError && error.code === "model_not_available");
    });
});

describe("openaiapi: translation round-trip against a fake upstream", () => {
    it("TEXT: a chat-completions stream comes back as Anthropic SSE with usage and a settled receipt", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const response = await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), {}));
        const text = await readAll(response.body);
        ok(text.includes("event: message_start"));
        ok(text.includes('"text_delta"'));
        ok(text.includes('"text":"PONG"'));
        ok(text.includes('"stop_reason":"end_turn"'));
        ok(text.includes('"input_tokens":11'));
        ok(text.includes("event: message_stop"));
        ok(!text.includes("thinking"), "emitReasoning is off: no thinking blocks are fabricated");
        const completion = await response.completion;
        strictEqual(completion?.providerRequestId, "chatcmpl-text-1");
        deepStrictEqual(completion?.usage, { input_tokens: 11, output_tokens: 7 });
    });
    it("TOOL CALL: streamed tool_calls deltas come back as one tool_use block with parsed input", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const response = await adapter(sink, (await keyFile()).path, () => new Response(TOOL_STREAM, { status: 200, headers: { "content-type": "text/event-stream" } }))
            .send(request(openaiRow("gpt-6.1-sol"), {}));
        const text = await readAll(response.body);
        ok(text.includes('"type":"tool_use"'));
        ok(text.includes('"id":"call_weather_1"'));
        ok(text.includes('"name":"get_weather"'));
        ok(text.includes('"input_json_delta"'));
        ok(text.includes('"partial_json":"{\\"city\\":\\"Istanbul\\"}"'));
        ok(text.includes('"stop_reason":"tool_use"'), "finish_reason tool_calls maps to tool_use");
        const completion = await response.completion;
        deepStrictEqual(completion?.usage, { input_tokens: 21, output_tokens: 9 });
    });
    it("TOOL CALL, non-streaming: a chat completion with tool_calls comes back as a tool_use content block", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const completion = {
            id: "chatcmpl-ns-1",
            choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [{ id: "call_ns_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Ankara\"}" } }] }, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 4, completion_tokens: 6 },
        };
        const response = await adapter(sink, (await keyFile()).path, () => new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } }))
            .send(request(openaiRow("gpt-6.1-terra"), { stream: false }));
        const body = JSON.parse(await readAll(response.body)) as { id: string; content: { type: string; id: string; name: string; input: { city: string } }[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number }; model: string };
        strictEqual(body.id, "chatcmpl-ns-1");
        deepStrictEqual(body.content, [{ type: "tool_use", id: "call_ns_1", name: "get_weather", input: { city: "Ankara" } }]);
        strictEqual(body.stop_reason, "tool_use");
        deepStrictEqual(body.usage, { input_tokens: 4, output_tokens: 6 });
        strictEqual(body.model, "anthropic-openaiapi-gpt-6.1-terra", "the response names the router's model id, not the upstream's");
        strictEqual(sentJson(sink)["stream"], false, "the upstream request is non-streaming");
        strictEqual(sentJson(sink)["stream_options"], undefined);
        strictEqual(response.providerRequestId, "chatcmpl-ns-1");
        deepStrictEqual(response.usage, { input_tokens: 4, output_tokens: 6 });
    });
    it("TEXT, non-streaming: the message text comes back in an Anthropic message body", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const completion = { id: "chatcmpl-ns-2", choices: [{ index: 0, message: { role: "assistant", content: "PONG" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
        const response = await adapter(sink, (await keyFile()).path, () => new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } }))
            .send(request(openaiRow("gpt-6-astra"), { stream: false }));
        const body = JSON.parse(await readAll(response.body)) as { content: { type: string; text: string }[]; stop_reason: string };
        deepStrictEqual(body.content, [{ type: "text", text: "PONG" }]);
        strictEqual(body.stop_reason, "end_turn");
    });
});

describe("openaiapi: an error object streamed mid-response keeps the upstream's reason (audit D2-05)", () => {
    it("the reason reaches the client as a 400-class error, with the lane key scrubbed", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const failing = () => new Response(sseBody([
            { id: "chatcmpl-9", choices: [{ index: 0, delta: { content: "partial" } }] },
            { error: { message: `context length exceeded (echoed ${TEST_KEY})`, code: "context_length_exceeded" } },
        ]), { status: 200, headers: { "content-type": "text/event-stream" } });
        const response = await adapter(sink, (await keyFile()).path, failing).send(request(openaiRow("gpt-6-astra"), {}));
        await rejects(readAll(response.body), (error: unknown) => error instanceof RouterError &&
            error.code === "invalid_request" &&
            error.status === 400 &&
            error.message.includes("context length exceeded") &&
            error.message.includes("[redacted]") &&
            !error.message.includes(TEST_KEY));
    });
});

describe("openaiapi: the measured 429 credit-exhaustion state", () => {
    // MEASURED 2026-11-09, kanit/openai/kota/ (both /v1/chat/completions and /v1/responses):
    const CREDIT_BODY = JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "credit_balance_exhausted" } });
    it("a send-time 429 with insufficient_quota is a named provider_rate_limited error with the billing remedy", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const lane = adapter(sink, (await keyFile()).path, () => new Response(CREDIT_BODY, { status: 429, headers: { "content-type": "application/json" } }));
        await rejects(lane.send(request(openaiRow("gpt-6-astra"), {})), (error: unknown) => error instanceof RouterError &&
            error.code === "provider_rate_limited" &&
            error.message.includes("openaiapi_credit_exhausted") &&
            error.message.includes("billing") &&
            !error.message.includes(TEST_KEY));
    });
    it("the live probe 429 yields readiness blocked openaiapi_credit_exhausted, never green", async () => {
        const listing = { object: "list", data: OPENAI_API_UPSTREAM_IDS.map((id) => ({ id, object: "model" })) };
        const sink = { sent: [] as HttpTransportRequest[] };
        let call = 0;
        const lane = adapter(sink, (await keyFile()).path, () => {
            call += 1;
            return call === 1
                ? new Response(JSON.stringify(listing), { status: 200, headers: { "content-type": "application/json" } })
                : new Response(CREDIT_BODY, { status: 429, headers: { "content-type": "application/json" } });
        });
        const result = await lane.catalog();
        strictEqual(result.readiness.status, "blocked", "never shown green");
        strictEqual(result.readiness.detailCode, "openaiapi_credit_exhausted");
        ok((result.readiness.remedy ?? "").includes("billing"), "the remedy points at the one move");
        deepStrictEqual(result.models.map((entry) => entry.id), OPENAI_API_UPSTREAM_IDS, "membership still comes from the live list");
    });
    it("NEGATIVE: a plain 429 without the credit code is not the credit state", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        await rejects(adapter(sink, (await keyFile()).path, () => new Response("Too Many Requests", { status: 429, headers: { "retry-after": "29" } }))
            .send(request(openaiRow("gpt-6-astra"), {})), (error: unknown) => error instanceof RouterError &&
            error.code === "provider_rate_limited" && !error.message.includes("openaiapi_credit_exhausted") && error.retryAfter === "29");
    });
});

describe("openaiapi: catalog refresh against a fake upstream", () => {
    const listing = { object: "list", data: [...OPENAI_API_UPSTREAM_IDS, "text-embedding-3-small"].map((id) => ({ id, object: "model" })) };
    const pong = { id: "chatcmpl-probe-1", choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 6, completion_tokens: 1 } };
    it("list 200 + probe 200 -> ready; the probe is one tiny chat call with max_completion_tokens", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        let call = 0;
        const lane = adapter(sink, (await keyFile()).path, () => {
            call += 1;
            return call === 1
                ? new Response(JSON.stringify(listing), { status: 200, headers: { "content-type": "application/json" } })
                : new Response(JSON.stringify(pong), { status: 200, headers: { "content-type": "application/json" } });
        });
        const result = await lane.catalog();
        strictEqual(result.readiness.status, "ready");
        strictEqual(result.readiness.detailCode, "openaiapi_live_verified:3_models");
        deepStrictEqual(result.models.map((entry) => entry.id), [...OPENAI_API_UPSTREAM_IDS, "text-embedding-3-small"]);
        strictEqual(sink.sent[0]?.path, "/v1/models");
        strictEqual(sink.sent[0]?.method, "GET");
        strictEqual(sink.sent[0]?.headers.get("authorization"), `Bearer ${TEST_KEY}`);
        strictEqual(sink.sent[1]?.path, "/v1/chat/completions");
        strictEqual(sink.sent[1]?.method, "POST");
        const probe = JSON.parse(Buffer.from(sink.sent[1]?.body ?? "").toString("utf8")) as Record<string, unknown>;
        strictEqual(probe["model"], "gpt-6-astra");
        strictEqual(probe["max_completion_tokens"], 16);
        strictEqual(probe["max_tokens"], undefined);
    });
    it("NEGATIVE: a rejected key at refresh yields auth_required and an empty catalog", async () => {
        const result = await adapter({ sent: [] }, (await keyFile()).path, () => new Response("no", { status: 401 })).catalog();
        strictEqual(result.readiness.status, "auth_required");
        strictEqual(result.readiness.detailCode, "openaiapi_key_rejected");
        strictEqual(result.models.length, 0);
    });
    it("NEGATIVE: a live list without any contracted model is named, not empty-silent", async () => {
        const result = await adapter({ sent: [] }, (await keyFile()).path, () => new Response(JSON.stringify({ object: "list", data: [{ id: "text-embedding-3-small" }] }), { status: 200 })).catalog();
        strictEqual(result.readiness.status, "unavailable");
        ok(result.readiness.detailCode?.startsWith("openaiapi_models_not_in_live_catalog"), result.readiness.detailCode);
    });
});

describe("openaiapi: credential handling (FILE ONLY)", () => {
    it("NEGATIVE: OPENAI_API_KEY in the process environment is NOT read -- the lane is file-only", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const lane = new OpenAiApiKeyAdapter(capturingTransport(sink, () => new Response("{}")), { OPENAI_API_KEY: TEST_KEY });
        const readiness = await lane.readiness();
        strictEqual(readiness.status, "auth_required");
        strictEqual(readiness.detailCode, "openaiapi_key_missing");
        ok((readiness.remedy ?? "").includes("FILE"), "the remedy explains the file-only rule");
        await rejects(lane.send(request(openaiRow("gpt-6-astra"), {})), (error: unknown) => error instanceof RouterError && error.code === "provider_auth_required");
        strictEqual(sink.sent.length, 0, "no network call happens without a key");
    });
    it("NEGATIVE: no file at all -> openaiapi_key_missing, and send refuses before any network call", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const lane = new OpenAiApiKeyAdapter(capturingTransport(sink, () => new Response("{}")), { OPENAI_API_KEY_FILE: join(tmpdir(), "no-such-file.env") });
        strictEqual((await lane.readiness()).detailCode, "openaiapi_key_missing");
        await rejects(lane.send(request(openaiRow("gpt-6-astra"), {})), (error: unknown) => error instanceof RouterError && error.code === "provider_auth_required");
        strictEqual(sink.sent.length, 0);
    });
    it("401 from upstream maps to provider_auth_required; an error body quoting the key is redacted", async () => {
        const path = (await keyFile()).path;
        await rejects(adapter({ sent: [] }, path, () => new Response("no", { status: 401 })).send(request(openaiRow("gpt-6-astra"), {})), (error: unknown) => error instanceof RouterError && error.code === "provider_auth_required");
        await rejects(adapter({ sent: [] }, path, () => new Response(`bad key ${TEST_KEY}`, { status: 400 })).send(request(openaiRow("gpt-6-astra"), {})), (error: unknown) => error instanceof RouterError &&
            error.code === "invalid_request" && !error.message.includes(TEST_KEY) && error.message.includes("[redacted]"));
    });
});

describe("openaiapi: local loopback http server (no network leaves the machine)", () => {
    it("the adapter drives a real FixedOriginFetchTransport against a loopback server", async () => {
        type SeenRequest = { method: string | undefined; url: string | undefined; headers: IncomingMessage["headers"]; body: string };
        const seen: SeenRequest[] = [];
        const server = createServer((incoming, response) => {
            let body = "";
            incoming.on("data", (chunk) => { body += String(chunk); });
            incoming.on("end", () => {
                seen.push({ method: incoming.method, url: incoming.url, headers: incoming.headers, body });
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.end(TEXT_STREAM);
            });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            const transport = new FixedOriginFetchTransport(new URL(`http://127.0.0.1:${port}`));
            const lane = new OpenAiApiKeyAdapter(transport, { OPENAI_API_KEY_FILE: (await keyFile()).path });
            const carrying = request(openaiRow("gpt-6-astra"), { max_tokens: 1_000 }, "/v1/messages", OAUTH_HEADERS);
            const response = await lane.send(carrying);
            const text = await readAll(response.body);
            const completion = await response.completion;
            strictEqual(seen.length, 1);
            strictEqual(seen[0]?.method, "POST");
            strictEqual(seen[0]?.url, "/v1/chat/completions");
            strictEqual(seen[0]?.headers["authorization"], `Bearer ${TEST_KEY}`);
            strictEqual(seen[0]?.headers["x-api-key"], undefined);
            const body = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
            strictEqual(body["model"], "gpt-6-astra");
            strictEqual(body["max_completion_tokens"], 1_000);
            ok(text.includes('"text":"PONG"'));
            strictEqual(completion?.providerRequestId, "chatcmpl-text-1");
            deepStrictEqual(completion?.usage, { input_tokens: 11, output_tokens: 7 });
        }
        finally {
            server.close();
            server.closeAllConnections();
            await once(server, "close");
        }
    });
});

describe("openaiapi: MCP data in replayed history never reaches the wire (audit D2-01)", () => {
    it("an mcp__ tool_use and its tool_result are replaced by placeholders; the ordinary Read pair survives in a valid order", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { messages: mcpHistory() }))).body);
        const body = sentJson(sink) as { messages: Record<string, unknown>[] };
        const wire = JSON.stringify(body);
        strictEqual(wire.includes(MARKER_INPUT), false, "the MCP call input is not on the wire");
        strictEqual(wire.includes(MARKER_RESULT), false, "the MCP result is not on the wire");
        strictEqual(wire.includes("toolu_mcp_1"), false, "no tool_call id of the withheld pair is on the wire");
        ok(wire.includes(callPlaceholder(MCP_TOOL)), "the call placeholder is present");
        ok(wire.includes(resultPlaceholder(MCP_TOOL)), "the result placeholder is present");
        deepStrictEqual(body.messages.map((message) => message["role"]), ["user", "assistant", "tool", "user"], "no tool_calls entry or tool message for the withheld pair; the tool message follows its assistant turn");
        deepStrictEqual(body.messages[1]?.["tool_calls"], [{ id: "toolu_read_1", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "notes.txt" }) } }]);
        deepStrictEqual(body.messages[2], { role: "tool", tool_call_id: "toolu_read_1", content: PLAIN_RESULT });
    });
});

describe("openaiapi: the key never reaches a child environment", () => {
    it("OPENAI_API_KEY_FILE is in ROUTER_OWNED_SECRET_VARIABLES and every lane secret is stripped from children", () => {
        ok((ROUTER_OWNED_SECRET_VARIABLES as readonly string[]).includes(OPENAI_API_KEY_FILE_VARIABLE));
        const source: NodeJS.ProcessEnv = {
            PATH: "x",
            [OPENAI_API_KEY_FILE_VARIABLE]: "C:/s.env",
            [OPENAI_API_KEY_VARIABLE]: TEST_KEY,
        };
        for (const child of [sanitizedClaudeEnvironment(source), sanitizedWorkerEnvironment("google", source), sanitizedWorkerEnvironment("openai", source)]) {
            strictEqual(child[OPENAI_API_KEY_FILE_VARIABLE], undefined, "the file path is a secret pointer: stripped");
            strictEqual(child[OPENAI_API_KEY_VARIABLE], undefined, "the key selector guard variable: stripped");
            strictEqual(Object.values(child).includes(TEST_KEY), false);
            strictEqual(child["PATH"], "x", "NEGATIVE: unrelated variables survive");
        }
    });
    it("the router-owned lane variables do not trip the OAuth-only selector guard; the api-key selector OPENAI_API_KEY does", () => {
        assertNoApiKeySelectors({
            [OPENAI_API_KEY_FILE_VARIABLE]: "x",
            ALIBABA_TOKEN_PLAN_API_KEY: TEST_KEY,
            ALIBABA_TOKEN_PLAN_API_KEY_FILE: "x",
            ZAI_API_KEY: TEST_KEY,
            ZAI_API_KEY_FILE: "x",
        });
        throws(() => { assertNoApiKeySelectors({ [OPENAI_API_KEY_VARIABLE]: TEST_KEY }); }, (error: unknown) => error instanceof RouterError &&
            error.message.includes(OPENAI_API_KEY_VARIABLE) &&
            !error.message.includes(TEST_KEY));
    });
});

// The chat-completions translation (openai-sse.ts, openai-message-map.ts) is shared code; this
// lane drives it through its adapter, so these arms pin what the translation promises: a vendor
// extension inside `usage` cannot break the parse, reasoning is not turned into an unsigned
// thinking block, replayed history is translated without refusing the turn, only client tools
// are offered, images become image_url parts, and an upstream status keeps its named class.
const STREAM_WITH_VENDOR_USAGE = sseBody([
    { id: "chatcmpl-vendor-1", choices: [{ index: 0, delta: { role: "assistant", reasoning: "thinking about it" } }] },
    { id: "chatcmpl-vendor-1", choices: [{ index: 0, delta: { content: "PONG" } }] },
    { id: "chatcmpl-vendor-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    // A provider may attach a vendor object to usage; it must not break the parse.
    { id: "chatcmpl-vendor-1", choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 5 }, vendor_extension: { credits: 0, tier: { name: "free" } } } },
    "[DONE]",
]);

describe("openaiapi: shared chat-completions translation (usage, replay, tools, images, status classes)", () => {
    it("tolerates a vendor object inside usage: text streams, usage is the two standard counters, reasoning is not emitted, the receipt settles", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const response = await adapter(sink, (await keyFile()).path, () => new Response(STREAM_WITH_VENDOR_USAGE, { status: 200, headers: { "content-type": "text/event-stream" } }))
            .send(request(openaiRow("gpt-6.1-terra"), {}));
        const text = await readAll(response.body);
        ok(text.includes("\"text\":\"PONG\""), "answer text streamed");
        ok(text.includes("\"message_stop\""), "stream closed properly");
        ok(!text.includes("thinking about it"), "reasoning is not emitted as an unsigned thinking block");
        ok(text.includes("\"usage\":{\"input_tokens\":11,\"output_tokens\":7}"), "usage mapped");
        const completion = await response.completion;
        deepStrictEqual(completion?.usage, { input_tokens: 11, output_tokens: 7 });
        strictEqual(completion?.providerRequestId, "chatcmpl-vendor-1");
    });
    it("tolerates a vendor object inside usage on the non-streaming path too; reasoning is not carried", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const body = { id: "chatcmpl-vendor-2", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "PONG", reasoning: "hidden" } }], usage: { prompt_tokens: 3, completion_tokens: 2, vendor_extension: { credits: 0 } } };
        const response = await adapter(sink, (await keyFile()).path, () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }))
            .send(request(openaiRow("gpt-6.1-sol"), { stream: false }));
        const parsed = JSON.parse(await readAll(response.body)) as { content: { type: string; text: string }[]; usage: unknown };
        deepStrictEqual(parsed.content, [{ type: "text", text: "PONG" }]);
        deepStrictEqual(parsed.usage, { input_tokens: 3, output_tokens: 2 });
        strictEqual(sentJson(sink)["stream"], false);
    });
    it("drops thinking blocks from replayed history instead of refusing the turn", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const history = [
            { role: "user", content: "one" },
            { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "" }, { type: "text", text: "answer" }] },
            { role: "user", content: "two" },
        ];
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6.1-terra"), { messages: history }))).body);
        deepStrictEqual(sentJson(sink)["messages"], [
            { role: "user", content: "one" },
            { role: "assistant", content: "answer" },
            { role: "user", content: "two" },
        ]);
    });
    it("B02 class: an in-conversation system message is merged into the leading system prompt, never dropped", async () => {
        // Claude Code puts a role:"system" entry inside messages (the skill catalogue and
        // reminders); the first translator draft refused it with a 422.
        const sink = { sent: [] as HttpTransportRequest[] };
        const messages = [
            { role: "user", content: "question" },
            { role: "system", content: [{ type: "text", text: "skill catalogue" }] },
        ];
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6.1-sol"), { system: [{ type: "text", text: "base prompt" }], messages }))).body);
        deepStrictEqual(sentJson(sink)["messages"], [
            { role: "system", content: "base prompt\n\nskill catalogue" },
            { role: "user", content: "question" },
        ]);
    });
    it("NEGATIVE: an unknown message role is still refused", async () => {
        const messages = [{ role: "tool", content: "x" }];
        await rejects(adapter({ sent: [] }, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { messages })), (error: unknown) => error instanceof RouterError && error.code === "unsupported_feature");
    });
    it("server and deferred tools are not advertised upstream; client tools are", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const tools = [
            { name: "Read", description: "read", input_schema: { type: "object", properties: {} } },
            { name: "Lazy", defer_loading: true, input_schema: { type: "object" } },
            { type: "web_search_20250305", name: "web_search" },
        ];
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { tools, tool_choice: { type: "auto" } }))).body);
        const sent = sentJson(sink)["tools"] as { function: { name: string } }[];
        deepStrictEqual(sent.map((tool) => tool.function.name), ["Read"]);
    });
    it("an image is forwarded as an image_url part carrying the data URL", async () => {
        const sink = { sent: [] as HttpTransportRequest[] };
        const messages = [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "what" }] }];
        await readAll((await adapter(sink, (await keyFile()).path).send(request(openaiRow("gpt-6-astra"), { messages }))).body);
        const sent = sentJson(sink)["messages"] as { content: { type: string; image_url?: { url: string } }[] }[];
        deepStrictEqual(sent[0]?.content.map((part) => part.type), ["image_url", "text"]);
        strictEqual(sent[0]?.content[0]?.image_url?.url, "data:image/png;base64,AAAA");
    });
    for (const [status, code] of [[403, "provider_auth_required"], [500, "adapter_unavailable"], [503, "adapter_unavailable"]] as const) {
        it(`an upstream HTTP ${status} is answered as ${code} after exactly one call`, async () => {
            const sink = { sent: [] as HttpTransportRequest[] };
            await rejects(adapter(sink, (await keyFile()).path, () => new Response("upstream says no", { status })).send(request(openaiRow("gpt-6-astra"), {})), (error: unknown) => error instanceof RouterError && error.code === code);
            strictEqual(sink.sent.length, 1, "one call, no retry");
        });
    }
});
