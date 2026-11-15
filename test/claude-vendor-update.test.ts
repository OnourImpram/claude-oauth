import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readInstallLock, type InstallCheck, type InstallLock } from "../src/runtime/install-lock.js";
import { annotateVendorUpdate, parseDistinguishedName, resolveClaudeVendorUpdate, type ResolveClaudeVendorUpdateOptions, type SignatureReport } from "../src/runtime/claude-vendor-update.js";

// CASE RECORD (2026-11-15). Claude Code updates itself; the exact-hash pin then refused to
// launch claude-oauth until someone re-pinned by hand. It happened at 2.1.252, 2.1.270,
// 2.1.283, 2.1.284, 2.1.289, 2.1.302, 2.1.316, 2.1.319 and 2.1.325. The owner asked for the
// pin to follow the update on its own. The policy tested here accepts a new binary ONLY when
// the platform's code-signing verdict is Valid, the signer is the one the lock names, and the
// version does not go backwards. Every other outcome keeps the old refusal.

const PINNED_SHA = "A".repeat(64);
const UPDATED_SHA = "B".repeat(64);
const VENDOR_SUBJECT = 'CN="Anthropic, PBC", O="Anthropic, PBC", L=San Francisco, S=California, C=US, SERIALNUMBER=4860621, OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US';
const VALID_VENDOR_SIGNATURE: SignatureReport = { status: "Valid", subject: VENDOR_SUBJECT, thumbprint: "60C2D9C51F09822FFF4F194DE9EEDB67451292D1" };

let scratch = "";
let cacheCounter = 0;

