# claude-oauth

Run other models inside Claude Code over their own OAuth sessions — **without replacing the native
Claude path.** `claude` stays native. `claude-oauth` opens the router.

> **Status: pre-release. Not ready to use, and deliberately not pretending otherwise.**
> Several capability claims below are gated on open defects (see [Known gaps](#known-gaps)).
> This README documents what is measured, what is not, and what is broken.

---

## Why this exists

Claude Code is an agent harness, not just a chat window. Its value is in the loop: tools, subagents,
skills, MCP servers, permission prompts. A model router that only forwards text turns that harness
into a chat box.

The goal here is the opposite: **every model reachable through the router should be able to use the
same Claude Code surface** — the `Agent` tool, skills, MCP servers such as Playwright, file
editing under the same permission rules. Anything less is a downgrade wearing the harness's clothes.

Two audiences, both intentional:

1. **Developers** — switch models mid-workflow, run several in parallel, cross-check one against
   another, inside the tool they already use.
2. **Students** — extend a free provider tier (for example Google's student Gemini offer, subject to
   Google's own terms) into Claude Code, so the harness itself is learnable without a paid plan.

This is meant to grow the harness's adoption, not to route around anyone. The native path is
untouched and remains the recommended one; nothing here proxies, wraps, or intercepts Anthropic's
own endpoint.

## What it does not do

- It does **not** modify, patch, or proxy the native Claude path. `claude` talks to
  `api.anthropic.com` exactly as it did before installation.
- It does **not** bypass any provider's authentication. Each lane drives that provider's own
  official CLI under the user's own account: Antigravity (`agy`) for Google, `grok` for xAI,
  `codex` for OpenAI.
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
repository-verified guarantee. Closing that gap is a release blocker.

## Known gaps

These are open defects, found by review and independent measurement. They are listed because a
pre-release README that hides them is worthless.

| Id | Severity | What is wrong |
|---|---|---|
| B01 | **Critical** | The parent session's permission boundary is not applied to Google and Grok subagents. The Google lane forces write/bypass flags on; the Grok lane accepts the first permission option and serves its own write handler. `executionMode: "agent-readonly"` therefore **misdescribes** the effective authority. |
| B02 | High | A `role:"system"` message that arrives after the last user message is silently dropped when compiling the request. Measured loss: ~77.5k characters — the skill catalogue, the agent catalogue, MCP server instructions, output style. No error, no warning, no detector. This is why skills and the `Agent` tool appear unavailable to routed models. |
| B03 | High | A Grok continuation request can lose both the session id and the new user instruction. |
| B04 | High | The workspace write check does not write the file it checks; a path race is open. |
| B05 | High | This tree contains no launcher shim, so the native/router separation cannot be verified from the repository. |
| B06 | High | The long-context advertisement is written into `max_input_tokens`, a protocol capacity contract, above the pinned snapshot value. A client obeying the advertised limit may build a request the transport does not accept. Unproven either way. |

B01 and B02 together are the reason the capability goal is not met today: routed models neither
receive the catalogue that tells them what exists, nor operate under a permission boundary that
makes handing them tools safe. **Both must land together.** Restoring capability without restoring
the boundary would ship a more powerful hole.

## Requirements

- Node.js — `package.json` declares `>=24.0.0`, but the runtime gate pins one exact version. That
  inconsistency is unresolved; see the installation notes before assuming a range works.
- The provider CLIs listed above, authenticated under your own accounts.
- Windows is the only platform exercised so far. Other platforms are unmeasured, not unsupported.

## Contributing

The most useful contribution right now is reproduction. Several findings above ship with offline,
quota-free probes: they compile a request body and count what survives, with a positive control.
No model call, no account, no cost. If a probe does not reproduce on your machine, that is a
finding about the probe, and it is worth reporting.

Please do not include credentials, account identifiers, or machine-specific paths in issues or
pull requests. Report a leak by location and type, never by value.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Apache-2.0 was chosen over MIT for its explicit patent grant and its `NOTICE` mechanics: this
project integrates several commercial providers' client software, and downstream adopters should
not have to guess about patent exposure.

Third-party redistribution rights for pinned binaries and dependencies have **not** been reviewed.
Nothing here should be read as a grant covering those.
