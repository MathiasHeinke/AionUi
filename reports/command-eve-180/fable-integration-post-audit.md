# Command EVE 1.8.0 Integration — Post-Merge Staff Audit (1c6716a3..HEAD)

## Context

Read-only senior review of the committed integration range (16 commits, 101 files, +7,434/−3,469) on `codex/command-eve-180-integration`, after reading `reports/command-eve-180/integration-live-qa.md`. Focus: the manually resolved merge areas (AboutModalContent, GuidPage, useGuidSend, localRuntime, DE/EN locales, command-eve-settings-surfaces.e2e.ts) and the P0/P1/P2 defect classes named in the review charter. Direct inspection plus three read-only workers (settings primitives/identity, DE-EN locale parity, runtime-state/tests/CSS).

## Verdict

**No release blocker. P0: none. P1: none.** The manually resolved merge areas are coherent and the anti-leak posture is layered and fail-safe. The QA report's own release gate stands (do not package from this commit alone; packaged E2E pending).

## Verified sound (FACT unless noted)

- **Public identity hard-pin is a deliberate fix, defense-in-depth verified.** `useGuidSend.ts:166` and `GuidPage.tsx:573` pin `isCommandEveAssistant = COMMAND_EVE_SHELL_ENABLED`; raw agent pill bar is compile-time hidden (`GuidPage.tsx:51` `SHOW_RAW_AGENT_SELECTION = !COMMAND_EVE_SHELL_ENABLED`), the guid mention dropdown never opens from typing (`GuidPage.tsx:214-221` always `setMentionOpen(false)`), the restore path force-selects the EVE key when the assistant seed exists (`useGuidAgentSelection.ts:373-377`), and a fallback EVE agent identity covers a missing seed (`useGuidSend.ts:260-273`).
- **Founder/technical-details gate fail-safe.** `useCommandEveFounderBuild.ts:10-13` defaults `{loading:true, founderBuild:false}`, only ever transitions false→true, catch→false; main side reads `COMMAND_EVE_FOUNDER_BUILD` env only, not baked into any build config. No flash of `model_ref`/`base_url`/receipt paths to public users; all technical fields in `localRuntime/index.tsx` verified gated behind `showTechnicalDetails`.
- **DE/EN locale parity clean.** Full leaf-key parity for localRuntime (125/125), deinTeam, connectorCatalog, credits, pet; the 101-vs-99-line delta in localRuntime.json is formatting only. Every key consumed by the new AboutModalContent and localRuntime page exists in both languages; `i18n-keys.d.ts` in sync; `scripts/check-i18n.js` exits 0. No new user-visible value leaks an internal identity.
- **About update action verified end-to-end.** `AboutModalContent.tsx:29` dispatches `aionui-open-update-modal`; listener alive with cleanup at `UpdateModal.tsx:240-244`; UpdateModal mounted globally (`Layout.tsx:397`, unchanged in range).
- **Shared modal footer wiring correct.** `AionModal.tsx:366-385` handles null/undefined/ReactNode/config footers with no duplication or lost buttons; the dropped `mt-10px` is compensated by the wrapper's `pt-16px`.
- **Mobile settings navigation improved and tested.** `SettingsPageWrapper.tsx:201-238` overflow-fade + active-item `scrollIntoView` with full listener/observer cleanup; `isSettingsPathActive` (`SettingsSider.tsx:67-70`) fixes the old substring false-active bug; `aria-current='page'` set; new 390px deep-link e2e covers it.
- **e2e spec strengthened, not weakened.** Raw-model-id assertions replaced by humanized-copy assertions plus a new leak guard `getByText(/Gemma|Ollama|custom:command-eve/i)).toHaveCount(0)`; every positively-asserted data-testid exists at HEAD (incl. dynamic `system-preference-${key}` at `SystemModalContent/index.tsx:543`); support-note copy matches source in both languages.
- **CSS/theming clean.** All new `eve-*` classes defined in `command-eve-visual.css`/`settings.css`; colors via CSS variables so `:root[data-theme='dark']` covers dark mode; `@media (max-width:767px)` block reflows the new about/settings surfaces; no fixed width >390px without a media query.
- **Error-copy neutralization in send path.** Raw `alert("…aionrs is installed / EVE/Hermes…")` replaced with i18n'd `Message.error` + `getConversationCreateErrorMessage` on the aionrs branch (`useGuidSend.ts:431,449`); helper and `conversation.createFailed` keys exist in both languages.
- **Settings DOM tests adapted, not weakened** (class rename `.aion-dir-input`→`.eve-dir-input`; responsive width `md:!max-w-640px`). No identity assertions removed.

## Findings (all P2 — none blocks release)

