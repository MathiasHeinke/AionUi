# Command EVE 1.8.0 Design Contract

Status: **plan of record**
Date: 2026-07-09
Scope: visual system, global theme, Appearance controls, and visual QA
Runtime scope: unchanged

## Provenance

This contract integrates:

- the approved light and dark Image 2.0 directions;
- the founder decisions from the 2026-07-09 design review;
- the first Fable 5 High design pass;
- the Fable 5 High meta-theme addendum;
- the final Codex repo and implementation audit.

Supporting artifacts:

- `docs/strategy/assets/command-eve-180/command-eve-180-light-approved.png`
- `docs/strategy/assets/command-eve-180/command-eve-180-dark-approved.png`
- `docs/strategy/assets/command-eve-180/command-eve-180-dark-final.png`
- `docs/strategy/command-eve-180-fable-design-v2-2026-07-09.md`
- `docs/strategy/command-eve-180-fable-meta-theme-addendum-2026-07-09.md`
- `docs/strategy/command-eve-180-design-sprint-2026-07-09.md`

The two Fable reports are evidence and challenge material. This file is the
normative decision after Codex adjudication.

## 1. Product Decision

Command EVE 1.8.0 is not a chat-dashboard reskin. The approved visual direction
becomes the **global product meta-theme**.

Every public route, submenu, dialog, popover, artifact, empty state, loading
state, error state, and settings surface must inherit the same visual language:

- neutral light and graphite dark foundations;
- restrained frosted glass for shell chrome, panels, and overlays;
- the orange Command glyph as the only brand anchor;
- blue for interaction and selection;
- red, yellow, green, and blue for semantic state;
- precise spacing, quiet hierarchy, and modern native depth;
- optional local background images with a mandatory readability floor.

The old AionUI theme gallery and its novelty presets are not part of the public
Command EVE product. Existing stored values are migrated without data loss, but
the legacy visual language must not remain visible in the default app.

## 2. Non-Goals

- No Hermes, Honcho, inference, model-routing, billing, or credit changes.
- No public exposure of Claude, Codex, Gemini, CLI, or provider internals.
- No component-library replacement. Arco Design and IconPark remain.
- No glass on individual message bubbles or large scrolling regions.
- No card-inside-card settings composition.
- No cloud upload of user background images.
- No deletion of existing user CSS or theme data during migration.
- No behavioral refactor of `AcpSendBox.tsx`, `UnifiedSendBar.tsx`, seat
  switching, or updater IPC for visual reasons.
- No notarized release before the full route and state matrix passes.

## 3. Locked Visual References

The approved renders define direction, density, and mood. They are not allowed
to override product truth or accessibility.

The following adaptations are mandatory:

1. The black rounded tile around the top-left logo is removed.
2. The existing `public/command-eve-logo.svg` is not used directly in app
   chrome because the dark tile is embedded inside the SVG.
3. A transparent `CommandEveGlyph` renders the orange `⌘` for in-app chrome.
4. Every public conversation and project-chat row uses the EVE glyph. Runtime,
   backend, assistant, and CLI logos do not appear in history rows.
5. The selected row is quieter than the current full-width slab.
6. The pointer shown in the render only demonstrates the hover state. The app
   never renders a synthetic cursor.
7. The seat rail is admin-only and fail-closed; the shell must still look
   complete when it is absent.

## 4. Color Semantics

### 4.1 Brand

```css
:root {
  --eve-brand-logo: #f97316;
  --eve-brand-ui: #c2410c;
  --eve-brand-soft: color-mix(in srgb, var(--eve-brand-logo) 14%, transparent);
}

[data-theme='dark'] {
  --eve-brand-ui: #fb923c;
}
```

`--eve-brand-logo` is the official identity color. Its contrast on white is
below the 3:1 control threshold, so it is used for the exempt brand mark and
decorative spotlight only. Interactive outlines and small functional marks use
`--eve-brand-ui` or the primary interaction color.

Orange is never a status color.

### 4.2 Interaction

Default accent: blue. Appearance may offer pre-validated blue, petrol,
emerald, and graphite pairs. Purple is not offered. Brand orange and semantic
status colors are not user-selectable accent colors.