before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "claude-vendor-update-"));
});
after(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function lockWithPolicy(): InstallLock {
    return {
        schemaVersion: 1,
        claude: {
            version: "2.1.319",
            executable: join(scratch, "claude.exe"),
            sha256: PINNED_SHA,
            vendorSignature: { platform: "win32", signerCommonName: "Anthropic, PBC", signerOrganization: "Anthropic, PBC" },
        },
    } as unknown as InstallLock;
}

interface Probes {
    hashCalls: number;
    versionCalls: number;
    signatureCalls: number;
}

function scenario(overrides: Partial<ResolveClaudeVendorUpdateOptions> & {
    readonly observedSha256?: string;
    readonly reportedVersion?: string;
    readonly signature?: SignatureReport;
} = {}): { readonly options: ResolveClaudeVendorUpdateOptions; readonly probes: Probes } {
    const probes: Probes = { hashCalls: 0, versionCalls: 0, signatureCalls: 0 };
    const { observedSha256, reportedVersion, signature, ...rest } = overrides;
    cacheCounter += 1;
    const options: ResolveClaudeVendorUpdateOptions = {
        lock: lockWithPolicy(),
        moduleRoot: scratch,
        cachePath: join(scratch, `accept-${cacheCounter}.json`),
        environment: {},
        platform: "win32",
        hashFile: async () => {
            probes.hashCalls += 1;
            return observedSha256 ?? UPDATED_SHA;
        },
        versionRunner: async () => {
            probes.versionCalls += 1;
            return { exitCode: 0, stdout: `${reportedVersion ?? "2.1.325"} (Claude Code)\n`, stderr: "" };
        },
        signatureProbe: async () => {
            probes.signatureCalls += 1;
            return signature ?? VALID_VENDOR_SIGNATURE;
        },
        now: () => new Date("2026-11-15T09:00:00.000Z"),
        ...rest,
    };
    return { options, probes };
}

describe("resolveClaudeVendorUpdate", () => {
    it("accepts a newer binary that the vendor signed, and pins the effective lock to what is on disk", async () => {
        const { options } = scenario();
        const resolved = await resolveClaudeVendorUpdate(options);
        strictEqual(resolved.decision.status, "accepted");
        strictEqual(resolved.decision.detailCode, "signed_vendor_update_accepted");
        strictEqual(resolved.decision.pinnedVersion, "2.1.319");
        strictEqual(resolved.decision.observedVersion, "2.1.325");
        strictEqual(resolved.decision.observedSha256, UPDATED_SHA);
        deepStrictEqual({ version: resolved.lock.claude.version, sha256: resolved.lock.claude.sha256 }, { version: "2.1.325", sha256: UPDATED_SHA });
        strictEqual(resolved.lock.claude.executable, options.lock.claude.executable);
    });

    it("leaves the pin alone when the bytes on disk are the pinned bytes, and never consults the signature", async () => {
        const { options, probes } = scenario({ observedSha256: PINNED_SHA });
        const resolved = await resolveClaudeVendorUpdate(options);
        strictEqual(resolved.decision.status, "pinned");
        strictEqual(resolved.decision.detailCode, "locked_hash_match");
        strictEqual(resolved.lock, options.lock);
        strictEqual(probes.signatureCalls, 0);
        strictEqual(probes.versionCalls, 0);
    });

    describe("acceptance record", () => {
        it("the second launch on the same accepted binary does not pay for a signature probe again", async () => {
            const first = scenario();
            const firstResolved = await resolveClaudeVendorUpdate(first.options);
            strictEqual(firstResolved.decision.cached, false);
            strictEqual(first.probes.signatureCalls, 1);
            const second = scenario({ cachePath: first.options.cachePath });
            const secondResolved = await resolveClaudeVendorUpdate(second.options);
            strictEqual(secondResolved.decision.status, "accepted");
            strictEqual(secondResolved.decision.cached, true);
            strictEqual(second.probes.signatureCalls, 0);
            strictEqual(secondResolved.decision.acceptedAt, "2026-11-15T09:00:00.000Z");
            strictEqual(secondResolved.lock.claude.sha256, UPDATED_SHA);
            const stored = JSON.parse(await readFile(first.options.cachePath, "utf8")) as { accepted: Record<string, unknown> };
            deepStrictEqual(Object.keys(stored.accepted).sort(), ["acceptedAt", "executable", "sha256", "signerCommonName", "signerOrganization", "signerThumbprint", "version"]);
        });

        it("NEGATIVE: a record for other bytes never accepts the bytes on disk; the signature decides", async () => {
            const first = scenario();
            await resolveClaudeVendorUpdate(first.options);
            const second = scenario({ cachePath: first.options.cachePath, observedSha256: "D".repeat(64), signature: { status: "NotSigned", subject: "", thumbprint: "" } });
            const resolved = await resolveClaudeVendorUpdate(second.options);
            strictEqual(second.probes.signatureCalls, 1);
            strictEqual(resolved.decision.status, "refused");
            strictEqual(resolved.decision.detailCode, "vendor_update_signature_not_valid");
        });

        it("NEGATIVE: a record made under another signer policy is not reused", async () => {
            const first = scenario();
            await resolveClaudeVendorUpdate(first.options);
            const base = lockWithPolicy();
            const otherPolicy = { ...base, claude: { ...base.claude, vendorSignature: { platform: "win32" as const, signerCommonName: "Someone Else", signerOrganization: "Someone Else" } } };
            const second = scenario({ cachePath: first.options.cachePath, lock: otherPolicy });
            const resolved = await resolveClaudeVendorUpdate(second.options);
            strictEqual(second.probes.signatureCalls, 1);
            strictEqual(resolved.decision.detailCode, "vendor_update_signer_mismatch");
        });

        it("a corrupt record is ignored, not trusted and not fatal", async () => {
            const { options, probes } = scenario();
            await writeFile(options.cachePath, "{ not json", "utf8");
            const resolved = await resolveClaudeVendorUpdate(options);
            strictEqual(resolved.decision.status, "accepted");
            strictEqual(probes.signatureCalls, 1);
        });

        it("an unwritable record location does not turn an acceptance into a refusal", async () => {
            const blocker = join(scratch, "blocker-file");
            await writeFile(blocker, "x", "utf8");
            const { options } = scenario({ cachePath: join(blocker, "nested", "accept.json") });
            strictEqual((await resolveClaudeVendorUpdate(options)).decision.status, "accepted");
        });
    });

    describe("parseDistinguishedName", () => {
        it("reads the subject Windows prints for the measured vendor certificate", () => {
            const attributes = parseDistinguishedName(VENDOR_SUBJECT);
            deepStrictEqual(attributes?.filter(([name]) => name === "CN" || name === "O"), [["CN", "Anthropic, PBC"], ["O", "Anthropic, PBC"]]);
            strictEqual(attributes?.length, 9);
        });
        it("keeps a quoted attribute whole: a name inside another value is not an attribute", () => {
            deepStrictEqual(parseDistinguishedName('CN=Evil Corp, OU="CN=Anthropic, PBC"'), [["CN", "Evil Corp"], ["OU", "CN=Anthropic, PBC"]]);
        });
        it("handles doubled quotes inside a quoted value and backslash escapes outside one", () => {
            deepStrictEqual(parseDistinguishedName('CN="A ""quoted"" name", O=Comma\\, Inc'), [["CN", 'A "quoted" name'], ["O", "Comma, Inc"]]);
        });
        it("NEGATIVE: returns undefined for a subject that does not parse", () => {
            strictEqual(parseDistinguishedName('CN="unterminated'), undefined);
            strictEqual(parseDistinguishedName("no equals sign"), undefined);
            strictEqual(parseDistinguishedName('CN="closed" trailing'), undefined);
        });
    });

    describe("NEGATIVE: every outcome other than a valid vendor signature keeps the old refusal", () => {
        const refusals: readonly { readonly name: string; readonly signature: SignatureReport; readonly detailCode: string }[] = [
            { name: "an unsigned binary", signature: { status: "NotSigned", subject: "", thumbprint: "" }, detailCode: "vendor_update_signature_not_valid" },
            { name: "a signed binary whose bytes were altered after signing", signature: { ...VALID_VENDOR_SIGNATURE, status: "HashMismatch" }, detailCode: "vendor_update_signature_not_valid" },
            { name: "a signature that does not chain to a trusted root", signature: { ...VALID_VENDOR_SIGNATURE, status: "NotTrusted" }, detailCode: "vendor_update_signature_not_valid" },
            { name: "a valid signature from a different publisher", signature: { status: "Valid", subject: 'CN="Some Other Vendor, Inc.", O="Some Other Vendor, Inc.", C=US', thumbprint: "0".repeat(40) }, detailCode: "vendor_update_signer_mismatch" },
            { name: "a publisher that only embeds the vendor name inside another attribute", signature: { status: "Valid", subject: 'CN=Evil Corp, O=Evil Corp, OU="CN=Anthropic, PBC, O=Anthropic, PBC"', thumbprint: "0".repeat(40) }, detailCode: "vendor_update_signer_mismatch" },
            { name: "a publisher whose name merely starts with the vendor name", signature: { status: "Valid", subject: 'CN="Anthropic, PBC Holdings", O="Anthropic, PBC"', thumbprint: "0".repeat(40) }, detailCode: "vendor_update_signer_mismatch" },
            { name: "the right common name under a different organization", signature: { status: "Valid", subject: 'CN="Anthropic, PBC", O="Somebody Else"', thumbprint: "0".repeat(40) }, detailCode: "vendor_update_signer_mismatch" },
            { name: "a subject that names the vendor twice", signature: { status: "Valid", subject: 'CN="Anthropic, PBC", CN=Evil Corp, O="Anthropic, PBC"', thumbprint: "0".repeat(40) }, detailCode: "vendor_update_signer_mismatch" },
        ];
        for (const refusal of refusals) {
            it(`refuses ${refusal.name}`, async () => {
                const { options } = scenario({ signature: refusal.signature });
                const resolved = await resolveClaudeVendorUpdate(options);
                strictEqual(resolved.decision.status, "refused");
                strictEqual(resolved.decision.detailCode, refusal.detailCode);
                strictEqual(resolved.lock, options.lock, "a refused update must leave the lock exactly as pinned");
            });
        }

        it("refuses a downgrade below the pinned version without asking for a signature", async () => {
            const { options, probes } = scenario({ reportedVersion: "2.1.316" });
            const resolved = await resolveClaudeVendorUpdate(options);
            strictEqual(resolved.decision.status, "refused");
            strictEqual(resolved.decision.detailCode, "vendor_update_version_below_pin");
            strictEqual(resolved.lock, options.lock);
            strictEqual(probes.signatureCalls, 0);
        });

        it("compares versions numerically: 2.1.99 is below 2.1.319", async () => {
            const { options } = scenario({ reportedVersion: "2.1.99" });
            strictEqual((await resolveClaudeVendorUpdate(options)).decision.detailCode, "vendor_update_version_below_pin");
        });

        it("refuses when the binary does not report a version", async () => {
            const { options } = scenario({ versionRunner: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }) });
            const resolved = await resolveClaudeVendorUpdate(options);
            strictEqual(resolved.decision.status, "refused");
            strictEqual(resolved.decision.detailCode, "vendor_update_version_probe_failed");
        });

        it("refuses when the signature probe itself fails", async () => {
            const { options } = scenario({ signatureProbe: async () => { throw new Error("powershell missing"); } });
            const resolved = await resolveClaudeVendorUpdate(options);
            strictEqual(resolved.decision.status, "refused");
            strictEqual(resolved.decision.detailCode, "vendor_update_signature_probe_failed");
            strictEqual(resolved.lock, options.lock);
        });

        it("does nothing when the lock carries no vendor-signature policy: the pin stays exact-hash", async () => {
            const base = lockWithPolicy();
            const { vendorSignature: _dropped, ...claudeWithoutPolicy } = base.claude;
            const { options, probes } = scenario({ lock: { ...base, claude: claudeWithoutPolicy } });
            const resolved = await resolveClaudeVendorUpdate(options);
            strictEqual(resolved.decision.status, "not_applicable");
            strictEqual(resolved.decision.detailCode, "vendor_signature_policy_absent");
            strictEqual(resolved.lock, options.lock);
            strictEqual(probes.signatureCalls, 0);
        });

        it("does nothing on a platform the policy does not name", async () => {
            const { options, probes } = scenario({ platform: "linux" });
            const resolved = await resolveClaudeVendorUpdate(options);
            strictEqual(resolved.decision.status, "not_applicable");
            strictEqual(resolved.decision.detailCode, "vendor_signature_policy_other_platform");
            strictEqual(resolved.lock, options.lock);
            strictEqual(probes.signatureCalls, 0);
        });

        it("a missing binary is left to the ordinary check, which names it", async () => {
            const { options } = scenario({ hashFile: async () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); } });
            const resolved = await resolveClaudeVendorUpdate(options);
            strictEqual(resolved.decision.status, "not_applicable");
            strictEqual(resolved.lock, options.lock);
        });

        it("refuses when the bytes change between the hash and the signature verdict", async () => {
            let call = 0;
            const { options } = scenario({ hashFile: async () => (call++ === 0 ? UPDATED_SHA : "C".repeat(64)) });
            const resolved = await resolveClaudeVendorUpdate(options);
            strictEqual(resolved.decision.status, "refused");
            strictEqual(resolved.decision.detailCode, "vendor_update_binary_changed_during_verification");
            strictEqual(resolved.lock, options.lock);
        });
    });
});

