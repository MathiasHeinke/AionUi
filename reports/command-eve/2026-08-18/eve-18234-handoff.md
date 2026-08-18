# Command EVE 1.823.4 — Übergabeprotokoll vor Codex-Neustart (2026-08-18)

## 0. Startauftrag für die nächste Session (copy-paste)

> Lies `reports/command-eve/2026-08-18/eve-18234-handoff.md` im Worktree
> `/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration`
> (Branch `codex/eve-18230-18225-integration`, HEAD `96efee4c2`). Arbeite die
> offenen Punkte in Abschnitt 5 in der Reihenfolge ab. Kein Notar/R2, bevor
> Mathias den lokalen 1.823.4-Build live getestet hat.

## 1. Release-Wahrheit

- **Dev-Kanal live: 1.823.3** (2026-08-18T07:20Z), Basis-HEAD `aa7e59636` +
  Release-Commit `fdce87fb9`. Notar akzeptiert, Stapler grün. Stable unberührt.
- 1.823.2 (01:44Z) hatte die Modell-Leiter noch nicht wirksam; 1.823.3 löste
  die Edge-Blockade (Branch `companyos/eve-18232-ladder`).
- **1.823.4 ist NICHT gebaut, NICHT notarisiert, NICHT auf R2.** Es existiert
  nur als Commit `96efee4c2` im Worktree.
- Wahrheitsquelle: `Company.OS/docs/releases/VERSIONS.md`.

## 2. Inhalt von 1.823.4 (Commit `96efee4c2`, 13 Dateien, +301/−96)

1. **Authority — builtin MCP ohne Popup:** `eveAuthorityRuntimeCore.ts`
   klassifiziert `mcp__aionui_image_generation__*` und
   `mcp__aionui_eve_artifacts__*` nach innerem Toolnamen: Reads +
   `eve_typed_ui_publish` + die produktseitig verwalteten Paid-Calls
   (`aionui_image_generation`, `eve_image_edit`, `eve_video_edit`,
   `eve_video_generate`) laufen ohne „Nicht verifizierte Operation"-Karte.
   Neue Tools auf bekannten Servern und alle Third-Party-MCP bleiben `ask`.
   `tool_search`, `tool_describe`, `video_analyze`, `read_window_below` sind
   jetzt always-read. Bare `tool_call` ist hart `ask` (kein Backdoor).
2. **Native Hermes-Freigabe statt Sonderkarte (Shim-Patch in
   `runtimeBootstrapCore.ts`):** die Tool-Search-Bridge löst das UNDERLYING
   Tool für die Authority-Entscheidung auf; strukturierte Gates laufen über
   Hermes' eigene `approve`-Direktive (`request_tool_approval` mit
   once/session/always + Hermes-Allowlists) statt über die selbstgebaute
   Einmal-Karte. Der Rule-Key trägt die Leiter-Sprosse
   (`command-eve:L<ladder>:<label>`), damit ein Runterstufen wieder fragt.
