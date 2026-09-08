# Security

## Status: pre-release, with known open defects

This repository is a **pre-release**. It is published so that the design, the claims and the
open defects can be read and reproduced, not because it is ready to run on a machine you care
about. Security-relevant defects and their repair status are listed here first:

| Id | Severity | What is wrong | Where |
|---|---|---|---|
| **B01** | Critical | The parent Claude Code session's permission boundary is **not applied** to the Google and xAI subagents. The Google lane forces write/bypass flags on; the xAI lane accepts the first permission option and serves its own file-write handler. `executionMode: "agent-readonly"` therefore misdescribes the effective authority. A routed model can write to disk where the parent session would have asked. | `src/supervisor/provider-set.ts`, `src/antigravity/headless-bridge.ts`, `src/grok/acp-bridge.ts` |
| **N05** | Repaired | **Repaired 2026-09-08.** A repository-owned patched copy of pinned Clodex requires the session nonce, supplied only in the child environment, for every HTTP route including `/health`. Anonymous scratch-home measurements for missing/wrong/correct `x-api-key`: catalog and health **401/401/200**, malformed JSON messages **401/401/400**. Missing or empty nonce, missing/ambiguous patch anchors and patched-copy hash drift fail closed before startup. The original entrypoint hash gate remains strict; `clodex.capsuleEntrypointSha256` separately pins the patched bytes. | `src/workers/clodex-capsule.ts`, `src/runtime/clodex-capsule-entrypoint.ts`, `src/runtime/clodex-capsule-patch.ts` |

Related open items with a security dimension: **B04** (the workspace write check does not write
the file it checked, path race), and the fact that **B05**, the
launcher shim that separates `claude` from `claude-oauth` is not in this tree, means the
native-separation claim cannot be verified from this repository yet. The full list is in the
README under *Known gaps*.

**~~G02~~, Repaired 2026-09-08 (diagnostic branch).** Grok 1.0.13 package documentation
lists project `.mcp.json` as a discovery source until a Claude import marker suppresses it.
The xAI refusal remains fail-closed and now names the file and the remedy. Root and nested
workspace tests measure this error; `.grok/hooks` and `.grok/plugins` stay refused. Live xAI
in repositories with non-empty `.mcp.json` is **NOT_RUN because discovery cannot be excluded**.

N05 is repaired. The remaining open defects still prevent a release; see the README for the
measured B01 native-path repair and the Agent inheritance check that remains NOT_RUN.

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

In scope: everything under `src/`, `scripts/`, `config/` and `docs/` in this repository, and the
behaviour of the built `claude-oauth` command.

Out of scope: the software this project drives, Antigravity `agy` (Google), `grok` (xAI), the
third-party Clodex bridge (`@bman654/clodex`) that carries the OpenAI lane, and the Claude Code
binary itself. Those are other people's software, run under your own account; report issues in
them upstream. If this project *misuses* one of them, passes a flag it should not, trusts output
it should not, pins a version with a known defect, that is in scope.

## Disclosure

Fixed issues are described in `CHANGELOG.md` with their id and the class of defect. Open issues
stay listed in the README until they are closed. There is no embargo period to negotiate: the
open defects are already public.
