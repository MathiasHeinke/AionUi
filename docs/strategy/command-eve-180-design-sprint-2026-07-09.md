# Command EVE 1.8.0 Design Sprint

Date: 2026-07-09
Branch: `houston/v16-onboarding`
Status: plan-of-record

> **Founder delta, 2026-07-09:** The approved light/dark direction is now the
> global Command EVE meta-theme, not a chat-shell skin. Clauses below that keep
> decorative AionUI presets in the public product or limit the redesign to a
> small route subset are superseded by
> `docs/strategy/command-eve-180-design.md` and
> `docs/strategy/command-eve-180-implementation-plan-2026-07-09.md`. Existing
> saved theme data is preserved, but legacy presets/custom CSS are migrated out
> of the public default UI.

## Decision

Command EVE 1.8.0 is a visual-design sprint only.

Runtime, Hermes/Honcho activation, cross-runtime worker routing, autonomy loops,
and other operating-system topics move to 1.8.1+. The 1.8.0 scope is to make
the existing Command EVE product surface feel more polished, calmer, more
premium, and more alive without changing the underlying agent/runtime contract.

## Product Goal

Create a coherent Command EVE visual system that keeps the product practical for
daily operator work while adding a controlled glass layer, better hierarchy,
cleaner spacing, more refined light/dark modes, and an optional local background
image mode.

The result must feel like a professional AI work OS, not a decorative mockup.
Glass is a system primitive, not an effect sprinkled across random components.

## Non-Goals

- No new Hermes/Honcho orchestration behavior.
- No model/provider routing changes.
- No new public billing or credit behavior.
- No cloud upload for user background images without an explicit future privacy
  opt-in.
- No broad component-library replacement.
- No landing-page or marketing redesign.
- No release until screenshot QA and accessibility gates pass.

## Existing Ground Truth

- Theme tokens already exist in `docs/theming/tokens.md`.
- Runtime theme injection lives in
  `packages/desktop/src/renderer/utils/theme/applyTheme.ts`.
- Built-in themes live in
  `packages/desktop/src/renderer/theme/builtinThemes.ts`.
- Layout shell lives in
  `packages/desktop/src/renderer/components/layout/Layout.tsx`.
- Layout/global UI CSS lives in
  `packages/desktop/src/renderer/styles/layout.css` and
  `packages/desktop/src/renderer/styles/themes/*`.
- Current sidebar already has an early frosted layer in `layout.css`.
- Current chat header already has a separate glass layer in
  `packages/desktop/src/renderer/pages/conversation/components/ChatLayout/chat-layout.css`.
- Existing background-image customization already exists in
  `packages/desktop/src/renderer/pages/settings/AppearanceSettings/backgroundUtils.ts`
  and is consumed by `CssThemeModal.tsx` / `CssThemeSettings.tsx`.
- Custom theme CSS is processed by
  `packages/desktop/src/renderer/utils/theme/customCssProcessor.ts`, which adds
  `!important` to declarations and is appended last by `applyTheme.ts`.
- Chat surfaces live under
  `packages/desktop/src/renderer/pages/conversation/`.
- Unified input row lives in
  `packages/desktop/src/renderer/components/chat/UnifiedSendBar.tsx`.
- Settings surfaces live under
  `packages/desktop/src/renderer/pages/settings/`.

## Sprint Slices

### 1.8.0-a — Baseline, Design Brief, and Fable Plan

Output:

- Baseline screenshots for desktop light, desktop dark, narrow/mobile, chat,
  settings/privacy, artifacts/preview, history/sidebar, and busy/reasoning
  state where available.
- Inventory of all existing `backdrop-filter` and background-image injection
  sites before any new primitive is introduced.
- `design.md` draft with product principles, screen inventory, token inventory,
  and acceptance gates.
- Fable 5 high read-only plan challenge report.
- Final selected direction before code implementation starts.

Steps:

1. Capture current screenshots from the running dev or packaged app.
2. Generate three image-design directions from the screenshots:
   - restrained glass/professional
   - premium glass/work OS
   - background-image adaptive
3. Send screenshots, chosen direction, and code-surface map to Fable 5 high in
   read-only/plan mode.
4. Integrate real findings into `design.md`.
5. Stop for Mathias selection if image directions materially diverge.

Fable worker contract:

```yaml
RoleLabel: role:cpo
ParentSeat: role:ceo
Agent: claude-fable
Mode: plan
Workspace: /Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-v16-onboarding
Dispatch: manual
SourceOfTruth:
  - docs/strategy/command-eve-180-design-sprint-2026-07-09.md
  - docs/theming/tokens.md
  - packages/desktop/src/renderer/styles/layout.css
  - packages/desktop/src/renderer/styles/themes/base.css
  - packages/desktop/src/renderer/components/layout/Layout.tsx
  - packages/desktop/src/renderer/components/chat/UnifiedSendBar.tsx
Scope:
  Include:
    - visual hierarchy
    - glass-system architecture
    - light/dark parity
    - background-image readability model
    - migration plan
  Exclude:
    - code edits
    - runtime/provider changes
    - billing/credits changes
AcceptanceCriteria:
  - concrete component-by-component plan
  - explicit accessibility/readability gates
  - risks and anti-patterns called out
  - ends with REVIEW_COMPLETE
HumanGate:
  - no build implementation before Mathias/Codex accepts the design direction
Reporting:
  - write report to tmp/fable-command-eve-180-design-plan.md
```

