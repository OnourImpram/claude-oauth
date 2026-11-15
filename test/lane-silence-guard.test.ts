import { ok, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { AgentModelAdapter } from "../src/adapters/agent-model.js";
import { ALIBABA_LANE, AnthropicApiKeyAdapter } from "../src/adapters/anthropic-api-key.js";
import { OPENAI_API_KEY_FILE_VARIABLE, OPENAI_API_KEY_VARIABLE, OpenAiApiKeyAdapter } from "../src/adapters/openai-api-key.js";
import type { HttpTransport, HttpTransportRequest, ModelRecord, ModelSnapshot, ProviderAdapter, ProviderId } from "../src/domain/contracts.js";
import { AgentSessionRegistry, type AgentRunHandle } from "../src/mcp/session-registry.js";
import { ALIBABA_MODEL_CONTRACTS, OPENAI_API_MODEL_CONTRACTS } from "../src/domain/model-contracts.js";
import { withVerifiedAlibabaModels, withVerifiedOpenAiApiModels } from "../src/domain/model-refresh.js";
import { ModelRegistry } from "../src/domain/registry.js";
import { ReceiptStore } from "../src/runtime/receipt-store.js";
import { startRouterServer, type RunningRouter } from "../src/router/server.js";
import { SESSION_HEADER } from "../src/security/nonce.js";

// CASE RECORD (2026-11-15). The router's guard measures how long the PROVIDER has been silent
// (router-stream-watchdog.test.ts, audit D1-01). Two adapters were wired to it when it was
// repaired: the Anthropic OAuth passthrough and the clodex lane. The API-key lanes were not:
//   - The OpenAI API lane translates a chat-completions stream. The translated body
//     carries a router-made ping every 15 s, so it cannot be declared the provider's own
//     bytes; nothing told the guard that the provider had spoken.
//   - Alibaba and Z.AI pass the upstream's own Messages stream through, undeclared.
// On those three lanes the guard was therefore still a cap on TOTAL duration: a long, healthy
// answer was cut at the limit. These arms run the real adapters behind the real router with
// an upstream that keeps speaking for three times the limit.

const TIMEOUT_MS = 200;
const nonce = "s".repeat(43);
// Synthetic credentials: not real keys, exist only in this file.
const TEST_KEY = "silence-guard-unit-test-placeholder-not-a-key";

const baseline: ModelSnapshot = { schemaVersion: 1, generatedAt: "2026-11-15T00:00:00.000Z", source: "test", models: [] };
const openaiSnapshot = withVerifiedOpenAiApiModels(baseline, OPENAI_API_MODEL_CONTRACTS.map((entry) => entry.upstreamModel));
const alibabaSnapshot = withVerifiedAlibabaModels(baseline, ALIBABA_MODEL_CONTRACTS.map((entry) => entry.upstreamModel));

let directory = "";
let router: RunningRouter | undefined;
let receiptsPath = "";
let receiptCounter = 0;

before(async () => {
    directory = await mkdtemp(join(tmpdir(), "lane-silence-"));
});
after(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
afterEach(async () => {
    await router?.close();
    router = undefined;
});

const sleep = async (ms: number): Promise<void> => await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * An upstream that answers 200 at once and then sends one event per interval. On abort the body
 * errors with a plain Error, as the real transport does.
 */
function slowTransport(events: readonly string[], intervalMs: number): HttpTransport {
    return {
        async send(request: HttpTransportRequest): Promise<Response> {
            let timer: NodeJS.Timeout | undefined;
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    let sent = 0;
                    const stop = (): void => {
                        if (timer !== undefined)
                            clearInterval(timer);
                    };
                    request.signal.addEventListener("abort", () => {
                        stop();
                        try {
                            controller.error(new Error("upstream request aborted"));
                        }
                        catch {
                            // already closed
                        }
                    }, { once: true });
                    if (events.length === 0)
                        return; // headers, then silence
                    timer = setInterval(() => {
                        controller.enqueue(new TextEncoder().encode(events[sent] as string));
                        sent += 1;
                        if (sent >= events.length) {
                            stop();
                            controller.close();
                        }
                    }, intervalMs);
                },
                cancel() {
                    if (timer !== undefined)
                        clearInterval(timer);
                },
            });
            return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        },
    };
}

