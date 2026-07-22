# Command EVE 1.818 — Auth-Security- & Brand-Review (1818_auth_security_kimi)

**Datum:** 2026-07-22
**Scope:** Unabhängige Security-/Brand-Verifikation der im Worktree `eve-1818-integration`
(branch `codex/command-eve-1818-integration`, Basis `1dec06ad`) in-flight befindlichen
Founder-Aufträge: (1) Icon-Fransen, (2) AionUi-Logo-Sweep, (3) Login-Gate-UX nach
Apple-Prinzip, (4) "Jetzt App öffnen"-Button nach Browser-Login, (5) Rechtsklick/Kontextmenü.

**Rolle dieses Workers:** Review + Verifikation (kein Code-Owner der Slice; Implementierung
lief parallel durch Root/andere Worker). Kein Plane-Done gesetzt.

---

## Verdict: PASS nach Root-Remediation — alle fünf Founder-Punkte korrekt und sicher umgesetzt

### 1. Login-Gate-UX (registrationGate/index.tsx, CSS, i18n de+en) — PASS

- Browser-PKCE ist jetzt der primäre, große Button ("Sicher im Browser anmelden" /
  "Konto sicher im Browser erstellen"); E-Mail/Passwort hinter einem aria-expandierten
  Fallback-Toggle (`registration-gate-password-fallback-toggle`).
- Registrierungs-Awareness exakt wie vom Founder gefordert:
  „Gerade auf command-eve.com registriert oder angemeldet? EVE übernimmt deine
  Browser-Sitzung sicher — ohne das Passwort erneut einzugeben."
- `browserSessionHint` erklärt die Wiederverwendung der Browser-Session.
- autocomplete-Semantik im Fallback erhalten (`username` / `current-password` /
  `new-password`), autoFocus im geöffneten Fallback, Submit-Button auf `secondary`
  degradiert (visuelle Hierarchie korrekt).
- a11y: `aria-expanded`, `aria-controls`, Fallback mit eigener Region.

### 2. Browser-Success-Seite + Deep-Link (desktopAuthLoopback.ts) — PASS

- Neuer Button `Jetzt Command EVE öffnen` → `command-eve://auth/complete`.
- **Kein Auth-Material im URL**: weder Code, State, Token noch User-Daten
  (Test pinnt: `not.toContain('one-time-code-123' | 'state=' | 'access_token')`).
- Sicherheits-Header auf allen Loopback-Antworten (Success + Fehler):
  `cache-control: no-store`, `pragma: no-cache`, `referrer-policy: no-referrer`,
  `x-content-type-options: nosniff`, CSP `default-src 'none'; style-src
'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
  Keine Scripts auf der Seite (CSP-konform, kein auto-open-Hack).
- **Single-Use gehärtet**: Handler-Level-410 für Keep-Alive-Race zusätzlich zu
  `server.close()`; ein zweiter Callback kann nie erneut ein Redeem auslösen.
- Deep-Link-Angriffsfläche: `auth/complete` wird vom Parser **verworfen**
  (`deepLinkSecurity.test.ts` pinnt `parseDeepLinkUrl(...) === null`); der Link
  erreicht nie den Renderer-Dispatch. Fokus läuft ausschließlich über den
  `open-url`-Handler im Main-Prozess. Keine neue Renderer-Angriffsfläche.

### 3. Rechtsklick/Kontextmenü (appMenu.ts, index.ts) — PASS

- `setupEditableContextMenu`: natives Edit-Menü (undo/redo/cut/copy/paste/
  pasteAndMatchStyle/delete/selectAll) via Electron-Roles.
- **Scope korrekt**: nur bei `params.isEditable` (kein Menü auf Seiteninhalt),
  WeakSet gegen Doppelbindung, Destroyed-Check.
- Keine Clipboard-Inhalte im Main-Prozess (reine Role-Actions) — Passwort-Felder
  bleiben Renderer-intern.

### 4. Icon-Fransen — PASS (Pipeline nachweislich sauber)

Pixel-Analyse des neuen Masters `resources/command-eve-icon-master.png` (1024×1024 RGBA):

- 0 opaque-weiße Pixel, 0 weißliche semi-transparente Pixel (max. Luminanz der
  Alpha-Kante: 23.5 — dunkles Navy, kein Halo).
- Full-Bleed-Squircle: Mitte-Zeile durchgehend opak (0→1023), saubere
  Anti-Alias-Kante, 11.1 % Orange-Anteil (⌘).
- Brand-Gate `scripts/verify-command-eve-brand-assets.mjs`: **PASS**
  (10 PNG-Flächen + SVG-Parität + icns/ico-Container, inkl. Extraktions-Check der
  icns über sips).
- `build-with-builder.js` ruft die Brand-Gate jetzt **vor** dem Bundling auf —
  ein fransiges Icon kann den Build nicht mehr passieren (Release-Invariante).

**Founder-Fall:** Das reale Foto ist die verbindliche Regressionsevidenz: Der
installierte Vorbuild konnte weiße Eckfransen zeigen. Die 1.818-Pipeline erzeugt
alle Container neu aus einem fransenfreien Master und prüft die resultierenden
Rasterflächen fail-closed. Eine Cache-Hypothese ist kein Fixnachweis und wird
daher nicht als Root Cause behauptet.

### 5. AionUi-Logo-Sweep — PASS

- Die historisch benannten Dateien `resources/aionui_logo_black_bg.svg` und
  `resources/aionui_logo_no_border.png` enthalten jetzt ebenfalls das kanonische
  EVE-Zeichen; der Dateiname darf keine alte sichtbare Marke mehr konservieren.
- Renderer-/Public-Brand-Flächen zeigen durchgängig das ⌘-EVE-Logo
  (SVG-Parität public ↔ renderer bytegleich, Gate pinnt `#f97316` + ⌘).

