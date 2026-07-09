# Command EVE 1.8.0 Meta-Theme Implementation Plan

Date: 2026-07-09
Status: ready for implementation after worktree ownership gate
Canonical design: `docs/strategy/command-eve-180-design.md`

## 1. Objective

Replace the public AionUI visual language with the approved Command EVE light
and dark meta-theme across the entire product, while preserving runtime,
security, updater, billing, seat isolation, and user data behavior.

The plan is complete only when:

1. every public route inherits the new visual system;
2. the new shell, row-status, composer, footer, updater, and Appearance
   contracts are implemented;
3. legacy public theme presets are migrated without deleting saved data;
4. all visual, accessibility, performance, and packaged-app gates pass;
5. Fable and Codex post-reviews are green;
6. Mathias approves the final light/dark screenshot matrix.

## 2. Execution Roles

| Role | Responsibility |
|---|---|
| Mathias / Founder | visual direction, final screenshot approval, release gate |
| Codex / Controller | scope, impact analysis, implementation integration, tests, final judgment |
| Fable 5 High | read-only design/system challenge before build and post-review after QA |
| Image 2.0 | bitmap design references only; never implementation truth |
| Playwright/E2E | repeatable interaction and screenshot evidence |
| GitNexus | pre-edit impact and post-change scope verification |

External reviewers do not write source code in the active integration
worktree. Codex owns final edits and conflict resolution.

## 3. Worktree Ownership Gate

The current design worktree already contains unrelated or parallel bugfix
changes. At planning time these include:

- `AGENTS.md`
- `CLAUDE.md`
- `BtwOverlay.module.css`
- `ExtensionSettingsTabContent.tsx`
- `ConversationSearchPopover.css`
- `chat-layout.css`
- `ExtensionSettingsPage.tsx`
- `layout.css`
- `default-color-scheme.css`
- `extensionMessageBoundary.ts`
- `extensionMessageBoundary.test.ts`

Rules:

1. This planning pass edits only design docs and image assets.
2. Do not begin source implementation while ownership of those changes is
   unclear or while the parallel bugfix worker is still writing them.
3. Before 1.8.0-b, capture `git status`, identify the bugfix commit/branch, and
   start a clean visual worktree from the accepted bugfix base.
4. Never overwrite or revert parallel changes.
5. Shared files are edited only after a fresh GitNexus impact pass and a real
   three-way diff against the bugfix result.
6. If a shared CSS file conflicts, prefer a new imported Command EVE layer over
   a manual conflict resolution inside unrelated bugfix hunks.
7. Source implementation commits are slice-scoped and do not include the
   pre-existing dirty files unless their owner explicitly hands them over.

Gate result required before coding:

```text
WORKTREE_OWNERSHIP_PASS
bugfix_base=<commit>
visual_worktree=<path>
dirty_unowned_files=0
```

## 4. Shared Data Contracts

### 4.1 Visual preferences

Use structured settings rather than arbitrary CSS for public controls.

```ts
type EveAppearanceMode = 'system' | 'light' | 'dark';
type EveAccent = 'blue' | 'petrol' | 'emerald' | 'graphite';

type EveVisualPreferences = {
  schemaVersion: 1;
  mode: EveAppearanceMode;
  accent: EveAccent;
  glassOpacity: number; // 0.72..1.0
  glassBlur: number; // 0..28 px
  reducedEffects: boolean;
  background: {
    enabled: boolean;
    assetId?: string;
    fit: 'cover' | 'contain' | 'fill';
    intensity: number; // 0.2..1.0
    blur: number; // 0..24 px
    dim: number; // 0..0.6
    adaptiveTint: boolean;
  };
};
```

The persisted value is clamped at the read boundary and again before CSS
variables are applied.

### 4.2 Session status

```ts
type SessionStatus =
  | 'running'
  | 'error'
  | 'attention'
  | 'completed'
  | 'newResult'
  | 'idle';
```

Selection is not a status. Do not add `selected` to this union.

### 4.3 Update footer state

```ts
type EveUpdateUiState =
  | { kind: 'current' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; progress?: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; messageKey: string };
```

This is a read-only projection of existing updater truth. It must not become a
second updater state machine.

### 4.4 Transparent EVE identity

