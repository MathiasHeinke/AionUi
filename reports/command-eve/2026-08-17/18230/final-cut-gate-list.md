# Command EVE 1.823.0 — Restliste bis zum finalen Schnitt

Stand: 2026-08-17, HEAD `aa7e59636`, Branch `codex/eve-18230-18225-integration`
Worktree: `/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration`

Diese Datei ist der Wiedereinstiegspunkt nach dem Codex-Neustart. Sie listet nur,
was für den finalen 1.823.0-Schnitt noch offen ist. Was bereits ausgeliefert und
bewiesen ist, steht unten unter „Nicht neu herleiten".

## Lage

1.823.0 ist notarisiert, gestapelt und als **Dev-Update** live (R2 `channels/dev/`).
Stable bleibt unverändert 1.822.5. Alois testet den Dev-Build und findet die
Blocker, die hier stehen. **Alois' laufender Build enthält die Fixes unten noch
nicht** — sie wirken erst nach dem QA-Rebuild (G6).

## Bindende Leitplanken

- **In der Hermes-Architektur bleiben.** Keine zweite Genehmigungsschicht, keine
  zweite Artefakt-Ablage, kein Parallelmechanismus. Nur bestehende Nähte
  verkabeln oder die kleinste verantwortliche Naht reparieren.
- Endnutzer-Tauglichkeit ist Abnahmekriterium, nicht nur technische Korrektheit.
- Behauptungen mit `file:line` belegen. Live-Proben schlagen Schlussfolgerungen.
- Kein Build, keine Notarisierung, kein R2-Upload, kein Push, kein Linear-Write
  ohne ausdrückliches Go des Founders.
- `reports/command-eve/1823-independent-review-armA-fable.md` ist ein fremder
  untracked Report — nicht anfassen.

---

## G1 — Artefakt-Ablage in sichtbaren Projektordnern (P0, in Arbeit)

Der Auslöser: EVE behauptete, ein gerade erzeugtes Bild existiere nicht, und
konnte es weder zeigen noch herausgeben. Die Ablage ist heute versteckt,
hash-benannt und teilweise gar nicht im Projekt.

**Befund (belegt):**

- Office schreibt in den Projektordner, aber versteckt und hash-benannt:
  `.command-eve/conversation-artifacts/<sha24>/<sha24>-<sha256><ext>`
  — `packages/desktop/src/process/services/project-workspace/storage/conversationArtifactStore.ts:49`
- Bilder landen gar nicht im Projekt, sondern unter
  `dataPath/command-eve-managed-image-artifacts`, Blob **ohne Dateiendung**
  — `packages/desktop/src/process/commandEve/imageArtifactStore.ts:85`. Video analog.
- `eve_artifact_get` liefert keinen Pfad zurück
  — `packages/desktop/src/process/resources/builtinMcp/eveArtifactToolSurface.ts:63`.
  Genau deshalb sagt EVE „die Datei gibt es nicht".
- Hermes arbeitet nativ im Session-cwd und kann sichtbare Dateien ohne
  Sonderlogik nutzen — `acp_adapter/server.py:2089` (gebündelt).

**Festgelegte Umsetzung:**

1. Sichtbare Ordner je Projekt: `bilder/`, `videos/`, `dokumente/` — nur bei
   Bedarf angelegt, kein Leer-Gerüst.
2. Sprechende Namen nach Office-Muster: `<slug>-<YYYY-MM-DD>.<ext>`, Kollision
   `-2`, `-3`. Der Hash bleibt im Record, verschwindet aus dem Dateinamen.
3. Ohne Projektbindung dieselbe Struktur im Temp-Bereich.
4. `eve_artifact_get` gibt den **projekt-relativen** Pfad zurück
   (`bilder/foo-2026-08-17.png`), **niemals absolut** — der Store redigiert
   `file_path`, `canonical_path`, absolute Pfade und Home-Pfade aktiv:
   `conversationArtifactStore.ts:36-39`. Relativ genügt, weil Hermes im
   Session-cwd arbeitet.
5. **Aufräum-Hinweis (leichte Regel, vom Founder erbeten):** Dateizahl beim
   Schreiben mitzählen, ab 100 Dateien im Ordner einmal ein Hinweis, danach nur
   bei Verdopplung (200/400/800). Kein Verzeichnis-Scan, kein Nagging, Stand pro
   Ordner persistiert.

**Offene Founder-Entscheidung (blockiert den Implementierungsstart):**
Wird die sichtbare Datei kanonisch, oder ist sie eine zweite Kopie?
Empfehlung des Vorprüfers: **zweite, eigenständig geschriebene Datei.**
Begründung: `writePrivateDocumentImmutable` publiziert create-only und der
Lesepfad prüft `nlink !== 1`
(`packages/desktop/src/process/commandEve/officeArtifactAttachmentCore.ts:362`,
erneut nach dem Öffnen in `:377`). Hardlinks sind damit ausgeschlossen. Macht man
die sichtbare Datei kanonisch, wird sie im Finder editier- und löschbar und der
Re-Read-Pfad für „Bearbeiten" verliert seine Integritätsgarantie. Zwei Kopien
kosten Plattenplatz, halten aber den bestehenden Vertrag unangetastet.

