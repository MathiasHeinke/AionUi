# Command EVE 1.823.0 — Grok 4.6 independent regression/UX/security review

You are the second independent reviewer from a different provider family. Work read-only in this exact checkout. Do not edit files, do not spawn subagents, do not use web search/network, do not call providers, and do not expose secrets or private data.

## Frozen input

- Worktree: `/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-seat-management`
- Branch: `codex/eve-18230-seat-management`
- Git SHA: `fee7da7957969cf4b0761625f60f729967009030`
- Integrated source snapshot: `sha256:c95ddafacf10c1215fc205ed39eb1746795daaef8d60f48ddb3b1655ea288a8c`
- Seat feature baseline/range: `2fcd23a0bce9f1649a2145f109f49be28bfce599..fee7da7957969cf4b0761625f60f729967009030`
- Current composer/image/video implementation is the working-tree diff plus new files under `packages/desktop` and `tests`.
- Linear work item: MAT-1843.

## Required audit

Independently trace and challenge:

1. Free seats and Alois-style recovery: count restoration, no old €99 purchase redirect, unlimited user-created client seats, stable seat/Seed/company-brain binding, rename/settings and failure recovery.
2. Composer parity and UX: same behavior on start and active chat, explicit work-product mode only, no keyword/prose trigger, correct one-shot reset, project + authority and MAX + context as true compound pills, premium icon/text alignment, top-right image reference vs top-left regular attachments, compact responsive layout.
3. Motion: composer menus must use the shared measured cadence (480 ms open, 380 ms close, 300 ms hover, 400 ms selection), close animation must actually remain mounted, and reduced-motion must eliminate visible motion. The six-rung authority menu must override Arco's 200 px cap, use available viewport height, and scroll all six rungs.
4. Image/video execution: exact tier/resolution/aspect/reference handoff, direct image create vs Hermes artifact edit, queue/fresh-chat round trip, retries/deduplication, failure restore, seat-switch fences, artifact refresh/persistence.
5. Security: IPC input validation, file capability boundaries, replay/double-spend, conversation/seat cross-binding, path handling, and stale events.
6. Tests and source quality: name any P0/P1 regression or insufficient gate. You may run focused read-only tests if useful.
7. Explicitly confirm or refute the interrupted attempt's lead that paid image-edit state may lack the seat/Seed capture already present in image generation and video edit.

For every finding provide severity P0/P1/P2, exact `file:line`, failure/attack path, preconditions, impact, and smallest remediation. Distinguish facts from inference. End with `PASS`, `REJECT`, or `PARK`, then:

`GROK46_REVIEW_COMPLETE`
