# Security

## Status: pre-release, with known open defects

This repository is a **pre-release**. It is published so that the design, the claims and the
open defects can be read and reproduced — not because it is ready to run on a machine you care
about. Two of the open defects are security-relevant on their own, and they are listed here
before anything else so that nobody finds them the hard way:

| Id | Severity | What is wrong | Where |
|---|---|---|---|
| **B01** | Critical | The parent Claude Code session's permission boundary is **not applied** to the Google and xAI subagents. The Google lane forces write/bypass flags on; the xAI lane accepts the first permission option and serves its own file-write handler. `executionMode: "agent-readonly"` therefore misdescribes the effective authority. A routed model can write to disk where the parent session would have asked. | `src/supervisor/provider-set.ts`, `src/antigravity/headless-bridge.ts`, `src/grok/acp-bridge.ts` |
| **N05** | High | The OpenAI capsule's own loopback port does **not enforce the transport nonce**. The nonce is sent by the router as a client header but is not configured on the child, and the pinned Clodex `--listen local --quick` mode accepts unauthenticated requests. Another process on the same machine could reach that port without going through the router. | `src/workers/clodex-capsule.ts` |

Related open items with a security dimension: **B04** (the workspace write check does not write
the file it checked — path race), **G02** (a non-empty `.mcp.json` in the project makes the xAI
lane refuse to start; fail-closed, but it is a denial of the lane), and the fact that **B05** — the
launcher shim that separates `claude` from `claude-oauth` is not in this tree — means the
native-separation claim cannot be verified from this repository yet. The full list is in the
README under *Known gaps*.

None of these are hidden, and none are considered acceptable for a release. Until B01 and N05
are closed, do not run this router on a machine or in a repository where an unexpected file write
or a locally reachable provider port would matter.

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
- whether you verified it by running something, or only by reading the source — both are
  welcome, but please say which.

## What not to include

**Report a leak by location and type, never by value.** Do not paste credentials, OAuth tokens,
refresh tokens, account identifiers, session nonces or machine-specific paths into an email,
an issue or a pull request — not even redacted ones, and not even "test" ones. A value is not
synthetic because it sits in a test environment. `file:line + kind` is enough for the
maintainer to find it.

The same rule binds the repository itself: `scripts/secret-scan.mjs` runs as part of
`npm run check`, and its `--ozdenetim` arm proves the scanner can actually fire before its clean
result is believed.

## Scope

In scope: everything under `src/`, `scripts/`, `config/` and `docs/` in this repository, and the
behaviour of the built `claude-oauth` command.

Out of scope: the provider CLIs this project drives (Antigravity `agy`, `grok`, `codex`) and the
Claude Code binary itself. Those are other vendors' software, run under your own account; report
issues in them to their vendors. If this project *misuses* one of them — passes a flag it should
not, trusts output it should not — that is in scope.

## Disclosure

Fixed issues are described in `CHANGELOG.md` with their id and the class of defect. Open issues
stay listed in the README until they are closed. There is no embargo period to negotiate: the
open defects are already public.
