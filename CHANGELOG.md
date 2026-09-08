# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Defect ids (B*, G*, N*, A*, S*) are the
repository's own and are stable across the README, `SECURITY.md` and this file.

## [Unreleased]

### Fixed: N06 bounded helper timeout (2026-09-08)

- **Repaired 2026-09-08.** `runCaptured` escalates SIGTERM to SIGKILL after
  `terminationGraceMs` (default 100 ms), rejects with `upstream_timeout` even without an
  `exit` event, and releases timeout pipes and the child process reference.
- Windows tests cover normal output, a SIGTERM-handler child, and a kill failure with no
  exit event. The handler test passes trivially on Windows because kill is terminal there.
  The meaningful Linux arm is NOT_RUN locally because this run uses a Windows host.

## [0.1.0], pre-release, unreleased

This is the first version made readable outside the maintainer's machine. It is **not a
usable release**: the open defects listed in the README under *Known gaps*, B01 (permission
boundary not applied to Google/xAI subagents), B02 (trailing system message dropped), B05
(launcher shim not in this tree), G01 (Google lane not connected to the Claude Code tool
surface), N01 (image tool results reduced to empty strings) among them, are why. Subsequent
repair entries below record the defects that have since been closed.

What follows is the work of 2026-09-07, when the tree was reviewed by several independent
passes and repaired where a repair was narrow enough to carry its own regression test.

### Fixed: N05 capsule listener authentication (2026-09-08)

- The OpenAI capsule runs a generated copy of pinned Clodex 2.11.1. The original dependency
  stays unchanged. Unique patch anchors and a separate `capsuleEntrypointSha256` lock gate
  reject drift before the child starts. Copies are removed at shutdown or startup failure.
- Local quick mode takes its password only from the child environment and refuses a missing
  or empty nonce. Health, startup polling and readiness use the same session authentication.
- Anonymous scratch-home tests measure missing/wrong/correct headers: catalog and health
  401/401/200; malformed JSON messages 401/401/400. No live provider credentials are used.
- `node scripts/test-n05-mutations.mjs` runs the full suite against removed authorization,
  empty-nonce and patched-hash guards, then restores source and lock bytes from memory.

### Fixed, diagnostics channel (Antigravity lane)

- The child process's own failure reason now survives into the thrown error on every failure
  path, not only the last two, parse errors, terminal-event errors, usage errors, timeouts,
  the output-size limit, spawn failures and runner exceptions all carry it. Previously an
  `agy` run that printed why it failed was reported as a bare protocol error.
- An `agy` run that exits 0 with an empty response is no longer reported as a success. It is
  named as a tool-permission denial only when the child's stderr says so; otherwise the
  generic code stays.
- Redaction before the diagnostic travels now covers: prefixed provider keys, AWS access key
  ids, JWT segments, `Bearer`/`Basic`/`Token` values (quoted or not), `key=`/`token=` URL
  parameters, multi-word quoted secret values, base64 with `/` and `+`, and non-ASCII runs.
  Redaction happens before truncation, so a trimmed tail cannot expose a prefix.
- The truncation limit is counted in UTF-8 bytes and cuts on a code-point boundary (no split
  surrogate); the message says how many bytes were dropped, and means it.
- The redaction no longer eats POSIX file paths (`/home/x/MyApp123/src/index.ts` kept its
  path), and an OS-level `permission denied` (EACCES) is no longer classified as an `agy`
  tool-permission denial with the wrong remedy.
- The remedy text names the flags the lane actually ran with (`--mode accept-edits` versus
  `--mode plan --sandbox`), instead of one fixed sentence.
- The remaining Turkish marker in an English error message (`ONARIM:`) became `FIX:`.

### Fixed, gates that could pass without being able to fail

