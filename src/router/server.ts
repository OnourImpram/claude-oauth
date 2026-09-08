import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import type { AdapterResponse, RouteReceipt } from "../domain/contracts.js";
import { RouterError, errorPayload, normalizeRouterError } from "../domain/errors.js";
import { ModelRegistry } from "../domain/registry.js";
import { numericUsage, parseMessageEnvelope } from "../domain/validation.js";
import { ReceiptStore } from "../runtime/receipt-store.js";
import { writeSafeLog, type SafeLogEntry } from "../runtime/log.js";
import { nonceMatches, SESSION_HEADER } from "../security/nonce.js";
import type { McpToolBridge } from "../mcp/tool-bridge.js";
import { clientResponseHeaders } from "./headers.js";
export interface RouterServerOptions {
    readonly nonce: string;
    readonly registry: ModelRegistry;
    readonly receipts: ReceiptStore;
    // Verilmezse efemeral port kullanilir; o durumda /model listesi harici
    // modelleri gostermez (bkz. preferredLoopbackPort).
    readonly preferredPort?: number;
    // Faz 9: Claude Code araclarini ACP ajanina sunan MCP ucu. Verilmezse
    // /mcp yolu 404 doner -- yani bu yetenek YAPILANDIRILMAMIS demektir, ve
    // o durum sessiz bir basarisizlik degil, adi konmus bir 404'tur.
    readonly mcpBridge?: (sessionKey: string) => McpToolBridge | undefined;
}
export interface RunningRouter {
    readonly baseUrl: string;
    readonly port: number;
    close(): Promise<void>;
}
const maximumBodyBytes = 64 * 1024 * 1024;
const requestTimeoutMs = 300_000;
async function readBody(request: IncomingMessage): Promise<Buffer> {
    const contentLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
    if (Number.isFinite(contentLength) && contentLength > maximumBodyBytes) {
        throw new RouterError("invalid_request", "Request body exceeds the local router limit.", 413);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += buffer.length;
        if (size > maximumBodyBytes)
            throw new RouterError("invalid_request", "Request body exceeds the local router limit.", 413);
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}
function requestHeaders(request: IncomingMessage): Headers {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value))
            for (const entry of value)
                headers.append(name, entry);
        else if (value !== undefined)
            headers.set(name, value);
    }
    return headers;
}
function writeHeaders(response: ServerResponse, headers: Headers): void {
    for (const [name, value] of clientResponseHeaders(headers))
        response.setHeader(name, value);
}
async function streamResponse(response: ServerResponse, upstream: AdapterResponse): Promise<void> {
    response.statusCode = upstream.status;
    writeHeaders(response, upstream.headers);
    if (upstream.body === null) {
        return;
    }
    const reader = upstream.body.getReader();
    try {
        for (;;) {
            const result = await reader.read();
            if (result.done)
                break;
            if (!response.write(Buffer.from(result.value)))
                await once(response, "drain");
        }
    }
    finally {
        reader.releaseLock();
    }
}
function writeJson(response: ServerResponse, status: number, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    response.writeHead(status, { "content-type": "application/json", "content-length": String(body.length) });
    response.end(body);
}
async function appendReceipt(store: ReceiptStore, receipt: RouteReceipt): Promise<void> {
    try {
        await store.append(receipt);
    }
    catch {
        writeSafeLog({ event: "receipt_write_failed", level: "error", requestId: receipt.requestId, provider: receipt.provider });
    }
}
export async function startRouterServer(options: RouterServerOptions): Promise<RunningRouter> {
    const server = createServer((request, response) => {
        void handleRequest(request, response, options);
    });
    server.keepAliveTimeout = 75_000;
    server.headersTimeout = 80_000;
    server.requestTimeout = 0;
    // Sabit port denenir; mesgulse efemerale duseriz -- ama SESSIZCE degil.
    // Efemeral porta dusmek picker'i yeniden bosaltir, bu yuzden sebebi gorunur
    // olmak zorunda: alarmin sessizligi kabul olcutu yapilamaz.
    let listenFallbackReason: string | undefined;
    if (options.preferredPort !== undefined) {
        server.listen(options.preferredPort, "127.0.0.1");
        try {
            await once(server, "listening");
        }
        catch (error) {
            listenFallbackReason = (error as NodeJS.ErrnoException).code ?? "listen_failed";
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
        }
    }
    else {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
    }
    const address = server.address() as AddressInfo;
    if (listenFallbackReason !== undefined) {
        writeSafeLog({
            event: "loopback_pinned_port_unavailable",
            level: "warn",
            code: listenFallbackReason,
            remedy: `Pinned loopback port ${options.preferredPort} is taken, so this session listens on ${address.port} instead. The session works, but Claude Code caches gateway model discovery per base URL, so /model will not list external models until the pinned port is free. Free it, or set HEZARFEN_ROUTER_PORT to another stable port.`,
        });
    }
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        port: address.port,
        close: async () => {
            server.close();
            server.closeIdleConnections();
            server.closeAllConnections();
            await once(server, "close");
        },
    };
}
// Presence, never value. A missing channel and a channel carrying the wrong secret are
// different defects and must not collapse into one line.
function describeAuthChannels(headers: IncomingMessage["headers"], pathNonceValid: boolean, nonce: string): readonly string[] {
    const arrived: string[] = [];
    if (headers[SESSION_HEADER] !== undefined) arrived.push("sessionHeader");
    const authorization = headers["authorization"];
    if (authorization !== undefined) {
        arrived.push("authorization");
        // "A credential arrived" and "OUR credential arrived through the wrong door" are
        // different events with opposite remedies, and a bare channel name collapses them.
        if (!Array.isArray(authorization) && nonceMatches(nonce, authorization.replace(/^Bearer /iu, "")))
            arrived.push("authorizationIsSessionNonce");
    }
    if (headers["x-api-key"] !== undefined) arrived.push("apiKey");
    if (pathNonceValid) arrived.push("urlPath");
    return arrived;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, options: RouterServerOptions): Promise<void> {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const routedTarget = sessionTarget(request.url, options.nonce);
    const route = classifyRoute(routedTarget.target.pathname);
    let receiptBase: Pick<RouteReceipt, "requestedModel" | "configuredModel" | "provider" | "oauthType"> | undefined;
    // registry.resolve() firlatirsa receiptBase hic atanmaz, makbuz yazilmaz ve log
    // hangi modelin istendigini soylemez -- "model_not_available" teshis edilemez olur.
    // Istenen model, cozumlemeden ONCE yakalanir.
    let requestedModel: string | undefined;
    try {
        const { target, pathNonceValid } = routedTarget;
        if (request.method === "HEAD" && (target.pathname === "/api/hello" || target.pathname === "/")) {
            response.writeHead(200);
            response.end();
            return;
        }
        const suppliedNonce = request.headers[SESSION_HEADER];
        const headerNonceValid = !Array.isArray(suppliedNonce) && nonceMatches(options.nonce, suppliedNonce);
        if (!headerNonceValid && !pathNonceValid) {
            // A 401 that only says "no valid session" cannot be diagnosed: it does not
            // distinguish a caller that sent nothing from one that sent the same secret
            // through a channel this gate does not read. Which channels ARRIVED is
            // recorded -- presence only, never a value, so the log stays safe to keep.
            //
            // The gate deliberately stays closed to the authorization channel even when it
            // carries our own nonce. Opening it would not make those callers work: the
            // Anthropic adapter forwards authorization upstream verbatim, so a request
            // whose only credential is the loopback nonce would fail at the provider AND
            // ship a local secret off the machine. Refusing at the door is the cheaper end.
            writeSafeLog({
                event: "session_auth_channels",
                level: "warn",
                code: "session_auth_required",
                route: classifyRoute(routedTarget.target.pathname),
                authChannels: describeAuthChannels(request.headers, pathNonceValid, options.nonce),
                remedy: "The gate is fail-closed and refused a caller that carried no session header. ONARIM: authorizationIsSessionNonce means the launcher is publishing the session nonce as a credential -- it must not. That was measured to break the Claude path outright (the client sends the nonce instead of its OAuth token and Anthropic answers 401 Invalid bearer token), so remove it from the child environment rather than opening this gate. Without that marker the caller holds a credential that is not this router's, and that is worth investigating.",
            });
            throw new RouterError("session_auth_required", "A valid local session header is required.", 401);
        }
        // Faz 9 / Yol 4 -- MCP ucu. Kapinin ARKASINDA duruyor: buraya gelen her
        // istek yukaridaki nonce kolundan gecmistir, yani saglayici ajani da ayni
        // oturum sirrini tasimak zorunda. Ayri dinleyici, ayri port, yeni kimlik
        // sinifi YOK (spec §6): kapi zaten kurulu ve negatif kontrollu.
        const mcpMatch = /^\/mcp\/([A-Za-z0-9_-]{1,128})$/u.exec(target.pathname);
        if (mcpMatch !== null) {
            await handleMcp(request, response, options, mcpMatch[1] as string);
            return;
        }
        if (request.method === "GET" && target.pathname === "/v1/models") {
            writeJson(response, 200, options.registry.discoveryPayload());
            return;
        }
        const isMessages = target.pathname === "/v1/messages";
        const isCountTokens = target.pathname === "/v1/messages/count_tokens";
        if (request.method !== "POST" || (!isMessages && !isCountTokens)) {
            throw new RouterError("invalid_request", "Route not found.", 404);
        }
        const body = await readBody(request);
        const envelope = parseMessageEnvelope(body, isMessages);
        requestedModel = envelope.model;
        const route = options.registry.resolve(envelope.model);
        receiptBase = {
            requestedModel: envelope.model,
            configuredModel: route.model.upstreamModel,
            provider: route.model.provider,
            oauthType: route.model.oauthType,
        };
        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(new Error("upstream timeout")), requestTimeoutMs);
        request.once("aborted", () => abortController.abort(new Error("client aborted")));
        response.once("close", () => {
            if (!response.writableEnded)
                abortController.abort(new Error("client disconnected"));
        });
        let upstream: AdapterResponse;
        try {
            upstream = await route.adapter.send({
                requestId,
                path: isMessages ? "/v1/messages" : "/v1/messages/count_tokens",
                query: target.search,
                model: route.model,
                envelope,
                body,
                headers: requestHeaders(request),
                signal: abortController.signal,
            });
            await streamResponse(response, upstream);
            const completion = await upstream.completion;
            const providerRequestId = completion?.providerRequestId ?? upstream.providerRequestId;
            const providerUsage = completion?.usage ?? upstream.usage;
            await appendReceipt(options.receipts, {
                schemaVersion: 1,
                timestamp: new Date().toISOString(),
                requestId,
                ...receiptBase,
                ...(providerRequestId === undefined ? {} : { providerRequestId }),
                durationMs: Math.round(performance.now() - startedAt),
                status: abortController.signal.aborted ? "cancelled" : upstream.status >= 400 ? "failed" : "completed",
                ...(providerUsage === undefined ? {} : { usage: numericUsage(providerUsage) ?? {} }),
            });
        }
        finally {
            clearTimeout(timeout);
        }
        response.end();
    }
    catch (caught) {
        const error = normalizeRouterError(caught);
        if (!response.headersSent) {
            const body = errorPayload(error);
            const headers: Record<string, string> = {
                "content-type": "application/json",
                "content-length": String(body.length),
            };
            if (error.retryAfter !== undefined)
                headers["retry-after"] = error.retryAfter;
            response.writeHead(error.status, headers);
            response.end(body);
        }
        else {
            response.destroy();
        }
        if (receiptBase !== undefined) {
            await appendReceipt(options.receipts, {
                schemaVersion: 1,
                timestamp: new Date().toISOString(),
                requestId,
                ...receiptBase,
                durationMs: Math.round(performance.now() - startedAt),
                status: "failed",
                errorCode: error.code,
            });
        }
        writeSafeLog({
            event: "request_failed",
            level: "warn",
            requestId,
            ...(receiptBase === undefined ? {} : { provider: receiptBase.provider }),
            code: error.code,
            ...(requestedModel === undefined ? {} : { requestedModel: safeModelName(requestedModel) }),
            durationMs: Math.round(performance.now() - startedAt),
            route,
            method: safeMethod(request.method),
            pathFingerprint: createHash("sha256").update(routedTarget.target.pathname, "utf8").digest("hex").slice(0, 16),
        });
    }
}
// The model name arrives from the client, so it never reaches the log raw: anything
// outside the identifier alphabet is dropped and the result is bounded. A log line is
// a record, not a channel for whatever a caller decided to send.
function safeModelName(model: string): string {
    return model.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 64);
}
function safeMethod(method: string | undefined): NonNullable<SafeLogEntry["method"]> {
    return method === "GET" || method === "POST" || method === "HEAD" ? method : "OTHER";
}
function sessionTarget(url: string | undefined, nonce: string): { readonly target: URL; readonly pathNonceValid: boolean } {
    const target = new URL(url ?? "/", "http://127.0.0.1");
    const match = /^\/_session\/([^/]+)(\/.*)?$/u.exec(target.pathname);
    if (match === null)
        return { target, pathNonceValid: false };
    const supplied = match[1];
    target.pathname = match[2] ?? "/";
    return { target, pathNonceValid: nonceMatches(nonce, supplied) };
}
// MCP ucu: JSON-RPC girer, JSON-RPC cikar. Araclari BU sunucu CALISTIRMAZ --
// kopru cagriyi park eder, yanit Claude Code bir sonraki turda gonderdiginde
// gelir. Yetki Claude Code tarafinda kalir (spec §6).
async function handleMcp(request: IncomingMessage, response: ServerResponse, options: RouterServerOptions, sessionKey: string): Promise<void> {
    if (request.method !== "POST") {
        throw new RouterError("invalid_request", "The MCP endpoint accepts POST only.", 405);
    }
    if (options.mcpBridge === undefined) {
        throw new RouterError("invalid_request", "Route not found.", 404);
    }
    const bridge = options.mcpBridge(sessionKey);
    if (bridge === undefined) {
        // Adi konmus bir hata. Sessiz bir 404 ajani sonsuz yeniden denemeye iter,
        // ve bu disaridan "saglayici yavas" gibi gorunur.
        throw new RouterError("invalid_request", "No live agent session for this MCP endpoint. ONARIM: the session was swept or the router restarted; send the turn again so a fresh session starts.", 409);
    }
    const body = await readBody(request);
    let message: unknown;
    try {
        message = JSON.parse(body.toString("utf8"));
    }
    catch {
        writeJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
    }
    // MCP 2025-06-18 toplu JSON-RPC istegini kaldirdi. Diziyi sessizce ilk ogeye
    // indirgemek yerine ACIKCA reddediyoruz: yarim islenen bir toplu istek tam
    // olarak §7.3 kapisinin saydigi seyi uretir -- eslesmeyen tool_result.
    if (Array.isArray(message)) {
        writeJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batched JSON-RPC is not supported." } });
        return;
    }
    const answer = await bridge.handle(message);
    if (answer === undefined) {
        // Bildirim: govde YOK. Govde yazmak JSON-RPC akisini desenkronize eder ve
        // ajan dongusunun ortasinda durur.
        response.writeHead(202);
        response.end();
        return;
    }
    writeJson(response, 200, answer);
}
function classifyRoute(pathname: string): NonNullable<SafeLogEntry["route"]> {
    if (pathname === "/api/hello" || pathname === "/")
        return "hello";
    if (pathname === "/v1/models")
        return "models";
    if (pathname === "/v1/messages")
        return "messages";
    if (pathname === "/v1/messages/count_tokens")
        return "count_tokens";
    if (pathname.startsWith("/mcp/"))
        return "mcp";
    return "other";
}
