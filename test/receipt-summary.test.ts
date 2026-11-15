import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { RouteReceipt } from "../src/domain/contracts.js";
import { ReceiptStore } from "../src/runtime/receipt-store.js";
import { summarizeReceipts } from "../src/runtime/receipt-summary.js";

// `claude-oauth receipt` showed the LAST request only. Whether a lane had been failing all
// afternoon, how many tokens a model took today, which error class dominated: none of it was
// answerable without reading receipts.jsonl by hand. `claude-oauth receipts` answers from the
// receipts the router already writes; it adds no new record and no prompt text.

const NOW = Date.parse("2026-11-15T12:00:00.000Z");

function receipt(overrides: Partial<RouteReceipt> & { readonly minutesAgo: number }): RouteReceipt {
    const { minutesAgo, ...rest } = overrides;
    return {
        schemaVersion: 1,
        timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
        requestId: `req-${minutesAgo}`,
        requestedModel: "anthropic-openai-gpt-6.1-sol",
        configuredModel: "gpt-6.1-sol",
        provider: "openai",
        oauthType: "chatgpt",
        durationMs: 1_000,
        status: "completed",
        ...rest,
    } as RouteReceipt;
}

describe("summarizeReceipts", () => {
    it("groups by provider and model, counts outcomes, sums tokens and reports the median duration", () => {
        const summary = summarizeReceipts([
            receipt({ minutesAgo: 50, durationMs: 100, usage: { input_tokens: 10, output_tokens: 1 } }),
            receipt({ minutesAgo: 40, durationMs: 300, usage: { input_tokens: 20, output_tokens: 2 } }),
            receipt({ minutesAgo: 30, durationMs: 900, status: "failed", errorCode: "upstream_timeout" }),
            receipt({ minutesAgo: 20, durationMs: 50, status: "cancelled" }),
            receipt({ minutesAgo: 10, provider: "xai", oauthType: "xai-cli", requestedModel: "anthropic-xai-grok-4.7", configuredModel: "grok-4.7", durationMs: 7_000, usage: { input_tokens: 5, output_tokens: 5 } }),
        ], { now: NOW, hours: 24 });
        strictEqual(summary.windowHours, 24);
        strictEqual(summary.requests, 5);
        deepStrictEqual(summary.lanes.map((lane) => `${lane.provider}/${lane.model}`), ["openai/gpt-6.1-sol", "xai/grok-4.7"]);
        const openai = summary.lanes[0];
        deepStrictEqual(
            { requests: openai?.requests, completed: openai?.completed, failed: openai?.failed, cancelled: openai?.cancelled },
            { requests: 4, completed: 2, failed: 1, cancelled: 1 },
        );
        deepStrictEqual({ input: openai?.inputTokens, output: openai?.outputTokens }, { input: 30, output: 3 });
        // 50, 100, 300, 900: the median of an even count is the mean of the middle two.
        strictEqual(openai?.medianDurationMs, 200);
        deepStrictEqual(openai?.errorCodes, { upstream_timeout: 1 });
        strictEqual(openai?.lastAt, new Date(NOW - 20 * 60_000).toISOString());
    });

    it("NEGATIVE: a receipt older than the window is not counted, one exactly on the edge is", () => {
        const summary = summarizeReceipts([
            receipt({ minutesAgo: 61 }),
            receipt({ minutesAgo: 60 }),
            receipt({ minutesAgo: 1 }),
        ], { now: NOW, hours: 1 });
        strictEqual(summary.requests, 2);
    });

    it("NEGATIVE: no receipts is an empty summary, not an error", () => {
        deepStrictEqual(summarizeReceipts([], { now: NOW, hours: 24 }), { windowHours: 24, since: new Date(NOW - 24 * 3_600_000).toISOString(), requests: 0, lanes: [] });
    });

    it("a receipt without usage adds no tokens and is not reported as zero usage measured", () => {
        const summary = summarizeReceipts([receipt({ minutesAgo: 5 })], { now: NOW, hours: 24 });
        strictEqual(summary.lanes[0]?.inputTokens, 0);
        strictEqual(summary.lanes[0]?.requestsWithUsage, 0);
    });

    it("the busiest lane comes first; ties keep provider/model order", () => {
        const summary = summarizeReceipts([
            receipt({ minutesAgo: 9, provider: "xai", oauthType: "xai-cli", configuredModel: "grok-4.7" }),
            receipt({ minutesAgo: 8, provider: "xai", oauthType: "xai-cli", configuredModel: "grok-4.7" }),
            receipt({ minutesAgo: 7 }),
        ], { now: NOW, hours: 24 });
        deepStrictEqual(summary.lanes.map((lane) => lane.provider), ["xai", "openai"]);
    });
});

describe("ReceiptStore.all", () => {
    let directory = "";
    before(async () => {
        directory = await mkdtemp(join(tmpdir(), "receipt-summary-"));
    });
    after(async () => {
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("reads the rotated file before the current one, in order", async () => {
        const path = join(directory, "ordered.jsonl");
        await writeFile(`${path}.previous`, `${JSON.stringify(receipt({ minutesAgo: 30 }))}\n`);
        await writeFile(path, `${JSON.stringify(receipt({ minutesAgo: 20 }))}\n${JSON.stringify(receipt({ minutesAgo: 10 }))}\n`);
        const read = await new ReceiptStore(path).all();
        deepStrictEqual(read.receipts.map((entry) => entry.requestId), ["req-30", "req-20", "req-10"]);
        strictEqual(read.malformedLines, 0);
    });

    it("NEGATIVE: a malformed line is counted and skipped, the readable ones still come back", async () => {
        const path = join(directory, "malformed.jsonl");
        await writeFile(path, `${JSON.stringify(receipt({ minutesAgo: 20 }))}\n{not json\n${JSON.stringify({ schemaVersion: 1, provider: "nobody" })}\n${JSON.stringify(receipt({ minutesAgo: 10 }))}\n`);
        const read = await new ReceiptStore(path).all();
        deepStrictEqual(read.receipts.map((entry) => entry.requestId), ["req-20", "req-10"]);
        strictEqual(read.malformedLines, 2);
    });

    it("NEGATIVE: no receipt file at all is an empty result", async () => {
        deepStrictEqual(await new ReceiptStore(join(directory, "absent.jsonl")).all(), { receipts: [], malformedLines: 0 });
    });
});
