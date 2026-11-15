import { RouterError } from "../domain/errors.js";
import { SESSION_HEADER } from "../security/nonce.js";
const hopByHopHeaders = new Set([
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);
/** The header that carries Claude Code's request class; the router records it in the receipt. */
export const REQUEST_CLASS_HEADER = "x-claude-code-request-class";
/**
 * The headers Claude Code sends only when its gateway-hint gate is open. MEASURED 2026-11-15 in
 * the 2.1.325 binary: the gate returns the environment value CLAUDE_CODE_GATEWAY_HINT_HEADERS
 * when it is set, otherwise a server-side flag that defaults to false; these four header names
 * are the ones built behind it. The launcher opens the gate (claudeRouterEnvironment) so the
 * receipt can carry the request class, and because the router asked for the hints it also
 * consumes them: upstreamRequestHeaders forwards none, so a provider receives nothing it would
 * not have received with the gate closed. Headers the gate does not control (the agent id,
 * the parent agent id, the auxiliary type) are not in this list and cross as before.
 */
export const GATEWAY_HINT_HEADERS: readonly string[] = [
    REQUEST_CLASS_HEADER,
    "x-claude-1p-request-class",
    "x-claude-code-agent-type",
    "x-claude-code-prompt-id",
];
export function upstreamRequestHeaders(source: Headers, allowProviderAuth: boolean): Headers {
    const result = new Headers();
    for (const [name, value] of source) {
        const normalized = name.toLowerCase();
        if (hopByHopHeaders.has(normalized) || normalized === SESSION_HEADER || GATEWAY_HINT_HEADERS.includes(normalized))
            continue;
        if (normalized === "x-api-key") {
            throw new RouterError("provider_auth_required", "Provider API-key headers are not accepted.", 401);
        }
        if (!allowProviderAuth && ["authorization", "cookie"].includes(normalized))
            continue;
        result.append(name, value);
    }
    return result;
}
export function clientResponseHeaders(source: Headers): Headers {
    const result = new Headers();
    for (const [name, value] of source) {
        if (!hopByHopHeaders.has(name.toLowerCase()))
            result.append(name, value);
    }
    return result;
}
