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

What limits this today is in the defect table, not hidden. The generated delegate agents answer
from what the prompt hands them and cannot drive the harness themselves (N03), so a delegated
review gets the diff pasted into its prompt. A direct `/model` switch to the Google or xAI lane
carries the tool loop (G01 and G03 repaired), so a review run that way can open files and run tests
itself. Which lane reaches what is in the lane table and the defect ids, and nowhere else.

### The harness surface, not a chat box

Claude Code's value is in the loop: tools, subagents, skills, MCP servers, permission prompts. A
model router that only forwards text turns that harness into a chat box. The goal here is the
opposite: **every model reachable through the router should be able to use the same Claude Code
surface**, the `Agent` tool, skills, MCP servers such as Playwright, file editing under the same
permission rules. Since 2026-09-08 the Google lane reaches that surface for real (G01 below, with a
live receipt). The native permission paths in Google and xAI are now constrained (B01 below);
permission inheritance through a separate `Agent` child session remains unmeasured.

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
  to another model through the `Agent` tool. Today the Google and xAI delegates run with
  `tools: []` and a single turn, and the OpenAI delegates with a fixed list of six built-in tools
  and no MCP or `Skill` (N03), they answer, they do not drive the harness.

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

Measured on the maintainer's machine, 2026-09-07, two arms:

| Arm | Check | Result |
|---|---|---|
| Environment | `ANTHROPIC_BASE_URL` in a normal `claude` session | absent |
| Process tree | ancestry of the `claude` process | no router process |
| Positive | `claude remote-control --help` in a clean environment | accepted, full help |
| Negative | same command with a router-style `ANTHROPIC_BASE_URL` | refused, exit 1 |

The negative arm is the point: the check can fail, so the pass means something.

**Scope, stated honestly:** that measurement was taken on one machine, and the negative arm used a
synthetic base URL rather than a live router window. **This repository does not yet ship the
launcher shim or the test that reproduces either arm**, so a reader cannot verify the claim from
this tree alone. Until it does, treat the claim as the maintainer's measurement, not as a
repository-verified guarantee. Closing that gap is a release blocker (B05).

## Known gaps

These are open defects, found by review and independent measurement. They are listed because a
pre-release README that hides them is worthless. Ids are stable across this file,
`SECURITY.md`, `CHANGELOG.md` and the project page. Repair status is marked in the rows below and recorded in the changelog.

