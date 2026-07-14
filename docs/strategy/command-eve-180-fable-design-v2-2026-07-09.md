# Fable 5 High Design Review - Command EVE 1.8.0

Date: 2026-07-09
Mode: read-only plan review via Claude Max
Completion sentinel: `REVIEW_COMPLETE`

This is the normalized Fable worker output. It is review evidence, not the
canonical decision. Codex adjudication lives in
`docs/strategy/command-eve-180-design.md`.

---

## Worker Draft

Command EVE 1.8.0 Visual Design Contract

Status: v2 — implementation-grade contract after locked founder direction
Supersedes: previous command-eve-180-design.md draft
Source sprint: docs/strategy/command-eve-180-design-sprint-2026-07-09.md
Locked references: refined dark + refined light generated directions, founder sidebar detail screenshot (2026-07-09)
Scope lock: visual-only. No runtime, inference, billing, Hermes/Honcho, or worker-lane changes.

---

1. Product Intent

Command EVE 1.8.0 makes the existing operator surface feel calm, premium, and alive without touching the agent/runtime contract. The locked direction (both light and dark) is:

- A neutral glass shell (chrome / panel / overlay tiers — already tokenized in packages/desktop/src/renderer/styles/themes/default-color-scheme.css) with the orange Command glyph
  as the single brand anchor.
- One consistent identity + status language in the sidebar: every conversation and project-chat row leads with the Command glyph; a single small status badge appears only when
  there is something to say.
- A composer that reads as the primary work surface: quiet at rest, with a localized warm (brand-orange) border spotlight that follows the pointer.
- Seats as refined glass monograms, not saturated color circles.
- Blue reserved for interaction (primary actions, selection accent, activity); orange reserved for brand; red/yellow/green reserved for semantic status. No purple CI anywhere in
  new EVE visuals.

The result must stay practical for daily operator work. Glass is a system primitive; effects never compete with text.

2. Non-Goals

- No Hermes/Honcho orchestration, model/provider routing, billing/credit, or autonomy changes.
- No exposure of internal CLIs, worker lanes, or founder-only surfaces to end users.
- No component-library replacement — Arco Design + IconPark stay.
- No new visual framework; CSS variables + UnoCSS utilities + CSS Modules only.
- No cloud upload of background images; local-first stays absolute.
- No card-inside-card UI; no glass on individual message bubbles or large scrolling regions.
- No redesign of decorative/user CSS themes (their !important pipeline intentionally wins); regression screenshots only.
- No refactor of AcpSendBox.tsx behavior, UnifiedSendBar.tsx slot contract, or seat-switch logic in SeatRail.tsx for visual reasons.
- No release before the visual QA matrix, accessibility gates, and Fable/Codex post-review pass.

3. Locked Founder Decisions (normative)

1. Both refined light and dark directions are approved; no new direction may be invented.
1. Top-left brand mark = orange Command glyph alone. Never inside a black rounded-square tile.
1. Conversation and project-chat rows use the Command glyph, not a chat bubble.
1. Row status badge only when meaningful: red = error/blocked, yellow = human action required, green = completed, blue = active/running or new result. No badge = idle.
1. Selected row is reduced and modern: faint glass wash + restrained accent hairline + stronger text/icon contrast. No heavy full-row slab, no card look.
1. Composer keeps the pointer-reactive orange border spotlight: neutral idle, localized warm hotspot near the pointer, keyboard focus ring, static fallbacks for touch/reduced
   motion.
1. Seats = refined glass monograms. Active: neutral ring + online dot. Inactive: tiny identity-color rim indicator. Never fully saturated circles.
1. Paperclip stays on the same baseline as all other composer controls.
1. No purple CI. Orange brand, blue interaction accents, semantic red/yellow/green, neutral light/dark glass.
1. Background images remain local-first and must preserve readability.

1. Mockup-vs-Repo Adaptation Flags

The generated images are a selected direction, not implementation truth. Where the repo or a locked decision contradicts them, the repo/decision wins:

┌─────┬─────────────────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ # │ Mockup shows │ Adaptation │
├─────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ A1 │ Dark mode places the orange glyph in a │ Decision 2 overrides: glyph alone, transparent background. │
│ │ black rounded tile │ │
├─────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ │ Brand glyph at the absolute top-left │ On macOS the traffic lights occupy that corner (Titlebar/index.tsx:245 offsets menus by 76px). The glyph anchors the top of │
│ A2 │ corner │ the seat rail when the rail is visible, and the sidebar header (layout-sider-header, currently empty) when it is not. It │
│ │ │ never fights the traffic lights. │
├─────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ │ Sidebar rows lead with chat-bubble │ Repo already renders the ⌘ avatar (ConversationRow.tsx COMMAND_EVE_ASSISTANT_AVATAR fallback chain). Decision 3 confirms │
│ A3 │ icons │ glyph; the MessageOne bubble fallback is retired for EVE lanes (it already is) and remains only for non-EVE third-party │
│ │ │ agents with no logo. │
├─────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ │ Selected row as a full-width slab with │ │
│ A4 │ blue left bar and blue title (founder │ Decision 5 reduces this: faint wash, hairline, stronger contrast — spec in §6.4. │
│ │ detail screenshot) │ │
├─────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ A5 │ Seat circles partially read as │ Decision 7 overrides the current repo (seatRail.css saturated --seat-color fills) too: both move to glass monograms. │
│ │ saturated fills │ Identity color survives only as a tiny rim indicator; the deterministic seatColor() hash stays. │
├─────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ A6 │ Send button is a saturated blue circle │ Adopted — but note the current dark-mode send button uses --aou-4 (purple ramp) in sendbox.css:19. It migrates to --primary │
│ │ │ (decision 9: no purple CI). │
├─────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ │ Composer right-cluster icon order │ The UnifiedSendBar slot order (model · permission · context · mic · send) is the shipped contract and stays. Icons are │
│ A7 │ (folder · gauge · shield · ring · mic · │ restyled, not reordered. │
│ │ send) │ │
├─────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ A8 │ Background photo behind the whole app │ Background image mode is opt-in and local-first (§12), never a default. │
├─────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ A9 │ Hardcoded German strings │ All user-facing text via i18n keys (i18n skill; modules in packages/desktop/src/common/config/i18n-config.json). │
├─────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ A10 │ Seat rail visible with five seats + “+” │ The rail is admin-only and fail-closed (SeatRail.tsx security note). The design must not assume it is present; brand-mark │
│ │ │ placement has a rail-less variant (A2). │
├─────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ A11 │ Mockup pin/section chrome │ Matches existing GroupedHistory sections; naming/IA changes are out of 1.8.0 scope. │
│ │ (“ANGEHEFTET”, “TEAMS”, “ORDNER”) │ │
├─────┼─────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ │ │ Current repo overlays an Arco Spin (ConversationRow.tsx:242). 1.8.0 replaces the Spin with the blue running badge (pulsing; │
│ A12 │ Running state as a plain dot │ static under reduced motion) so the row carries exactly one status system. Busy-obviousness is re-verified in the QA │
│ │ │ matrix. │
└─────┴─────────────────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

