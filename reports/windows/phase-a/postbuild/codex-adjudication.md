# Codex Windows Phase A post-build adjudication

Date: 2026-07-14

Scope: unsigned Windows x64 Phase A implementation, reviewer findings, fail-closed proof contracts and local regression gates.

## Reviewer adjudication

- Fable 5 Max found one deterministic P1 in copied-NSIS-uninstaller argument handling. The raw, unquoted and final `_?=` form is now isolated from normal `ArgumentList` use and contract-tested.
- Fable's review-provenance delta found one P2: rejected G00/G01 receipts could retain hardcoded happy-path metrics. Metrics now derive from the exact document checks, failed dimensions become `NOT_RECORDED`, and the negative test covers the failure path. The Fable convergence rerun found no remaining P0, P1 or P2.
- The earlier completed GLM 5.2 pass found credential diagnostics, sentinel coverage and credit-timeout weaknesses. Each was fixed and regression-tested.
- The bounded GLM post-fix pass timed out without a verdict. It is recorded as `TIMEOUT_INCONCLUSIVE`, not PASS.
- Codex found no remaining confirmed P0, P1 or P2 in the reviewed local implementation. The actual Windows runner remains authoritative for PowerShell parsing, packaging, installation, Hermes cloud turns, cancellation, restart and uninstall behavior.

## Local gates

- Focused Windows contract and lifecycle suites: PASS, 6 files and 65 tests.
- Full Vitest suite: 415 files passed, 1 skipped; 4,006 tests passed, 3 skipped.
- TypeScript: PASS.
- Lint: PASS with no errors; existing warnings remain outside this slice.
- Changed-file formatting and `git diff --check`: PASS.
- Reusable, manual and release workflow YAML parse: PASS.

The repository-wide formatter gate has pre-existing debt outside this slice. It must be resolved in a separate mechanical commit before the exact GitHub proof can run; this adjudication does not waive that gate.

Completion sentinel: `WIN_PHASE_A_POSTBUILD_REVIEW_CONVERGED`
