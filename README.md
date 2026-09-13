# claude-oauth

Run other models inside Claude Code over their own OAuth sessions, **without replacing the native
Claude path.** `claude` stays native. `claude-oauth` opens the router.

> **Status: pre-release. Not ready to use, and deliberately not pretending otherwise.**
> Several capability claims below are gated on open defects (see [Known gaps](#known-gaps)).
> This README documents what is measured, what is not, and what is broken.
> Project page: <https://onourimpram.github.io/claude-oauth/> · Security: [SECURITY.md](SECURITY.md) ·
> Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Changes: [CHANGELOG.md](CHANGELOG.md)

---

## Why this exists

Two goals. The mechanism is the same for both; the second is the one that shaped the code.

**1. Make Claude Code reachable for students and researchers.** Claude Code is an agent harness,
not a chat window: tools, subagents, skills, MCP servers and permission prompts in one loop.
Learning it is worth a student's time. Paying for it is often not possible. Many students and
researchers already hold a model plan of some kind: Google's student Gemini offer, a ChatGPT plan,
an xAI plan. `claude-oauth` lets those plans answer inside Claude Code, over the account's own
OAuth session, with no API key and no separate bill. The harness becomes learnable on the plan you
already have, and the native `claude` path stays exactly as installed for the day you move to it.

**2. Raise the quality of work done inside Claude Code by letting other models verify it.** A model
that wrote a change is the worst judge of that change. The working pattern behind this project is a
maker and a checker that are never the same model: one produces the diff, the manuscript, the
analysis; another, in a fresh context, reads the output and reports what is wrong with it. Claude
Code already has the mechanism, the `Agent` tool and subagents. What it lacks is a second model to
hand the work to. This repository supplies it: one delegate agent per routed model
(`gemini-delege`, `grok-delege`, `sol-delege`, `astra-delege`, `terra-delege`), and a `/model`
switch that puts a Google, xAI or OpenAI model in the driver's seat for a review pass while your
tools, permissions and MCP servers stay where they are.

This repository was built the way it asks to be used. The router was written and reviewed by
different models in turn, and the defect table below is what that loop produced: review passes by
models that had not written the code, followed by the author's measurement of each claim. The
Google native-write bypass (B01) was found by an OpenAI model after the author's own measurement
had passed it. The G01 repair was designed together with an OpenAI model, and the option the
measurement supported won over the one first proposed. The N05 repair was written by an OpenAI
model in a separate worktree, and the gate that accepted it was run by the reviewing side, not by
the model that wrote it. None of that guarantees correctness. It is the reason the defect list
exists at all.

### Who this is for

- **Students and researchers** with a provider plan and no API budget: learn the harness on the
  plan you have. Subject to each provider's own terms; the student offers are the providers' to give
  and to withdraw.
- **Developers** who want a second model in the same harness: switch models mid-workflow, run
  several in parallel, hand a review to a model that did not write the code.
- **Not for** anyone looking to route around Anthropic. The native path is untouched and remains
  the recommended one; nothing here proxies, wraps or intercepts Anthropic's own endpoint. The
  intent is to grow the harness's adoption: someone who learns Claude Code on a free tier and later
  wants the native models has a reason to pay for them.

### How verification works here

The pattern needs two things: a second model inside the harness, and the discipline that the
producer never signs off on its own work. This repository provides the first. The second is a
habit, and making that habit cheap is the point of the project:

1. A Claude model, or you, produces the change.
2. Hand the output (the diff, the test log, the draft) to a delegate agent of a different vendor,
   or switch `/model` to that vendor and ask for a review with the same tools the producer had.
3. Treat the checker's answer as a worker's evidence, not as truth: run the test it points at, open
   the file it names.
4. Where the two disagree, the disagreement is the finding.

Generated Google and xAI delegates now inherit the parent's available tools without a launcher
turn cap (N03 repaired). OpenAI delegates use the built-in tools plus `Skill` by default and
accept user definitions containing MCP names. The generated JSON and override rules are tested.
Permission inheritance through an `Agent` child session was measured live on the Google lane on
2026-09-08 (B01 row below): the child takes the parent's permission set, and the routed parent
reached Claude Code's `Agent` tool through the bridge. The child's tool loop on a routed model is
what the same measurement exercised when Claude Code picked the routed Gemini as the child model.

The method behind this habit has its own project. [autofusion](https://github.com/OnourImpram/autofusion)
freezes the artifact, sends it to reviewers that cannot see each other, grounds checkable findings
with the verification commands the repository already trusts, and writes a metadata-only receipt
that keeps unresolved disagreement visible. autofusion provides the method; this repository
provides the plumbing, the models reachable through the sessions you already hold. If you work
intensely with AI, the recommendation from both projects is the same: keep one model for routine
work, and run fusion on the decisions that matter, where a missed issue is costly or hard to
reverse. Site: <https://onourimpram.github.io/autofusion/>.

### The harness surface, not a chat box

Claude Code's value is in the loop: tools, subagents, skills, MCP servers, permission prompts. A
model router that only forwards text turns that harness into a chat box. The goal here is the
opposite: **every model reachable through the router should be able to use the same Claude Code
surface**, the `Agent` tool, skills, MCP servers such as Playwright, file editing under the same
permission rules. Since 2026-09-08 the Google lane reaches that surface for real (G01 below, with a
live receipt). The native permission paths in Google and xAI are constrained, and permission
inheritance through a separate `Agent` child session was measured live the same day (B01 below).

## How it sits inside Claude Code

`claude-oauth` starts a **real Claude Code process**, the same binary you already have, and
points that process's upstream endpoint at a loopback router it runs alongside. Claude Code keeps
its own tools, permission prompts, skills and MCP configuration; only the model behind the
`/v1/messages` call changes. When the selected model is a Claude model, the router forwards to
Anthropic unchanged. When it is one of the lanes below, the router drives that lane and translates
its answer back into the message shape Claude Code expects.

```
claude        ─────────────────────────────────▶  api.anthropic.com        (native, untouched)

claude-oauth  ─▶  Claude Code process  ─▶  loopback router  ─┬─▶  Antigravity `agy`   Google OAuth
                  (your tools, your          (this repo)     ├─▶  `grok`              xAI OAuth
                   permissions, your MCP)                    └─▶  Clodex capsule      ChatGPT/Codex OAuth
```

| Lane | What actually runs | Whose software | Pinned in `config/install-lock.json` |
|---|---|---|---|
| Google | Antigravity CLI `agy`, headless, one process per call | Google | `antigravity.version` |
| xAI | `grok` over ACP (Agent Client Protocol), long-lived sessions, at most four live at once, so a tool loop can cross Claude Code's per-turn HTTP requests | xAI | `grok.version` |
| OpenAI | **Clodex** (`@bman654/clodex`), a third-party bridge, run as a local capsule with the `openai-oauth` provider | [bman654/clodex](https://github.com/bman654/clodex), MIT-licensed npm package, with repository-owned shadow and capsule patches | `clodex.version`, `clodex.localPatchSha256`, `clodex.capsuleEntrypointSha256` |

Each lane authenticates as **you**, on your own plan: the Google and xAI lanes run those vendors'
own CLIs; the OpenAI lane does **not** run OpenAI's `codex` CLI, it runs Clodex, which speaks to
OpenAI over your ChatGPT/Codex-plan OAuth session. Earlier drafts of this project described all
three lanes as "the provider's own official CLI"; that was wrong for OpenAI and is corrected here.

### Selecting a model, including mid-session

- **At launch:** `claude-oauth --model grok` (or `gemini`, `gemini-pro`, `opus-google`, `sol`,
  `terra`, `astra`). Any other argument is passed to Claude Code as-is.
- **Mid-session:** Claude Code's own `/model` command. Routed models appear in the picker after
  `claude-oauth models refresh` has written them into the model snapshot; until then the picker
  shows only Claude models.
- **As a subagent:** inside a `claude-oauth` session the launcher registers one delegate agent per
  routed model (`gemini-delege`, `grok-delege`, `sol-delege`, …) so a Claude model can hand a task
  to another model through the `Agent` tool. Google and xAI omit `tools` and `maxTurns`, so Claude
  Code inherits the available parent tools, including MCP and `Skill`, without a launcher cap.
  OpenAI defaults to `Read`, `Write`, `Edit`, `Grep`, `Glob`, `PowerShell` and `Skill`, with no turn
  cap. A user `--agents` definition may widen or narrow either setting, including adding MCP
  names or omitting `tools` to inherit. Reserved delegates must keep their model identity.

| Delegate lane | Tool reach |
|---|---|
| Google and xAI | Inherit available parent tools. Their provider sessions use the router MCP bridge to return tool calls to Claude Code. Permission inheritance through an Agent child session was measured live on 2026-09-08 (B01 row). |
| OpenAI | Clodex carries ordinary HTTP `tool_use`/`tool_result` exchanges; its capsule receives no router MCP endpoint and cannot attach to that session bridge. The default list above reaches built-ins and `Skill`. Explicit MCP names in a user definition can travel as ordinary Claude Code tools, subject to the parent catalogue and permissions; they are not included in the default list. Live OpenAI delegate MCP execution: NOT_RUN, requires an authenticated Agent child-session harness. |

Switching back to a Claude model in the same session is the same `/model` command. There is no
mode to remember: the native `claude` command never enters any of this.

## What it does not do

- It does **not** modify, patch, or proxy the native Claude path. `claude` talks to
  `api.anthropic.com` as it did before installation, that is the claim measured below.
- It does **not** bypass any provider's authentication. Each lane uses your own account's OAuth
  session, through the vendor's CLI for Google and xAI, through Clodex for OpenAI.
- It does **not** grant entitlements. If a provider's plan does not include a model, the router
  cannot conjure it. Quota exhaustion surfaces as quota exhaustion.

## The native-separation claim

The distinguishing claim of this project is that installing it does not degrade native Claude Code.
That is a claim, so it gets a measurement rather than a paragraph.

The repository ships [portable launchers](shim/) and
[a two-arm probe](scripts/native-separation-probe.mjs). From a clone with Node and Claude Code on
PATH, run this without starting a router or installing the shim:

```sh
node scripts/native-separation-probe.mjs
```

The positive arm removes provider routing variables, including `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_CUSTOM_HEADERS`, then runs `claude remote-control --help`.
The negative arm runs the same command with `ANTHROPIC_BASE_URL=http://127.0.0.1:9` and requires
a non-zero exit plus a message naming `api.anthropic.com`. On Windows the probe prefers
`claude.exe` on PATH over a sanitizing command wrapper, which would erase the negative arm.
It prints measurements without copying raw CLI output or configuration. Exit codes: 0 means
both expected outcomes were measured, 1 means an outcome differed, 2 means Claude was absent
from PATH, and 3 means an arm could not finish or start.

Measured on Windows, 2026-09-08:

```text
command: claude.exe remote-control --help (resolved on PATH; native executable preferred)
positive: PASS exit=none exited=false usage=printed api.anthropic.com=absent
positive: stdout_bytes=2860 stderr_bytes=0
negative: PASS exit=1 exited=true usage=absent api.anthropic.com=named
negative: stdout_bytes=0 stderr_bytes=258
```

Both arms measured in about five seconds. The positive arm prints the Remote Control usage text and
is not refused; with Claude Code 2.1.257 the process stays alive after printing (measured from Node,
PowerShell and a file-backed stdout alike), so the probe judges the arm on the printed text and the
absence of a refusal, terminates the process after a bounded grace period, and records `exited=false`
instead of a timeout. The negative arm used a synthetic loopback URL and was refused with exit 1 naming
`api.anthropic.com`. Neither arm establishes native process ancestry or a live router session's
behavior. Stub tests execute the PowerShell and POSIX shims, check environment separation, argument
forwarding and exit status, and exercise a native launch with no router release. Probe controls detect
both an always-accepting and an always-rejecting CLI.

### Using the shipped shims

`shim/claude-oauth.ps1` forwards to `shim/claude-oauth-launcher.ps1`; `shim/claude-oauth.sh` is the
POSIX entry. Both start the installed router CLI. Remote Control requests (`remote-control`,
`--remote-control`, `--rc`) and `--hezarfen-entrypoint=claude` take the native path before resolving
the router release or Node. PowerShell also ships `shim/claude-launcher.ps1` as a direct native
entry. Native launches clear provider credentials, routing and model overrides, and router
metadata. The PowerShell scripts restore the caller's environment after the child exits.

Set `CLAUDE_OAUTH_RELEASE_ROOT` to an installed release, or keep `shim/` inside that release.
When copied into an installation's bin directory, the fallback layout is
`<shim-directory>/.claude-oauth-runtime/current`. The release must contain `dist/src/cli.js`,
`config/`, and a one-line `release-id` artifact holding the content identity produced by
`node scripts/release-id.mjs --compute <release-directory>`. The shim reads that file, never a
literal release id. The CLI verifies it against the installed content. To check directory name,
content and artifact together, run `node scripts/release-id.mjs --verify <release-directory>`.
Legacy releases without the artifact remain verifiable but cannot use these shims until an
installer supplies it.

`CLAUDE_OAUTH_NODE` selects Node; otherwise PowerShell tries `<release>/node.exe`, POSIX tries
`<release>/node/bin/node`, then each uses Node on PATH. `CLAUDE_OAUTH_NATIVE_BINARY` selects the
native Claude binary; otherwise it is resolved on PATH. These scripts preserve the caller's
working directory and do not include the maintainer's plugin filtering or personal model-pin
helper. PowerShell invokes executables with explicit Windows argument quoting to preserve
`--agents` JSON, embedded quotes and empty arguments. A PowerShell child receives the argument
array through a temporary process environment variable, cleared before the target starts, so
PowerShell input pipelines and output capture remain available. `--input-format stream-json`
uses raw OS pipes, with output measured before stdin closes. Relative executable overrides
resolve against the caller's working directory. Windows `.cmd` and `.bat` targets are refused;
select the native executable instead. For example, after configuring the release location:

```powershell
./shim/claude-oauth.ps1 --model gemini
./shim/claude-launcher.ps1 remote-control --help
```

```sh
sh shim/claude-oauth.sh --model gemini
sh shim/claude-oauth.sh --hezarfen-entrypoint=claude remote-control --help
```

## Known gaps

These are open defects, found by review and independent measurement. They are listed because a
pre-release README that hides them is worthless. Ids are stable across this file,
`SECURITY.md`, `CHANGELOG.md` and the project page. Repair status is marked in the rows below and recorded in the changelog.

| Id | Severity | What is wrong |
|---|---|---|
| ~~B01~~ | ~~High~~ | **Repaired and measured 2026-09-08, Agent arm included.** Google direct route: call-scoped settings allow only the bridge MCP server and deny native `write_file`, `command`, `browser`, `execute_url` and `unsandboxed` actions; a live Claude Code Write denial leaves no file and a native `write_to_file` attempt is denied too. xAI rejects native ACP writes and admits only identified bridge MCP permission requests. **`Agent` child sessions, measured live on the Google lane:** the routed parent reached Claude Code's `Agent` tool through the bridge (router park events `Agent`, `ListAgents`); with `Write` disallowed on the parent the child could not create the file (positive arm, no file), with `Write` allowed the child wrote it (negative arm, file present with the exact content). Inheritance is Claude Code's own mechanism: the child takes the parent's permission set, and every router call to the Google lane gets its own call-scoped denial settings regardless of which session made it. Claude Code chooses the child model itself (haiku in one arm, the routed Gemini in the other); the router does not set it. Receipt: the streams and router.log lines are in the maintainer's measurement notes. |
| ~~B02~~ | ~~High~~ | **Repaired 2026-09-07 (`b5caf0e`).** A `role:"system"` message arriving after the last user message was dropped silently while compiling the request, measured loss ~77.5k characters: the skill catalogue, the agent catalogue, MCP server instructions, the output style. It now travels in its own `SESSION CAPABILITY CONTEXT` section. Six test arms, mutation-verified. The end-to-end claim is NOT made here: G01 still keeps the Google lane off the tool surface. |
| ~~B03~~ | ~~High~~ | **Repaired 2026-09-08.** Compilation and result extraction share the last logical conversation record, so trailing system records retain the live session. Every continuation is validated and its system context plus all accompanying user text travels in labelled MCP result text before the agent resumes. Tests measure one start, the instruction received, mixed images, trailing blank text, and a usage bound covering the full request body. This preserves transport, not a guarantee of model compliance. |
| ~~B04~~ | High, residual scope | **Repaired 2026-09-08 for the checked-file replacement race.** Writes use a non-truncating open, validate the handle identity, and write through that handle; new files use exclusive creation, with deterministic Windows symlink/junction tests proving outside target contents stay unchanged. Arbitrary ancestor replacement remains a limitation requiring platform-specific filesystem support; see `SECURITY.md`. |
| ~~B05~~ | ~~High~~ | **Repaired 2026-09-08.** Portable PowerShell/POSIX shims and a reproducible two-arm probe ship in this tree; stub tests measure native environment cleanup and router entry selection. Live probe: both arms PASS on Windows, 2026-09-08, output recorded above. |
| ~~B06~~ | ~~High~~ | **Repaired 2026-09-08.** `max_input_tokens` uses the lower of the advertised window and snapshot transport capacity, tested for every routed model against its pin; Astra's `context_window` remains a presentation value of 1,000,000 while input is capped at the unchanged 872,000 pin: accepted capacity unproven, advertisement capped at the pin. |
| ~~B07~~ | ~~High~~ | **Found and repaired 2026-09-08 (Agent arm).** When the Google model chose one of its own native tools (`read_file`) instead of the bridged Claude Code tools, the call-scoped settings denied it, agy ended without an answer, and the bridge returned the denial as HTTP 502; Claude Code treated 502 as transient and retried ten times with exponential backoff, every retry meeting the same policy. The denial now travels as 403 (terminal for the turn, not retried) and the bridged prompt carries one policy sentence telling the model that its native file, shell and browser tools are disabled here and naming the MCP server to use. Tests: `test/headless-bridge-denial-status.test.ts`, `test/headless-bridge-policy-note.test.ts`; mutation control over the whole suite fails one test per reverted change. Whether the model now picks the bridged tools more often is a model behaviour, not something this repair proves. |
| ~~B08~~ | ~~High~~ | **Found and repaired 2026-09-08 (two-step bridged tool probe on the Google lane).** The router reported request bytes as `input_tokens`; Claude Code read a 320 kB second turn as 320k tokens against the 200k window it assumes for a model id without the `[1m]` suffix, started an automatic compaction, and the compaction request replayed the just-delivered `tool_result`, which the registry refused as "no live agent session" (409) ten times with backoff until the turn failed. Repair: the registry remembers delivered ids (bounded, past retirement) and the adapter runs an all-delivered result set as a fresh turn, logging `agent_tool_result_replayed`; the reported input bound is now `ceil(bytes / 3)`, an estimate and labelled as one; every session retirement logs its reason (`agent_session_retired`). Test: `test/mcp-replayed-result.test.ts`; mutation control over the whole suite fails it and the usage-bound test. Pick the `[1m]` model id in the picker for the full Gemini window. |
| ~~B09~~ | ~~High~~ | **Found and repaired 2026-09-10 (operator report: `claude-oauth` refused to start).** The OpenAI lane wrote its patched Clodex capsule to `dist/clodex-capsules/session-*` inside the pinned release, and `dist` is one of the two directories the content-addressed release id hashes. A session that ended without `close()` (a killed process on 2026-09-08 14:43) left the capsule behind, the release no longer hashed to its own id, and the next start refused it with `release_contents_do_not_match_release_id`. The refusal was correct: the detector fired on a real edit-in-place. The defect was where runtime state lived. Repair: capsules are written under `<release>/.runtime/clodex-capsules/`, still below the module root so bare ESM imports resolve against the release's own dependencies, and outside every hashed directory; `.runtime/` is ignored by git and excluded when a release is cut. Test: `test/clodex-capsule-entrypoint.test.ts` asserts the capsule path is under `.runtime` and never under `dist` or `config`; mutation control over the whole suite fails it. A fresh release was cut and pinned; the drifted release directory was left untouched as evidence. |
| ~~B10~~ | ~~High~~ | **Found and repaired 2026-09-10 (operator report: every GPT model showed a 200k window).** Claude Code does not read the `context_window` that discovery advertises; it assumes 200k for any model id without the `[1m]` suffix (measured under B08). The router attached the suffix only when the SNAPSHOT window equalled the contract ceiling, so Astra's advertised 1,000,000 never reached the client and Astra ran at 200k with compaction far too early. Repair: the suffix follows the ADVERTISED window; Astra is `anthropic-openai-gpt-6-astra[1m]` and takes the 650k `autoCompactWindow` from settings, the same as Opus. Sol and Terra advertise their 872,000 snapshot and stay at the 200k assumption on purpose: it keeps them under the 272K input pricing boundary. Grok advertises 500,000 and also stays at 200k because Claude Code has only the two assumptions; a `[1m]` id would overflow at 500k before the 650k compaction. Test: `test/contract-derivation.test.ts` (positive arm Astra, negative arm Sol); mutation control over the whole suite fails it. |
| ~~B11~~ | ~~Medium~~ | **Found and repaired 2026-09-10 (operator report: Gemini answered with "Please run /login").** B07 returned a headless permission denial as 403; Claude Code reads 401 and 403 as an authentication failure and prompted for login on a lane whose OAuth session was fine. Repair: a denial is 400, terminal, shown as an API error, not retried, never mistaken for an expired login. Test: `test/headless-bridge-denial-status.test.ts`; mutation control over the whole suite fails it. The denial the operator saw was attributed to a native `read_file` outside the allow list of the call-scoped agy settings. That attribution was tested on 2026-09-13 against the repaired release and did not hold. Three probes ran real agy 1.1.27 in exactly the routed configuration, against a real MCP endpoint: a plain file read, a call to a tool named `mcp__playwright__browser_navigate`, and an instruction to avoid MCP and use a native file tool. All three succeeded through the MCP surface; the model never reached for a native tool. No allow-list entry was added, because none was shown to be needed. Whether a routed Gemini can drive Playwright end to end in a live session is still `NOT_RUN`. |
| ~~B12~~ | ~~High~~ | **Found and repaired 2026-09-10 (operator report: after `/model` to Grok, `/compact` and every turn failed).** The Google and xAI lanes hold separate session registries. After a switch, the conversation still carried the previous lane's `tool_result` blocks; the new lane's registry had never minted those ids and refused the turn as "no live agent session" (409), 44 times in one session. Claude Code cannot strip `tool_result` blocks from its own history, so the refusal was a dead end. Repair: a result set the registry never parked is neither a continuation nor an orphan; it runs as a fresh turn over the compiled history and logs `agent_tool_result_foreign`. Only ids of a live session continue that session. Test: `test/mcp-foreign-result.test.ts`; mutation control over the whole suite fails it. |
| ~~G01~~ | ~~High~~ | **Repaired 2026-09-08.** The Google lane now carries the same tool loop the xAI lane has. The objection that kept it away was that `agy mcp add` writes the session nonce into the operator's persistent config; the lane instead runs inside a **call-scoped configuration home** (`USERPROFILE` redirected, identity files hard-linked, never copied), so the operator's own `mcp_config.json` is never opened for writing. Live receipt: the router logged `agent_tool_call_parked`, Claude Code executed the MCP tool 213 ms later, one `tool_use` block crossed the stream, and the model returned a string it could not otherwise know. NOT claimed: a multi-step loop, or the `Agent` sub-loop. |
| ~~G02~~ | ~~High~~ | **Repaired 2026-09-08, diagnostic branch.** Installed Grok 1.0.13 documentation (`docs/user-guide/07-mcp-servers.md`, Compatibility) says project `.mcp.json` is loaded unless the Claude import marker suppresses it. Refusal is retained and now names `.mcp.json` plus a workspace/user-configuration remedy; root and nested-workspace tests measure it, with hooks/plugins still fail-closed. Live xAI in repositories with non-empty `.mcp.json`: **NOT_RUN, intentionally refused because Grok can discover this file**. |
| ~~G03~~ | ~~High~~ | **Repaired 2026-09-08.** A session parked on a tool call set `running = false` and so looked idle; at the cap the oldest such session was cancelled mid-loop and the returning `tool_result` found no session. A first repair used a 60 s age window; an independent wall-clock measurement then showed a legitimate 61 s permission wait being sacrificed, so age was dropped as the discriminator. Now a parked session is never evicted for capacity: at the cap the request receives an explicit 503. The cost is stated in the source: an abandoned parked session holds capacity until the idle timeout or the provider's own timeout. Both registries also close and wait on shutdown (previously only the xAI one did; four Google processes and homes were measured surviving `close()`). |
| ~~G04~~ | ~~High~~ | **Repaired 2026-09-08.** Agent history drops `thinking` and `redacted_thinking`, summarizes `image` and `document` with media type and size, and renders `server_tool_use` and `mcp_tool_use` like tool calls. Per-type Google/xAI tests and a session-lane fixture cover messages and token counting without 422. Media history remains a placeholder; initial multi-text request framing and delegate tooling are outside this repair. |
| ~~G08~~ | ~~Suspected~~ | **Repaired 2026-09-08.** The SDK-typed HTTP definition and a fake ACP peer verify exact name, URL and `{name,value}[]` headers. Live Grok 1.0.13 reached the router bridge: `agent_tool_call_parked` at `2026-09-08T10:23:44.844Z`, caller PID `49944`, tool `cluster_a_handshake_receipt`; the reply completed with `end_turn` and zero unmatched results. Header removal is exercised as a full-suite mutation control. |
| ~~N01~~ | ~~High~~ | **Repaired 2026-09-08.** Anthropic and native MCP base64 image tool results cross the shared bridge on both xAI/ACP and Google/Antigravity lanes; text compilation and unsupported/URL media use type, media-type and byte-size placeholders (URL size is unknown). Embedded resources retain known MIME type and payload size. Adapter-to-MCP tests preserve image bytes, MIME casing and error status; the production-log fixture measures payload-free image metadata. Live provider image interpretation is NOT_RUN, no vision task was submitted. |
| ~~N03~~ | ~~High~~ | **Repaired 2026-09-08.** Google/xAI inherit tools without a launcher turn cap; OpenAI defaults include `Skill` and user definitions may add MCP names. Generated JSON and wider/narrower overrides are tested in both client modes; changed or removed model identities still receive 400. Live Agent tool loops remain NOT_RUN, requiring an authenticated child-session harness. |
| ~~N04~~ | ~~High~~ | **Repaired 2026-09-08.** Every request derives its catalogue and replaces changed bridge descriptors before releasing parked results; the xAI permission lookup reads the live names. Tests cover ToolSearch adding `mcp__playwright__browser_snapshot`, schema changes, removal, and unchanged descriptors. Already parked removed-tool calls can finish; subsequent calls are refused. Provider-side catalogue cache refresh is NOT_RUN, the offline measurement covers `tools/list`. |
| ~~N05~~ | ~~High~~ | **Repaired 2026-09-08.** The capsule runs a hash-pinned patched copy of Clodex and receives its session nonce only through the child environment. Measured with an anonymous scratch home, missing/wrong/correct `x-api-key`: catalog and health **401/401/200**, malformed JSON messages **401/401/400**. Empty nonce, missing patch anchors and patched hash drift prevent startup. |
| ~~N06~~ | ~~Medium~~ | **Repaired 2026-09-08.** Captured helpers receive SIGTERM, then SIGKILL after configurable `terminationGraceMs` (default 100 ms), and reject with a timeout even without `exit`; Windows tests cover the deadline and missing-exit case, while the meaningful SIGTERM-resistant Linux arm is NOT_RUN locally (Windows host). |
| ~~P01~~ | ~~High~~ | **Repaired 2026-09-08.** Found while measuring N05 on Linux: the install lock is written with Windows variables (`%USERPROFILE%`, `%LOCALAPPDATA%`, `%APPDATA%`), and on POSIX `doctor` died in path expansion before reporting a single component. On POSIX those variables now resolve to `HOME`, `XDG_DATA_HOME` (else `~/.local/share`) and `XDG_CONFIG_HOME` (else `~/.config`), backslashes become separators, and a binary that is not there is reported as missing instead of aborting the diagnosis. Measured: WSL2 `doctor` lists components; unit arms in `test/install-lock-posix-paths.test.ts`, mutation control fails 3 tests. Linux binaries are still not pinned by the lock, so on Linux `doctor` reports them missing until a POSIX lock exists. |

B01's measured Google native-write bypass is closed. The live check covers direct routing with
`gemini-3.8-flash-high` on Windows; it does not establish permission inheritance through `Agent`
child sessions or live enforcement of every denied action category.

In model discovery, `context_window` is the model's advertised presentation window.
`max_input_tokens` is the protocol input capacity and never uses a presentation override to
exceed the verified snapshot value. OpenAI refresh accepts a snapshot capacity only when it
matches `config/install-lock.json`. The pin is a conservative transport bound, not proof of
live acceptance; near-limit input and output-budget probes were NOT_RUN in this local run.

## Requirements

- **Node.js 24.** `package.json` declares `>=24.0.0`; the runtime gate for the *installed* router
  pins the exact version in `config/install-lock.json` and refuses any other. Building and testing
  this tree needs only the range; running the installed router needs the pin. That inconsistency
  is documented, not resolved.
- The provider CLIs, authenticated under your own accounts, at the paths and versions pinned in
  `config/install-lock.json`. Those paths are Windows paths (`%LOCALAPPDATA%`, `%USERPROFILE%`).
- **Platforms.** The test suite runs on Windows and Linux (both in CI). The router itself has only
  been exercised on Windows. The shadow-lock path refuses macOS explicitly
  (`src/runtime/claude-shadow.ts`), so macOS is unsupported, not merely unmeasured.

## Building and verifying from this tree

```
npm ci
npm run check         # lint + typecheck + build + tests + secret scan
npm run self-check    # the gates' negative controls: each one is shown catching its canary
node dist/src/cli.js --help
```

What you **can** do from this tree: build it, run every test, run the gates and their negative
controls, read the request compiler and the lane bridges, and reproduce the offline probes behind
several of the findings above.

What you **cannot** do from this tree yet: install it as the maintainer runs it. Portable shims
are included, but there is no release builder documented, and the install lock pins binaries at
machine-specific Windows locations. `node dist/src/cli.js doctor` will tell you, component by
component, what it cannot find, that is the intended behaviour, not a bug to report.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In one line: every rule ships with its measure, every gate
ships with its negative control, and `npm run check` is green or there is no pull request.

The most useful contribution right now is reproduction of the findings above. Please do not
include credentials, account identifiers, or machine-specific paths in issues or pull requests;
report a leak by location and type, never by value. Anything exploitable goes to
[SECURITY.md](SECURITY.md), not to an issue.

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Apache-2.0 was chosen over MIT for its explicit patent grant and its `NOTICE` mechanics: this
project integrates several vendors' client software and a third-party bridge, and downstream
adopters should not have to guess about patent exposure.

Third-party redistribution rights for pinned binaries and dependencies have **not** been reviewed.
Nothing here should be read as a grant covering those. Not affiliated with, endorsed by, or
sponsored by Anthropic, Google, OpenAI or xAI.
