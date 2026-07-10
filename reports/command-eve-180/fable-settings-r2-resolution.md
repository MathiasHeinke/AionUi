# Command EVE 1.8.0 - Fable R2 post-review resolution

Source audit: `fable-settings-r2-post-review.md`

Completion sentinel: `SETTINGS_R2_POST_REVIEW_COMPLETE`

Final Fable 5 High fix verification: all six rows passed with no fix-induced regression.

Final verification sentinel: `SETTINGS_R2_FIX_VERIFY_COMPLETE`

## Resolved findings

- **P0 light evidence:** invalid P0 light captures were removed and P1 was recaptured through the production `applyTheme` writer. Every capture asserted `html[data-theme] === body[arco-theme]`; the corrected light screenshots no longer contain dark Arco tokens on a light shell.
- **P1 public skill slugs:** EVE team roles, outcomes, controls, budget copy, and skill labels now use the `deinTeam` de-DE/en-US namespace. Unknown skills render a neutral localized fallback.
- **P1 projected-cost clipping:** the total is non-shrinking and no-wrap, while the label may wrap. The full `200 EUR / 60 EUR` value is visible in light and dark screenshots.
- **P1 guided-auth dead end:** founder receipt setup remains founder-only. Public users receive an honest non-action status instead of a permanently disabled setup flow.
- **P1 raw toasts:** connector success and failure messages are localized; raw bridge messages and reason codes remain founder-only.
- **P1 manifest fallbacks:** unknown local tiers and receipt states render neutral localized fallbacks instead of dynamic i18n keys or model identifiers.

## Evidence

- `reports/command-eve-180/screenshots/routes-r2/p1/settings-connectors-dark-p1.png`
- `reports/command-eve-180/screenshots/routes-r2/p1/settings-connectors-light-p1.png`
- `reports/command-eve-180/screenshots/routes-r2/p1/settings-connectors-mobile-dark-390-p1.png`
- `reports/command-eve-180/screenshots/routes-r2/p1/settings-runtime-dark-p1.png`
- `reports/command-eve-180/screenshots/routes-r2/p1/settings-runtime-light-p1.png`
- `reports/command-eve-180/screenshots/routes-r2/p1/settings-eve-runtime-dark-p1.png`
- `reports/command-eve-180/screenshots/routes-r2/p1/settings-eve-runtime-light-p1.png`

## Verification

- Targeted Vitest: 79/79 passed.
- TypeScript: clean.
- Oxlint: clean.
- Desktop public-name scan: no AionUI, Company.OS, Hermes, Claude, Codex, Gemma, Ollama, `kanban.db`, Preflight, Receipt, MCP, Dispatcher, or raw skill slugs.
- Mobile connector route: `scrollWidth === clientWidth === 390`, exactly one active settings route.
