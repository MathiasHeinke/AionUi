# Command EVE 1.2.8 — Live-Test-Protokoll (Claude, 2026-06-27)

Getestet: frischer 1.2.8-Build (`out/mac-arm64/Command EVE.app`), eingeloggte Founder-Session, via Computer-Use.
**Gesamturteil: NICHT release-reif — 1 kritischer Bug (EVE kann nicht senden) + mehrere UI-Defekte.**

---

## ✅ RESOLUTION (2026-06-27, fix-forward — KEIN Rollback, auf Founder-Wunsch)
**K1 ist GEFIXT + verifiziert.** Root-Cause (Diagnose-Workflow + DB-Inspektion): die EVE-Assistant-
Zeile (`command-eve-chief-of-staff`) war an `632f31d2 = "Aion CLI" (agent_type=aionrs)` gebunden statt
an `55f3ed1c = Hermes (acp/hermes)`. Der Jun-26-Re-seed wählte den Preset-Agent aus den ZUR SEED-ZEIT
ONLINE-Agents; Hermes war noch nicht hochgefahren → `selectCommandEvePresetAgentType` fiel auf `aionrs`
durch, und 1.2.7 (kein destruktiver Re-seed mehr) FROR diese Bindung ein. **Keine 1.2.8-UI-Regression —
1.2.8 war Opfer.** EVE hat auf aionrs keine Modell-Verdrahtung → „kein Modell ausgewählt" + die acp-Lane-
UI greift nicht.

