# Command EVE 1.8.0 R2 — Settings P1 Post-Build Audit (read-only)

## Context

Audit of the uncommitted diff after bc58b27d (connectorCatalog + localRuntime public cleanup, locale sweeps, migration-test extension) against `reports/command-eve-180/fable-settings-r2-pre-review.md` and the routes-r2/p1 screenshot evidence. No files edited, no git state changed. Findings verified against code (FACT file:line) and rendered screenshots (FACT screenshot:path).

## Resolution status vs pre-review (what the P1 cleanup actually fixed)

- Wrapper adoption (Step 2): DONE — both pages use `SettingsPageWrapper` (test locks it).
- Path/slug redaction (Step 3): DONE for the two pages — manifest/company-root paths, provider/hermes/ollama/model IDs, kanban db/reconciliation paths, reason codes all founder-gated; public copy humanized; migration test extended with a stricter leak regex (now incl. Preflight/HumanGate/MCP/Dispatcher) — 6/6 tests green; `node scripts/check-i18n.js` passes; locales are only de-DE/en-US per i18n-config, so the 2-locale sweep is complete.
- De-nesting: DONE — connector cards are flat divider rows (`--glass-panel-border` exists), summary cards → flat stat overview, runtime cards → `eve-settings-group`.
- Colors: DONE — state maps are blue/green/red/gray only; "Pro" pill blue, "Optional" gray (screenshots).
- Sider selection: single highlight on all captured routes.
- Duplicate "Dein Team" header: resolved (single header in p1 screenshots).
- 390px: connectors mobile dark is clean (stacked dl, 2-col stats, full-width actions).

## Confirmed findings (P0/P1, ordered by severity)

### P0-1 — All light-mode evidence is invalid: captures show dark-Arco-on-light, so the light contrast gate is unverified
- FACT(screenshot: settings-connectors-light-p1.png, settings-runtime-light-p1.png, settings-eve-runtime-light-p1.png; identical in p0 captures): gray Tags ("Sicherer Modus", "Status", "Status-Hinweis", "Optional", "Noch nicht verbunden", count "14"), default/secondary Buttons ("Aktualisieren", "Sicher verbinden", "Drosseln", "Pausieren") and role skill chips render near-white-on-white; colored tags show dark-palette values. Body text (`html[data-theme]` tokens) is correct → `body[arco-theme]` stayed `dark` while `html[data-theme]` was `light`.
- Root-cause trace (read-only worker): every committed writer sets both attributes together — FACT(applyTheme.ts:39-40); the settings-footer quick toggle routes through `applyTheme` via ThemeContext reconciliation (ThemeContext.tsx:58-62); the boot scripts (index.html:21 html, :42 body) read the same localStorage key. No committed screenshot harness exists for these captures. INFERENCE: the ad-hoc capture step forced `data-theme='light'` (or seeded localStorage without reload) without `applyTheme` — a harness artifact, not an in-app code path.
- Impact: none of the routes-r2 light screenshots (p0 or p1) certify light mode. If light mode really rendered like this it would be a hard blocker; as-is, the visual gate for light theme is simply unfulfilled — you cannot sign off contrast, semantic colors, or copy legibility for light from this evidence.
- Bounded fix: re-capture the light matrix by switching through the real path (AppearanceSettings radio, or `applyTheme(...)`/both attributes in the harness), then re-review light contrast. Optional hardening: assert `body[arco-theme] === html[data-theme]` in the existing e2e (theme-switching.e2e.ts already checks this pattern) or a small runtime invariant.

### P1-1 — Raw English capability slugs on the public EVE-Runtime page
- FACT(DeinTeamPanel.tsx:235-237) `role.skills.map((skill) => <Tag …>{skill}</Tag>)`; FACT(screenshot: settings-eve-runtime-dark-p1.png) "strategy", "planning", "decision-making", "coordination", "delegation", "reporting", "faq", "triage", "local-chat".
- Impact: untranslated internal slugs on the flagship public surface; breaks G2-adjacent copy rules and German-locale polish.
- Bounded fix: map via i18n (`deinTeam.skills.<slug>` with defaultValue = humanized slug), locales de-DE/en-US; extend migration test.

