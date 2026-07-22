# ADR: Command EVE coverage gate — matrix 80 % vs controller baseline

Date: 2026-07-21 (1.818 C3)
Status: PROPOSED — decision pending with the controller (CTO-Seat, via Plane). This note only surfaces the numbers and frames the options; it does not decide.

## Context

The 1.817 release matrix and the repo's actual coverage gates disagree. The
1.817 controller resolved the conflict for 1.817 via an HG-2.5 baseline
decision and explicitly carried the permanent resolution into 1.818.

## The matrix requirement

`Company.OS/.claude/worktrees/author-studio-features/reports/command-eve/2026-07-20/1817/05-regression/s60-s84-release-matrix.md:78-79`

> Coverage must report Statements, Branches, Functions, and Lines at or above
> 80 percent. A missing or undefined coverage measure is a reject.

The 80 % figure appears first in that matrix (plan-generator output), with no
baseline annotation. The matrix itself states it "does not authorize
notarization, R2 writes, or a release-state transition."

## The repo's actual gates (FACT)

- `vitest.config.ts:98-104` — all four thresholds are `0`, with the comment
  "Keeping them informational until coverage ramps up across all files."
- `codecov.yml:19-25` — project status `target: auto, threshold: 1%,
informational: true`; patch status `target: 50%, informational: true`.
- `just push` (repo release-quality suite) contains no coverage gate; 1.816
  shipped under the same doctrine.

## The controller baseline decision (1.817, FINAL)

`.../1817/05-regression/g6-coverage-gate-controller-decision.md` (HG-2.5,
2026-07-20): G6 counts as satisfied when ALL of these hold:

1. all four metrics are defined and fully reported;
2. no regression against the 1.817 baseline `e617c81c` on identical scope;
3. the release delta is covered by focused suites (project-workspace safety
   suite et al.).

Measured numbers (FACT, from that decision + the HG-2.5 controller card):

| Scope               | Statements | Branches | Functions | Lines |
| ------------------- | ---------- | -------- | --------- | ----- |
| Baseline `e617c81c` | 42.47      | 40.06    | 38.64     | 43.14 |
| Freeze `16c1cf70`   | 45.24      | 43.28    | 41.66     | 46.11 |
| Delta (pp)          | +2.77      | +3.22    | +3.02     | +2.97 |
| Final 1.817 card    | 45.62      | 43.59    | —         | —     |

So the product sits at ~45 % statement coverage — about 35 percentage points
(~20k covered lines) below the literal matrix value.

## Options

- **A. Ratify the baseline doctrine in the matrix.** Replace the literal 80 %
  with the controller rule (reported + no-regression + focused-delta
  coverage). Lowest friction; honest about the current ~45 %; keeps the gate
  meaningful instead of aspirational.
- **B. Coverage ramp plan with milestones.** E.g. +5 pp/release on
  `packages/desktop/src/process/services`, tracked via Plane. `vitest.config`
  thresholds are raised only when the measurement surface actually holds them
  (fail-closed, per the controller carry-over — "vitest thresholds erst
  anheben, wenn die Messflaeche die Schwelle tatsaechlich haelt").
- **C. Enforce the literal 80 % now.** Rejected: never enforced by any repo
  gate, ~35 pp gap is a milestone program, not a release gate; enforcing it
  retroactively blocks releases without improving the code.

A and B combine cleanly (ratify doctrine now, ramp as a tracked program).

## Decision

Pending — stays with the controller (CTO-Seat, via Plane), exactly as carried
over in `g6-coverage-gate-controller-decision.md` ("Entweder
Coverage-Ramp-Plan mit Meilensteinen ... ODER Ratifizierung des
informational-Status in der Release-Matrix. Owner: CTO-Seat, via Plane.").

## Consequences (once decided)

- Option A: update the release matrix template so future plan-generator
  output matches the ratified rule.
- Option B: create the Plane work item with per-release milestones before any
  `vitest.config.ts` threshold change; thresholds move only behind measured
  headroom.
