import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { SUPERVISOR_DETAIL_CODE_LIMIT } from "../src/domain/contracts.js";
import { clodexCatalogDriftDetailCode } from "../src/domain/model-contracts.js";

// Measured 2026-09-07 by a whole-repository review pass, which is the only way this
// was ever going to be found: the producer and the consumer are in different files and
// neither is wrong on its own. A real catalog drift across three models produced a
// detailCode of about 187 characters; src/supervisor/ipc.ts rejects anything past 128,
// and rejecting one field throws away the WHOLE status object -- so a running session
// vanishes from discovery and doctor can report it stopped. The text written to
// EXPLAIN a problem was destroying the delivery of the diagnosis.
//
// The bound now lives in one exported constant. These arms are what keep the two sides
// from drifting apart again: the second one fails the moment the producer can emit
// something the reader will refuse.

function drift(count: number): { id: string; liveContextWindow: number; snapshotContextWindow: number }[] {
    return Array.from({ length: count }, (_unused, index) => ({
        id: `anthropic-openai-gpt-5.6-lane${index}`,
        liveContextWindow: 872_000,
        snapshotContextWindow: 828_400,
    }));
}

describe("supervisor detailCode fits the contract that carries it", () => {
    it("no drift keeps the bare code", () => {
        strictEqual(clodexCatalogDriftDetailCode([]), "clodex_session_catalog_drift");
    });

    it("a single drifting model is reported in full", () => {
        const code = clodexCatalogDriftDetailCode(drift(1));
        ok(code.includes("lane0"), "the drifting model is not named");
        ok(code.includes("live872000"), "the live window is not carried");
        ok(code.length <= SUPERVISOR_DETAIL_CODE_LIMIT, `${code.length} characters exceeds the limit`);
    });

    it("the code stays inside the IPC bound however many models drift", () => {
        for (const count of [2, 3, 5, 12, 40]) {
            const code = clodexCatalogDriftDetailCode(drift(count));
            ok(code.length <= SUPERVISOR_DETAIL_CODE_LIMIT,
                `${count} drifting models produced ${code.length} characters, over the ${SUPERVISOR_DETAIL_CODE_LIMIT} the reader accepts`);
        }
    });

    it("what does not fit is counted, not silently dropped", () => {
        const code = clodexCatalogDriftDetailCode(drift(12));
        ok(/\+\d+_more/u.test(code), `the truncation is silent: ${code}`);
        ok(code.startsWith("clodex_session_catalog_drift:"), "the code prefix was lost to truncation");
    });

    it("negative control: the limit is what makes these arms fail", () => {
        // If the constant were raised without the reader agreeing, the third arm above
        // would keep passing while the reader kept refusing. This arm pins the number
        // itself, so a change has to be deliberate on both sides.
        strictEqual(SUPERVISOR_DETAIL_CODE_LIMIT, 256);
    });
});