3. **Vorschau-Fix (`MessageGeneratedArtifact.tsx`):** verwaltete Bilder
   bekommen ihre Vorschau nur noch über die verifizierte Artifact-ID-Bridge,
   nie aus dem Placement-Pfad (Temp-Chats lösten den gegen die falsche Wurzel
   auf → „keine Vorschau verfügbar").
4. **Registration-Gate-CSS:** hartcodiertes Orange/Blau durch Accent-Tokens
   ersetzt, Ladezustand lesbar.

**Verifikationsstand:** `eveHermesToolAuthority.test.ts` +
`hermesDesktopBridge.test.ts` 19/19 grün (18.08., 16:57). Der geänderte
Renderer-Test `managedImageArtifacts.dom.test.tsx` und die Vollsuite liefen
in dieser Runde NICHT. Visuelle Verifikation von 3 + 4 in der laufenden App
steht aus.

## 3. Offene Befunde aus dem Live-Test (VULPES-Session, Konv. `11df1a06`, ungepatchte 1.823.3)

P0 — vor Sarah-Demo (Fr 22.08.) Pflicht:

1. **Artefakt-Aktionen tot:** Bearbeiten / Herunterladen / Öffnen / Im Ordner
   zeigen schlagen fehl — auf der Chat-Karte UND in der Artefakte-Rail
   („Öffnen mit System-App fehlgeschlagen", „Datei herunterladen
   fehlgeschlagen"). Ursache ungeprüft; vermutlich Pfadauflösung Temp-vs-
   Projekt bzw. Bridge-Handler.
2. **Bildgenerierung ohne Gesprächskontext:** Hermes geht mit einem
   kontextlosen Prompt direkt zu OpenRouter → Zufallsbild (Logistik-Slide
   statt Fuchs). Der Generierungsprompt muss aus dem laufenden Gespräch
   gebaut werden (Werkzeuganleitung/Systemprompt, nicht noch eine Regel).
3. **Permit-Sackgasse + Halluzination der Werkzeuglage:** Agent verlangt
   „einmaligen Bearbeitungs-Permit", es kommt keiner; danach behauptet er
   „PDF-/Datei-Export-Tool im Seat nicht freigeschaltet" — obwohl PDF-Erzeugung
   grundsätzlich läuft. 1.823.4 (Punkt 2.1/2.2) adressiert das teilweise;
   Verifikation ausstehend.
4. **SVG-Ersatzcover:** trotz Visual-Gate mit 3 echten generierten
   Richtungen und Nutzerwahl „2" setzte Hermes ein selbstgebautes SVG ins
   PDF statt das gewählte Bild. Auswahl muss an der Ausführung hängen.
5. **Kein Turn-Feedback im Bild-Modus:** nach Absenden kein Spinner, kein
   Prompt-Echo; die Artefakt-Karte erscheint später ohne sichtbaren Turn.

P1:

6. **Registration-Gate Design** → in 1.823.4 gefixt, Auge drauf.
7. **AionCore-Bootfehler nach lokalem Live-Patch** (Recovery-Screen, beim
   zweiten Start ok) — Patch auf laufende App ist der Verdacht; beobachten.
8. **Seat-Verwaltung defekt** (Plus-Button-Modal und Einstellungen lehnen
   neuen Seat ab) — bewusst NICHT release-blockierend, Ticket für .5.
9. **„Alles erlauben"-Switch soll sofort im laufenden Chat greifen** (heute:
   Wechsel mitten im Chat → Popups kommen trotzdem weiter).
10. **Deutsche Zwischenstände sichtbar** (Ruhezeit-Doktrin: ≤60 s ohne
    Lebenszeichen), Reasoning nur auf Klick. Statuszeile existiert, Inhalt
    und Sprache prüfen.

Bereits erledigt (1.823.1–1.823.3, nicht erneut aufmachen): kanonische
Ablage + Retention/Sweeper, GPT Image 2 Referenzbilder (`input_references`
0–16 via IMAGES-Route), Modellwahl im Bearbeiten-Modus inkl. Vorauswahl =
zuletzt genutztes Modell, Weiterarbeits-Weg (deiktisch → Clarify-Auswahl),
Sticky-Tool-Modus mit X, Kaltstart-Rennen `command 'hermes' not found`
(Fix in 1.823.3), Kimi-P1-Auflage Temp-Pfad-Beschreibung (in 1.823.1).

## 4. Kanonische Produkt-Entscheidungen dieser Session

- **Modell-Leiter final:** standard/hoch = `openai/gpt-5.6-luna` (hoch =
  Effort high), xhigh/max = `moonshotai/kimi-k3`. DeepSeek, Gemini, GLM
  vollständig raus — auch die Hintergrund-Tool-Kette. Grok 4.6 nach eigener
  Messung verworfen (Qualität 8,21 vs. Kimi 9,13; Judges 10/12 letzter
  Platz). Multiplikatoren unverändert 1,3/4/2/2. Evidenz:
  `Company.OS/docs/operations/evidence/command-eve-max-eval-2026-08-18/`.
- **Vision/Dokumente:** Kimi nativ image+video, kein file; Luna
  text+image+file. Cloud-Vision-Egress bleibt ZU
  (`COMMAND_EVE_IMAGE_OMITTED_TEXT`) bis die Egress-Frage entschieden ist.
- **Fix-Pipeline (Doktrin):** lokal patchen → sofort in der lokalen App
  testen → erst bei Stable Notar + R2. Kein Notar für lokale Iteration.
- **Clean-Code-Regel #1 (Mathias, verbindlich):** Dateien ≤ wenige hundert
  Zeilen, 1.000 Zeilen nur als absolute Ausnahme. `runtimeBootstrapCore.ts`
  (13.970 Zeilen) ist der Hauptverstoß.
- **1.823.5 (geplant):** `runtimeBootstrapCore.ts` aufsplittern, auf
  Hermes-Plugin-Architektur umstellen (Hermes bekommt seine nativen
  Fähigkeiten zurück statt Regel-Patches), Python raus, Seat-Verwaltung,
  Aufräum-Hinweis-Oberfläche für Video/Office (cleanup_notice hat nur in
  der Bild-Lane einen Leser).
- **Termin:** Fr 2026-08-22 Demo bei Sarah Babayan — PDF-/Bild-Workflows
  müssen sitzen (5.000 €).

## 5. Reihenfolge ab Neustart

1. Lokale App aus dem Worktree patchen + starten; Mathias testet die
   Tool-Freigaben live (Bild erstellen/bearbeiten, PDF, Video, Office).
   Erwartung: keine „Nicht verifizierte Operation"-Karten bei builtin
   Tools; echte Fremd-Tools fragen weiter.
2. VULPES-P0-Befunde 1–5 fixen (Artefakt-Aktionen, Bildprompt-Kontext,
   Permit-Sackgasse, SVG-Ersatz, Turn-Feedback).
3. Geänderte Renderer-Tests + Vollsuite.
4. Erst danach: Notar + R2-Dev-Upload 1.823.4 → Alois. VERSIONS.md-Eintrag
   VOR dem Bauen (Regel 1).
5. 1.823.5-Aufsplitter planen (Abschnitt 4).

## 6. Pfade

- Worktree: `/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration`
- Branch: `codex/eve-18230-18225-integration`, HEAD `96efee4c2`
- Lokale Test-App: `out/mac-arm64/Command EVE.app` im Worktree
- VERSIONS.md: `/Users/mathiasheinke/Developer/Company.OS/docs/releases/VERSIONS.md`

```text
SessionEndSync:
  Workspace: Company.OS + AionUI-Integrationsworktree
  Branch: codex/eve-18230-18225-integration @ 96efee4c2 (1.823.4 WIP committed)
  Outcome: Authority/Native-Approval/Preview/CSS-Patch committed + getestet (19/19);
           VULPES-Live-Befunde als P0/P1-Backlog festgeschrieben; Handoff abgelegt
  Verification: vitest 2 Dateien 19/19 grün; Vollsuite + Renderer-Test + visuelle
           Verifikation ausstehend (Abschnitt 2)
  Linear: pending (MAT-1624-Update beim 1.823.4-Dev-Upload nachholen)
  HumanGate: lokaler Live-Test durch Mathias vor Notar/R2
```
