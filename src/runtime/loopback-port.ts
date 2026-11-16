import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
export async function allocateLoopbackPort(): Promise<number> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    server.close();
    await once(server, "close");
    return port;
}
// Claude Code's gateway model discovery keys its cache to ANTHROPIC_BASE_URL EXACTLY
// (in the binary: `e.baseUrl !== a.ANTHROPIC_BASE_URL -> return []`). An ephemeral port
// per session invalidates that cache every single time and the /model list NEVER shows
// external models. That is why the port is fixed.
//
// A fixed port on loopback is predictable, but on its own it opens nothing: every request
// must carry the 256-bit session nonce (in a header or in the path), otherwise it gets a
// 401.
// 8787 IS DELIBERATELY NOT USED: on this machine ~/.claude/cache/gateway-models.json is
// still dated 2026-05-05, has baseUrl http://127.0.0.1:8787 and carries four models of a
// gateway that no longer exists. Choosing that port would drop ghost models we do not
// serve into the picker.
export const PINNED_LOOPBACK_PORT = 8791;
export function preferredLoopbackPort(environment: NodeJS.ProcessEnv = process.env): number {
    const raw = environment["HEZARFEN_ROUTER_PORT"];
    if (raw === undefined)
        return PINNED_LOOPBACK_PORT;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : PINNED_LOOPBACK_PORT;
}

// WHO HOLDS THE PINNED PORT (2026-11-16, measured)
// An orphaned local image receiver of another task listened on 8791 for 17 hours. Two
// claude-oauth windows fell back to ephemeral ports, read the holder as "another claude
// session", skipped the picker cache, and /model listed only the native models. That skip
// exists to protect a ROUTER session's picker; a foreign process has no picker to protect.
// So the second launcher asks the holder, without any credential:
//   1. HEAD /api/hello answered with ROUTER_IDENTITY_HEADER -> a router of this release or later;
//   2. GET /v1/models answered 401 session_auth_required   -> a router of an earlier release;
//   3. connection refused                                  -> free (the holder left after our bind);
//   4. any other answer                                    -> foreign;
//   5. no answer in time, or a transport error             -> unknown (kept conservative: skip).
// The header names the software only; it carries nothing about the session, and HEAD /api/hello
// already answered without a credential before this marker existed.
export const ROUTER_IDENTITY_HEADER = "x-claude-oauth-router";

export type PinnedPortHolder = "router" | "foreign" | "free" | "unknown";

export async function probePinnedPortHolder(port: number, timeoutMs = 750): Promise<PinnedPortHolder> {
    const hello = await loopbackRequest(port, "HEAD", "/api/hello", timeoutMs);
    if (hello.kind === "refused")
        return "free";
    if (hello.kind === "error")
        return "unknown";
    if (hello.headers[ROUTER_IDENTITY_HEADER] !== undefined)
        return "router";
    const models = await loopbackRequest(port, "GET", "/v1/models", timeoutMs);
    if (models.kind === "refused")
        return "free";
    if (models.kind === "error")
        return "unknown";
    if (models.status === 401 && models.body.includes("session_auth_required"))
        return "router";
    return "foreign";
}

type LoopbackAnswer =
    | { readonly kind: "answered"; readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: string }
    | { readonly kind: "refused" }
    | { readonly kind: "error" };

const PROBE_BODY_LIMIT = 4096;

function loopbackRequest(port: number, method: "HEAD" | "GET", path: string, timeoutMs: number): Promise<LoopbackAnswer> {
    return new Promise((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (answer: LoopbackAnswer): void => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            resolve(answer);
        };
        const outgoing = httpRequest({ host: "127.0.0.1", port, method, path, agent: false }, (incoming) => {
            const chunks: Buffer[] = [];
            let size = 0;
            const answered = (): LoopbackAnswer => ({
                kind: "answered",
                status: incoming.statusCode ?? 0,
                headers: incoming.headers,
                body: Buffer.concat(chunks).toString("utf8").slice(0, PROBE_BODY_LIMIT),
            });
            incoming.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
                size += chunk.length;
                if (size >= PROBE_BODY_LIMIT) {
                    finish(answered());
                    incoming.destroy();
                }
            });
            incoming.on("end", () => finish(answered()));
            incoming.on("error", () => finish({ kind: "error" }));
        });
        // A hard deadline, not a socket idle timer: a holder that keeps streaming must not hold
        // the launch hostage.
        timer = setTimeout(() => {
            outgoing.destroy();
            finish({ kind: "error" });
        }, timeoutMs);
        outgoing.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" ? { kind: "refused" } : { kind: "error" }));
        outgoing.end();
    });
}
