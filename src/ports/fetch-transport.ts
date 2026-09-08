import type { HttpTransport, HttpTransportRequest } from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
export class FixedOriginFetchTransport implements HttpTransport {
    #origin: URL;
    constructor(origin: URL) {
        const secureRemote = origin.protocol === "https:";
        const localHttp = origin.protocol === "http:" && loopbackHosts.has(origin.hostname);
        if (!secureRemote && !localHttp)
            throw new Error("transport origin must be HTTPS or loopback HTTP");
        if (origin.username !== "" || origin.password !== "")
            throw new Error("transport origin must not contain credentials");
        this.#origin = new URL(origin.href);
    }
    async send(request: HttpTransportRequest): Promise<Response> {
        if (!request.path.startsWith("/"))
            throw new Error("transport path must be absolute");
        const target = new URL(request.path, this.#origin);
        if (target.origin !== this.#origin.origin)
            throw new Error("transport path changed fixed origin");
        return await new Promise((resolveResponse, rejectResponse) => {
            const requestHeaders: Record<string, string> = {};
            for (const [name, value] of request.headers)
                requestHeaders[name] = value;
            let responseStarted = false;
            let incoming: IncomingMessage | undefined;
            const cleanup = (): void => request.signal.removeEventListener("abort", onAbort);
            const fail = (error: unknown): void => {
                cleanup();
                rejectResponse(request.signal.aborted
                    ? new RouterError("upstream_timeout", "The upstream request was cancelled or timed out.", 504, {
                        cause: error,
                    })
                    : new RouterError("adapter_unavailable", "The fixed upstream endpoint is unavailable.", 503, {
                        cause: error,
                    }));
            };
            const onResponse = (message: IncomingMessage): void => {
                incoming = message;
                const status = message.statusCode;
                if (status === undefined) {
                    message.destroy();
                    fail(new Error("upstream status is missing"));
                    return;
                }
                try {
                    const headers = new Headers();
                    for (let index = 0; index < message.rawHeaders.length; index += 2) {
                        const name = message.rawHeaders[index];
                        const value = message.rawHeaders[index + 1];
                        if (name !== undefined && value !== undefined)
                            headers.append(name, value);
                    }
                    const noBody = [204, 205, 304].includes(status);
                    const body = noBody ? null : (Readable.toWeb(message) as ReadableStream<Uint8Array>);
                    responseStarted = true;
                    message.once("close", cleanup);
                    resolveResponse(new Response(body, {
                        status,
                        headers,
                        ...(message.statusMessage === undefined ? {} : { statusText: message.statusMessage }),
                    }));
                }
                catch (error) {
                    message.destroy();
                    fail(error);
                }
            };
            const startRequest = target.protocol === "https:" ? httpsRequest : httpRequest;
            const client = startRequest(target, { method: request.method, headers: requestHeaders }, onResponse);
            const onAbort = (): void => {
                const error = new Error("upstream request aborted");
                incoming?.destroy(error);
                client.destroy(error);
            };
            client.once("error", (error) => {
                if (!responseStarted)
                    fail(error);
            });
            if (request.signal.aborted)
                onAbort();
            else {
                request.signal.addEventListener("abort", onAbort, { once: true });
                if (request.body !== undefined)
                    client.write(Buffer.from(request.body));
                client.end();
            }
        });
    }
}
