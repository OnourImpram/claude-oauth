import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderModelRecord } from "../src/domain/contracts.js";
import { GROK_CATALOG_CONTEXT_WINDOW_TOKENS, GROK_MODEL_ID } from "../src/domain/model-contracts.js";
import { grokCatalogAfterCacheRefresh } from "../src/domain/model-refresh.js";

// CASE RECORD (measured 2026-11-15). `doctor --live` reported the xAI lane as
// auth_required / "not in live catalog" while the contract model was there: the Grok CLI
// answers the first `initialize` after a period of disuse from its on-disk models_cache.json
// and refreshes that file in the background (its mtime moved during the very next call, which
// then returned grok-4.7 at the pinned window). One stale answer was enough for a refresh to
// drop the lane from the snapshot; it had happened before (2026-09-13, 2026-10-19) and was
// read as a login problem both times.
//
// The check now asks once more when the contract model is missing. That is a retry with a
// changed condition (the first call is what refreshes the cache), bounded at two attempts.

const stale: readonly ProviderModelRecord[] = [{ id: "grok-4.6", contextWindow: 500_000 }, { id: "grok-4.5", contextWindow: 500_000 }];
const fresh: readonly ProviderModelRecord[] = [{ id: GROK_MODEL_ID, contextWindow: GROK_CATALOG_CONTEXT_WINDOW_TOKENS }, ...stale];

function scripted(answers: readonly (readonly ProviderModelRecord[])[]): { readonly inspect: () => Promise<readonly ProviderModelRecord[]>; readonly calls: () => number } {
    let calls = 0;
    return {
        inspect: async () => {
            const answer = answers[Math.min(calls, answers.length - 1)] as readonly ProviderModelRecord[];
            calls += 1;
            return answer;
        },
        calls: () => calls,
    };
}

describe("grokCatalogAfterCacheRefresh", () => {
    it("asks again when the first answer comes from a stale cache, and returns the refreshed catalog", async () => {
        const source = scripted([stale, fresh]);
        const waits: number[] = [];
        const catalog = await grokCatalogAfterCacheRefresh(source.inspect, { sleep: async (ms) => { waits.push(ms); } });
        deepStrictEqual(catalog, fresh);
        strictEqual(source.calls(), 2);
        strictEqual(waits.length, 1, "one pause between the two attempts");
    });

    it("does not ask twice when the first answer already holds the contract model", async () => {
        const source = scripted([fresh]);
        const catalog = await grokCatalogAfterCacheRefresh(source.inspect, { sleep: async () => undefined });
        deepStrictEqual(catalog, fresh);
        strictEqual(source.calls(), 1);
    });

    it("NEGATIVE: a model that is really gone is reported after exactly two attempts, not retried forever", async () => {
        const source = scripted([stale]);
        const catalog = await grokCatalogAfterCacheRefresh(source.inspect, { sleep: async () => undefined });
        deepStrictEqual(catalog, stale, "the caller sees the catalog as it is and reports the mismatch");
        strictEqual(source.calls(), 2);
    });

    it("NEGATIVE: the right id at the wrong window is still a mismatch after the second attempt", async () => {
        const wrongWindow: readonly ProviderModelRecord[] = [{ id: GROK_MODEL_ID, contextWindow: 500_000 }];
        const source = scripted([wrongWindow]);
        deepStrictEqual(await grokCatalogAfterCacheRefresh(source.inspect, { sleep: async () => undefined }), wrongWindow);
        strictEqual(source.calls(), 2);
    });

    it("NEGATIVE: a failing catalog call is not swallowed", async () => {
        await rejects(grokCatalogAfterCacheRefresh(async () => { throw new Error("grok login required"); }, { sleep: async () => undefined }), /grok login required/u);
    });
});