1. **P2 — EVE's own send-failure path is still silent** (pre-existing, but the range's error-neutrality fix missed the primary path). In shell mode all sends route through the ACP branch (`finalEffectiveAgentType='hermes'`, `useGuidSend.ts:300`), where a null conversation is `console.error` + silent `return false` (`useGuidSend.ts:522-524`) and a thrown create error is rethrown then swallowed by `sendMessageHandler` (`:540-542`, `:584-586`). The new `Message.error(getConversationCreateErrorMessage(...))` landed only on the aionrs branch (`:431,:449`), which shell-mode EVE never takes. Impact: if `conversation.create` fails after the runtime reports ready, the user clicks send and nothing visibly happens. FACT that the path is silent; FACT (verified at base `1c6716a3`) that it predates this range. Remediation: mirror the `Message.error(getConversationCreateErrorMessage(error, t))` handling in the ACP branch.
2. **P2 — Warmup poll cap bypassed during pull-progress.** `localRuntime/index.tsx:415`: the 12-attempt ceiling is skipped whenever `pullInProgress`; if the backend wedges in `pull-progress`, the renderer polls IPC every 2.5s indefinitely. INFERENCE (depends on backend dropping the stage). Remediation: absolute time/attempt ceiling for the pull path too.
3. **P2 — `load()` has no mounted guard.** `localRuntime/index.tsx:353-396`: setState after `await Promise.all` with no `alive` flag and no cleanup on the initial effect — state updates on an unmounted component. FACT. Remediation: adopt the `let alive` pattern already used in `useCommandEveFounderBuild`.
4. **P2 — AionModal padding defaults changed globally.** `AionModal.tsx:188` content padding `'0'`→`'4px 24px 20px'`; `:372-376` adds `px-24px pt-16px pb-20px` to every custom footer unless `footerUnpadded` (only `TeamCreateModal.tsx:184` opts out). Full-bleed modals not passing explicit padding (e.g. DayZeroOnboardingModal, CssThemeModal, DirectorySelectionModal) may show doubled inset. INFERENCE, cosmetic. Remediation: visual sweep of AionModal callers during packaged QA; opt full-bleed footers into `footerUnpadded`.
5. **P2 — Missing regression coverage** (all FACT):
   - About "Check for updates" button has no `data-testid` and no test clicking it (the event→modal path is covered via SiderFooter unit test and the auto-update e2e, but the About button's own wiring is unverified).
   - The guid create-failure `Message.error` branch is guarded only by a source-string assertion (`publicShellIdentity.test.ts`); no behavioral test invokes it.
   - localRuntime founder-gating has no rendered DOM test asserting `base_url`/`model_ref`/receipt paths stay hidden at `founderBuild=false` (source verified correct — coverage gap only).
6. **P2 — Accessibility: `PreferenceRow` label not associated with its control.** New shared primitive (`PreferenceRow.tsx:16-44`) renders the label as a `div`; switches (e.g. include-prereleases on About) expose no accessible name. Pre-existing pattern, now codified. Remediation: add `id`/`aria-labelledby` plumbing or `aria-label` pass-through in the primitive.
7. **P2 — i18n residue (pre-existing, none introduced here):** 33 EN-only `settings.json` keys (present at base); `localRuntime.labels.ollamaUrl` value "Ollama URL" (founder-gated view only); dead flat Gemini fallback keys in channel-assistant settings strings (nested keys win, never rendered); `settings.companyBrain`/`extensionSkillsBadge` absent in both languages (code `defaultValue` fallback renders).
8. **P2 — Unreachable-in-shell raw alerts remain** on the OpenClaw/Nanobot branches (`useGuidSend.ts:334,353,382,401`) — English `alert()` with internal names; reachable only if the EVE seed is missing AND a stale non-EVE selection persists. Pre-existing.

## Explicitly not re-litigated

The documented local Gemma instruction-adherence failure and the stale open-view completion strip are quality/runtime issues already contracted for 1.8.1 in the QA report; source inspection found no additional code defect behind them in this range, and no regression test exists yet for the completion-reconciliation acceptance criteria (that gap is part of the 1.8.1 contract, not this integration).

## Recommended follow-ups (non-blocking, roughly ordered)

1. Mirror the neutral `Message.error` handling into the ACP send branch (finding 1) — smallest fix with the highest user-facing value, since it is the shell's primary path.
2. Add `data-testid` + a click test for the About update button; add a rendered founder-gating test for localRuntime (findings 5a/5c).
3. Mounted-guard + pull-poll ceiling in `localRuntime/index.tsx` (findings 2–3).
4. Visual sweep of AionModal callers in packaged QA for the padding-default change (finding 4).

FABLE_180_POST_AUDIT_COMPLETE