```tsx
type CommandEveGlyphProps = {
  size?: number;
  className?: string;
  decorative?: boolean;
};

export const CommandEveGlyph = ({
  size = 20,
  className,
  decorative = true,
}: CommandEveGlyphProps) => (
  <span
    className={classNames('command-eve-glyph', className)}
    style={{ fontSize: size }}
    aria-hidden={decorative || undefined}
  >
    {'⌘'}
  </span>
);
```

Do not reuse the square app-icon SVG for this component.

## 5. Slice 1.8.0-a - Contract and Baseline

### Owner

Codex, reviewed by Fable, approved by Mathias.

### Inputs

- canonical design contract;
- approved light/dark images;
- Fable main report and addendum;
- current packaged-app screenshots;
- route table and component map.

### Tasks

1. Persist the approved image references under `docs/strategy/assets/`.
2. Produce the final revised dark render with:
   - transparent top-left EVE glyph;
   - EVE glyph in every chat/project row;
   - semantic status attachments;
   - reduced selected row;
   - premium seat rail;
   - pointer-local composer glow;
   - account/update footer.
3. Record a matching light-mode adaptation rule.
4. Capture current baseline screenshots from the packaged 1.7.x app.
5. Build a public route list from `Router.tsx`.
6. Inventory existing:
   - `backdrop-filter` sites;
   - `--aou-*` visible uses;
   - literal renderer colors;
   - theme preset/custom-CSS injection;
   - Arco global overrides;
   - updater-open event and state sources.
7. Run Fable read-only pre-review and integrate only adjudicated findings.

### Acceptance

- Design contract and implementation plan are self-contained.
- Founder decisions are explicit and non-contradictory.
- No source file was modified.
- `WORKTREE_OWNERSHIP_PASS` is recorded before slice b starts.

### Human gate

Mathias accepts the final render and this plan.

## 6. Slice 1.8.0-b - Theme Kernel and Meta-Template

### Goal

Create the global token/runtime foundation with near-zero layout change before
polishing individual surfaces.

### Pre-edit impact targets

- `ThemeProvider`
- `useTheme`
- `applyTheme`
- theme resolution/storage types
- global style import root
- `AionModal`

Warn before editing if GitNexus reports HIGH or CRITICAL impact.

### Tasks

1. Add a dedicated Command EVE visual token file in an architecture-approved
   location.
2. Define shell, glass, row, status, brand, accent, background, and footer
   semantic tokens for light and dark.
3. Import the layer after default color scheme and before user-gated custom CSS.
4. Wire structured `EveVisualPreferences` with clamping and defaults.
5. Add System/Light/Dark preference without widening resolved theme types
   unnecessarily:
   - persisted preference may be `system`;
   - resolved runtime appearance remains `light | dark`;
   - OS changes update the resolved appearance live;
   - no write-back loop.
6. Implement accent pairs across both Arco color variables and RGB-triplet
   aliases.
7. Make glass opacity/blur factors multiplicative ceilings, not unrestricted
   raw CSS.
8. Introduce shared meta-theme primitives/classes for chrome, panel, overlay,
   row, pill, artifact, empty state, and dialog.
9. Port global Arco defaults and `AionModal` to the primitives.
10. Add opaque fallbacks for unsupported backdrop filters and reduced
    transparency.
11. Add token schema tests and CSS import-order tests.

### Verification

```bash
bunx tsc --noEmit
bun run i18n:types
node scripts/check-i18n.js
bunx vitest run tests/unit/renderer
```

Add screenshot comparisons for untouched start/chat/settings surfaces. The
goal is token foundation with no accidental layout drift.

### Acceptance

- Every root route receives the new token layer.
- No user control can make text unreadable.
- System mode is deterministic and loop-free.
- No new purple default surface.
- Existing custom CSS is not deleted or auto-applied in public mode.

### Rollback

Remove the new imported token/preference layer; existing theme runtime remains
operational.

## 7. Slice 1.8.0-c - Shell Identity, Seats, Rows, and Footer

### Pre-edit impact targets

- `SeatRail`
- `ConversationRow`
- `deriveSessionStatus`
- `SessionStatusDot`
- `SiderFooter`
- `ProfileAvatar`
- updater modal/status ownership

### Tasks

