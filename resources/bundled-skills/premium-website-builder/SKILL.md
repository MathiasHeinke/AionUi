---
name: premium-website-builder
description: Build or rework a visually distinctive, production-ready landing page or narrative website from a goal, brand, live page, screenshot, reference image, or rough idea. Use when the operator says "build me a website", "turn this design into a live page", "make the landing page feel premium", "create a cinematic hero", or asks for responsive implementation and browser verification without requiring Figma. Produces a locked art direction, semantic implementation in the existing stack, poster-first lazy hero video when it earns its place, responsive interactions, accessibility and performance evidence, and a review-ready local build. Compose with landing-copy when the ICP, value frame, or page copy is not already locked.
---

# Premium Website Builder

Build a site that feels authored for one company and one ambition. The goal is
not more visual effects. The goal is a coherent place, a clear narrative, real
interaction and fast delivery in the browser.

Figma is optional. A selected reference image, screenshot, moodboard or live
page can be the visual source of truth when its composition is explicit enough.

## When to use

- Build a landing page, homepage, product page or small narrative website.
- Turn a reference image, generated concept or screenshot into a live page.
- Rework a page that is functional but generic, flat, crowded or visually cheap.
- Add a cinematic hero with an immediate poster and lazily loaded video.
- Make navigation, sections and interactions feel deliberate on desktop and mobile.
- Verify the finished page in a real browser and prepare it for an approved deploy.

Do not use this skill for copy only. Use `landing-copy` for positioning, offer
language and section copy. Do not use it for a single isolated CSS effect unless
that effect is being integrated into a complete page direction.

This is the end-to-end website orchestrator. If focused skills such as
`reference-page-analysis`, `visual-art-direction`, `ui-design-spec`,
`ui-effect-library` or `responsive-optimizer` are installed, use them as narrow
inputs or review passes. This skill owns the sequence, chosen stack, media
contract, quality gates and final handoff when their advice overlaps.

## Load the references

- Always read `references/art-direction.md` before choosing the visual system.
- Always read `references/quality-gates.md` before implementation and again
  before handoff.
- Read `references/poster-first-lazy-video.md` whenever the hero uses motion,
  image-to-video generation, a background film or multiple video segments.
- Read `references/responsive-interaction.md` whenever the page has navigation,
  menus, hover behavior, scroll states, accordions or other responsive controls.

## Operating boundary

- Inspect the existing repository, framework, conventions and dirty state first.
  Use the existing stack unless the operator explicitly wants a new one.
- Keep copy, navigation and actions as real HTML. Never bake them into images or video.
- Reuse brand assets only when their provenance and usage are clear.
- Do not invent testimonials, customer counts, outcomes, logos or other proof.
- Build and verify locally by default. Public deployment, domain changes,
  analytics, cookies, forms and data collection require explicit approval.
- Before generating image or video assets, verify the available capability,
  provider, rights, privacy boundary and operator approval. Never invent a
  completed asset or attach a dead media URL when generation is unavailable.
- In a client seat, keep that client's brand, assets and evidence isolated.

## Method

### 1. Establish truth and the page job

Inspect the brief, current site, screenshots, assets and relevant source files.
Lock these facts before styling:

1. Primary audience and the one job the page must complete.
2. Primary action and any quieter secondary action.
3. Existing copy state: locked, editable or missing.
4. Desired feeling in concrete terms, plus visual directions to avoid.
5. Required sections, integrations, devices and publication state.

If the ICP, promise or section copy is missing, run `landing-copy` first. Ask at
most three high-leverage questions at once; continue with clearly labeled
assumptions when the missing choice is reversible.

### 2. Lock one art direction

Translate the desired feeling into one visual thesis: composition, image world,
typography roles, color roles, material language, geometry, ornament and motion.
Use `references/art-direction.md`.

When the direction is genuinely ambiguous, produce two or three high-quality
visual routes and have the operator choose. Once selected, treat the winning
route as the visual source of truth. Do not average incompatible routes together.

### 3. Design the narrative before the components

