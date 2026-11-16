// pinned-port-holder.test.ts -- who holds the pinned port, and does the picker cache follow it?
//
// Case (2026-11-16, measured): an orphaned local image receiver of another task held 8791. Two
// claude-oauth windows fell back to ephemeral ports, skipped the picker cache as if a router
// session held the port, and /model listed only native models. Each arm below is one answer a
// holder can give; the last block ties the answer to the cache decision.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ModelSnapshot } from "../src/domain/contracts.js";
import { ModelRegistry } from "../src/domain/registry.js";
import { startRouterServer } from "../src/router/server.js";
import { shouldWriteGatewayModelsCache } from "../src/runtime/gateway-models-cache.js";
import { allocateLoopbackPort, probePinnedPortHolder, ROUTER_IDENTITY_HEADER } from "../src/runtime/loopback-port.js";
import { ReceiptStore } from "../src/runtime/receipt-store.js";

const snapshot: ModelSnapshot = { schemaVersion: 1, generatedAt: "2026-11-16T00:00:00.000Z", source: "pinned-install-baseline", models: [] };
const closers: (() => Promise<void>)[] = [];

after(async () => {
    for (const close of closers.reverse()) await close();
});

async function httpServer(handler: Parameters<typeof createHttpServer>[1]): Promise<number> {
    const server: HttpServer = createHttpServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    closers.push(async () => {
        server.closeAllConnections();
        server.close();
    });
    return (server.address() as AddressInfo).port;
}

describe("probePinnedPortHolder", () => {
    it("a real router of this release answers HEAD with the identity header -> router", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pinned-holder-"));
        const router = await startRouterServer({
            nonce: "n".repeat(43),
            registry: new ModelRegistry(snapshot, new Map()),
            receipts: new ReceiptStore(join(directory, "receipts.jsonl")),
        });
        closers.push(async () => {
            await router.close();
            await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        });
        const hello = await fetch(`${router.baseUrl.replace(/\/$/u, "")}/api/hello`, { method: "HEAD" });
        assert.equal(hello.headers.get(ROUTER_IDENTITY_HEADER), "1", "the router names itself on HEAD /api/hello");
        assert.equal(await probePinnedPortHolder(router.port), "router");
    });

    it("the identity header alone is enough (arm 1, no fallback needed) -> router", async () => {
        const port = await httpServer((request, response) => {
            if (request.method === "HEAD") response.writeHead(200, { [ROUTER_IDENTITY_HEADER]: "1" });
            else response.writeHead(404);
            response.end();
        });
        assert.equal(await probePinnedPortHolder(port), "router");
    });

    it("an earlier release without the header still answers 401 session_auth_required (arm 2) -> router", async () => {
        const port = await httpServer((request, response) => {
            if (request.method === "HEAD") {
                response.writeHead(200);
                response.end();
                return;
            }
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ type: "error", error: { type: "session_auth_required", message: "A valid local session header is required." } }));
        });
        assert.equal(await probePinnedPortHolder(port), "router");
    });

    it("the measured holder: a plain local HTTP receiver answering 501 -> foreign", async () => {
        const port = await httpServer((_request, response) => {
            response.writeHead(501, { "content-type": "text/html" });
            response.end("<p>Unsupported method</p>");
        });
        assert.equal(await probePinnedPortHolder(port), "foreign");
    });

    it("a 401 that is not ours (another app's auth wall) -> foreign", async () => {
        const port = await httpServer((_request, response) => {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "unauthorized" }));
        });
        assert.equal(await probePinnedPortHolder(port), "foreign");
    });

    it("a holder that streams without end is cut at the body limit -> foreign", async () => {
        const port = await httpServer((request, response) => {
            response.writeHead(200, { "content-type": "text/plain" });
            if (request.method === "HEAD") {
                response.end();
                return;
            }
            const timer = setInterval(() => response.write("x".repeat(1024)), 5);
            response.on("close", () => clearInterval(timer));
        });
        assert.equal(await probePinnedPortHolder(port, 2_000), "foreign");
    });

    it("nobody listens any more -> free", async () => {
        const port = await allocateLoopbackPort();
        assert.equal(await probePinnedPortHolder(port), "free");
    });

    it("a holder that accepts the connection and never answers -> unknown, within the deadline", async () => {
        const sockets: Socket[] = [];
        const server: NetServer = createNetServer((socket) => sockets.push(socket));
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        closers.push(async () => {
            for (const socket of sockets) socket.destroy();
            server.close();
        });
        const started = Date.now();
        assert.equal(await probePinnedPortHolder((server.address() as AddressInfo).port, 200), "unknown");
        assert.ok(Date.now() - started < 2_000, "the probe must not hold the launch hostage");
    });
});

describe("the picker cache follows the holder", () => {
    it("the pinned session always writes", () => {
        assert.equal(shouldWriteGatewayModelsCache(8791, 8791, undefined), true);
    });
    it("an ephemeral session writes when no router session's picker is at stake", () => {
        assert.equal(shouldWriteGatewayModelsCache(55390, 8791, "foreign"), true, "the measured case");
        assert.equal(shouldWriteGatewayModelsCache(55390, 8791, "free"), true);
    });
    it("an ephemeral session never overwrites a router session's picker, nor guesses", () => {
        assert.equal(shouldWriteGatewayModelsCache(55390, 8791, "router"), false);
        assert.equal(shouldWriteGatewayModelsCache(55390, 8791, "unknown"), false);
        assert.equal(shouldWriteGatewayModelsCache(55390, 8791), false, "no answer recorded is no permission");
    });
});
