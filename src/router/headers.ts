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
export function upstreamRequestHeaders(source: Headers, allowProviderAuth: boolean): Headers {
    const result = new Headers();
    for (const [name, value] of source) {
        const normalized = name.toLowerCase();
        if (hopByHopHeaders.has(normalized) || normalized === SESSION_HEADER)
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
