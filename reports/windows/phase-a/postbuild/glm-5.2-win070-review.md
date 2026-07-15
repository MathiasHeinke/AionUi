# GLM 5.2 post-build review attempt

Date: 2026-07-14

Scope: read-only OpenRouter review of the unsigned Windows x64 Phase A implementation after the Fable NSIS hotfix.

## Outcome

Status: `TIMEOUT_INCONCLUSIVE`

GLM 5.2 ran with xhigh reasoning for exactly two hours. It inspected the workflow, gate receipts, convergence logic, credential confinement, safeStorage record compatibility, credit metering, Hermes cancel/restart behavior, artifact transfer and uninstall cleanup. It also exercised convergence and credit-delta helpers with ad hoc read-only probes.

The model did not produce its required final report or completion sentinel. During the final portion of the bounded run it repeatedly revisited the same workflow and gate searches. Codex stopped the process at the two-hour audit boundary. No GLM verdict is treated as PASS and no GLM claim is used as release authority.

The earlier completed GLM pass found two P1 and three P2 items. The current tree contains the corresponding fixes: the PowerShell receipt variable was renamed, credential-format ambiguity now fails loudly, exact sentinel negative tests exist, the credit probe timeout is configurable at 300 seconds, and safeStorage dependency comments and evaluator coverage were added.

Observed runtime: 2:00:00. Codex CLI reported 4,086,790 tokens used before interruption.

Completion sentinel: `GLM_PHASE_A_POSTFIX_REVIEW_TIMEOUT`

## Final evidence rerun

Date: 2026-07-15

Status: `BLOCKED_BUDGET`

The final GLM 5.2 evidence review was routed through the Company.OS external
audit cost router. The preflight reported monthly spend of `$52.619407`
against a `$50` monthly cap, with a `$0.75` reserve, and rejected execution via
`budget_brake_blocked`. No provider call was made and no GLM verdict exists.

Router report:
`reports/model-router/2026-07-15/0910-external-audit-compa-724`. The budget
decision is recorded in `metrics/ai-cost-ledger.jsonl`; it is evidence of a
blocked optional reviewer lane, not evidence about product quality.

This optional arm is therefore recorded as `BLOCKED_BUDGET`, not PASS. Phase A
authority remains the exact Windows runner, Codex adjudication and the Fable 5
Max review.