5. Token Taxonomy

All new tokens live in a new file packages/desktop/src/renderer/styles/themes/command-eve-visual.css, imported after default-color-scheme.css (no-conflict rule, §14.7). Existing
--glass-\* tokens stay canonical and are not renamed. No component may hardcode a color; everything routes through the tokens below or existing semantic tokens
(docs/theming/tokens.md).

5.1 Shell & glass (existing, unchanged)

Already shipped in default-color-scheme.css: --glass-chrome-bg/-solid/-border/-filter/-trail, --glass-panel-_, --glass-overlay-_, --glass-overlay-scrim, --glass-edge-highlight,
--glass-shadow-soft, each with light and dark blocks, @supports opaque fallback and prefers-reduced-transparency fallback (layout.css:51–63, chat-layout.css:32–49). 1.8.0-b
consolidates remaining ad-hoc glass onto these; it does not fork them.

5.2 Brand (new)

The Command orange must be sampled from the shipped command-eve-logo.svg asset (single source of truth — packages/desktop/src/common/config/commandEveShell.ts:70). Proposed
values pending that sampling:

┌────────────────────┬───────────────────────────────────────────────────────┬──────────────┬─────────────────────────────────────────────┐
│ Token │ Light │ Dark │ Use │
├────────────────────┼───────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────┤
│ --eve-brand │ #e8590c │ #ff7a45 │ Glyph tint, spotlight color, brand accents │
├────────────────────┼───────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────┤
│ --eve-brand-strong │ #d9480f │ #ff8f66 │ Hover/pressed brand accents │
├────────────────────┼───────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────┤
│ --eve-brand-soft │ color-mix(in srgb, var(--eve-brand) 12%, transparent) │ same formula │ Faint brand washes (never behind body text) │
└────────────────────┴───────────────────────────────────────────────────────┴──────────────┴─────────────────────────────────────────────┘

Rules: --eve-brand is never used for status, never as text under 3:1, never as the selection accent (that is --primary). The legacy --aou-\* purple ramp remains for compatibility
but is forbidden in new EVE visuals; 1.8.0-c/d migrate the visible offenders (dark send button, stop-button breathe using --aou-2/4/5 in sendbox.css).

5.3 Status (new; mapped to existing semantics)

┌────────────────────────┬─────────────────────┬─────────────┬────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Token │ Light │ Dark │ Meaning │
├────────────────────────┼─────────────────────┼─────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ --eve-status-error │ var(--danger) │ #f76560 │ error / blocked │
│ │ #f53f3f │ │ │
├────────────────────────┼─────────────────────┼─────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ --eve-status-attention │ #ca8a04 │ #eab308 │ human action required (true yellow — deliberately not --warning orange, which would collide with brand orange │
│ │ │ │ at 8px) │
├────────────────────────┼─────────────────────┼─────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ --eve-status-completed │ var(--success) │ #23c343 │ completed │
│ │ #00b42a │ │ │
├────────────────────────┼─────────────────────┼─────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ --eve-status-activity │ var(--primary) │ #4d9fff │ running / new result │
│ │ #165dff │ │ │
├────────────────────────┼─────────────────────┼─────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ --eve-status-ring │ var(--bg-1) │ var(--bg-1) │ 2px halo separating the dot from the glyph (replaces the hardcoded var(--color-bg-2) in │
│ │ │ │ SessionStatusDot.tsx:55 so it tracks the actual row surface) │
└────────────────────────┴─────────────────────┴─────────────┴────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

5.4 Row selection (new)

┌─────────────────────────────┬─────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────┐
│ Token │ Light │ Dark │
├─────────────────────────────┼─────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
│ --eve-row-selected-bg │ color-mix(in srgb, var(--text-primary) 5%, transparent) │ color-mix(in srgb, var(--text-primary) 8%, transparent) │
├─────────────────────────────┼─────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
│ --eve-row-selected-hairline │ var(--primary) │ var(--primary) │
├─────────────────────────────┼─────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
│ --eve-row-hover-bg │ var(--bg-hover) │ var(--bg-hover) │
└─────────────────────────────┴─────────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────┘

5.5 Composer spotlight (new)

┌───────────────────────────────────────┬─────────────────────────────┬─────────────────────────────────────────────────────────┐
│ Token │ Light │ Dark │
├───────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────────────────┤
│ --eve-spotlight-color │ var(--eve-brand) │ var(--eve-brand) │
├───────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────────────────┤
│ --eve-spotlight-radius │ 220px │ 220px │
├───────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────────────────┤
│ --eve-spotlight-max │ 0.5 │ 0.68 │
├───────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────────────────┤
│ --eve-composer-border │ var(--border-base) │ color-mix(in srgb, var(--border-base) 80%, transparent) │
├───────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────────────────┤
│ --eve-composer-focus-ring │ var(--primary) │ var(--primary) │
├───────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────────────────┤
│ --eve-spotlight-x / --eve-spotlight-y │ runtime-written per element │ — │
└───────────────────────────────────────┴─────────────────────────────┴─────────────────────────────────────────────────────────┘

