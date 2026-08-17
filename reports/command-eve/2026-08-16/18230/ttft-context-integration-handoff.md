# Command EVE 1.822.5 → 1.823.0 TTFT/context integration handoff

Updated after adversarial remediation: `2026-08-16T16:05:07Z`

Issues: `MAT-1624`, `MAT-1783`

Canonical input:
`/Users/mathiasheinke/Developer/.agent-sandboxes/company-os/eve-18225-stable-release-receipt/reports/command-eve/2026-08-16/18230/00-handoff/ttft-18225-to-18230-handoff.md`

This is a source and provider-free verification receipt. It is not package,
runtime, provider, billing, release, merge, deploy, sign, notarization, R2, or
Linear-Done authority.

## Repository receipts

| Repository | Isolated branch                         | Exact base                                 | Intended source write set                                                                                                                                                            |
| ---------- | --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AionUI     | `codex/eve-18230-ttft-context-aionui`   | `2c7d4e7547f0dac8652e7bdc949b69d998939ea1` | ACP marks/status/correlation, benchmark/formal/Golden Set harnesses, local Ollama usage normalization, focused tests, this receipt                                                   |
| Hermes     | `codex/eve-18230-ttft-context-hermes`   | `9b9dc0d2e7a36fa00898892992d496a5d61c333b` | Common provider-call receipt and validation, final OpenAI/Codex/Bedrock/Anthropic/Gemini seams, ACP loopback header fence, MoA/multi-attempt rejection, and focused tests (12 paths) |
| AionCore   | `codex/eve-18230-ttft-context-aioncore` | `8c2e7c344f2e50493ec3427625f13715b1e6599c` | none; existing task-ready and warm-session log seams are consumed                                                                                                                    |

The pre-existing AionUI integration worktree with 274 staged paths was not
modified. GitNexus-generated `AGENTS.md`, `CLAUDE.md`, and `.claude/` changes
are stewardship artifacts and are excluded from commits.

Hermes remediation head: `00afd5f27c759a8de131e0154de0dfd684dd1ddb`.
It is the amended single successor to `d8e68536739fb0cab68a8d4df4ab577ab7677a60`.

## Re-anchoring onto the integration base

The lane originally branched from `2f30231bc`, which is not an ancestor of the
integration head. It was rebased with `--onto 2c7d4e754`; `2c7d4e754` is now an
ancestor of the lane head and `git merge-tree` against the integration head is
conflict-free.

`AcpSendBox.tsx` was the only conflicting file, because the integration side
rebuilt it (+765/-285) while this lane instrumented it. The instrumentation was
re-placed against the rewritten send path rather than merged line-wise:

| Mark                                                                         | Placement in the new path                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit_started` + `beginSubmitActivity`                                     | Immediately after the single `issueSendAttempt()` inside `executeCommand`, which is now the only send-attempt choke point and serves both the direct send and the queue drain |
| warmup disposition (`warmup_joined` / `runtime_resident` / `warmup_started`) | Before the grounded/ungrounded warmup branch, still reading `getWarmupConversationStatus`                                                                                     |
| `warmup_ready` / `warmup_failed` / `warmup_timeout`                          | On both warmup branches, unchanged in meaning                                                                                                                                 |
| `turn_admitted` + `bindSubmitActivityTurn`                                   | Directly after `markSendAccepted`, so admission still cannot precede the accepted ACP result                                                                                  |
| `request_accepted`                                                           | Retained, now carrying the attempt/seat correlation fields                                                                                                                    |
| `clearSubmitActivity`                                                        | Kept in `finally`, still guarded by `!sendAccepted`, and the reducer's `attemptId` fence is unchanged                                                                         |

No marker was dropped: every stage from the original commit has an exact
equivalent in the rewritten path. Image and video CREATE sends return before
`executeCommand` and never open an ACP turn, so they correctly emit no submit
marker; Word, Excel, PDF and presentation sends do route through
`dispatchMessage` into `executeCommand` and are covered by a new regression
test asserting exactly one `submit_started` and no foreign-attempt clear.

## TTFT package state

| Package | Provider-free source state                                                                                                                                                                                                                                             | Remaining evidence gate                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| TTFT-0  | Eight-group, content-free, exact conversation/submit-attempt/admission/turn/message correlation implemented; foreign admission, finish, output, provider call, duplicate call, and every modeled negative chronology are rejected explicitly                           | Packaged capture must supply exact AionCore readiness and one uniquely correlated final-provider receipt                                      |
| TTFT-1  | The final provider-call receipt binds turn, 1-based call index, request id, exact request hash, exact response-usage hash, and attempt count; strict schemas reject content, malformed hashes, bucket mismatch, under/over-attribution, and stale/multi-call ambiguity | Authenticated provider/cache/billing values remain unmeasured; the local Ollama runtime truthfully reports reuse as unavailable               |
| TTFT-2  | Golden Set categories, duplicate-ID rejection, full artifact commits, strict provider-receipt identity, and fail-closed parity/cold-token gate implemented; no capability-profile shortening in this slice                                                             | Real baseline/candidate outputs and verifiable provider reuse evidence must prove ≥30% reduction and model p50; unavailable reuse cannot PASS |
| TTFT-3  | Submit/warmup join/resident/ready/fail/timeout stages and existing AionCore warm-session seam are wired into the collector                                                                                                                                             | Packaged cold/warm/new-chat samples, and cloud p50 only after explicit authenticated-measurement approval                                     |
| TTFT-4  | Stable/session/tool prefix fingerprints, sticky-route comparison, cache attribution, and content-free cost reconciliation implemented                                                                                                                                  | Exact provider cache read/write and billed-cost receipts require authenticated measurement                                                    |
| TTFT-5  | Ephemeral `submitting` status is marked at DOM commit, correlated to the submit attempt, and formally gated at ≤150 ms; it is never relabeled as thinking                                                                                                              | Packaged UI sample must prove the ≤150 ms gate on the integration candidate                                                                   |

## Source verification

AionUI focused suite:

```text
./node_modules/.bin/vitest run \
  tests/unit/command-eve/ollamaOpenAiShim.test.ts \
  tests/unit/renderer/useAcpMessage.dom.test.ts \
  tests/unit/renderer/AcpSendBox.dom.test.tsx \
  tests/unit/renderer/acpPerformanceMarks.dom.test.ts \
  tests/unit/renderer/acpRuntimeStatus.dom.test.tsx \
  tests/unit/scripts/commandEveTtftFormal.test.ts \
  tests/unit/scripts/commandEveTtftGoldenSet.test.ts \
  --reporter=dot --silent
```

Result after remediation: `7/7 files PASS`, `302/302 tests PASS`.

```text
./node_modules/.bin/tsc -p scripts/command-eve/ttft/tsconfig.json --noEmit
```

Result: `PASS`.

Repo-wide AionUI Vitest run:

```text
./node_modules/.bin/vitest run --reporter=dot --silent
```

Result: `732 files / 8398 tests PASS`; `6 files / 14 tests FAIL`; `3 files /
14 tests SKIP`. Five failed files are blocked by the unchanged missing
`serve-handler` dependency. The remaining `provisioner.test.ts` case timed out
under full-suite load, then passed in isolation with `48/48` after `117.19s`.
No failed path is modified by this TTFT remediation.

Repo-wide AionUI TypeScript baseline check:

```text
./node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false
```

Result: `BLOCKED_BASELINE` by seven diagnostics outside every modified path:
`computerUseRuntimeCore.ts`, `hermesNativeKanbanCore.ts` (2),
`autoUpdaterService.ts`, `NativeKanbanBoard.tsx` (2), and missing
`serve-handler` types in `packages/web-host/src/static-server.ts`.

Lint and formatting:

```text
./node_modules/.bin/oxlint <eight changed source/test/report paths>
./node_modules/.bin/oxlint --quiet -f unix
./node_modules/.bin/oxfmt --check <eight changed source/test/report paths>
git diff --check
```

Changed-scope lint has zero errors; its 19 warnings predate the remediation
hunks. Repo-wide lint remains `BLOCKED_BASELINE` by one unchanged
`no-useless-spread` error in
`externalActionExecutionService.ts:1036`. Format and diff checks pass.

Hermes canonical focused suite, independently repeated after commit:

```text
.venv/bin/python -m pytest \
  tests/agent/test_context_breakdown.py \
  tests/run_agent/test_run_agent.py \
  tests/run_agent/test_streaming.py \
  tests/acp/test_server.py -q