- `scripts/lint.mjs`: a bare `// lint-izin:` with no reason, or the literal string
  `lint-izin:` inside the offending expression, no longer silences a finding; an exemption is
  a trailing comment with a reason of some substance. The unguarded-spawn rule no longer
  accepts the words `spawnFailureGuard` inside a comment as a guard; comments are blanked
  before file-level conditions run, string bodies are not (so `.once("error"` in a string
  still counts, deliberately, the first attempt blinded that detector and was caught).
- `scripts/secret-scan.mjs`: the inline-credential rule now matches the JSON shape
  `"refresh_token": "…"`, the most common on-disk shape, which it could not see before. The
  `install-lock.json` exemption is keyed on the **value** (sha256 hex or npm SRI), not on the
  file; a secret-shaped value in that file is now reported.
- `scripts/fidelity-diff.mjs`: a file present in the reference and missing from the build now
  fails the gate; an unreadable root is `NOT_RUN` (exit 3), not an empty tree that compares
  equal. The machine-specific default reference path is gone; the caller names it.
- `test/gate-negative-control.mjs`: a built module that exists but throws while loading is a
  failure (exit 1), not "build missing" (exit 3). The binaries it compares come from
  environment variables, never from a personal path.
- `test/workspace-write.test.ts`: a junction that cannot be created is a reported skip, not a
  test that returns early and passes with none of its assertions run.
- Every `--ozdenetim` self-check gained arms for the above, so the gate's own negative control
  covers what was fixed.

### Fixed, lifecycle, IPC and protocol contracts

- MCP session registry: a session whose start fails (bad base URL, header derivation, or
  `startAgent` throwing) is retired and its parked tool calls released, instead of leaking.
- MCP session registry: a request whose signal is already aborted is rejected before it can
  reclaim a live session or start an agent.
- Grok lane: a spawn failure is contained as `adapter_unavailable` (503) instead of crashing
  the router through an unhandled `error` event.
- Gemini lane: a cancelled request is stopped before configuration and before spawn; the
  session-level `cancel()` is honoured before the child exists.
- Supervisor IPC: accepted sockets are tracked and closed on shutdown, so an idle client
  cannot hang the launcher.
- Supervisor IPC: a catalog-drift diagnosis whose detail code exceeded the IPC reader's
  128-character cap made the whole status unreadable and the running session invisible to
  `doctor`. The producer and the consumer now agree on the contract (A01).
- Clodex adapter: the 32 KiB diagnostic bound is applied while reading a streamed error body,
  not after buffering all of it.
- Provider set: a Clodex capsule whose `catalog()` fails after a successful start is closed
  instead of orphaned.
- ACP file reads (Grok and Gemini lanes) honour the requested `line`/`limit` range after the
  workspace security check; previously the whole file was returned.

### Fixed, test suite portability

- `test/acp-read-lines.test.ts` built a `ChildProcess` it never spawned; the Gemini bridge's
  cleanup `kill()` on that handle reached `kill(2)` with an indeterminate pid on Linux and
  terminated the whole process group, so the suite could not run there at all. The fake no
  longer signals the OS. (Windows was unaffected: the same call fails with EBADF.)

### Changed

- The repository is English throughout, source, tests, scripts, comments, gate output. Two
  identifiers stay Turkish on purpose because tooling outside the tree reads them:
  `--ozdenetim` and `lint-izin:`.
- Review evidence and per-session task files are excluded via `.gitignore`, not a local
  `.git/info/exclude` that would differ between clones.

### Added

- `docs/index.html`: a single-file project page with no external requests, stating the
  claim, its measurement and its scope, and listing the open defects by id.
- `SECURITY.md`, `CONTRIBUTING.md`, this changelog, issue templates, and a CI workflow that
  runs `npm run check` plus both gate self-checks on Linux and Windows.

### Known open, see README *Known gaps*

B01, B02, B03, B04, B05, B06, G01, G02, G03, G04, G08, N01, N06. None are closed by this
version; several require an authority or capability contract decision before code.

[0.1.0]: https://github.com/OnourImpram/claude-oauth
