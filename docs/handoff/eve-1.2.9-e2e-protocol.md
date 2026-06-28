# Command EVE 1.2.9 — Full E2E-Test-Protokoll (Claude, 2026-06-28)

Getestet: notarisierter 1.2.9-Build (`out/mac-arm64/Command EVE.app`, stapler PASSED), eingeloggte Founder-Session, via Computer-Use. Durchlauf: Start-Screen, Chat, und ALLE Einstellungs-Untermenüs.

**Gesamturteil: Die vier Founder-Asks (A Picker · U1 Overlap · U2 Naming · B EVE-Selbstauskunft) sind LIVE verifiziert + funktionieren. Zusätzlich 8 vorbestehende Befunde (M1–M8) gefunden — überwiegend i18n/Branding, zwei davon (M1, M6) sind Modellnamen-Leaks und damit direkt im „keine Modellnamen"-Mandat.**

---

## ✅ DIE FOUNDER-ASKS — ALLE LIVE BESTÄTIGT

### A) Picker zeigt Kapazität, KEINE Modellnamen ✓
Start-Screen-Picker (gezoomt verifiziert):
```
Privat (lokal)        Standard   (schnell · privat)
                      Hoch       (intelligenter · privat)
EVE Inference (Cloud) Standard   (großer Kontext)
                      Hoch       (intelligenter)        · mehr Credits · im Paid-Tarif
                      Max        (höchste Intelligenz)  · höchste Kosten
```
Kein „DeepSeek/GLM/Gemma" irgendwo. STUFE-Labels Standard/Hoch/Max bleiben.

### U1) Kein Text-Overlap auf gegateten Zeilen ✓
Gegraute „Hoch (intelligenter)"-Zeile zeigt „mehr Credits · im Paid-Tarif" sauber getrennt — kein Überlappen mehr.

### U2) Cloud-Einstieg „Standard" (nicht „Mittel") ✓
Bar + Picker zeigen „EVE Cloud · Standard".

### B) EVE kennt ihren Modus — sagt NICHT mehr „Gemma 4" ✓✓ (der Kernfix)
Frage „Worauf läufst du gerade? Welches Modell nutzt du genau?" → EVE antwortet:
> „Moin. Ich laufe im **EVE Cloud**-Modus, Stufe **Standard** — das heißt große Kontexte und die volle Tool-Umgebung. **Welches Modell genau da unten steckt, kann und werde ich nicht sagen** — das ist nicht Teil meines Knowledge-Cuts. Was zählt, ist was ich damit machen kann…"

→ Nennt die aktive Lane (EVE Cloud, Stufe Standard), **verweigert den Modellnamen** (Standing-Rule greift), kein „Gemma". Exakt die approbierte Copy.

### Weitere ✓
- **Self-heal/aionrs-Fix hält:** EVE sendet, läuft auf acp-Lane, Bar zeigt „Berechtigung · Standard" (nicht aionrs-„Auto-Bearbeitung").
- **Version:** „Über" zeigt **v1.2.9** (der gestrandete 1.2.7 ist weg).
- **Konto:** sauber, DE; EVE-Cloud-Status „aktiviert — die Cloud-Modelle stehen zur Verfügung" (kein Modellname).
- **Datenschutz:** DE, ehrliche Telemetrie-off-Copy, keine Leaks.
- **Remote (WebUI):** DE, sauber; kein BYOK als Top-Menü (korrekt für DE).
- **Assistenten:** EVE-Assistent vorhanden + aktiv, DE.
- **Billing-Inhalt:** Credit-Packs 25/50/100/250€ + Starter 79€ + Spend-Cap korrekt für das neue Modell.

---

## ❌ BEFUNDE (M1–M8) — vorbestehend, durch den gründlichen Durchlauf aufgedeckt

