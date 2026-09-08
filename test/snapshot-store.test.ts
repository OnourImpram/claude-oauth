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
    it("reads back the written snapshot exactly", async () => {
        const path = join(directory, "round-trip.json");
        await writeSnapshot(path, baseline);
        deepStrictEqual(await readSnapshot(path), baseline);
    });

    it("leaves no temporary files in the directory after writing", async () => {
        const path = join(directory, "no-leftovers.json");
        await writeSnapshot(path, baseline);
        const { readdir } = await import("node:fs/promises");
        const leftovers = (await readdir(directory)).filter((name) => name.includes(".tmp"));
        deepStrictEqual(leftovers, []);
    });

    it("overwriting replaces the old content completely", async () => {
        const path = join(directory, "overwrite.json");
        await writeSnapshot(path, baseline);
        const wider: ModelSnapshot = { ...baseline, source: "live-provider-refresh", models: [] };
        await writeSnapshot(path, wider);
        strictEqual((await readSnapshot(path)).source, "live-provider-refresh");
    });
});

describe("readSnapshotOrDefault", () => {
    it("falls back to the baseline when the runtime file is missing", async () => {
        strictEqual((await readSnapshotOrDefault(join(directory, "missing.json"), defaultPath())).source, "pinned-install-baseline");
    });

    it("falls back to the baseline without throwing when the runtime file is CORRUPT", async () => {
        const broken = join(directory, "corrupt.json");
        await writeFile(broken, "{ this is not JSON", "utf8");
        strictEqual((await readSnapshotOrDefault(broken, defaultPath())).source, "pinned-install-baseline");
    });

    // REGRESSION: a corrupt snapshot file made `claude` unable to start, with a raw
    // SyntaxError. It now falls back to the baseline -- but not silently, with a
    // structured warning.
    it("seedSnapshot reseeds a corrupt snapshot without throwing", async () => {
        const broken = join(directory, "corrupt-seed.json");
        await writeFile(broken, "{ partially written", "utf8");
        await seedSnapshot(broken, defaultPath());
        strictEqual((await readSnapshot(broken)).source, "pinned-install-baseline");
    });

    it("valid JSON outside the schema is also treated as corrupt", async () => {
        const wrongShape = join(directory, "outside-schema.json");
        await writeFile(wrongShape, JSON.stringify({ schemaVersion: 99, models: "not a list" }), "utf8");
        strictEqual((await readSnapshotOrDefault(wrongShape, defaultPath())).source, "pinned-install-baseline");
    });

    it("prefers a valid runtime file when present", async () => {
        const live = join(directory, "live.json");
        await writeSnapshot(live, { ...baseline, source: "live-provider-refresh" });
        strictEqual((await readSnapshotOrDefault(live, defaultPath())).source, "live-provider-refresh");
    });
});

describe("seedSnapshot", () => {
    it("seeds from the baseline when absent", async () => {
        await seedSnapshot(runtimePath(), defaultPath());
        strictEqual((await readSnapshot(runtimePath())).source, "pinned-install-baseline");
    });

    it("does not overwrite an EXISTING snapshot", async () => {
        await writeSnapshot(runtimePath(), { ...baseline, source: "live-provider-refresh" });
        await seedSnapshot(runtimePath(), defaultPath());
        strictEqual((await readSnapshot(runtimePath())).source, "live-provider-refresh");
    });

    // REGRESSION: when two terminals opened at the same time the first seeding raced (Windows EBUSY).
    it("eight concurrent seed operations do not race or corrupt the file", async () => {
        const racing = join(directory, "race.json");
        await Promise.all(Array.from({ length: 8 }, async () => { await seedSnapshot(racing, defaultPath()); }));
        const text = await readFile(racing, "utf8");
        const parsed = JSON.parse(text) as ModelSnapshot;
        strictEqual(parsed.schemaVersion, 1);
        strictEqual(parsed.models.length, 1);
    });

    it("concurrent writes do not leave a partial file", async () => {
        const racing = join(directory, "race2.json");
        await Promise.all(Array.from({ length: 8 }, async (_unused, index) => {
            await writeSnapshot(racing, { ...baseline, source: `run-${index}` });
        }));
        const parsed = JSON.parse(await readFile(racing, "utf8")) as ModelSnapshot;
        strictEqual(parsed.schemaVersion, 1);
        strictEqual(parsed.source.startsWith("run-"), true);
    });

    // NEGATIVE CONTROL: the test above is green thanks to the bounded rename retry on the
    // write path. That retry is ONLY for a transient collision -- if it swallows a
    // permanent error, the gate's green loses its meaning. When the target is a DIRECTORY
    // the rename can never succeed; what is expected here is not that the error is
    // suppressed but that it is THROWN.
    it("does not swallow a permanent rename error", async () => {
        const blocked = join(directory, "blocking-directory");
        await mkdir(blocked, { recursive: true });
        await rejects(async () => { await writeSnapshot(blocked, baseline); });
    });
});