const WORDS = 12;
/** A chat-completions stream: WORDS content deltas, a finish, usage, [DONE]. */
function chatEvents(): string[] {
    const data = (value: unknown): string => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
    return [
        ...Array.from({ length: WORDS }, (_, index) => data({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: `w${index} ` } }] })),
        data({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        data({ id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 3, completion_tokens: WORDS, total_tokens: 3 + WORDS } }),
        data("[DONE]"),
    ];
}
/** A Messages stream: message_start, WORDS text deltas, message_delta, message_stop. */
function messagesEvents(): string[] {
    const event = (name: string, value: unknown): string => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
    return [
        event("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "m", stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }),
        event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        ...Array.from({ length: WORDS }, (_, index) => event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `w${index} ` } })),
        event("content_block_stop", { type: "content_block_stop", index: 0 }),
        event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 3, output_tokens: WORDS } }),
        event("message_stop", { type: "message_stop" }),
    ];
}

async function start(snapshot: ModelSnapshot, provider: ProviderId, adapter: ProviderAdapter): Promise<string> {
    receiptCounter += 1;
    receiptsPath = join(directory, `receipts-${receiptCounter}.jsonl`);
    router = await startRouterServer({
        nonce,
        registry: new ModelRegistry(snapshot, new Map<ProviderId, ProviderAdapter>([[provider, adapter]])),
        receipts: new ReceiptStore(receiptsPath),
        requestTimeoutMs: TIMEOUT_MS,
    });
    return router.baseUrl.replace(/\/$/u, "");
}

async function lastReceipt(waitMs = 2_000): Promise<Record<string, unknown> | undefined> {
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            const last = (await readFile(receiptsPath, "utf8")).split("\n").filter((line) => line.trim() !== "").at(-1);
            if (last !== undefined)
                return JSON.parse(last) as Record<string, unknown>;
        }
        catch {
            // not written yet
        }
        if (Date.now() > deadline)
            return undefined;
        await sleep(20);
    }
}

async function post(base: string, model: string): Promise<{ readonly status: number; readonly text: string }> {
    const response = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { [SESSION_HEADER]: nonce, "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    let text = "";
    try {
        text = await response.text();
    }
    catch {
        // a body cut mid-stream rejects here; the receipt is what the arm reads
    }
    return { status: response.status, text };
}

function modelId(snapshot: ModelSnapshot): string {
    const row = snapshot.models[0];
    ok(row !== undefined, "the lane has a snapshot row");
    return row.id;
}

async function openaiKeyFile(): Promise<string> {
    const path = join(directory, `openai-${receiptCounter}.env`);
    await writeFile(path, `${OPENAI_API_KEY_VARIABLE}="${TEST_KEY}"\n`);
    return path;
}

// 12 words, 50 ms apart, then three closing events: about 750 ms against a 200 ms limit.
const INTERVAL_MS = 50;

/** The OpenAI API lane behind the real router, fed by an upstream that speaks `events` one per interval. */
async function startOpenAiLane(events: readonly string[]): Promise<string> {
    const adapter = new OpenAiApiKeyAdapter(slowTransport(events, INTERVAL_MS), { [OPENAI_API_KEY_FILE_VARIABLE]: await openaiKeyFile() });
    return await start(openaiSnapshot, "openaiapi", adapter);
}

describe("silence guard on the API-key lanes", () => {
    it("OpenAI API: a translated stream that keeps arriving is not cut at the limit", async () => {
        const base = await startOpenAiLane(chatEvents());
        const answer = await post(base, modelId(openaiSnapshot));
        strictEqual((answer.text.match(/"text_delta"/gu) ?? []).length, WORDS, "every word must reach the client");
        ok(answer.text.includes("message_stop"), "the stream ends properly");
        strictEqual((await lastReceipt())?.["status"], "completed");
    });

    it("Alibaba: the passed-through Messages stream is not cut at the limit", async () => {
        const adapter = new AnthropicApiKeyAdapter(slowTransport(messagesEvents(), INTERVAL_MS), ALIBABA_LANE, { [ALIBABA_LANE.keyVariable]: TEST_KEY });
        const base = await start(alibabaSnapshot, "alibaba", adapter);
        const answer = await post(base, modelId(alibabaSnapshot));
        strictEqual((answer.text.match(/"text_delta"/gu) ?? []).length, WORDS, "every word must reach the client");
        ok(answer.text.includes("message_stop"), "the stream ends properly");
        strictEqual((await lastReceipt())?.["status"], "completed");
    });

    it("NEGATIVE: an OpenAI API upstream that sends headers and then nothing is still ended by the guard", async () => {
        const startedAt = Date.now();
        const base = await startOpenAiLane([]);
        const answer = await post(base, modelId(openaiSnapshot));
        ok(!answer.text.includes("message_stop"), "nothing was generated, so nothing may look finished");
        const receipt = await lastReceipt();
        strictEqual(receipt?.["status"], "failed");
        ok(Date.now() - startedAt < 2_000, "ended near the limit, not left hanging");
    });

    it("NEGATIVE: an Alibaba upstream that goes quiet mid-answer is still ended by the guard", async () => {
        // Three events arrive, then the upstream stalls for good.
        const events = messagesEvents().slice(0, 3);
        const stalling: HttpTransport = {
            async send(request: HttpTransportRequest): Promise<Response> {
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        for (const event of events)
                            controller.enqueue(new TextEncoder().encode(event));
                        request.signal.addEventListener("abort", () => {
                            try {
                                controller.error(new Error("upstream request aborted"));
                            }
                            catch {
                                // already closed
                            }
                        }, { once: true });
                    },
                });
                return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
            },
        };
        const adapter = new AnthropicApiKeyAdapter(stalling, ALIBABA_LANE, { [ALIBABA_LANE.keyVariable]: TEST_KEY });
        const base = await start(alibabaSnapshot, "alibaba", adapter);
        const answer = await post(base, modelId(alibabaSnapshot));
        ok(!answer.text.includes("message_stop"), "the stalled answer must not look finished");
        strictEqual((await lastReceipt())?.["status"], "failed");
    });
});

