# Command EVE 1.822.5 → 1.823.0 TTFT/context integration handoff

Generated: `2026-08-16T14:04:50Z`

Issues: `MAT-1624`, `MAT-1783`

Canonical input:
`/Users/mathiasheinke/Developer/.agent-sandboxes/company-os/eve-18225-stable-release-receipt/reports/command-eve/2026-08-16/18230/00-handoff/ttft-18225-to-18230-handoff.md`

This is a source and provider-free verification receipt. It is not package,
runtime, provider, billing, release, merge, deploy, sign, notarization, R2, or
Linear-Done authority.

## Repository receipts

| Repository | Isolated branch | Exact base | Intended source write set |
| --- | --- | --- | --- |
| AionUI | `codex/eve-18230-ttft-context-aionui` | `2f30231bc48134a150633f0653aa5dda65e23ff0` | ACP marks/status/correlation, benchmark/formal/Golden Set harnesses, local Ollama usage normalization, focused tests, this receipt |
| Hermes | `codex/eve-18230-ttft-context-hermes` | `9b9dc0d2e7a36fa00898892992d496a5d61c333b` | `agent/context_breakdown.py`, `tests/agent/test_context_breakdown.py` |
| AionCore | `codex/eve-18230-ttft-context-aioncore` | `8c2e7c344f2e50493ec3427625f13715b1e6599c` | none; existing task-ready and warm-session log seams are consumed |

The pre-existing AionUI integration worktree with 274 staged paths was not
modified. GitNexus-generated `AGENTS.md`, `CLAUDE.md`, and `.claude/` changes
are stewardship artifacts and are excluded from commits.

## TTFT package state

| Package | Provider-free source state | Remaining evidence gate |
| --- | --- | --- |
| TTFT-0 | Eight-group, content-free, exact attempt/turn/message correlation implemented; delayed foreign finish/output is rejected | Packaged capture must supply exact AionCore readiness and one uniquely correlated upstream receipt |
| TTFT-1 | Nine prompt/context segment receipts, stable prefix hashes, provider/local cache buckets, cost reconciliation, and ≥95% exact-call coverage gate implemented | Runtime integrator must pass the exact call's usage receipt; authenticated cache/billing values remain unmeasured |
| TTFT-2 | Golden Set categories and fail-closed parity/cold-token gate implemented; no capability-profile shortening in this slice | Real baseline/candidate outputs and exact-call newly evaluated tokens must prove ≥30% reduction and model p50 |
| TTFT-3 | Submit/warmup join/resident/ready/fail/timeout stages and existing AionCore warm-session seam are wired into the collector | Packaged cold/warm/new-chat samples, and cloud p50 only after explicit authenticated-measurement approval |
| TTFT-4 | Stable/session/tool prefix fingerprints, sticky-route comparison, cache attribution, and content-free cost reconciliation implemented | Exact provider cache read/write and billed-cost receipts require authenticated measurement |
| TTFT-5 | Ephemeral `submitting` status is marked at DOM commit, correlated to the submit attempt, and formally gated at ≤150 ms; it is never relabeled as thinking | Packaged UI sample must prove the ≤150 ms gate on the integration candidate |

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

Result: `7/7 files PASS`, `291/291 tests PASS`.

```text
./node_modules/.bin/tsc -p scripts/command-eve/ttft/tsconfig.json --noEmit
```

Result: `PASS`.

Repo-wide AionUI TypeScript baseline check:

```text
./node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false
```

Result: `BLOCKED_BASELINE` by seven diagnostics outside every modified path:
`computerUseRuntimeCore.ts`, `hermesNativeKanbanCore.ts` (2),
`autoUpdaterService.ts`, `NativeKanbanBoard.tsx` (2), and missing
`serve-handler` types in `packages/web-host/src/static-server.ts`.

Hermes canonical focused suite:

```text
HERMES_PYTHON=<existing-dev-venv>/bin/python scripts/run_tests.sh \
  tests/agent/test_context_breakdown.py \
  tests/gateway/test_status_command.py \
  tests/gateway/test_usage_command.py -q
```

Result: `3/3 files PASS`, `22/22 tests PASS`. `ruff`, `ty`, `py_compile`, and
`git diff --check` also pass.

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

Final GitNexus detect receipts on the complete source write set:

- AionUI: `CRITICAL`, 104 changed symbols, 24 affected execution flows. The
  scan counted the GitNexus-generated context files as well as the intended
  slice; those generator files are removed before staging. The risk remains
  conservatively `CRITICAL` because the central ACP observer paths are shared.
- Hermes: `LOW`, zero affected execution processes on the final code diff.
  A later read-only repeat with GitNexus CLI 1.6.5 could not open the existing
  index because its LadybugDB storage version is 40 while the index is version
  42; the successful final detect from the indexing CLI remains the receipt.

## Executable integration procedure

1. Integrate the single Hermes commit and the single AionUI commit into the
   1.823.0 candidate; retain AionCore `8c2e7c3...` unless another authorized
   integration wave supersedes it.
2. Build a candidate package without changing prompt, skill, tool, safety,
   memory, or workspace profiles.
3. Run the TTFT benchmark. It arms immediately before submit, admits only the
   first exact `turn_admitted`, binds the new message identity, rejects nodes
   already present at arm time, waits two animation frames for visibility, and
   requires the exact turn terminal.
4. Normalize one uniquely correlated `Agent task ready`, `ACP session warmed
   up`, and desktop upstream-outcome receipt into the formal input, then run:

   ```text
   bun run command-eve:bench:ttft:formal -- --input <capture.json> --output <receipt.json>
   ```

   Only `outcome: PASS` with all eight groups present is formal evidence.
5. For TTFT-1/2/4, feed the usage object belonging to that same inference call
   to `compute_prompt_cache_attribution(..., usage_correlation="exact_call")`.
   Capture baseline/candidate Golden Set result files and run:

   ```text
   bun run command-eve:bench:ttft:golden-set -- \
     --baseline <baseline.json> --candidate <candidate.json> --output <gate.json>
   ```

   Fixture or unavailable token evidence intentionally returns
   `SOURCE_PASS_MEASUREMENT_REQUIRED`, never a performance PASS.
6. Any provider/cache/billing/cloud-p50 run requires a new explicit approval
   naming provider, model, purpose, and cost frame. No such run occurred here.

## Authority boundary

No push, merge, deploy, release, package-signing, notarization, R2 action, paid
or provider-side inference, Plane write, Linear state transition, or Linear
Done action was performed.
