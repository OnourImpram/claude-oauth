# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Defect ids (B*, G*, N*, A*, S*) are the
repository's own and are stable across the README, `SECURITY.md` and this file.

## [Unreleased]

## [2.0.0], pre-release, 2026-11-15

First tagged release, numbered 2.0.0. The entries below were recorded as unreleased until this
tag.

### Fixed: a one-shot Google task gets the time its caller asked for (2026-11-15)

- The one-shot commands `gemini`, `opus-google`, `sonnet-google` and `antigravity --model` take
  `--timeout <seconds>` and hand it to the bridge as the process budget (the kill timer and
  agy's own print timeout). Without the flag the default stays 300 s.
- The one-shot lane no longer has its own ten-minute ceiling. A named budget is honoured up to
  the same six-hour process backstop the routed session lane uses; anything beyond it, and
  anything that is not whole positive seconds, is refused with `invalid_request` instead of
  being replaced by a default.
- Why: a delegated task on a slow reasoning tier was killed at 302.6 s with `upstream_timeout`
  although its caller had asked for 1800 s. The command took no budget, so the number only
  steered the caller's own watchdog. D2-02 had lifted the default for routed sessions only.
- The values of `--task` and `--cwd` are no longer inspected for flags, so a task whose whole
  text is `--model` or `--timeout` stays a task.
- Held by tests: `test/antigravity-task-arguments.test.ts` (the flag, its refusals, the task
  text arm) and `test/antigravity-session-timeout.test.ts` (a named one-shot budget reaches the
  runner and agy; neither lane may pass the backstop; the default is unchanged).

### Changed: OpenAI model names follow the latest version (2026-11-15)

- `sol`, `terra`, `luna` and `astra` are the names of the OpenAI model families, not aliases of one
  version. A name points at the newest version of its family in the contract; when a newer version
  arrives the family's row is replaced and the name stays. A version-suffixed second name is never
  opened for it.
- Moved: `sol` from `gpt-5.6-sol` to `gpt-6.1-sol` and `terra` from `gpt-5.6-terra` to
  `gpt-6.1-terra` (display names follow). `luna` stays on `gpt-6-luna`, `astra` on `gpt-6-astra`.
  Every row keeps the window, output limit and auto-compact value it had; Astra keeps its
  advertised window and its source note.
- Removed: the names `sol6`, `sol61` and `terra61`, and the rows they carried. The ids
  `anthropic-openai-gpt-5.6-sol`, `anthropic-openai-gpt-5.6-terra` and
  `anthropic-openai-gpt-6-sol` no longer resolve; select `sol` or `terra`. The delegate agents
  follow the names: `sol-delege`, `terra-delege`, `luna-delege`, `astra-delege`; `sol6-delege`,
  `sol61-delege` and `terra61-delege` are gone.
- Upgrade step: a model snapshot written before this change keeps the retired rows until the
  next refresh, and while it does the OpenAI lane reports `clodex_session_catalog_drift` naming
  them and stays closed (measured with a unit probe on the new contracts, no provider call). Run
  `claude-oauth models refresh --allow-shrink` once after installing this change (README, "After
  a row is retired").
- Held by a test: `openAiFamilyNameViolations` (`src/domain/model-contracts.ts`) reports a name that
  is not the family of its upstream model, a name that contains a digit, and a second row of one
  family. `test/model-family-names.test.ts` asserts the shipped contracts have no violation and has
  negative arms on fixture lists for each rule. RED before the change: the assertion on the shipped
  contracts named `sol6`, `sol61` and `terra61` (nine violations).
- The tests that carried the old ids as fixtures now use the new ones, with every assertion kept.

### Docs: the site explains the own-API-key lanes (2026-11-15)

- `docs/index.html` gains the section "Using your own API key" (OpenAI API, Alibaba Token Plan,
  Z.AI): which variable names the key file, what the router sends, how the rows enter the
  `/model` picker, the named states a lane reports without a working key, and the data rule.
  Until now the site described the OAuth lanes only and this account lived in the README alone.

### Fixed: `--model haiku` was refused on Claude Code 2.1.325 (2026-11-15)

- Found by the live tour through the public launcher (one small prompt per model): `haiku`
  exited 1 with "There's an issue with the selected model
  (claude-haiku-5-5)". Claude Code 2.1.325 resolves `haiku` to `claude-haiku-5-5`, the router's
  native list ended at `claude-haiku-4-5-20251001`, and the request was refused locally in 2 ms
  with `model_not_available`. The log held the same class four more times, for four other Claude
  models: every native model Anthropic shipped needed a row here before it worked.
- The row is added to `config/models.default.json`. The class is closed by a rule: a Claude model
  id (`claude-...`) that the snapshot does not list is served by the native lane under its own
  id. That lane is a passthrough with the user's own claude.ai session, so Anthropic accepts or
  refuses the id, as it does without the router. Every other lane keeps the closed snapshot:
  there the selected model has to be a contracted row. The router logs
  `native_model_not_in_snapshot` once per id, so a missing row stays visible.
- `test/native-model-passthrough.test.ts`, six arms. With the rule switched off and the row
  absent three were RED (`model_not_available`, and the missing row); green three runs in a row.
  Negative arms: an unknown id of another lane is still refused, a string that only starts like
  a Claude id is refused, and with no Anthropic adapter the answer is `adapter_unavailable`.

### Fixed: findings of the independent audit of this branch, D3-01 to D3-03 (2026-11-15)

- A fresh-context auditor read the commits of this branch against the code and ran 14 mutants in
  a scratch clone. Verdict: pass with findings, none critical or high, three low. All three are
  closed here.
- **D3-02, a keep-alive held a request open for ever.** The request guard was re-armed by every
  byte the provider sent on the API-key lanes. A stream of SSE comments, of chunks with empty
  deltas, or of `ping` events never ended while the keep-alive lasted, and an Alibaba stream with
  no content was recorded as `completed`. The guard-on-every-lane change of this same branch had removed the total-duration
  cap that used to end such a request. Now the chat-completions translation re-arms the guard
  only on a chunk that carries something (usage, a finish reason, text, reasoning or a tool
  call), and the Anthropic passthrough tap re-arms on every Messages event except `ping`; that
  lane no longer declares itself upstream-driven. Reasoning deltas count on purpose: a model
  thinking out loud is working. The native Anthropic passthrough is left as it is: the router
  does not parse those bytes. `test/lane-silence-guard.test.ts` gains arms for these keep-alive
  cases and one negative control (reasoning-only chunks are not cut).
- **D3-01, a test that could not see what it guarded.** The closed list for `requestClass` is
  enforced where the receipt is written, but the test read the receipt back through the parser,
  which filters too: with the server filter removed it stayed green while the client's string
  was in the file. A new arm reads the raw bytes of `receipts.jsonl`; with the server filter
  removed it fails, restored it passes.
- **D3-03, an undocumented step after a row is retired.** The model snapshot under the runtime
  root keeps a retired row until the next refresh, and selecting it answers 404.
  `claude-oauth models refresh` refuses to drop a row on its own ("Refusing to shrink the model
  snapshot"), which is the guard doing its job; when the removal is deliberate the refresh is run
  once with `--allow-shrink`. The README says so
  now, and `docs/index.html` lists `orchestrator-argon`, which it had missed.
- Recorded, not repaired: known gap N08 in the README (the non-default `patched-shadow` mode
  replaces the Claude Code pin with the hash it measures; found by code reading in the comparison
  audit, not reproduced).
- Recorded, not repaired: known gap N09 in the README, adapter audit finding D2-04 (the Google
  lane hard-links the operator's Antigravity identity files into the call-scoped home). The
  audit rated it plausible. Three measurements with agy 1.5.9 (before the first run, after five
  live probes, after 20 completed Google-lane requests) found all seven files unchanged; a token
  refresh was not observed, so the finding stays open and unreproduced.

### Changed: the Grok CLI pin moves from 1.0.40 to 1.0.77 (2026-11-15)

- Measured (2026-11-15): the stable channel pointer `https://x.ai/cli/stable` answers `1.0.77`; the
  binary reports `grok 1.0.77 (50ca579fa996)`; Windows Authenticode status is `Valid` and the
  signer is `CN=X Corp.`. The 1.0.40 binary was signed by `X.AI LLC`, so the signer changed
  between the two pins.
- `config/install-lock.json`: the `grok` block now carries version `1.0.77`, source commit
  `50ca579fa996`, the executable `providers\grok\versions\1.0.77\grok.exe` and the hashes of that
  binary and of its installer. The 1.0.40 binary stays where it was (`providers\grok\bin`), so the
  previous release keeps verifying against its own lock.
- `doctor --live` from the tree reports `grok 1.0.77 ok locked_bytes_and_reported_version_match`.
- Live from the tree: three consecutive `claude-oauth --model grok -p` runs answered `pong`
  (router durations 9.9 s, 10.1 s and 11.9 s; each receipt `completed`, `requestClass` `main`).
- Not covered: nothing in the lock's `grok` block names a signer, so the signer change is recorded
  here as a measured fact and is not a check of its own; the pin is the binary's hash.

### Added: `claude-oauth receipts`, the client's request class in receipts, and the gateway hint headers (2026-11-15)

- `claude-oauth receipt` showed the last request only; whether a lane had been failing all
  afternoon meant reading `receipts.jsonl` by hand. `claude-oauth receipts [--hours N]` (default
  24) prints one row per provider and configured model from the receipts the router already
  writes: requests; completed, failed and cancelled; token sums over the receipts that carried
  usage (and how many did); median duration; error codes; request classes; newest timestamp. The
  rotated file is read before the current one; a malformed line is counted and skipped. No new
  record is written and no prompt text exists in a receipt.
- Receipts gain `requestClass` when the client sends `x-claude-code-request-class` with one of the
  six values measured in the Claude Code 2.1.325 binary: `main`, `subagent`, `workflow`,
  `compaction`, `auxiliary`, `side_reply`. Observability only: nothing is routed or refused by it.
  A value outside the list is dropped, so a client string never reaches the receipt file as free
  text, and a class this build does not know is dropped on read instead of making the receipt
  unreadable.
- Measured on the maintainer's own history (30 days, 8151 receipts, 0 malformed): the native
  lane reports no token usage: the router forwards Anthropic's bytes without parsing them, and
  that is left as it is.
- The field did not fire at first: 0 of 1630 receipts carried `requestClass`, three live probes
  through this tree included. Measured in the Claude Code 2.1.325 binary: the header is built only
  when the client's gateway-hint gate is open. The gate returns the value of
  `CLAUDE_CODE_GATEWAY_HINT_HEADERS` when it is set; otherwise it is true only off the first-party
  path or behind a server-side flag that defaults to false. Four headers sit behind it:
  `x-claude-code-request-class`, `x-claude-1p-request-class`, `x-claude-code-agent-type`,
  `x-claude-code-prompt-id`.
- The launcher now sets `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` for the Claude child, whatever the
  operator's shell says. The router asked for the hints, so it consumes them:
  `upstreamRequestHeaders` forwards none of the four, on the Anthropic passthrough and on the
  Clodex lane alike, and a provider receives nothing it would not have received with the gate
  closed. Headers the gate does not control (agent id, parent agent id, auxiliary type) cross as
  before; a negative arm holds that. Only the request class is recorded in the receipt.
- Evidence. `test/receipt-summary.test.ts` (8 arms) and `test/receipt-request-class.test.ts`
  (7 arms): 11 of them seen RED against a typed stub first, 4 negative controls green by design.
  `test/gateway-hint-headers.test.ts`, 5 arms, seen RED (4 failing) with an empty stub list. Live,
  with the variable explicitly unset in the calling shell: the receipt of a routed request carries
  `"requestClass":"main"`. Gate after the summary commit: `npm run check` rc 0, 926 tests, 925
  pass, 0 fail, 1 skipped.

### Changed: the model lists are curated against the live catalogues (2026-11-15)

- Owner request (2026-11-15): add the new Gemini and GPT models, drop the models that left their
  catalogue and the old ones, keep each lane to models worth routing to. Every addition in the
  curation commit answered a live one-line probe first (`terra61`, added afterwards, was checked
  against the account catalogue instead, see below); every removal is named here.
- Google (`agy models`, agy 1.5.9, 22 rows). Added: `carbon` = `gemini-4-carbon-high`, `hydrogen` =
  `gemini-4-hydrogen-xhigh`, `orchestrator` = `gemini-pro-orchestrator`, `orchestrator-argon` =
  `gemini-pro-orchestrator-argon`. Removed: `gemini-pro` (`gemini-3.1-pro-high` is no longer
  listed); the alias is not repointed, because the selected model is the model that answers. Not
  added on purpose: `gpt-oss-120b-medium` (listed, answers, 95 s). The catalogue publishes no
  context window for the new rows, so the shared Antigravity constants are inherited, not
  measured.
- ChatGPT OAuth (clodex 2.21.7 seeds). Added: `sol6` = `gpt-6-sol`, `luna` = `gpt-6-luna`,
  `sol61` = `gpt-6.1-sol`, and `terra61` = `gpt-6.1-terra`. The last one is not in the 2.21.7
  seed list: after `clodex providers refresh-models openai-oauth` the owner's account catalogue
  lists ten models and it is one of them, and `clodex models --json` reports effective 872000 for
  it with the saved max context stop, like the six seeded rows. Its live row publishes no
  `maxOutputTokens`, so the output limit is inherited from the seeded rows, and the auto-compact
  window is inherited from `sol` and `terra`, not measured per model. `sol` keeps meaning
  `gpt-5.6-sol`. A row is served only when the live catalogue of the account reports the id. Not
  contracted: `gpt-5.6-luna` (older generation), `gpt-reserve` and `codex-auto-review` (not
  general chat models).
- Alibaba Token Plan (21 rows listed). Added: `qwen4-max-preview` (HTTP 200 "pong", 6.1 s).
  Removed, still listed: `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-flash`, `glm-5.2` (older
  generations of rows that stay) and `deepseek-v4-pro-0813`, `deepseek-v4.1-flash-1017`,
  `deepseek-v4-flash-0731` (dated snapshots). Seven chat rows remain, down from thirteen:
  `qwen4-max-preview`, `qwen3.8-max`, `qwen3.8-flash`, `glm-5.3`, `deepseek-v4-pro`,
  `deepseek-v4.1-flash`, `auto`. Like every row there, `qwen4-max-preview` keeps the
  `[UNVERIFIED]` inherited window.
- Handled in the same change: picker needles, local patch rows and the lock's `localPatchSha256`
  follow the agent contracts (`test/claude-shadow.test.ts` held them RED first).
  `SUPERVISOR_DETAIL_CODE_LIMIT` 256 -> 512: with seven ChatGPT-OAuth rows a full drift needs
  about 440 characters (the figure in the code comment), and at 256 the code named three rows and
  counted the rest. Test counts are derived from the contract lists instead of literals.
- Evidence: gate `npm run check` rc 0 after the curation commit (1011 tests, 1010 pass, 0 fail,
  1 skipped) and after the `terra61` commit (1026 tests, 1025 pass, 0 fail, 1 skipped).
- Not covered: no context window was measured for any added row; the windows are inherited as
  stated above.

### Added: a test that measures mixed line endings in the working copy (2026-11-15)

- Measured: nine tracked files mixed CRLF with bare LF after patches that inserted LF lines into
  CRLF files. git hides it (`* text=auto` normalises on commit), but `tsc` copies the newlines
  inside comments and template literals into `dist`, and the release id is a hash of `dist`, so a
  release cut from such a tree cannot be reproduced from a fresh clone.
- `test/line-endings.test.ts` walks `src`, `test`, `config` and `scripts` and fails with the file
  names when a file has both endings; its negative arm proves the counter sees a mixed buffer.
  Seen RED with the nine files listed, GREEN after the working copy was normalised (no content
  change in the index).
- Not covered: only those four directories are walked; the root documents and `docs` are outside
  the test.

### Fixed: the Google and xAI agent lanes fold `tool_addition` blocks instead of answering 422 (2026-11-15)

- Measured 2026-11-15 with Claude Code 2.1.325: `claude-oauth --model grok -p` answered "422
  messages[1].content contains an unsupported tool_addition block". With the
  mid-conversation-tool-changes / inline-tools betas the client puts `tool_addition` blocks inside
  a `role:"system"` message in `messages`. The API-key lanes already folded them (audit D2-03);
  the Google and xAI agent lanes refused the whole request, so every `-p` call and every session
  that loaded a deferred tool failed there. The receipts carry the trace: xAI requests ending in
  `unsupported_feature`. The same refusal was measured in 3 ms on the ACP SDK before and after the
  bump below, so it was not caused by the bump.
- The request is folded once, before either gate reads it, so `/v1/messages` and
  `/v1/messages/count_tokens`, the tool loop and the text-only path all see the same
  conversation. Folded definitions join the tool list offered to the agent. No prefix is
  withheld: these lanes run on the owner's own OAuth and the envelope's `tools` array already
  crosses unfiltered here, `mcp__` included. Definitions are de-duplicated on the trimmed name,
  because the bridge trims and refuses a duplicate with 400. A block type nobody has measured is
  still refused (negative arm).
- Evidence: `test/agent-tool-addition.test.ts`, 6 arms, seen RED (5 failing with the 422 above,
  the negative arm green) before the change. Live from this tree: `--model grok -p` and
  `--model gemini -p` both answer `pong`. Gate: `npm run check` rc 0, 946 tests, 945 pass, 0 fail,
  1 skipped.

### Changed: Clodex 2.21.7 and ACP SDK 2.7.0 (2026-11-15)

- `@bman654/clodex` 2.11.1 -> 2.21.7, the newest version on the npm registry. 2.21.8 exists only
  as a GitHub tag (2026-11-14): `npm view @bman654/clodex@2.21.8` answers E404 and the dist-tag
  `latest` is 2.21.7, so 2.21.7 is what can be pinned with an integrity string. The lock's
  integrity equals the registry's `dist.integrity`.
- Capsule patch: both anchors still match exactly once and the two security properties hold on the
  2.21.7 bytes. The anchor spans and the body of `isAuthorized` are byte-identical to 2.11.1 (same
  SHA-256 in both bundles); upstream still enforces neither property itself, so both stay enforced
  here: the local quick-mode password is the session nonce, and `/health` is answered only after
  the authorization check. The real-listener tests (health, catalog and messages authenticate
  before JSON parsing; a missing or empty nonce exits before listening) pass against the real
  2.21.7 bundle. The local patch file and its hash pin are unchanged.
- The capsule no longer copies a hard-coded chunk name (`chunk-J7WXOD2K.js` in 2.11.1,
  `chunk-UTKSMW77.js` in 2.21.7). It reads every relative import of the entrypoint (static `from`,
  bare `import`, dynamic `import`), follows them through the copied files, keeps the directory
  layout, and refuses with a 503 naming the specifier when one resolves outside the package `dist`
  directory (lexically, as an absolute path or `file:` URL, or through a link) or names something
  that is not a file there. Fixture tests cover one chunk, a chunk importing a chunk, a cycle, a
  traversal from the entrypoint and from a chunk, a missing file, a directory and a junction;
  removing either containment check turns a test red.
- The environment strip list missed `CLODEX_PASSTHROUGH_OUTAGE_HOLD_MS` (new in 2.21.x) and five
  names that 2.11.1 already read (three server tunables and the two launcher variables): six
  `CLODEX_*` names join it. A test now scans the installed bundle for every `CLODEX_*` name it
  reads and fails when one is neither stripped nor kept on purpose, so the next bump cannot add one
  silently.
- `@agentclientprotocol/sdk` 1.4.0 -> 2.7.0. From the SDK's own CHANGELOG and
  `MIGRATION_STABLE_UNSTABLE.md`: 2.0.0 removes the `AgentSideConnection`, `ClientSideConnection`,
  `Agent` and `Client` classes and `LegacyAgentFactory`, makes the default import carry only
  stable ACP v1 (unstable features need `@agentclientprotocol/sdk/unstable`) and removes the
  unversioned `schema/schema.json` export. The two bridges (`src/grok/acp-bridge.ts`,
  `src/gemini/acp-bridge.ts`) already used the app API and only stable v1 methods (`initialize`,
  `session/new`, `session/prompt`, `fs/read_text_file`, `session/request_permission`,
  `session/update`), so the build is clean with no source change. One test read the removed schema
  export; it now reads `schema/v1/schema.json` (the same `McpServerHttp` and `HttpHeader`
  assertions hold). `zod` 4.4.3 is installed and inside the new `^3.25.76 || ^4.0.0` peer range;
  `@modelcontextprotocol/server` is an optional peer used only by SDK entrypoints the router does
  not import.
- Evidence, in the commit's words "measured against 1.4.0 on the same tree": `npm run check` 917
  tests / 916 pass / 0 fail / 1 skipped three times in a row; `doctor --live` xAI row ready
  (`grok_acp_live_catalog_verified`); a direct ACP task against Grok CLI 1.0.40 answered on 7 of 7
  runs; `--model grok -p` through the router completed with
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. Without that variable the same prompt was refused
  with 422 "unsupported tool_addition block" in 3 ms on 1.4.0 and on 2.7.0 alike; the agent-lane
  fold above repairs it.
- Known and open, not repaired by this change: the patched-shadow mode cannot patch Claude Code
  2.1.325 (Clodex's own proof check fails, with 2.11.1 as well); the default native-gateway mode
  does not use it. Listed as N07 in the README's known gaps.

### Fixed: the request guard measures provider silence on every lane, not total duration (2026-11-15)

- Measured (audit D1-01 and D1-05, both reproduced by test before the fix): one 300 s timer was
  armed before the adapter call and cleared only after the whole body had streamed, so a healthy
  stream still producing tokens at 300 s was cut mid-body with no `message_stop` and no error
  event, and the cut was filed as `upstream_protocol_error` although the router's own timer made
  it.
- The guard is re-armed when the provider speaks. On a body chunk, when the adapter declares the
  body to be the provider's own bytes (`upstreamDriven`): the Anthropic passthrough, the Clodex
  capsule, and Alibaba and Z.AI, whose tapped Messages stream is the upstream's bytes unchanged.
  On reported activity (`upstreamActivity`), when the adapter builds its own body: the OpenAI API
  lane reports each upstream read through the chat-completions translation
  (`onUpstreamRead`), and the Google and xAI agent lanes re-arm when the agent's text grows. A
  keep-alive the router generates re-arms nothing (the translated chat-completions body is not
  declared the provider's own, because it carries a router-made ping), so the agent lanes keep
  the bound they rely on to end a stuck turn: a turn that writes nothing is still ended at the
  limit (300 s by default) and its session cancelled. Time spent waiting on a slow client is not
  provider silence either.
- A cut by the guard is filed as `upstream_timeout` (504); a departed client is filed as a
  cancelled receipt and a `request_cancelled` log line, not as a provider failure.
- D1-05: the back-pressure wait was a bare `once(response, "drain")`, which never settles when the
  client goes away while the write buffer is full: the handler hung, kept the upstream reader
  locked and wrote no receipt. The wait now ends with the request's abort signal and the reader is
  cancelled.
- Evidence: `test/router-stream-watchdog.test.ts`, 8 arms, 3 consecutive runs;
  `test/lane-silence-guard.test.ts`, the real adapters behind the real router with a 200 ms limit:
  positive arms for a healthy long stream and negative arms that hold the
  bound. Mutation control: letting the agent-lane ping report activity makes the "writes nothing"
  arm hang until the test timeout. Gate after the second commit: `npm run check` rc 0, 911 tests,
  910 pass, 0 fail, 1 skipped.
- Not covered: the arms run at a 200 ms limit; the commits record no live stream past 300 s.

### Fixed: adapter audit repairs on the API-key and agent lanes, D2-01 to D2-08 (2026-11-15)

Five repairs from the read-only adapter audit (D2-02 has its own entry below).

- D2-01 (high): the `mcp__` data rule covered tool definitions only. A conversation that already
  held `mcp__` `tool_use` / `tool_result` pairs (mail, Drive, calendar, browser output produced
  under a Claude model) replayed them verbatim to the OpenAI API, Alibaba and Z.AI after a
  `/model` switch. One shared function (`src/adapters/mcp-history.ts`) now runs on both wire paths,
  the chat-completions translation and the Anthropic passthrough. An `mcp__` `tool_use` (and a
  server-side `mcp_tool_use`) becomes a text block naming the tool, and the input is not carried.
  Its `tool_result` (matched by `tool_use_id` across the request, and any `mcp_tool_result`)
  becomes a text block naming the tool. A `tool_result` no `tool_use` accounts for is withheld as
  "an unidentified tool". A result placeholder that would precede a surviving `tool_result` moves
  behind it, so the chat lane never splits `tool_calls` from its tool messages. Non-MCP pairs and
  untouched histories cross unchanged (the same array when nothing is withheld).
- D2-03 (medium): on the OpenAI API lane a `tool_addition` block became the text
  `[tool_addition block omitted by the router]` in the system prompt and its definition never
  reached `tools`, so a deferred tool Claude Code loads mid-conversation was unreachable. The fold
  is now one function (`src/adapters/tool-addition.ts`) shared with the passthrough lanes: a
  non-`mcp__` definition joins the outgoing tools (deduplicated against the tools this lane
  actually offers, so a deferred stub does not hide the full definition), `mcp__` definitions are
  withheld, the block's `cache_control` is not copied and no placeholder text is left. The
  omitted-block placeholder keeps a test arm of its own, reached through a non-text block in a
  `tool_result`.
- D2-05 (medium): an OpenAI-style server that fails after the headers are out sends
  `data: {"error":{"message":...,"code":...}}` with no `choices`. The SSE translator reported
  every such record as "emitted an invalid chat completion chunk" (502) and dropped the upstream's
  reason: a context overflow could not be told from a router bug, and the client retried a
  deterministic failure. The error object now becomes a `RouterError` that quotes the upstream
  message the way the HTTP-status path quotes a body: lane keys scrubbed (the OpenAI API
  lane passes its key through the new `secrets` stream option), whitespace collapsed, bounded to 300
  characters. Classes follow the HTTP path: a 400/413/422 code (number or numeric string), or a
  type or code naming a context-length or invalid-request condition, is a 400-class
  `invalid_request`; 429 is `provider_rate_limited`; anything else stays 502. A record that is
  neither a chunk nor an error object keeps the invalid-chunk error.
- D2-06 (low): every finish reason other than `length` and `tool_calls` collapsed to `end_turn`,
  so an answer the provider filtered halfway looked like a finished turn. `content_filter` is now
  Anthropic's `refusal` on the streaming and the non-streaming path (one shared mapping); every
  other finish reason maps exactly as before.
- D2-08 (low): B08 bounded the agent lanes' `input_tokens` at `ceil(bytes / 3)` because Claude
  Code read bytes as tokens; `output_tokens` was still the raw UTF-8 byte count, feeding the same
  context gauge. `localUsage` now applies the same bound to output (`ceil(bytes / 3)`, minimum 1)
  on every path that calls it: text-only and tool-loop, streaming and not. Provider-reported usage
  is still preferred when the agent supplies it.
- Evidence. D2-01: all three API-key lanes against one fixture (markers absent from the serialized
  body, placeholders present, an ordinary `Read` pair intact) plus edge shapes on both
  translations (`test/mcp-history.test.ts`, `test/mcp-history-fixture.ts`). D2-03: new arms on the
  chat-completions lane; `scripts/test-tool-addition-mutations.mjs` follows the fold into its new
  module, re-points the omitted-placeholder mutant and adds seven mutants for the chat path and
  the MCP history rule: every mutant is caught and the sources are restored byte-exact. D2-05:
  direct arms on the stream translator (`test/openai-sse-error.test.ts`: classes, bound,
  redaction, string-valued error, negative controls, `onComplete` exactly once) and one arm on
  the OpenAI API lane proving its key is wired (the arm fails when the wiring is removed). D2-06:
  `test/openai-finish-reason.test.ts`, both paths for `content_filter` plus negative controls
  pinning `stop`, `length`, `tool_calls`, an unlisted reason and a missing reason. D2-08:
  `test/agent-output-usage.test.ts`, a 3,000-byte answer reports 1,000
  on all four paths, two-byte characters count as bytes (6,000 -> 2,000), rounding up, and the
  minimum of 1.
- Not covered: the commits record unit and mutation evidence only; no live provider call is
  recorded for these five.

### Fixed: one stale catalog answer no longer drops the Grok lane (2026-11-15)

- Measured 2026-11-15: `doctor --live` filed the xAI lane as `auth_required`, "not in live
  catalog", while the contract model was listed. The Grok CLI answers the first `initialize` after
  a period of disuse from its on-disk `models_cache.json` and refreshes the file in the
  background; the next call (during which the file's mtime moved) returned `grok-4.7` at the
  pinned window. The same false alarm dropped the lane from the snapshot on 2026-09-13 and
  2026-10-19.
- The catalog is asked for once more, after a 2 s pause, when the contract model is missing
  (`grokCatalogAfterCacheRefresh`). Two attempts, never more; a model that is really gone or
  listed at another window is still reported.
- A catalog that arrived without the contract model is filed as `unavailable` with `oauthReady`
  true, not as `auth_required`: the login works, the catalog disagrees.
- Detail codes no longer carry a model generation (`grok_acp_live_catalog_verified`,
  `grok_contract_model_not_in_live_catalog`, `grok_acp_snapshot_verified`); the old ones still
  said "4_6 ... 500k" after the contract moved to `grok-4.7` at 256k.
- Evidence: `test/grok-catalog-refresh.test.ts`, 5 arms.

### Changed: Antigravity CLI pin 1.5.9 (2026-11-15)

- `config/install-lock.json` now pins `agy` 1.5.9 (was 1.3.1), downloaded from the URL in the
  source manifest (`antigravity-cli-auto-updater` `manifests/windows_amd64.json`, version 1.5.9).
  The sha512 of the download equals the manifest value (128/128 hex); Authenticode `Valid`,
  signer `CN=Google LLC`. Installed beside 1.3.1 under `providers/antigravity/versions/1.5.9`
  (1.3.1 left in place).
- Measured 2026-11-15 with this pin, from the development tree: `doctor --live` rc 0; the Google
  lane live-verified on `gemini-3.8-flash-high`, `gemini-4-argon-high`, `claude-opus-5-5-high` and
  `claude-sonnet-5-5-high` (`gemini-3.1-pro-high` is still not in the catalog). All eight flags
  the headless bridge passes are present in 1.5.9's `--help`. The owner's seven linked identity
  files were byte- and mtime-identical before and after the five live probes.
- New in 1.5.9 and not used yet: an `acp` subcommand (Agent Client Protocol stdio server),
  `--settings`, `--mode auto`.

### Fixed: a routed Antigravity session is not killed at five minutes (2026-11-15)

- Measured (audit D2-02, reproduced by test before the fix): the routed Google session inherited
  the one-shot default of 300 s as both the runner's kill timer and `agy`'s own `--print-timeout`.
  In that lane one `agy` process holds a whole agentic task and blocks in the router's tool bridge
  while Claude Code runs a tool or waits on a permission prompt, so model time, every tool run and
  every prompt counted against one five-minute budget. A task with a test run in it was killed and
  restarted over a compiled history with its in-session context gone.
- A call with a tool endpoint now gets its own backstop (`sessionProcessTimeoutMs`, six hours) and
  `agy`'s `--print-timeout` follows it. What ends a stuck turn there is the router's request
  guard, and what ends an abandoned session is the registry's idle sweep. A one-shot call keeps the
  five-minute default and the ten-minute ceiling.
- Evidence: `test/antigravity-session-timeout.test.ts`, 3 arms.
- Not covered: that `agy` accepts a print timeout of this size on the live binary. The commit
  says it was measured separately and does not carry the measurement.

### Fixed: the supervisor sweeps what a killed session leaves behind (2026-11-15)

- Measured (audit D1-07, reproduced by test before the fix): a session removes
  `sessions/<id>.json` and its Clodex capsule in a `finally`; a killed router, a closed terminal
  window or a crash skips it and nothing removed the leftovers later. They accumulated without
  bound, and once 256 dead state files existed `doctor` stopped probing the rest and could report
  a live session as stopped.
- Session state files whose IPC endpoint no longer answers are removed at launcher start (files
  younger than 30 s are kept: a session may be starting or stopping). Discovery takes the newest
  256 state files instead of the first 256 by name, so a live session cannot be crowded out. A
  Clodex capsule directory records its owner; capsules whose owner process is gone are removed
  before a new capsule is made, and a capsule owned by a running session is left alone. The
  owner-record sweep the Antigravity call homes already had moves to
  `src/runtime/owned-directory.ts` and serves both; there is one implementation.
- Evidence: `test/session-sweep.test.ts` (5 arms); the existing call-home and capsule tests pass
  unchanged. The commit records test evidence only.

### Fixed: core audit repairs (receipt reader, local-failure naming, startup causes, unreadable release, log and scan bounds) (2026-11-15)

Repairs from the independent audit of the core slice (2026-11-15). Each was seen failing in
`test/core-audit-regressions.test.ts` (or in the scan's own self-check) before the change.

- D1-02: the receipt reader accepted four credential classes while the writer produced six, so
  `claude-oauth receipt` called a well-formed file malformed after any request on an API-key or
  ChatGPT Web lane. The classes are one exported list (`OAUTH_TYPES`) shared by the snapshot
  validator and the receipt reader.
- D1-03: a local failure on the CLI path (a missing `claude.exe`, a lock that does not parse) was
  printed as `upstream_protocol_error`, "the provider returned an invalid response".
  `normalizeCliError` now names a file-system failure by errno code, system call and path under
  the new code `local_failure`; a foreign error contributes its name only, never its message.
- D1-04: the serving path swallowed every OpenAI-lane startup failure into one readiness code and
  logged nothing. The cause (code and the author-written remedy, bounded) is now filed as
  `provider_start_failed`.
- D1-06: `prepareEffectiveInstallation` refused only a release whose hash mismatched; a release
  that could not be hashed at all was launched. `requireReleaseIdentity` refuses both.
- D1-08: `router.log` rotates to `router.log.previous` past 8 MiB; the size is tracked in memory
  after one `stat` per process.
- D1-09: the secret scan read `src`, `test`, `scripts` and `config` only, so 25 of 159 tracked
  files (the shims, docs, workflows and root documents) were never visited. Its reach is the
  tracked tree now, and the self-check walks a real temporary tree instead of feeding text to the
  regexes.
- Evidence: gate `npm run check`: 829 tests, 828 pass, 0 fail, 1 skipped; lint 0; secret scan 158
  files, 0 findings; self-check rc 0.

### Added: the Claude Code pin follows a vendor-signed update on its own (2026-11-15)

- Measured: Claude Code updates itself, the exact-hash pin then refuses to launch, and someone
  has to re-pin and cut a release. It happened at 2.1.252, 2.1.270, 2.1.283, 2.1.284, 2.1.289,
  2.1.302, 2.1.316, 2.1.319 and, on the morning of this change, 2.1.325 (`doctor` rc 2,
  `locked_hash_mismatch`). The owner asked for the pin to follow the update without a person
  in the loop.
- `config/install-lock.json` may now carry `claude.vendorSignature`
  (`platform`, `signerCommonName`, `signerOrganization`). When the bytes on disk are not the
  pinned bytes, `src/runtime/claude-vendor-update.ts` accepts the new binary for the run only if
  all of these hold: the policy names this platform; the binary reports a version that is not
  below the pinned one; Windows Authenticode says `Valid`; the signer subject has exactly one
  `CN` and one `O`, each equal to the policy; and the bytes hash the same before and after the
  verdict. Anything else leaves the lock as released, so the launch is refused exactly as
  before, now with a named reason (`vendor_update_signature_not_valid`,
  `vendor_update_signer_mismatch`, `vendor_update_version_below_pin`,
  `vendor_update_version_probe_failed`, `vendor_update_signature_probe_failed`,
  `vendor_update_binary_changed_during_verification`) and a remedy in `doctor` and `router.log`.
- The policy sits inside the hashed `config/`, so it cannot be loosened without a new release.
  The acceptance record (`<runtime root>/claude-vendor-update.json`) sits outside the release;
  it only saves the next launch a signature probe and is compared on bytes, path, version and
  signer before it is believed. Every other pinned component keeps its exact hash. Without the
  field, or on a platform the policy does not name, the pin is exact-hash only, as before.
- `doctor` gains `claudeVendorUpdate` (`pinned` | `accepted` | `refused` | `not_applicable`) and
  labels the `claude` check `signed_vendor_update_accepted` when the match exists because an
  update was accepted.
- Evidence. Unit: `test/claude-vendor-update.test.ts`, 37 arms, injected probes. Mutation:
  `scripts/test-vendor-update-mutations.mjs`, 19 mutants, each caught. Live, real binaries and
  the real Authenticode probe (2026-11-15): signed 2.1.325 under a 2.1.319 pin accepted in
  2.4 s and from the record in 0.5 s; a copy with one byte flipped refused (`HashMismatch`); a
  non-PE file refused (`UnknownError`); a validly signed binary of another publisher refused
  (`vendor_update_signer_mismatch`); 2.1.319 under a 2.1.325 pin refused (below pin).
- Not covered: macOS and Linux have no policy (no signed binary was available to measure), so
  the pin stays exact-hash there. A Claude Code update can still change request shapes a lane
  depends on; the policy keeps the launcher working, it does not review the new version.

### Fixed: the Anthropic-passthrough lanes fold `tool_addition` blocks before sending (2026-11-09)

- Measured: every live call through the new `alibaba` lane failed with HTTP 400
  `InvalidParameter` / "Request body format invalid". Claude Code (with the
  `mid-conversation-tool-changes-2026-07-01` / `inline-tools-2026-09-15` betas) puts a
  `role: "system"` message INSIDE `messages` whose content mixes text with `tool_addition`
  blocks; Alibaba's Anthropic endpoint rejects the whole forwarded body while even one is
  present (bisect evidence, keys redacted: `tasks/2026-11-09-router-alibaba-zai/kanit/bisect/bisect3-router-govde.json`
  and `bisect3-router-govde1-defer.json` — the forwarded body 400, the same body with only the
  `tool_addition` blocks removed 200; `defer_loading`, `context_management`, `output_config` and
  the 1h `ttl` are all accepted with them gone). The `zai` lane shares the passthrough and the
  defect (masked on 2026-11-09 by Z.AI's 429/1113 balance exhaustion).
- `passthroughEnvelope` now removes every `tool_addition` block from message content arrays. A
  removed block's `tool.definition` joins the outgoing `tools` (deduplicated by name, the block's
  `cache_control` not copied); `mcp__*` definitions are withheld under the same data rule as the
  `tools` array; a message left with no blocks is dropped; the empty-`tools` rule (drop `tools`
  and `tool_choice`) still applies. No other block type is interpreted. The openaiapi
  lane was measured NOT affected: `openai-message-map.ts` turns such a block into the
  `[tool_addition block omitted by the router]` placeholder in the system prompt (pinned by a
  test; it does not throw), so it is unchanged.
- Tests: 11 new arms (10 in `test/alibaba-zai.test.ts`, 1 in `test/openaiapi.test.ts`), including
  a fake upstream that answers the measured 400 body whenever the received JSON still contains
  `tool_addition` (loopback http server, no network; control arm proves the 400 branch is live).
  Mutation evidence: `scripts/test-tool-addition-mutations.mjs`, 9 mutants, each caught by the
  new tests (`.astra-review/tool-addition-mutations/results.json`).

### Added: three API-key lanes — Alibaba Token Plan, Z.AI, OpenAI API (2026-11-09)

- `alibaba` (`https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages`),
  `zai` (`https://api.z.ai/api/anthropic/v1/messages`) and `openaiapi`
  (`https://api.openai.com/v1/chat/completions`) are router-held-key lanes. The first
  two pass Anthropic Messages through unchanged (model swap, fresh headers, `x-api-key`,
  `metadata` dropped); `openaiapi` translates Messages to chat completions
  (`authorization: Bearer`, `max_completion_tokens` instead of `max_tokens`, which the reasoning
  gpt-6 family requires). The existing `openai` (ChatGPT OAuth / clodex) lane is untouched. 18
  new catalog rows (`anthropic-alibaba-*` x13, `anthropic-zai-*` x2, `anthropic-openaiapi-*` x3);
  `glm-5.3` stays distinguishable across the Alibaba and Z.AI lanes by full id.
- Keys are read per call from the dotenv file named by the lane's `<KEY>_FILE` variable
  (`alibaba` and `zai` also from `<KEY>` in the router environment). `openaiapi` reads the FILE
  only: `OPENAI_API_KEY` in the router environment is an api-key selector the router refuses to
  start under. All lane
  variables join `ROUTER_OWNED_SECRET_VARIABLES`; no child process, log line or error message
  ever sees a key value. The client's OAuth `authorization` and `anthropic-beta` flags are
  physically never forwarded on any of the three lanes (fresh headers only).
- MEASURED (2026-11-09, evidence under the task's `kanit/`): Z.AI HTTP 429 with code `1113`
  ("Insufficient balance or no resource package") maps to the named state
  `zai_balance_insufficient` — readiness `blocked`, rows kept, one-line recharge remedy; OpenAI
  HTTP 429 `insufficient_quota` / `credit_balance_exhausted` maps to `openaiapi_credit_exhausted`
  with the billing remedy. Missing keys map to `alibaba_key_missing` / `zai_key_missing` /
  `openaiapi_key_missing`. The refresh probe is a model list plus ONE tiny chat probe per lane:
  the list alone answers 200 while chat calls fail (both providers measured that way).
- UNVERIFIED (stated, not measured): every context window except `gpt-6-astra`'s
  (1,050,000 in / 128,000 out, from the OpenAI model card, `[1m]` picker suffix, auto-compact
  220,000 below the 272K pricing boundary) takes a conservative default
  (262,144 in / 200,000 auto-compact); none of the three model lists publishes a context window,
  and no number was invented. Alibaba's seven media models (wan2.7-image, wan2.7-image-pro,
  wan3.0-video, qwen-image-3.0-pro, qwen-audio-3.0-{tts-plus,realtime-plus,asr-flash}) are not
  added: not Messages-protocol chat models.
- Data rule (README): sensitive, clinical, client, human-subject or otherwise private data is
  not routed to these lanes; `mcp__*` tools are never advertised on any of them.
- The Anthropic<->OpenAI chat translator (`openai-message-map.ts`, `openai-sse.ts`) that
  `openaiapi` uses takes its lane differences as options: it drops thinking blocks from replayed
  history, does not emit upstream reasoning as unsigned thinking blocks, advertises only client
  tools, ignores vendor keys inside `usage`, and merges a `role: "system"` entry inside `messages`
  (Claude Code adds one for a model id it does not recognise) into the leading system prompt
  instead of refusing it.
- Tests: 73 new arms in `test/alibaba-zai.test.ts` and `test/openaiapi.test.ts` — header
  non-leak (negative arm, both lane shapes), missing-key states, `1113`, credit exhaustion,
  mcp__* filtering, snapshot derivation with negative arms, parser credential mix-ups, discovery
  `[1m]`, translation round-trips (text and one tool call, streaming and non-streaming), key-file
  resolution, environment stripping, and one real
  `FixedOriginFetchTransport` loopback http server per adapter (no network). Mutation evidence:
  `scripts/test-alibaba-zai-mutations.mjs`, 13 mutants, each caught by the new tests
  (`.astra-review/alibaba-zai-mutations/results.json`).

### Added: `argon` contract row, Gemini 4 Argon High (2026-10-18)

- `anthropic-google-gemini-4-argon-high` (alias `argon`) joins `AGENT_MODEL_CONTRACTS`. Measured with
  `agy models`: `gemini-4-argon-{low,medium,high}` are listed. Before this, `antigravity --model
  gemini-4-argon-high` was refused locally (`model_not_available`). Argon's context window is not
  published by the catalogue or the models page, so the shared Antigravity constants are inherited.
- Picker needles, local patch row and its `localPatchSha256` pin follow.
- The Grok 4.7 contract (256000-token catalog window) was re-measured against the live catalog and
  is unchanged.

### Changed: Claude via Antigravity moves to 5.5; new `sonnet-google` lane (2026-10-05)

- `opus-google` now routes `claude-opus-5-5-high` (id `anthropic-google-claude-opus-5-5-high`);
  new alias `sonnet-google` routes `claude-sonnet-5-5-high`. Measured with `agy models` on a Google
  AI Ultra account: the 5.5 rows are listed and `claude-opus-4-6-thinking` is not; Antigravity's
  models page removes the 4.6 rows on 2026-11-02 and offers 5.5 on Pro (non-trial) and Ultra only.
- `claude-oauth gemini|opus-google|sonnet-google` read their upstream model from the contract
  instead of a literal; the `antigravity --model` help line lists the contract's allow list.
- Snapshot change: the old `anthropic-google-claude-opus-4-6-thinking` row disappears, so the
  first `models refresh` after upgrading needs `--allow-shrink`.

### Added: ChatGPT Web lane through Agent Web Bridge (2026-09-13)

- New provider `web`: a proxy adapter in front of Agent Web Bridge, a loopback daemon that
  drives the operator's signed-in ChatGPT tab in their own Chrome. Five picker rows keyed to
  the bridge's effort profiles (instant, medium, high, extra-high, pro) with the window
  ChatGPT enforces on a Pro account (111,193 tokens, auto-compact 95,000), read from the
  codex-chatgpt-web reference source rather than assumed.
- Readiness is three named facts, each with a remedy: bridge daemon on 8765, tunnel-client
  `/readyz`, Chrome CDP on 9222. Rows enter the snapshot only when all three pass.
- The adapter strips the fields the bridge refuses, forces `tool_choice: auto`, answers
  `count_tokens` locally, maps the bridge's 423 pause to a reconcile remedy and its 413 to a
  400 naming the real limits (`max_body_bytes`, `max_prompt_bytes`, the ChatGPT window).
- Measured: a print-mode `Return exactly PONG` through the router returned `PONG` in 40.2 s
  with the bridge ledger at `COMPLETED`, `send_attempts=1`. A full vault session does not fit:
  its first request exceeds the bridge's 2,000,000-byte body limit, so the lane is usable from
  lean sessions until a context-fit step exists on the bridge side (open).
- The adapter advertises only the tools the bridge auto-approves, read from the bridge's
  `/health` (`auto_approved_tools`) at readiness and lazily before the first send. Measured
  2026-09-13 22:07 in a vault session: `Skill` had no bridge rule, sat in PROPOSED for ten
  minutes while the remote tool call timed out twice, and the turn died of
  completion_contract_missing. A bridge without the field leaves the list unfiltered.
- Claude Code's session-title side request (system "You are naming a coding session", one
  user message wrapping the prompt in `<session>`, no tools) is answered locally from the
  prompt's first line in the `{"title": ...}` shape the model was returning. Measured
  2026-09-13 22:37: through the bridge it was a second ChatGPT conversation started in the
  same second as the real turn; the title completed and the real turn's page load met HTTP
  429, which paused the bridge. Tools present, more than one user message, or no `<session>`
  block: forwarded unchanged.
- Claude Code's quota probe (one user message `quota`, no tools, no system) is answered locally
  too; measured 2026-09-14 it was a 16 s ChatGPT conversation of its own.
- A second claude-oauth window (router on an ephemeral port) keeps not overwriting the first
  window's /model picker cache (A3); the launcher now prints that remedy to the terminal as well,
  since the log line alone read as a bug in the second window.

### Added: live text on the agent lanes (xai, google) (2026-09-14)

- The text an agent has produced so far is streamed as it grows (session registry polls the
  run handle every 250 ms; the adapter opens the message on the first character). Measured
  2026-09-13: grok steps of 17 to 118 s showed nothing until they ended. The tail and the
  tool_use block close the same message; a bare tool call or a non-streaming client keeps
  the old shape. No provider bridge changes.

### Fixed: Grok context gauge; subagent cap configurable (2026-09-14)

- `anthropic-xai-grok-4.6` is advertised as `anthropic-xai-grok-4.6[1m]`. Claude Code knows only
  the 200k and 1M buckets and ignores discovery's `context_window`; measured 2026-09-14, the
  same conversation read 17% on a 1M lane and 85% on Grok, and a 500k model was compacted at
  ~140k real tokens. Any agent lane above 200k now takes the suffix; the router's 350k
  auto-compaction (at launch) and Grok's own 85% trigger bound the 1M bucket.
- The live-subagent cap (one provider process each) is 6 by default and
  `CLAUDE_OAUTH_MAX_AGENT_SESSIONS` overrides it; the 503 names the variable. A five-agent
  Workflow fan-out hit the old fixed 4.
- Documented: Workflow `agent({ model: "grok" | "gemini" })` runs the subagent on that lane
  through the router alias table (measured by the operator's sessions); the `Agent` tool's
  `model` enum does not take vendor aliases.

### Added: Grok's native reads and tool calls in router.log (2026-09-14)

- The router serves Grok's own `fs/read_text_file` requests and, until now, recorded nothing
  about them. Measured 2026-09-14 11:53-11:59: two Grok turns of 85 s and 108 s announced a
  file scan, parked no bridged call, and Claude Code's gauge did not move; the reads had gone
  into Grok's own session. Each native read is now `agent_native_read` (path relative to the
  workspace, bytes served) and each native tool call `agent_native_tool_call` (ACP kind);
  never content, never a command. The `agent_tool_call_parked` remedy no longer reads a
  missing parked call as "the lane is not connected". README: the two contexts on the xAI
  lane and what the reported `input_tokens` on it measures. Test:
  `test/grok-native-activity.test.ts`; mutation control (event renamed) fails it.
- Measured live 13:05-13:23 on the first release carrying the event: a four-agent Workflow on
  Grok logged 264 native tool calls and 0 `agent_native_read`; grok reads with its own tools,
  not through the router's ACP file handler, and 262 of the 264 carried ACP kind `other`. The
  record now names the tool from xAI's `x.ai/tool` descriptor (`read_file`, `bash`, ...) and
  falls back to the ACP kind; title and rawInput still never reach the log. Mutation control
  (descriptor lookup removed) fails the test.

### Fixed: library console output on the TUI; system prompt repeated on every tool result (2026-09-14)

- grok 1.0.30 answers with JSON-RPC ids it invents (`skills-reload`, `workflows-reload`) and
  the ACP SDK's `console.error` reached the terminal under the Claude Code TUI. The launcher
  now files every library console call in router.log as `library_console`; nothing reaches
  the terminal.
- A continuation (tool result) no longer re-sends the whole system prompt to the agent session
  that already holds it; only trailing system records and the instruction blocks around the
  tool result travel (B03). Measured on grok: "a full system dump rides on the Skill response".

### Changed: grok pin 1.0.25 to 1.0.30, grok self-update off (2026-09-13)

- The grok CLI's own `auto_update = true` replaced the pinned binary at 21:22 (1.0.25 ->
  1.0.30, `04b7ffed98c6`) while the operator was signing in; every launch after that logged
  `grok:drift:locked_hash_mismatch` and the xai row left the picker. The detector did its job;
  the class remedy is the CLI's `auto_update = false` in its config.toml, the lock is
  re-pinned from the binary on disk, and the row returns through a fresh release.

### Changed: claude pin 2.1.257 to 2.1.270 (2026-09-13)

- Claude Code updated itself; the lock refused every launch, as designed. The sha256 was
  recomputed from the binary on disk.

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

[2.0.0]: https://github.com/OnourImpram/claude-oauth/releases/tag/v2.0.0
[0.1.0]: https://github.com/OnourImpram/claude-oauth
