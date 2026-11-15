import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCaptured, spawnFailureGuard, type CapturedProcess, type ProcessOptions } from "./child-process.js";
import { expandLockedPath, sha256File, type InstallCheck, type InstallLock, type VendorSignaturePolicy } from "./install-lock.js";

// CASE RECORD (2026-11-15). The exact-hash pin on the Claude Code binary did its job nine
// times and broke the launch nine times: Claude Code updates itself, the bytes change, and
// claude-oauth refused to start until someone measured the new binary and cut a release
// (2.1.252, 2.1.270, 2.1.283, 2.1.284, 2.1.289, 2.1.302, 2.1.316, 2.1.319, 2.1.325). The
// owner asked for the pin to follow the update without a person in the loop.
//
// What replaces the person is the platform's own code-signing verdict, not "whatever is on
// disk". A binary that differs from the pinned bytes is accepted ONLY when all of these hold:
//   1. the lock carries a vendor-signature policy for this platform,
//   2. the binary reports a version that is not below the pinned one (no rollback to an old,
//      signed, possibly vulnerable build),
//   3. the platform says the signature is Valid (intact bytes, chain to a trusted root),
//   4. the signer's subject has exactly one CN and one O, each equal to the policy's value,
//   5. the bytes did not change while the verdict was being obtained.
// Any other outcome leaves the lock untouched, so the ordinary check reports the drift and
// the launch is refused exactly as before. Every other pinned component keeps its exact hash.
//
// The policy lives in config/install-lock.json, inside the hashed part of a release: it cannot
// be loosened without cutting a new release. The acceptance record lives in the runtime root,
// outside the release, because a release is never written at run time.

export interface SignatureReport {
    /** Authenticode status as the platform names it: Valid, NotSigned, HashMismatch, NotTrusted, ... */
    readonly status: string;
    /** The signer certificate's subject as a distinguished name; empty when there is no signer. */
    readonly subject: string;
    readonly thumbprint: string;
}
export type SignatureProbe = (executable: string, environment: NodeJS.ProcessEnv) => Promise<SignatureReport>;
export type VendorUpdateStatus = "pinned" | "accepted" | "refused" | "not_applicable";
export interface VendorUpdateDecision {
    readonly status: VendorUpdateStatus;
    readonly detailCode: string;
    readonly pinnedVersion: string;
    readonly observedVersion?: string;
    readonly observedSha256?: string;
    readonly signatureStatus?: string;
    readonly signerThumbprint?: string;
    readonly acceptedAt?: string;
    readonly cached?: boolean;
    readonly remedy?: string;
}
export interface ResolveClaudeVendorUpdateOptions {
    readonly lock: InstallLock;
    readonly moduleRoot: string;
    readonly cachePath: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly hashFile?: (path: string) => Promise<string>;
    readonly versionRunner?: (command: string, args: readonly string[], options: ProcessOptions) => Promise<CapturedProcess>;
    readonly signatureProbe?: SignatureProbe;
    readonly now?: () => Date;
}
export interface ResolvedClaudeVendorUpdate {
    readonly lock: InstallLock;
    readonly decision: VendorUpdateDecision;
}

const REFUSAL_REMEDY = "The Claude Code binary on disk is not the pinned one and could not be accepted automatically. Reinstall Claude Code from the vendor, or re-pin config/install-lock.json from a binary you have verified and cut a new release.";
const VERSION_PATTERN = /(?<![0-9.])(\d+)\.(\d+)\.(\d+)(?![0-9.])/u;

function parseVersion(text: string): readonly [number, number, number] | undefined {
    const match = VERSION_PATTERN.exec(text);
    if (match === null)
        return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function compareVersions(left: readonly [number, number, number], right: readonly [number, number, number]): number {
    for (let index = 0; index < 3; index += 1) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0)
            return difference;
    }
    return 0;
}

/**
 * Splits a distinguished name as Windows prints it (`CN="Anthropic, PBC", O=..., C=US`) into
 * its attributes. A quoted value may contain commas and equals signs; `""` inside quotes is a
 * literal quote; a backslash escapes the next character outside quotes. Returns undefined for
 * a string that does not parse, so a malformed subject can never satisfy a policy.
 */
