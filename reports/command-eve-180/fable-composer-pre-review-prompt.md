You are the read-only Fable 5 High design and code reviewer for Command EVE 1.8.0-d.

Do not edit files. Do not print secrets or inspect .env files. Work only in the current repository.

Read these sources:

- docs/strategy/command-eve-180-design.md, especially sections 9, 15, 16, and 18
- docs/strategy/command-eve-180-implementation-plan-2026-07-09.md, section 8
- docs/strategy/assets/command-eve-180/command-eve-180-light-approved.png
- docs/strategy/assets/command-eve-180/command-eve-180-dark-final.png
- packages/desktop/src/renderer/styles/themes/command-eve-visual.css
- packages/desktop/src/renderer/components/chat/UnifiedSendBar.tsx
- packages/desktop/src/renderer/components/chat/SendBox/index.tsx
- packages/desktop/src/renderer/components/chat/SendBox/sendbox.css
- packages/desktop/src/renderer/components/media/FileAttachButton.tsx
- packages/desktop/src/renderer/pages/guid/components/GuidInputCard.tsx
- packages/desktop/src/renderer/pages/guid/components/GuidActionRow.tsx
- packages/desktop/src/renderer/pages/guid/index.module.css

Current live evidence:

- reports/command-eve-180/screenshots/dev/guid.png
- reports/command-eve-180/screenshots/dev/appearance-light.png
- reports/command-eve-180/screenshots/dev/appearance-dark.png

Challenge the intended implementation before Codex commits it:

1. One shared `.eve-composer-surface` visual contract for start and chat.
2. Panel-tier glass with a solid reduced-transparency fallback.
3. Paperclip and all controls on a stable 32px baseline, without reordering UnifiedSendBar.
4. Blue send/stop states with no visible `--aou-*` dependency.
5. Orange pointer-local border spotlight using one rAF-coalesced style write per frame, cached geometry, and no React render per pointer move.
6. Keyboard focus suppresses spotlight; touch/coarse pointer and reduced motion use a static border/hotspot.
7. No behavior change to send, stop, queue, speech, permissions, context, files, ACP, or Hermes.
8. Desktop 1440 and mobile 390 geometry must remain stable in idle, recording, transcribing, sending, stopping, and queueing states.

Return findings ordered P0-P3 with exact file references and concrete fixes. Distinguish release blockers from optional polish. End with exactly:

FABLE_180_COMPOSER_PRE_REVIEW_COMPLETE
