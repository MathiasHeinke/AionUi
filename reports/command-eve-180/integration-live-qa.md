# Command EVE 1.8.0 Integration Live QA

Date: 2026-07-10
Integration commit: `52dac388`
Runtime base: `1c6716a3`
Design head: `57df4290`
Post-audit hotfix: working tree after `8eedc09a`

## Result

The integrated design/runtime baseline is fit to continue into packaged QA.
No renderer crash, console error, page error, failed request, public CLI identity
leak, or horizontal document overflow was observed during the live Electron run.

The broad GitNexus change set is classified `CRITICAL` because it spans 73
files and 40 execution flows. The shared runtime symbols reviewed individually
(`AionModal`, `GuidPage`, `SettingsPageWrapper`, and `handleSend`) are all
`LOW` risk. This integration therefore relies on the expanded automated and
live verification below rather than the aggregate graph label alone.

Fable 5 High completed a 13m40s post-merge audit with three read-only
workers. It reported no P0/P1 defect and eight P2 findings. The user-facing,
bounded-runtime, regression-coverage, and accessibility findings were fixed in
the integration working tree; the packaged modal sweep remains part of the
final combined-artifact gate.

## Verification

| Gate                                | Result  | Evidence                                                                                   |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| Full repository Vitest matrix       | PASS    | 398 files passed, 1 skipped; 3,855 tests passed, 3 skipped                                 |
| Command EVE focused test suite      | PASS    | 170 files, 2,242 tests                                                                     |
| Renderer/settings/theme suite       | PASS    | 89 files, 591 tests                                                                        |
| TypeScript                          | PASS    | `bunx tsc --noEmit -p tsconfig.json`                                                       |
| i18n consistency                    | PASS    | `node scripts/check-i18n.js` (existing warnings only)                                      |
| Desktop settings routes             | PASS    | 15/15 active route, 0 px document overflow, 0 public CLI identity leaks                    |
| Mobile settings routes              | PASS    | 15/15 active pill visible, 0 px document overflow                                          |
| Light desktop settings routes       | PASS    | 15/15 routes, correct light theme, 0 px document overflow, 0 public CLI identity leaks     |
| Light mobile settings routes        | PASS    | 15/15 routes, active pill visible, 0 px document overflow                                  |
| Visible control names               | PASS    | 17 live surfaces, 0 visible unnamed buttons or switches after the appearance-switch hotfix |
| Team creation                       | PASS    | Only Command EVE is selectable; real EVE logo; 0 internal CLI names                        |
| About update action                 | PASS    | Opens the update modal and reports current state                                           |
| Prompt icon/text rhythm             | PASS    | 15.5 px measured icon-to-text gap on all three prompt rows                                 |
| Renderer runtime errors             | PASS    | 0 console errors, 0 page errors, 0 request failures                                        |
| Local EVE inference transport       | PASS    | UI send, warm-up, persistence, response, and `finished` status in 233.5 seconds            |
| Local EVE instruction adherence     | FAIL    | Local model ignored the exact-output instruction and returned onboarding copy              |
| Open-view completion reconciliation | FAIL    | Finished turn remained visually streaming until conversation remount                       |
| Cloud inference                     | NOT RUN | Dev profile intentionally had no CEVE license bearer credential                            |
| Packaged E2E                        | PENDING | Run after the parallel runtime worktree is committed and integrated                        |

## Fable P2 Hotfixes

- Primary EVE conversation-create failures now show provider-neutral feedback
  and preserve the draft, files, and selected directory.
- OpenClaw/Nanobot fallback branches no longer contain raw `alert()` messages
  or expose internal runtime names.
- Local-runtime pull polling keeps the intended long-running install window but
  stops after 60 minutes instead of polling forever; warm-up polling remains
  capped separately.
- Local-runtime asynchronous loads ignore late results after unmount.
- The About update action now has direct click-through E2E coverage.
- Shared preference switches derive an accessible name from their visible row
  label; icon-only controls and appearance switches have explicit names.
- Focused post-audit regression suite: 8 files, 25 tests, all passing,
  including rendered founder-gating coverage for the public local-runtime view.
- The visual-preference hydration test now waits for the CSS projection effect,
  removing a full-suite timing race without changing product behavior.

## Evidence

- Route matrix: `integration-settings-live-audit.json`
- Light route matrix: `integration-settings-light-live-audit.json`
- Accessibility matrix: `integration-accessibility-live-audit.json`
- Renderer errors: `integration-renderer-console-audit.json`
- Local inference record: `integration-local-inference-live.json`
- Fable post-merge audit: `fable-integration-post-audit.md`
- Live screenshots: `screenshots/integration-live/`
- First integrated start screen: `screenshots/integration-start.png`

## Follow-up Contract

### 1.8.1 - local instruction-adherence gate

- Re-run a deterministic exact-output prompt against every supported local tier.
- Score exact match separately from transport completion.
- Keep Gemma unreliability visible; do not silently convert a quality failure
  into a runtime pass.

### 1.8.1 - completion reconciliation

- Reproduce a turn where the backend reaches `finished` while the open renderer
  still shows `Antwort streamt`.
- The renderer must reconcile to idle without navigation or remount.
- Acceptance: status strip reads `EVE bereit`, send controls are enabled, and no
  local streaming timer remains within five seconds of backend completion.

## Remaining Release Gate

Do not package or notarize from this commit alone. First integrate the parallel
runtime worktree as an explicit commit, re-run the complete automated suites,
build the app, execute packaged E2E, and repeat the live model/UI matrix on the
final combined artifact.
