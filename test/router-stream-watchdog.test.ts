import { ok, strictEqual } from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { FakeAdapter } from "../src/adapters/fake.js";
import type { AdapterRequest, AdapterResponse, ModelSnapshot, ProviderAdapter, ProviderId } from "../src/domain/contracts.js";
import { ModelRegistry } from "../src/domain/registry.js";
import { ReceiptStore } from "../src/runtime/receipt-store.js";
import { startRouterServer, type RunningRouter } from "../src/router/server.js";
import { SESSION_HEADER } from "../src/security/nonce.js";

// CASE RECORD (2026-11-15, audit finding D1-01). The router armed ONE 300 s timer before the
// adapter call and cleared it only after the whole body had streamed. It was meant as a
// "the provider went quiet" guard and worked as a cap on total response time: a healthy
// stream still producing tokens at 300 s was cut mid-body, with no message_stop and no error
// event, and the cut was then filed as upstream_protocol_error ("the provider returned an
// invalid response") although the router's own timer made it.
//
// The guard now measures silence, not duration. What counts as "the provider spoke":
//   - a body chunk, when the adapter declares the body to be the provider's own bytes
//     (upstreamDriven), or
//   - the adapter calling request.upstreamActivity(), for adapters that build the body
//     themselves (translation, synthetic keep-alives).
// A keep-alive the router generates is NOT the provider speaking: the agent lanes rely on
// this guard to end a stuck turn (session-registry FINDING 1), and a ping every 15 s must
// not make a stuck turn immortal.

const TIMEOUT_MS = 200;
const nonce = "w".repeat(43);
const snapshot: ModelSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    source: "pinned-install-baseline",
    models: [{
        id: "claude-opus-5",
        provider: "anthropic",
        upstreamModel: "claude-opus-5",
        displayName: "Claude Opus 5",
        oauthType: "claude.ai",
        executionMode: "native-message-loop",
        discoverable: true,
        capabilities: ["messages"],
    }],
};
const requestBody = JSON.stringify({ model: "claude-opus-5", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] });

let directory = "";
let router: RunningRouter | undefined;
let receiptsPath = "";
let receiptCounter = 0;

before(async () => {
    directory = await mkdtemp(join(tmpdir(), "router-watchdog-"));
});
after(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
afterEach(async () => {
    await router?.close();
    router = undefined;
});

const sleep = async (ms: number): Promise<void> => await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

interface StreamPlan {
    /** Milliseconds between chunks. */
    readonly intervalMs: number;
    readonly chunks: number;
    readonly chunk?: (index: number) => Uint8Array;
    readonly upstreamDriven?: boolean;
    /** Call request.upstreamActivity() with every chunk, as a translating adapter does. */
    readonly reportsActivity?: boolean;
}

// A fake upstream that behaves like the real transport on abort: the body errors with the
// transport's plain Error, not with an AbortError.
function streamingAdapter(plan: StreamPlan): ProviderAdapter {
    return new FakeAdapter("anthropic", (request: AdapterRequest): AdapterResponse => {
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
                if (plan.chunks === 0)
                    return; // headers, then silence
                timer = setInterval(() => {
                    if (plan.reportsActivity === true)
                        request.upstreamActivity?.();
                    controller.enqueue(plan.chunk?.(sent) ?? encode(`event: content_block_delta\ndata: {"n":${sent}}\n\n`));
                    sent += 1;
                    if (sent >= plan.chunks) {
                        stop();
                        controller.close();
                    }
                }, plan.intervalMs);
            },
            cancel() {
                if (timer !== undefined)
                    clearInterval(timer);
            },
        });
        return {
            status: 200,
            headers: new Headers({ "content-type": "text/event-stream" }),
            body,
            ...(plan.upstreamDriven === true ? { upstreamDriven: true } : {}),
        };
    });
}

async function start(adapter: ProviderAdapter): Promise<string> {
    receiptCounter += 1;
    receiptsPath = join(directory, `receipts-${receiptCounter}.jsonl`);
    router = await startRouterServer({
        nonce,
        registry: new ModelRegistry(snapshot, new Map<ProviderId, ProviderAdapter>([["anthropic", adapter]])),
        receipts: new ReceiptStore(receiptsPath),
        requestTimeoutMs: TIMEOUT_MS,
    });
    return router.baseUrl.replace(/\/$/u, "");
}

async function lastReceipt(waitMs = 2_000): Promise<Record<string, unknown> | undefined> {
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            const lines = (await readFile(receiptsPath, "utf8")).split("\n").filter((line) => line.trim() !== "");
            const last = lines.at(-1);
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

async function post(base: string): Promise<Response> {
    return await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { [SESSION_HEADER]: nonce, "content-type": "application/json" },
        body: requestBody,
    });
}

