# Command EVE 1.823.0 — Opus 5 independent security/reliability review

You are the first independent security reviewer. Work read-only in this exact checkout. Do not edit files, do not spawn subagents, do not use the network, do not call providers, and do not expose secrets or private data.

## Frozen input

- Worktree: `/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-seat-management`
- Branch: `codex/eve-18230-seat-management`
- Git SHA: `fee7da7957969cf4b0761625f60f729967009030`
- Integrated source snapshot: `sha256:c95ddafacf10c1215fc205ed39eb1746795daaef8d60f48ddb3b1655ea288a8c`
- Seat feature baseline: `2fcd23a0bce9f1649a2145f109f49be28bfce599`
- Seat feature range: `2fcd23a0bce9f1649a2145f109f49be28bfce599..fee7da7957969cf4b0761625f60f729967009030`
- Current composer/image/video implementation is the working-tree diff plus new files under `packages/desktop` and `tests`.
- Linear work item: MAT-1843.

## Required audit

Audit the actual implementation, not prose. Focus on:

1. Free multi-seat management: entitlement math, seat-count recovery, seat/Seed isolation, company-brain/name changes, retry/reload behavior, and whether a user can accidentally lose or cross-bind a seat.
2. Explicit work-product composer: ordinary prose must never activate image/video/PDF/PPTX mode; start and in-session selection/handoff/queue/reset must preserve exact mode and options.
3. Direct image-generation trust boundary: renderer-to-Main validation, capability-granted reference paths, traversal/symlink/TOCTOU exposure, seat/revision checks before and after spend, request-ID replay/deduplication, one in-flight operation per conversation, failure artifact states, retry ambiguity, and no double charge.
4. Image/video artifact iteration: selected artifacts must remain scoped to their conversation/seat; edit vs create must not silently diverge; artifact refresh/persistence must be reliable.
5. Recovery and concurrency: remount, fresh-chat initial-message bridge, queue snapshots, failure restore, seat switching during paid work, cancellation/timeout, and stale renderer events.
6. Tests: identify false-positive tests and material missing negative cases. You may run focused read-only tests if useful, but do not mutate source.
7. Explicitly confirm or refute the interrupted attempt's lead that paid image-edit state may lack the seat/Seed capture already present in image generation and video edit.

## Evidence format

For every finding provide:

- Severity: P0, P1, or P2
- Exact `file:line`
- Attack/failure path
- Affected asset
- Preconditions
- Impact
- Smallest bounded remediation

Separate confirmed facts from inference. If no P0/P1 exists, say so only after tracing the executable path. End with one verdict: `PASS`, `REJECT`, or `PARK`, then the exact sentinel:

`OPUS5_REVIEW_COMPLETE`
