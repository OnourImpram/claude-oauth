# Security

## Status: version 2.0.0, with three known open defects

Version 2.0.0 is ready to use on Windows. The design, the claims and the defects, open and
repaired, are published so that they can be read and reproduced. Security-relevant defects and
their repair status are listed here first; the README's Known gaps table is the complete ledger:

| Id | Severity | What is wrong | Where |
|---|---|---|---|
| **~~B01~~** | Repaired | **Repaired and measured 2026-09-08, Agent arm included.** The parent Claude Code session's permission boundary used to be skipped on the Google and xAI subagents. Google direct route: call-scoped settings now allow only the bridge MCP server and deny native `write_file`, `command`, `browser`, `execute_url` and `unsandboxed` actions; a live Claude Code Write denial leaves no file. xAI rejects native ACP writes and admits only identified bridge MCP permission requests. With `Write` disallowed on the parent, an `Agent` child session on the Google lane could not create the file. The full row is in the README. | `src/supervisor/provider-set.ts`, `src/antigravity/headless-bridge.ts`, `src/grok/acp-bridge.ts` |
| **N05** | Repaired | **Repaired 2026-09-08.** A repository-owned patched copy of pinned Clodex requires the session nonce, supplied only in the child environment, for every HTTP route including `/health`. Anonymous scratch-home measurements for missing/wrong/correct `x-api-key`: catalog and health **401/401/200**, malformed JSON messages **401/401/400**. Missing or empty nonce, missing/ambiguous patch anchors and patched-copy hash drift fail closed before startup. The original entrypoint hash gate remains strict; `clodex.capsuleEntrypointSha256` separately pins the patched bytes. | `src/workers/clodex-capsule.ts`, `src/runtime/clodex-capsule-entrypoint.ts`, `src/runtime/clodex-capsule-patch.ts` |
| **N08** | Low, open | **Open, found 2026-11-15 by code reading, not reproduced.** In the non-default `patched-shadow` mode the launcher replaces the Claude Code pin with the hash it measures on disk, so in that mode a binary the vendor-signature policy refuses can still be launched unpinned. The default `native-gateway` mode keeps the pin. | `src/runtime/claude-shadow.ts` |
| **N09** | Medium, open | **Open, audit finding D2-04 (2026-11-15): plausible, measured, not reproduced.** The Google lane's call-scoped configuration home hard-links the operator's Antigravity identity files. A hard link is the same file, so an in-place write by `agy` would change the operator's real file, and concurrent Google sessions share it. Measured with agy 1.5.9: the seven files were unchanged across five live probes and 20 routed requests; a token refresh was not observed. | README, Known gaps |

**~~B04~~: Repaired 2026-09-08 for the checked-file replacement race.** Existing files open
without truncation, reject final symlinks where `O_NOFOLLOW` is available, and compare the
opened file's identity and link count before writing through that same handle. Windows uses
the handle identity check. New files use exclusive creation. Deterministic Windows tests
replace a checked file with an outside symlink, redirect an existing parent via junction,
and insert a new-target symlink; each rejects without changing outside target contents.

**B04 residual scope, full ancestor confinement cannot be repaired from this tree within the
no-architecture-change constraint.** Portable Node filesystem calls do not provide the
platform-specific directory-handle operations needed to bind containment to the opened file.
Scratch-directory measurement confirms a repeated outside/inside/outside ancestor replacement across
`lstat`/`realpath`/`open` that can preserve the initial outside inode's identity. New-file
`mkdir` or `open` can also create an outside directory or empty file before later containment
validation rejects. Both broader schedules were reproduced on Windows after the narrow fix;
the helper must not be treated as a sandbox against arbitrary concurrent
ancestor changes. A source search in this run found no production caller of the helper.

**~~B05~~, repaired 2026-09-08.** Portable launchers now separate native invocation from router
startup and sanitize provider variables on the native entry, with executed shim tests and a
two-arm probe in this tree. The live negative arm returned exit 1 and named api.anthropic.com.
The clean Remote Control help arm passed as well: the usage text is printed and no refusal appears (the process stays alive after printing with Claude Code 2.1.257 and is terminated by the probe after a bounded grace period).
See the README's native-separation section for exact output and reproduction commands.

**~~G02~~, Repaired 2026-09-08 (diagnostic branch).** Grok 1.0.13 package documentation
lists project `.mcp.json` as a discovery source until a Claude import marker suppresses it.
The xAI refusal remains fail-closed and now names the file and the remedy. Root and nested
workspace tests measure this error; `.grok/hooks` and `.grok/plugins` stay refused. Live xAI
in repositories with non-empty `.mcp.json` is **NOT_RUN because discovery cannot be excluded**.

N05 is repaired. Three defects are open (N07, N08 and N09, all in the README's Known gaps table);
see the README for the
measured B01 native-path repair, the Agent inheritance arm measured live on 2026-09-08 (positive and negative arms), and the B07 repair that turns a headless permission denial into a terminal 403 instead of a retried 502.

## Reporting a vulnerability

Please report security issues by email to **onour@onourimpram.com** rather than in a public
issue, unless the issue is already listed above (in which case a public issue that adds
reproduction evidence is welcome).

This is a single-maintainer project. You will get an acknowledgement, and a fix or a stated
reason why not; there is no formal SLA and none is promised.

What a useful report contains:

- the affected file and line, and the commit you looked at;
- a concrete input or sequence that produces the effect;
- what you observed versus what you expected;
- whether you verified it by running something, or only by reading the source, both are
  welcome, but please say which.

## What not to include

**Report a leak by location and type, never by value.** Do not paste credentials, OAuth tokens,
refresh tokens, account identifiers, session nonces or machine-specific paths into an email,
an issue or a pull request, not even redacted ones, and not even "test" ones. A value is not
synthetic because it sits in a test environment. `file:line + kind` is enough for the
maintainer to find it.

The same rule binds the repository itself: `scripts/secret-scan.mjs` runs as part of
`npm run check`, and its `--ozdenetim` arm proves the scanner can actually fire before its clean
result is believed.

## Scope

In scope: everything under `src/`, `scripts/`, `shim/`, `config/` and `docs/` in this repository, and the
behaviour of the built `claude-oauth` command.

Out of scope: the software this project drives, Antigravity `agy` (Google), `grok` (xAI), the
third-party Clodex bridge (`@bman654/clodex`) that carries the OpenAI lane, and the Claude Code
binary itself. Those are other people's software, run under your own account; report issues in
them upstream. If this project *misuses* one of them, passes a flag it should not, trusts output
it should not, pins a version with a known defect, that is in scope.

The Claude Code pin can follow a vendor-signed update (`claude.vendorSignature` in
`config/install-lock.json`, decided in `src/runtime/claude-vendor-update.ts`). A way to make that
decision accept a binary the platform does not report as validly signed by the named signer, or
to accept a version below the pin, is in scope and is a high-severity report. The acceptance
record under the runtime root has the same trust level as the launcher script: whoever can
write there can already replace the launcher.

## Disclosure

Fixed issues are described in `CHANGELOG.md` with their id and the class of defect. Open issues
stay listed in the README until they are closed. There is no embargo period to negotiate: the
open defects are already public.
