# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Defect ids (B*, G*, N*, A*, S*) are the
repository's own and are stable across the README, `SECURITY.md` and this file.

## [Unreleased]

### Measured: the Gemini native-tool attribution in B11 did not hold (2026-09-13)

- B11's row said a native `read_file` outside the call-scoped allow list stopped the
  turn. Three probes ran real agy 1.1.27 in the routed configuration against a real MCP
  endpoint: a plain file read, a call to a tool named `mcp__playwright__browser_navigate`,
  and an instruction to avoid MCP and use a native file tool. All three succeeded through
  the MCP surface and the model never reached for a native tool.
- No allow-list entry was added. An unmeasured reason does not widen a permission surface.
- Whether a routed Gemini drives Playwright end to end in a live session stays NOT_RUN.

### Fixed: B12 tool results of another lane refused after a model switch (2026-09-10)

- Google and xAI registries are separate; after `/model` the previous lane's `tool_result` ids
  were refused as 409 "no live agent session", `/compact` included. A result set the registry
  never parked now runs as a fresh turn (`agent_tool_result_foreign`).

### Fixed: B11 permission denial shown as a login prompt (2026-09-10)

- The B07 denial travelled as 403, which Claude Code presents as "Please run /login". It is
  now 400: terminal, not retried, not an authentication failure.

### Fixed: B10 GPT models assumed at 200k by Claude Code (2026-09-10)

- Claude Code ignores discovery's `context_window` and keys the window on the `[1m]` suffix
  alone. The suffix now follows the advertised window: Astra is `[1m]` (1,000,000, compaction
  at the 650k `autoCompactWindow`); Sol, Terra and Grok deliberately stay at the 200k assumption.

### Fixed: B09 runtime capsule written inside the content-addressed release (2026-09-10)

- Reported by the operator: `claude-oauth` refused to start with
  `release_contents_do_not_match_release_id`. The OpenAI lane's patched Clodex capsule lived at
  `dist/clodex-capsules/session-*`; a session killed before `close()` left it behind, and `dist` is
  hashed into the release id, so the detector correctly refused an edited release. Capsules now
  live under `<release>/.runtime/clodex-capsules/`, below the module root and outside every hashed
  directory. Regression in `test/clodex-capsule-entrypoint.test.ts`.

### Fixed: B06 discovery input capacity (2026-09-08)

- **Repaired 2026-09-08.** Discovery separates the presentation `context_window` from
  `max_input_tokens`, using the lower of the advertisement and verified snapshot capacity
  for input. Astra retains its 1,000,000 presentation value and uses the unchanged 872,000
  install-lock pin for input: accepted capacity unproven, advertisement capped at the pin.
- Tests cover every routed contract, read the OpenAI pin from `config/install-lock.json`,
  and verify that a smaller snapshot capacity lowers the input advertisement. Live
  near-limit transport acceptance and output-budget probes were NOT_RUN; no pin changed.

### Fixed: B04 checked-file replacement race (2026-09-08)

- **Repaired 2026-09-08 for the checked-file replacement race.** Existing workspace files
  open without truncation, use `O_NOFOLLOW` where available, compare the opened handle's
  file identity and link count with the inspection, and truncate/write through that handle.
  New targets use exclusive creation and handle validation before writing content.
- Deterministic Windows tests replace a checked file with an outside symlink, redirect an
  existing parent through a junction, and insert a symlink before new-file creation. All
  reject and preserve outside contents. The overwrite control verifies shorter content
  removes the old tail.
- Full ancestor-directory confinement cannot be repaired within this tree's portable Node
  API and no-architecture-change scope. Repeated ancestor replacement can bypass path-based
  containment; new-file rejection can leave an outside empty file or directory. Both the
  outside overwrite and empty-file residue were reproduced in disposable Windows directories. The helper
  currently has no production caller. See `SECURITY.md` for this residual scope.

### Fixed: N06 bounded helper timeout (2026-09-08)

- **Repaired 2026-09-08.** `runCaptured` escalates SIGTERM to SIGKILL after
  `terminationGraceMs` (default 100 ms), rejects with `upstream_timeout` even without an
  `exit` event, and releases timeout pipes and the child process reference.
- Windows tests cover normal output, a SIGTERM-handler child, and a kill failure with no
  exit event. The handler test passes trivially on Windows because kill is terminal there.
  The meaningful Linux arm is NOT_RUN locally because this run uses a Windows host.
### Fixed: B08 compaction replay refused, bytes reported as tokens (2026-09-08)

- Found by a two-step bridged tool probe on the Google lane. Bytes were reported as `input_tokens`;
  Claude Code judged the turn too long, compacted, and its compaction request replayed the last
  delivered `tool_result`, refused as 409 ten times. Delivered ids are now remembered (bounded), a
  replayed result set runs as a fresh turn (`agent_tool_result_replayed`), the input bound is
  `ceil(bytes / 3)`, and each session retirement names its reason (`agent_session_retired`).

### Fixed: B07 headless permission denial returned as a retryable 502 (2026-09-08)

- Found on the Agent inheritance measurement: the Google model chose its native `read_file`, the
  call-scoped settings denied it, agy ended without an answer and the bridge answered 502; Claude Code
  retried ten times with backoff into the same policy. The denial is now 403 (terminal for the turn)
  and the bridged prompt states the tool policy once, naming the MCP server to use.
- B01 Agent arm measured live (positive arm: no file; negative arm: file written by the child), so the
  B01 row is closed. The child model is chosen by Claude Code, not the router.