| Id | Severity | What is wrong |
|---|---|---|
| B01 | **Native paths repaired; Agent NOT_RUN** | **Google direct route: PASS, 2026-09-08.** Call-scoped settings allow only the bridge MCP server and deny native `write_file`, `command`, `browser`, `execute_url`, and `unsandboxed` actions. Live Claude Code Write denial leaves no file; a native `write_to_file` fallback is also denied, while MCP still parks and returns the denial. xAI rejects native ACP writes and admits only identified bridge MCP permission requests. `Agent` permission inheritance: **NOT_RUN (requires a separate Agent child-session harness)**. |
| ~~B02~~ | ~~High~~ | **Repaired 2026-09-07 (`b5caf0e`).** A `role:"system"` message arriving after the last user message was dropped silently while compiling the request, measured loss ~77.5k characters: the skill catalogue, the agent catalogue, MCP server instructions, the output style. It now travels in its own `SESSION CAPABILITY CONTEXT` section. Six test arms, mutation-verified. The end-to-end claim is NOT made here: G01 still keeps the Google lane off the tool surface. |
| ~~B03~~ | ~~High~~ | **Repaired 2026-09-08.** Compilation and result extraction share the last logical conversation record, so trailing system records retain the live session. Every continuation is validated and its system context plus all accompanying user text travels in labelled MCP result text before the agent resumes. Tests measure one start, the instruction received, mixed images, trailing blank text, and a usage bound covering the full request body. This preserves transport, not a guarantee of model compliance. |
| B04 | High | The workspace write check does not write the file it checks; a path race is open. |
| B05 | High | This tree contains no launcher shim, so the native/router separation cannot be verified from the repository. |
| B06 | High | The long-context advertisement is written into `max_input_tokens`, a protocol capacity contract, above the pinned snapshot value. A client obeying the advertised limit may build a request the transport does not accept. Unproven either way. |
| ~~G01~~ | ~~High~~ | **Repaired 2026-09-08.** The Google lane now carries the same tool loop the xAI lane has. The objection that kept it away was that `agy mcp add` writes the session nonce into the operator's persistent config; the lane instead runs inside a **call-scoped configuration home** (`USERPROFILE` redirected, identity files hard-linked, never copied), so the operator's own `mcp_config.json` is never opened for writing. Live receipt: the router logged `agent_tool_call_parked`, Claude Code executed the MCP tool 213 ms later, one `tool_use` block crossed the stream, and the model returned a string it could not otherwise know. NOT claimed: a multi-step loop, or the `Agent` sub-loop. |
| ~~G02~~ | ~~High~~ | **Repaired 2026-09-08, diagnostic branch.** Installed Grok 1.0.13 documentation (`docs/user-guide/07-mcp-servers.md`, Compatibility) says project `.mcp.json` is loaded unless the Claude import marker suppresses it. Refusal is retained and now names `.mcp.json` plus a workspace/user-configuration remedy; root and nested-workspace tests measure it, with hooks/plugins still fail-closed. Live xAI in repositories with non-empty `.mcp.json`: **NOT_RUN, intentionally refused because Grok can discover this file**. |
| ~~G03~~ | ~~High~~ | **Repaired 2026-09-08.** A session parked on a tool call set `running = false` and so looked idle; at the cap the oldest such session was cancelled mid-loop and the returning `tool_result` found no session. A first repair used a 60 s age window; an independent wall-clock measurement then showed a legitimate 61 s permission wait being sacrificed, so age was dropped as the discriminator. Now a parked session is never evicted for capacity: at the cap the request receives an explicit 503. The cost is stated in the source: an abandoned parked session holds capacity until the idle timeout or the provider's own timeout. Both registries also close and wait on shutdown (previously only the xAI one did; four Google processes and homes were measured surviving `close()`). |
| ~~G04~~ | ~~High~~ | **Repaired 2026-09-08.** Agent history drops `thinking` and `redacted_thinking`, summarizes `image` and `document` with media type and size, and renders `server_tool_use` and `mcp_tool_use` like tool calls. Per-type Google/xAI tests and a session-lane fixture cover messages and token counting without 422. Media history remains a placeholder; initial multi-text request framing and delegate tooling are outside this repair. |
| ~~G08~~ | ~~Suspected~~ | **Repaired 2026-09-08.** The SDK-typed HTTP definition and a fake ACP peer verify exact name, URL and `{name,value}[]` headers. Live Grok 1.0.13 reached the router bridge: `agent_tool_call_parked` at `2026-09-08T10:23:44.844Z`, caller PID `49944`, tool `cluster_a_handshake_receipt`; the reply completed with `end_turn` and zero unmatched results. Header removal is exercised as a full-suite mutation control. |
| ~~N01~~ | ~~High~~ | **Repaired 2026-09-08.** Anthropic and native MCP base64 image tool results cross the shared bridge on both xAI/ACP and Google/Antigravity lanes; text compilation and unsupported/URL media use type, media-type and byte-size placeholders (URL size is unknown). Embedded resources retain known MIME type and payload size. Adapter-to-MCP tests preserve image bytes and error status; the production-log fixture measures payload-free image metadata. Live provider image interpretation is NOT_RUN, no vision task was submitted. |
| N03 | High | Generated `*-delege` agents carry `tools: []` and `maxTurns: 1`; a user definition that widens them is rejected. |
| ~~N04~~ | ~~High~~ | **Repaired 2026-09-08.** Every request derives its catalogue and replaces changed bridge descriptors before releasing parked results; the xAI permission lookup reads the live names. Tests cover ToolSearch adding `mcp__playwright__browser_snapshot`, schema changes, removal, and unchanged descriptors. Already parked removed-tool calls can finish; subsequent calls are refused. Provider-side catalogue cache refresh is NOT_RUN, the offline measurement covers `tools/list`. |
| ~~N05~~ | ~~High~~ | **Repaired 2026-09-08.** The capsule runs a hash-pinned patched copy of Clodex and receives its session nonce only through the child environment. Measured with an anonymous scratch home, missing/wrong/correct `x-api-key`: catalog and health **401/401/200**, malformed JSON messages **401/401/400**. Empty nonce, missing patch anchors and patched hash drift prevent startup. |
| N06 | Medium | On POSIX, a helper that ignores SIGTERM keeps the timeout waiting; there is no escalation to SIGKILL. Unmeasured on Linux. |

B01's measured Google native-write bypass is closed. The live check covers direct routing with
`gemini-3.8-flash-high` on Windows; it does not establish permission inheritance through `Agent`
child sessions or live enforcement of every denied action category.

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

What you **cannot** do from this tree yet: install it as the maintainer runs it. There is no
launcher shim (B05), no release builder documented, and the install lock pins binaries at
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