5.6 Seat states (new)

┌────────────────────────┬──────────────────────────────────────────────────────────┬──────────────────────────────────────────────────────────┐
│ Token │ Light │ Dark │
├────────────────────────┼──────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ --eve-seat-bg │ color-mix(in srgb, var(--text-primary) 5%, transparent) │ color-mix(in srgb, var(--text-primary) 8%, transparent) │
├────────────────────────┼──────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ --eve-seat-border │ color-mix(in srgb, var(--text-primary) 14%, transparent) │ color-mix(in srgb, var(--text-primary) 18%, transparent) │
├────────────────────────┼──────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ --eve-seat-text │ var(--text-primary) │ var(--text-primary) │
├────────────────────────┼──────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ --eve-seat-ring-active │ color-mix(in srgb, var(--text-primary) 55%, transparent) │ color-mix(in srgb, var(--text-primary) 65%, transparent) │
├────────────────────────┼──────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ --eve-seat-online │ var(--success) │ var(--success) │
└────────────────────────┴──────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘

Identity color stays the deterministic seatColor(seat_id) (FNV-1a, SeatRail.tsx:50), injected per-seat as --seat-color, now consumed only by the 6px rim indicator.

5.7 Scrim & background image (new; extends §12)

┌─────────────────────────┬─────────────────────────────────────────────────────┬─────────────────────────────────────────────────────┐
│ Token │ Light │ Dark │
├─────────────────────────┼─────────────────────────────────────────────────────┼─────────────────────────────────────────────────────┤
│ --eve-bgimg-scrim │ color-mix(in srgb, var(--bg-base) 62%, transparent) │ color-mix(in srgb, var(--bg-base) 68%, transparent) │
├─────────────────────────┼─────────────────────────────────────────────────────┼─────────────────────────────────────────────────────┤
│ --eve-bgimg-scrim-floor │ 0.55 (min effective opacity; not user-underridable) │ 0.6 │
└─────────────────────────┴─────────────────────────────────────────────────────┴─────────────────────────────────────────────────────┘

When background-image mode is active (html[data-eve-bg-image='true']), the glass tiers raise their fill by ~10% via override block in the same token file — no component changes.

5.8 Shadow & border

No new shadow tokens: reuse --glass-shadow-soft and --glass-edge-highlight. New surfaces must not invent box-shadow literals except focus rings (--eve-composer-focus-ring /
--color-primary-6 outlines) and the status-dot halo.

6. Component Anatomy & Interaction States

6.1 Top-left brand mark

- Asset: command-eve-logo.svg (existing), rendered at 22–24px, no container tile, no border, no shadow (decision 2 / flag A1).
- Placement: top slot of the seat rail (SeatRail.tsx, above .seat-rail\_\_toggle) for admins; for non-admin installs (rail hidden), the sidebar header layout-sider-header
  (Layout.tsx:329) renders it left-aligned. The existing hidden devtools click-gesture on that header is preserved (the glyph becomes its visible target).
- States: static; no hover effect (it is not a control). aria-hidden='true' + empty alt — the app name is already announced by the window title. If it doubles as the devtools
  gesture target it stays a non-focusable decorative element (the gesture is a hidden affordance, not a documented control).
- Collapsed sidebar: glyph remains visible in the rail (admins) or hides with the sider (non-admins) — never floats over content.

  6.2 Seat rail (SeatRail.tsx, styles/seatRail.css)

Anatomy per seat (expanded, 44px visual / 48px target): glass disc (--eve-seat-bg fill, 1px --eve-seat-border), monogram initials in --eve-seat-text at 600 weight, plus at most
two attachments:

- Active seat: 1.5px neutral ring (--eve-seat-ring-active) offset 2px outside the disc + 8px online dot (--eve-seat-online) bottom-right with --eve-status-ring halo.
- Inactive seat: 6px identity rim dot in var(--seat-color) at the 4–5 o’clock position (with halo). No ring, no fill color.

States:

┌────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ State │ Treatment │
├────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ rest │ glass disc, monogram │
├────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ hover │ disc fill +3% mix, transform: scale(1.05) (none under reduced motion — existing block seatRail.css:187 extends) │
├────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ active/pressed │ scale 0.97 │
├────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ focus-visible │ existing triple-ring pattern retained, outermost ring --color-primary-6 (keeps WCAG 2.4.7 distinctness; seatRail.css:136) │
├────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ switching │ existing freeze behavior unchanged (--switching opacity 0.45) │
├────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ collapsed rail │ 14px glass dot with the identity rim as a 2px arc; active keeps neutral ring; targets stay ≥28px (existing) │
└────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

The luminance-picked contrastText() becomes unnecessary for fills (monogram is --eve-seat-text on neutral glass) but the function stays exported for the identity rim tooltip
swatches and future use. Tooltips (name, right side, hover+focus) unchanged. The “+” add-seat dashed circle keeps its current spec.

6.3 Sidebar sections (GroupedHistory/index.tsx, layout.css)

- Section labels (.sider-section-title, sticky .sider-section-label): unchanged typography; sticky background moves from --bg-2 to --glass-chrome-bg-solid so it matches the
  frosted sider in both modes; keep the dark-mode #9098a1 mid-gray override — migrate that literal into a token --eve-section-title-dark in the new token file.
- Section headers gain no glass of their own (they sit inside the chrome tier already).
- Collapse/expand chevrons, add-buttons: existing .sider-action-btn tokens unchanged.

  6.4 Chat / project rows and the selected row (ConversationRow.tsx)

Anatomy: [⌘ glyph 16px + status badge slot] [title, ellipsis] [timestamp] [hover: ⋯ menu] at 34px height, radius 8px — all existing. Changes:

- Leading icon: the ⌘ glyph (or preset-assistant/agent logo) always; idle rows keep the muted grayscale opacity-55 treatment; selected and any badged state render full strength
  (extend the existing idleMuted condition: mute only when status === 'idle' && !selected).
