# Fable 5 Max post-build review

Date: 2026-07-14

Scope: unsigned Windows x64 Phase A proof implementation, followed by a bounded delta review of the final NSIS fix.

## Initial verdict

`FINDINGS`: one P1, no P0 or P2.

The copied NSIS uninstaller received `_?=` through `ProcessStartInfo.ArgumentList`. Because the Command EVE install path contains a space, .NET would quote the argument even though NSIS requires `_?=` to be unquoted and last. The lifecycle would therefore retain installation residue and could never converge.

## Resolution

- Added a mutually exclusive raw-argument path to the PowerShell process helper.
- Kept normal child processes on `ArgumentList`.
- Invoked the copied NSIS uninstaller with raw `/S _?=$installDirectory`.
- Added a quote-character guard and fail-closed error path.
- Added positive and negative contract pins for the raw NSIS form.
- Added Vitest imports for the two remaining TypeScript proof entrypoints.

## Delta review

Fable inspected the current working-tree diff and surrounding implementation, then ran:

```text
bunx vitest run tests/unit/command-eve/windows/windowsBuildWorkflowContract.test.ts
```

Result: 15/15 tests passed. Fable found no P0, P1, or P2 issue in the delta and confirmed that no earlier finding was reopened.

Reviewer runtime: Claude Code v2.1.209, Fable 5, max effort, read-only plan mode, Claude Max subscription lane.

## Review-provenance delta

After the post-build reports were wired into WIN-G01, Fable found one P2: a rejected receipt could still carry hardcoded happy-path metrics. Codex replaced those literals with metrics derived from the exact document checks and added a negative test covering unknown state, missing Codex convergence and an incomplete GLM trace.

Fable re-opened the final implementation and test, reran the focused suite and confirmed:

- WIN-G00 reports a truthful `critical_unknown_count` from zero to two.
- WIN-G01 reports `NOT_RECORDED` for every failed review dimension.
- GLM remains `TIMEOUT_INCONCLUSIVE`, never PASS.
- 15/15 focused tests pass.
- No P0, P1 or P2 remains in the reviewed provenance delta.

Delta completion sentinel: `FABLE_PHASE_A_GATE_DELTA_CONVERGED`

Completion sentinel: `FABLE_PHASE_A_POSTFIX_CONVERGED`