1. Add transparent `CommandEveGlyph`.
2. Add top-shell brand slots for rail-present and rail-absent states.
3. Remove runtime/assistant logos from public conversation rows.
4. Preserve internal metadata while rendering only EVE identity.
5. Refine seat visuals without touching authorization or switching logic.
6. Replace selected-row `!bg-fill-3` with the reduced wash/hairline state.
7. Finalize status mapping and precedence.
8. Add non-color status shape classes.
9. Keep error/attention until actual resolution; do not clear on open.
10. Use existing durable conversation/turn/cron truth; do not create a second
    status store.
11. Make the row keyboard-operable without breaking nested dropdown, checkbox,
    context menu, or sortable drag behavior.
12. Refactor profile reading into a shared local hook/context.
13. Extract updater observation without changing update check timing.
14. Rebuild `SiderFooter` with identity trigger plus expandable update control.
15. Keep `UpdateModal` as the decision and progress surface.
16. Add i18n labels and polite announcements.

### Tests

- table-driven status precedence and clearing;
- every badge shape/color/label;
- selected row with and without badge;
- row Enter/Space, nested menu, batch checkbox, and drag interaction;
- rail active/inactive/focus/switching states;
- no runtime logo in public history;
- profile signed-in and signed-out fallback;
- updater state projection;
- no duplicate check/download/install IPC;
- footer hover, focus, touch, collapsed, reduced-motion behavior.

### Acceptance

- Shell matches the approved dark/light identity.
- All updater states are discoverable without opening a hidden menu.
- Account/footer density passes German max-font at 260px sidebar width.
- Seat switching behavior and security tests are unchanged.

### Rollback

Brand, seat, row, status, and footer commits stay separate so each can be
reverted without reverting the theme kernel.

## 8. Slice 1.8.0-d - Composer and Primary Work Surface

### Pre-edit impact targets

- composer panel wrapper
- `UnifiedSendBar`
- SendBox styles
- guide/start input card
- privacy pill
- suggestion rows

### Tasks

1. Apply panel-tier glass to the composer wrapper.
2. Align paperclip and every control on one stable baseline.
3. Replace visible `--aou-*` send/stop styling with primary tokens.
4. Implement pointer spotlight with a masked pseudo-element.
5. Add rAF-coalesced pointer tracking with cached geometry.
6. Add focus, touch, reduced-motion, reduced-transparency, and mask fallback.
7. Keep `UnifiedSendBar` order and ACP behavior unchanged.
8. Port privacy pill to the overlay/pill primitive.
9. Port suggestion rows to one grouped panel without nested cards.
10. Validate send, stop, mic, model, permission, context, and attachment states.

### Tests

- pointer at top/right/bottom/left boundaries;
- no more than one style write per animation frame;
- no React render per pointer move;
- focus-visible suppresses spotlight;
- touch gets static border;
- reduced motion has no tracking;
- controls remain stable while recording, transcribing, sending, stopping, or
  queueing;
- 390px and 1440px baseline alignment.

### Acceptance

- Composer matches both approved modes.
- No input behavior changed.
- No icon, label, or dynamic state shifts layout.

### Rollback

Spotlight hook and CSS are isolated; removing them restores the neutral glass
composer.

## 9. Slice 1.8.0-e - Appearance and Global Route Sweep

This is split internally to keep reviews bounded.

### 1.8.0-e1 - Appearance control surface

1. Replace the preset-card gallery with the IA in the design contract.
2. Add System/Light/Dark segmented control.
3. Add curated accent swatches.
4. Add clamped opacity and blur controls.
5. Preserve existing font and scale controls inside the new panel system.
6. Extend the existing local background path with fit/intensity/blur/dim/tint.
7. Add per-section and global reset.
8. Make changes live and debounce persistence.
9. Hide custom CSS in public builds; retain founder/developer gate.

### 1.8.0-e2 - Legacy migration

1. Prune decorative presets from public `BUILTIN_THEMES`.
2. Stop importing legacy preset CSS/covers into the public bundle.
3. Map active legacy IDs to the equivalent new light/dark mode.
4. Preserve user and extension theme payloads byte-for-byte.
5. Ensure saved CSS is not applied in public mode.
6. Add one-time, idempotent migration notice.
7. Verify seats/reinstalls do not repeat migration.

### 1.8.0-e3 - Settings, artifacts, and overlays

1. Port Settings shell, sider, and every submenu to global primitives.
2. Port privacy, billing, account, Company Brain, connectors, capabilities,
   runtime, diagnostics, remote, and system pages.