- **Sofort (Founder-Box):** Live-DB re-bind `agent_id 632f31d2→55f3ed1c` (DB gesichert, App sauber beendet,
  re-bound, relaunch). **Verifiziert:** neue EVE-Konversation antwortet („Jo, bin da. Woran sollen wir
  arbeiten?"), und die volle 1.2.8-Leiste greift: `EVE Cloud · Mittel · Berechtigung · Standard · Kontext-
  Ring · 🎤 · ↑`. → K1 gelöst, **U3 gelöst** (Mode-Label jetzt „Standard", nicht aionrs-„Auto-Bearbeitung").
- **Dauerhaft (Code, committed 6efc786):** (a) `selectCommandEvePresetAgentType` fällt NIE mehr auf `aionrs`
  — EVE bindet an den Primär-Backend (hermes) auch wenn dieser zur Seed-Zeit offline ist (fixt Neu-Installs +
  Re-seeds). (b) `assistantStorageRepair` re-bindet beim Start jede schon-eingefrorene Installation aionrs→hermes
  (self-heal, idempotent, fail-open, scoped auf EVE). 25/25 Tests grün, tsc + oxlint clean.
- **OFFEN für 1.2.9-Build (Founder-Gate):** Build + R2-Push des self-heal; optional U1/U2 mitfixen.

---

## 🔎 ROOT-CAUSE-UPDATE (DB + Runtime-Inspektion) — KORRIGIERT
**KORREKTUR:** Mein erstes `pgrep` hatte einen Regex-Bug; tatsächlich **läuft Hermes (PID 4490) UND Ollama (PID 5014, erreichbar, gemma-Modelle geladen)**, Bootstrap-Receipt status="ready". Der Runtime ist NICHT tot. ABER die Runtime-Seite zeigt **„Kanban-Preflight konnte nicht geladen werden / KANBAN_GOVERNANCE_NOT_LOCKED", „EVE Runtime Kanban = Nicht bereit", „Governance-Lock unvollständig"**, und **Release = „1.2.7"** (runtime-bootstrap NICHT auf 1.2.8 gebumpt). → Hermes läuft, gilt aber evtl. als „nicht verifiziert" (Governance/Kanban nicht ready) → EVE-Fallback auf aionrs. Alternativ ein reines Frontend-Routing-Problem (neue EVE-Konversation wählt aionrs statt acp). Der Diagnose-Workflow klärt die Code-Seite.
DB `conversations.type`: neue EVE-Konversationen = **`aionrs`**, ältere EVE + Claude = **`acp`** (alle haben model=NULL — Modell ist Session-State, nicht in der Spalte). Aktive `acp`-Sessions HABEN Modelle (lokal gemma 64k bzw. **Cloud size=1000000 used=24152 cost $0.146** → mein model-sensitives Fenster greift auf der acp-Lane!). `commandEve.inferenceSelection`=`eve-standard` korrekt gesetzt; `hermes.preferredModelId`=lokales Gemma.

**KETTE:** Hermes/Ollama nicht gestartet → EVE-Assistant fällt laut Prompt („If Hermes is not verified, use the fallback backend") auf `aionrs` zurück → neue EVE-Konversation = `aionrs` ohne Modell → „kein Modell ausgewählt" + meine acp-In-Chat-Änderungen greifen nicht (aionrs = AionrsSendBox, unangetastet).

**EINORDNUNG:** Wahrscheinlich **Test-/Runtime-Artefakt** (Runtime lief beim direkten Build-Launch nicht, weil ich 1.2.6 + dessen Ollama beendet hatte), **NICHT zwingend eine 1.2.8-Code-Regression**. Auf der `acp`-Lane (wenn Hermes läuft) greifen meine Änderungen nachweislich (Picker in der Leiste bei „test", model-sensitives 1M-Fenster in der Session). ZU BESTÄTIGEN: sauberer Relaunch mit gestartetem Runtime → sendet EVE dann? (+ der Diagnose-Workflow klärt die Code-Seite). Offene echte Defekte unabhängig davon: U1–U3 + runtime-bootstrap-Version 1.2.7→1.2.8.

---

## 🔴 KRITISCH (Symptom)

### K1 — EVE-Konversationen: „kein Modell ausgewählt", kann nicht senden
- Neue EVE-Cloud-Nachricht vom Start-Screen (Modell „EVE Cloud · Mittel" aktiv) → Konversation erstellt, aber **leerer Verlauf, KEINE Antwort**, Placeholder: **„Für die aktuelle Sitzung ist kein Modell ausgewählt, Nachricht kann nicht gesendet werden"**.
- **Auch bestehende EVE-Konversationen** („Moin EVE…") zeigen denselben Zustand: leer + „kein Modell ausgewählt".
- Der Modell-Picker steht bei diesen EVE-Konversationen **im Header („Modell auswählen")**, NICHT in der Bottom-Leiste — und **öffnet beim Klick keine Liste** (nicht auswählbar).
- Die Claude-Code-Konversation („test") funktionierte dagegen (Antwort sichtbar).
- **Befund:** Die EVE-Konversationen laufen offenbar NICHT auf dem `acp`/hermes-Pfad, gegen den ich die 1.2.8-In-Chat-Änderungen gebaut+getestet habe (vermutlich `aionrs`-Plattform). Darum greifen meine In-Chat-Änderungen dort NICHT (Picker im Header statt Leiste, generische Modi) UND die Modell-Auswahl ist gebrochen. → Genau die 1.2.2-Lektion: Unit-Tests grün, aber nur der Runtime-Test fängt es.

---

## ⚠️ UI-DEFEKTE (Start-Screen, wo meine Bar greift)

### U1 — Picker: überlappender Text auf gegateten Cloud-Zeilen — ✅ GEFIXT (1.2.9, commit 3593a29)
Bei Trial-Account sind „Hoch"/„Max" ausgegraut, aber der orange Kosten-Badge („mehr Credits" / „höchste Kosten") lag **ÜBER** dem Modellnamen + „im Paid-Tarif" — gequetscht. FIX: Menü 280→340px + der lange Modell-Sublabel trunkiert zuerst (STUFE-Label + Badges bleiben shrink-0), kein Overlap mehr, alle Infos erhalten.

### U2 — Naming-Inkonsistenz lokal vs. Cloud — ✅ GEFIXT (1.2.9, commit 3593a29, Founder-Wahl)
War: Lokal = **Standard / Hoch**, Cloud = **Mittel / Hoch / Max** → „Standard" (lokal) vs „Mittel" (Cloud) verwirrend. FIX (Founder wählte „Cloud-Einstieg → Standard"): Cloud-Einstiegsstufe „Mittel" → **„Standard"**. Beide Lanes starten jetzt mit „Standard" (Lokal: Standard·Hoch; Cloud: Standard·Hoch·Max). Reine Label-Änderung — Wire-`tier` bleibt `standard`, kein Routing-Change.

### U3 — Permission-Modus-Label
Start-Screen-Dropdown zeigt **Standard / Auto-Bearbeitung / YOLO** — der mittlere ist das generische `aionrs`-Label, NICHT das approbierte EVE-Label **„Änderungen übernehmen"**. (Folgt aus K1: Mode-Backend = aionrs, nicht hermes.)

---

## ✅ WAS KORREKT IST
- **Unified Send-Bar auf dem Start-Screen** vorhanden + sauber: `+ · ◉ EVE Cloud · Mittel · 🛡 YOLO · 🎤 · ↑`. Mic da, deutsches Wording gut.
- **Modell-Tiers korrekt verdrahtet:** Cloud Mittel=DeepSeek V4 Flash, Hoch=DeepSeek V4 Pro, Max=GLM 5.2; Paid-Gating für Trial greift.
- **Log-Leiste ist WEG** im Operator-Build („EVE bereit · Modell unbekannt · Logs" nicht sichtbar) ✓ (STEP 1).
- Sidebar deutsch + konsistent; Claude-Code-Konversation funktioniert + „Berechtigung · Standard"-Prefix da.

---

## 📋 EMPFEHLUNG (aktualisiert — fix-forward gewählt)
1. ~~1.2.8-Feed auf 1.2.4 zurückrollen~~ — **VERWORFEN auf Founder-Wunsch** („ich will nichts backrollen"). Stattdessen fix-forward (siehe RESOLUTION oben). K1 + U3 gelöst.
2. ✅ **K1 diagnostiziert + gefixt:** EVE lief auf `aionrs` statt `acp/hermes` (eingefrorene Re-seed-Bindung). Sofort-Re-bind auf der Founder-Box + dauerhafter Self-Heal im Code (committed 6efc786).
3. **U1/U2 noch offen** (U3 erledigt). Empfehlung: in den 1.2.9-Build mit-falten.
4. **VOR dem 1.2.9-Feed-Push:** erneut runtime-testen (frische EVE-Konversation antwortet) — auf der Founder-Box bereits bestätigt; nach dem Build erneut auf dem gebauten Artefakt.