The selected accent must update both token forms already used by the app:

- `--color-primary-*` color values;
- `--primary-*` RGB triplets consumed by `rgba(var(--primary-6), ...)`.

### 4.3 Status

```css
--eve-status-running: var(--color-primary-6);
--eve-status-new: var(--color-primary-6);
--eve-status-error: var(--color-danger-6);
--eve-status-attention: #a16207;
--eve-status-completed: var(--color-success-6);
--eve-status-ring: var(--eve-row-surface);
```

Dark mode may use lighter token aliases, but semantic meaning never changes.
Attention yellow must pass a measured 3:1 non-text contrast gate in light mode.

Status is not encoded by color alone:

| State       | Color  | Shape / motion                           | Meaning                 |
| ----------- | ------ | ---------------------------------------- | ----------------------- |
| `running`   | blue   | outlined ring, restrained pulse          | EVE is working          |
| `error`     | red    | rounded square                           | failed or blocked       |
| `attention` | yellow | diamond                                  | user action is required |
| `completed` | green  | filled circle with check at larger sizes | task completed          |
| `newResult` | blue   | filled circle                            | unread result           |
| `idle`      | none   | none                                     | nothing to surface      |

Every indicator also has an i18n tooltip and accessible label.

## 5. Glass System

The existing chrome, panel, and overlay token tiers remain canonical. New
components consume shared variables instead of inventing local translucency.

### Chrome

Use for fixed shell structure: titlebar, sidebar, seat rail, and footer. This is
the lightest persistent material: high background visibility, medium blur,
quiet border, and low shadow.

### Composer

Use only for the primary chat input. It is slightly more opaque than chrome so
placeholder text, dictated text, attachments, and focus state stay readable,
while the background remains visibly continuous through the surface.

### Reading

Use behind long-form chat and document text projected over a background image.
It is more opaque than the composer and has no card border, hover state, or
local shadow. This is a contrast plane, not a container users can click.

### Panel

Use for settings groups, artifact frames, privacy/capability groups, and
inspectable content. Stronger fill and no nested panels.

### Overlay

Use for popovers, search, dropdowns, menus, and modals. Strongest separation,
compact geometry, and a solid reduced-transparency fallback.

### User-adjustable glass

Appearance exposes **Glass opacity**, not unrestricted transparency. The
stored 72%-100% setting is projected through role-specific safety floors rather
than applied as one flat alpha value:

- chrome: 34% light / 48% dark minimum; dark chrome uses a near-black tint so
  it remains translucent without turning milky gray;
- composer: 48% light / 52% dark minimum;
- reading: 66% light / 70% dark minimum;
- panel: 72% minimum;
- overlay: 80% minimum;
- light default: 84%;
- dark default: 84%;
- background-image mode may raise the minimum automatically;
- OS reduced-transparency or EVE reduced-effects forces 100% opaque;
- blur range: 0 to 28px, default 20px;
- user values can reduce an effect, never exceed the designed transparency or
  blur ceiling.

Text contrast, focus contrast, and scrim floors cannot be disabled.

### 5.1 Functional material audit

Glass is assigned by **role**, not by how decorative a component looks. Every
public element must be classified before styling:

| Role                 | Required primitive             | Resting material                                                 | Required state                                                            |
| -------------------- | ------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| command              | `button` / Arco `Button`       | transparent inside existing chrome; panel only when freestanding | hover, active, focus-visible, disabled, accessible name                   |
| navigation           | link or navigation button      | transparent row                                                  | `aria-current`, keyboard activation, quiet selected hairline              |
| disclosure           | button                         | transparent                                                      | `aria-expanded`, visible chevron, Enter/Space                             |
| selection            | radio, checkbox, switch, tab   | control or segmented surface                                     | selected/checked state exposed to assistive tech                          |
| status               | non-interactive text/indicator | no button treatment                                              | semantic shape and accessible label; live region only for error/attention |
| reading surface      | non-interactive region         | reading tier                                                     | no pointer cursor or hover fill; contrast floor is mandatory              |
| inspectable artifact | panel tier                     | panel or solid fallback                                          | toolbar commands remain separate from content                             |
| transient choice     | menu, popover, dialog          | overlay tier                                                     | focus containment/return and escape behavior                              |
| structure/divider    | semantic container             | transparent                                                      | never styled like a command                                               |