- Status badge: single 8px dot overlaid bottom-right of the glyph (existing SessionStatusDot overlay pattern), colors per §7. The Arco Spin running overlay is removed (flag A12).
- Hover: --eve-row-hover-bg; no elevation, no border.
- Selected row (decision 5): background --eve-row-selected-bg (faint wash — on the glass sider this reads as a light glass tint without any backdrop-filter of its own); a 2px
  inset hairline on the left edge box-shadow: inset 2px 0 0 var(--eve-row-selected-hairline) inside the 8px radius; title stays --text-primary (not accent-colored — the founder
  screenshot’s blue title is replaced by stronger neutral contrast); glyph full strength. No card border, no shadow, no full-saturation slab. The current '!bg-fill-3' selected
  class is replaced by conversation-item--selected in a new GroupedHistory/conversation-row.css.
- Batch mode / checked and drag states unchanged.

  6.5 Status indicator

See §7 for the full machine. Rendering contract: SessionStatusDot gains role='img', keeps aria-label + Arco tooltip (hover and focus via the focusable row, not hover-only),
data-status for tests, and reads colors from --eve-status-\*.

6.6 Composer (GuidInputCard.tsx, AcpSendBox.tsx visual hooks, SendBox/sendbox.css, UnifiedSendBar.tsx)

Anatomy (unchanged structure): panel (.sendbox-panel, radius 16px) containing textarea + UnifiedSendBar slot row. Visual spec:

- Surface: --glass-panel-bg + --glass-panel-filter (one persistent blur surface; see §10 budget), border --eve-composer-border, shadow --glass-shadow-soft.
- Pointer spotlight per §8 — the only brand-orange element on the screen besides the glyph.
- Slot row: all controls share one baseline row (items-center inside the existing items-end bar); the paperclip (leftSlot) uses the same 32px control height as
  mic/model/permission/context/send (decision 8). No slot reordering (flag A7).
- Send button: circular 32px, --primary fill, white icon; disabled = --bg-4 fill with --text-disabled icon (replaces the hardcoded #d3d4d9 and dark-mode --aou-4 in
  sendbox.css:4–29). Stop button keeps the breathe animation but re-based on --primary mixes instead of --aou-\*.
- Focus: :focus-visible on the panel’s textarea shows a 2px --eve-composer-focus-ring ring, offset 1px, spotlight suppressed while visible (§8.4).

  6.7 Privacy pill (EgressRedactionTogglePill.tsx, titlebar toolbar slot)

- Overlay-tier pill: --glass-overlay-bg fill (falls back solid), 1px --glass-overlay-border, radius 999px, shield IconPark glyph + label (i18n), 28px min height.
- States: rest (secondary text), hover (primary text, fill +4%), focus-visible (primary ring), toggled-local vs toggled-redacted communicated by label text + glyph variant —
  never color alone.
- Alignment: vertically centered in the titlebar toolbar next to CreditMeterBadge/ProfileAvatar; calm — no pulsing, no brand orange.

  6.8 Suggestions (start screen; GuidActionRow.tsx, QuickActionButtons.tsx)

- Rows: full-width quiet buttons (Arco Button, custom class): transparent rest with 1px --border-light bottom hairline OR contained in a single panel-tier group — pick the single
  group panel (matches mockups: one bordered container, three rows, chevron-right affordance). Inside the group: no per-row cards (no card-in-card).
- States: hover --eve-row-hover-bg; focus-visible primary ring; pressed --bg-active. Icons: IconPark outline, --text-secondary.
- The bottom “Websuche …” status chip is overlay-tier pill styling like §6.7.

  6.9 Artifacts (Messages/MessageGeneratedArtifact.tsx, Messages/artifacts.tsx, media/WebviewHost.tsx)

- One consistent panel-tier preview frame: --glass-panel-bg-solid (artifacts sit in the scrolling message list — no backdrop-filter, §10), 1px --glass-panel-border, radius 12px,
  header row (type icon + filename + open/download actions), content region with overflow:auto.
- Inspection-first: no decorative frames, no glass over media, actions are real buttons with labels/tooltips.

  6.10 Settings & privacy pages (pages/settings/\*)

- Group containers: panel tier (solid variant inside scrollable pages), consistent 12px radius, group headers share the sidebar section-title treatment (§6.3).
- No nested panels: a group is one level; controls sit directly inside.
- The settings sider active item adopts the same selected-row spec (§6.4) for cross-surface consistency.

  6.11 Overlays (search popover, dropdowns, modals, command menus)

- Overlay tier: --glass-overlay-bg + --glass-overlay-filter + --glass-overlay-border + --glass-shadow-soft, over --glass-overlay-scrim where modal.
- Focus ring always visible; first focusable element receives focus; prefers-reduced-transparency → --glass-overlay-bg-solid.
- ConversationSearchPopover ports its ad-hoc styles onto these tokens in 1.8.0-b (consolidation, zero visual delta intent).

7. Status State Machine

Inputs (all existing): isGenerating, hasCompletionUnread, isWaitingInput, hasError, cronStatus ∈ {none, active, paused, error, unread} (sessionStatus.ts:38–51).

States and mapping (changes the current done mapping — flag A12 + green/blue split):

┌─────────────────────────────┬────────────────────────────────────────────────┬────────────────────────┬────────────────────────────────────────────────────────────────────┐
│ State │ Badge │ Token │ Derivation │
├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ running │ blue dot, gentle 1.2s opacity pulse (static │ --eve-status-activity │ isGenerating │
│ │ under reduced motion) │ │ │
├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ error (error/blocked) │ red dot │ --eve-status-error │ hasError || cronStatus === 'error' │
├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ attention (human action │ yellow dot │ --eve-status-attention │ isWaitingInput || cronStatus === 'paused' │
│ required) │ │ │ │
├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ completed │ green dot │ --eve-status-completed │ cronStatus === 'unread' (a scheduled/delegated run finished │
│ │ │ │ successfully, unacknowledged) │
├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ newResult │ blue dot, static │ --eve-status-activity │ hasCompletionUnread (a chat turn produced output not yet seen) │
├─────────────────────────────┼────────────────────────────────────────────────┼────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ idle │ none │ — │ otherwise │
└─────────────────────────────┴────────────────────────────────────────────────┴────────────────────────┴────────────────────────────────────────────────────────────────────┘

