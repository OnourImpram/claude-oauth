import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ModelSnapshot } from "../src/domain/contracts.js";
import { readSnapshot, readSnapshotOrDefault, seedSnapshot, writeSnapshot } from "../src/runtime/snapshot-store.js";

// The snapshot is the single source of the /model list. When two terminals open at the
// same time the first seeding races; on Windows that blew up as EBUSY. The snapshot
// REGRESSING to the 4-model baseline was the visible symptom of that event -- which is
// why the write path must be atomic and the read path must fall back to the baseline on
// a corrupt file.

let directory = "";
const defaultPath = (): string => join(directory, "models.default.json");
const runtimePath = (): string => join(directory, "models.snapshot.json");

const baseline: ModelSnapshot = {
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

before(async () => {
    directory = await mkdtemp(join(tmpdir(), "snapshot-store-"));
    await writeFile(defaultPath(), JSON.stringify(baseline), "utf8");
});

after(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("writeSnapshot / readSnapshot", () => {
    it("yazilan snapshot aynen geri okunur", async () => {
        const path = join(directory, "gidis-donus.json");
        await writeSnapshot(path, baseline);
        deepStrictEqual(await readSnapshot(path), baseline);
    });

    it("yazma sonrasi dizinde gecici dosya birakmaz", async () => {
        const path = join(directory, "artik-yok.json");
        await writeSnapshot(path, baseline);
        const { readdir } = await import("node:fs/promises");
        const leftovers = (await readdir(directory)).filter((name) => name.includes(".tmp"));
        deepStrictEqual(leftovers, []);
    });

    it("ustune yazmak eski icerigi tamamen degistirir", async () => {
        const path = join(directory, "ustune.json");
        await writeSnapshot(path, baseline);
        const wider: ModelSnapshot = { ...baseline, source: "live-provider-refresh", models: [] };
        await writeSnapshot(path, wider);
        strictEqual((await readSnapshot(path)).source, "live-provider-refresh");
    });
});

describe("readSnapshotOrDefault", () => {
    it("runtime dosyasi yoksa tabana duser", async () => {
        strictEqual((await readSnapshotOrDefault(join(directory, "yok.json"), defaultPath())).source, "pinned-install-baseline");
    });

    it("runtime dosyasi BOZUKSA tabana duser, firlatmaz", async () => {
        const broken = join(directory, "bozuk.json");
        await writeFile(broken, "{ bu JSON degil", "utf8");
        strictEqual((await readSnapshotOrDefault(broken, defaultPath())).source, "pinned-install-baseline");
    });

    // REGRESSION: a corrupt snapshot file made `claude` unable to start, with a raw
    // SyntaxError. It now falls back to the baseline -- but not silently, with a
    // structured warning.
    it("bozuk snapshot'i olan seedSnapshot yeniden tohumlar, firlatmaz", async () => {
        const broken = join(directory, "bozuk-tohum.json");
        await writeFile(broken, "{ yarim yazilmis", "utf8");
        await seedSnapshot(broken, defaultPath());
        strictEqual((await readSnapshot(broken)).source, "pinned-install-baseline");
    });

    it("sema disi ama gecerli JSON da bozuk sayilir", async () => {
        const wrongShape = join(directory, "sema-disi.json");
        await writeFile(wrongShape, JSON.stringify({ schemaVersion: 99, models: "liste degil" }), "utf8");
        strictEqual((await readSnapshotOrDefault(wrongShape, defaultPath())).source, "pinned-install-baseline");
    });

    it("gecerli runtime dosyasi varsa onu tercih eder", async () => {
        const live = join(directory, "canli.json");
        await writeSnapshot(live, { ...baseline, source: "live-provider-refresh" });
        strictEqual((await readSnapshotOrDefault(live, defaultPath())).source, "live-provider-refresh");
    });
});

describe("seedSnapshot", () => {
    it("yoksa tabandan tohumlar", async () => {
        await seedSnapshot(runtimePath(), defaultPath());
        strictEqual((await readSnapshot(runtimePath())).source, "pinned-install-baseline");
    });

    it("VAR OLAN snapshot'i ezmez", async () => {
        await writeSnapshot(runtimePath(), { ...baseline, source: "live-provider-refresh" });
        await seedSnapshot(runtimePath(), defaultPath());
        strictEqual((await readSnapshot(runtimePath())).source, "live-provider-refresh");
    });

    // REGRESSION: when two terminals opened at the same time the first seeding raced (Windows EBUSY).
    it("es zamanli sekiz tohumlama yarismaz ve dosyayi bozmaz", async () => {
        const racing = join(directory, "yaris.json");
        await Promise.all(Array.from({ length: 8 }, async () => { await seedSnapshot(racing, defaultPath()); }));
        const text = await readFile(racing, "utf8");
        const parsed = JSON.parse(text) as ModelSnapshot;
        strictEqual(parsed.schemaVersion, 1);
        strictEqual(parsed.models.length, 1);
    });

    it("es zamanli yazmalar yarim dosya birakmaz", async () => {
        const racing = join(directory, "yaris2.json");
        await Promise.all(Array.from({ length: 8 }, async (_unused, index) => {
            await writeSnapshot(racing, { ...baseline, source: `kosum-${index}` });
        }));
        const parsed = JSON.parse(await readFile(racing, "utf8")) as ModelSnapshot;
        strictEqual(parsed.schemaVersion, 1);
        strictEqual(parsed.source.startsWith("kosum-"), true);
    });

    // NEGATIVE CONTROL: the test above is green thanks to the bounded rename retry on the
    // write path. That retry is ONLY for a transient collision -- if it swallows a
    // permanent error, the gate's green loses its meaning. When the target is a DIRECTORY
    // the rename can never succeed; what is expected here is not that the error is
    // suppressed but that it is THROWN.
    it("kalici rename hatasini yutmaz", async () => {
        const blocked = join(directory, "engel-dizini");
        await mkdir(blocked, { recursive: true });
        await rejects(async () => { await writeSnapshot(blocked, baseline); });
    });
});