Rules:

- Clickable `div`/`span` elements are forbidden on public surfaces unless a
  composite widget cannot legally use a native control; such exceptions need a
  correct role, tab stop, keyboard handler, and test.
- Static labels, status badges, and reading panels never gain hover fill merely
  to look interactive.
- Toolbar controls are icon-only when the symbol is familiar, with localized
  tooltip and `aria-label`; mode switches and ambiguous business actions keep
  text.
- Chrome is the lightest persistent material. Reading and panel tiers are more
  opaque. Overlay is the most opaque glass tier. Code, QR, video, and image
  inspection may use a solid local backing when translucency harms fidelity.
- A background-image work area uses a centered reading veil: the text column
  keeps the full reading floor while outer edges reveal more of the image. It
  must never become one flat opaque sheet or leave long-form text directly on
  raw photography.
- Do not stack a glass card inside another glass card. Child controls use
  transparent resting states and borrow separation from their owning surface.
- Reduced-transparency and reduced-effects always replace blur with the matching
  solid tier without changing layout or interaction semantics.
- `tests/unit/renderer/interactiveElementSemantics.test.ts` scans every renderer
  TSX file. A clickable non-native element fails CI unless it is a valid
  keyboard-operated composite control or a named structural interaction such
  as a resize handle, dismiss backdrop, or event boundary.

## 6. Brand Mark

Introduce a presentational `CommandEveGlyph` that renders a transparent,
unboxed `⌘` using `--eve-brand-logo`.

Rules:

- top shell mark: 28-32px, no tile, border, or container shadow;
- optional restrained orange optical glow in dark mode only;
- row mark: 16px, neutral/muted at idle, full contrast when selected or badged;
- decorative instance: `aria-hidden='true'`;
- interactive parent owns its accessible name;
- favicon, installer, and packaged app icon may keep the existing square asset;
- no runtime/provider/assistant logo is rendered in public chat history.

Placement:

- admin with seat rail: top slot of `SeatRail`, below any macOS-reserved window
  control area;
- rail absent: sidebar header slot;
- mobile: titlebar brand treatment follows existing centered-title behavior.

## 7. Seat Rail

Keep the existing security, switching, dimensions, tooltips, and interrupt
confirmation behavior. Change only presentation.

Expanded seat:

- 48px target, 44px glass monogram;
- neutral glass fill and border;
- active seat: neutral selection ring plus green online dot;
- inactive seat: 6px identity-color rim dot;
- no saturated seat-color fill.

Collapsed seat:

- target remains at least 28px;
- use a neutral glass dot with the identity color as a small rim segment;
- tooltip remains the identity source if the accent cannot be distinguished.

The rail remains exactly 72px expanded and 40px collapsed because other layout
math consumes `--seat-rail-width`.

## 8. Sidebar Rows

### 8.1 Anatomy

`[EVE glyph + status] [title] [timestamp] [hover/focus menu]`

- row height remains 34px;
- titles truncate to one line with a tooltip;
- timestamps hide on narrow/mobile layouts;
- project children preserve indentation;
- pinned, batch, archive, drag, and context-menu behavior remain intact.

### 8.2 Selection

Selected is orthogonal to execution status.

```css
.conversation-item--selected {
  background: var(--eve-row-selected-bg);
  box-shadow: inset 2px 0 0 var(--eve-row-selected-hairline);
}
```

The selected title stays neutral high-contrast text. Do not use a saturated
blue title, heavy slab, panel border, or card shadow.

### 8.3 Status precedence and clearing

Precedence:

`running -> error -> attention -> completed -> newResult -> idle`

Clearing:

- `running`: terminal generation event;
- `error`: successful retry, explicit resolution, or explicit acknowledge;
  merely opening the chat does not imply the error is fixed;
- `attention`: required action completed or request explicitly dismissed;
- `completed`: task result opened/acknowledged;
- `newResult`: result opened/acknowledged.