**Einstiegspunkt für die Umsetzung:** Die gemeinsame Naht gehört an den
**Bind-Zeitpunkt**, nicht ans Staging — erst dort ist die Konversation und damit
der Projektordner bekannt.

- Bild: `imageArtifactStore.ts:465` (`bindStagedImageArtifact` flippt auf `active`)
- Video: analog beim Record-Write
- Office: hat den Ort bereits in `officeArtifactAttachmentCore.ts:437`
  (`persistImportedOfficeParent`)
- Projektordner-Auflöser: `resolveCommandEveOfficeConversationAuthority`
  (`officeArtifactAttachmentCore.ts:404`) liest `conversation.extra.workspace`.
  Das ist der Kandidat für die Extraktion in die geteilte Naht — Bild und Video
  kennen ihn heute gar nicht.

**Abnahme:** Bild, Video, PDF, PPTX, XLSX und DOCX landen sichtbar und
sprechend benannt im Projektordner; EVE kann sie in einem Folgeturn ohne
Sonderlogik finden, referenzieren und wiederverwenden; Download aus dem Chat
funktioniert; die rechte Artefakt-Ansicht zeigt sie.

---

## G2 — Freigabedialog erschien nie (P0, Fix liegt, Beweis fehlt)

Behoben in `825de4818`, aber **im laufenden Dev-Build nicht enthalten**. Alois
sah „bestätige kurz in der App", ohne dass je ein Dialog kam.

Root-Cause live im gebündelten Hermes reproduziert:
`is_interactive_cli: True | is_gateway_approval_ctx: True | notify_cb: False`
→ `submit_pending` → Status `approval_required` in einer Queue, die im Desktop
niemand liest. ACP setzt `platform="acp"` (`acp_adapter/server.py:2083`), damit
greift `_is_gateway_approval_context()` (`tools/approval.py:244`) und der
Gateway-Zweig gewinnt vor dem CLI-Zweig (`tools/approval.py:3256`) — aber der
ACP-Adapter registrierte den Callback nur am Terminal-Tool
(`acp_adapter/server.py:2107`).

**Offen:** Live-Nachweis am neuen QA-Bundle, dass der Dialog für Bild-Edit,
PDF, Excel und Video erscheint und die Ausführung nach Bestätigung durchläuft.

---

## G3 — Bootstrap-Wettlauf (P0, Fix liegt, Beweis fehlt)

Behoben in `0a7dc6ae0`, Regressionstests in `aa7e59636` (Schärfe bewiesen: zwei
Tests waren auf dem alten Stand rot).

`pushStage` überschrieb den autoritativen Receipt nach jeder Stufe; `buildReceipt`
setzt `status: ready`, sobald nichts blockiert — aber `ollama` und `model`, die
den lokalen Modellaufruf erst freigeben, stehen am Ende der Kette. Zwischenstände
gehen jetzt nach `runtime-bootstrap-progress.json`, alle 52 Ausstiege laufen über
`commitReceipt`.

**Offen:** Verhalten am neuen QA-Bundle bestätigen.

---

## G4 — Erst-Turn-Latenz (P1, offen)

Gemessen: warm 1,5 s p50, aber **erster Turn eines neuen Chats 80–146 s**.
Ollama selbst antwortet in unter 1 s. Zwei Posten:

1. ~18.500 Prompt-Tokens, davon ~43 KB reine Tool-Schemas. Hermes' progressive
   Tool-Disclosure stellt MCP- und Plugin-Tools zurück, **Core-Tools per Design
   nie** (`tools/tool_search.py:1`, gebündelt).
2. ~21–26 s Hermes/ACP-Start pro neuem Chat. Die bestehende Warmup-Naht
   (`packages/desktop/src/renderer/components/chat/SendBox/index.tsx:1084`)
   könnte vorgezogen werden.

**Entscheidung offen:** Ob G4 den finalen Schnitt blockiert oder als bekannte
Kennzahl mitgeht. 80–146 s Wartezeit beim ersten Eindruck sind für Endnutzer
hart; das spricht dafür, mindestens Posten 2 (Warmup vorziehen) noch zu machen.

---

## G5 — Bild-Nachbearbeitung (P2, offen)

Zwei Befunde aus Alois' Test, beide noch nicht auf ihre Ursache untersucht:

- **GPT Image 2.0 erkennt das Referenzbild nicht an.** Der Founder weiß sicher,
  dass das Modell Referenzbilder verarbeiten und verändern kann. Einstieg:
  `packages/desktop/src/common/config/eveManagedImageGenerationCore.ts` und
  `packages/desktop/src/process/bridge/commandEveImageArtifactBridge.ts`.
- **Im Bearbeiten-Modus ist das Modell fix auf Nano Banana 2** und nicht
  wechselbar. Noch nicht geprüft, ob das gewollt ist oder ein Fehler.

Zusätzlich vom Founder als Wunsch benannt, noch nicht eingeplant: nach dem
Erstellen direkt „Auflösung erhöhen", „Format ändern" und „Alternative erzeugen"
am Artefakt anbieten.