describe("install lock: the vendor-signature policy field", () => {
    async function lockFileWith(mutate: (claude: Record<string, unknown>) => void): Promise<string> {
        const repositoryLock = JSON.parse(await readFile(join(import.meta.dirname, "..", "..", "config", "install-lock.json"), "utf8")) as { claude: Record<string, unknown> };
        mutate(repositoryLock.claude);
        cacheCounter += 1;
        const path = join(scratch, `lock-${cacheCounter}.json`);
        await writeFile(path, JSON.stringify(repositoryLock), "utf8");
        return path;
    }
    const policy = { platform: "win32", signerCommonName: "Anthropic, PBC", signerOrganization: "Anthropic, PBC" };

    it("is carried through the parser when present", async () => {
        const lock = await readInstallLock(await lockFileWith((claude) => { claude["vendorSignature"] = policy; }));
        deepStrictEqual(lock.claude.vendorSignature, policy);
    });
    it("is absent when the lock does not declare it: exact-hash stays the default", async () => {
        const lock = await readInstallLock(await lockFileWith((claude) => { delete claude["vendorSignature"]; }));
        strictEqual(lock.claude.vendorSignature, undefined);
    });
    it("the repository lock declares the policy for the measured signer", async () => {
        const lock = await readInstallLock(join(import.meta.dirname, "..", "..", "config", "install-lock.json"));
        deepStrictEqual(lock.claude.vendorSignature, policy);
    });
    for (const [name, broken] of [
        ["an unknown platform", { ...policy, platform: "plan9" }],
        ["an empty signer common name", { ...policy, signerCommonName: " " }],
        ["a missing organization", { platform: "win32", signerCommonName: "Anthropic, PBC" }],
        ["a non-object policy", "Anthropic, PBC"],
    ] as const) {
        it(`NEGATIVE: ${name} is a broken lock, not a silently ignored policy`, async () => {
            await rejects(readInstallLock(await lockFileWith((claude) => { claude["vendorSignature"] = broken; })), /vendor signature policy/u);
        });
    }
});

