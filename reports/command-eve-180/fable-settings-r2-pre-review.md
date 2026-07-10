# Command EVE 1.8.0 — R2 Settings Migration: Implementation Contract (Fable 5, read-only pre-review)

## Context

R1 (commit 597c185d) landed the global visual rails: eve tokens/primitives in `command-eve-visual.css`, arco-override rework, AionModal/AppLoader theming, and — already inside R2 territory — the settings sider/mobile-nav migration onto `eve-row`/`--eve-shell-*`. This contract grounds the R2 settings sweep against current code + the routes-r1 light/dark screenshot matrix. Evidence markers: FACT(file:line) = read directly; INFERENCE = derived from adjacent evidence; HYPOTHESIS = unverified. Behavior rule interpretation: "byte-identical behavior" = no IPC/schema/persistence/logic changes; rendered copy, class names, and one selection-predicate bug fix are the deliberate visual deltas and are called out below.

## Scope and freeze

- **Frozen (do not edit):** `ExtensionSettingsPage.tsx`, `hooks/system/useExtensionSettingsTabs.ts`, `WebviewHost`, `extensionMessageBoundary`, `contents/ExtensionSettingsTabContent.tsx` — FACT(Router.tsx:166) `/settings/ext/:tabId` internals. The nav _anchoring_ code in SettingsSider/SettingsPageWrapper/SettingsModal is design-system-owned and editable. Also frozen: anything the parallel bugfix worktree owns.
- **Shared-surface caveat:** `ModelModalContent`, `WebuiModalContent`, `SystemModalContent`, `AboutModalContent`, `AgentModalContent`, `AccountModalContent`, `BillingModalContent`, `ToolsModalContent` render in BOTH `/settings/*` pages and `SettingsModal` (FACT SettingsPageWrapper.tsx:208 `value='page'` / SettingsModal/index.tsx:402 `value='modal'`). Every edit there must be screenshot-verified on both surfaces. Page-only: `AppearanceModalContent`, `ErsteSchritteModalContent`, `CompanyBrainModalContent`.
- **Founder gating changes priorities:** FACT(EveRuntime/index.tsx:97-115) the "Assistenten" and "Agenten & Belegschaft" tabs are gated by `useCommandEveFounderBuild()`. Everything inside `WorkerAssignmentCard.tsx`, `HumanGateDisplay.tsx`, `AssistantEditDrawer.tsx`, `AgentSettings/LocalAgents.tsx` is founder-only → P2, not P0.

## (1) Safe sequence — one commit per step, screenshot diff after each

**Step 1 — Sider selection bug (1 line, do first, isolated commit).**
FACT(SettingsSider.tsx:258) `isSelected = pathname.includes(item.path)` → on `/settings/eve-runtime` the `runtime` item also matches ("Diagnose" + "EVE-Runtime" both highlighted; visible in both screenshot modes). Mobile nav is immune (FACT SettingsPageWrapper.tsx:213 prefixes `/settings/`). Fix: boundary-safe match on `/settings/${item.path}` (exact segment). This is the one deliberate behavior-visible fix; call it out in the commit message.

**Step 2 — SettingsPageWrapper adoption (structural, before any styling of those pages).**

- `pages/connectorCatalog/index.tsx` — FACT(:565-586) hand-rolled scroll root + `max-w-1120px` column + raw `<header><h1>` (`text-28px font-700 text-t-primary`). Wrap in `SettingsPageWrapper`, convert header to `eve-page-header`/`eve-page-title`/`eve-page-subtitle` (keep refresh Button + read-only Tag as header actions).
- `pages/localRuntime/index.tsx` — FACT(:387-402) own scroll root with **opaque `bg-bg-1`** (breaks the transparent shell contract), `max-w-1280px`. Same conversion; drop `bg-bg-1`.
- Known deltas: max-width narrows to 1024px; wrapper owns scroll; mobile top-nav appears on these routes (desired). Verify `/connectors` and `/runtime` legacy redirects (FACT Router.tsx:174,176) and deep links after adoption.

**Step 3 — Public copy / path redaction (P0 leaks; renderer-side only).**
See section (3). Do this before de-nesting so screenshots of the flattened pages are final-copy.

**Step 4 — Per-page de-nesting + color remap, one page per commit, in this order (public first, blast-radius-aware):**

1. eve-runtime (public Orchestrierung tab + DeinTeamPanel)
2. billing (shared with modal)
3. model (shared with modal)
4. capabilities/SkillsHub
5. erste-schritte
6. account (shared), company-brain
7. webui (shared)
8. connectors + runtime content polish (after Step 2 shell)
9. P2 founder-gated surfaces (WorkerAssignmentCard, HumanGateDisplay, AssistantEditDrawer, LocalAgents)

