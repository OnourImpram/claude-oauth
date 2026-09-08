import { strictEqual, match, notStrictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { computeReleaseId, RELEASE_ID_PATTERN, verifyReleaseIdentity } from "../src/runtime/release-identity.js";

// REGRESSION: release directories are named router-v3-<distHash>-<configHash> and were
// described as "content-addressed, immutable", but nothing recomputed those hashes --
// publicLauncherStatus only checked the FORMAT. So the active release could be patched by
// hand and keep its name, and this went unnoticed for days.

let root = "";

async function seed(distBody: string, configBody: string): Promise<void> {
    await mkdir(join(root, "dist", "src"), { recursive: true });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "dist", "src", "cli.js"), distBody, "utf8");
    await writeFile(join(root, "config", "install-lock.json"), configBody, "utf8");
}

before(async () => {
    root = await mkdtemp(join(tmpdir(), "release-identity-"));
    await seed("export const a = 1;\n", '{"schemaVersion":1}\n');
});

after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("computeReleaseId", () => {
    it("produces the expected format", async () => {
        match(await computeReleaseId(root), RELEASE_ID_PATTERN);
    });

    it("is deterministic: an unchanged tree produces the same identity", async () => {
        strictEqual(await computeReleaseId(root), await computeReleaseId(root));
    });

    it("is sensitive to a single byte: changing dist changes the identity", async () => {
        const before_ = await computeReleaseId(root);
        await writeFile(join(root, "dist", "src", "cli.js"), "export const a = 2;\n", "utf8");
        notStrictEqual(await computeReleaseId(root), before_);
        await writeFile(join(root, "dist", "src", "cli.js"), "export const a = 1;\n", "utf8");
        strictEqual(await computeReleaseId(root), before_);
    });

    it("changing config changes the second component while the first stays the same", async () => {
        const before_ = await computeReleaseId(root);
        await writeFile(join(root, "config", "install-lock.json"), '{"schemaVersion":1,"x":2}\n', "utf8");
        const after_ = await computeReleaseId(root);
        const [, distBefore, configBefore] = RELEASE_ID_PATTERN.exec(before_) ?? [];
        const [, distAfter, configAfter] = RELEASE_ID_PATTERN.exec(after_) ?? [];
        strictEqual(distAfter, distBefore);
        notStrictEqual(configAfter, configBefore);
        await writeFile(join(root, "config", "install-lock.json"), '{"schemaVersion":1}\n', "utf8");
    });

    it("the file NAME is also hashed: moving the content changes the identity", async () => {
        const before_ = await computeReleaseId(root);
        await writeFile(join(root, "dist", "src", "other.js"), "export const a = 1;\n", "utf8");
        await rm(join(root, "dist", "src", "cli.js"));
        notStrictEqual(await computeReleaseId(root), before_);
        await writeFile(join(root, "dist", "src", "cli.js"), "export const a = 1;\n", "utf8");
        await rm(join(root, "dist", "src", "other.js"));
        strictEqual(await computeReleaseId(root), before_);
    });
});

describe("verifyReleaseIdentity", () => {
    it("reports unverified without throwing when not launched from an embedded release", async () => {
        const identity = await verifyReleaseIdentity(root, {});
        strictEqual(identity.status, "unverified");
        strictEqual(identity.detailCode, "not_launched_from_embedded_release");
    });

    it("still reports unverified when the source is embedded-release but the identity is absent", async () => {
        const identity = await verifyReleaseIdentity(root, { HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE: "embedded-release" });
        strictEqual(identity.status, "unverified");
    });

    it("returns verified for the correct identity", async () => {
        const declared = await computeReleaseId(root);
        const identity = await verifyReleaseIdentity(root, {
            HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE: "embedded-release",
            HEZARFEN_CLAUDE_OAUTH_RELEASE_ID: declared,
        });
        strictEqual(identity.status, "verified");
        strictEqual(identity.computedId, declared);
    });

    // NEGATIVE CONTROL -- the event itself: the release was edited in place and kept its name.
    it("reports mismatch when content changes (a release edited in place)", async () => {
        const declared = await computeReleaseId(root);
        await writeFile(join(root, "dist", "src", "cli.js"), "export const a = 1;\n// patched by hand\n", "utf8");
        const identity = await verifyReleaseIdentity(root, {
            HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE: "embedded-release",
            HEZARFEN_CLAUDE_OAUTH_RELEASE_ID: declared,
        });
        strictEqual(identity.status, "mismatch");
        strictEqual(identity.detailCode, "release_contents_do_not_match_release_id");
        notStrictEqual(identity.computedId, declared);
        await writeFile(join(root, "dist", "src", "cli.js"), "export const a = 1;\n", "utf8");
    });

    it("a malformed identity is a mismatch and the content digest is not even computed", async () => {
        const identity = await verifyReleaseIdentity(root, {
            HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE: "embedded-release",
            HEZARFEN_CLAUDE_OAUTH_RELEASE_ID: "router-v2-not-lowercase",
        });
        strictEqual(identity.status, "mismatch");
        strictEqual(identity.detailCode, "release_id_malformed");
        strictEqual(identity.computedId, undefined);
    });

    it("returns unreadable for an unreadable release without crashing", async () => {
        const identity = await verifyReleaseIdentity(join(root, "no-such-directory"), {
            HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE: "embedded-release",
            HEZARFEN_CLAUDE_OAUTH_RELEASE_ID: "router-v3-AAAAAAAAAAAA-BBBBBBBBBBBB",
        });
        strictEqual(identity.status, "unreadable");
    });
});

describe("RELEASE_ID_PATTERN", () => {
    it("accepts only UPPERCASE hex and exactly 12+12 characters", () => {
        strictEqual(RELEASE_ID_PATTERN.test("router-v3-ABCDEF012345-0123456789AB"), true);
        strictEqual(RELEASE_ID_PATTERN.test("router-v3-abcdef012345-0123456789ab"), false);
        strictEqual(RELEASE_ID_PATTERN.test("router-v3-ABCDEF01234-0123456789AB"), false);
        strictEqual(RELEASE_ID_PATTERN.test("router-v2-ABCDEF012345-0123456789AB"), false);
    });
});
