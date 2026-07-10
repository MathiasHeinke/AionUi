# Command EVE 1.8.0 Composer Design QA

Date: 2026-07-10
Slice: 1.8.0-d primary work surface

## Result

The composer slice is ready to commit. It does not claim that the full 1.8.0 shell redesign is complete; the remaining legacy shell and route surfaces stay in the subsequent design slices.

## Live Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| Start composer, dark pointer spotlight | PASS | `screenshots/dev/guid-composer-dark-hover-final.png` |
| Start composer, light pointer spotlight | PASS | `screenshots/dev/guid-composer-light-hover.png` |
| In-chat composer, dark | PASS | `screenshots/dev/chat-dark-hover.png` |
| In-chat composer, light finished | PASS | `screenshots/dev/chat-light-finished.png` |
| Mobile 390px | PASS, `scrollWidth === clientWidth === 390` | `screenshots/dev/guid-mobile-dark-390.png` |
| Keyboard focus | PASS, blue 2px outline; spotlight suppressed | `screenshots/dev/guid-keyboard-focus-dark.png` |
| Reduced effects | PASS, solid background; no blur; static 30% hotspot | `screenshots/dev/guid-reduced-effects-dark.png` |
| Start drag feedback | PASS, dashed primary border + tint | `screenshots/dev/guid-drag-dark.png` |
| In-chat drag feedback | PASS, dashed primary border + tint | `screenshots/dev/chat-drag-dark.png` |
| Speech recording | PASS, timer and waveform visible | `screenshots/dev/guid-speech-recording-dark.png` |
| Speech transcription | PASS, processing feedback visible; empty recording ended as `Keine Sprache erkannt` | `screenshots/dev/guid-speech-processing-dark.png` |
| Running/stop state | PASS, blue stop + white square + neutral disabled mic | `screenshots/dev/chat-stop-dark.png` |
| Draft while running | PASS, stop changes to enabled send without moving the row | `screenshots/dev/chat-queue-ready-dark.png` |

## Runtime Evidence

- Local inference smoke finished after 4:49 without blocking the renderer.
- Renderer CDP roundtrip during inference: 77 ms.
- The fresh dev profile correctly hit the onboarding gate, so this run validated runtime/UI behavior rather than answer quality.
- Backend emitted `turn_completed` with status `finished`; no manual stop was used.
- Pointer controller produced clamped four-corner positions: `4px 4px`, `764px 4px`, `4px 186px`, `764px 186px`.
- All composer controls measured 32px high on desktop; mobile had no horizontal overflow.

## Automated Gates

- TypeScript: pass
- Oxlint on touched TS/TSX: pass; full repository lint exits 0 with 896 pre-existing warnings and no errors
- Oxfmt on touched formatter-stable files: pass
- i18n validation/types: pass; 227 pre-existing warning-only unknown literals remain
- Focused composer, ACP, speech and regression tests: 21/21 pass
- Full Vitest suite: 3,738 passed, 3 skipped; 372 files passed, 1 skipped
- Contract test prevents regressions in speech CSS ownership, drag feedback, stop contrast, placeholder scope and solid fallbacks
- Fable 5 High final review: PASS (`FABLE_180_COMPOSER_FINAL_GATE_COMPLETE`)

## Evidence Hygiene

The screenshot set contains only the isolated dev profile and synthetic E2E fixture data. Debug/intermediate renders were removed.