### P1-2 — Projected-cost value clipped at viewport edge on EVE-Runtime
- FACT(screenshot: settings-eve-runtime-dark-p1.png + light): "200€ / 60…" cut mid-string, dividers touch the window edge → the Orchestrierung tab body has no right padding / overflows the wrapper column. FACT(ProjectedSpendMeter.tsx:70-76) renders `{eur(totalEur)} / {eur(hullEur)}`.
- Impact: the budget ceiling — the one number the meter exists to show — is unreadable.
- Bounded fix: restore right padding on the tab content (or `min-w-0` + `pr` on the meter row) in EveRuntime/index.tsx / DeinTeamPanel container; re-capture.

### P1-3 — Public guided-auth flow is a dead end (interaction truth)
- FACT(connectorCatalog/index.tsx:254-258) `canSubmit` requires a non-empty HumanGate receipt; FACT(:435-437 comment) `request_humangate` has no in-app handler, so a public operator can never possess a "Freigabebeleg". The new public modal (this diff) invites the flow ("Sicher verbinden" button, "Freigabebeleg einfügen" placeholder) but cannot be completed; the format hint (`receipt://hg-3/<id>`) was also removed for founder mode.
- Impact: public users hit a permanently disabled confirm with no explanation — violates the "no dead controls" rule the file itself cites.
- Bounded fix: founder-gate the guided-auth button (public gets the existing status-note pattern), or in public mode hide the receipt field and route through the approval flow; keep the receipt-format placeholder in founder mode.

### P1-4 — Hardcoded English toasts + raw reason_code leak in the same flow
- FACT(connectorCatalog/index.tsx:553) `Message.success('Connector credential stored securely.')`; FACT(:557) `Message.error(response.msg || response.data?.reason_code || 'Guided setup failed.')`; FACT(:560).
- Impact: English strings on a German public UI and raw internal slugs (`reason_code`, bridge `msg`) surfaced publicly — the one unredacted outlet left in the flow this diff cleaned.
- Bounded fix: new `connectorCatalog.setupModal.storedSuccess` / `setupFailed` keys (de/en); show raw `msg`/`reason_code` only when `showTechnicalDetails`.

### P1-5 — Manifest-driven i18n keys without defaultValue can leak raw keys
- FACT(localRuntime/index.tsx:211) `t(\`localRuntime.tierDescriptions.${tier.id}\`)` — unlike `tierNames` (:193-195) there is no defaultValue; a new tier id in the on-disk manifest renders `localRuntime.tierDescriptions.gemma-…` verbatim (leaks "gemma", looks broken). Same class: `receiptStatus.${status}` / `receiptNextAction.${status}` (:609-614) trust unvalidated receipt JSON.
- Bounded fix: add `defaultValue` fallbacks (generic public description / status dash); optional unit test asserting fallback.

## Optional polish (not blocking)

- Orphaned locale keys after this diff: `connectorCatalog.values.receiptAvailable/receiptPending`, `connectorCatalog.empty.preflightMissing`, `connectorCatalog.sections.latestPreflight` are no longer referenced — prune in both locales + regenerate types.
- FACT(connectorCatalog/index.tsx:380-383) `<details>/<summary>` raw interactive HTML (founder-only surface) — convert to Arco `Collapse` to satisfy the no-raw-interactive-HTML convention.
- `formatTimestamp` duplicated in connectorCatalog and localRuntime — hoist to a shared util.
- Public credential labels "Zugangsdaten 1/2" are ambiguous for multi-secret connectors (env names hidden in public mode) — if any public connector has ≥2 `env_refs`, show a humanized per-key hint.
- ProjectedSpendMeter/DeinTeamPanel contain hardcoded German UI strings (pre-existing) — en-US users see German; fold into the next i18n sweep.
- `scope: 'founder'` hardcoded in the public guided-auth submit (connectorCatalog/index.tsx:548) — resolves itself if P1-3 founder-gates the flow.

## Verification (for the fix pass)

- Re-run `bun run vitest run tests/unit/theme/commandEveSettingsMigration.test.ts`, `bunx tsc --noEmit`, `bun run i18n:types` + `node scripts/check-i18n.js` after copy fixes.
- Re-capture routes-r2 light matrix after the arco-theme sync fix (this is the gate for P0-1) plus eve-runtime both modes for the meter clip.
- GitNexus `detect_changes` before committing per repo rules.

## Release-blocker verdict

P0-1 (light-mode Arco washout) is the only release blocker: either a real theme-sync bug or invalid light-mode evidence — both block the light-theme gate (G-contrast) until re-verified. Everything else is bounded P1 cleanup; the connector/runtime P1 scope of this diff itself resolves the pre-review findings for those two pages.
