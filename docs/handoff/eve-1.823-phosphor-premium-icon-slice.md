# Command EVE 1.823 Phosphor premium icon slice

Date: 2026-08-16
Linear anchors: MAT-1624, MAT-1844
Base: `ff94a4ba53002c94204adf6fdb5a1a9be2e67384`
Branch: `codex/eve-1823-phosphor-premium-slice`

## Candidate truth

This branch is a source-only UI candidate. It does not prove a packaged app,
provider, deployment, signing, notarization, upload, merge, or release. The
source review workspace remained read-only; the candidate was rebuilt from the
exact base above in its own worktree.

The slice contains only:

- desktop and React Native Phosphor compatibility facades;
- generic UI-icon import migration and the matching dependency/bundler changes;
- icon alignment, semantic color, light/dark, hover, focus, disabled, and
  reduced-motion CSS;
- connection-status icons, appearance-swatch selection, focused test mocks,
  contracts, and this evidence record.

It intentionally contains no Composer behavior, project assignment, Office,
Permit, provider, bridge-policy, or AionCore revision change. Files that also
own those concerns carry import-only icon edits. Logos, avatars, Mermaid
content, the native file-preview asset, and the Iconify file-type renderer stay
as documented exceptions.

## Implementation contract

- Generic desktop glyphs import the facade at
  `packages/desktop/src/renderer/components/icons/index.tsx`; only the facade
  and provider import `@phosphor-icons/react` directly.
- Generic mobile glyphs use
  `mobile/src/components/ui/PremiumIcon.tsx`; production code no longer imports
  Ionicons directly.
- Legacy Icon Park names remain accepted at the facade boundary so the migration
  changes rendering without rewriting component behavior.
- Naked glyph wrappers provide size, alignment, and semantic color only. They
  do not add a border, fill, radius, or shadow. Interactive buttons retain their
  normal hit area and focus-visible treatment.
- The native `file-icon.svg`, `FilePreview`, Mermaid content, avatars, logos,
  channel artwork, and `FileTypeIcon` remain outside the generic-glyph rule.

## Visual QA

The CDP gauntlet ran against an isolated development profile with the
development-only entitlement gate disabled and the bundled local AionCore
binary. No production profile, provider, or paid lane was used.

Evidence:
`artifacts/design-qa/premium-ui/phosphor-candidate-20260816/premium-ui-gauntlet-report.json`

- 8 route captures: `/guid`, Appearance, Authority, and component showcase in
  light and dark;
- 8 opened overlay captures, including tools, authority, workspace, and narrow
  authority scrolling;
- 0 harness failures, 0 captured runtime errors, and 0 fast 100-250 ms
  interaction-motion findings;
- the final visual pass confirms baseline alignment/currentColor inheritance,
  a borderless selected appearance check, and unframed work-product menu
  glyphs in both themes.

## Verification boundary

| Gate | Result |
| --- | --- |
| Root TypeScript | PASS |
| Mobile TypeScript | PASS |
| Focused desktop UI/contracts | 121/121 PASS |
| MAX SVG-regression retest | 45/45 PASS |
| Mobile Phosphor facade | 3/3 PASS |
| Full mobile Jest | 83 PASS, 5 unchanged Bridge-test failures |
| Root lint | 0 errors, 999 warnings |
| Mobile lint | 0 errors, 10 warnings |
| Targeted format | PASS on 225 files |
| i18n type generation/check | PASS |
| CDP visual matrix | 8/8 routes, 8/8 overlays, 0 failures |

Full Vitest recorded 7,777 PASS, 20 FAIL, and 12 skipped. The failures are not
hidden:

- 12 are the known exact-base failures in approved-copy, adapter-security,
  Windows-build, visual-rail, tooltip-overlay, and MAX-authority contracts;
- 5 project-workspace tests timed out only under the disk-pressured full run and
  passed 48/48 when rerun in isolation;
- 3 Bonsai provisioner tests fail closed because the volume had about 1 GiB free
  and did not meet the model download headroom. The provisioner files are
  unchanged by this candidate.

The five full-mobile Bridge failures are also in unchanged implementation and
test files. This handoff therefore claims no all-repository green state; it
records the passing changed-scope gates and the remaining baseline/environment
failures separately.

GitNexus was indexed at the exact base before editing. Final Detect-Changes
reports `CRITICAL`: 259 changed files, 110 graph-mapped symbols, and 26 affected
flows. This is the expected aggregate blast radius of replacing a shared icon
import across the renderer and mobile shell. The high-risk mixed-owner files
were inspected separately and contain import-only edits; the scope audit finds
no Composer behavior, project-assignment, Office, Permit, provider, bridge, or
AionCore change. The critical graph receipt is therefore retained as a review
gate, not downgraded into a PASS.

No source-only result upgrades this candidate to package or release truth.
