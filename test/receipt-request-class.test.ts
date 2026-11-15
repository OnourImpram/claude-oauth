import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { FakeAdapter } from "../src/adapters/fake.js";
import type { ModelSnapshot, ProviderAdapter, ProviderId, RouteReceipt } from "../src/domain/contracts.js";
import { ModelRegistry } from "../src/domain/registry.js";
import { ReceiptStore } from "../src/runtime/receipt-store.js";
import { summarizeReceipts } from "../src/runtime/receipt-summary.js";
import { startRouterServer, type RunningRouter } from "../src/router/server.js";
import { SESSION_HEADER } from "../src/security/nonce.js";

// MEASURED 2026-11-15 in the Claude Code 2.1.325 binary: the client names a header
// `x-claude-code-request-class` and a closed value list
// ["main","subagent","workflow","compaction","auxiliary","side_reply"]. The router records the
// class in the receipt when the header carries one of exactly those values. It is an
// observability field only: nothing is routed by it, and a value outside the list is dropped
// (a client-supplied string never lands in the receipt file as free text).

const nonce = "c".repeat(43);
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

let directory = "";
let router: RunningRouter | undefined;
let counter = 0;

before(async () => {
    directory = await mkdtemp(join(tmpdir(), "receipt-class-"));
});
after(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
afterEach(async () => {
    await router?.close();
    router = undefined;
});

const answering = (): ProviderAdapter => new FakeAdapter("anthropic", () => ({
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: new Blob(["{}"]).stream() as ReadableStream<Uint8Array>,
}));

async function roundTrip(headers: Record<string, string>, adapter: ProviderAdapter = answering()): Promise<RouteReceipt | undefined> {
    counter += 1;
    const store = new ReceiptStore(join(directory, `receipts-${counter}.jsonl`));
    router = await startRouterServer({
        nonce,
        registry: new ModelRegistry(snapshot, new Map<ProviderId, ProviderAdapter>([["anthropic", adapter]])),
        receipts: store,
    });
    const response = await fetch(`${router.baseUrl.replace(/\/$/u, "")}/v1/messages`, {
        method: "POST",
        headers: { [SESSION_HEADER]: nonce, "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: "claude-opus-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    await response.text();
    await router.close();
    router = undefined;
    return await store.last();
}

describe("request class in the receipt", () => {
    it("a class the client names is recorded", async () => {
        strictEqual((await roundTrip({ "x-claude-code-request-class": "subagent" }))?.requestClass, "subagent");
    });

    it("every value of the measured list is accepted", async () => {
        for (const value of ["main", "subagent", "workflow", "compaction", "auxiliary", "side_reply"])
            strictEqual((await roundTrip({ "x-claude-code-request-class": value }))?.requestClass, value);
    });

    it("NEGATIVE: a value outside the list is dropped, and the receipt is still written", async () => {
        const receipt = await roundTrip({ "x-claude-code-request-class": "main\"}, \"injected\": {\"x" });
        strictEqual(receipt?.status, "completed");
        strictEqual("requestClass" in (receipt ?? {}), false);
        const upper = await roundTrip({ "x-claude-code-request-class": "MAIN" });
        strictEqual("requestClass" in (upper ?? {}), false, "the list is matched exactly, not case-folded");
    });

    // Independent audit D3-01 (2026-11-15). The arm above reads the receipt back through the
    // parser, and the parser has its own closed-list filter: with the SERVER's filter removed it
    // stayed green (7 of 7) while a raw read showed the client's string in the file. The contract
    // is about the file, so this arm reads the bytes.
    it("NEGATIVE: a value outside the list never reaches the receipt FILE (raw bytes, not the parser)", async () => {
        await roundTrip({ "x-claude-code-request-class": "free-text-from-the-client" });
        const raw = await readFile(join(directory, `receipts-${counter}.jsonl`), "utf8");
        ok(raw.includes("\"status\":\"completed\""), "the receipt line was written");
        strictEqual(raw.includes("free-text-from-the-client"), false, "the client's string is not in the file");
        strictEqual(raw.includes("requestClass"), false, "no requestClass key is written for a value outside the list");
    });

    it("NEGATIVE: no header, no field", async () => {
        const receipt = await roundTrip({});
        strictEqual(receipt?.status, "completed");
        strictEqual("requestClass" in (receipt ?? {}), false);
    });

    it("a failed request keeps its class", async () => {
        const failing = new FakeAdapter("anthropic", () => {
            throw new Error("boom");
        });
        const receipt = await roundTrip({ "x-claude-code-request-class": "compaction" }, failing);
        strictEqual(receipt?.status, "failed");
        strictEqual(receipt?.requestClass, "compaction");
    });
});

describe("request class on disk and in the summary", () => {
    const NOW = Date.parse("2026-11-15T12:00:00.000Z");
    const base = {
        schemaVersion: 1,
        requestedModel: "claude-opus-5",
        configuredModel: "claude-opus-5",
        provider: "anthropic",
        oauthType: "claude.ai",
        durationMs: 10,
        status: "completed",
    } as const;

    it("NEGATIVE: an unknown class already on disk is dropped on read, the receipt survives", async () => {
        const path = join(directory, "on-disk.jsonl");
        await writeFile(path, [
            JSON.stringify({ ...base, timestamp: new Date(NOW - 60_000).toISOString(), requestId: "a", requestClass: "subagent" }),
            JSON.stringify({ ...base, timestamp: new Date(NOW - 30_000).toISOString(), requestId: "b", requestClass: "something-new" }),
        ].join("\n") + "\n");
        const read = await new ReceiptStore(path).all();
        strictEqual(read.malformedLines, 0);
        deepStrictEqual(read.receipts.map((entry) => entry.requestClass), ["subagent", undefined]);
    });

    it("the summary counts requests per class, and leaves unclassified requests out of the count", () => {
        const at = (seconds: number): string => new Date(NOW - seconds * 1_000).toISOString();
        const summary = summarizeReceipts([
            { ...base, timestamp: at(50), requestId: "1", requestClass: "main" },
            { ...base, timestamp: at(40), requestId: "2", requestClass: "subagent" },
            { ...base, timestamp: at(30), requestId: "3", requestClass: "subagent" },
            { ...base, timestamp: at(20), requestId: "4" },
        ], { now: NOW, hours: 1 });
        strictEqual(summary.lanes[0]?.requests, 4);
        deepStrictEqual(summary.lanes[0]?.requestClasses, { main: 1, subagent: 2 });
    });
});
