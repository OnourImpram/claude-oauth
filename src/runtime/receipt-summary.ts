import type { ProviderId, RouteReceipt } from "../domain/contracts.js";

export interface ReceiptLaneSummary {
    readonly provider: ProviderId;
    /** The upstream model the lane was configured to call (the receipt's configuredModel). */
    readonly model: string;
    readonly requests: number;
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
    /** Receipts that carried a usage object; the token sums cover these only. */
    readonly requestsWithUsage: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly medianDurationMs: number;
    /** Router error code -> count, for the failed requests that named one. */
    readonly errorCodes: Readonly<Record<string, number>>;
    /** Request class -> count, over the receipts that carried one (Claude Code's own label). */
    readonly requestClasses: Readonly<Record<string, number>>;
    /** Timestamp of the newest receipt of this lane inside the window. */
    readonly lastAt: string;
}

export interface ReceiptSummary {
    readonly windowHours: number;
    /** Start of the window, ISO 8601. */
    readonly since: string;
    readonly requests: number;
    /** Busiest lane first. */
    readonly lanes: readonly ReceiptLaneSummary[];
}

function median(sorted: readonly number[]): number {
    if (sorted.length === 0)
        return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? (sorted[middle] as number) : Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

/**
 * What the lanes did inside the last `hours`: one row per provider and configured model, from
 * the receipts the router already writes (no prompt text, no new record). A receipt exactly on
 * the window's edge counts. Token sums cover only the receipts that carried usage, and
 * `requestsWithUsage` says how many those were, so a lane that reports no usage reads as
 * "not reported", not as zero tokens spent.
 */
export function summarizeReceipts(receipts: readonly RouteReceipt[], options: { readonly now: number; readonly hours: number }): ReceiptSummary {
    const sinceMs = options.now - options.hours * 3_600_000;
    interface Bucket {
        readonly provider: ProviderId;
        readonly model: string;
        readonly durations: number[];
        completed: number;
        failed: number;
        cancelled: number;
        requestsWithUsage: number;
        inputTokens: number;
        outputTokens: number;
        readonly errorCodes: Record<string, number>;
        readonly requestClasses: Record<string, number>;
        lastAtMs: number;
        lastAt: string;
    }
    const buckets = new Map<string, Bucket>();
    let requests = 0;
    for (const receipt of receipts) {
        const at = Date.parse(receipt.timestamp);
        if (Number.isNaN(at) || at < sinceMs)
            continue;
        requests += 1;
        const key = `${receipt.provider}\u0000${receipt.configuredModel}`;
        let bucket = buckets.get(key);
        if (bucket === undefined) {
            bucket = { provider: receipt.provider, model: receipt.configuredModel, durations: [], completed: 0, failed: 0, cancelled: 0, requestsWithUsage: 0, inputTokens: 0, outputTokens: 0, errorCodes: {}, requestClasses: {}, lastAtMs: at, lastAt: receipt.timestamp };
            buckets.set(key, bucket);
        }
        bucket.durations.push(receipt.durationMs);
        bucket[receipt.status] += 1;
        if (receipt.usage !== undefined) {
            bucket.requestsWithUsage += 1;
            bucket.inputTokens += receipt.usage["input_tokens"] ?? 0;
            bucket.outputTokens += receipt.usage["output_tokens"] ?? 0;
        }
        if (receipt.errorCode !== undefined)
            bucket.errorCodes[receipt.errorCode] = (bucket.errorCodes[receipt.errorCode] ?? 0) + 1;
        if (receipt.requestClass !== undefined)
            bucket.requestClasses[receipt.requestClass] = (bucket.requestClasses[receipt.requestClass] ?? 0) + 1;
        if (at >= bucket.lastAtMs) {
            bucket.lastAtMs = at;
            bucket.lastAt = receipt.timestamp;
        }
    }
    const lanes = [...buckets.values()]
        .map((bucket): ReceiptLaneSummary => ({
            provider: bucket.provider,
            model: bucket.model,
            requests: bucket.durations.length,
            completed: bucket.completed,
            failed: bucket.failed,
            cancelled: bucket.cancelled,
            requestsWithUsage: bucket.requestsWithUsage,
            inputTokens: bucket.inputTokens,
            outputTokens: bucket.outputTokens,
            medianDurationMs: median([...bucket.durations].sort((left, right) => left - right)),
            errorCodes: bucket.errorCodes,
            requestClasses: bucket.requestClasses,
            lastAt: bucket.lastAt,
        }))
        .sort((left, right) => right.requests - left.requests || left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model));
    return { windowHours: options.hours, since: new Date(sinceMs).toISOString(), requests, lanes };
}