Important status must be derived from durable existing conversation/cron truth
where available. A restart must not silently claim `idle` if persisted product
truth still says error, attention, or unread. 1.8.0 may not invent a second
status database; it must read the existing conversation, turn, and cron stores.

Only error and attention transitions are announced in a polite live region.
Other states remain available through row focus and tooltips without creating
announcement noise.

## 9. Composer

The composer is the primary work surface and one of at most three persistent
blurred surfaces.

Rules:

- translucent panel tier with solid fallback;
- paperclip and all other controls share one baseline and stable 32px targets;
- no control reordering inside `UnifiedSendBar`;
- blue send/stop action styling, no `--aou-*` purple ramp;
- local orange border spotlight only around the pointer;
- normal neutral border at rest;
- blue 2px focus-visible ring for keyboard operation;
- spotlight suppressed while focus-visible ring is active;
- no synthetic pointer.

Spotlight contract:

```css
--eve-spotlight-x: 50%;
--eve-spotlight-y: 0%;
--eve-spotlight-radius: 220px;
--eve-spotlight-opacity-light: 0.5;
--eve-spotlight-opacity-dark: 0.68;
```

Implementation uses a masked pseudo-element. Pointer coordinates are
element-relative, `getBoundingClientRect()` is cached on enter/resize, and
pointer writes are coalesced to one `requestAnimationFrame` update.

Fallbacks:

- pointer leave: 180-240ms opacity fade;
- touch/coarse pointer: static 30% brand-mixed hairline;
- reduced motion: static hotspot, no tracking/pulse;
- reduced transparency: solid surface, spotlight border may remain;
- unsupported mask: neutral border plus a small `box-shadow` hotspot fallback.

## 10. Sidebar Account and Update Footer

Replace the generic bottom settings row with one coherent footer:

`[avatar] [display name]                         [update control]`

The identity area remains the Settings/back entry point. It uses the canonical
local registration profile already consumed by `ProfileAvatar`; no email is
rendered in the footer.

Signed-out fallback: EVE glyph plus localized `Einstellungen` / `Settings`.

The update control mirrors existing updater truth and opens `UpdateModal` for
details and decisions. It does not duplicate check/download/install logic.

| State       | Rest                        | Expanded label    | Action              |
| ----------- | --------------------------- | ----------------- | ------------------- |
| current     | quiet refresh icon          | Check for updates | open modal/check    |
| checking    | indeterminate ring          | Checking...       | open modal          |
| available   | blue download button        | Update            | open modal/download |
| downloading | progress ring               | Loading... N%     | open modal          |
| ready       | blue install/restart button | Restart & install | open modal          |
| error       | red retry icon              | Update failed     | open modal/retry    |

Behavior:

- collapsed width: icon-only with tooltip;
- expanded sidebar: width grows from 32px to content width on hover/focus;
- transition: 160ms width and label-opacity easing;
- reduced motion: state changes instantly;
- touch: actionable states remain expanded, current stays icon-only;
- available state remains expanded for five seconds once per app session;
- all state text is present in `aria-label` even when visually collapsed;
- real Arco button primitive, minimum 28px target, focus-visible ring;
- update IPC order and updater tolerances remain unchanged.

The profile and updater state should be shared through hooks/context rather than
duplicating bridge calls in the titlebar, footer, and modal.

## 11. Global Meta-Theme Primitives

All routes inherit root tokens through `ThemeProvider`, global shell classes,
and the Arco alias layer. The implementation should expose reusable classes or
small primitives for:

- `eve-chrome`;
- `eve-panel`;
- `eve-overlay`;
- `eve-row`;
- `eve-pill`;
- `eve-artifact-frame`;
- `eve-empty-state`;
- `eve-dialog`.

These are ownership boundaries, not decorative cards.

Every route must use the same foundation immediately, even if its internal
information architecture is improved in a later release.

Coverage includes:

- start screen and chat;
- history, groups, archive, search, and teams;
- command center and tasks;
- settings and every settings submenu;
- privacy, billing, account, Company Brain, capabilities, connectors, runtime,
  diagnostics, remote, and system;
- onboarding and registration gates;
- artifact, image, video, audio, HTML, file, and table previews;
- dialogs, confirmations, popovers, toasts, empty/loading/error states;
- workspace and three-pane layouts.

