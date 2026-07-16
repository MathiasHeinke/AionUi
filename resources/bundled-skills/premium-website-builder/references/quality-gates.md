# Quality Gates

## Evidence language

Classify checks as:

- `PASS`: verified with a command, browser state, screenshot or network evidence.
- `FAIL`: verified defect that blocks the stated quality bar.
- `NOT RUN`: not yet checked. Never restate it as pass.
- `ACCEPTED`: known limitation explicitly accepted by the operator.

## Visual gate

- One coherent visual thesis governs the page.
- The first viewport has one clear focal order.
- Every major section has a deliberate visual or typographic center.
- No empty column looks unfinished.
- Media supports the section's meaning and does not merely decorate it.
- Typography, color, material and icon treatment remain consistent.
- The page does not look like an unedited component library or AI template.
- Real content has been used for final spacing and line breaks.

## Content and action gate

- Hero contains at most one kicker, headline and support line.
- Primary action is obvious and functional.
- Links and buttons lead somewhere real or are clearly marked as prototype behavior.
- No fabricated proof, numbers, testimonials, endorsements or customer logos.
- Review controls and comparison switches are hidden from the public default state.

## Responsive gate

Check 320, 390, 768, 1024, 1440 and 1920 CSS pixels:

- no horizontal page scroll;
- no clipped headline, action or navigation;
- deliberate media crop and focal point;
- readable line length and type scale;
- mobile menu works without hover;
- interactive targets are at least 44 by 44 pixels;
- closed tabs and accordions still form a complete section.

## Accessibility gate

- Semantic landmarks and heading order are coherent.
- A keyboard skip link reaches the main content.
- The complete interaction path works with keyboard only.
- `:focus-visible` is clearly visible.
- Normal text contrast reaches 4.5:1 and large text 3:1.
- Decorative media is hidden from assistive technology; meaningful media has useful alternatives.
- Autoplaying motion longer than five seconds can be paused.
- Reduced motion disables non-essential animation and prevents cinematic video loading.
- Dialogs close with Escape and restore focus.

## Performance gate

Targets on a representative production build:

- LCP at or below 2.5 seconds.
- CLS at or below 0.1.
- INP at or below 200 milliseconds.
- Explicit media dimensions or aspect ratios.
- Core fonts and first-view imagery optimized and cached appropriately.
- No avoidable third-party script in the critical path.
- No application error in the browser console.

For poster-first hero media:

- Poster is the initial LCP candidate.
- Initial DOM has no `video.src` and no `<source src>` for the video.
- Network shows zero video bytes before the lazy trigger.
- WebM is preferred, MP4 is the fallback and MIME types are correct.
- The motion control can appear at `canplay`; video fades only after `playing`.
- Poster remains visible on failure.
- Reduced motion triggers no video request. Data saver does the same when the
  browser exposes the Network Information API.
- A runtime preference change pauses playback, removes all media sources and
  calls `video.load()` so an active request cannot continue buffering.

Prove the loading contract from a cold navigation with cache disabled and the
tested preferences set before navigation. Before the lazy trigger, inspect both
DOM and network: no `video[src]`, no `source[src]`, empty `currentSrc`, no
matching Resource Timing entry and no matching request in the network log. A
previously cached visit is not valid evidence.

## Build gate

- Repository's production build succeeds.
- Type checks, lint and relevant tests pass.
- Browser console has no application errors.
- Changed files match the requested scope.
- `git diff --check` passes.
- Existing unrelated changes are preserved.

## Deployment gate

Before any public write, confirm:

- the operator approved the exact preview;
- target project, account and domain are correct;
- prototype `noindex` policy is intentional;
- production indexing policy is intentional;
- analytics, cookies, forms and data destinations are explicitly approved;
- cache headers fit versioned media filenames;
- security headers do not break required media or fonts;
- rollback path is known.

Never carry `noindex` from a prototype into production by accident. Never remove
it from a private prototype without approval.

## Handoff report

```text
Art direction:
Local preview:
Changed files:
Desktop widths:
Mobile widths:
Keyboard and focus:
Reduced motion:
Poster first network proof:
Build and tests:
Console:
Known limitations:
Public deploy: not requested | approved | completed
```