Precedence (first match wins): running → error → attention → completed → newResult → idle. Rationale: live activity is the current truth; a resting error is the loudest resting
state; completion of a task outranks an unread chat reply.

selected is orthogonal — a row visual (§6.4), never a badge. A selected row still shows its badge until the clearing event fires.

Clearing rules:

┌───────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ State │ Clears when │
├───────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ running │ the turn ends (transitions into error, newResult, or idle) │
├───────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ error │ the conversation is opened (user is informed) or the next turn starts; cron error clears on job acknowledge/edit per existing job store │
├───────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ attention │ the pending question/permission is answered, or the paused job is resumed/acknowledged │
├───────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ completed │ the conversation is opened, or the job execution is marked read (existing cron-unread path) │
├───────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ newResult │ the conversation is opened (row becomes selected with the chat visible) │
└───────────┴─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

Staleness: chat-derived flags (hasError, hasCompletionUnread, isWaitingInput) are session-scoped and reset on app restart; cron statuses persist via the job store. No TTL decay
in 1.8.0 — clearing is event-driven only (persistence upgrade listed in §17).

Accessible names (i18n keys under the existing conversation.status.\* namespace; done is renamed, one new key):

┌───────────┬───────────────────────────────┬───────────────────────────┬────────────────────────────┐
│ State │ Key │ de-DE │ en-US │
├───────────┼───────────────────────────────┼───────────────────────────┼────────────────────────────┤
│ running │ conversation.status.running │ Antwort läuft │ Response running │
├───────────┼───────────────────────────────┼───────────────────────────┼────────────────────────────┤
│ error │ conversation.status.error │ Fehler — Eingriff nötig │ Error — needs intervention │
├───────────┼───────────────────────────────┼───────────────────────────┼────────────────────────────┤
│ attention │ conversation.status.attention │ Deine Aktion erforderlich │ Your action required │
├───────────┼───────────────────────────────┼───────────────────────────┼────────────────────────────┤
│ completed │ conversation.status.completed │ Aufgabe abgeschlossen │ Task completed │
├───────────┼───────────────────────────────┼───────────────────────────┼────────────────────────────┤
│ newResult │ conversation.status.newResult │ Neues Ergebnis │ New result │
└───────────┴───────────────────────────────┴───────────────────────────┴────────────────────────────┘

Announcement contract: the dot has role='img' + aria-label; the tooltip mirrors the label. A single visually-hidden aria-live='polite' region in GroupedHistory/index.tsx
announces only transitions into error and attention for non-selected conversations (debounced 2s, one message per transition: “{title}: {statusLabel}”) —
running/newResult/completed transitions are not announced (noise). The seat rail keeps its existing role='alert' switch-failure region.

8. Pointer Spotlight Contract (composer)

Net-new (no implementation exists in the renderer today).

8.1 CSS-variable contract

The tracking element (the composer panel) owns four custom properties, written only by the hook in §8.2: --eve-spotlight-x, --eve-spotlight-y (px, element-relative),
--eve-spotlight-o (0 → --eve-spotlight-max), and reads static tokens --eve-spotlight-color, --eve-spotlight-radius (§5.5).

/_ command-eve-composer.css (new file, component-scoped) _/
.eve-composer {
position: relative;
border: 1px solid var(--eve-composer-border);
border-radius: 16px;
}

/_ Border-only warm hotspot: a masked gradient ring, never a surface glow. _/
.eve-composer::before {
content: '';
position: absolute;
inset: -1px;
border-radius: inherit;
padding: 1.5px; /_ ring thickness _/
background: radial-gradient(
var(--eve-spotlight-radius) circle at var(--eve-spotlight-x, 50%) var(--eve-spotlight-y, 0%),
var(--eve-spotlight-color),
transparent 70%
);
-webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
-webkit-mask-composite: xor;
mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
mask-composite: exclude;
opacity: var(--eve-spotlight-o, 0);
transition: opacity 240ms ease-out;
pointer-events: none;
}

/_ Keyboard focus: honest ring, spotlight suppressed. _/
.eve-composer:has(:focus-visible) {
outline: 2px solid var(--eve-composer-focus-ring);
outline-offset: 1px;
}
.eve-composer:has(:focus-visible)::before {
opacity: 0;
}

/_ Touch / no-hover: static warm hairline instead of tracking. _/
@media (hover: none), (pointer: coarse) {
.eve-composer {
border-color: color-mix(in srgb, var(--eve-spotlight-color) 30%, var(--eve-composer-border));
}
.eve-composer::before {
display: none;
}
}

@media (prefers-reduced-motion: reduce) {
.eve-composer::before {
transition: none;
}
}

8.2 Tracking hook (TypeScript pseudocode)

// renderer/hooks/ui/useComposerSpotlight.ts (new)
export function useComposerSpotlight(ref: React.RefObject<HTMLElement>) {
useEffect(() => {
const el = ref.current;
if (!el) return;
const noHover = window.matchMedia('(hover: none), (pointer: coarse)').matches;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (noHover) return; // CSS static fallback owns this case

    let rect: DOMRect | null = null;
    let raf = 0;
    let px = 0, py = 0;

    const write = () => {
      raf = 0;
      el.style.setProperty('--eve-spotlight-x', `${px}px`);
      el.style.setProperty('--eve-spotlight-y', `${py}px`);
    };
    const onEnter = () => {
      rect = el.getBoundingClientRect(); // cached: no layout reads per move
      el.style.setProperty('--eve-spotlight-o', 'var(--eve-spotlight-max)');
    };
    const onMove = (e: PointerEvent) => {
      if (!rect) rect = el.getBoundingClientRect();
      px = e.clientX - rect.left;
      py = e.clientY - rect.top;
      if (reducedMotion) {
        // No tracking under reduced motion: pin a static hotspot top-center once.
        el.style.setProperty('--eve-spotlight-x', '50%');
        el.style.setProperty('--eve-spotlight-y', '0%');
        return;
      }
      if (!raf) raf = requestAnimationFrame(write); // coalesce to one write/frame
    };
    const onLeave = () => {
      el.style.setProperty('--eve-spotlight-o', '0'); // CSS 240ms fade-out
      rect = null;
    };
    const onResize = () => { rect = null; };

    el.addEventListener('pointerenter', onEnter);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', onResize);
    return () => { /* symmetric cleanup + cancelAnimationFrame(raf) */ };

}, [ref]);
}