```

Result on the final amended commit: `331 passed`, `4 skipped`, zero failures.
`ruff check` on the changed files, `py_compile`, and `git diff --check` pass.
Repo-wide formatting remains blocked by two pre-existing formatter deltas
outside the parity hunks in `context_breakdown.py:1111,1139` and
`test_context_breakdown.py:833,843`.

Inside AionUI the identity grammar now has exactly one definition,
`commandEveProviderCallIdentity.ts`, consumed by both the Main shim header gate
and the TTFT formal validator; the two previously identical regex literals are
gone. It admits 1–256 printable non-space ASCII characters (`0x21` through
`0x7E`), so space, Unicode, DEL, tab, empty and 257-character values are
rejected.

**Correction (1.823.0 candidate).** This section previously claimed
cross-repository parity proven by execution, citing
`tests/integration/command-eve-provider-call-identity-parity.real.test.ts`
against Hermes `agent.context_breakdown._valid_identity_text`. That claim did
not hold for the shipped artifact: no member of
`resources/bundled-hermes/hermes_agent-0.20.0-py3-none-any.whl` defines that
function, so the test could only ever describe a different Hermes tree, and
without `COMMAND_EVE_HERMES_SOURCE` it skipped silently. The wheel carries the
minter (`agent/conversation_loop.py`) and no validator, so there is no second
verdict to compare against. The test has been replaced by
`tests/unit/command-eve/commandEveProviderCallIdentity.test.ts`, which always
runs, asserts that what the wheel mints is accepted here, and fails the day a
Hermes-side validator appears — at which point the real parity test is owed.

Hermes prompt-preservation receipt:

```text
agent/system_prompt.py   worktree/head blob: 3de226531794520f19ce4df642a9ee0c82217f56
agent/prompt_builder.py  worktree/head blob: f234c98c02da94977db4cf17ed354f023da82021
```

No prompt, skill, tool schema, safety, memory, or workspace contract was
shortened by this slice.

GitNexus impact receipts before editing:

- AionUI `emitAcpPerformanceMark`: `CRITICAL`, seven direct callers and six
  execution processes. The implementation is additive: existing stages and v1
  receipt fields remain valid.
- AionUI remaining edited symbols: `LOW` in the focused impact checks.
- Hermes `compute_session_context_breakdown`: `LOW`, three direct callers,
  zero execution processes.
- AionCore: analyzed only; no symbol was edited.

GitNexus detect receipts:

- AionUI original candidate: `CRITICAL`, 104 changed symbols, 24 affected
  execution flows. The complete two-commit integration therefore remains
  conservatively `CRITICAL` because central ACP observer paths are shared.
- AionUI remediation-only final working diff: global CLI detect reports `LOW`,
  113 changed symbols and zero affected flows across 8 files. Many local
  symbols were mechanically reported as `undefined`; this narrower result does
  not supersede the original candidate's CRITICAL integration classification.
- Hermes: final remediation detect is mechanically unavailable. The isolated
  worktree is not indexed; global analyze/detect hit the existing N-API /
  LadybugDB storage-version incompatibility. Source diff and tests were still
  completed without claiming graph closure.

## Executable integration procedure

1. Integrate the single Hermes commit and the single AionUI commit into the
   1.823.0 candidate; retain AionCore `8c2e7c3...` unless another authorized
   integration wave supersedes it.
2. Build a candidate package without changing prompt, skill, tool, safety,
   memory, or workspace profiles.
3. Run the TTFT benchmark. It arms immediately before submit, selects exactly
   one `submit_started` in the actual composer conversation, binds exactly one
   matching `turn_admitted`, rejects foreign admission and pre-arm nodes,
   rechecks the exact output element after both animation frames, and requires
   the exact turn terminal.
4. Normalize one uniquely correlated `Agent task ready`, `ACP session warmed
up`, and strict v3 desktop transport envelope carrying the common
   `command-eve-provider-call/v1` receipt into the formal input, then run:

   ```text
   bun run command-eve:bench:ttft:formal -- --input <capture.json> --output <receipt.json>
   ```

   Only `outcome: PASS` with all eight groups present is formal evidence.

5. For TTFT-1/2/4, capture the baseline/candidate common provider-call receipts
   from the final provider choke point. The Golden comparison verifies their
   exact identities, request/usage hashes, schemas, and usage buckets before it
   computes anything. Then run:

   ```text
   bun run command-eve:bench:ttft:golden-set -- \
     --baseline <baseline.json> --candidate <candidate.json> --output <gate.json>
   ```

   Fixture, malformed, ambiguous, or unavailable token evidence intentionally
   returns `SOURCE_PASS_MEASUREMENT_REQUIRED`, never a performance PASS.

6. Any provider/cache/billing/cloud-p50 run requires a new explicit approval
   naming provider, model, purpose, and cost frame. No such run occurred here.

## Authority boundary

No push, merge, deploy, release, package-signing, notarization, R2 action, paid
or provider-side inference, Plane write, Linear state transition, or Linear
Done action was performed.
