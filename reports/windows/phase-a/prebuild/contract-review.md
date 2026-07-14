# Windows Phase A contract review

Date: 2026-07-14
Controller verdict: `CONTRACT_PASS`
Scope: COMPA-724 parent; COMPA-725 through COMPA-731 execution children

## Contract checks

- Source of truth, Phase A boundary, worker ownership and dependency order are explicit.
- WIN-000, WIN-010, WIN-020, WIN-030, WIN-040 and WIN-060 are integrated before WIN-070.
- WIN-070 requires G00 through G08 plus G06T on one clean source commit and one unsigned installer hash.
- The managed cloud-chat gate requires a dedicated secret-backed test seat, a complete deterministic answer and a server-side metering delta.
- Missing credentials become `BLOCKED_AUTH`; they never become PASS.
- Process ownership, cancellation, uninstall cleanup and disposable-profile deletion are explicit negative tests.
- Signing, public updater metadata, R2 upload and pilot promotion remain outside Phase A.
- Every long bootstrap emits a heartbeat. A slow runner is observed, not restarted speculatively.
- Worker and CAO do not set Plane items to Done; final status remains controller/founder authority.

## Rollback

The candidate is an internal unsigned GitHub artifact. A failed gate deletes the
disposable VM/profile, preserves redacted receipts and cannot alter a public
feed. Reverting the bounded Phase A commits restores the prior macOS-only build
surface.

Completion sentinel: `WIN_PHASE_A_CONTRACT_REVIEW_COMPLETE`
