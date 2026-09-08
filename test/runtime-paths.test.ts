import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runtimePaths } from "../src/runtime/paths.js";

// CASE RECORD (FINDING 6, 2026-09-05, independent audit): the `shadow/patch-state-2.8.2`
// -> `shadow/patch-state` rename had NO measure at all -- `grep -rn shadowPatchBackups
// test/` returned zero results. A version number buried in a path starts lying at the
// first upgrade: the installed `patch-state.json` still points at the old directory and
// claude-shadow.ts assertPathInside now counts it as OUTSIDE (503). Reading the code
// shows a self-repairing path (stale manifest -> pristine reset -> re-patch), but an
// unmeasured rule rots, and it does not announce it.
//
// The pristine backup in the old directory is left ORPHANED. Deleting it is the
// OPERATOR's call: this test does not measure it and does not propose the deletion.

const BASE = process.platform === "win32" ? "C:\\hezarfen-olcum" : "/hezarfen-olcum";
const paths = runtimePaths({ LOCALAPPDATA: BASE });

// A version number buried in a path segment: "patch-state-2.8.2", "claude-2.1.251"...
const YOLDA_SURUM = /(?:^|[^0-9])\d+\.\d+\.\d+(?:[^0-9]|$)/u;

describe("runtimePaths -- surum yola gomulmez", () => {
    it("TWEAKCC yedek dizini surum tasimayan sabit addir", () => {
        strictEqual(paths.shadowPatchBackups, join(paths.root, "shadow", "patch-state"));
    });

    it("hicbir calisma-zamani yolu surum numarasi tasimaz", () => {
        const tasiyanlar = Object.entries(paths)
            .filter(([, value]) => typeof value === "string" && YOLDA_SURUM.test(value))
            .map(([key]) => key);
        deepStrictEqual(tasiyanlar, []);
    });

    // POSITIVE CONTROL: the arm above may simply be producing empty output. Does the
    // criterion ACTUALLY catch the NAME that was removed? If it does not, the test is
    // measuring the rule's name, not the rule itself.
    it("olcut kaldirilan eski adi (patch-state-2.8.2) yakalar", () => {
        strictEqual(YOLDA_SURUM.test(join(paths.root, "shadow", "patch-state-2.8.2")), true);
        strictEqual(YOLDA_SURUM.test(paths.shadowPatchBackups), false);
    });

    it("her yol calisma-zamani kokunun altinda kalir", () => {
        for (const [key, value] of Object.entries(paths)) {
            if (typeof value !== "string" || key === "root" || key === "ipc")
                continue;
            strictEqual(value.startsWith(paths.root), true, `kok disina cikan yol: ${key}`);
        }
    });
});