// The agent lanes (Google, xAI) build their own body: live text, a ping, then the outcome.
// The ping is the router's and must never count. The agent's TEXT GROWING is the provider
// speaking, and until 2026-11-15 nothing reported it, so a turn that wrote for longer than
// the limit was cut while it was writing.
const agentModel: ModelRecord = {
    id: "hezarfen-xai-grok-4.6",
    provider: "xai",
    upstreamModel: "grok-4.6",
    displayName: "Grok 4.6",
    oauthType: "xai-cli",
    executionMode: "agent-readonly",
    discoverable: true,
    capabilities: ["messages"],
};
const agentSnapshot: ModelSnapshot = { ...baseline, models: [agentModel] };

class WritingAgent {
    #chunks: string[] = [];
    #resolveDone: () => void = () => undefined;
    readonly done: Promise<void>;
    cancelled = false;

    constructor() {
        this.done = new Promise<void>((resolve) => {
            this.#resolveDone = resolve;
        });
    }

    handle(): AgentRunHandle {
        return {
            done: this.done,
            text: () => this.#chunks.join(""),
            cancel: () => {
                this.cancelled = true;
                this.#resolveDone();
            },
        };
    }

    say(text: string): void {
        this.#chunks.push(text);
    }

    finish(): void {
        this.#resolveDone();
    }
}

function agentAdapter(agent: WritingAgent, onStart: () => void, pingIntervalMs?: number): AgentModelAdapter {
    return new AgentModelAdapter({
        provider: "xai",
        readiness: async () => ({ provider: "xai" as const, oauthReady: true, adapterReady: true, status: "ready" as const, detailCode: "test" }),
        run: async () => {
            throw new Error("the text-only runner must not be reached on the tool path");
        },
        sessions: new AgentSessionRegistry({
            mcpBaseUrl: "http://127.0.0.1:65000",
            progressIntervalMs: 10,
            startAgent: () => {
                onStart();
                return agent.handle();
            },
        }),
        ...(pingIntervalMs === undefined ? {} : { pingIntervalMs }),
    });
}

describe("silence guard on the agent lanes", () => {
    it("an agent that keeps writing is not cut at the limit", async () => {
        const agent = new WritingAgent();
        let timer: NodeJS.Timeout | undefined;
        const adapter = agentAdapter(agent, () => {
            let said = 0;
            timer = setInterval(() => {
                agent.say(`w${said} `);
                said += 1;
                if (said >= WORDS) {
                    clearInterval(timer);
                    agent.finish();
                }
            }, INTERVAL_MS);
        });
        try {
            const base = await start(agentSnapshot, "xai", adapter);
            const answer = await post(base, agentModel.id);
            ok(answer.text.includes(`w${WORDS - 1} `), "the last word must reach the client");
            ok(answer.text.includes("message_stop"), "the stream ends properly");
            strictEqual((await lastReceipt())?.["status"], "completed");
            strictEqual(agent.cancelled, false, "a turn that ended on its own was not cancelled");
        }
        finally {
            clearInterval(timer);
        }
    });

    it("NEGATIVE: an agent that writes nothing is ended at the limit, and the router's own ping does not keep it alive", async () => {
        const agent = new WritingAgent();
        // A ping every 20 ms: ten of them inside the 200 ms limit.
        const base = await start(agentSnapshot, "xai", agentAdapter(agent, () => undefined, 20));
        const startedAt = Date.now();
        const answer = await post(base, agentModel.id);
        ok(!answer.text.includes("message_stop"), "nothing was written, so nothing may look finished");
        strictEqual((await lastReceipt())?.["status"], "failed");
        ok(Date.now() - startedAt < 2_000, "ended near the limit, not left hanging");
        strictEqual(agent.cancelled, true, "the stuck turn itself was cancelled");
    });

    it("NEGATIVE: an agent that stops writing mid-turn is ended at the limit", async () => {
        const agent = new WritingAgent();
        const base = await start(agentSnapshot, "xai", agentAdapter(agent, () => {
            agent.say("w0 ");
            setTimeout(() => agent.say("w1 "), INTERVAL_MS);
        }));
        const answer = await post(base, agentModel.id);
        ok(!answer.text.includes("message_stop"), "the stalled turn must not look finished");
        strictEqual((await lastReceipt())?.["status"], "failed");
        strictEqual(agent.cancelled, true);
    });
});

