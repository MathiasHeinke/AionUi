
# Fable 5 High Meta-Theme Addendum - Command EVE 1.8.0

Date: 2026-07-09
Mode: read-only plan review via Claude Max
Completion sentinel: `ADDENDUM_REVIEW_COMPLETE`

This is the normalized Fable worker output for the founder's global-theme,
Appearance, and update-footer delta. It is review evidence; the integrated
decision lives in `docs/strategy/command-eve-180-design.md`.

---

## Worker Addendum

Command EVE 1.8.0 — Meta-Theme Addendum (Founder Delta, 2026-07-09)

Status: normative addendum to the v2 design contract. Where this addendum conflicts with the v2 contract or the sprint plan-of-record, this addendum wins.

---
1. Exact Changes to the v2 Design Contract

┌─────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Contract   │                                                                            Change                                                                             │
│   section   │                                                                                                                                                               │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ §1 Product  │ Add principle 0: the approved light/dark direction is the global product meta-theme. Every route, submenu, dialog, empty/loading/error state renders through  │
│ Intent      │ the new tokens/primitives — not only the chat dashboard.                                                                                                      │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ §2          │ Superseded: “Decorative/user CSS themes are preserved and regression-tested, not redesigned.” Decorative presets are removed from the public product (§6      │
│ Non-Goals   │ below). This consciously reverses a sprint-accepted Fable correction; migration tests replace decorative regression shots. The non-goal “no broad             │
│             │ component-library replacement” stands — the meta-theme is tokens + primitives, not new components.                                                            │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│             │ Add §5.9 user-control tokens: --eve-user-glass (glass-transparency factor 0–1), --eve-user-blur (blur factor 0–1), --eve-accent (curated accent, applied by   │
│ §5 Token    │ overriding --primary/--color-primary-* through the existing theme.tokens pipeline in applyTheme.ts:29–41), --eve-user-reduced-effects (attribute flag         │
│ Taxonomy    │ html[data-eve-reduced-effects], additive to — never a replacement for — the OS media queries). All glass tier fills/filters become calc()/color-mix()         │
│             │ expressions of the designed value × the user factor, so user settings can only move toward solid, never past the designed transparency maximum.               │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ §6          │                                                                                                                                                               │
│ Component   │ Add §6.12 Sidebar footer: account identity + update control (contract in §5 of this addendum).                                                                │
│ Anatomy     │                                                                                                                                                               │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ §6.10       │ Extend: all settings pages (screenshot 3 shows the legacy white-card AionUI look on Darstellung) adopt panel-tier groups, §6.3 section headers, and semantic  │
│ Settings    │ tokens in 1.8.0-e.                                                                                                                                            │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ §13 Surface │ Add rows per §2 below.                                                                                                                                        │
│  map        │                                                                                                                                                               │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ §14 Slices  │ Re-scoped per §7 below.                                                                                                                                       │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ §15 Matrix  │ Expanded per §7: full-route light/dark coverage replaces the chat-centric matrix; decorative-theme shots dropped, migration tests added.                      │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ §17 Gaps    │ Items 12/14 remain; decorative-pruning question is now answered (remove from public).                                                                         │
└─────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

2. Repo-Grounded Component/File Map (delta)

