# Fable 5 High - Composer Review

Date: 2026-07-10
Scope: Command EVE 1.8.0-d composer surface
Mode: read-only review in Claude Code / Fable 5 High

## Outcome

Final verdict: **PASS - no release blocker remains.**

Sentinel: `FABLE_180_COMPOSER_FINAL_GATE_COMPLETE`

## Review Loop

1. Pre-review found inline border ownership, legacy purple focus values, mismatched send/stop colors, nested surfaces, missing fallbacks, stale spotlight geometry, mixed control heights, missing accessible names, mobile bleed and a hover-only attachment path.
2. Post-review confirmed the main implementation but found two release blockers: broken in-chat drag feedback and insufficient stop-icon contrast.
3. Final review verified both blockers, all P2 adjudications and all listed P3 cleanups against the current diff, tests and live evidence.

## Verified Fixes

- Start and in-chat composers share `eve-panel eve-composer-surface`.
- Drag feedback uses `eve-composer-surface--dragging` on both surfaces.
- Stop is primary blue with a white 12px square and accessible label.
- Unsupported/reduced-transparency environments receive a solid composer background.
- Prompt rows use Arco `Button`, not raw interactive HTML.
- The pointer spotlight is frame-coalesced, resize-aware and suppressed for keyboard focus.
- Reduced effects pin the static hotspot on `::before`.
- Attachment labels and send/stop labels are present.
- Placeholder styling is scoped to the composer.
- Speech styles load at the reusable `SpeechInputButton` boundary and cover Arco's disabled wrapper behavior.
- GitNexus-generated `AGENTS.md`/`CLAUDE.md` renames are absent from the final diff.

## Verification Seen By Fable

- `tsc --noEmit`: clean
- focused unit/contract tests: pass
- lint: zero errors
- i18n validation: pass, existing warning-only inventory unchanged
- live light/dark, mobile, drag, speech, stop and completed-chat evidence: reviewed

The final residual CSS co-location note was also resolved after the Fable verdict by moving the remaining mobile speech rules from `SendBox/sendbox.css` into `SpeechInputButton.css`; the source-contract test now rejects any future `speech-input-*` rule in `sendbox.css`.