No public route may expose unthemed Arco defaults, old white-card galleries,
purple `--aou-*` washes, or legacy AionUI branding.

## 12. Appearance Settings

The current preset-card gallery is replaced by an operator-focused control
surface. The app itself is the live preview; no novelty preview cards.

### 12.1 Information architecture

1. **Mode**: System, Light, Dark segmented control.
2. **Accent**: pre-validated blue, petrol, emerald, graphite swatches.
3. **Glass and effects**: opacity, blur, reduced effects.
4. **Background**: local image, fit, intensity, blur, dim, adaptive tint.
5. **Typography**: existing chat, markdown, and code sizes.
6. **Interface scale**: existing persisted scale control and verified bounds.
7. **Reset**: per-section reset and global reset with confirmation.
8. **Advanced**: custom CSS only in founder/developer mode.

### 12.2 Control rules

- Mode defaults to System for new installs; existing light/dark preference is
  preserved during migration.
- System mode listens to `prefers-color-scheme` without writing a config loop.
- Glass opacity: 72-100%, accessibility floor enforced.
- Glass blur: 0-28px.
- Background fit: cover, contain, fill.
- Background intensity: 20-100%, with a non-overridable scrim floor.
- Background blur: 0-24px.
- Background dim: 0-60%.
- Typography retains current per-region clamps.
- Accent selection updates instantly but may not change semantic colors.
- Reduced effects cannot override an OS accessibility preference in the less
  restrictive direction.
- Slider changes are locally previewed and debounced before persistence.
- Reset is reversible until confirmed.

### 12.3 Legacy theme migration

- Public `BUILTIN_THEMES` contains only the new Command EVE light/dark base.
- System is stored as a preference, not a third decorative CSS theme.
- Decorative preset IDs map to light/dark based on their previous appearance.
- Active user/extension CSS themes map to the new light/dark base.
- Existing user CSS and theme objects are retained byte-for-byte in storage.
- Saved custom CSS is not auto-applied in public mode.
- Public builds show no `Manuell hinzufügen` entry or legacy preset cards.
- Founder/developer mode may expose the existing editor behind an explicit
  warning and remains backwards-compatible.
- Migration is idempotent and emits one localized notice.
- Background-image migration extends the existing Appearance path; no parallel
  background store is introduced.

## 13. Artifacts, Settings, and Overlays

Artifacts use a solid panel-tier frame inside scrolling chat content:

- header with type, filename, and open/download actions;
- content region with stable dimensions and overflow;
- no backdrop filter inside the message list;
- no decorative media frame.

Settings groups use one panel level with direct controls. Nested panel stacks
are prohibited.

Overlays use the overlay tier with strong focus, compact spacing, and a solid
reduced-transparency fallback.

## 14. Background Image Contract

- local import only;
- no raw original path in exported config, logs, telemetry, or artifacts;
- existing `backgroundUtils.ts` path is extended/migrated;
- missing asset falls back to the normal theme;
- background mode raises glass opacity as needed;
- bright, dark, busy, and low-contrast references must pass measured contrast;
- user controls cannot lower the scrim below the readability floor;
- adaptive tint is local and deterministic.

## 15. Accessibility Gates

Release-blocking:

- body text at least 4.5:1;
- large text and functional strokes at least 3:1;
- status meaning is not color-only;
- real keyboard activation for conversation rows;
- visible focus on every interactive surface;
- minimum 28px targets, larger where mobile requires it;
- German and English at 200% zoom and maximum font settings;
- full accessible names for collapsed controls;
- no hover-only action path;
- separate reduced-motion and reduced-transparency behavior;
- no announcement spam;
- no clipping or overlap in collapsed/sidebar/mobile states.

## 16. Performance Gates

- Maximum three persistent backdrop-filter surfaces per window: sidebar/shell,
  chat header, composer.
- Rows, messages, artifact frames, and scrollable settings groups use solid or
  translucent fills without their own filter.
- Pointer tracking performs at most one style write per frame and no React
  state update per move.
- Animations use opacity and transform except the bounded update-control width
  transition.
