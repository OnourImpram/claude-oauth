import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    claudeConfigDirectory,
    gatewayModelsCachePath,
    gatewayModelsCacheRemedy,
    gatewayModelsCacheStatus,
    projectDiscoveryPayload,
    readGatewayModelsCache,
    shouldWriteGatewayModelsCache,
    writeGatewayModelsCache,
} from "../src/runtime/gateway-models-cache.js";

// Fixture: the real cache MEASURED on disk on 2026-09-02 -- exactly what discovery wrote.
// baseUrl is a dead ephemeral port; this is the file as it stood at the moment the
// operator's picker was empty.
const MEASURED_STALE_CACHE = {
    baseUrl: "http://127.0.0.1:51654",
    fetchedAt: 1788293828770,
    models: [
        { id: "anthropic-openai-gpt-5.6-sol", display_name: "GPT-5.6 Sol via ChatGPT OAuth" },
        { id: "anthropic-google-gemini-3.7-flash-high[1m]", display_name: "Gemini 3.7 Flash High via Google OAuth, read-only agent" },
        { id: "anthropic-xai-grok-4.6", display_name: "Grok 4.6 via xAI OAuth, read-only agent" },
    ],
};

// discoveryPayload() shape: the same fields as registry.ts:66-83.
const DISCOVERY_PAYLOAD = {
    data: [
        { type: "model", id: "anthropic-openai-gpt-5.6-sol", display_name: "GPT-5.6 Sol via ChatGPT OAuth", context_window: 872_000, max_input_tokens: 872_000, max_output_tokens: 128_000 },
        // Since 2026-09-05 Astra carries the ADVERTISED number (1_000_000), Sol the
        // measured one (872_000). The fixture imitates real discovery output; the two
        // numbers differing is deliberate, and the measure of that difference lives in
        // contract-derivation.test.ts.
        { type: "model", id: "anthropic-openai-gpt-6-astra", display_name: "GPT-6 Astra via ChatGPT OAuth", context_window: 1_000_000, max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
        { type: "model", id: "anthropic-xai-grok-4.6", display_name: "Grok 4.6 via xAI OAuth, read-only agent", context_window: 500_000, max_input_tokens: 500_000 },
        // Malformed rows are DROPPED and do not corrupt the file: discovery would not have written them either.
        { type: "model", id: 42, display_name: "malformed id" },
        { type: "model", id: "missing-name" },
        "string",
        null,
    ],
    has_more: false,
    first_id: "anthropic-openai-gpt-5.6-sol",
    last_id: "anthropic-xai-grok-4.6",
};

describe("gateway-models-cache", () => {
    let directory: string;
    let path: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "gateway-models-cache-"));
        path = join(directory, "cache", "gateway-models.json");
    });

    afterEach(async () => {
        // AN INSTRUMENT DEFECT, not a subject defect (measured 2026-09-05, in this run):
        // when the full suite ran in parallel this cleanup failed on Windows in ~4/19 runs
        // with "ENOTEMPTY: directory not empty, rmdir ...\cache" and turned `npm run check`
        // RED; the same file on its own ran 12/12 clean. So the green/red distinction
        // depended not on the code but on whether the file handle happened to be released
        // at the moment of deletion -- and nobody takes a gate like that seriously, so a
        // bypass becomes an incentive defect. maxRetries/retryDelay is Node's documented
        // arm for ENOTEMPTY/EBUSY.
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("projects discoveryPayload to exactly {id, display_name} and drops malformed rows", () => {
        const rows = projectDiscoveryPayload(DISCOVERY_PAYLOAD);
        assert.deepEqual(rows, [
            { id: "anthropic-openai-gpt-5.6-sol", display_name: "GPT-5.6 Sol via ChatGPT OAuth" },
            { id: "anthropic-openai-gpt-6-astra", display_name: "GPT-6 Astra via ChatGPT OAuth" },
            { id: "anthropic-xai-grok-4.6", display_name: "Grok 4.6 via xAI OAuth, read-only agent" },
        ]);
        assert.deepEqual(projectDiscoveryPayload({}), []);
        assert.deepEqual(projectDiscoveryPayload({ data: "invalid" }), []);
    });

    it("round-trips through disk with the measured on-disk schema", async () => {
        const written = await writeGatewayModelsCache(path, "http://127.0.0.1:8791/", projectDiscoveryPayload(DISCOVERY_PAYLOAD), () => 1_700_000_000_000);
        assert.equal(written.baseUrl, "http://127.0.0.1:8791", "trailing slash is stripped -- Claude Code keys the cache by exact base URL");
        const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        assert.deepEqual(Object.keys(raw).sort(), ["baseUrl", "fetchedAt", "models"], "no extra keys: the file must look like discovery wrote it");
        const read = await readGatewayModelsCache(path);
        assert.deepEqual(read, written);
    });

    it("repairs the measured stale cache: dead port -> live port, models preserved", async () => {
        await writeFile(path, JSON.stringify(MEASURED_STALE_CACHE), "utf8").catch(async () => {
            await writeGatewayModelsCache(path, "http://127.0.0.1:1", []);
            await writeFile(path, JSON.stringify(MEASURED_STALE_CACHE), "utf8");
        });
        const before = await gatewayModelsCacheStatus(path, "http://127.0.0.1:8791");
        assert.equal(before.status, "stale");
        assert.equal((before as { cachedBaseUrl: string }).cachedBaseUrl, "http://127.0.0.1:51654");

        await writeGatewayModelsCache(path, "http://127.0.0.1:8791", MEASURED_STALE_CACHE.models);
        const after = await gatewayModelsCacheStatus(path, "http://127.0.0.1:8791");
        assert.equal(after.status, "matches");
        assert.equal((after as { modelCount: number }).modelCount, 3);
    });

    it("reports missing and unreadable by name -- never a silent empty list", async () => {
        assert.deepEqual(await gatewayModelsCacheStatus(path, "http://127.0.0.1:8791"), { status: "missing", path: path });
        await writeGatewayModelsCache(path, "http://127.0.0.1:8791", []);
        await writeFile(path, "{\"baseUrl\": 5}", "utf8");
        const status = await gatewayModelsCacheStatus(path, "http://127.0.0.1:8791");
        assert.equal(status.status, "unreadable");
        assert.match((status as { reason: string }).reason, /baseUrl|fetchedAt|models/u);
    });

    it("A1/A3: writes only when the router holds the pinned port", () => {
        assert.equal(shouldWriteGatewayModelsCache(8791, 8791), true, "pinned session writes");
        assert.equal(shouldWriteGatewayModelsCache(9000, 9000), true, "HEZARFEN_ROUTER_PORT override is the pin");
        // NEGATIVE ARM -- the measured fault: an ephemeral port (51654) does not overwrite the pinned session's cache.
        assert.equal(shouldWriteGatewayModelsCache(51654, 8791), false, "ephemeral session skips");
    });

    it("every non-matching status carries a remedy naming what to do; matches carries none", async () => {
        assert.match(gatewayModelsCacheRemedy(await gatewayModelsCacheStatus(path, "http://127.0.0.1:8791")) ?? "", /launch once/u, "missing");
        await writeGatewayModelsCache(path, "http://127.0.0.1:51654", MEASURED_STALE_CACHE.models);
        const stale = gatewayModelsCacheRemedy(await gatewayModelsCacheStatus(path, "http://127.0.0.1:8791")) ?? "";
        assert.match(stale, /51654/u, "stale remedy names the cached address");
        assert.match(stale, /8791/u, "stale remedy names the live address");
        await writeFile(path, "{\"baseUrl\": 5}", "utf8");
        assert.match(gatewayModelsCacheRemedy(await gatewayModelsCacheStatus(path, "http://127.0.0.1:8791")) ?? "", /delete .*gateway-models\.json/u, "unreadable");
        await writeGatewayModelsCache(path, "http://127.0.0.1:8791", MEASURED_STALE_CACHE.models);
        assert.equal(gatewayModelsCacheRemedy(await gatewayModelsCacheStatus(path, "http://127.0.0.1:8791")), undefined, "matches has no remedy");
    });

    it("resolves the cache path under CLAUDE_CONFIG_DIR when set, else ~/.claude", () => {
        assert.equal(gatewayModelsCachePath({ CLAUDE_CONFIG_DIR: "D:\\cfg" }), join("D:\\cfg", "cache", "gateway-models.json"));
        assert.equal(claudeConfigDirectory({ CLAUDE_CONFIG_DIR: "   " }), claudeConfigDirectory({}), "blank override is ignored");
        assert.ok(gatewayModelsCachePath({}).endsWith(join(".claude", "cache", "gateway-models.json")));
    });
});