export function parseDistinguishedName(subject: string): readonly (readonly [string, string])[] | undefined {
    const attributes: (readonly [string, string])[] = [];
    let index = 0;
    const length = subject.length;
    while (index < length) {
        while (index < length && (subject[index] === " " || subject[index] === ","))
            index += 1;
        if (index >= length)
            break;
        const equals = subject.indexOf("=", index);
        if (equals === -1)
            return undefined;
        const name = subject.slice(index, equals).trim();
        if (name === "" || /[",]/u.test(name))
            return undefined;
        index = equals + 1;
        while (index < length && subject[index] === " ")
            index += 1;
        let value = "";
        if (subject[index] === '"') {
            index += 1;
            let closed = false;
            while (index < length) {
                const character = subject[index] as string;
                if (character === '"') {
                    if (subject[index + 1] === '"') {
                        value += '"';
                        index += 2;
                        continue;
                    }
                    closed = true;
                    index += 1;
                    break;
                }
                value += character;
                index += 1;
            }
            if (!closed)
                return undefined;
            while (index < length && subject[index] === " ")
                index += 1;
            if (index < length && subject[index] !== ",")
                return undefined;
        }
        else {
            while (index < length && subject[index] !== ",") {
                const character = subject[index] as string;
                if (character === '"')
                    return undefined;
                if (character === "\\" && index + 1 < length) {
                    value += subject[index + 1] as string;
                    index += 2;
                    continue;
                }
                value += character;
                index += 1;
            }
            value = value.trim();
        }
        attributes.push([name.toUpperCase(), value]);
    }
    return attributes;
}
function signerMatchesPolicy(subject: string, policy: VendorSignaturePolicy): boolean {
    const attributes = parseDistinguishedName(subject);
    if (attributes === undefined)
        return false;
    const values = (name: string): readonly string[] => attributes.filter(([key]) => key === name).map(([, value]) => value);
    const commonNames = values("CN");
    const organizations = values("O");
    return commonNames.length === 1 && organizations.length === 1
        && commonNames[0] === policy.signerCommonName && organizations[0] === policy.signerOrganization;
}

// The probe asks Windows itself. The interpreter is addressed by its absolute path under the
// system root, never through PATH, and the target travels in an environment variable so no
// path is ever spliced into a command line. Only property reads are used (no .NET method
// calls), so the script also runs under Constrained Language Mode.
const AUTHENTICODE_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:CLAUDE_OAUTH_SIGNATURE_TARGET",
    "$subject = ''",
    "$thumbprint = ''",
    "if ($signature.SignerCertificate) { $subject = $signature.SignerCertificate.Subject; $thumbprint = $signature.SignerCertificate.Thumbprint }",
    "@{ status = \"$($signature.Status)\"; subject = \"$subject\"; thumbprint = \"$thumbprint\" } | ConvertTo-Json -Compress",
].join("; ");

export const authenticodeSignatureProbe: SignatureProbe = async (executable, environment) => {
    const systemRoot = environment["SystemRoot"] ?? environment["SYSTEMROOT"] ?? environment["windir"] ?? "C:\\Windows";
    const interpreter = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const encoded = Buffer.from(AUTHENTICODE_SCRIPT, "utf16le").toString("base64");
    const child = spawn(interpreter, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        env: { ...environment, CLAUDE_OAUTH_SIGNATURE_TARGET: executable },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    const spawnFailure = spawnFailureGuard(child);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
        const timer = setTimeout(() => {
            child.kill();
            rejectExit(new Error("signature probe timed out"));
        }, 60_000);
        child.once("error", (error) => {
            clearTimeout(timer);
            rejectExit(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            resolveExit(code ?? 1);
        });
    });
    const failure = spawnFailure();
    if (failure !== undefined)
        throw failure;
    if (exitCode !== 0)
        throw new Error(`signature probe exited with code ${exitCode}`);
    const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/u, "").trim();
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null)
        throw new Error("signature probe returned no report");
    const record = parsed as Record<string, unknown>;
    const field = (name: string): string => (typeof record[name] === "string" ? (record[name] as string) : "");
    if (field("status") === "")
        throw new Error("signature probe returned no status");
    return { status: field("status"), subject: field("subject"), thumbprint: field("thumbprint").toUpperCase() };
};