`pet`, `privacy`, `system`, `appearance`, `about` are already contract-clean (screenshot + code agree) — do not touch except the Gemma copy notes below.

GitNexus: run `gitnexus_impact` before editing shared symbols (`getBuiltinSettingsNavItems`, `DeinTeamPanel`, each `*ModalContent`), `gitnexus_detect_changes` before each commit.

## (2) SettingsPageWrapper adoption verdict

- **Adopt:** `connectorCatalog/index.tsx`, `localRuntime/index.tsx` (the only two `/settings/*` routes bypassing it — FACT from route map Router.tsx:143-167).
- **Already adopted (leave):** all 15 other settings pages + `ExtensionSettingsPage` (frozen).
- **Do not add a header prop to the wrapper**; use the existing `eve-page-header` primitives (FACT command-eve-visual.css:312-341) inline per page — matches how rebuilt pages already compose.

## (3) Exact nested-card removals and copy/path leaks

### Nested-card removals (public)

| Page               | Chain (FACT)                                                                                                                           | Fix                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eve-runtime        | index.tsx:91 `<section rounded-16px bg-bg-2>` → DeinTeamPanel RoleCard Arco `<Card>` :247 per role                                     | Drop the :91 section chrome; RoleCard → flat `eve-row`-style rows or `eve-settings-group` dividers, one surface level                                     |
| eve-runtime        | index.tsx:80-90 "Dein Team" h2+subtitle AND DeinTeamPanel.tsx:418-424 own "Dein Team" heading + near-duplicate paragraph               | Remove the panel-internal header (:418-424); keep page-level. Kills the duplicated intro seen in both screenshot modes                                    |
| billing            | BillingModalContent.tsx:168,220,282,306,335,363 — six sibling Arco `<Card>`                                                            | → `eve-settings-group` sections (border-top divider pattern, command-eve-visual.css:343-352)                                                              |
| account            | AccountModalContent.tsx:196,373,405 Cards                                                                                              | same                                                                                                                                                      |
| company-brain      | CompanyBrainModalContent.tsx:445 outer Card wrapping row-list (:489,:628)                                                              | drop outer Card, keep rows                                                                                                                                |
| erste-schritte     | ErsteSchritteModalContent.tsx:130-133 `rounded-14px bg-fill-1` → :147 `rounded-10px bg-fill-2` rows; plus :188-210 hoverable Card grid | flatten status block to one level; step Cards may stay as the single level if the page has no other panel around them — keep onClick navigation           |
| model              | ModelModalContent — runtime panel → 3 bordered model sub-cards (screenshot; verify lines during impl)                                  | one level                                                                                                                                                 |
| capabilities       | SkillsHubSettings.tsx:606,657,848 section cards each containing :621,:743,:866 inner `rd-12px bg-fill-1` cards                         | flatten inner level                                                                                                                                       |
| webui              | WebuiModalContent.tsx:696 login card → :702,:730 pills → :754 QR container → :760 `bg-white`                                           | flatten one level; **keep white behind the QR code** — QR quiet-zone contrast is functional; document as sanctioned literal (or a `--static-white` token) |
| runtime (Diagnose) | region → Runtime-Wahrheit card + model cards + Kanban card + banner (screenshot)                                                       | one level, `eve-settings-group`                                                                                                                           |
| connectors         | page panel → connector card → "Letzter Preflight" + "Geführter Setup-Pfad" sub-cards (screenshot, 3+ deep)                             | connector = one `eve-panel--solid`; sub-sections become plain groups                                                                                      |

Founder-only (P2): WorkerAssignmentCard.tsx:131→:167/:151; HumanGateDisplay.tsx:65→:82→:84 (3-deep); LocalAgents.tsx:143→:154→:156 (3-deep).

### Copy / internal-path leaks (public)

