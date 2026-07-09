# Command EVE 1.8.0 Visual Design

Status: draft after Fable plan challenge
Source sprint: `docs/strategy/command-eve-180-design-sprint-2026-07-09.md`

## Design Intent

Command EVE should feel like a calm, capable AI work OS: precise, premium, and
alive, but never decorative at the cost of legibility or speed.

The 1.8.0 visual direction is restrained glass, sharper hierarchy, cleaner
spacing, stronger light/dark parity, and a local background-image mode that
keeps the user's data on-device.

## Principles

1. Work surface first, effect second.
2. Glass is a tokenized system with chrome, panel, and overlay tiers.
3. Text and controls must remain readable over worst-case backgrounds.
4. No individual message-bubble glass and no glass over large scrolling regions.
5. Existing Arco/IconPark primitives stay; the sprint refines, it does not
   replace the UI stack.
6. Background image mode is local-first and extends the existing Appearance
   theme path.
7. Decorative/user CSS themes are preserved and regression-tested, not redesigned.

## Glass Tiers

### Chrome

Use for fixed app structure: sidebar, title/header strip, composer chrome.

Properties:

- medium blur
- low shadow
- quiet border
- stable height and spacing
- reduced-transparency fallback to opaque `--bg-1` / `--bg-2`

### Panel

Use for inspectable app panels: settings groups, artifact preview frames,
privacy/capability surfaces.

Properties:

- stronger fill than chrome
- clear border
- no nested card-in-card look
- readable body text on background-image mode

### Overlay

Use for popovers, search, command menus, model selectors, and temporary
decision surfaces.

Properties:

- strongest blur/shadow
- compact geometry
- focus ring always visible
- no background bleed through text

## Screen Inventory

Primary screens:

- Chat shell
- Sidebar/history/archive/groups
- Start screen
- Composer/send bar
- Message list
- Reasoning/tool/busy state
- Artifact preview
- Settings
- Privacy
- Capabilities/skills
- Team create/manage

State screenshots required:

- light/dark
- 1440x1024 desktop
- 390x844 narrow/mobile
- collapsed/expanded sidebar
- workspace and preview open
- long chat titles
- busy/reasoning with queue
- German locale
- max font size
- bright/dark/busy/low-contrast background image
- reduced-transparency
- decorative preset regression shots

## Component Rules

### Layout and Sidebar

Refine first through tokens, not hardcoded colors. Preserve collapsed and
drag-snap behavior. Sidebar active rows need stronger hierarchy than hover rows,
but no heavy card treatment.

### Chat Header

Port the existing header glass onto the shared chrome tier. Replace the current
reduced-motion transparency proxy with `prefers-reduced-transparency`.

### Composer

Keep the `UnifiedSendBar` slot contract stable. Visual polish belongs in
wrapper classes and CSS. Do not refactor `AcpSendBox.tsx` behavior for visual
reasons.

### Messages

Improve rhythm and scanning, but avoid translucent message bubbles. User and
assistant messages should stay readable and stable during long scrolls.

### Settings and Privacy

Settings should feel like one coherent operating console. Use panel tier for
groups and privacy controls. The privacy pill must align with page header
rhythm and remain visually calm.

### Artifacts

Artifacts are inspection surfaces. Images, videos, audio, HTML, files, and
tables should render in consistent preview frames with clear open/download
actions, not decorative frames.

## Background Image Mode

The existing Appearance background mechanism must be migrated or extended.

Rules:

- no cloud upload
- no raw original filesystem path in exported config
- imported local asset or existing data URL theme asset
- scrim/readability floor always active under chat/settings content
- user controls: enable, image, fit, intensity, blur, dim, adaptive tint
- missing asset falls back to normal theme

Readability floor:

- body text contrast: 4.5:1 minimum
- large text and UI strokes: 3:1 minimum
- focus rings visible on every glass tier
- chat column and settings content keep an opaque-enough scrim regardless of
  user intensity settings

## Image Exploration Prompts

Target dimensions: 1440x1024 desktop app.

### Direction A — Restrained Professional Glass

Design a serious AI work OS with subtle frosted chrome, clean sidebar hierarchy,
compact premium composer, calm light mode, and clear privacy/status affordances.
Use glass only on shell chrome and overlays. Avoid decorative blobs, card soup,
or marketing-page treatment.

### Direction B — Premium Work OS

Design a darker, more premium Command EVE interface with precise spacing,
native macOS depth, high-contrast text, refined message rhythm, artifact preview
affordance, and a polished status/reasoning indicator. Keep it practical for
daily operator work.

### Direction C — Adaptive Background Mode

Design Command EVE with a user-selected local background image behind the app.
The app chrome adapts through scrim, glass, tint, and contrast. Show a readable
chat shell, sidebar, composer, and artifact preview over a complex background
without losing clarity.

## Implementation Order

1. Inventory current glass/background sites.
2. Add tiered glass tokens in `default-color-scheme.css`.
3. Add primitives and reduced-transparency fallback.
4. Port sidebar and chat-header glass to primitives with near-zero visual delta.
5. Capture screenshots.
6. Polish sidebar/chat/composer.
7. Polish settings/privacy/artifacts.
8. Migrate/extend background image mode.
9. Full visual QA matrix.

## Hard Gates

- No runtime/provider behavior changes.
- No new public/founder boundary regressions.
- No duplicate background-image system.
- No unreadable glass over background images.
- No clipping at German/max-font sizes.
- No performance regression on long chat scroll.
- No release without screenshot evidence and post-review.
