import type { RouterErrorCode } from "./contracts.js";
export class RouterError extends Error {
    readonly code: RouterErrorCode;
    readonly status: number;
    readonly retryAfter?: string;
    constructor(code: RouterErrorCode, message: string, status: number, options?: {
        readonly retryAfter?: string;
        readonly cause?: unknown;
    }) {
        super(message, options?.cause === undefined ? undefined : { cause: options.cause });
        this.name = "RouterError";
        this.code = code;
        this.status = status;
        if (options?.retryAfter !== undefined)
            this.retryAfter = options.retryAfter;
    }
}
export function normalizeRouterError(error: unknown): RouterError {
    if (error instanceof RouterError)
        return error;
    if (error instanceof DOMException && error.name === "AbortError") {
        return new RouterError("upstream_timeout", "The upstream request was cancelled or timed out.", 504, {
            cause: error,
        });
    }
    return new RouterError("upstream_protocol_error", "The provider returned an invalid response.", 502, {
        cause: error,
    });
}
export function errorPayload(error: RouterError): Uint8Array {
    return Buffer.from(JSON.stringify({
        type: "error",
        error: { type: error.code, message: error.message },
    }), "utf8");
}
