# Design QA — Command EVE V3 Workbench

## Comparison target

- Source visual truth: `/Users/mathiasheinke/.codex/generated_images/019fb3b7-89c5-7c61-8d28-e47bd4010766/exec-186206a2-89ba-44e7-86ba-ecca8fce1d95.png`
- Rendered implementation: `/var/folders/dc/rdykb2jj0p7d6qvvyh1bcnt40000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-08-08 at 4.32.18 PM.jpeg`
- Combined comparison input: `/tmp/command-eve-v3-design-qa/selected-v3-vs-live-final.png`
- Viewport and CSS size: `1112 x 768` logical px in the isolated Electron QA window.
- Source pixels: `1507 x 1044`.
- Implementation pixels: `1112 x 768`.
- Density normalization: the source was scaled with preserved aspect ratio and center-cropped to `1112 x 768`; the implementation remained at its native `1112 x 768` CUA capture. Both halves were then placed in one `2224 x 768` comparison image. Effective comparison density: `1x` logical-pixel normalized.
- State: light Command EVE shell, project navigation visible, Browser active at `https://command-eve.com/`, EVE chat sidecar pinned on the right, browser history retained.

The source mock contains populated chat messages and an earlier website composition. The implementation uses the isolated synthetic `EVE QA Workbench` conversation and the current live website. Those content differences are intentional; the judged target is the app-shell composition, controls, surfaces, and interaction behavior.

## Findings

No actionable P0, P1, or P2 mismatch remains in the selected V3 scope.

The combined final comparison shows the same information architecture and composition: persistent left navigation, app-level Chat/Browser tabs with the launcher immediately following the last tab, dominant browser canvas, layout controls at the trailing edge of the browser navigation bar, and a restrained pinned EVE sidecar on the right. The sidecar and browser are separated by one hairline instead of framed cards.

### Required fidelity surfaces

- Fonts and typography: existing Command EVE system typography and optical weights are preserved. Tab labels, URL text, sidecar title, onboarding copy, and compact controls remain legible without clipping or unintended wrapping. Dynamic website display typography is outside the shell implementation.
- Spacing and layout rhythm: content begins at the established shell boundary; the launcher follows the final tab; browser controls align within the 44 px navigation row; the browser remains dominant; the sidecar keeps a compact, resizable desktop width and a single separator. No persistent control is hidden or overlapped at the tested viewport.
- Colors and visual tokens: implementation uses the existing glass, text, focus-ring, selected-row, and hairline tokens. The pinned sidecar is calm and solid enough to separate chat from live web content; the unpinned overlay was also retested after its opacity correction.
- Image quality and asset fidelity: no target shell asset was replaced by CSS art, custom SVG, emoji, or placeholder imagery. Controls use the existing IconPark family. Browser content is the real live page and retains its native crop and sharpness.
- Copy and content: all new shell labels are localized in German and English. The empty synthetic chat copy is coherent for the QA state; it is intentionally different from the populated design mock.
- Icons and affordances: fullscreen, split-right, split-bottom, sidecar, pin/unpin, expand-chat, close, launcher, browser navigation, and tab-close controls use consistent icon weight, native buttons, accessible labels, pressed state, focus treatment, and reduced-motion fallbacks.
- Responsiveness and accessibility: full canvas, right split, bottom split, pinned sidecar, and floating sidecar were exercised. Controls have semantic button/group/tab roles, `aria-label`, `aria-pressed`, keyboard tab behavior, focus-visible styling, and reduced-motion handling.

## Focused region comparison

A separate crop was not required after the final full-view comparison because the normalized `2224 x 768` input kept the complete tab strip, browser toolbar, layout controls, sidecar header, divider, and composer readable at original implementation resolution. These regions were additionally inspected through direct Computer Use interactions rather than inferred from code.

## Primary interactions tested

- Open and reuse the singleton Browser through the `+` launcher.
- Browser -> Chat -> Browser with URL, rendered page, and back state preserved.
- Browser -> `AGENTS.md` file preview -> Browser with URL and page state preserved.
- Full-canvas Browser.
- Chat-left / Browser-right split.
- Browser-top / Chat-bottom split.
- Pinned right EVE sidecar.
- Unpin to floating overlay and pin back into the layout.
- Maximize Chat and return to Browser.
- Close only the sidecar while retaining Browser state.
- Resizable sidecar and bottom split affordances present.

## Console and runtime check

- No renderer crash, hook-order error, or visible navigation failure occurred in the final interaction pass.
- The Electron main-process log still emits `ERR_ABORTED (-3)` when repeated test navigation to the same URL cancels an in-flight guest-view load. The page completes visibly, URL/history remain correct, and this does not alter the design result. It is classified as non-blocking P3 runtime log noise for the later browser-transport cleanup, not a visual or interaction failure in this handoff.

## Comparison history

### Iteration 1 — blocked

- Earlier P2: the launcher sat at the far right instead of directly after the final tab.
  - Evidence: `/var/folders/dc/rdykb2jj0p7d6qvvyh1bcnt40000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-08-08 at 4.08.17 PM.jpeg`.
  - Fix: changed the tab strip from an expanding track to content-sized flex behavior while keeping the layout-control group independently aligned.
- Earlier P2: the unpinned glass sidecar allowed strong website colors to bleed through.
  - Evidence: `/var/folders/dc/rdykb2jj0p7d6qvvyh1bcnt40000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-08-08 at 4.09.37 PM.jpeg`.
  - Fix: applied the solid Command EVE chrome background and a 96 percent content surface to the floating sidecar.
