# Codex Windows Phase A post-build adjudication

Date: 2026-07-15

Scope: unsigned Windows x64 Phase A implementation, independent reviewer
findings, fail-closed proof contracts, shared Command EVE `1.8.12` integration,
exact-source GitHub execution and final evidence convergence.

## Final verdict

Verdict: `PASS_AS_WINDOWS_X64_PROOF`

GitHub Actions run
[`29401329864`](https://github.com/MathiasHeinke/AionUi/actions/runs/29401329864)
completed successfully on exact source commit
`66ec41174e35a72db475f30206cd5fe346b1c4d6`. `WIN-G00` through `WIN-G08`,
including `WIN-G06T`, passed on unsigned Command EVE `1.8.12` installer
SHA-256 `683000bb28d31e79fe6404e6df46bb2346a212c61df2399924aded792fca01b5`.
The canonical validators accept every gate receipt; recomputed convergence is
identical to the stored PASS with no missing gate or error.

This verdict is deliberately narrower than `WINDOWS_READY`. The proof ran on
Microsoft Windows Server 2022 Datacenter build `20348`, as an administrator,
with x64, four CPUs and approximately 16 GB RAM. It does not prove Windows 11,
standard-user policy, an 8 GB machine, unmodified Defender/SmartScreen, the
named pilot computer, signing, public updates, rollback or sellability.

## Reviewer adjudication

- Fable 5 Max initially found a P1 in copied-NSIS-uninstaller argument handling
  and a P2 in hardcoded G00/G01 happy-path metrics. Both were fixed and their
  negative paths are contract-tested.
- Fable's broader pass found process-stream drain, Windows ARM64 release-train,
  timeout/Defender scoping, required-gate pinning, update-feed isolation and
  Python `RECORD` false-positive risks. Confirmed findings were fixed before the
  final run.
- Fable's first final review found one remaining P2: the committed Hermes wheel
  was hashed but not pin-enforced. Bootstrap now rejects mismatched bytes with
  `HERMES_WHEEL_HASH_MISMATCH` before pip, G06T binds expected and actual
  SHA-256, and positive plus tamper tests cover the contract.
- The final Fable `1.8.12` delta review independently checked source, GitHub,
  all 25 evidence files, cleanup, updater isolation and the wheel pin. Verdict:
  PASS with zero confirmed P0, P1 or P2 and sentinel
  `FABLE_WINDOWS_PHASE_A_1812_DELTA_CONVERGED`.
- The earlier completed GLM 5.2 pass produced findings that were fixed. Its
  bounded post-fix run remains `TIMEOUT_INCONCLUSIVE`. The requested final GLM
  rerun was stopped before provider execution by the Company.OS monthly budget
  brake and is `BLOCKED_BUDGET`, never PASS.
- Codex independently validated the receipts, convergence, GitHub state,
  installer digest, evidence-secret scan and disposable-seat cleanup. No
  remaining confirmed P0, P1 or P2 was found.

## Exact proof results

- Command EVE `1.8.12` x64 NSIS install, launch, restart and uninstall: PASS.
- Shared macOS `1.8.12` background-update, visual-surface and release-binding
  commits were integrated before the Windows proof: PASS across Linux, macOS
  and Windows quality jobs.
- Pinned AionCore and bundled Python `3.12.13`: PASS.
- Hermes `0.17.0` cloud-turn-holder profile, with wheel SHA-256
  `b5e36fce7a65b202fff54bc0742316748224c11c9061312843aecdd59ec4694d`
  and Ollama/local-model stages skipped: PASS.
- Complete managed cloud answer and post-cancel restart answer: PASS.
- Paid-credit classification and server-side metering: PASS, purchased-credit
  delta `26`, allowance and free-action deltas `0`.
- Provider credential, plaintext test-seat credential and raw-text egress
  scans: PASS with zero findings.
- Process, installation, shortcut and registry residue: PASS with zero
  findings.
- Phase A updater isolation: PASS; packaged URL is
  `https://phase-a.invalid`, not a public update feed.

## Verification ledger

- Focused Windows/runtime/updater suites: 10 files and 205 tests PASS.
- Local full Vitest suite: 419 files passed, 1 skipped; 4,040 tests passed,
  3 skipped.
- GitHub Linux and macOS quality jobs: 419 files passed, 1 skipped; 4,040 tests
  passed, 3 skipped on each platform.
- GitHub Windows quality job: 418 files passed, 2 skipped; 4,024 tests passed,
  19 skipped under platform filters.
- TypeScript, lint, format, i18n, package build and `git diff --check`: PASS.
- Exact GitHub Windows build, packaged lifecycle and summary jobs: PASS.
- Canonical gate validation: G00-G08/G06T all valid; recomputed convergence
  equals stored convergence and ends in `WIN_PHASE_A_CONVERGENCE_COMPLETE`.

## Cleanup

The ephemeral GitHub license secret and temporary mint secret were removed.
The private test-seat state file is absent. The disposable tenant, entitlement,
license, credit, reservation, transaction, usage, profile, membership and invite
records were deleted and all ten exact table counts were re-queried as zero.
Unsigned candidates, standalone marker artifacts and stale evidence were
deleted. GitHub retains exactly one sanitized artifact:
`windows-x64-phase-a-evidence-66ec411`, artifact ID `8338527889`, 25,200 bytes.

## Residual boundaries

Phase B must provide Windows 11 and standard-user evidence, ordinary
Defender/SmartScreen behavior, real pilot hardware, artifact/file/voice/worker
workflows, support diagnostics and the named-pilot acceptance loop. The
first-boot Hermes dependency closure still resolves transitive Python packages
from PyPI over TLS; only the committed Hermes wheel itself is hash-pinned in
Phase A. Signing, public update/rollback, final-byte provenance and commercial
distribution remain Phase C work.

Completion sentinel: `WIN_PHASE_A_POSTBUILD_REVIEW_CONVERGED`
