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
    it("beklenen bicimi uretir", async () => {
        match(await computeReleaseId(root), RELEASE_ID_PATTERN);
    });

    it("kararlidir: degismeyen agac ayni kimligi verir", async () => {
        strictEqual(await computeReleaseId(root), await computeReleaseId(root));
    });

    it("tek bayta duyarlidir: dist degisince kimlik degisir", async () => {
        const before_ = await computeReleaseId(root);
        await writeFile(join(root, "dist", "src", "cli.js"), "export const a = 2;\n", "utf8");
        notStrictEqual(await computeReleaseId(root), before_);
        await writeFile(join(root, "dist", "src", "cli.js"), "export const a = 1;\n", "utf8");
        strictEqual(await computeReleaseId(root), before_);
    });

    it("config degisiminde ikinci bilesen degisir, birincisi ayni kalir", async () => {
        const before_ = await computeReleaseId(root);
        await writeFile(join(root, "config", "install-lock.json"), '{"schemaVersion":1,"x":2}\n', "utf8");
        const after_ = await computeReleaseId(root);
        const [, distBefore, configBefore] = RELEASE_ID_PATTERN.exec(before_) ?? [];
        const [, distAfter, configAfter] = RELEASE_ID_PATTERN.exec(after_) ?? [];
        strictEqual(distAfter, distBefore);
        notStrictEqual(configAfter, configBefore);
        await writeFile(join(root, "config", "install-lock.json"), '{"schemaVersion":1}\n', "utf8");
    });

    it("dosya ADI da ozete girer: icerik tasinirsa kimlik degisir", async () => {
        const before_ = await computeReleaseId(root);
        await writeFile(join(root, "dist", "src", "baska.js"), "export const a = 1;\n", "utf8");
        await rm(join(root, "dist", "src", "cli.js"));
        notStrictEqual(await computeReleaseId(root), before_);
        await writeFile(join(root, "dist", "src", "cli.js"), "export const a = 1;\n", "utf8");
        await rm(join(root, "dist", "src", "baska.js"));
        strictEqual(await computeReleaseId(root), before_);
    });
});

describe("verifyReleaseIdentity", () => {
    it("gomulu release'den baslatilmadiysa unverified der, hata firlatmaz", async () => {
        const identity = await verifyReleaseIdentity(root, {});
        strictEqual(identity.status, "unverified");
        strictEqual(identity.detailCode, "not_launched_from_embedded_release");
    });

    it("kaynak embedded-release ama kimlik yoksa yine unverified", async () => {
        const identity = await verifyReleaseIdentity(root, { HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE: "embedded-release" });
        strictEqual(identity.status, "unverified");
    });

    it("dogru kimlikle verified doner", async () => {
        const declared = await computeReleaseId(root);
        const identity = await verifyReleaseIdentity(root, {
            HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE: "embedded-release",
            HEZARFEN_CLAUDE_OAUTH_RELEASE_ID: declared,
        });
        strictEqual(identity.status, "verified");
        strictEqual(identity.computedId, declared);
    });

    // NEGATIVE CONTROL -- the event itself: the release was edited in place and kept its name.
    it("icerik degistiginde mismatch verir (yerinde duzenlenmis release)", async () => {
        const declared = await computeReleaseId(root);
        await writeFile(join(root, "dist", "src", "cli.js"), "export const a = 1;\n// elle yamalandi\n", "utf8");
        const identity = await verifyReleaseIdentity(root, {
            HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE: "embedded-release",
            HEZARFEN_CLAUDE_OAUTH_RELEASE_ID: declared,
        });
        strictEqual(identity.status, "mismatch");
        strictEqual(identity.detailCode, "release_contents_do_not_match_release_id");
        notStrictEqual(identity.computedId, declared);
        await writeFile(join(root, "dist", "src", "cli.js"), "export const a = 1;\n", "utf8");
    });

    it("bicimsiz kimlik mismatch sayilir ve icerik bile hesaplanmaz", async () => {
        const identity = await verifyReleaseIdentity(root, {
            HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE: "embedded-release",
            HEZARFEN_CLAUDE_OAUTH_RELEASE_ID: "router-v2-kucukharf-degil",
        });
        strictEqual(identity.status, "mismatch");
        strictEqual(identity.detailCode, "release_id_malformed");
        strictEqual(identity.computedId, undefined);
    });

    it("okunamayan release icin unreadable doner, cokmez", async () => {
        const identity = await verifyReleaseIdentity(join(root, "boyle-bir-dizin-yok"), {
            HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE: "embedded-release",
            HEZARFEN_CLAUDE_OAUTH_RELEASE_ID: "router-v3-AAAAAAAAAAAA-BBBBBBBBBBBB",
        });
        strictEqual(identity.status, "unreadable");
    });
});

describe("RELEASE_ID_PATTERN", () => {
    it("yalniz BUYUK harf hex ve tam 12+12 kabul eder", () => {
        strictEqual(RELEASE_ID_PATTERN.test("router-v3-ABCDEF012345-0123456789AB"), true);
        strictEqual(RELEASE_ID_PATTERN.test("router-v3-abcdef012345-0123456789ab"), false);
        strictEqual(RELEASE_ID_PATTERN.test("router-v3-ABCDEF01234-0123456789AB"), false);
        strictEqual(RELEASE_ID_PATTERN.test("router-v2-ABCDEF012345-0123456789AB"), false);
    });
});
