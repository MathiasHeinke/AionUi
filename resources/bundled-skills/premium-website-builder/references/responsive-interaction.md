# Responsive Interaction

## Compose for each device class

Define the desktop and mobile composition separately. For every major element,
decide whether it remains, moves, crops, simplifies, becomes a menu or disappears.
Do not merely scale the desktop canvas down.

Minimum review widths:

```text
320, 390, 768, 1024, 1440, 1920 CSS pixels
```

Add intermediate widths where the actual content breaks. Device presets alone do
not prove responsiveness.

## Floating navigation pattern

A translucent capsule can work when the art direction supports it. It is optional.
The useful behavior has clear states:

1. At the top: full wordmark, links and primary action.
2. Scrolling down: the capsule may contract to essential icons or the active section.
3. Scrolling up, focusing it or approaching with a pointer: it expands again.
4. On touch: an explicit button opens a real mobile menu. No proximity behavior.

Implementation rules:

- Keep navigation reachable by keyboard in every state.
- Expand on `focus-within`, not hover alone.
- Provide accessible names for icon-only states.
- Use a real `dialog` or an equivalent focus-managed menu on mobile.
- Escape closes the menu, focus returns to the opener and background scroll locks.
- Respect reduced motion; state changes remain understandable without animation.
- Avoid excessive blur on low-power devices and Safari.

## Interaction hierarchy

Use motion to explain state:

- 120 to 220 ms for direct control feedback.
- 250 to 500 ms for navigation or panel state changes.
- 600 to 1100 ms for atmospheric reveals and media fades.

Prefer opacity and transform. Avoid animating layout properties when a transform
can express the same change. Do not put `transition: all` on broad containers.

## Touch and hover

- Every hover-only reveal needs a tap, focus or always-visible equivalent.
- Gate pointer effects with `@media (hover: hover) and (pointer: fine)`.
- Interactive targets must be at least 44 by 44 CSS pixels.
- Do not replace the system cursor unless the concept truly requires it.
- Never hide the page's meaning behind a gesture with no visible affordance.

## Sections and progressive disclosure

Tabs and accordions must not make the closed state look empty. Keep a title,
summary, useful visual cue and current state visible. Deep content can open on
demand, but the section should remain understandable before interaction.

For tabs:

- Use correct tab semantics and arrow-key behavior.
- The active tab must be distinguishable without color alone.
- On narrow screens, use a scrollable tab row or a different composition rather
  than squeezing unreadable labels.

For accordions:

- Use buttons with `aria-expanded` and `aria-controls`.
- Preserve a stable visual rhythm when panels open.
- Do not hide primary conversion information by default.

## Media crop

Set explicit aspect ratios and define crop focal points per breakpoint. A desktop
hero often needs a different `object-position` or a dedicated mobile poster.
Verify that text remains legible over every crop and that important subjects are
not cut off.

## Required browser checks

- No horizontal page scroll at any required width.
- Navigation opens, closes and restores focus.
- Keyboard order follows the visual order.
- Focus indicators remain visible over images and glass.
- Text does not collide with media subjects.
- Sticky elements do not cover headings or actions.
- Browser zoom at 200 percent remains usable.
- Long German or translated labels do not break controls.
- Reduced motion preserves all content and state changes.