// CASE RECORD (independent audit D3-02, 2026-11-15). The guard was re-armed by EVERY byte the
// provider sent. A stream of SSE comments, of empty deltas or of `ping` events therefore never
// ended: measured with a 200 ms limit, the requests ran 2492 ms and 2472 ms (the whole length of
// the keep-alive train) and the Alibaba receipt recorded a stream with no content as `completed`.
// Before c56ecd0 a total-duration cap would have ended such a request; after it nothing did.
// A keep-alive proves the connection is open, not that the model is producing anything.
describe("silence guard: a keep-alive is not the provider speaking", () => {
    // 40 keep-alives 50 ms apart: two seconds of traffic against a 200 ms limit.
    const TRAIN = 40;
    const NEAR_LIMIT_MS = 1_200;
    const data = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;

    it("OpenAI API: SSE comments alone do not hold the request open", async () => {
        const startedAt = Date.now();
        const events = Array.from({ length: TRAIN }, () => ": keep-alive\n\n");
        const base = await startOpenAiLane(events);
        const answer = await post(base, modelId(openaiSnapshot));
        const elapsed = Date.now() - startedAt;
        ok(!answer.text.includes("message_stop"), "nothing was generated, so nothing may look finished");
        strictEqual((await lastReceipt())?.["status"], "failed");
        ok(elapsed < NEAR_LIMIT_MS, `ended near the 200 ms limit, not after the keep-alive train; took ${elapsed} ms`);
    });

    it("OpenAI API: chunks whose deltas are empty do not hold the request open", async () => {
        const startedAt = Date.now();
        const events = Array.from({ length: TRAIN }, () => data({ id: "chatcmpl-1", choices: [{ index: 0, delta: {} }] }));
        const base = await startOpenAiLane(events);
        await post(base, modelId(openaiSnapshot));
        const elapsed = Date.now() - startedAt;
        strictEqual((await lastReceipt())?.["status"], "failed");
        ok(elapsed < NEAR_LIMIT_MS, `ended near the 200 ms limit; took ${elapsed} ms`);
    });

    it("Alibaba: ping events alone do not hold the request open, and are not a completed answer", async () => {
        const startedAt = Date.now();
        const events = Array.from({ length: TRAIN }, () => `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`);
        const adapter = new AnthropicApiKeyAdapter(slowTransport(events, INTERVAL_MS), ALIBABA_LANE, { [ALIBABA_LANE.keyVariable]: TEST_KEY });
        const base = await start(alibabaSnapshot, "alibaba", adapter);
        await post(base, modelId(alibabaSnapshot));
        const elapsed = Date.now() - startedAt;
        strictEqual((await lastReceipt())?.["status"], "failed");
        ok(elapsed < NEAR_LIMIT_MS, `ended near the 200 ms limit; took ${elapsed} ms`);
    });

    it("NEGATIVE: reasoning deltas are the provider speaking; a thinking model is not cut", async () => {
        // Twelve reasoning-only chunks (600 ms, three times the limit), then one word and the close.
        const events = [
            ...Array.from({ length: WORDS }, () => data({ id: "chatcmpl-1", choices: [{ index: 0, delta: { reasoning_content: "thinking " } }] })),
            data({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "done" } }] }),
            data({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
            data({ id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
            "data: [DONE]\n\n",
        ];
        const base = await startOpenAiLane(events);
        const answer = await post(base, modelId(openaiSnapshot));
        ok(answer.text.includes("message_stop"), "the stream ends properly");
        strictEqual((await lastReceipt())?.["status"], "completed");
    });
});