### 🔴 Modellnamen-Leaks (direkt im „keine Modellnamen"-Mandat)
- **M1 — Einstellungen › Modell:** leakt mehrfach: Intro „…lokal über **Ollama/Gemma**.", Badge „EVE Runtime + **Ollama**", Body „…in EVE Runtime/**Ollama** geschrieben.", und je Karte die rohe Modell-ID „custom:command-eve-**gemma4**-e4b/12b/31b-64k:latest". (Die Karten-TITEL sind korrekt abstrahiert: schnell/intelligenter/leistungsstark · privat.) → Renderer-Fix (ModelModalContent): Modell-ID-Zeile ausblenden/abstrahieren + „Ollama/Gemma" → „EVE Runtime".
- **M6 — Einstellungen › System:** Toggle „Lokales EVE-Modell vorwärmen" Beschreibung: „Lädt das lokale **Gemma**-Modell…". → „lokale EVE-Modell".

### 🟡 i18n / Wording
- **M2 — Einstellungen › Darstellung:** ROHE i18n-Keys sichtbar statt Labels: `settings.appearancePanel` (Nav), `settings.fontSizeChat/Markdown/Code`, `settings.fontSizeStepperReset` (×3), `settings.scale`, `settings.scaleReset`. → Übersetzungen fehlen (de + en).
- **M3 — Einstellungen › Billing:** komplette Seite ENGLISCH („free actions used", „Spend cap", „Plans", „Credit packs", „Out of allowance? Top up", „Report branding"…) im sonst deutschen App. → i18n.
- **M7 — Einstellungen › Fähigkeiten:** Skill-Beschreibungen ENGLISCH („Founder intent to CEO delegation and worker contracts", „Memory and local ledger setup"…).

### 🟡 Branding / interne Begriffe
- **M4 — Einstellungen › Agenten:** „**Hermes** · Lokale EVE-Runtime" — interner Runtime-Name sichtbar (Brand-Label-Regel: Hermes → EVE).
- **M5 — Einstellungen › Darstellung:** Light-Theme-Karte ist mit „**AionUi**" gebrandet (Upstream-Name). Auch die quirky Upstream-Themes (Hello Kitty, Misaka Mikoto, Y2K电子账本…) sind fragwürdig für ein professionelles Reseller-Produkt — Produkt-Kuration, kein Bug.
- **M8 — Einstellungen › Fähigkeiten:** Skill-Beschreibungen leaken interne Company.OS-Vokabel auf die OPERATOR-Oberfläche („CEO delegation", „worker contracts", „founder onboarding", „governed work routing").

### Nicht geprüft (niedrigere Prio)
Company Brain, Desktop-Pet, Remote › Channels-Tab. Bei Bedarf nachziehen.

---

## ✅ FIXES APPLIED (Founder-Wahl „Großer Batch", 2026-06-28)
M1–M6 gefixt (Worker + Review), für den nächsten 1.2.9-Rebuild:
- **M1** Modell-Settings: `commandEveLocalRuntimeDesc` + Badge + Restart-Note → „Ollama/Gemma" raus, nur „EVE Runtime" (de+en); rohe Modell-ID-Zeile (`tier.modelId`) aus jeder Karte in ModelModalContent.tsx entfernt.
- **M2** Darstellung: 7 fehlende de-DE-Keys ergänzt (appearancePanel=„Darstellung", fontSizeChat/Markdown/Code, fontSizeStepperReset=„Zurücksetzen", scale=„Skalierung", scaleReset=„Zoom zurücksetzen").
- **M3** Billing: neuer `credits`-Namespace (de-DE + en-US `credits.json`, in den i18n-Index registriert) — alle `t('credits.settings.*'/'credits.meter.*')`-Keys auf Deutsch.
- **M4** Agenten: Karten-Titel „Hermes" → „EVE Runtime" (LocalAgents.tsx; interner Key `'hermes'` unverändert).
- **M5** Themes (builtinThemes.ts): Light-Theme „AionUi" → „EVE"; 3 off-brand Themes entfernt (Misaka Mikoto, Hello Kitty, Y2K); dead cover-Imports in themeCovers.ts mit aufgeräumt. Behalten: EVE, Dark, Retro Windows, Retroma Obsidian, Discourse Horizon, Glittering Input Field.
- **M6** System: „vorwärmen"- + Runtime-Status-Text „Gemma" → „EVE-Modell" / „EVE Runtime" (de+en).

Verifiziert: 1340 Tests grün (renderer+settings+command-eve), JSON valide, oxlint 0, credits-Namespace registriert. (Full tsc + Rebuild folgen.)

## ⚠️ RESIDUEN (NICHT im M1–M6-Scope — Fast-follow, Founder-Entscheidung)
- **Runtime-Seite** (`localRuntime.json`, Haupt-Nav „Runtime"): Untertitel „…EVE Runtime, **Ollama, Gemma-Tiers**…" + „Lokale KI braucht **Ollama** / muss **Ollama** installiert sein". „Gemma-Tiers" ist ein Modell-Leak; „Ollama" ist hier funktional (Install-Hinweis). Nicht getestet/geändert in dieser Runde.
- **MCP-Import-Copy** (`en-US/settings.json`): „Will be imported into **AionUi**" / „Imported into AionUi" — AionUi-Brand-Leak (en-only).
- **M7/M8** (Fähigkeiten: englische Skill-Texte + interne CEO/Worker-Vokabel) — separat.

## 📋 EMPFEHLUNG
1. **A+B sind ship-reif** — die vier Asks funktionieren live.
2. **M1 + M6 fixen vor dem Ship** — sie widersprechen direkt dem „keine Modellnamen"-Mandat (sonst wirbt 1.2.9 mit „modellfrei", leakt aber in Modell/System-Settings). Reiner Renderer/i18n-Fix, ein Rebuild.
3. **M2 (rohe i18n-Keys) mitnehmen** — sind sichtbar kaputt, billig zu fixen.
4. **M3/M4/M5/M7/M8 = Founder-Entscheidung** — größere i18n-/Branding-/Kurations-Arbeit (Billing-Übersetzung, Hermes→EVE, AionUi-Theme, Skill-Copy). Fast-follow oder mitfalten.
5. **R2-Push** erst nach Founder-Go (Prod-Feed-Grenze).
