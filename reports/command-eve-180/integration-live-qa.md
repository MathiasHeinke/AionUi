# Command EVE 1.8.0 Integration Live QA

Date: 2026-07-10
Integration commit: `52dac388`
Runtime base: `1c6716a3`
Design head: `57df4290`

## Result

The integrated design/runtime baseline is fit to continue into packaged QA.
No renderer crash, console error, page error, failed request, public CLI identity
leak, or horizontal document overflow was observed during the live Electron run.

The broad GitNexus change set is classified `CRITICAL` because it spans 73
files and 40 execution flows. The shared runtime symbols reviewed individually
(`AionModal`, `GuidPage`, `SettingsPageWrapper`, and `handleSend`) are all
`LOW` risk. This integration therefore relies on the expanded automated and
live verification below rather than the aggregate graph label alone.

## Verification

| Gate | Result | Evidence |
| --- | --- | --- |
| Command EVE focused test suite | PASS | 170 files, 2,242 tests |
| Renderer/settings/theme suite | PASS | 89 files, 591 tests |
| TypeScript | PASS | `bunx tsc --noEmit -p tsconfig.json` |
| i18n consistency | PASS | `node scripts/check-i18n.js` (existing warnings only) |
| Desktop settings routes | PASS | 15/15 active route, 0 px document overflow, 0 public CLI identity leaks |
| Mobile settings routes | PASS | 15/15 active pill visible, 0 px document overflow |
| Team creation | PASS | Only Command EVE is selectable; real EVE logo; 0 internal CLI names |
| About update action | PASS | Opens the update modal and reports current state |
| Prompt icon/text rhythm | PASS | 15.5 px measured icon-to-text gap on all three prompt rows |
| Renderer runtime errors | PASS | 0 console errors, 0 page errors, 0 request failures |
| Local EVE inference transport | PASS | UI send, warm-up, persistence, response, and `finished` status in 233.5 seconds |
| Local EVE instruction adherence | FAIL | Local model ignored the exact-output instruction and returned onboarding copy |
| Open-view completion reconciliation | FAIL | Finished turn remained visually streaming until conversation remount |
| Cloud inference | NOT RUN | Dev profile intentionally had no CEVE license bearer credential |
| Packaged E2E | PENDING | Run after the parallel runtime worktree is committed and integrated |

## Evidence

- Route matrix: `integration-settings-live-audit.json`
- Renderer errors: `integration-renderer-console-audit.json`
- Local inference record: `integration-local-inference-live.json`
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
