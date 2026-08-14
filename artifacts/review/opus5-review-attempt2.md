# Command EVE 1.823.0 — Independent Security/Reliability Review (Opus 5)

- Frozen SHA: `fee7da7957969cf4b0761625f60f729967009030`
- Frozen source snapshot: `sha256:c95ddafacf10c1215fc205ed39eb1746795daaef8d60f48ddb3b1655ea288a8c`
- Runtime: Claude Code 2.1.131, exact model `claude-opus-5`, Claude Max, interactive tmux, plan/read-only
- Verification run by reviewer: 55/55 focused tests passed
- Filesystem/network posture: read-only; no edits, subagents, network, provider calls, or secret access

## Verdict

`REJECT`

The interrupted attempt's lead is confirmed. `handleCommandEveImageEdit` contains no seat/Seed capture, no `seatStillMatches` check, no paid-artifact transition fence, and no image-edit seat-changed outcome. The lane can therefore consume a permit under one Seed and let managed generation recapture and bill/stage under another Seed after a concurrent seat switch.

## P1-1 — Image edit has no seat capture

- Evidence: `packages/desktop/src/process/bridge/commandEveImageArtifactBridge.ts:918-967`, `:992-1162`, `:1118-1137`
- Contrast: `packages/desktop/src/process/bridge/commandEveVideoBridge.ts:1531-1532`, `:1689-1718`; `packages/desktop/src/process/commandEve/managedImageGenerationService.ts:225-240`, `:356`
- Confirmed failure path:
  1. Image edit reads the active record/grant and consumes the spend permit.
  2. The bridge holds no `tryBeginCommandEvePaidArtifactOperation` fence.
  3. A seat switch can complete before the managed service begins.
  4. The managed service captures the now-current seat because `expectedSeat` was not passed, then emits that seat in `commandEveMediaSeedAttribution`.
- Affected asset: client-Seed billing attribution and Seed isolation.
- Preconditions: two seats, valid image edit, concurrent seat switch in the pre-service window.
- Smallest remediation: mirror video edit's handler-entry seat id/revision capture and paid-artifact fence, pass `expectedSeat` and captured `dataPath` into managed generation, and add a stable image-edit seat-changed refusal.

## P1-2 — Permit/user turn can be burned before provider execution

- Evidence: `packages/desktop/src/process/bridge/commandEveImageArtifactBridge.ts:1118-1143`; `packages/desktop/src/process/commandEve/managedImageGenerationService.ts:280-284`, `:375`; `packages/desktop/src/process/commandEve/videoEditSpendPermitStore.ts:1108-1125`
- Confirmed failure path: the exclusive durable turn claim is consumed before registry and other pre-provider gates run. A transient pre-provider failure is returned with `retryable: true`, but reuse of the same user-turn hash is rejected as already consumed.
- Impact: no image and no upstream debit, but the user's edit turn is irrecoverably spent for the retention window while the UI invites an impossible retry.
- Smallest remediation: resolve registry/tier/license/seat before consume where possible and add video-style completion/replay recovery; never label a consumed, unrecoverable turn retryable.

## P2 findings

1. Image artifacts and capability handles are install-global and carry no `seat_id` (`imageArtifactStore.ts:79`; `artifactCapabilityHandleStore.ts`; `utils.ts:112-117`). Stamp and verify the active seat on list/preview/edit/bind.
2. `bindStagedImageArtifact` accepts a caller-provided conversation without checking the parent artifact's conversation (`imageArtifactStore.ts:367-425`). Require parent conversation equality for edit-derived children.
3. The test named "a disabled seat refuses before everything" only disables the feature flag; it does not exercise a seat (`tests/unit/command-eve/commandEveImageArtifactBridge.test.ts:303`). Add real image-edit seat tests.
4. Reference reads retain a low-exploitability lstat/read TOCTOU on intermediate directories (`imageIntelligenceService.ts:88-111`).

## Confirmed sound

- Explicit composer mode authority is fail-closed and cannot be minted by prose.
- One-shot reset, queued image options, and fresh-chat reparse preserve explicit selection.
- Direct image-create input normalization, seat-bound grants, one-in-flight coordination, request-id conflict detection, and preview hash re-verification are present.
- No P0 and no unauthorized-provider path or confirmed double charge were found.

`OPUS5_REVIEW_COMPLETE`
