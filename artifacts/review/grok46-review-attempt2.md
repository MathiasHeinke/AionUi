# Command EVE 1.823.0 — Independent Regression/UX/Security Review (Grok 4.6)

- Frozen SHA: `fee7da7957969cf4b0761625f60f729967009030`
- Frozen source snapshot: `sha256:c95ddafacf10c1215fc205ed39eb1746795daaef8d60f48ddb3b1655ea288a8c`
- Runtime: Grok CLI 1.0.3, exact model `grok-4.6`, grok.com subscription, plan/read-only, `xhigh`
- Execution note: the first 30-turn pass reached its cap while tracing; the same session was resumed only to synthesize its already gathered evidence.
- Filesystem/network posture: read-only; no edits, subagents, web search, provider calls, or secret access

## Verdict

`REJECT`

Paid Hermes image edit is not seat/Seed-fenced like image generation and video edit. This is a confirmed isolation and spend-recovery defect.

## P1 — Paid image edit lacks seat/Seed fence and completion recovery

- Evidence: `packages/desktop/src/process/bridge/commandEveImageArtifactBridge.ts:958-967`, `:992-1161`, `:1031-1074`, `:1111-1143`
- Contrast: `packages/desktop/src/process/bridge/commandEveVideoBridge.ts:1526-1543`, `:1689-1785`; `packages/desktop/src/process/commandEve/managedImageGenerationService.ts:219-371`
- Confirmed facts:
  - The handler never captures active seat id/revision.
  - It never calls `seatStillMatches`, `getCommandEvePaidArtifactBlockReason`, or `tryBeginCommandEvePaidArtifactOperation`.
  - Production `runManagedEdit` passes only `stagedParentArtifactId`; it does not pass `expectedSeat`, `dataPath`, or `requestId`.
  - The managed service captures the current seat after the edit permit has already been consumed.
  - No image-edit completion receipt/replay recovery exists, while video edit has one.
- Failure path: consume under Seat A, switch while the handler is unlocked, managed service captures Seat B, then stages/attributes the derived image to Seat B. A post-consume failure also makes the same advertised retry fail as turn-consumed.
- Impact: cross-Seed stage/attribution plus lost single-use edit authorization.
- Smallest remediation: mirror the video-edit preamble; capture seat/revision/data path before consume, hold the paid-artifact lock, pass the captured seat into managed generation, and persist/read a completion receipt for replay ambiguity.

## P2 findings

1. Authority menu height/scroll is currently CSS-asserted rather than behavior-asserted (`ComposerContextDeck.module.css:115-120`; `ComposerContextDeck.dom.test.tsx:83-92`). Add a rendered scroll-range assertion.
2. Reduced motion removes visible CSS motion but Arco popups can remain mounted for the normal 380 ms exit duration (`composerMenuMotion.ts:10-32`; `arco-override.css:105-138`). Pass a reduced-motion-aware exit duration.
3. The context meter is a raw `<button>` instead of the native control primitive (`ComposerContextDeck.tsx:155-166`).
4. Direct image create bypasses the normal conversation command queue (`AcpSendBox.tsx:1620-1697`); Main prevents double spend, but the second create degrades to an in-flight refusal/draft restore.

## Confirmed sound

- Unlimited/free seats, Alois retry/recovery, in-app create/rename/company-brain flows, and removal of the old per-seat checkout path match the contract.
- Prose cannot arm a work-product mode; start/session handoff and one-shot reset are fail-closed.
- Project+authority and MAX+context are true compound controls; image reference placement and regular attachment separation are present.
- Direct image create and video create/edit have the expected seat capture and paid-operation controls.
- No separate P0 was found.

`GROK46_REVIEW_COMPLETE`