### 1.8.0-b — Theme Tokens and Glass Primitives

Output:

- Stable CSS variables for glass surfaces, shadows, rings, scrims, tint, and
  background-image readability.
- Tiered primitive class set in global styles, consumed by existing components:
  `chrome`, `panel`, and `overlay`.
- Existing sidebar and chat-header glass ported onto the primitives first, with
  screenshot-diff-zero intent before any visible redesign.
- No component-specific hardcoded color spread.
- Decorative/custom CSS themes are explicitly out of scope for redesign in
  1.8.0; they get regression screenshots only, because their `!important`
  ordering intentionally overrides normal primitives.

Example token direction:

```css
:root {
  --eve-glass-chrome-bg: color-mix(in srgb, var(--bg-base) 78%, transparent);
  --eve-glass-panel-bg: color-mix(in srgb, var(--bg-base) 86%, transparent);
  --eve-glass-overlay-bg: color-mix(in srgb, var(--bg-base) 72%, transparent);
  --eve-glass-border: color-mix(in srgb, var(--border-base) 72%, transparent);
  --eve-glass-shadow: 0 18px 48px rgba(16, 24, 40, 0.12);
  --eve-glass-chrome-blur: 12px;
  --eve-glass-panel-blur: 18px;
  --eve-glass-overlay-blur: 22px;
  --eve-scrim-bg: color-mix(in srgb, var(--bg-base) 78%, transparent);
}

[data-theme='dark'] {
  --eve-glass-chrome-bg: rgba(14, 20, 34, 0.68);
  --eve-glass-panel-bg: rgba(16, 21, 32, 0.78);
  --eve-glass-overlay-bg: rgba(16, 21, 32, 0.62);
  --eve-glass-border: rgba(255, 255, 255, 0.08);
  --eve-glass-shadow: 0 18px 52px rgba(0, 0, 0, 0.42);
  --eve-scrim-bg: rgba(8, 10, 14, 0.72);
}

.eve-glass-panel {
  background: var(--eve-glass-panel-bg);
  border: 1px solid var(--eve-glass-border);
  box-shadow: var(--eve-glass-shadow);
  -webkit-backdrop-filter: blur(var(--eve-glass-panel-blur)) saturate(145%);
  backdrop-filter: blur(var(--eve-glass-panel-blur)) saturate(145%);
  contain: paint;
}
```

Gates:

- Text contrast remains readable on light, dark, and background-image mode.
- `prefers-reduced-transparency` keeps surfaces opaque enough where supported.
  Do not use `prefers-reduced-motion` as the transparency proxy.
- No layout shift when glass toggles on/off.
- Do not glass individual message bubbles or large scrolling message lists.

### 1.8.0-c — Chat Shell and Sidebar Polish

Output:

- Cleaner conversation shell.
- Sidebar/historical list alignment, hover states, section headers, active rows,
  archive/group states, and command/status surfaces refined.
- Input composer gets a premium but compact visual system.
- Reasoning/tool/status display is clearer without adding noisy text.

Targets:

- `Layout.tsx`
- `layout.css`
- `GroupedHistory/*`
- `ChatLayout/*`
- `Messages/*`
- `UnifiedSendBar.tsx`
- `AcpSendBox.tsx`

Gates:

- Long chat titles do not overflow.
- Sidebar collapsed/expanded/mobile states still work.
- Busy/reasoning state remains obvious.
- Send/stop/mic/permission controls remain stable and reachable.
- `AcpSendBox.tsx` behavior is not refactored in this slice; visual work should
  stay in presentational slots/classes and SendBox CSS unless a narrowly scoped
  class hook is unavoidable.

### 1.8.0-d — Settings, Privacy, Artifacts, and Capability Surfaces

Output:

- Privacy and capability surfaces look like one coherent settings system.
- Artifact/image/video/audio/HTML/file surfaces use consistent preview framing.
- Datenschutz pill/header alignment remains fixed and visually calmer.

Targets:

- `PrivacySettings.tsx`
- `CapabilitiesSettings.tsx`
- `SkillsHubSettings.tsx`
- `SystemSettings.tsx`
- `Messages/components/MessageGeneratedArtifact.tsx`
- `Messages/artifacts.tsx`
- `media/WebviewHost.tsx`

Gates:

- No hidden internal CLI/provider lanes reappear.
- Existing public/founder boundaries remain intact.
- Artifacts remain inspection-first, not decorative.

### 1.8.0-e — Local Background Image Mode

Output:

- User can select/import a local background image through the existing
  Appearance theme path.
- The image remains local and is stored as an imported copy or existing local
  theme asset, not as a raw original filesystem path in exported config.
- App derives or stores a local theme profile without creating a second,
  parallel background-image system.
- Surfaces automatically adapt with scrim, blur, tint, and contrast variables.

Proposed config shape:

```ts
type EveVisualBackgroundConfig = {
  enabled: boolean;
  imageAssetId?: string;
  fit: 'cover' | 'contain' | 'fill';
  intensity: number;
  blur: number;
  dim: number;
  adaptiveTint: boolean;
};
```

Gates:

- No image leaves the device.
- Missing/deleted image path fails gracefully to the default theme.
- Readability passes on bright, dark, busy, and low-contrast images.
- Export/logging never prints private original local image paths unless
  explicitly needed for local debugging.
- The legacy `backgroundUtils.ts` transparency-punch-through selectors are
  migrated or fenced before new glass primitives ship.

### 1.8.0-f — Visual QA, E2E, and Release Candidate

Output:

- Screenshot matrix committed or archived in a deterministic report path.
- Light/dark/background-image visual QA.
- Targeted unit tests and E2E smoke tests.
- Fable read-only post-review.
- Codex final release gate.

Verification matrix:

```bash
bunx tsc --noEmit
bun run i18n:types
node scripts/check-i18n.js
bunx vitest run tests/unit/command-eve
bun run test:e2e -- --grep "Command EVE"
```

Visual matrix:

- desktop 1440x1024 light
- desktop 1440x1024 dark
- narrow 390x844 light
- narrow 390x844 dark
- desktop background image mode light image
- desktop background image mode dark image
- desktop background image mode bright/busy/low-contrast image
- busy/reasoning state
- artifact preview state
- settings/privacy state
- sidebar collapsed, expanded, and drag-snap
- workspace + preview open three-pane state
- German locale and maximum font-size step
- reduced-transparency mode
- decorative theme regression shots

Release gates:

- No hardcoded user-facing strings.
- No new secret or local-file leakage.
- No broad unrelated refactor.
- No card-inside-card visual sprawl.
- No one-note purple/blue/gray wash.
- No clipped text at tested sizes.
- Long-chat scroll remains smooth with glass + background mode active.
- Packaged smoke before notarization.

## Fable 5 Plan Challenge

First read-only Fable 5 high pass completed on 2026-07-09 with verdict
`PASS_WITH_FIXES` and sentinel `REVIEW_COMPLETE`.

Accepted corrections:

- 1.8.0-e must extend or migrate the existing Appearance background-image
  mechanism; it must not introduce a second parallel background store.
- 1.8.0-b starts with consolidation of existing glass sites before new visual
  changes.
- Glass tokens are tiered as chrome/panel/overlay.
- Decorative/custom CSS themes are regression-tested but not redesigned in
  1.8.0 because their `!important` pipeline intentionally wins the cascade.
- Reduced transparency is a hard gate and must not be proxied through reduced
  motion.
- `AcpSendBox.tsx` logic remains out of visual scope.
- The visual QA matrix includes collapsed/expanded sidebar, three-pane preview,
  German/max-font, reduced-transparency, decorative presets, and long-chat
  scroll performance.

## Image Generation Brief

Target: Command EVE desktop app, 1440x1024.

Generate three independent UI directions from the current Command EVE surfaces.
Keep the product recognizable as a serious AI work OS. Improve hierarchy,
spacing, typography, light/dark polish, and glass depth. Include the chat
composer, sidebar/history, session header, privacy pill, status/reasoning
indicator, and artifact preview affordance. Use subtle glass surfaces and
native-feeling macOS depth. Avoid decorative blobs, card soup, marketing hero
layouts, or unreadable translucent layers.

Direction A: restrained professional glass.
Direction B: premium dark/light work OS.
Direction C: adaptive local background image mode.

## Implementation Rules

- Build from tokens and primitives first.
- Keep existing Arco and IconPark usage.
- Prefer CSS variables and existing theme infrastructure.
- Use CSS Modules only for complex component-scoped work.
- Do not add a new visual framework.
- Do not change runtime behavior in visual slices unless required to support the
  background-image setting.
- Every visual change needs screenshot evidence.

## Acceptance

1. Mathias can compare before/after screenshots and see a clear premium polish
   improvement without losing product clarity.
2. Light and dark mode both feel intentional.
3. Glass is consistent, readable, and restrained.
4. Background image mode is local-first and safe.
5. Existing Command EVE public/runtime/founder gates remain intact.
6. The 1.8.0 release can be notarized only after the visual QA matrix and
   Fable/Codex post-review pass.