Arrange a page journey, not a component inventory. A useful default is:

```text
promise → proof or glimpse → explanation → spaces or services → trust → action
```

Every major section needs a clear visual or typographic center. An empty column
must carry intentional negative space, atmosphere or media; it must not look
unfinished. Use cards, tabs and accordions only when the information model calls
for them.

Hero discipline:

- At most one kicker, one headline, one short support line.
- One primary action and at most one quieter secondary action.
- Keep the headline to roughly two desktop lines when the language allows it.
- The hero should communicate one place, promise or transformation at a glance.

### 4. Implement the real page

Build semantic structure and real controls in the repository's current stack.
Create reusable tokens for type, color, spacing, radii, borders, shadows and
motion. Preserve stable dimensions for media to prevent layout shift.

When there is no existing stack, use semantic HTML, CSS and JavaScript for a
truly static page. Use Vite with React for an interactive single-page build that
benefits from components, stateful navigation or cinematic media controls.
Record the choice instead of silently introducing a framework.

Use enhancement in layers:

1. Readable HTML and working navigation.
2. Responsive layout and static media.
3. Accessible interaction.
4. Motion and cinematic media.
5. Optional decorative effects that survive the quality gates.

Do not let a visual experiment block the usable page. If an advanced effect is
unstable, keep the strong static composition and remove the effect.

### 5. Treat hero motion as a progressive enhancement

The poster is the first and complete hero. The video is a later enhancement,
not the loading screen. Follow `references/poster-first-lazy-video.md` exactly.

First verify that an approved image-to-video capability is actually available.
If it is not, ship the poster-complete local page plus a media manifest and exact
generation prompts. Mark the video `BLOCKED_CAPABILITY`; do not fake motion,
claim completion or wire sources that do not exist.

The essential contract:

- Poster and video share the same composition, crop and neutral anchor state.
- The poster is requested immediately and owns the initial paint.
- The initial DOM contains neither `video.src` nor a `<source src>` for the video.
- Attach sources only after page load, hero proximity and browser idle.
- Do not attach video for reduced motion or, when the browser exposes the
  signal, data saver users.
- Expose the control at `canplay`, but fade video in only after the `playing`
  event; keep the poster underneath on failure or rejected autoplay.
- Keep motion sparse and natural. Repetition must not reveal the loop.

### 6. Compose desktop and mobile deliberately

Desktop and mobile are related compositions, not one layout at different scale.
Use `references/responsive-interaction.md`. Decide what crops, reorders,
collapses, remains visible and becomes a mobile menu. Never require hover to
understand or operate the page.

### 7. Verify in the real browser

Run the build, start a persistent local preview process and open the actual page
in the available active browser. Keep the preview alive for operator review.
Check the browser console, network, focus order, responsive widths, media behavior and interaction states. Use
`local-vision-qa` when it is available, but do not replace human visual judgment
with a single automated score.

Iterate until all release-blocking items in `references/quality-gates.md` pass.
Screenshots, console output and network evidence are stronger than claims such
as "responsive" or "production ready".

### 8. Hand off before publishing

Present the local URL or preview, the locked design decision, changed files,
media package, verification evidence and any known limitations. Ask for the
operator's approval before a public deploy or any external write.

## Output

Return:

1. The locked visual thesis and page narrative.
2. A runnable website in the requested or existing stack.
3. Optimized poster and video variants when motion is used.
4. A concise verification report covering desktop, mobile, accessibility,
   performance, console and media loading.
5. A local preview URL and, only after approval, the public deployment result.

## Non-negotiable quality rules

- One visual thesis per page. Never copy a previous client's palette or scenery by default.
- No generic black page plus red accent as a shortcut to premium design.
- No card grid as a substitute for a page idea.
- No two alternating still images presented as a video.
- No repeated signature gesture on an obvious timer.
- No direct video sources in the initial render when a poster-first hero is promised.
- No decorative button without a real action.
- No mobile interaction that depends on hover.
- No automatic public deployment or data collection.
- No "production ready" claim without browser and build evidence.
