# Command EVE 1.7.91 Release Hardening Handoff

## Scope

1.7.91 is the release-hardening line before notarize and R2 upload. It does not pull the larger 1.8 autonomy, xAI multimodal, payments, remote Hermes, or full privacy-matrix work into the ship gate.

## Release Blockers Covered

- Long-session history must be recoverable by scrolling upward until the first turn. The renderer loads compact 250-message history pages and dedupes offset overlaps.
- Cloud inference truncation must not silently stop a task when providers return `finish_reason: length` or `max_tokens`. Command EVE now treats those cloud-shim completions as continuation-worthy through the existing continuation cap.
- Streaming must not look frozen when the backend is active but renderer commits are backed up. The ACP watchdog classifies buffered events as `ui_backlog` so pending thinking/tool output can flush.
- Team creation must expose only Command EVE as the user-visible leader. Raw CLI lanes such as Claude Code, Codex, Gemini, Hermes CLI, or worker names remain internal routing choices.
- Auto-title stays cloud-first and does not fall back to local Gemma. Local Gemma unreliability remains visible via the Gemma smoke gate, not hidden inside titles.
- Public/client builds must not expose the internal Command Center. The route, sidebar entry, and runtime settings surfaces are founder-build gated and fail closed.
- Permission copy must not surface raw "YOLO", bypass, no-sandbox, or dangerous CLI wording to users. Technical persisted mode IDs remain for compatibility, but labels render as safe operational language.
- The release gate must block stale macOS updater metadata. `latest-*-mac.yml` is verified against final DMG/ZIP bytes before ship, preventing pre-staple hashes from reaching R2.
- Renderer-declared Command EVE runtime IPC channels must stay registered in the active Electron app entrypoint.

## Parked For Later

- Goal progress HUD and full autonomous loop UI.
- xAI/Grok image, video, TTS, and "Smart Plus" model productization.
- Full artifact gallery across image/video/audio/HTML/table/file/report.
- Granular privacy tab with local/EU/US/DE inference routing matrix.
- Remote Hermes/orchestrator hosting, debit card, phone, mail, and paid external account gates.
- Skill marketplace / Nous skill-library harvesting.

## Verification Commands

Run from the repo root:

```bash
bunx vitest run \
  tests/unit/command-eve/runtimeBootstrapCore.test.ts \
  tests/unit/command-eve/assistantBootstrap.test.ts \
  tests/unit/command-eve/commandCenterFounderGate.dom.test.tsx \
  tests/unit/command-eve/eveRuntimePublicGate.dom.test.tsx \
  tests/unit/command-eve/runtimeBridgeRegistration.test.ts \
  tests/unit/renderer/messageMerging.dom.test.tsx \
  tests/unit/conversation/runtime/acpStreamWatchdog.test.ts \
  tests/unit/renderer/utils/teamAgentTypePolicy.test.ts \
  tests/unit/renderer/useAutoTitle.dom.test.ts \
  tests/unit/scripts/afterAllArtifactBuild.test.ts

node --test scripts/fetch-bundled-skills.test.mjs
node --test scripts/release/verify-mac-update-feed-core.test.mjs
node --test scripts/release/release-gate-aggregator-core.test.mjs
node scripts/check-i18n.js
bunx tsc --noEmit --pretty false
bun run lint
```

Before the final release build:

```bash
bun run package
bunx playwright test tests/e2e/cases/teams/team-whitelist.e2e.ts --workers=1
node scripts/release/verify-no-private-keys.mjs
node scripts/release/verify-notarization-stapled.mjs --help
node scripts/release/verify-mac-update-feed.mjs --help
```

The actual notarized DMG build and R2 upload can take 30+ minutes. Do not treat a long-running upload/notarization step as stuck before checking process output and elapsed time.

## Current Gate Results

- PASS: version-truth sources report 1.7.91 (`package.json`, runtime bootstrap release, capability-pack release, shell `COMMAND_EVE_VERSION`) and are pinned by `runtimeBootstrapCore.test.ts`.
- PASS: targeted unit suite: 5 files, 89 tests.
- PASS: TypeScript: `bunx tsc --noEmit --pretty false`.
- PASS: source build smoke: `bun run package`.
- PASS: `git diff --check`.
- WARN: full `bun run lint` is blocked by pre-existing repo-wide oxlint debt outside this slice (for example `egressBoundaryCore.ts` regex escapes and older runtime/test warnings). The two newly added/changed small release tests pass targeted oxlint.
- DEV-HARNESS BLOCKED: `bun run test:e2e:team:whitelist` in dev mode starts the incomplete-installation screen because the dev Electron launch sees packaged-resource markers without bundled AionCore. Re-run the whitelist E2E in packaged mode after the notarized build exists.