8.3 Behavior numbers

- Hotspot radius: 220px (token). Ring thickness 1.5px. Gradient fades to transparent at 70% of the radius, so the warm zone spans roughly ±150px of border around the pointer.
- Opacity: 0 idle → --eve-spotlight-max (0.5 light / 0.68 dark) on pointer-enter (240ms ease-out in; same fade-out on leave).
- Reduced motion: no per-frame tracking — a static top-center warm hairline segment at the same opacity, instant transitions.
- Touch / coarse pointer: no tracking, no pseudo-element — a uniform border tint at 30% brand mix (CSS-only, §8.1).
- Reduced transparency: independent axis — the spotlight is a border gradient, not translucency, so it stays; only the composer surface swaps --glass-panel-bg →
  --glass-panel-bg-solid under prefers-reduced-transparency (never proxied through reduced motion).
- Keyboard focus (:focus-visible within): spotlight opacity forced to 0; the 2px --primary ring is the single focus signal (blue = interaction, decision 9).

9. Accessibility Gates (release-blocking)

1. Contrast: body text ≥ 4.5:1, large text and meaningful UI strokes ≥ 3:1 on every tier in light, dark, and worst-case background-image mode (bright, busy, low-contrast images).
   Verified per-surface with sampled screenshots, not assumed from tokens.
1. Non-color encoding: every status has role='img' + aria-label + tooltip on hover and row focus; error/attention additionally announced via the polite live region (§7).
   Hover-only affordances are never the sole path — the row ⋯ menu stays reachable via context-menu and keyboard.
1. Keyboard: conversation rows must be focusable and activatable (currently div onClick — ConversationRow.tsx:210; 1.8.0-c adds role='button', tabIndex=0, Enter/Space handling).
   Focus order: rail → sider actions → sections/rows → content → composer. :focus-visible ring on every interactive element, distinct from resting/selected treatments (seat rail
   pattern already compliant).
1. Target sizes: ≥ 28px effective targets everywhere (existing seat-rail and mobile-row conventions extend to new pills/buttons). Status dots are non-interactive and exempt.
1. Screen-reader names: brand glyph decorative (aria-hidden); privacy pill announces state in its accessible name, not color; seat buttons keep name + aria-current; composer
   controls keep their existing labels through the slot contract.
1. Zoom/scaling: no clipping at 200% zoom and the app’s maximum font-size step, German locale included (chat-history\_\_section max-height guard pattern; verified in the matrix).
1. Status announcements: exactly the §7 contract — no unlabeled color changes, no announcement spam.
1. Reduced transparency ≠ reduced motion: separate media queries, both tested (layout.css:57 pattern is the reference; the mobile chat-header combined query in chat-layout.css:39
   is kept but the reduced-transparency arm must also exist standalone).

1. Performance Guardrails

- Backdrop-filter budget: at most 3 persistent filtered surfaces per window — sidebar chrome, chat header, composer. Overlays are transient extras. Rows, message bubbles,
  artifact frames, and anything inside a scroll container use solid/translucent fills only (no filter).
- Every filtered surface declares contain: paint (and isolation: isolate where stacking demands it) — already the shipped pattern.
- Spotlight: one pointermove listener on the composer, rAF-coalesced to ≤1 style write per frame, rect cached on enter/resize (zero layout reads per move), repaint confined to
  the masked pseudo-element. No React state updates per move.
- Animations restricted to opacity/transform; the status-dot pulse is opacity only.
- Long-chat gate: 500-message conversation scrolls without dropped frames (Electron DevTools performance trace) with glass on, spotlight active, and background-image mode enabled
  — release-blocking in 1.8.0-f.
- No layout shift when glass is toggled (solid fallbacks keep identical geometry).

11. Responsive, Collapsed & Truncation

- Sidebar 260px default, drag-snap collapse to 0 with hysteresis (Layout.tsx:82–90) — unchanged. Collapsed rows center the glyph; badges stay attached (bottom-right of glyph);
  tooltips carry the title + status.
- Seat rail expanded 72px / collapsed 40px; publishes --seat-rail-width for toast centering (layout.css:179) — unchanged; the redesign keeps identical widths so no layout math
  moves.
- Mobile (<768px): rail hidden (existing), sider is a fixed overlay with scrim; composer spotlight resolves to the touch fallback automatically (hover: none); privacy pill
  collapses to icon-only with accessible name intact.
- Long titles: single-line ellipsis + inline tooltip (existing chat-history\_\_item-name + Tooltip); timestamps hidden on mobile (existing); German/max-font verified in the matrix.
  Suggestion rows ellipsize at one line with full text as tooltip/accessible name.

12. Local Background-Image Safety & Readability Contract

- Mechanism: extend the existing Appearance path (AppearanceSettings/backgroundUtils.ts, CssThemeModal/CssThemeSettings) — no second background system. Image stored as an
  imported local asset/data-URL theme asset; raw original filesystem paths never appear in exported config or logs.
- When enabled, html[data-eve-bg-image='true'] activates: --eve-bgimg-scrim under the content column and sidebar, +10% glass fill raise across tiers, and the scrim floor
  (--eve-bgimg-scrim-floor) that user intensity/dim/blur controls cannot underride.