interface AcceptanceRecord {
    readonly executable: string;
    readonly sha256: string;
    readonly version: string;
    readonly signerCommonName: string;
    readonly signerOrganization: string;
    readonly signerThumbprint: string;
    readonly acceptedAt: string;
}
function isAcceptanceRecord(value: unknown): value is AcceptanceRecord {
    if (typeof value !== "object" || value === null)
        return false;
    const record = value as Record<string, unknown>;
    return ["executable", "sha256", "version", "signerCommonName", "signerOrganization", "signerThumbprint", "acceptedAt"]
        .every((key) => typeof record[key] === "string");
}
async function readAcceptance(cachePath: string): Promise<AcceptanceRecord | undefined> {
    try {
        const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"));
        if (typeof parsed !== "object" || parsed === null)
            return undefined;
        const record = (parsed as Record<string, unknown>)["accepted"];
        return isAcceptanceRecord(record) ? record : undefined;
    }
    catch {
        // A missing or unreadable record only costs one more signature probe.
        return undefined;
    }
}
async function writeAcceptance(cachePath: string, record: AcceptanceRecord): Promise<void> {
    try {
        await mkdir(dirname(cachePath), { recursive: true });
        const temporary = `${cachePath}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, accepted: record }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, cachePath);
    }
    catch {
        // The record is a convenience (it saves the next launch a signature probe), never a
        // dependency: an acceptance that cannot be recorded is still an acceptance.
    }
}

export async function resolveClaudeVendorUpdate(options: ResolveClaudeVendorUpdateOptions): Promise<ResolvedClaudeVendorUpdate> {
    const environment = options.environment ?? process.env;
    const platform = options.platform ?? process.platform;
    const hashFile = options.hashFile ?? sha256File;
    const versionRunner = options.versionRunner ?? runCaptured;
    const signatureProbe = options.signatureProbe ?? authenticodeSignatureProbe;
    const pinned = options.lock.claude;
    const unchanged = (status: VendorUpdateStatus, detailCode: string, extra: Partial<VendorUpdateDecision> = {}): ResolvedClaudeVendorUpdate => ({
        lock: options.lock,
        decision: {
            status,
            detailCode,
            pinnedVersion: pinned.version,
            ...extra,
            ...(status === "refused" ? { remedy: REFUSAL_REMEDY } : {}),
        },
    });
    let executable: string;
    let observedSha256: string;
    try {
        executable = expandLockedPath(pinned.executable, environment);
        observedSha256 = await hashFile(executable);
    }
    catch {
        // Absent or unreadable: the ordinary check names it (locked_binary_missing).
        return unchanged("not_applicable", "vendor_update_binary_unreadable");
    }
    if (observedSha256 === pinned.sha256)
        return unchanged("pinned", "locked_hash_match");
    const policy = pinned.vendorSignature;
    if (policy === undefined)
        return unchanged("not_applicable", "vendor_signature_policy_absent", { observedSha256 });
    if (policy.platform !== platform)
        return unchanged("not_applicable", "vendor_signature_policy_other_platform", { observedSha256 });
    const pinnedVersion = parseVersion(pinned.version);
    let observedVersionText: string | undefined;
    try {
        const probe = await versionRunner(executable, ["--version"], {
            cwd: options.moduleRoot,
            environment,
            timeoutMs: 30_000,
            maximumOutputBytes: 64 * 1024,
        });
        if (probe.exitCode === 0)
            observedVersionText = VERSION_PATTERN.exec(`${probe.stdout}\n${probe.stderr}`)?.[0];
    }
    catch {
        observedVersionText = undefined;
    }
    const observedVersion = observedVersionText === undefined ? undefined : parseVersion(observedVersionText);
    if (pinnedVersion === undefined || observedVersion === undefined || observedVersionText === undefined)
        return unchanged("refused", "vendor_update_version_probe_failed", { observedSha256 });
    if (compareVersions(observedVersion, pinnedVersion) < 0)
        return unchanged("refused", "vendor_update_version_below_pin", { observedSha256, observedVersion: observedVersionText });
    const accepted = (record: AcceptanceRecord, cached: boolean): ResolvedClaudeVendorUpdate => ({
        lock: { ...options.lock, claude: { ...pinned, version: record.version, sha256: record.sha256 } },
        decision: {
            status: "accepted",
            detailCode: "signed_vendor_update_accepted",
            pinnedVersion: pinned.version,
            observedVersion: record.version,
            observedSha256: record.sha256,
            signatureStatus: "Valid",
            signerThumbprint: record.signerThumbprint,
            acceptedAt: record.acceptedAt,
            cached,
        },
    });
    const remembered = await readAcceptance(options.cachePath);
    if (remembered !== undefined
        && remembered.sha256 === observedSha256
        && remembered.executable === executable
        && remembered.version === observedVersionText
        && remembered.signerCommonName === policy.signerCommonName
        && remembered.signerOrganization === policy.signerOrganization) {
        return accepted(remembered, true);
    }
    let report: SignatureReport;
    try {
        report = await signatureProbe(executable, environment);
    }
    catch {
        return unchanged("refused", "vendor_update_signature_probe_failed", { observedSha256, observedVersion: observedVersionText });
    }
    const verdictContext = { observedSha256, observedVersion: observedVersionText, signatureStatus: report.status };
    if (report.status !== "Valid")
        return unchanged("refused", "vendor_update_signature_not_valid", verdictContext);
    if (!signerMatchesPolicy(report.subject, policy))
        return unchanged("refused", "vendor_update_signer_mismatch", verdictContext);
    let confirmedSha256: string;
    try {
        confirmedSha256 = await hashFile(executable);
    }
    catch {
        return unchanged("refused", "vendor_update_binary_changed_during_verification", verdictContext);
    }
    if (confirmedSha256 !== observedSha256)
        return unchanged("refused", "vendor_update_binary_changed_during_verification", verdictContext);
    const record: AcceptanceRecord = {
        executable,
        sha256: observedSha256,
        version: observedVersionText,
        signerCommonName: policy.signerCommonName,
        signerOrganization: policy.signerOrganization,
        signerThumbprint: report.thumbprint,
        acceptedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    await writeAcceptance(options.cachePath, record);
    return accepted(record, false);
}

/**
 * The effective lock already carries the accepted bytes, so the ordinary check reports a
 * plain match. Doctor must still say that the match exists because an update was accepted,
 * not because the release pinned those bytes: a reader of the report has to be able to tell
 * the two apart.
 */
export function annotateVendorUpdate(checks: readonly InstallCheck[], decision: VendorUpdateDecision): readonly InstallCheck[] {
    if (decision.status !== "accepted")
        return checks;
    return checks.map((check) => (check.component === "claude" && check.status === "ok"
        ? { ...check, detailCode: decision.detailCode }
        : check));
}