- Earlier P2: maximizing Chat remounted an unrelated scheduled-task hover popover under the pointer.
  - Evidence: `/var/folders/dc/rdykb2jj0p7d6qvvyh1bcnt40000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-08-08 at 4.10.13 PM.jpeg`.
  - Fix: Command EVE's unconfigured scheduler prompt now opens by deliberate click instead of hover.
- Post-fix evidence: `/var/folders/dc/rdykb2jj0p7d6qvvyh1bcnt40000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-08-08 at 4.20.01 PM.jpeg`; all three findings retested PASS.

### Iteration 2 — blocked

- P2 found in the normalized side-by-side comparison: the four layout controls still lived in the app-level tab band, while the selected V3 target placed them in the Browser navigation bar.
  - Evidence: `/tmp/command-eve-v3-design-qa/selected-v3-vs-live.png`.
  - Fix: extracted one reusable `WorkbenchLayoutControls` component, added a trailing `toolbarActions` slot to `WebviewHost`, rendered the controls in `URLViewer`, and retained the titlebar placement only for non-URL artifacts.
- Post-fix evidence: `/var/folders/dc/rdykb2jj0p7d6qvvyh1bcnt40000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-08-08 at 4.32.18 PM.jpeg` and `/tmp/command-eve-v3-design-qa/selected-v3-vs-live-final.png`; direct Computer Use retest PASS.

## Implementation checklist

- [x] V3 browser-dominant shell implemented.
- [x] Pinned/floating EVE sidecar implemented.
- [x] Full, right split, bottom split, and sidecar modes implemented.
- [x] Browser state survives Chat and file-preview switching.
- [x] Layout controls placed in the Browser toolbar.
- [x] Keyboard/ARIA/reduced-motion treatment present.
- [x] Source and final implementation compared in one normalized input.
- [x] No actionable P0/P1/P2 remains.

## Follow-up polish

- P3: deduplicate or intentionally swallow the harmless Electron guest-view `ERR_ABORTED (-3)` cancellation during repeated same-URL navigation so developer logs stay quiet.

## 1.823.0 addendum — explicit work-product composer

### Comparison target

- Source visual truth: `/var/folders/dc/rdykb2jj0p7d6qvvyh1bcnt40000gn/T/TemporaryItems/NSIRD_screencaptureui_U8k7OW/Bildschirmfoto 2026-08-15 um 10.23.07.png`
- Rendered implementation: `/tmp/eve-composer-pdf-accent-final.png`
- Combined comparison input: `/tmp/eve-composer-pdf-accent-compare-final.png`
- Viewport/state: Command EVE start composer, light theme, explicit `PDF erstellen` mode active, focus cleared after selection.
- Source pixels: `1652 x 888`; compared source crop: `1450 x 520` normalized to `1426 x 528`.
- Implementation pixels: `1426 x 528`, captured from a `713 x 264` CSS-pixel clip at `2x`; composer itself measured `665 x 208` CSS px.
- Density normalization: both focused regions were compared at `1426 x 528` and placed in one `2852 x 528` image.

### Findings

No actionable P0, P1, or P2 mismatch remains in this focused scope.

- Fonts and typography: the compact PDF label, placeholder, project/authority labels and context controls retain the source hierarchy, optical weight and truncation behavior.
- Spacing and layout rhythm: header, editable canvas, action row and lower compound controls keep the same composition; the requested tool-coloured frame does not change geometry.
- Colors and visual tokens: the former neutral composer frame now reads the selected PDF identity through one existing `1px` red hairline. It adds neither a second border nor a coloured fill. Image, video and presentation were runtime-checked through the same contract with violet, cyan and orange accents.
- Image quality and asset fidelity: this surface contains no raster artwork. Every visible control uses the existing Icon Park family; no text glyph, emoji, CSS drawing or inline-SVG substitute was introduced.
- Copy and content: the source labels and German work-product copy remain unchanged.
- Interaction/accessibility: the tools menu opened, all four modes selected, each retained a `1px` frame, and the composer textarea remained visually borderless. Light and dark token variants were checked. Runtime logging captured zero new console exceptions during the four-mode interaction pass.

### Focused region comparison

The focused composer crop was required because the requested difference is a one-pixel frame and is not reliably judgeable in a full-window screenshot. The combined image keeps both surfaces at identical pixel dimensions; the intended difference is the selected PDF colour carried from pill to frame.

### Comparison history

- Initial source state: tool identity was visible on the PDF pill and tools trigger, while the outer composer frame stayed neutral.
- Requested refinement: carry the selected tool identity onto the existing frame without creating a thick or nested selection border.
- Fix: introduced one shared light/dark work-product palette and let the existing composer border/spotlight variables consume the active mode colour at `42%` mix.
- Post-fix evidence: `/tmp/eve-composer-pdf-accent-compare-final.png`; measured border `1px`; image/video/presentation/PDF runtime mapping and zero-console-error pass recorded through Electron CDP.

### Implementation checklist

- [x] One shared colour source for pill, menu icon and composer frame.
- [x] Exactly one `1px` frame; no added border width, fill or static inner focus rectangle.
- [x] Four distinct light accents and four dark-mode accents.
- [x] Start and in-session surfaces share the same selector/CSS contract.
- [x] Focused DOM contracts and live Electron interaction pass green.

final result: passed
