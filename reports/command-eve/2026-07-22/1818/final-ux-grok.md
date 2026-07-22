# Command EVE 1.818 — Final UX Review (1818_final_ux_grok)

**Datum:** 2026-07-22
**Rolle:** Grok final UX pass (read-only review, no code ownership)
**Worktree:** `/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-1818-integration`
**Branch:** `codex/command-eve-1818-integration` @ base `1dec06ad` + dirty founder UX slice
**Peer evidence:** `reports/command-eve/2026-07-22/1818/auth-security-brand-review.md` (Kimi PASS on security/brand)
**Plane Done:** not set (worker authority)

---

## Verdict: **CONDITIONAL PASS** for founder UX slice

Ship the 1.818 founder UX/auth/brand surface **after** three closeout items (R1–R3). No P0 product-UX defect found in the in-flight slice. Residual issues are hierarchy polish, commit hygiene, and still-missing live Dev-App proof.

### Integrator remediation addendum

- **R3 closed:** the CTA now uses the native Arco primary treatment without a competing hand-painted ghost background.
- **License-back P2 closed:** returning from the optional code path now lands on browser-first auth; a focused DOM regression test pins that route.
- **Legacy logo aliases closed:** both historically named `resources/aionui_logo_*` assets contain the canonical EVE mark and are covered by the generator/verifier.
- **Still open by design:** R1 is closed only by the RC commit; R2 is closed only by the continuous real Dev-App proof.

| Surface                                      | Verdict            | Confidence                                             |
| -------------------------------------------- | ------------------ | ------------------------------------------------------ |
| Login-Gate browser-first (Apple-style)       | PASS               | High (code + i18n + E2E assertions)                    |
| Browser success → “Jetzt Command EVE öffnen” | PASS               | High (code + security peer)                            |
| Editable context menu (Cut/Copy/Paste)       | PASS               | High                                                   |
| Icon / brand pipeline (no fringes)           | PASS               | High (`brand:verify` PASS)                             |
| AionUi smiley on public brand surfaces       | PASS in-app        | Medium (dead assets remain; non-DE/EN locale residual) |
| Identity coherence (no email-name greetings) | PASS               | High (core + unit)                                     |
| First-run CTA → Erste Schritte               | PASS with polish   | Medium (unit only; live proof open)                    |
| Provider row hidden from BYOK settings       | PASS (security-UX) | High                                                   |
| Live Dev-App session proof                   | OPEN               | —                                                      |

---

## What landed (founder journey, end-to-end)

### 1. First contact — Registration Gate

Browser-mediated PKCE is the **only** large primary action:

- DE: “Sicher im Browser anmelden” / “Konto sicher im Browser erstellen”
- EN: “Sign in securely in browser” / “Create account securely in browser”
- Founder copy present: browser session reuse without re-entering password
- Password path behind `aria-expanded` fallback toggle; credentials not shown by default
- Enter on browser-first screen triggers web login (no phantom “email required”)
- Autofill/password-field dark fill CSS addresses the classic light-on-light Chromium trap

**UX judgment:** Correct hierarchy. This matches the founder mandate (post-web-registration users are not forced to retype credentials).

### 2. Browser callback — return to app

Success page:

- Clear confirmation + orange primary “Jetzt Command EVE öffnen”
- Dock fallback line for when focus fails
- No auth material in the deep link (security peer verified)

**UX judgment:** Apple-adjacent loop is complete: Browser does the hard part; one explicit button returns focus. No auto-open script games.

### 3. Entitled landing — identity + first value

- Greeting uses **confirmed** names only; email-local-part guesses → neutral “Hallo.” / “Hello.”
- Shared profile store refreshes after web login, password login, license unlock, profile edit, logout
- First-run CTA: “Mit EVE einrichten” / “Set up with EVE” → existing `/settings/erste-schritte`
- Visibility bound to canonical onboarding truth (`first_value_ready` / identity item) — no second checklist, no forced modal, no auto-LLM

**UX judgment:** Correct product restraint. First value is offered, not imposed.

### 4. Brand / chrome

- Brand gate PASS (10 PNG surfaces + SVG parity + icns/ico)
- Master icon has no white fringe/halo (peer pixel analysis + gate)
- Context menu only on editable fields — paste works where users expect it, not on chrome chrome

---

## Findings (actionable)

### R1 — Release hygiene (blocking closeout, not product redesign)

Untracked files the UX/brand surface depends on:

- `resources/command-eve-icon-master.png`
- `scripts/generate-command-eve-icons.mjs`
- `scripts/verify-command-eve-brand-assets.mjs`
- `scripts/command-eve-brand-contract.mjs`
- `packages/desktop/src/renderer/pages/guid/components/FirstRunSetupCta.tsx`
- `packages/desktop/src/process/commandEve/accountIdentityCore.ts`
- `packages/desktop/src/renderer/components/settings/SettingsModal/contents/providerProtectionCore.ts`
- matching unit tests + `tests/unit/security/editableContextMenu.test.ts`

Without these in the 1.818 commit, a clean clone loses brand gate + first-run CTA + identity core.

### R2 — Live Dev-App proof still open (blocking “UX proven”)

Code + unit are green for identity/first-run/auth DOM. Still missing one continuous Dev-App session:

1. Browser-first login → success page → open app
2. Profile edit → greeting + sider identity update same session
3. Cold first-run state → CTA visible → Erste Schritte
4. Completed first-value → CTA gone
5. Icon/Dock brand looks correct after install (or `killall Dock` note if cache sticks)

Until then: **do not market the slice as live-proven**.

### R3 — First-run CTA visual weight (closed by integrator)

`FirstRunSetupCta` mounts Arco `type='primary'` **and** applies soft ghost styles (`.commandEveFirstRunCta`: translucent primary fill, quiet border).

- Intent is right: CTA must not compete with the composer “send” affordance.
- Implementation is slightly dishonest: primary semantics + secondary paint → theme/hover inconsistency risk.

**Resolution:** retain the requested prominent primary action, but let the shared Arco design system own its fill, hover and contrast.

### P2 — License “Zurück” lands on local PII registration form (closed)

From auth, „Ich habe einen Lizenzcode“ correctly goes to license paste.
E2E still asserts: license **back** → `registration-gate-form` (local Name/Firma/E-Mail), not browser-first auth.

The back action now returns to browser-first auth. `RegistrationGateAuth.dom.test.tsx` proves the legacy local-PII form is not mounted on that route.

### P2 — Residual AionUi strings outside DE/EN shell brand pack

DE/EN conversation/quick-actions brand is Command EVE. Residual `AionUi` / `AionUI` remains in:

- EN settings MCP error strings, some common Linux packaging strings
- non-primary locales (e.g. uk-UA) still heavily AionUi

Not a Dock-icon issue; still a public-copy leak if an MCP error surfaces in EN. Sweep is productization, not blocker for the founder five.

### P3 — Historically named AionUi logo assets (closed)

`resources/aionui_logo_black_bg.svg` / `aionui_logo_no_border.png` now contain the canonical EVE mark and are enforced by the same brand gate, so accidental reuse cannot reintroduce the old smiley.

### Carry-over (not this slice, still open product question)

1.817 Fable note remains: Project-Workspace headline panel discoverability when default tab is “Aktivität” and the panel lives under “Kontext”. This final UX pass did **not** redesign that surface. Needs an explicit founder decision before claiming “workspace UX complete.”

---

## Microcopy / i18n

| Check                                                          | Result                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| DE/EN registrationGate key parity (new browser/fallback keys)  | PASS (0 de-only / 0 en-only)                                    |
| `conversation.welcome.firstRunSetupCta` DE/EN + i18n-keys.d.ts | PASS                                                            |
| Founder registration-awareness DE sentence                     | Present, clear, non-PR                                          |
| Neutral greeting without confirmed name                        | PASS (“Hallo.” / “Hello.”)                                      |
| Success-page German                                            | Clear; slightly ahead of broker finish (documented, acceptable) |

No tone/PR-smoothing issues in the new DE gate copy. Direct and concrete.

---

## Interaction quality checklist

| Criterion                                 | Result                                        |
| ----------------------------------------- | --------------------------------------------- |
| One obvious next step on gate             | Yes — browser primary                         |
| Progressive disclosure for power path     | Yes — password fallback                       |
| a11y expanded/controls on fallback        | Yes                                           |
| No double primary buttons at same weight  | Gate: good; Guid first-run: soft primary (R3) |
| Same-session identity update paths wired  | Yes (gate + account modal)                    |
| Security-owned provider not user-editable | Yes (reduces “broken local chat” footgun)     |
| Paste in password fields                  | Yes (native editable menu)                    |
| Forced modal / auto-setup                 | Correctly absent                              |

---

## What I did **not** re-run

- Full E2E suite / packaged registration-gate runtime (spec reviewed, not executed here)
- Notarize / R2 / aggregator
- Website/Stripe brand surfaces outside this repo
- Interactive Dev-App visual session

Kimi’s security/brand unit table (25/25 auth suite, brand gate PASS) is accepted as peer evidence, not re-executed in full.

---

## Root recommendation

1. **Commit** the untracked UX/brand/identity files with the dirty slice (R1).
2. **Run** one Dev-App proof session and attach notes/screenshots to this folder (R2).
3. **Optional same-day polish:** First-run CTA secondary styling + one helper line (R3).
4. Keep Project-Workspace discoverability as an explicit founder product decision, not a silent ship assumption.
5. Treat residual AionUi MCP/error copy as a fast follow, not a 1.818 stop, unless EN MCP errors are in the G7 script.

**Overall UX call:** The founder five (icons, logo sweep, browser-first gate, open-app button, context menu) plus identity/first-run addendum form a coherent first-run story. Conditional PASS pending commit hygiene + live proof.

---

## SessionEndSync (worker)

```text
SessionEndSync:
  Workspace: eve-1818-integration (AionUi sandbox)
  Branch: codex/command-eve-1818-integration
  Commit: dirty on 1dec06ad (no worker commit)
  Outcome: final UX review written; CONDITIONAL PASS
  Verification: code/i18n/brand-gate review; peer security report; brand:verify PASS; no live Dev-App
  ActiveContext: none
  ArchitectMemory: none
  WikiADR: none
  Honcho: none
  GitNexus: none
  Plane: none
  Linear: none
  HumanGate: R2 live proof + R1 commit ownership at Root/CEO
```

**Report path:** `reports/command-eve/2026-07-22/1818/final-ux-grok.md`
