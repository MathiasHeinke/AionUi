# Fable 5 Max Command EVE 1.8.12 Windows Phase A delta review

Date: 2026-07-15
Mode: read-only, Fable 5 Max with bounded final-delta scope

## Scope

- prior reviewed source: `98ac3aff7791d7b8c71dc0d97f6365488f45a80d`;
- final source: `66ec41174e35a72db475f30206cd5fe346b1c4d6`;
- final GitHub run: [`29401329864`](https://github.com/MathiasHeinke/AionUi/actions/runs/29401329864);
- final evidence: 25 sanitized JSON files plus the hash-only test-seat cleanup
  receipt;
- delta: shared Command EVE `1.8.12` update/UI/release work and the Hermes-wheel
  SHA-256 enforcement hotfix.

## Verdict

Verdict: `PASS`

Confirmed P0: `0`

Confirmed P1: `0`

Confirmed P2: `0`

Phase A may close strictly as `WINDOWS_X64_PROOF` on the measured GitHub
Windows Server 2022 runner. The review explicitly rejects broader claims such as
`WINDOWS_READY`, Windows 11, pilot-ready, signed, sellable or public release.

## Decisive checks

- All shared `1.8.12` changes remain in one product tree; Linux, macOS and
  Windows quality receipts bind the same source and version.
- The bundled Hermes `0.17.0` wheel independently hashes to
  `b5e36fce7a65b202fff54bc0742316748224c11c9061312843aecdd59ec4694d`.
  Bootstrap fails before pip on mismatch, tests prove tampered/same-version
  rejection, and G06T binds expected and actual hashes.
- Run `29401329864` uses the exact final commit and every required job is green.
- G00-G08/G06T all PASS on source `66ec4117` and one installer SHA-256
  `683000bb28d31e79fe6404e6df46bb2346a212c61df2399924aded792fca01b5`.
- No prior `1.8.11` installer hash remains in the final evidence; timestamps and
  first-launch/restart provenance are coherent and distinct.
- Secret, JWT, email, UUID and overclaim scans over the evidence found no
  supported leak or false release claim.
- Package inventory proves Command EVE `1.8.12` x64, bundled Python `3.12.13`,
  one `win32-x64` runtime and isolated `https://phase-a.invalid` update feed.
- Live GitHub state contains no repository secret and exactly one final
  25,200-byte sanitized evidence artifact. Both cleanup receipts agree on the
  three identity hashes; all ten disposable-seat record counts are zero.

## Optional P3 notes

- Commit the final Codex adjudication, GLM status alignment and Defender-scope
  disclosure with the evidence closeout.
- First-boot Hermes transitive dependencies still resolve from PyPI over TLS.
  Pinning or vendoring that dependency closure is Phase B+ hardening; it is not
  a regression in the reviewed `1.8.12` delta.

GLM remains `TIMEOUT_INCONCLUSIVE` for the earlier bounded attempt and
`BLOCKED_BUDGET` for the requested final rerun. It has no PASS verdict and is
not release authority.

Completion sentinel: `FABLE_WINDOWS_PHASE_A_1812_DELTA_CONVERGED`
