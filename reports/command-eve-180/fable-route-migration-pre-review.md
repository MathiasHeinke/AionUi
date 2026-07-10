# Command EVE 1.8.0 — Public-Route Migration Pre-Build Audit (Fable 5 High, read-only)

## Context

Slice 1.8.0-b/c/d landed (theme kernel, shell, seat rail, footer, composer, Appearance rebuild — verified, do not touch). This audit grounds the remaining slice-e/f work (settings sweep, standalone routes, overlays, artifacts, legacy migration) before Codex implements it. Evidence: 3 read-only code sweeps + full routes-before screenshot review + approved light/dark renders.

## Verdict (short)

Foundation is contract-conformant; remaining work is bounded and mostly mechanical. BUT implementation must start with the **global rails** (arco-override/--aou-*, modal tier, loader, toast, eve-pill blur), because they violate release gates on _every_ route and all later screenshots depend on them. Two content decisions need founder/Codex adjudication before the sweep (artifact provider/model exposure; runtime/connector diagnostics content incl. the literal "AionUI + Hermes Runtime" label). No blocker to starting.

## P0 findings

1. _*--aou-* live on all public routes_*: arco-override.css:103-104 (--aou-2 = global Arco control fill/border), :144-145 (**--aou-6-brand is UNDEFINED** — global primary-button var silently broken); MessageList.tsx:107; MessageThinking.module.css (7 uses); MessageToolGroupSummary.css (7); ChatHistory.tsx:237-238; SlashCommandMenu.tsx:98; FileChangesPanel.tsx:70; SiderToolbar.tsx:69; AgentPillBar.tsx:53; WorkspaceFolderSelect.tsx:225; TeamCreateModal.tsx:46/54; SettingsModal/index.tsx:387. Violates the "no visible --aou-*" release gate.
2. **eve primitives defined but unused**: eve-artifact-frame + eve-empty-state used NOWHERE; no settings page, modal, loader, or toast uses any eve-* class. Consumers today: SendBox, GuidInputCard, ConversationRow, SiderFooter.css, seatRail.css only.
3. **Nested card stacks everywhere** (prohibited §13): kanban 3-4 deep (index.tsx:397→291→188→211); ModelModalContent 3 deep (:498→:569→:606); EveRuntime (index.tsx:91 → WorkerAssignmentCard.tsx:131 → :167); SkillsHub/capabilities; connectorCatalog (:313→:340/:358/:440); billing Arco-Card stack (:168,220,282,306,335,363); erste-schritte (:133→:147 + Card :188); localRuntime (:242/434/460→:182); account (:196,373,405); company-brain (:445).
4. **Registration gate theme-blind**: RegistrationGatePage.css 35 hex + 38 rgba; purple glow rgba(139,92,246,.16) l.30; #ffffff!important l.227; permanently dark (light mode broken); hand-rolled blur(28px) glass (l.77-78); index.tsx raw <button>/<label>/<form> (489, 623, 634, 691, 728, 744, 884).
5. **Hardcoded white card + purple**: WebuiModalContent.tsx:760 `bg-white`; SkillsHubSettings.tsx:176-181 (#722ED1 purple, #F5319D pink) + :550 rgba(var(--purple-6)).
6. **Legacy theme system still bundled & latently injectable**: builtinThemes.ts:16-19/45-54 (4 decorative preset CSS + covers ship in every build); CssThemeSettings statically imported (AppearanceModalContent.tsx:11) incl. "Manuell hinzufügen" (CssThemeSettings.tsx:416-424); NO migrateLegacyTheme.ts exists; useTheme.ts:73 applies ANY ipcBridge.theme.changed broadcast unconditionally → decorative/custom CSS (customCssProcessor !important, appended last) would override the eve layer by construction.

## P1 findings

- SettingsSider.tsx:277 legacy `!bg-fill-3` selected slab (contract §8.2 wants eve-row wash + hairline); reuses `conversation-item` class (:273).
- AionModal.tsx not on overlay tier: var(--dialog-fill-0) (:182), #86909c close fill (:349), raw <button> (:348), var(--bg-3) border (:340); ~67 raw Arco Modal files + 11 Modal.confirm sites unthemed (notably SeatRail.tsx:250 seat-interrupt confirm, commandCenter:3539); arco-override.css contains ZERO --eve-_/--glass-_ wiring.
- Toasts: .arco-message hardcoded light gradients (arco-override.css:314-344).
- AppLoader.tsx:6-8 bare Spin, minHeight 100vh, no tokens — every lazy route fallback unthemed; Router has NO route-level error boundary.
- Blur-budget violations: .eve-pill has overlay backdrop-filter (command-eve-visual.css:291-292); ConversationSearchPopover.css:81-82 + :94-95 nested blur on scrolling results.
- Semantic color misuse: connectorCatalog stateColor purple (:178-184) + orange gated/needs_auth (:181/189/328/614); localRuntime tierColor purple pro (:165-170); kanban review 'orange' (:146); billing.css #4f46e5 indigo fallback (:88); EVE-Runtime orange "Pausieren" control (screenshot); erste-schritte orange "offen" badge.
- Legacy/internal naming in public UI: "AionUI + Hermes Runtime" + slug aionui-hermes-runtime on /settings/connectors (screenshot; source likely process/commandEve/connectorCatalogCore.ts); "KI-Shell" in scheduled subtitle; "Claude-CLI" in erste-schritte copy; MessageGeneratedArtifact renders provider/model in chat history (:191-193, 239-242) — §2/§19 exposure decision needed.
- connectorCatalog + localRuntime bypass SettingsPageWrapper (no shared shell/mobile nav under /settings/*); EveRuntime intro text rendered twice (screenshot).
- Raw interactive HTML: registrationGate (many), OnboardingReadinessGreeting :156 (+<a> :84), OnboardingWaitingBanner :82, DayZeroOnboardingModal :124, SettingsPageWrapper :214, MessageGeneratedArtifact :313/:324.
- CronStatusTag saturated *-light-1 pills + legacy border-arco-3/text-3 (:39-43); cron job-card hover:shadow-sm (:155); localRuntime inline-style progress bar (:278/283).
- Absolute local paths rendered on connectors/runtime pages (Company.OS root, manifest, preflight, kanban.db) — check against "no local path leaked" gate intent.

## P2 findings

- Legacy Arco token layer (bg-fill-_, text-t-_, --color-*) across all unmigrated pages — theme-safe; map during panel adoption, not a blocker.
- Non-tokenized backdrop-filters outside the eve reduced-effects kill-switch: layout.css:47-48 (sidebar), chat-layout.css:32-33 (header), BtwOverlay.module.css:21, LoginPage.css:177, RegistrationGatePage.css:77-78.
- Hex-literal top offenders: LoginPage.css(45), SeatRail.tsx(19), billing.css(19), MobileActionSheet(15), AppErrorBoundary(9), FileAttachButton(7), sendbox.css(5), titlebar.css(4), MessagePlan/ThoughtDisplay/MessageToolCall (3-4 each).
- common/theme/types.ts:7 ThemeAppearance lacks 'system' — two parallel appearance models coexist (works; don't widen legacy type).
- Dead preset CSS/covers on disk (hello-kitty, misaka-mikoto, retroma-* variants, unused PNGs) — delete.
- connectorCatalog hardcoded English strings (:251/265/271/541-548) — i18n gate.
- AppearanceModalContent still wraps rebuilt panel in legacy bg-2 rd-16px shell (:59/71); Appearance uses bespoke eve-appearance-* namespace, not shared eve-panel.

## Recommended bounded implementation sequence

**R1 — Global rails (small diff, global leverage; screenshot-diff gate before/after):**
a. arco-override.css → eve aliases: repoint :103-104/:144-145; define or remove --aou-6-brand deliberately; port .arco-message gradients to eve tokens.
b. AionModal → eve-dialog tier (themes 15 dialog surfaces at once); Arco Modal/Modal.confirm default chrome via arco-override.
c. AppLoader → eve shell bg + centered mark (themes every route fallback); consider a minimal route error fallback.
d. Remove backdrop-filter from .eve-pill; fix ConversationSearchPopover nested blur.
e. Add shared `eve-settings-group` / page-header pattern (h1 + subtitle + actions) for reuse by every route below.
f. Sweep the 11 remaining --aou-* consumers (chat Messages files first — MessageThinking, MessageToolGroupSummary, MessageList, ChatHistory).
**R2 — Settings sweep:** SettingsSider selected state → eve-row tokens; then per-page de-nesting to one panel level: model, capabilities/SkillsHub (incl. purple/pink removal), eve-runtime (incl. duplicated intro + orange Pausieren), billing, erste-schritte (incl. Claude-CLI copy + orange badge), account, company-brain, webui (incl. bg-white), pet, system/privacy (light touch). Decide SettingsPageWrapper adoption for connectors/runtime.
**R3 — Standalone routes:** kanban (de-nest, orange review → semantic), scheduled + TaskDetail + CronStatusTag + CreateTaskDialog (+ "KI-Shell" copy), connectorCatalog (de-nest, purple/orange remap, display-name fix, i18n), localRuntime (de-nest, purple pro tier, progress bar tokens), onboarding banner/greeting/day-zero modal, MessageGeneratedArtifact → .eve-artifact-frame + Arco buttons (+ provider/model decision).
**R4 — Pre-auth surfaces:** registration gate + login tokenization onto eve-overlay tiers; raw-HTML → Arco; decide dark-only vs theme-aware (recommend: keep dark-committed but tokenized).
**R5 — Legacy migration (parallel-safe with R2-R4):** prune decorative BUILTIN_THEMES from public; lazy/founder-gate CssThemeSettings import; new migrateLegacyTheme.ts (remap activeId, persist previousActiveId, one-time notice, idempotent); gate useTheme.ts:73 injection channel in public mode; delete dead preset assets; byte-preservation tests.
**R6 — Gates:** full-route light/dark matrix, no-literal lint gate, --aou visibility gate, blur-budget count, migration fixtures, 500-message scroll trace, packaged smoke.

## Likely regressions & exact tests

- arco-override repoint touches every Arco control → per-route light/dark screenshot diff after R1a alone; verify all 4 accents update both --color-primary-* and --primary-* RGB triplets (rgba(var(--primary-6)) sites: ConversationRow.tsx:220, localRuntime:283).
- --aou-6-brand fix may change primary-button hue (currently falling back) → button screenshots in all accents/modes.
- MessageThinking/ToolGroupSummary restyle → rerun 500-message scroll trace vs 1.7.x.
- .eve-pill blur removal → guid/composer pill screenshots; reduced-effects + reduced-transparency states.
- AionModal port → open/confirm/cancel e2e for UpdateModal, seat-interrupt confirm (behavior unchanged), CSS-theme delete confirm; solid fallback under prefers-reduced-transparency.
- Registration gate: fail-closed guard untouched (structural render paths in index.tsx); e2e: blocked launch → license entry → entitled; browser-login; day-14 curtain; 390px; video-bg fallback; light+dark.
- Kanban: ACP confirm-card flow, read-only Hermes semantics, empty/unavailable/loading states; Scheduled: keep-awake toggle, create-dialog form, job-detail nav.
- Connector catalog: gated/needs_auth badges keep warning semantics (no green-washing); preflight matching unchanged if display names change; new i18n keys → bun run i18n:types + node scripts/check-i18n.js.
- Theme migration: fixtures for 4 decorative + user + extension themes; byte-equality of stored CSS; notice idempotency across reinstall/seat switch; system-mode reacts to OS change with no config write loop; no theme-decoration style element in public mode.
- Settings sweep: German max-font 200% zoom on erste-schritte/eve-runtime (densest); extension tab anchoring still works after sider changes.

## Legacy theme / migration traps

1. --aou-6-brand is undefined — today's primary buttons already render fallback styling; "fixing" it can visibly change buttons. Decide the target (eve accent) explicitly.
2. Custom/decorative CSS is injected LAST with forced !important (applyTheme.ts:17-27/42 + customCssProcessor) — it beats command-eve-visual.css by construction. Gate at applyTheme in public mode, not only in the UI.
3. useTheme.ts:73 applies any theme.changed broadcast — a second window/seat switch can resurrect decorative CSS after migration unless the injection is gated.
4. Two appearance models: keep legacy ThemeAppearance 'light'|'dark'; 'system' lives only in EveVisualPreferences; beware ipcBridge.theme.setActive write loops.
5. Static import chain AppearanceModalContent → CssThemeSettings → BUILTIN_THEMES → preset CSS/covers: pruning requires lazy founder-gated import or the bundle gate fails.
6. Arco <Card> replacement (billing/account/company-brain) changes padding/head/border — expect layout drift; screenshot each.
7. presets/_.css define their own --aou-_ ramps — retiring the ramp from default-color-scheme.css is safe only after public consumers are swept; user theme payloads stay byte-identical regardless.
8. /settings/ext/* files are frozen (parallel bugfix worktree per plan §3) — inherit only, no edits.
9. Adopting SettingsPageWrapper for connectors/runtime changes scroll + mobile-nav behavior — verify deep links (/connectors, /runtime redirects) and mobile.
10. "AionUI + Hermes Runtime" display label likely comes from catalog data (connectorCatalogCore.ts / manifest) — rename display text only; connector IDs/slugs feed preflight matching.
11. Worktree gate: git status now shows only untracked screenshots — earlier dirty bugfix files appear committed; Codex should still record WORKTREE_OWNERSHIP_PASS before slice-e edits.

## Verification (for the implementation)

Per repo workflow: bun run lint:fix / format / bunx tsc --noEmit; i18n:types + check-i18n on any copy change; targeted vitest; GitNexus impact before each shared-symbol edit and detect_changes before commits; full-route screenshot matrix per contract §18; just push.
