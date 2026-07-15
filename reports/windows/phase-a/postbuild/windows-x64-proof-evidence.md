# Command EVE Windows x64 Phase A evidence

Date: 2026-07-15
Status: `WINDOWS_X64_PROOF`

## Immutable identity

| Field             | Value                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| Repository        | `MathiasHeinke/AionUi`                                                            |
| Source commit     | `66ec41174e35a72db475f30206cd5fe346b1c4d6`                                        |
| GitHub run        | [`29401329864`](https://github.com/MathiasHeinke/AionUi/actions/runs/29401329864) |
| Run conclusion    | `success`                                                                         |
| Product/version   | Command EVE `1.8.12`                                                              |
| Candidate         | `Command EVE-1.8.12-win-x64.exe`                                                  |
| Candidate SHA-256 | `683000bb28d31e79fe6404e6df46bb2346a212c61df2399924aded792fca01b5`                |
| Signature state   | `NotSigned`, required for the internal Phase A candidate                          |
| Evidence artifact | `windows-x64-phase-a-evidence-66ec411`, artifact ID `8338527889`                  |

The final build used one clean source commit. G04 through G08 reference the
same installer hash. Before candidate deletion, an independent local SHA-256
check matched the gate receipts exactly. The package was never promoted to R2,
a public updater or a customer distribution channel.

The source also contains the shared Command EVE `1.8.12` background-update,
glass-surface and release-binding commits. Windows is maintained from the same
product tree as macOS rather than from a Windows-only fork.

## Runner truth

| Field            | Measured value                           |
| ---------------- | ---------------------------------------- |
| Operating system | Microsoft Windows Server 2022 Datacenter |
| Build            | `20348`                                  |
| Architecture     | x64                                      |
| CPU              | 4 logical processors                     |
| Memory           | approximately 16 GB                      |
| Test mode        | `packaged-nsis-phase-a`                  |

CI applied narrowly scoped Defender exclusions to ephemeral build and proof
paths. The run is not evidence for an ordinary Windows 11 desktop, standard
user restrictions or an unmodified endpoint-protection policy.

## Gate ledger

| Gate     | Result | Decisive evidence                                                                                     |
| -------- | ------ | ----------------------------------------------------------------------------------------------------- |
| WIN-G00  | PASS   | no critical unknown in the bounded Phase A contract                                                   |
| WIN-G01  | PASS   | committed review inputs record GLM `TIMEOUT_INCONCLUSIVE`; final rerun is separately `BLOCKED_BUDGET` |
| WIN-G02  | PASS   | Linux, macOS and Windows quality markers bind source/version parity                                   |
| WIN-G03  | PASS   | injected Windows build failure exited non-zero                                                        |
| WIN-G04  | PASS   | exact unsigned NSIS installer identity and SHA-256                                                    |
| WIN-G05  | PASS   | package inventory, AionCore, Python and isolated updater feed                                         |
| WIN-G06  | PASS   | install, two launches, shutdown, uninstall and zero residue                                           |
| WIN-G06T | PASS   | bundled Python plus pinned Hermes `0.17.0` wheel and clean process trees                              |
| WIN-G07  | PASS   | activation, cloud turns, credits, cancel/restart and zero secret findings                             |
| WIN-G08  | PASS   | every required gate converges on one source commit and one installer digest                           |

`phase-a-convergence.json` reports `ok: true`, `status: PASS`, an empty
`missing_gate_ids` array and an empty `errors` array. The canonical TypeScript
validators independently accepted every final receipt and reproduced the same
convergence result.

## Runtime evidence

- First bootstrap: `ready`, bundled Python `3.12.13`, Hermes `0.17.0`.
- Hermes wheel: expected and actual SHA-256 both
  `b5e36fce7a65b202fff54bc0742316748224c11c9061312843aecdd59ec4694d`;
  the fail-closed pin assertion passed.
- Restart bootstrap: a distinct fresh `ready` receipt; no stale first-launch
  receipt was reused.
- Runtime profile: `cloud_turn_holder_only`; Ollama and local model stages were
  explicitly skipped.
- First Hermes managed cloud turn: complete deterministic answer.
- Cancellation: owned Hermes process tree stopped with zero survivors.
- Restart turn: complete deterministic answer after cancellation.
- Paid path: tier `starter`, purchased-credit delta `26`, allowance delta `0`,
  free-action delta `0`.
- Egress: permitted server route, no raw prompt text stored in the receipt.
- Uninstall: zero process, install-file, shortcut and registry residue; the
  disposable profile was removed.

## Security and cleanup

- Provider-secret finding count: `0`.
- Plaintext test-seat finding count: `0`.
- The test-seat wire existed only as Electron `safeStorage` ciphertext bound to
  the disposable profile during the proof.
- An independent scan of all 25 downloaded JSON files found no supported
  sensitive-key value or provider-secret pattern.
- The ephemeral GitHub license secret and temporary mint secret were removed.
- The private test-seat state file was deleted.
- Every exact test-seat database record class was re-queried as zero after
  cleanup.
- The unsigned candidate, standalone marker artifacts and stale Phase A
  evidence were deleted. Only the final 25,200-byte sanitized evidence artifact
  remains under bounded GitHub retention.

## Measured cycle time

- Phase A implementation start: `2026-07-14T17:00:35+02:00`.
- Final `1.8.12` proof completion: `2026-07-15T11:30:20+02:00`.
- End-to-end wall time to the authoritative final proof: `18h 29m 45s`,
  including peer review, Mac/Windows parity integration, evidence-backed
  hotfixes and exact-source reruns.
- Final GitHub run duration: `54m 58s`.

## Residual boundaries

Phase A does not prove Windows 11, 8 GB operation, standard-user policy,
Defender/SmartScreen compatibility, the named pilot machine, files/artifacts,
voice, bounded worker delegation, signing, public updates, rollback, local
models or computer use. Those remain Phase B-D gates.

The only valid exit statement is `WINDOWS_X64_PROOF`. This document must not be
used to claim `WINDOWS_READY`, pilot acceptance or a sellable Windows release.

Completion sentinel: `WINDOWS_X64_PROOF_EVIDENCE_COMPLETE`