- User controls: enable, image, fit (cover|contain|fill), intensity, blur, dim, adaptive tint (sprint config shape). Missing/deleted asset → silent fallback to the default theme.
- Readability floor: §9.1 contrast gates measured on bright, dark, busy, and low-contrast reference images; focus rings visible on every tier over every reference image.
- The legacy backgroundUtils.ts transparency-punch-through selectors are migrated or fenced before the raised glass ships (sprint-accepted correction).
- No image leaves the device; no telemetry contains image data or paths.

13. Component / File Surface Map

┌──────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Surface │ Files (repo-grounded) │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Tokens (existing │ packages/desktop/src/renderer/styles/themes/default-color-scheme.css │
│ glass) │ │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Tokens (new --eve-_) │ new packages/desktop/src/renderer/styles/themes/command-eve-visual.css │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Shell / sider frame │ packages/desktop/src/renderer/components/layout/Layout.tsx, styles/layout.css │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Titlebar / brand / │ components/layout/Titlebar/index.tsx, Titlebar/titlebar.css, pages/conversation/platforms/acp/EgressRedactionTogglePill.tsx │
│ privacy pill │ │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Seat rail │ components/seats/SeatRail.tsx, styles/seatRail.css │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Sidebar rows + │ pages/conversation/GroupedHistory/ConversationRow.tsx, SessionStatusDot.tsx, sessionStatus.ts, index.tsx, new GroupedHistory/conversation-row.css │
│ status │ │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Search overlay │ GroupedHistory/ConversationSearchPopover.tsx / .css │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Chat header glass │ pages/conversation/components/ChatLayout/chat-layout.css │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Composer │ components/chat/UnifiedSendBar.tsx (slot contract — untouched), components/chat/SendBox/sendbox.css, new SendBox/command-eve-composer.css, new │
│ │ hooks/ui/useComposerSpotlight.ts, pages/guid/components/GuidInputCard.tsx, pages/conversation/platforms/acp/AcpSendBox.tsx (class hooks only) │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Suggestions │ pages/guid/components/GuidActionRow.tsx, QuickActionButtons.tsx │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Artifacts │ pages/conversation/Messages/components/MessageGeneratedArtifact.tsx, Messages/artifacts.tsx, media/WebviewHost.tsx │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Settings / privacy │ pages/settings/PrivacySettings.tsx, CapabilitiesSettings.tsx, SkillsHubSettings.tsx, SystemSettings.tsx, AppearanceSettings/backgroundUtils.ts │
│ pages │ │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Theme runtime │ │
│ (read-only │ utils/theme/applyTheme.ts, theme/builtinThemes.ts, utils/theme/customCssProcessor.ts │
│ reference) │ │
├──────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ i18n │ services/i18n/locales/_/conversation.json (+ modules per common/config/i18n-config.json) │
└──────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

Directory-size note (AGENTS.md ≤10 rule): styles/ currently has 7 direct children — the one new file fits; GroupedHistory/ has 10 (hooks/utils are dirs) — adding
conversation-row.css exceeds the limit, so either fold it into a styles/ subdir within GroupedHistory or co-locate as ConversationRow.module.css replacing a slot; resolve with
the architecture skill at implementation time.

14. Implementation Sequence (1.8.0-a … 1.8.0-f)

Lettering matches the sprint plan-of-record. Each slice is independently shippable and revertible.

1.8.0-a — Baseline & contract (complete)

Baseline screenshots, glass-site inventory, this contract, Fable challenge (PASS_WITH_FIXES), founder direction locked. Acceptance: this document merged as plan-of-record.

1.8.0-b — Tokens & primitive consolidation