┌───────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│      Surface      │                                                                          Files                                                                          │
├───────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Sidebar footer    │ components/layout/Sider/SiderFooter.tsx (rebuild), Sider/index.tsx (props), new components/layout/Sider/UpdateFooterControl.tsx + co-located CSS        │
│ (account +        │ Module, new hooks/system/useUpdateStatus.ts                                                                                                             │
│ update)           │                                                                                                                                                         │
├───────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Update truth      │ components/settings/UpdateModal.tsx (status machine at line 17; stays the detail surface), common/update/updateTypes.ts, ipcBridge.autoUpdate.* /       │
│ (read-only reuse) │ ipcBridge.update.* (unchanged), Layout mount + aionui-open-update-modal event (Layout.tsx:209–215, 396–398)                                             │
├───────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Account identity  │ components/layout/Titlebar/ ProfileAvatar (reuse avatar source), pages/settings/AccountSettings.tsx (name source)                                       │
├───────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Meta-theme base   │ styles/themes/default-color-scheme.css, new styles/themes/command-eve-visual.css (v2 §5 + §5.9 tokens)                                                  │
├───────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Theme runtime     │ utils/theme/applyTheme.ts, common/theme/resolveTheme.ts, theme/builtinThemes.ts (prune decorative), utils/theme/customCssProcessor.ts (gated),          │
│                   │ utils/theme/applyFontSizes.ts, common/config/fontSizes.ts                                                                                               │
├───────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Appearance        │ pages/settings/AppearanceSettings/index.tsx, components/settings/SettingsModal/contents/AppearanceModalContent.tsx (replaced),                          │
│ rebuild           │ AppearanceSettings/CssThemeSettings.tsx + CssThemeModal.tsx (gated to advanced), AppearanceSettings/presets/* + presets.ts + themeCovers.ts (retired    │
│                   │ from public), AppearanceSettings/backgroundUtils.ts (v2 §12 path)                                                                                       │
├───────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Migration         │ new utils/theme/migrateLegacyTheme.ts (startup remap, §6 below)                                                                                         │
├───────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Route sweep       │ every page under pages/ per §3; styles/arco-override.css (Arco --color-* aliases are the inheritance rail); components/base/AionModal (dialog tier)     │
└───────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

3. Global Route/Surface Coverage Matrix

Inheritance mechanism: tokens are :root-global and Arco reads them via the alias layer (arco-override.css, docs/theming/tokens.md §Arco aliases), so every route inherits the
meta-theme the moment 1.8.0-b lands. The per-route work is hunting residual hardcoded colors / legacy --aou-* washes / white-card layouts, not re-theming.

Routes from components/layout/Router.tsx:127–179:

┌──────────────────────────────────────────────────────────────────────────────────────┬─────────────────────┬────────────────────────────────────────────────────────────────┐
│                                        Route                                         │       Surface       │                             Action                             │
├──────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────────────────────────────────────────────┤
│ /login, registration gate                                                            │ auth shell          │ targeted pass (brand glyph, panel tier) — light layout work    │
│                                                                                      │                     │ only                                                           │
├──────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────────────────────────────────────────────┤
│ /guid                                                                                │ start screen        │ v2 §6.6/6.8 (slice d)                                          │
├──────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────────────────────────────────────────────┤
│ /conversation/:id                                                                    │ chat shell          │ v2 core (slices c/d)                                           │
├──────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────────────────────────────────────────────┤
│ /team/:id                                                                            │ teams               │ inherit + targeted pass; screenshot gate                       │
├──────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────────────────────────────────────────────┤
│ /settings/erste-schritte, model, eve-runtime, capabilities, connectors, runtime,     │ settings system     │ inherit + §6.10 panel-tier pass (slice e); each page gets a    │
│ webui, pet, system, billing, company-brain, account, about, privacy                  │                     │ light/dark shot                                                │
├──────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────────────────────────────────────────────┤
│ /settings/appearance                                                                 │ meta-theme control  │ full rebuild (§4 below)                                        │
│                                                                                      │ surface             │                                                                │
├──────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────────────────────────────────────────────┤
│ /settings/ext/:tabId                                                                 │ extension settings  │ inherit only; frozen for edits (parallel bug-fix worktree owns │
│                                                                                      │                     │  these files — v2 §14.7)                                       │
├──────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────────────────────────────────────────────┤
│ /scheduled, /scheduled/:job_id                                                       │ cron/tasks          │ inherit + targeted pass                                        │
├──────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────────────────────────────────────────────┤
│ /kanban                                                                              │ kanban board        │ inherit + targeted pass                                        │
├──────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────────────────────────────────────────────┤
│ /command-center                                                                      │ founder-only        │ inherit; screenshot gate only (never public; no layout         │
│                                                                                      │                     │ investment in 1.8.0)                                           │
├──────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────────────────────────────────────────────┤
│ /test/components                                                                     │ dev showcase        │ inherit; excluded from release gates                           │
├──────────────────────────────────────────────────────────────────────────────────────┼─────────────────────┼────────────────────────────────────────────────────────────────┤
│ Cross-route: AionModal dialogs, Arco Message/Modal.confirm, UpdateModal,             │                     │ one shared pass in slice e (overlay tier + scrim);             │
│ withRouteFallback loading/error fallbacks, empty states                              │ overlay/panel tiers │ loading/error fallback screens explicitly included in the      │
│                                                                                      │                     │ matrix                                                         │
└──────────────────────────────────────────────────────────────────────────────────────┴─────────────────────┴────────────────────────────────────────────────────────────────┘

Enforcement: a lint-style gate in 1.8.0-f — no new hex/rgb literals in packages/desktop/src/renderer outside styles/themes/* and styles/colors.ts, and no visible --aou-* purple
surface in any matrix screenshot.

4. Appearance Settings — Information Architecture & Controls

Replaces the gallery page in screenshot 3 (preset cards + “Manuell hinzufügen”). New IA, one panel-tier group per section:

1. Modus — segmented: Hell / Dunkel / System. System resolves via matchMedia('(prefers-color-scheme)') and re-resolves live; stored as appearance.mode. Default for new installs:
System; existing installs keep their resolved appearance (§6).
2. Akzentfarbe — curated swatches only (no free color picker): Blau (default, #165dff/#4d9fff), Petrol, Smaragd, Graphit — each a pre-validated light/dark pair applied as
--primary/--color-primary-* token overrides. Brand orange is not selectable (reserved for brand); semantic red/yellow/green never change; no purple option.
3. Glas & Effekte — Transparenz slider 0–100% (0 = solid, 100 = designed maximum; maps to --eve-user-glass; the designed values are the ceiling, so every position passes the
contrast floors by construction). Weichzeichnung slider 0–100% of designed blur (--eve-user-blur, ceiling 20px chrome / 12px panel / 18px overlay). Reduzierte Effekte toggle
(forces solid tiers, disables spotlight tracking + pulses; OS prefers-reduced-* settings still apply independently and cannot be overridden off).
4. Hintergrundbild — enable, image import (local-first, v2 §12), Anpassung (cover/contain/fill), Intensität 20–100% (floor --eve-bgimg-scrim-floor non-underridable),
Weichzeichnung 0–24px, Abdunklung 0–60%, adaptive Tönung toggle.
5. Typografie & Skalierung — existing chat/markdown/code steppers (defaults 16/15/13, ranges per common/config/fontSizes.ts FONT_SIZE_SPECS; minimum clamps ≥12/12/10px) and the
existing Skalierung/zoom control (default 100%; verify shipped bounds, gap G6).
6. Zurücksetzen — per-section reset + global “Auf Standard zurücksetzen” (with confirm).
7. Erweitert (gated) — custom CSS, per §6 decision below. Not rendered in public default builds.

Live preview: every control applies immediately through the existing applyTheme/theme-tokens pipeline (sliders debounced ~100ms); the app itself is the preview — no mock preview
cards. All labels via i18n keys under settings.appearance.*.

5. Update Footer — State & Interaction Contract

Placement: SiderFooter row 1 becomes [avatar 24px + display name, truncating] (click = the existing onSettingsClick target; inside settings it shows the back affordance as today)
with the update control right-aligned in the same 34px row. Logout and in-settings theme-toggle rows are unchanged below/beside. Collapsed sidebar: avatar-only + icon-only
update control stacked, tooltips right (existing siderTooltipProps pattern).

The control is a status mirror + launcher: it renders the shared status and opens UpdateModal (via the existing aionui-open-update-modal window event) for every action decision.
It never re-implements download/install logic — backend and modal semantics are untouched. Status comes from a new useUpdateStatus hook that lifts the modal’s existing machine
(UpdateModal.tsx:17) into a shared context; the founder’s six states map losslessly: checking→checking, available→available, downloading→downloading,
ready→downloaded(+installing), current→upToDate(+success), error→error.

┌─────────────┬────────────────────────────────────────────────────────────────────────────────┬─────────────────────────────────────────────┬─────────────────────────────┐
│    State    │                         Rest (icon 28px, ≥28px target)                         │        Expanded label (hover/focus)         │            Click            │
├─────────────┼────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────┼─────────────────────────────┤
│ current     │ quiet ghost Refresh icon, --text-secondary                                     │ „Nach Updates suchen“ / “Check for updates” │ opens modal → re-check      │
├─────────────┼────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────┼─────────────────────────────┤
│ checking    │ ghost icon with indeterminate ring, aria-busy                                  │ „Suche nach Updates…“                       │ opens modal (no re-trigger) │
├─────────────┼────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────┼─────────────────────────────┤
│ available   │ filled circle, --primary, Download icon (the reference screenshots’ blue pill) │ „Aktualisieren“ / “Update”                  │ opens modal → download      │
├─────────────┼────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────┼─────────────────────────────┤
│ downloading │ --primary progress ring (percent)                                              │ „Lädt… {percent}%“ (tabular-nums)           │ opens modal                 │
├─────────────┼────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────┼─────────────────────────────┤
│ ready       │ filled --primary, Install icon                                                 │ „Neu starten & installieren“                │ opens modal → install       │
├─────────────┼────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────┼─────────────────────────────┤
│ error       │ ghost with --danger icon                                                       │ „Update fehlgeschlagen“                     │ opens modal → retry         │
└─────────────┴────────────────────────────────────────────────────────────────────────────────┴─────────────────────────────────────────────┴─────────────────────────────┘

Interaction: expansion animates width+label opacity 160ms ease (matches sider transitions); instant under prefers-reduced-motion. Keyboard: real <button> (Arco Button),
:focus-visible expands + primary focus ring; full state text always in aria-label (hover-only labels are never the accessibility path). Touch/no-hover: no hover expansion — the
control renders persistently expanded whenever status ≠ current and icon-only otherwise; tap always opens the modal. State changes announce once via a polite live region (reuses
the v2 §7 announcement rail, debounced). available→ the label persists expanded for 5s once per session (discoverability fix for the “popup-only” problem) then rests to icon.
Avatar identity colors come from the existing identity palette — identity color ≠ CI color, so a purple avatar is acceptable (v2 decision 9 governs chrome, not identity).

6. Migration — Legacy Presets, User Themes, Custom CSS

Startup migration (new migrateLegacyTheme.ts, runs once before first applyTheme):

- theme.activeId ∈ decorative builtin IDs (retro-windows, retroma-obsidian-book, discourse-horizon, glittering-input-field), any theme.userThemes entry, or any extension theme →
remap to LIGHT_THEME_ID/DARK_THEME_ID by the legacy theme’s appearance field; persist the original under appearance.legacy.previousActiveId; show a one-time i18n notice (“Dein
Theme wurde auf das neue Command-EVE-Design umgestellt”).
- theme.userThemes config is preserved byte-for-byte (backwards-safe, reversible) — it is simply no longer rendered as public gallery cards and never auto-applied.
- builtinThemes.ts prunes the four decorative presets from public builds; the unused presets/*.css (incl. hello-kitty, misaka-mikoto, retroma-* variants never registered) and
themeCovers.ts covers are retired from the public bundle.
- Extension-provided CSS themes (merged in CssThemeSettings.tsx:262–269) are the same escape hatch and are gated identically.
- Font sizes and zoom persist unchanged (same config keys).

Custom CSS decision (recommendation): founder/developer-only in 1.8.0 — the “Erweitert” section renders only when a developer flag is set (not reachable from public UI; the
existing hidden devtools gesture tier is the model). Rationale: a warned-but-public section still reintroduces the old UI in screenshots, support cases, and demos, which decision
2 forbids; customCssProcessor.ts’s auto-!important pipeline is kept intact for that gated path and for future re-evaluation as a warned advanced feature in 1.8.1+. Saved CSS is
never deleted or mutated.

7. Implementation Slice Changes & Release-Blocking Gates

Slice deltas (lettering preserved):

- 1.8.0-b adds: §5.9 user-control tokens; glass tiers refactored to designed-value × user-factor expressions (factor default 1 → zero visual delta); accent-override token wiring.
- 1.8.0-c adds: sidebar footer rebuild (account row + update control + useUpdateStatus). The footer ships with the shell because it is shell chrome.
- 1.8.0-d: unchanged (composer/spotlight/suggestions/privacy pill).
- 1.8.0-e re-scoped to “Meta-theme everywhere”: Appearance rebuild (§4), legacy migration (§6), decorative/custom gating, background-image mode (v2 §12), settings/artifacts panel
pass, and the global route sweep (§3 targeted passes).
- 1.8.0-f adds the expanded gates below.

Release-blocking visual-regression gates (additive to v2 §9/§10/§15):

1. Full-route matrix: every route in §3 screenshotted light + dark at 1440×1024 (narrow set for guid/chat/settings index); loading, empty, and error fallback states included. No
page may show the legacy AionUI language (white-card gallery, purple --aou-* washes, unthemed Arco defaults).
2. Migration truth: automated test — each legacy activeId (4 decorative + 1 user CSS + 1 extension theme fixture) launches into the correct new default with config preserved; no
theme-decoration style element present in public default mode.
3. Appearance floors: screenshots at slider extremes (Transparenz 100%, Blur 100%, Intensität 20%, max dim) still pass the v2 §9 contrast gates; automated check that user factors
cannot exceed designed ceilings.
4. Update footer: 6 states × light/dark × expanded/collapsed sidebar screenshot set; e2e for keyboard expansion, touch persistent-expansion, modal launch per state; no
update-backend IPC calls added or reordered (diff-scoped assertion).
5. Custom-CSS gate: public build shows no “Manuell hinzufügen”/custom entry anywhere; gated build still round-trips saved CSS.
6. No-literal lint gate (§3 enforcement) passes.

Likely Codex Follow-up Gaps

1. useUpdateStatus extraction risk: UpdateModal owns a dual-path (electron-updater + manual GitHub/R2) machine with deliberate tolerances (UpdateModal.tsx:80–129); lifting status
into context must not change check timing or duplicate checks (footer must observe, and trigger at most the same background check cadence — verify whether any background check
currently exists at all, or the footer’s initial state is simply current until the user acts).
2. Signed-in identity source: confirm the canonical display-name/avatar source (AccountSettings vs ProfileAvatar vs seat identity) and the fallback when signed out — the footer
needs a defined logged-out variant (likely app name + settings affordance only).
3. system mode is net-new: Theme.appearance is 'light' | 'dark' today; adding appearance.mode='system' touches resolveTheme.ts, cross-window broadcast
(ipcBridge.theme.setActive), and the in-settings theme toggle in SiderFooter — check for circular config writes.
4. Accent-override completeness: overriding --primary must also cover Arco ramp aliases (--color-primary-1..6, --primary-6 rgb-triplet usages like rgba(var(--primary-6),0.08) in
ConversationRow.tsx:220) — audit both var() syntaxes before shipping accent swatches.
5. Glass factor refactor: converting shipped --glass-* literals into factor expressions risks subtle rendering diffs (color-mix nesting limits); needs the screenshot-diff-zero
gate from 1.8.0-b applied again.
6. Zoom bounds truth: the Skalierung control’s actual min/max/step and persistence key need verification before the §4 ranges are finalized.
7. Decorative preset removal vs. sprint record: update command-eve-180-design-sprint-2026-07-09.md acceptance text (it still promises decorative regression shots) so the
plan-of-record and this addendum don’t diverge.
8. Extension theme contract: removing extension themes from the gallery may break an extension-store expectation — confirm no shipped extension currently depends on theme
injection for core function.
9. One-time migration notice: needs UX + i18n review and an idempotency key so reinstalls/seat switches don’t re-show it.
10. Footer density: avatar+name+update in a 260px sider next to logout/theme rows risks crowding at German label lengths and max font step — include in the zoom/locale screenshot
set early, not only in 1.8.0-f.
