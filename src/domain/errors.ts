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
/**
 * For the CLI's own top level, where most failures are local (audit D1-03, 2026-11-15): a
 * missing claude.exe reached main() as a bare ENOENT and was printed as
 * upstream_protocol_error, "The provider returned an invalid response", before any provider
 * existed. A file-system failure is named by its errno code, system call and path. Any other
 * foreign error contributes its NAME only: an arbitrary message can carry a URL with the
 * session nonce in it, so it is never echoed (the stack frames go to router.log, redacted).
 */
export function normalizeCliError(error: unknown): RouterError {
    if (error instanceof RouterError)
        return error;
    if (error instanceof DOMException && error.name === "AbortError")
        return normalizeRouterError(error);
    if (error instanceof Error) {
        const failure = error as NodeJS.ErrnoException;
        if (typeof failure.code === "string" && /^E[A-Z0-9_]+$/u.test(failure.code)) {
            const detail = [failure.code, failure.syscall, failure.path].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
            return new RouterError("local_failure", `A local file operation failed: ${detail}. No provider was involved. Run claude-oauth doctor.`, 500, { cause: error });
        }
        return new RouterError("local_failure", `claude-oauth failed with an internal error (${error.name}). No provider answered with it; see router.log, event cli_fatal.`, 500, { cause: error });
    }
    return new RouterError("local_failure", "claude-oauth failed with an internal error. See router.log, event cli_fatal.", 500, { cause: error });
}
