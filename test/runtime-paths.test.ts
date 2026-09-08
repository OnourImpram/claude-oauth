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

const BASE = process.platform === "win32" ? "C:\\hezarfen-measurement" : "/hezarfen-measurement";
const paths = runtimePaths({ LOCALAPPDATA: BASE });

// A version number buried in a path segment: "patch-state-2.8.2", "claude-2.1.251"...
const VERSION_IN_PATH = /(?:^|[^0-9])\d+\.\d+\.\d+(?:[^0-9]|$)/u;

describe("runtimePaths -- versions are not embedded in paths", () => {
    it("the TWEAKCC backup directory has a stable name without a version", () => {
        strictEqual(paths.shadowPatchBackups, join(paths.root, "shadow", "patch-state"));
    });

    it("no runtime path carries a version number", () => {
        const versionedPaths = Object.entries(paths)
            .filter(([, value]) => typeof value === "string" && VERSION_IN_PATH.test(value))
            .map(([key]) => key);
        deepStrictEqual(versionedPaths, []);
    });

    // POSITIVE CONTROL: the arm above may simply be producing empty output. Does the
    // criterion ACTUALLY catch the NAME that was removed? If it does not, the test is
    // measuring the rule's name, not the rule itself.
    it("the criterion catches the removed old name (patch-state-2.8.2)", () => {
        strictEqual(VERSION_IN_PATH.test(join(paths.root, "shadow", "patch-state-2.8.2")), true);
        strictEqual(VERSION_IN_PATH.test(paths.shadowPatchBackups), false);
    });

    it("every path stays under the runtime root", () => {
        for (const [key, value] of Object.entries(paths)) {
            if (typeof value !== "string" || key === "root" || key === "ipc")
                continue;
            strictEqual(value.startsWith(paths.root), true, `path outside the root: ${key}`);
        }
    });
});