Add command-eve-visual.css (all §5 tokens, incl. brand-orange sampled from the logo asset); port ConversationSearchPopover and any remaining ad-hoc glass onto the shipped
--glass-\* tiers; migrate hardcoded literals flagged in §5–6 (#d3d4d9, dark-section #9098a1, status-dot halo) into tokens. Zero visual delta intent.
Acceptance: screenshot diff ≈ 0 on the §15 matrix; bunx tsc --noEmit clean; no component-level hardcoded colors added.
Rollback: delete the new token file + revert consolidation commits; nothing else depends on it yet.

1.8.0-c — Shell: brand mark, seat rail, sidebar rows, status machine

Brand glyph placement (§6.1); seat-rail glass monogram redesign (§6.2); row glyph/badge/selected-row spec (§6.4); sessionStatus.ts green/blue remap + newResult state + Spin
retirement (§7); row keyboard access; i18n keys + bun run i18n:types + node scripts/check-i18n.js.
Acceptance: all six badge states + selected row match spec in light/dark screenshots; unit tests for deriveSessionStatus precedence and clearing; rows operable by keyboard; busy
state remains obvious (running-pulse screenshot approved by founder); no purple in the shell.
Rollback: seat rail and row styling are file-scoped (seatRail.css, conversation-row.css, sessionStatus.ts) — each independently revertible.

1.8.0-d — Composer, spotlight, suggestions, privacy pill

Composer glass + slot-row baseline (§6.6); spotlight hook + CSS (§8); send/stop button de-purpling; suggestion group + status chips (§6.8); privacy pill overlay-tier styling
(§6.7).
Acceptance: spotlight matrix (idle / pointer at 4 border positions / focus-visible / touch emulation / reduced-motion / reduced-transparency) screenshots pass; no AcpSendBox.tsx
behavior change (diff limited to class hooks); paperclip baseline verified at 1440 and 390 widths; pointermove trace shows ≤1 style write per frame.
Rollback: spotlight is one hook + one CSS file; removing both restores 1.8.0-c composer.

1.8.0-e — Settings, artifacts & local background-image mode

Settings/privacy panel-tier pass (§6.10); artifact preview frames (§6.9); background-image mode per §12 on the existing Appearance path, with punch-through selectors migrated
first.
Acceptance: §12 gates (no path leakage, graceful missing-asset fallback, scrim floor holds at max user intensity, contrast on 4 reference images); settings screenshots coherent
light/dark; decorative-theme regression shots unchanged.
Rollback: background mode is config-gated (enabled: false default); visual settings pass is file-scoped.

1.8.0-f — Visual QA, e2e, release candidate

Full matrix (§15), long-chat perf trace (§10), packaged smoke, Fable read-only post-review, Codex release gate.
Acceptance: every gate in §9/§10/§12 green; bunx tsc --noEmit, bun run i18n:types, node scripts/check-i18n.js, bunx vitest run tests/unit/command-eve, bun run test:e2e -- --grep
"Command EVE" all pass; just push pipeline green.

14.7 No-conflict rule (parallel bug-fix worktree)

A separate worktree is actively changing, among others, layout.css, default-color-scheme.css, chat-layout.css, ConversationSearchPopover.css, BtwOverlay.module.css,
extension-settings surfaces, and src/process/security/\*. Therefore:

- Visual slices must not modify packages/desktop/src/process/**, renderer/utils/extensionMessageBoundary.ts, extension-settings files, or tests/unit/security/**.
- New tokens/styles land in new files (command-eve-visual.css, command-eve-composer.css, conversation-row.css) wherever possible; edits to shared files (layout.css,
  default-color-scheme.css, chat-layout.css, sendbox.css, seatRail.css) are additive, appended blocks — never rewrites of existing lines — so merges stay textual no-ops.
- No visual slice may require the bug-fix branch to merge first; each slice rebases cleanly onto whichever lands first. If a shared-file hunk conflict appears anyway, the visual
  hunk moves into the new-file layer rather than resolving inside the shared file.

15. Screenshot / E2E Matrix

Screenshots (light and dark unless noted), archived to a deterministic report path per run:

1. Desktop 1440×1024: start screen, chat, settings/privacy, artifact preview.
2. Narrow 390×844: start screen, chat.
3. Sidebar: expanded, collapsed, drag-snap mid-state; long-title row; German locale + max font step.
4. Row badges: all of running / error / attention / completed / newResult / idle, plus selected row and selected-with-badge.
5. Seat rail: expanded + collapsed; active / inactive / focus-visible / switching.
6. Composer spotlight: idle, pointer at left/top/right/bottom border, focus-visible, touch fallback, reduced-motion, reduced-transparency.
7. Background-image mode: bright / dark / busy / low-contrast reference images, light + dark shell, max user intensity (scrim-floor proof).
8. Three-pane (workspace + preview open); busy/reasoning state; reduced-transparency full shell; decorative-theme regression shots.

Automated:

- Unit: deriveSessionStatus precedence + clearing table (every row of §7); sessionStatusColor token mapping; seat monogram/initials helpers (existing exports).
- E2E (--grep "Command EVE"): row keyboard activation; badge visibility per mocked state; seat switch confirm-while-generating flow unchanged; composer focus ring appears and
  spotlight suppressed (assert computed opacity 0); reduced-transparency solid fallback (emulate media).
- Perf: scripted 500-message scroll trace, assert no long-task regression vs 1.7.x baseline.

16. Hard Gates (unchanged from plan-of-record, restated)

No runtime/provider changes · no public/founder boundary regressions · no duplicate background system · no unreadable glass · no clipping at German/max-font · no long-scroll perf
regression · no hardcoded strings or colors · no card-in-card · no purple wash · no release without screenshot evidence and Fable/Codex post-review.

17. Likely Codex Follow-up Gaps

1. Brand-orange hex truth: §5.2 values are proposals; sample the actual fill from command-eve-logo.svg and re-verify 3:1 non-text contrast for the glyph on --bg-base light
   (#e8590c-class oranges are borderline on white).
1. Attention-yellow contrast: #ca8a04 at 8px on light rows is ~2.9–3.2:1 against --bg-1; verify with the halo ring in place and darken one step if it fails the 3:1 UI-stroke
   gate.
1. sessionStatus.ts remap blast radius: check every consumer of 'done' (tests, SessionStatusDot, any analytics/testids) before renaming to completed/newResult; run
   gitnexus_impact on deriveSessionStatus at implementation time.
1. Spin retirement: confirm no other surface (e.g. batch mode, cron indicator, mobile) relied on the Spin overlay as its only busy signal; verify the pulse reads as “busy” in
   user testing — if not, reinstate a spinner variant of the blue badge rather than the avatar-replacing Spin.
1. Row keyboard access: converting the row div to a focusable control interacts with the inner ⋯ Dropdown, Checkbox, and drag-and-drop (SortableConversationRow.tsx) — needs a
   focus-management pass and e2e coverage.
1. :has(:focus-visible) support: verify the shipped Electron/Chromium version supports :has() in this position; fallback is a JS-toggled class from the existing focus handlers.
1. GroupedHistory directory limit: GroupedHistory/ is at 10 direct children; adding conversation-row.css violates AGENTS.md — resolve placement with the architecture skill (CSS
   Module vs. subdirectory).
1. Seat identity rim at 14px collapsed size: a 2px arc on a 14px dot may be imperceptible; validate collapsed-rail identity legibility or accept tooltip-only identity when
   collapsed.
1. --seat-rail-width invariants: the redesign must keep 72px/40px exactly or update the toast-centering consumers (layout.css:184).
1. Privacy pill component truth: confirm EgressRedactionTogglePill.tsx is the pill visible in the titlebar region shown in the mockups (vs. a separate Datenschutz header pill in
   settings/onboarding surfaces) before styling.
1. Live-region wording: the polite badge-transition announcements (§7) need i18n review so German phrasing doesn’t read as an error toast.
1. Background scrim floor math: the +10% glass raise and --eve-bgimg-scrim-floor values are estimates; validate against the four reference images with real contrast sampling,
   and check interaction with customCssProcessor.ts !important decorative themes.
1. Uncommitted state in this worktree: the design worktree currently carries uncommitted bug-fix-adjacent modifications (security dirs, default-color-scheme.css, layout.css);
   reconcile ownership before slicing 1.8.0-b commits so visual diffs stay clean.
1. --info/--text-0/--border-special pruning: tokens.md marks them legacy-unused; decide whether 1.8.0-b prunes or defers.
