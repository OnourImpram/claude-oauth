# claude-oauth

Run other models inside Claude Code over their own OAuth sessions — **without replacing the native
Claude path.** `claude` stays native. `claude-oauth` opens the router.

> **Status: pre-release. Not ready to use, and deliberately not pretending otherwise.**
> Several capability claims below are gated on open defects (see [Known gaps](#known-gaps)).
> This README documents what is measured, what is not, and what is broken.
> Project page: <https://onourimpram.github.io/claude-oauth/> · Security: [SECURITY.md](SECURITY.md) ·
> Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Changes: [CHANGELOG.md](CHANGELOG.md)

---

## Why this exists

Claude Code is an agent harness, not just a chat window. Its value is in the loop: tools, subagents,
skills, MCP servers, permission prompts. A model router that only forwards text turns that harness
into a chat box.

The goal here is the opposite: **every model reachable through the router should be able to use the
same Claude Code surface** — the `Agent` tool, skills, MCP servers such as Playwright, file
editing under the same permission rules. Since 2026-09-08 the Google lane reaches that surface for real
(G01 below, with a live receipt); what still stands between here and the full goal is B01 — the parent
session's permission boundary is not applied to the routed subagents.

Two audiences, both intentional:

1. **Developers** — switch models mid-workflow, run several in parallel, cross-check one against
   another, inside the tool they already use.
2. **Students** — extend a free provider tier (for example Google's student Gemini offer, subject to
   Google's own terms) into Claude Code, so the harness itself is learnable without a paid plan.

This is meant to grow the harness's adoption, not to route around anyone. The native path is
untouched and remains the recommended one; nothing here proxies, wraps, or intercepts Anthropic's
own endpoint.

## How it sits inside Claude Code

`claude-oauth` starts a **real Claude Code process** — the same binary you already have — and
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
| xAI | `grok` over ACP (Agent Client Protocol), long-lived sessions — at most four live at once — so a tool loop can cross Claude Code's per-turn HTTP requests | xAI | `grok.version` |
| OpenAI | **Clodex** (`@bman654/clodex`), a third-party bridge, run as a local capsule with the `openai-oauth` provider | [bman654/clodex](https://github.com/bman654/clodex), MIT-licensed npm package, with local patches in `config/` | `clodex.version`, `clodex.localPatchSha256` |

Each lane authenticates as **you**, on your own plan: the Google and xAI lanes run those vendors'
own CLIs; the OpenAI lane does **not** run OpenAI's `codex` CLI — it runs Clodex, which speaks to
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
  and no MCP or `Skill` (N03) — they answer, they do not drive the harness.

Switching back to a Claude model in the same session is the same `/model` command. There is no
mode to remember: the native `claude` command never enters any of this.

## What it does not do

- It does **not** modify, patch, or proxy the native Claude path. `claude` talks to
  `api.anthropic.com` as it did before installation — that is the claim measured below.
- It does **not** bypass any provider's authentication. Each lane uses your own account's OAuth
  session — through the vendor's CLI for Google and xAI, through Clodex for OpenAI.
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
`SECURITY.md`, `CHANGELOG.md` and the project page. Repaired items are in the changelog, not here.

| Id | Severity | What is wrong |
|---|---|---|
| B01 | **Critical** | The parent session's permission boundary is not applied to Google and xAI subagents. The Google lane forces write/bypass flags on; the xAI lane accepts the first permission option and serves its own write handler. `executionMode: "agent-readonly"` therefore **misdescribes** the effective authority. |
| ~~B02~~ | ~~High~~ | **Repaired 2026-09-07 (`b5caf0e`).** A `role:"system"` message arriving after the last user message was dropped silently while compiling the request — measured loss ~77.5k characters: the skill catalogue, the agent catalogue, MCP server instructions, the output style. It now travels in its own `SESSION CAPABILITY CONTEXT` section. Six test arms, mutation-verified. The end-to-end claim is NOT made here: G01 still keeps the Google lane off the tool surface. |
| B03 | High | An xAI continuation request can lose both the session id and the new user instruction. |
| B04 | High | The workspace write check does not write the file it checks; a path race is open. |
| B05 | High | This tree contains no launcher shim, so the native/router separation cannot be verified from the repository. |
| B06 | High | The long-context advertisement is written into `max_input_tokens`, a protocol capacity contract, above the pinned snapshot value. A client obeying the advertised limit may build a request the transport does not accept. Unproven either way. |
| ~~G01~~ | ~~High~~ | **Repaired 2026-09-08.** The Google lane now carries the same tool loop the xAI lane has. The objection that kept it away was that `agy mcp add` writes the session nonce into the operator's persistent config; the lane instead runs inside a **call-scoped configuration home** (`USERPROFILE` redirected, identity files hard-linked, never copied), so the operator's own `mcp_config.json` is never opened for writing. Live receipt: the router logged `agent_tool_call_parked`, Claude Code executed the MCP tool 213 ms later, one `tool_use` block crossed the stream, and the model returned a string it could not otherwise know. NOT claimed: a multi-step loop, or the `Agent` sub-loop. |
| G02 | High | A non-empty `.mcp.json` in the project root — Claude Code's standard project MCP file — makes the xAI lane refuse to start (503). Fail-closed, but it is a denial of the lane in any repository that has one. |
| ~~G03~~ | ~~High~~ | **Repaired 2026-09-08.** A session parked on a tool call set `running = false` and so looked idle; at the cap the oldest such session was cancelled mid-loop. The naive guard reopens the process leak this reclaim exists to close, because an unaddressable session IS a parked one — so the discriminator is age: a 60 s grace window. Negative control on both edges: removing the guard fails the new arm, making it unconditional fails the old one. |
| G04–G08 | High / suspected | `thinking`/`image`/`document` blocks in history are rejected with 422 on the agent lanes; the last text block of a multi-block user message is taken as "the request"; delegate agents get no tools; the live xAI MCP handshake has not been shown from this tree. |
| N01 | High | Image blocks inside a tool result are reduced to an empty string, so a Playwright screenshot returns as a successful, empty tool result. |
| N03 | High | Generated `*-delege` agents carry `tools: []` and `maxTurns: 1`; a user definition that widens them is rejected. |
| N04 | High | A changed tool catalogue on a continuation request does not reach the live MCP session. |
| N05 | High | The OpenAI capsule's own loopback port does not enforce the transport nonce; a local process could reach it without going through the router. |
| N06 | Medium | On POSIX, a helper that ignores SIGTERM keeps the timeout waiting; there is no escalation to SIGKILL. Unmeasured on Linux. |

B01 is now the reason the capability goal is not fully met: routed models reach the tools, but do not
yet operate under a permission boundary that makes handing them tools safe. Restoring capability without restoring
the boundary would ship a more powerful hole.

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
component, what it cannot find — that is the intended behaviour, not a bug to report.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In one line: every rule ships with its measure, every gate
ships with its negative control, and `npm run check` is green or there is no pull request.

The most useful contribution right now is reproduction of the findings above. Please do not
include credentials, account identifiers, or machine-specific paths in issues or pull requests;
report a leak by location and type, never by value. Anything exploitable goes to
[SECURITY.md](SECURITY.md), not to an issue.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Apache-2.0 was chosen over MIT for its explicit patent grant and its `NOTICE` mechanics: this
project integrates several vendors' client software and a third-party bridge, and downstream
adopters should not have to guess about patent exposure.

Third-party redistribution rights for pinned binaries and dependencies have **not** been reviewed.
Nothing here should be read as a grant covering those. Not affiliated with, endorsed by, or
sponsored by Anthropic, Google, OpenAI or xAI.
