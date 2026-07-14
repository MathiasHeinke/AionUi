# Command EVE Windows Phase A decisions

Date: 2026-07-14
Source commit: `5af678cc93296b8e23eb3bec4c16e643a55ee886`
Status: `FROZEN_FOR_PHASE_A`

## D1: Hermes dependency closure

Phase A may install the dependencies of the bundled Hermes wheel from PyPI over
TLS. The Windows installer must still contain the pinned CPython archive and the
committed Hermes wheel, and must not depend on system Python, Git, Bash or a
client-side provider credential.

The bootstrap receipt must record the Python version, Hermes wheel hash,
resolved package set, network requirement, stage durations and terminal state.
An offline first boot must return a bounded degraded classification; it must not
hang or report Hermes as ready. A fully bundled and hash-locked Windows wheel
closure remains required before a sellable public release.

## D2: CI execution lane

Phase A runs on the `MathiasHeinke/AionUi` fork using GitHub-hosted
`windows-2022` x64 runners. The fork is public, so no private account material or
raw test-seat credential may be written to workflow output or committed
evidence. Secret-backed cloud-chat tests must use GitHub Actions secrets and
redacted receipts. Runs without required account secrets must report
`BLOCKED_AUTH`, never PASS.

## D3: Packaged smoke mode

Phase A uses a spawn-based packaged lifecycle harness against the production
fuse profile. It does not weaken Electron fuses or treat a Playwright-instrumented
artifact as release truth. UI Automation and signed dual-artifact parity remain
later sellable-release work. Shared source-commit and product-version parity
across macOS and Windows is an immediate Phase A gate and may not be deferred.

## D4: Mac/Windows parity is a release invariant

Windows is a platform target of the same Command EVE product, not a fork. Every
cross-platform proof must bind Linux, macOS and Windows to one source commit,
one root application version and one Command EVE brand version. A platform-only
exception must be explicit, classified and covered by a platform test.

For later signed releases, a release is incomplete until the macOS and Windows
artifacts both bind to that same commit and version and their respective update
feeds pass. A Mac-only update must therefore keep the Windows release pending;
it may not be represented as a fully synchronized Command EVE release.

## Phase boundary

The output is an internal unsigned `WINDOWS_X64_PROOF`. It is not signed, not
uploaded to the public updater feed and not described as sellable or pilot-ready.

Completion sentinel: `PHASE_A_DECISIONS_FROZEN`
