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

describe("router kimlik kapisi", () => {
    it("oturum basligi ACAR", async () => {
        const response = await fetch(`${base()}/v1/models`, { headers: { [SESSION_HEADER]: nonce } });
        strictEqual(response.status, 200);
    });

    it("URL yolundaki nonce ACAR", async () => {
        const response = await fetch(`${base()}/_session/${nonce}/v1/models`);
        strictEqual(response.status, 200);
    });

    it("hicbir kimlik yoksa 401", async () => {
        const response = await fetch(`${base()}/v1/models`);
        strictEqual(response.status, 401);
    });

    it("YANLIS nonce tasiyan oturum basligi 401", async () => {
        const response = await fetch(`${base()}/v1/models`, { headers: { [SESSION_HEADER]: "y".repeat(43) } });
        strictEqual(response.status, 401);
    });

    // KARAR PINI, kolaylik defekti degil: dogru nonce'u tasisa bile Authorization
    // kapiyi ACMAZ. Bu testi "duzeltmek" icin kapiyi acan biri, ayni hamlede yerel
    // sirri saglayiciya gonderen yolu da acmis olur.
    it("DOGRU nonce'u tasisa bile Authorization kapiyi ACMAZ", async () => {
        const response = await fetch(`${base()}/v1/models`, { headers: { authorization: `Bearer ${nonce}` } });
        strictEqual(response.status, 401);
    });

    it("x-api-key kapiyi ACMAZ", async () => {
        const response = await fetch(`${base()}/v1/models`, { headers: { "x-api-key": nonce } });
        strictEqual(response.status, 401);
    });
});
