import { ok, strictEqual, throws } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { FakeAdapter } from "../src/adapters/fake.js";
import type { ModelSnapshot, ProviderAdapter, ProviderId } from "../src/domain/contracts.js";
import { RouterError } from "../src/domain/errors.js";
import { ModelRegistry } from "../src/domain/registry.js";

// CASE RECORD (2026-11-15, live tour through the public launcher). Claude Code 2.1.325 resolves
// `--model haiku` to `claude-haiku-5-5`. The router's native list (config/models.default.json)
// stopped at `claude-haiku-4-5-20251001`, so the request died locally with `model_not_available`
// and the client said "There's an issue with the selected model". The same class is in
// router.log four more times (claude-opus-4-7, claude-opus-5-5, claude-mythos-5-1,
// claude-fable-5-1): every native model Anthropic ships needed a row here before it worked.
//
// A Claude model id is Anthropic's to accept or refuse. The native lane is a passthrough with
// the user's own claude.ai session, so an id the snapshot does not list goes to that lane as it
// is; Anthropic answers 404 for an id it does not serve. Ids of every other lane keep the closed
// snapshot: there the selected model must be a contracted one.

const snapshot: ModelSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    source: "pinned-install-baseline",
    models: [{
        id: "claude-opus-5-5",
        provider: "anthropic",
        upstreamModel: "claude-opus-5-5",
        displayName: "Claude Opus 5.5",
        oauthType: "claude.ai",
        executionMode: "native-message-loop",
        discoverable: true,
        capabilities: ["messages", "streaming", "tools", "vision", "thinking"],
    }],
};
const answering = (provider: ProviderId): ProviderAdapter => new FakeAdapter(provider, () => ({
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: new Blob(["{}"]).stream() as ReadableStream<Uint8Array>,
}));
const withAnthropic = (): ModelRegistry => new ModelRegistry(snapshot, new Map<ProviderId, ProviderAdapter>([["anthropic", answering("anthropic")]]));
const refused = (code: string) => (error: unknown): boolean => error instanceof RouterError && error.code === code;

describe("native lane: a Claude model id the snapshot does not list", () => {
    it("is routed to the Anthropic passthrough under its own id", () => {
        const route = withAnthropic().resolve("claude-haiku-5-5");
        strictEqual(route.model.provider, "anthropic");
        strictEqual(route.model.id, "claude-haiku-5-5");
        strictEqual(route.model.upstreamModel, "claude-haiku-5-5", "the selected model is the model that is asked for upstream");
        strictEqual(route.model.oauthType, "claude.ai");
        strictEqual(route.model.executionMode, "native-message-loop");
        strictEqual(route.model.discoverable, false, "an unlisted id is served, not advertised");
        strictEqual(route.adapter.provider, "anthropic");
        strictEqual(route.uncontractedNative, true, "the caller can tell the row was not in the snapshot");
    });

    it("does not shadow a snapshot row", () => {
        const route = withAnthropic().resolve("claude-opus-5-5");
        strictEqual(route.model.displayName, "Claude Opus 5.5");
        strictEqual(route.model.discoverable, true);
        strictEqual(route.uncontractedNative, undefined);
    });

    it("NEGATIVE: an unknown id of another lane is still refused", () => {
        const registry = withAnthropic();
        for (const id of ["glm-5.3", "gpt-6-astra", "gemini-4-carbon-high", "grok-4.7", "anthropic-google-gemini-9", "anthropic-openai-gpt-9", "sol", "qwen4-max-preview"])
            throws(() => registry.resolve(id), refused("model_not_available"), id);
    });

    it("NEGATIVE: something that only starts like a Claude id is refused", () => {
        const registry = withAnthropic();
        for (const id of ["claude-", "claude", "Claude-Opus-5-5", "claude-opus 5", "claude-opus/../x", "claude-opus-5-5\n", "claude--opus", "claude-opus-", `claude-${"a".repeat(80)}`, "xclaude-opus-5-5"])
            throws(() => registry.resolve(id), refused("model_not_available"), JSON.stringify(id));
    });

    it("NEGATIVE: with no Anthropic adapter the request is refused as unavailable, not routed elsewhere", () => {
        const registry = new ModelRegistry(snapshot, new Map<ProviderId, ProviderAdapter>([["openai", answering("openai")]]));
        throws(() => registry.resolve("claude-haiku-5-5"), refused("adapter_unavailable"));
    });
});

describe("native lane: the shipped default list", () => {
    it("lists the id Claude Code 2.1.325 asks for under `haiku`", async () => {
        const shipped = JSON.parse(await readFile(resolve("config", "models.default.json"), "utf8")) as ModelSnapshot;
        const row = shipped.models.find((model) => model.id === "claude-haiku-5-5");
        ok(row !== undefined, "claude-haiku-5-5 is a row of config/models.default.json");
        strictEqual(row.provider, "anthropic");
        strictEqual(row.upstreamModel, "claude-haiku-5-5");
        strictEqual(row.executionMode, "native-message-loop");
    });
});
