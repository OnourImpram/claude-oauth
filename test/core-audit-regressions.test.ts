import { deepStrictEqual, doesNotThrow, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { OAUTH_TYPES, PROVIDER_IDS, type RouteReceipt } from "../src/domain/contracts.js";
import { RouterError, normalizeCliError } from "../src/domain/errors.js";
import { appendLogLine } from "../src/runtime/log.js";
import { ReceiptStore } from "../src/runtime/receipt-store.js";
import { requireReleaseIdentity } from "../src/runtime/release-identity.js";
import { describeProviderStartFailure } from "../src/supervisor/provider-set.js";

// Regressions for the 2026-11-15 independent audit of the core slice (findings D1-02, D1-03,
// D1-04, D1-06, D1-08). Each block names the measured failure it pins.

let scratch = "";
before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "core-audit-"));
});
after(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("D1-02: the receipt reader accepts every receipt the writer can produce", () => {
    // The server wrote oauthType "api-key" (Alibaba, Z.AI, OpenAI API) and "chatgpt-web";
    // the reader still accepted only the four original values, so `claude-oauth receipt`
    // failed with "The local receipt file is malformed" exactly after a request on the newest
    // lanes. The accepted set is one exported list now, shared with the snapshot validator.
    for (const oauthType of OAUTH_TYPES) {
        it(`reads back a receipt whose oauthType is ${oauthType}`, async () => {
            const store = new ReceiptStore(join(scratch, `receipts-${oauthType}.jsonl`));
            const receipt: RouteReceipt = {
                schemaVersion: 1,
                timestamp: "2026-11-15T09:00:00.000Z",
                requestId: "request-1",
                requestedModel: "model-a",
                configuredModel: "model-b",
                provider: PROVIDER_IDS[0],
                oauthType,
                durationMs: 12,
                status: "completed",
            };
            await store.append(receipt);
            deepStrictEqual(await store.last(), receipt);
        });
    }
    it("the list still names the api-key and chatgpt-web classes", () => {
        ok(OAUTH_TYPES.includes("api-key"));
        ok(OAUTH_TYPES.includes("chatgpt-web"));
        strictEqual(OAUTH_TYPES.length, 6);
    });
    it("NEGATIVE: an unknown oauthType is still a malformed receipt", async () => {
        const path = join(scratch, "receipts-unknown.jsonl");
        await writeFile(path, `${JSON.stringify({ schemaVersion: 1, timestamp: "2026-11-15T09:00:00.000Z", requestId: "r", requestedModel: "a", configuredModel: "b", provider: PROVIDER_IDS[0], oauthType: "made-up", durationMs: 1, status: "completed" })}\n`, "utf8");
        await new ReceiptStore(path).last().then(() => { throw new Error("accepted an unknown oauthType"); }, (error: unknown) => {
            ok(error instanceof RouterError);
        });
    });
});

describe("D1-03: a local failure on the CLI path is not reported as a provider protocol error", () => {
    // A missing claude.exe (ENOENT from the hash stream) or a corrupt lock reached main() as a
    // plain Error and was printed as upstream_protocol_error "The provider returned an invalid
    // response" before any provider existed.
    it("names a file-system failure by its errno code, system call and path", () => {
        const failure = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\Users\\x\\.local\\bin\\claude.exe'"), { code: "ENOENT", syscall: "open", path: "C:\\Users\\x\\.local\\bin\\claude.exe" });
        const error = normalizeCliError(failure);
        strictEqual(error.code, "local_failure");
        ok(error.message.includes("ENOENT") && error.message.includes("open") && error.message.includes("claude.exe"), error.message);
        ok(!error.message.includes("provider returned"), error.message);
    });
    it("NEGATIVE: an arbitrary error message is never echoed (it can carry a session URL)", () => {
        const error = normalizeCliError(new TypeError("fetch failed for http://127.0.0.1:8791/_session/SECRETNONCE/v1/messages"));
        strictEqual(error.code, "local_failure");
        ok(!error.message.includes("SECRETNONCE"), error.message);
        ok(error.message.includes("TypeError"), error.message);
    });
    it("a RouterError passes through untouched, and an abort stays a timeout", () => {
        const routed = new RouterError("provider_rate_limited", "quota", 429);
        strictEqual(normalizeCliError(routed), routed);
        strictEqual(normalizeCliError(new DOMException("aborted", "AbortError")).code, "upstream_timeout");
    });
});

describe("D1-04: a provider that fails to start leaves its cause in the log", () => {
    // The serving path swallowed every OpenAI-lane startup failure into the single readiness
    // code clodex_auth_or_startup_failed and wrote nothing: "re-login" and "reinstall the
    // pinned package" read the same. The cause is now filed (code + the author-written remedy).
    it("keeps a RouterError's code and its remedy sentence, bounded", () => {
        const spawn = describeProviderStartFailure(new RouterError("adapter_unavailable", `Clodex could not be started from its pinned path (ENOENT). FIX: reinstall the pinned Clodex package. ${"x".repeat(500)}`, 503));
        strictEqual(spawn.code, "adapter_unavailable");
        ok(spawn.remedy !== undefined && spawn.remedy.startsWith("Clodex could not be started") && spawn.remedy.length <= 300);
        const auth = describeProviderStartFailure(new RouterError("provider_auth_required", "Clodex could not return the ChatGPT OAuth model catalog.", 401));
        strictEqual(auth.code, "provider_auth_required");
        ok(auth.remedy !== spawn.remedy, "a spawn failure and an auth failure must not read the same");
    });
    it("NEGATIVE: a foreign error contributes its name only, never its message", () => {
        const described = describeProviderStartFailure(new RangeError("secret-bearing detail"));
        deepStrictEqual(described, { code: "provider_start_failed", errorName: "RangeError" });
    });
});

describe("D1-06: a release that cannot be read is refused, not waved through", () => {
    // prepareEffectiveInstallation refused only "mismatch". A release with a junction or an
    // unreadable file under dist/ or config/ hashes to "unreadable" and was launched anyway.
    const declaredId = "router-v3-AAAAAAAAAAAA-BBBBBBBBBBBB";
    it("refuses an unreadable release", () => {
        throws(() => requireReleaseIdentity({ status: "unreadable", declaredId, detailCode: "release_contents_unreadable" }), /release_contents_unreadable/u);
    });
    it("still refuses a mismatch", () => {
        throws(() => requireReleaseIdentity({ status: "mismatch", declaredId, computedId: "router-v3-CCCCCCCCCCCC-DDDDDDDDDDDD", detailCode: "release_contents_do_not_match_release_id" }), /release_contents_do_not_match_release_id/u);
    });
    it("NEGATIVE: a verified release and a direct (non-release) launch pass", () => {
        doesNotThrow(() => requireReleaseIdentity({ status: "verified", declaredId, computedId: declaredId, detailCode: "release_contents_match_release_id" }));
        doesNotThrow(() => requireReleaseIdentity({ status: "unverified", detailCode: "not_launched_from_embedded_release" }));
    });
});

describe("D1-08: router.log is bounded", () => {
    // writeSafeLog appended forever; the receipt store rotated at 2 MiB and the log had no
    // equivalent. One previous generation is kept, as for receipts.
    it("rotates to router.log.previous once the cap is passed, and keeps writing", async () => {
        const path = join(scratch, "router.log");
        const line = `${"l".repeat(99)}\n`; // 100 bytes
        for (let index = 0; index < 25; index += 1)
            appendLogLine(path, line, 1_000);
        const live = await stat(path);
        ok(live.size <= 1_000 + line.length, `live log is ${live.size} bytes`);
        const previous = await stat(`${path}.previous`);
        ok(previous.size > 0 && previous.size <= 1_000 + line.length, `previous generation is ${previous.size} bytes`);
        ok((await readFile(path, "utf8")).endsWith(line), "the newest line is in the live file");
    });
    it("NEGATIVE: below the cap nothing is rotated", async () => {
        const path = join(scratch, "small.log");
        appendLogLine(path, "one\n", 1_000);
        appendLogLine(path, "two\n", 1_000);
        strictEqual(await readFile(path, "utf8"), "one\ntwo\n");
        await stat(`${path}.previous`).then(() => { throw new Error("rotated below the cap"); }, (error: NodeJS.ErrnoException) => strictEqual(error.code, "ENOENT"));
    });
});