---

## G6 — QA-Rebuild und Verifikation (Pflicht, danach)

**Reihenfolge:**

1. `bun run command-eve:package:qa-signed` — die signierte QA-Lane aus
   `44e1d91e2`. Ohne diesen Schritt wirkt **kein einziger Hermes-Patch**.
2. Volle Regressionssuite (zuletzt grün: 764 Dateien, 8892 Tests, 0 Fehler).
3. TTFT-Rerun. Ein formales TTFT-PASS braucht den Rebuild zwingend, weil die
   Turn-ID-Bindung (`eb354bb1e`, `a4df454fd`) erst im neuen Bundle steckt.
4. Live-Proben für G1, G2, G3 am neuen Bundle.

**AionCore-Pin für jeden Build (sonst falsches Binary):**

```
AIONUI_BACKEND_LOCAL_BINARY=/Users/mathiasheinke/Developer/.agent-sandboxes/aioncore/_pinned-artifacts/8c2e7c34-darwin-arm64/aioncore
AIONUI_BACKEND_SHA256=541eae3c36ac57963b058fad3fc4b860470869cea784bd12012a3e73b611c867
AIONUI_BACKEND_SOURCE_COMMIT=8c2e7c344f2e50493ec3427625f13715b1e6599c
```

**TTFT-Lauf** (Profil immer frisch per `mktemp -d`, nie ein bestehendes löschen):

```
bunx tsx scripts/command-eve/ttft/benchmark.ts \
  --executable "out/qa-signed-packaged/mac-arm64/Command EVE.app/Contents/MacOS/Command EVE" \
  --app-commit $(git rev-parse HEAD) --cohort cold_start_chat --sessions 1 \
  --user-data-dir "$TTFT_PROFILE" --capture-only --prepare-local-default \
  --output /tmp/eve18230/ttft-check.json
```

Der erste Turn dauert real 80–146 s. Das ist kein Hänger, sondern G4.

---

## G7 — Release-Schnitt (zuletzt, nur auf Founder-Go)

Notarisieren, stapeln, R2. Reihenfolge beim Upload: Artefakte zuerst, die
`latest-arm64-mac.yml` **zuletzt**. Danach per `curl` bestätigen, dass Dev die
neue Version zeigt und Stable unverändert bleibt.

Vor dem Stable-Schnitt zusätzlich zu klären: die vom Founder für 1.823.0
angemeldete **In-App-Seat-Verwaltung**. Heute schickt der Button in den
Abrechnungs-Einstellungen nur in die Kontoansicht
(`packages/desktop/src/renderer/components/settings/SettingsModal/contents/BillingModalContent.tsx:180`
und `:377`); eine Stelle, an der ein Nutzer selbst Seats anlegt, benennt oder mit
Company Brain bestückt, ist im Renderer nicht auffindbar. Der Seat-Wechsel
dahinter existiert und ist ausgearbeitet
(`packages/desktop/src/process/commandEve/seatSwitchCore.ts`). Es fehlt also die
Oberfläche, nicht der Unterbau — Umfang und Zeitpunkt sind eine Founder-Entscheidung.

---

## Nicht neu herleiten — was steht

| Commit                    | Inhalt                                                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `44e1d91e2`               | Signierte QA-Lane (`electron-builder.qa-signed.yml`) — der Durchbruch: Runtime verlangt `tree_phase: signed`, die E2E-Lane schaltete Signierung ab, die Produktions-Lane die Inspect-Fuse. Die dritte Lane überlappt beides, ohne den Nicht-Distributions-Vertrag anzufassen. |
| `eb354bb1e` + `a4df454fd` | Turn-ID-Bindung Provider ↔ ACP-Turn, TTFT-Gate verlangt sie                                                                                                                                                                                                                   |
| `825de4818`               | Tool-Freigaben über ACP-Callback (G2)                                                                                                                                                                                                                                         |
| `0a7dc6ae0` + `aa7e59636` | Bootstrap-Receipt erst bei Abschluss, plus Regressionstests (G3)                                                                                                                                                                                                              |
| `b8a719eb4`, `84deeb5fa`  | TTFT misst den echten Produktpfad und liest gebündelte Milestones                                                                                                                                                                                                             |

## Praktische Hinweise

- **`rg` redigiert Bezeichner** in diesem Baum (Funktionsnamen erscheinen als
  `n`). Dateien direkt öffnen (`sed -n 'X,Yp'`), nicht auf die `rg`-Ausgabe
  allein verlassen.
- **Live-Proben gegen den gebündelten Hermes** haben beide P0-Ursachen bewiesen:
  `out/qa-signed-packaged/.../Contents/Resources/python/bin/python3.12 -I -B script.py`
  mit `sys.path.insert(0, "artifact-site-packages")`.
- Bei Parallelarbeit in `runtimeBootstrapCore.ts` Bereiche abgrenzen: ~5834
  (llm_request/Turn-Binding), ~7216–7360 (Authority-Hook), ~11755ff
  (Bootstrap-Receipt).
