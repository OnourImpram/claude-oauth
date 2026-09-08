# Contributing

Thank you for looking. This file explains how this repository works, because it works a little
differently from most, and a pull request that ignores the difference will not be merged
however good the code is.

## The one rule everything else follows from

**A rule with no measure will rot, and it will not announce it.**

So in this repository every rule ships with the thing that measures it, and every gate ships
with the thing that proves it can fail. Prose in a README is not a control. A comment saying
"never do X" is not a control. A test, a lint rule, a scan or a hook that goes red when X
happens is a control — and only once it has been shown going red.

Concretely:

1. **Every rule comes with its measure.** If you add a constraint ("the child's stderr must be
   redacted before it travels", "a spawn must have an error listener"), add the test or the lint
   rule that fails when the constraint is broken, in the same change. If the measure cannot be
   built yet, say so in the PR and mark the rule as unmeasured; do not add prose and call it done.
2. **Every gate comes with its negative control.** A gate that has only ever passed proves that
   it has a name, not that it measures anything. `scripts/lint.mjs --ozdenetim`,
   `scripts/secret-scan.mjs --ozdenetim` and `scripts/release-id.mjs --ozdenetim` each inject a
   synthetic defect and confirm the gate catches it. If you add a rule to a gate, add its canary.
   If you add a new gate, add its `--ozdenetim` arm.
3. **A test you wrote and then passed proves less than you think.** For a bug fix, the
   regression test must be shown failing on the old code first. Paste the failing run's
   summary line into the PR description — the number of tests that went from red to green is
   the evidence, not the adjective "fixed".
4. **`npm run check` green, or no PR.** It runs the lint rules, the type-check, the test suite and
   the secret scan. It is the floor, not the ceiling. The test count must not go down; if your
   change makes a test obsolete, delete it in a separate commit with the reason in the message.
5. **A number in a claim was measured in that run.** In commit messages, PR descriptions and
   comments, do not write "384 tests pass" from memory. Run it, then write it. If something
   could not run, write `NOT_RUN` and why — never a silent pass.

## Running the gates

```
npm ci
npm run check                            # lint + typecheck + build + tests + secret scan
node scripts/lint.mjs --ozdenetim        # negative control: each lint rule catches its canary
node scripts/secret-scan.mjs --ozdenetim # negative control: the scanner fires, exemptions hold
```

`npm run check` requires Node 24 (`package.json` says `>=24.0.0`; the runtime gate in
`src/runtime/claude-shadow.ts` pins the exact version in `config/install-lock.json`, which is a
separate and stricter check for the *installed* runtime, not for running the test suite).

Two further gates need inputs that live outside the repository and therefore report `NOT_RUN`
(exit 3) rather than pass when those inputs are absent — that is deliberate:

- `test/gate-negative-control.mjs` needs `CLAUDE_OAUTH_SHADOW_EXE` and `CLAUDE_OAUTH_NATIVE_EXE`.
- `scripts/fidelity-diff.mjs` needs a reference `dist/src` directory as its argument.

## Exemptions

Lint findings are shown as `file:line`. If a finding is deliberate, append a trailing comment
`// lint-izin: <reason>` to the line. The reason must be a real sentence a reviewer can weigh; a
bare marker, a one-word reason, or the marker inside a string literal is rejected — the gate's
own negative control checks all three. Do not translate the marker: `lint-izin:` is a protected
surface.

The secret scan accepts a match only when the *value* has the shape the exemption describes
(sha256 hex or npm SRI in `config/install-lock.json`). Do not widen an exemption to a whole file.

## Protected surfaces — do not change without saying so

Some things in this tree are load-bearing in ways that are not obvious from the diff:

- `config/claude-oauth-local-patches.mjs` — its bytes are pinned by `localPatchSha256` in
  `config/install-lock.json`. Changing a comment fails the integrity test. If you must change
  it, change the pin in the same commit and explain why in the message.
- `config/install-lock.json` — the version and digest pins for the installed runtime.
- `package-lock.json` — the dependency tree. Do not add dependencies; the project deliberately has
  two runtime dependencies and would like to keep it that way.
- `LICENSE`, `NOTICE` — Apache-2.0 and the trademark and third-party notices.
- Behavioural surfaces other tools rely on: the `--ozdenetim` flag, the `lint-izin:` marker, the
  `SADAKAT_LIST_MISSING` environment variable, and agent names ending in `-delege`.

## Language

Code, comments, tests, commit messages, documentation and the site are in **English**. Two
Turkish identifiers survive on purpose (`--ozdenetim`, `lint-izin:`) because tooling outside this
repository reads them; do not rename them.

## Commits

Conventional Commits (`fix(scope): …`, `feat(scope): …`, `docs: …`, `test: …`, `chore: …`). One
logical change per commit. The body says what was wrong, what changed, and how it was verified —
a commit message that would let a reader reproduce the before and the after.

## What is most useful right now

The README lists the open defects by id. The most useful contribution is **reproduction**:
several findings ship with offline, quota-free probes that compile a request body and count what
survives, with a positive control. No model call, no account, no cost. If a probe does not
reproduce on your machine, that is a finding about the probe and worth reporting.

Fixes for the architectural items (B01, B02, G01, N05) are welcome as *proposals* first — they
change the authority or capability contract, and a patch that restores capability without
restoring the permission boundary ships a more powerful hole. Open an issue describing the
contract you intend before writing the code.

## Issues and secrets

Do not include credentials, tokens, account identifiers or machine-specific paths in an issue or
PR. **Report a leak by location and type, never by value.** For anything exploitable, see
`SECURITY.md` and email instead of opening an issue.