---

## Befunde

### B1 (Release-relevant, vor Closeout klären): Untracked Pflichtdateien

Die folgenden neuen Dateien sind Teil des in-flight Release-Deltas und müssen
vor dem RC gemeinsam committed werden:

- `resources/command-eve-icon-master.png` (Quelle aller Brand-Assets)
- `scripts/generate-command-eve-icons.mjs`
- `scripts/command-eve-brand-contract.mjs`
- `scripts/verify-command-eve-brand-assets.mjs` — **build-with-builder.js ruft
  dieses Skript auf**; ein frischer Clone ohne diese Datei schlägt den Build fehl.
- `tests/unit/security/editableContextMenu.test.ts`

→ Müssen in den 1.818-Commit, sonst Build-Bruch für jeden anderen Checkout/CI.

### B2 (geschlossen): Historisch benannte Logo-Dateien

Beide `resources/aionui_logo_*`-Dateien wurden in die Generator-/Verifier-
Wahrheit aufgenommen und enthalten nun das kanonische EVE-Zeichen.

### B3 (Hinweis, non-blocking): Success-Seite vor Broker-Exchange

Die Success-Seite sagt „Anmeldung bestätigt", bevor der Broker-Exchange
abgeschlossen ist (by design — der Browser-Tab soll nicht auf das Netz warten).
Bei Broker-Fehler zeigt die App den Fehlerzustand; der Seiten-Text („schließt die
sichere Anmeldung im Hintergrund ab") deckt das ab. Kein Handlungsbedarf.

### B4 (Außerhalb Repo): command-eve.com

Falls das AionUi-Smiley auf der Website/Checkout-Strecke noch auftaucht, liegt
das außerhalb dieses Repos. Nicht verifiziert — Empfehlung: separater Check der
Web-Fläche (Favicon, Header, Checkout).

---

## Verifikation (frisch ausgeführt)

| Check                                                                                                                            | Ergebnis                                |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `desktopAuthLoopback.test.ts` + `deepLinkSecurity.test.ts` + `editableContextMenu.test.ts` + `RegistrationGateAuth.dom.test.tsx` | 25/25 PASS                              |
| `runBackendMigrations.test.ts` + `ollamaOpenAiShim.test.ts` (Root-Provider-Slice)                                                | 71/71 PASS                              |
| Pixel-Analyse Icon-Master (Weiß-Anteile, Halo, Coverage, Orange)                                                                 | PASS                                    |
| `verify-command-eve-brand-assets.mjs` (10 PNG + SVG + icns/ico)                                                                  | PASS                                    |
| E2E-Spec `command-eve-registration-gate.e2e.ts` (Browser-primary + Fallback-Toggle + autocomplete)                               | 2/2 PASS mit gebundenem AionCore-Binary |

## Nicht verifiziert / bewusst offen

- E2E-/Live-Durchlauf des kompletten Auth-Flows in der Dev-App (Release-Gate G7,
  nicht Scope dieses Reviews).
- Website/Stripe-Flächen (B4).
- Finales Commit-/Push- und Notarize-/R2-Ergebnis (Root-Hoheit).