- **connectors:** absolute paths rendered at index.tsx:605-606 (`Manifest: …`, `Company.OS Root: /Users/…`) and :337 (`preflight_result_file`). Fix renderer-side: founder-gate the raw-path rows via `useCommandEveFounderBuild` (exists, already imported elsewhere) or show basename only. Internal state slugs rendered verbatim (`LOCAL_COMPANY_OS_WORKSPACE_READY`, `PREFLIGHT_CONNECTED_VIEW_ONLY`, `AUTH_REQUIRED_BEFORE_PREFLIGHT`, `HUMANGATE_AND_PREFLIGHT_REQUIRED`, `operator_shell_prepare`, `HG-1/HG-2`, `State Authority: local-preflight-result-files-only`) → humanized i18n labels; raw value may remain in founder mode/tooltip.
- **connectors card title "AionUI + Hermes Runtime" / slug `aionui-hermes-runtime`:** the string exists nowhere in repo source (only license headers) — INFERENCE: data-driven from the on-disk Company.OS manifest. Fix = render-time display mapping (renderer or a display override in `connectorCatalogCore.ts`/`curatedConnectorReference.ts`); **never** touch the slug/ID — it feeds preflight matching (R1 trap #10).
- **runtime (Diagnose):** `EVE Runtime (Hermes)`, `hermes-agent 0.17.0` (×2), `Provider ollama`, Ollama/Egress URLs, gemma model IDs, kanban.db + reconciliation absolute paths (screenshot both modes). Recommend: founder-gate raw identifiers/paths; keep humanized status public. ADJUDICATION-1 (see below).
- **erste-schritte:** "z. B. deine Claude-CLI" — FACT(ErsteSchritteModalContent.tsx:54 fallback) + locale key de-DE/settings.json:1100 (and siblings in all locales). → "deine eigene Entwickler-CLI".
- **DeinTeamPanel.tsx:106-109 (public!):** lane tag title "Läuft auf deinem eigenen Claude-Abo…" and label "Abo-Lane" hover — → provider-neutral ("dein eigenes CLI-Abo"). New finding, not in R1 report.
- **model:** banner "Command EVE nutzt EVE Runtime lokal über Ollama/Gemma" + `custom:command-eve-gemma4-e4b-64k:latest` IDs. ADJUDICATION-1 (same provider-exposure decision as R1's artifact question).
- **system/privacy:** "Gemma"/"EVE Runtime" name bleed; privacy names Sentry + "Command-EVE-Server-Gateway und das Release-Gate". Recommend **keep Sentry** (transparency/legal disclosure) — ADJUDICATION-2.
- **Locale sweep (bounded):** only keys consumed by R2 pages — de-DE/settings.json:115 (AionUI Systemskills), :509 + :632 (KI-Shell), :1100 (Claude-CLI); en-US/settings.json:94, :597-598, :655 (`appDescription` "GUI app for Gemini CLI" — About page), de-DE/cron.json:55,:58 (KI-Shell — scheduled page, R3 but trivial to include); mirror across all 10 locales for those keys only. Run `bun run i18n:types` + `node scripts/check-i18n.js`.
- **Leave alone:** AboutModalContent 'AionUi' fallback — already flag-guarded by `COMMAND_EVE_SHELL_ENABLED` (FACT :110); internal event names (`aionui-open-update-modal`, `aionui:speech-to-text-…`) are not UI. Wiki links to `iOfficeAI/AionUi` (WebuiModalContent:681, ToolsModalContent:893/905, RemoteAgentManagement:35) = P2 ADJUDICATION-3.

## (4) Semantic color fixes

| Site (FACT)                                    | Today                                                                                                                                                                                                                                                               | Target                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| SkillsHubSettings.tsx:178-179                  | avatar `#722ED1` purple / `#F5319D` pink (+ :174-181 raw hexes)                                                                                                                                                                                                     | token-based palette: blue/teal/green/brand only                                              |
| SkillsHubSettings.tsx:193 → Tag :772           | `'purple'` for prompt_label                                                                                                                                                                                                                                         | `'arcoblue'`/gray                                                                            |
| SkillsHubSettings.tsx:550                      | `rgba(var(--purple-6),…)` "Von EVE gelernt" badge                                                                                                                                                                                                                   | blue interaction tokens                                                                      |
| SkillsHubSettings.tsx:194                      | `'orange'` for gated                                                                                                                                                                                                                                                | gray (neutral status; orange is brand-only)                                                  |
| CompanyBrainModalContent.tsx:510,646           | `color='purple'` "von EVE" Tags                                                                                                                                                                                                                                     | `'arcoblue'` or gray                                                                         |
| ErsteSchritteModalContent.tsx:42-46 → Tag :202 | `attention → 'orange'` "offen" pill                                                                                                                                                                                                                                 | gray; also fix casing "offen" vs "öffnen" inconsistency                                      |
| DeinTeamPanel.tsx:87                           | `paused: 'orange'` status tag                                                                                                                                                                                                                                       | gray                                                                                         |
| DeinTeamPanel.tsx:263                          | `consumesCredits ? 'orange'` tier tag                                                                                                                                                                                                                               | gray/neutral                                                                                 |
| DeinTeamPanel.tsx:174                          | `Button status='warning'` (orange) for Pausieren/Entlassen                                                                                                                                                                                                          | `status='default'`; the Popconfirm already carries the warning semantics                     |
| ModelModalContent                              | orange "EVE Runtime + Ollama" pill; orange "Läuft nicht auf diesem Mac" + orange-bordered button (screenshot)                                                                                                                                                       | neutral pill; danger/gray for unavailable                                                    |
| localRuntime                                   | purple "Pro" pill (Gemma 31B card) — the only clear purple in the matrix; orange "Optional" pill                                                                                                                                                                    | blue "Pro"; gray "Optional"                                                                  |
| connectors                                     | orange pills: `MCP Enable: Blockiert`, `10 Gated`, `Noch nicht verbunden`, HG-tags                                                                                                                                                                                  | gray/danger per severity — never green-wash gated/auth states (R1 gate)                      |
| billing.css:86-87                              | indigo `#4f46e5` / `#eef2ff` fallbacks                                                                                                                                                                                                                              | `--primary-*` tokens; sweep remaining hex fallbacks (:17,:29,:38,:56,:80,:91,:111,:159,:204) |
| ToolsSettings/McpServerHeader.tsx:37           | `text-orange-500` warning △                                                                                                                                                                                                                                         | warning token                                                                                |
| OneClickImportModal.tsx:436,440                | `fill='#165dff'`                                                                                                                                                                                                                                                    | `var(--primary-6)` equivalent                                                                |
| P2 founder-gated                               | LocalAgents.tsx:154-156 `rgba(255,122,31,…)`+`#ff7a1f` literals (brand orange as literal); AssistantEditDrawer.tsx:487,585 `rgba(242,156,27,…)` orange Custom badge; WorkerAssignmentCard.tsx:277-295 hex fallbacks                                                 | tokenize                                                                                     |
| Not a bug                                      | ProjectedSpendMeter.tsx:72 uses `rgb(var(--danger-6))` when over budget — semantic already. **Do not "fix"**                                                                                                                                                        | keep                                                                                         |
| Out of R2                                      | orange `⌘` toolbar glyph on every route (shell); capabilities ACTIVE/AVAILABLE periwinkle pills (verify = arcoblue, likely compliant); webui third-party channel logos + AddPlatformModal.tsx:31-34 provider brand hexes (legit third-party marks — ADJUDICATION-3) | note only                                                                                    |

Raw HTML → Arco (public P1): SkillsHubSettings.tsx:668,686,696,712,799; WebuiModalContent.tsx:651,658,677,787,796; CompanyBrainModalContent.tsx:497,636; ErsteSchritteModalContent.tsx:155 (`<a onClick>`); BillingModalContent.tsx:390-391 (`<label>`+`<input type='file'>` → Arco Upload trigger, keep upload behavior); AddPlatformModal.tsx:130. P2: channel `*ConfigForm` buttons, AssistantEditDrawer:552,593.

## (5) Required tests / states

- **Unit (vitest):** new test for sider selection predicate (`/settings/eve-runtime` selects only eveRuntime; `/settings/runtime` only runtime); status→color map tests for the remapped tags; existing DeinTeam floor-guard/budget suites must stay green untouched.
- **Screenshot matrix (routes-r2):** all 15 settings routes × light/dark; PLUS SettingsModal tabs (Model/Agent/Tools/Webui/System/About/Account/Billing) × light/dark — shared-content regression; re-capture billing full-page (Report-Branding section was cut off in routes-r1 — unreviewed).
- **Zoom:** 200% max-font German on erste-schritte and eve-runtime (densest, per R1).
- **Mobile 390px:** settings mobile top-nav on connectors + runtime after wrapper adoption (new surface), plus one already-wrapped page as control.
- **Reduced effects/transparency:** spot-check two settings pages (`data-eve-reduced-effects` path, command-eve-visual.css:473-539).
- **Behavior gates:** `/connectors`, `/runtime`, `/skills`, `/team-roster` redirects; capabilities `?tab=` deep links; extension tab anchoring (sider + wrapper + modal) unchanged; billing logo upload; erste-schritte step navigation; DeinTeam pause/hire actions + Popconfirm flows (unchanged semantics); QR code scannability on webui after restyle.
- **Pipeline:** `bun run lint:fix`, `bun run format`, `bunx tsc --noEmit`, `bun run i18n:types` + `node scripts/check-i18n.js` (copy changes), targeted vitest, `just push`; GitNexus impact/detect_changes per repo rules.

## (6) Issues Codex missed (net-new vs R1 report)

1. **Sider double-highlight substring bug** — FACT(SettingsSider.tsx:258); survived/introduced in R1's own sider migration.
2. **Founder gating reprioritizes R1's list:** WorkerAssignmentCard/AssistantEditDrawer "Claude"/`/usr/local/bin/claude` leaks are founder-only (FACT EveRuntime/index.tsx:97-115) → P2, while the _public_ leak is DeinTeamPanel.tsx:106-109 "Claude-Abo" hover, which R1 missed.
3. **Duplicate "Dein Team" intro is a composition bug** (page header at index.tsx:80-90 + panel-internal header at DeinTeamPanel.tsx:418-424), not duplicated copy in one file — fix by deleting the internal header, not the i18n string.
4. **"AionUI + Hermes Runtime" cannot be fixed by a repo string edit** — data-driven from on-disk manifest; needs a display-name mapping layer.
5. **ProjectedSpendMeter is already semantic** (`--danger-6`); the screenshot "orange cost" is compliant — a naive orange-sweep would wrongly neutralize a correct danger signal.
6. **Pink `#F5319D`** avatar color (R1 caught it, but note it renders live via name-hash — any user can hit purple AND pink avatars).
7. **CompanyBrainModalContent purple "von EVE" Tags** (:510,:646) — absent from the R1 findings.
8. **Webui QR `bg-white` is functionally required** (quiet zone) — must be a documented exception, not removed.
9. **billing routes-r1 screenshot is truncated** — Report-Branding section never visually reviewed; capture full-page in R2 gates.
10. **`/settings/about` reuses SystemSettings** (FACT Router.tsx:164) — About copy fixes ride the system page; don't double-fix.

## Adjudication items (do not block P0; founder/Codex decision)

- **ADJUDICATION-1:** provider/model exposure (Ollama/Gemma/hermes-agent/model IDs) on model + runtime pages — recommend founder-gate raw identifiers, keep humanized "Lokales Modell" public. Same decision family as R1's artifact provider/model question.
- **ADJUDICATION-2:** privacy page Sentry mention — recommend keep (honest disclosure).
- **ADJUDICATION-3:** third-party marks (channel logos, provider hexes) + `iOfficeAI/AionUi` wiki links — recommend keep marks, retarget or founder-gate wiki links.

## Priorities

- **P0:** Step 1 sider fix; Step 2 wrapper adoption (connectors, runtime); public path/name redaction on connectors + runtime; purple/pink removal (SkillsHub :178-179/:193/:550, CompanyBrain :510/:646, localRuntime Pro pill); "Claude-CLI" copy (erste-schritte + locale keys); "Claude-Abo" lane copy (DeinTeamPanel:106-109).
- **P1:** per-page de-nesting (eve-runtime incl. duplicate-header removal, billing, model, capabilities, erste-schritte, account, company-brain, webui, connectors/runtime content); orange status remaps (all table rows above); raw HTML → Arco on public pages; internal-slug humanization; billing.css indigo.
- **P2:** founder-gated surfaces (WorkerAssignmentCard, HumanGateDisplay, AssistantEditDrawer, LocalAgents); hex-fallback sweeps; wiki links; channel form buttons; McpServerHeader triangle; adjudication follow-ups.

## Acceptance gates

- **G1 (color):** `rg` clean under `pages/settings/`, `components/settings/SettingsModal/contents/`, `components/team/` for `color='purple'|'pink'`, `#722ED1|#F5319D|#4f46e5`, `color='orange'` and `status='warning'` on non-brand elements — sanctioned exceptions (QR white, third-party marks) listed in a lint-allowlist comment.
- **G2 (leaks):** no `/Users/`, no `Company.OS`, no `hermes|Hermes|AionUI|Claude|Gemma|Ollama|kanban.db` rendered on any public (non-founder) settings route — verified via the routes-r2 screenshot matrix + grep of rendered i18n keys.
- **G3 (one panel level):** every settings route shows ≤1 nested rounded/bordered surface inside the wrapper — screenshot checklist per page.
- **G4 (selection):** exactly one highlighted sider item on every route, incl. eve-runtime vs runtime — unit test + screenshot.
- **G5 (shared-surface parity):** SettingsModal tab screenshots show only intended changes.
- **G6 (behavior):** full vitest green; no IPC/schema/persistence diffs (`gitnexus_detect_changes` scope check per commit); redirects + deep links + extension anchoring + upload/QR flows verified.
- **G7 (pipeline):** tsc, lint, format, i18n checks clean; `just push` green.

SETTINGS_PRE_REVIEW_COMPLETE