describe("annotateVendorUpdate: doctor names an accepted update instead of calling it a plain match", () => {
    const checks: readonly InstallCheck[] = [
        { component: "node", expectedVersion: "24.14.0", status: "ok", detailCode: "locked_version_match" },
        { component: "claude", expectedVersion: "2.1.325", status: "ok", detailCode: "locked_bytes_and_reported_version_match" },
        { component: "clodex", expectedVersion: "2.11.1", status: "ok", detailCode: "locked_bytes_and_reported_version_match" },
    ];
    it("relabels only the claude check, and only when the update was accepted", () => {
        const annotated = annotateVendorUpdate(checks, { status: "accepted", detailCode: "signed_vendor_update_accepted", pinnedVersion: "2.1.319", observedVersion: "2.1.325" });
        deepStrictEqual(annotated.map((check) => check.detailCode), ["locked_version_match", "signed_vendor_update_accepted", "locked_bytes_and_reported_version_match"]);
    });
    it("NEGATIVE: a pinned or refused decision changes nothing", () => {
        strictEqual(annotateVendorUpdate(checks, { status: "pinned", detailCode: "locked_hash_match", pinnedVersion: "2.1.325" }), checks);
        strictEqual(annotateVendorUpdate(checks, { status: "refused", detailCode: "vendor_update_signer_mismatch", pinnedVersion: "2.1.319" }), checks);
    });
    it("NEGATIVE: a claude check that failed anyway is never relabelled as accepted", () => {
        const drifted: readonly InstallCheck[] = [{ component: "claude", expectedVersion: "2.1.325", status: "drift", detailCode: "locked_reported_version_mismatch" }];
        deepStrictEqual(annotateVendorUpdate(drifted, { status: "accepted", detailCode: "signed_vendor_update_accepted", pinnedVersion: "2.1.319" }), drifted);
    });
});
