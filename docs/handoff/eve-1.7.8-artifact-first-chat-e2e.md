# Command EVE 1.7.8 — Artifact-first Chat + E2E Isolation Handoff

Date: 2026-07-08
Branch: `houston/v16-onboarding`

## Outcome

1. EVE/Hermes now receives an app-owned always-on managed skill:
   `eve-artifact-first-contract`.
   This is separate from the opt-in `session-1-artefakt` menu. The rule is:
   any generated work product must be surfaced as a visible chat artifact even
   when the operator did not explicitly ask for an artifact.

2. Chat artifacts render the expected work-product surfaces:
   image, video, audio, sandboxed HTML, and markdown file/report content.
   Markdown artifacts now render tables and code blocks instead of raw plain
   text only.

3. The Registration E2E flake was traced to an E2E isolation issue, not a
   product gate regression. The shared Electron fixture keeps a dev app alive
   with `COMMAND_EVE_REGISTRATION_REQUIRED=0`; the dedicated registration spec
   launches its own gated app. On macOS, two live dev apps can race over the
   same CLI-safe `.command-eve-dev-2` symlink. The registration proof now closes
   the shared Electron app before launching its own gated app.

## Verification

- `bunx vitest run tests/unit/command-eve/startscreenNoteSlice.test.ts tests/unit/command-eve/artifactContractCore.test.ts tests/unit/renderer/messageList.dom.test.tsx --pool forks --maxWorkers=1`
  - 3 files, 40 tests passed.
- `bunx vitest run tests/unit/command-eve/multimodalRoutePolicyCore.test.ts tests/unit/command-eve/eveMultimodalTtsClientCore.test.ts tests/unit/command-eve/eveMultimodalTtsStatusBridge.test.ts tests/unit/command-eve/voicePolishCore.test.ts tests/unit/command-eve/videoCostCore.test.ts --pool forks --maxWorkers=1`
  - 5 files, 81 tests passed.
- `bunx tsc --noEmit --pretty false`
  - Passed.
- `bun run package`
  - Passed. Only known Vite dynamic-import/chunk warnings.
- `bunx playwright test --config playwright.config.ts tests/e2e/specs/command-eve-product-readiness.e2e.ts tests/e2e/specs/command-eve-local-runtime.e2e.ts tests/e2e/specs/command-eve-default-surface-inventory.e2e.ts tests/e2e/specs/command-eve-settings-surfaces.e2e.ts tests/e2e/specs/command-eve-skill-library.e2e.ts tests/e2e/specs/command-eve-command-center.e2e.ts tests/e2e/specs/command-eve-kanban-board.e2e.ts tests/e2e/specs/command-eve-registration-gate.e2e.ts --reporter=list --workers=1`
  - 19 tests passed.
- `git diff --check`
  - Passed.
- GitNexus `detect_changes(scope=all)`
  - Risk: medium. Affected process: `MessageGeneratedArtifact -> ReadString`.

## Notes For Next Slice

- Do not change `getCommandEveEnvSuffix` / `getCommandEveCliSafeName` lightly.
  GitNexus reported CRITICAL blast radius because these paths touch storage,
  migration, bridge, and runtime roots.
- For E2E suites that need a dedicated Electron process with different global
  env flags, close the shared fixture app first via
  `closeSharedElectronAppForIsolatedSpec()`.