- No layout shift when glass or accessibility fallbacks toggle.
- 500-message scroll trace may not regress against the 1.7.x baseline.
- Background image, spotlight, and three-pane mode are included in the trace.

## 17. Repo Surface Map

| Surface        | Primary files                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Theme runtime  | `hooks/context/ThemeContext.tsx`, `hooks/system/useTheme.ts`, `utils/theme/applyTheme.ts`, `common/theme/*`                |
| Tokens         | `styles/themes/default-color-scheme.css`, new Command EVE visual token layer, `styles/arco-override.css`                   |
| Shell          | `components/layout/Layout.tsx`, `styles/layout.css`, `components/layout/Titlebar/*`                                        |
| Seat rail      | `components/seats/SeatRail.tsx`, `styles/seatRail.css`                                                                     |
| Sidebar footer | `components/layout/Sider/SiderFooter.tsx`, `components/layout/Sider/index.tsx`, `components/account/ProfileAvatar.tsx`     |
| Updater        | `components/settings/UpdateModal.tsx`, existing update IPC/types, new shared observer hook/context                         |
| History rows   | `pages/conversation/GroupedHistory/ConversationRow.tsx`, `SessionStatusDot.tsx`, `sessionStatus.ts`, sortable wrappers     |
| Composer       | `components/chat/UnifiedSendBar.tsx`, `components/chat/SendBox/*`, `GuidInputCard.tsx`, visual class hooks in ACP send box |
| Appearance     | `AppearanceModalContent.tsx`, `AppearanceSettings/*`, `theme/builtinThemes.ts`, `customCssProcessor.ts`                    |
| Settings       | `pages/settings/*`, `SettingsPageWrapper`, `SettingsSider`, settings modal contents                                        |
| Artifacts      | `MessageGeneratedArtifact.tsx`, `Messages/artifacts.tsx`, `media/WebviewHost.tsx`                                          |
| Global dialogs | `components/base/AionModal.tsx`, Arco override layer, route fallbacks                                                      |
| i18n           | `services/i18n/locales/*`, generated i18n key types                                                                        |

Before implementation, use the architecture skill to choose new file locations.
`GroupedHistory` is already at its direct-child limit.

## 18. Verification Matrix

### Visual

- desktop 1440x1024: light and dark for every public route;
- narrow 390x844: start, chat, settings, account/update footer;
- sidebar expanded, collapsed, drag-snap, long titles, project children;
- every row status, selected row, selected-plus-status;
- seat rail expanded/collapsed, active, focus, switching;
- composer idle, four pointer positions, focus, touch, reduced motion,
  reduced transparency;
- updater current/checking/available/downloading/ready/error;
- Appearance default and every control extreme;
- settings, dialogs, loading, empty, and error states;
- artifact image/video/audio/HTML/file/table surfaces;
- workspace plus preview three-pane mode;
- four background-image contrast references;
- German/English, max font size, 200% zoom.

### Automated

- status precedence, shape, label, and clearing tests;
- row keyboard activation and nested-menu focus tests;
- seat switch behavior remains unchanged;
- update observer does not duplicate checks or IPC calls;
- update footer opens the existing modal for every state;
- theme migration fixtures for decorative, user, and extension themes;
- user theme data remains byte-identical after migration;
- public build contains no visible custom-theme entry;
- system mode responds to OS changes without config loops;
- accent aliases cover both color and RGB token forms;
- glass and background controls cannot cross accessibility floors;
- no new renderer color literals outside approved token files;
- no visible `--aou-*` use in Command EVE screenshots;
- TypeScript, i18n generation/check, targeted Vitest, Command EVE E2E, and
  packaged smoke all pass.

## 19. Hard Release Gates

- The global meta-theme is visible on every public route.
- No legacy AionUI visual language remains in the public default product.
- No runtime/provider behavior changed as part of the visual sprint.
- No theme/user data was deleted.
- No local path or image data leaked.
- No status lies after restart or clears merely because a row was opened.
- No internal model/CLI identity appears in chat history.
- No unreadable glass or background state.
- No unreviewed shared-file conflict with the parallel bugfix worktree.
- Fable post-review and Codex final visual audit pass before release.