describe("router stream watchdog", () => {
    it("a provider that keeps speaking is not cut, however long the whole response takes", async () => {
        // 12 chunks, 50 ms apart: 600 ms in total against a 200 ms limit.
        const base = await start(streamingAdapter({ intervalMs: 50, chunks: 12, upstreamDriven: true }));
        const response = await post(base);
        const text = await response.text();
        strictEqual((text.match(/content_block_delta/gu) ?? []).length, 12, "every chunk must reach the client");
        const receipt = await lastReceipt();
        strictEqual(receipt?.["status"], "completed");
    });

    it("a translating adapter that reports provider activity is not cut either", async () => {
        const base = await start(streamingAdapter({ intervalMs: 50, chunks: 12, reportsActivity: true }));
        const text = await (await post(base)).text();
        strictEqual((text.match(/content_block_delta/gu) ?? []).length, 12);
        strictEqual((await lastReceipt())?.["status"], "completed");
    });

    it("NEGATIVE: a provider that sends headers and then goes quiet is cut, and the cut is named a timeout", async () => {
        const base = await start(streamingAdapter({ intervalMs: 50, chunks: 0, upstreamDriven: true }));
        const started = Date.now();
        const response = await post(base);
        await response.text().catch(() => undefined);
        const elapsed = Date.now() - started;
        ok(elapsed >= TIMEOUT_MS - 20 && elapsed < TIMEOUT_MS + 1_500, `cut after ${elapsed} ms`);
        const receipt = await lastReceipt();
        strictEqual(receipt?.["status"], "failed");
        strictEqual(receipt?.["errorCode"], "upstream_timeout", "the router's own timer must not be filed as a provider protocol error");
    });

    it("NEGATIVE: keep-alives the router itself generates do not count as the provider speaking", async () => {
        // No upstreamDriven, no upstreamActivity: the body is only synthetic pings, as on an
        // agent lane whose turn is stuck. The guard must still end it (session-registry FINDING 1).
        const base = await start(streamingAdapter({ intervalMs: 40, chunks: 1_000, chunk: () => encode(": ping\n\n") }));
        const started = Date.now();
        const response = await post(base);
        await response.text().catch(() => undefined);
        const elapsed = Date.now() - started;
        ok(elapsed < TIMEOUT_MS + 1_500, `a stuck turn that only pings must be ended, ran ${elapsed} ms`);
        strictEqual((await lastReceipt())?.["errorCode"], "upstream_timeout");
    });

    it("NEGATIVE: a provider that never answers gets a 504 timeout envelope", async () => {
        const never = new FakeAdapter("anthropic", async (request: AdapterRequest): Promise<AdapterResponse> => await new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(new Error("upstream request aborted")), { once: true });
        }));
        const base = await start(never);
        const response = await post(base);
        strictEqual(response.status, 504);
        const payload = await response.json() as { error: { type: string } };
        strictEqual(payload.error.type, "upstream_timeout");
        strictEqual((await lastReceipt())?.["errorCode"], "upstream_timeout");
    });

    it("a client that walks away mid-stream is a cancellation, not a provider failure", async () => {
        const base = await start(streamingAdapter({ intervalMs: 30, chunks: 1_000, upstreamDriven: true }));
        const controller = new AbortController();
        const response = await fetch(`${base}/v1/messages`, {
            method: "POST",
            headers: { [SESSION_HEADER]: nonce, "content-type": "application/json" },
            body: requestBody,
            signal: controller.signal,
        });
        const reader = response.body?.getReader();
        await reader?.read();
        controller.abort();
        const receipt = await lastReceipt();
        strictEqual(receipt?.["status"], "cancelled");
        strictEqual(receipt?.["errorCode"], undefined);
    });

    it("a slow client is not mistaken for a silent provider: time spent waiting on the client does not count", async () => {
        // 24 MiB arrive at once; the client reads nothing for 600 ms (three times the limit),
        // then reads everything. The provider was never silent, the client was slow.
        const megabyte = new Uint8Array(1024 * 1024).fill(0x62);
        const base = await start(streamingAdapter({ intervalMs: 1, chunks: 24, chunk: () => megabyte, upstreamDriven: true }));
        const url = new URL(`${base}/v1/messages`);
        const outgoing = httpRequest(url, { method: "POST", headers: { [SESSION_HEADER]: nonce, "content-type": "application/json" } });
        outgoing.end(requestBody);
        const [incoming] = await once(outgoing, "response") as [IncomingMessage];
        await sleep(600);
        let bytes = 0;
        for await (const chunk of incoming)
            bytes += (chunk as Buffer).length;
        strictEqual(bytes, 24 * 1024 * 1024, "the whole body must arrive once the client reads");
        strictEqual((await lastReceipt())?.["status"], "completed");
    });

    it("a client that disconnects while the router waits on back-pressure does not leave the handler hanging (D1-05)", async () => {
        // Large chunks, as fast as possible, to a client that never reads: write() returns
        // false and the handler waits for "drain". Then the client goes away.
        const megabyte = new Uint8Array(1024 * 1024).fill(0x61);
        const base = await start(streamingAdapter({ intervalMs: 1, chunks: 100_000, chunk: () => megabyte, upstreamDriven: true }));
        const url = new URL(base);
        const socket = connect(Number(url.port), url.hostname);
        await new Promise<void>((resolveConnect) => socket.once("connect", () => resolveConnect()));
        socket.pause();
        socket.write(`POST /v1/messages HTTP/1.1\r\nHost: ${url.host}\r\n${SESSION_HEADER}: ${nonce}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(requestBody)}\r\n\r\n${requestBody}`);
        await sleep(400); // let the socket buffer fill and the handler park on drain
        socket.destroy();
        const receipt = await lastReceipt(3_000);
        ok(receipt !== undefined, "the handler must settle and write a receipt after the client is gone");
        strictEqual(receipt["status"], "cancelled");
    });
});