3. Port artifact image/video/audio/HTML/file/table frames.
4. Port update, confirm, search, dropdown, menu, modal, toast, and route fallback
   surfaces.
5. Remove nested card stacks and legacy hardcoded white/gray panels.

### 1.8.0-e4 - Remaining routes

Sweep all public routes from `Router.tsx`:

- guide/start and chat;
- team and team management;
- command center and tasks;
- onboarding/registration;
- workspace/preview;
- empty/loading/error states.

Each route receives the global foundation even if its detailed IA is scheduled
for a later feature release.

### Tests

- migration fixtures for every decorative ID, one user theme, one extension
  theme, and corrupt/unknown IDs;
- byte-equality assertion for preserved user CSS;
- no legacy style element in public mode;
- no public `Manuell hinzufügen` entry;
- background path privacy and missing-file fallback;
- Appearance extremes and reset;
- route screenshot matrix light/dark;
- literal-color and visible-purple audit.

### Acceptance

- No public route visually falls back to old AionUI.
- Existing user customization data remains recoverable.
- Appearance controls cannot violate accessibility floors.
- Background images never leave the device.

### Rollback

Migration must be versioned and reversible. Rollback restores visibility of
saved data, not deletion. Background mode defaults to disabled.

## 10. Slice 1.8.0-f - QA and Release Candidate

### Build and verification

```bash
bun run lint
bun run format:check
bunx tsc --noEmit
bun run i18n:types
node scripts/check-i18n.js
bunx vitest run tests/unit/command-eve
bun run test:e2e -- --grep "Command EVE"
```

Use the repository's actual scripts if names differ; do not silently skip a
missing command.

### Visual matrix

Capture deterministic screenshots for:

- every public route at 1440x1024 light/dark;
- start/chat/settings at 390x844 light/dark;
- all session and updater states;
- rail/sidebar expanded/collapsed;
- composer interaction/accessibility states;
- every artifact class;
- all Appearance extremes;
- background bright/dark/busy/low-contrast;
- German/English, max font, 200% zoom;
- loading, empty, error, modal, and confirmation states;
- three-pane workspace/preview.

### Performance

1. Record a 500-message scroll trace.
2. Test default theme and background-image mode.
3. Keep spotlight active during the trace.
4. Compare long tasks, dropped frames, memory, and paint cost with 1.7.x.
5. Fail release on meaningful regression until measured and accepted.

### Cross-review

1. Fable read-only post-review receives branch diff, screenshots, and test
   report.
2. Codex deduplicates findings and fixes real regressions.
3. Repeat until both reviewers have no release-blocking findings.
4. Mathias reviews final light/dark shell, Appearance, settings, and one dense
   chat screenshot.

### Packaged smoke

- build the app from a clean output directory;
- launch the packaged app, not only dev server;
- verify theme persistence across restart;
- verify update modal and footer without triggering a real install;
- verify local background asset persistence/fallback;
- verify no internal runtime identity is visible;
- verify main chat, settings, artifacts, seat switch, and updater UI.

### Release gate

Notarization and upload happen only after all 1.8.0-f gates and the parallel
bugfix integration are green. Packaging may take 30 minutes or longer; use
heartbeat checks and do not start duplicate build/notarization runs.

## 11. Required Evidence Package

Store under a deterministic report directory:

```text
reports/command-eve-180/
  design/
  screenshots/light/
  screenshots/dark/
  screenshots/background/
  e2e/
  performance/
  packaged-smoke/
  fable-post-review.md
  codex-final-audit.md
  release-gate.md
```

Each slice report contains:

- commit and branch;
- files changed;
- tests run and exit codes;
- screenshot paths;
- known residual risks;
- rollback command/commit;
- next human gate.

## 12. Stop Conditions

Stop implementation and report instead of improvising when:

- the bugfix worktree still owns a required shared file;
- GitNexus reports unreviewed HIGH/CRITICAL impact;
- updater extraction would change check/download/install order;
- migration would delete or mutate saved CSS;
- a user control can bypass contrast/scrim floors;
- an internal runtime/provider logo reappears in public UI;
- the packaged app differs materially from dev screenshots;
- a visual fix requires changing inference/runtime behavior.

## 13. Definition of Done

Command EVE 1.8.0 is done when the approved design is the product's default
visual foundation everywhere, not merely a polished first screen.

There must be no route where a user can reasonably say, "this is the old
AionUI again."
