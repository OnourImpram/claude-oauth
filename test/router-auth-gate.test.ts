import { strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ModelSnapshot } from "../src/domain/contracts.js";
import { ModelRegistry } from "../src/domain/registry.js";
import { ReceiptStore } from "../src/runtime/receipt-store.js";
import { startRouterServer, type RunningRouter } from "../src/router/server.js";
import { SESSION_HEADER } from "../src/security/nonce.js";

// The router carries a single local secret and accepts it through exactly two doors:
// the session header, and the URL path. That was written down in a comment as
// "measured" and nowhere else -- so nothing stopped a later edit from opening a third
// door, or closing one of the two. These tests are that stop.
//
// The third door matters more than it looks. Since the launcher publishes the nonce as
// ANTHROPIC_AUTH_TOKEN (gateway model discovery refuses to run without a credential),
// some client-internal requests now arrive carrying `Authorization: Bearer <nonce>` and
// nothing else. Accepting them would be the obvious "fix" and it is the wrong one: the
// Anthropic adapter forwards authorization upstream verbatim, so such a request would
// fail at the provider anyway AND carry a local secret off the machine. The gate stays
// shut, and the test below is what keeps it shut.

const snapshot: ModelSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    source: "pinned-install-baseline",
    models: [
        {
            id: "claude-opus-5",
            provider: "anthropic",
            upstreamModel: "claude-opus-5",
            displayName: "Claude Opus 5",
            oauthType: "claude.ai",
            executionMode: "native-message-loop",
            discoverable: true,
            capabilities: ["messages"],
        },
    ],
};

const nonce = "n".repeat(43);
let directory = "";
let router: RunningRouter | undefined;

before(async () => {
    directory = await mkdtemp(join(tmpdir(), "router-auth-"));
    router = await startRouterServer({
        nonce,
        registry: new ModelRegistry(snapshot, new Map()),
        receipts: new ReceiptStore(join(directory, "receipts.jsonl")),
    });
});

after(async () => {
    await router?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const base = (): string => router?.baseUrl.replace(/\/$/u, "") ?? "";

describe("router authentication gate", () => {
    it("the session header OPENS the gate", async () => {
        const response = await fetch(`${base()}/v1/models`, { headers: { [SESSION_HEADER]: nonce } });
        strictEqual(response.status, 200);
    });

    it("the nonce in the URL path OPENS the gate", async () => {
        const response = await fetch(`${base()}/_session/${nonce}/v1/models`);
        strictEqual(response.status, 200);
    });

    it("returns 401 when no authentication is supplied", async () => {
        const response = await fetch(`${base()}/v1/models`);
        strictEqual(response.status, 401);
    });

    it("returns 401 for a session header carrying the WRONG nonce", async () => {
        const response = await fetch(`${base()}/v1/models`, { headers: { [SESSION_HEADER]: "y".repeat(43) } });
        strictEqual(response.status, 401);
    });

    // A PINNED DECISION, not a convenience defect: Authorization does NOT open the gate,
    // even when it carries the correct nonce. Anyone who opens the gate to "fix" this test
    // opens, in the same move, the path that sends the local secret to the provider.
    it("Authorization DOES NOT OPEN the gate even when it carries the CORRECT nonce", async () => {
        const response = await fetch(`${base()}/v1/models`, { headers: { authorization: `Bearer ${nonce}` } });
        strictEqual(response.status, 401);
    });

    it("x-api-key DOES NOT OPEN the gate", async () => {
        const response = await fetch(`${base()}/v1/models`, { headers: { "x-api-key": nonce } });
        strictEqual(response.status, 401);
    });
});
