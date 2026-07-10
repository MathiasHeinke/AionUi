# Command EVE 1.8.0 Settings Review - Fable 5 High

Date: 2026-07-10
Branch: `codex/command-eve-180-design-system`
Reviewer: Claude Code Fable 5 High with four read-only workers
Completion sentinel: `FABLE_EVE_180_AUDIT_COMPLETE`
Elapsed time: 16m 50s

## Verdict

No P0 finding. The shared EVE settings theme is a credible replacement for the legacy shell. The review identified four bounded P1 integration or UX issues and several P2 evidence gaps.

## Accepted Findings

1. Integrate the design and runtime branches manually. They overlap in six files, and `useGuidSend` also has a semantic collision around failed-send draft retention.
2. Force the public Command EVE avatar in the team leader selector instead of inheriting a backend icon.
3. Keep the active mobile settings route visible and expose horizontal overflow with edge fades.
4. Give custom `AionModal` footers the same default gutters as generated footers, with an explicit opt-out for full-bleed footers.
5. Remove the `EVE/Hermes` identity leak and native alert from the EVE conversation-start error path.
6. Add a CSS focus fallback for the composer surface.
7. Extend visual evidence with dark-mobile settings states, theme-attribute parity, a true dark team modal, update states, and a post-fix EVE fallback state.

## Product Decisions

- Explicit provider names remain visible only in deliberate BYOK, model protocol, and voice routing controls. Those surfaces are privacy and routing choices, not public runtime leakage.
- The public shell remains hard-pinned to Command EVE. Internal CLI and orchestration identities stay hidden, while runtime failure and draft-preservation behavior must survive integration.
- Semantic warning, error, budget, and completion colors remain allowed; they are state communication, not decorative palette drift.

## Integration Contract

- Start from runtime commit `1c6716a3` in a fresh third worktree.
- Resolve `GuidPage` and `useGuidSend` by preserving the EVE-only public gate plus runtime `Promise<boolean>` send results and failed-send draft retention.
- Resolve settings locale and E2E conflicts by behavior, then run the merged unit, type, live Electron, E2E, and packaged smoke gates.
- Do not cherry-pick the complete design stack blindly into the dirty runtime worktree.