### Fixed: N03 delegate tools and turn limits (2026-09-08)
- Google and xAI delegates omit tools and maxTurns and no longer carry a read-only prompt.
  OpenAI retains its built-in default tools plus Skill: its Clodex capsule does not connect to
  the router MCP session bridge, but ordinary HTTP tool exchanges can carry explicit MCP names.
- User definitions can widen, narrow or omit tool/turn limits. The launcher still rejects a
  changed or removed model identity. Generated JSON and acceptance rules are measured for every
  routed delegate in both client modes. Live Agent child-session execution remains NOT_RUN,
  requiring an authenticated harness.
### Fixed: B05 portable launchers and separation probe (2026-09-08)
- PowerShell and POSIX shims resolve the release and Node from environment or installation
  layout, read the release-id artifact, and route Remote Control directly to native Claude.
  Native entries sanitize provider variables before launch. Release verification now checks an
  artifact when present as well as the directory name and content.
- Executed shim tests measure environment separation, arguments, working directory and exit
  forwarding, including JSON, empty and long arguments, PowerShell pipelines and pipe EOF.
  Stream JSON uses raw OS pipes and is measured returning output before input closes. Remote
  Control words in prompt values remain on the router route. PowerShell batch targets are
  refused; select native executables. Probe controls cover missing Claude and failures of
  either expected arm.
- Windows live probe, both arms PASS: the positive arm prints the Remote Control usage text and
  is not refused (Claude Code 2.1.257 keeps the process alive after printing; the probe judges the
  text, terminates after a bounded grace period and records exited=false), the negative arm is
  refused with exit 1 naming api.anthropic.com. README contains the output and clone commands.

## [0.1.0], pre-release, unreleased

This is the first version made readable outside the maintainer's machine. It is **not a
usable release**: the open defects listed in the README under *Known gaps*, B01 (permission
boundary not applied to Google/xAI subagents), B02 (trailing system message dropped), G01
(Google lane not connected to the Claude Code tool
surface), N01 (image tool results reduced to empty strings) among them, are why. Subsequent
repair entries below record the defects that have since been closed.

What follows is the work of 2026-09-07, when the tree was reviewed by several independent
passes and repaired where a repair was narrow enough to carry its own regression test.

### Fixed: P01 install lock paths on POSIX (2026-09-08)

- `expandLockedPath` resolves the Windows variables the lock is written with to their POSIX
  equivalents (`HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`) and converts separators, so `doctor`
  runs on Linux and reports each component instead of aborting on the first path. Windows
  behaviour unchanged (negative arm in the test). The lock still pins only Windows binaries.
### Fixed: G08 MCP handshake evidence and SDK boundary (2026-09-08)
- `mcpHttpServer` and session MCP options now use SDK 1.4.0 types, replacing the unchecked `as never` boundary. A fake ACP peer asserts the exact transmitted name, URL and header array against the installed schema.
- Live Grok 1.0.13 produced `agent_tool_call_parked` at `2026-09-08T10:23:44.844Z`, caller PID `49944`, tool `cluster_a_handshake_receipt`. The router continuation completed with `end_turn` and zero unmatched results. The probe used the existing CLI session without logging in or reading identity files.
### Fixed: G02 project MCP refusal diagnosis (2026-09-08)
- The installed Grok 1.0.13 package documents project `.mcp.json` discovery independently of the Claude vendor compatibility switch. Retain refusal; the error names the file and a workspace/user-configuration remedy. Hooks and plugins stay fail-closed.
- Root/nested-workspace tests reproduce the former generic error. Live xAI in repositories containing non-empty `.mcp.json` is NOT_RUN because that configuration is intentionally refused.
### Fixed: G04 agent history conversion (2026-09-08)
- Thinking and redacted thinking are dropped; images and documents retain media-type and size placeholders; server and MCP tool-use blocks become tool-call summaries. Historical tool blocks are summarized on both session and text lanes.
- Per-type Google/xAI tests and mixed session history cover messages and count_tokens. Initial multi-text request framing and delegate tooling are outside this repair.
### Fixed: N04 continuation tool catalogue (2026-09-08)
- Each adapter request derives MCP tools. Resume updates changed descriptors before releasing any parked call; equal catalogues retain their descriptors. xAI permission matching reads the live bridge names.
- Tests measure additions, description/schema replacement, removal and unchanged catalogues. Removed tools cannot receive new calls, while parked results can finish. Provider-side cache refresh remains NOT_RUN; this change measures the bridge tools/list contract.
### Fixed: B03 continuation identity and instructions (2026-09-08)
- Result extraction and compilation use the same normalized conversation record. Trailing system records no longer start a second agent.
- Continuations pass compiler validation before any result is released. All accompanying user text and current system context travel in labelled MCP result text, alongside preserved images. Tests inspect the parked reply and assert a single agent start; this is transport evidence, not model-compliance evidence.
- Review follow-up: trailing blank text no longer rejects a valid tool result, and continuation usage bounds cover the full request body despite truncated history summaries. Both have separate reproduction and full-suite mutation controls.
### Fixed: N01 tool-result media (2026-09-08)
- Base64 screenshots survive the adapter, session registry and shared MCP response on xAI and Google. Unsupported blocks and compiled history retain deterministic type, media-type and size summaries. URL-source size is unknown.
- Review follow-up: native MCP image blocks retain their payload too, including uppercase MIME types; embedded resource summaries use the known MIME type and decoded blob or UTF-8 text size. Separate red/green and full-suite mutation controls cover both formats and MIME casing.
- Image metadata reaches the production log without payloads. Reproduction tests fail with the repair removed; live provider image interpretation is NOT_RUN because no vision task was submitted.

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
