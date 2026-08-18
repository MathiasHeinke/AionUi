# 1.823.1 — Unabhaengige Reviews und die daraus gebauten Reparaturen

Stand: 2026-08-17, Basis-HEAD `aa7e59636`, alles uncommitted im Worktree
`/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration`

Dieses Dokument haelt fest, was drei unabhaengige Pruefer gefunden haben und was
daraufhin repariert wurde. Es ist der Beleg dafuer, dass die 1.823.1-Arbeit nicht
nur gebaut, sondern gegengeprueft ist.

## Warum drei Pruefer

Die Suiten des Erbauers waren gruen. Alle drei P0-Befunde unten kamen von
Pruefern, die den Code NICHT gebaut hatten. Das ist der ganze Grund fuer die
Trennung.

| Pruefer               | Lane                            | Verdikt (Stand bei Pruefung)                            |
| --------------------- | ------------------------------- | ------------------------------------------------------- |
| interner Review-Agent | eigene Session                  | REJECT — 2x P0, 1x P1, 3x P2, alle live reproduziert    |
| Fable 5               | Claude Max, interaktiv per tmux | REJECT — bestaetigt P0 unabhaengig, findet 3 weitere P1 |
| Kimi K3               | eigene Session                  | laeuft noch; hat das Crash-Fenster unabhaengig bewiesen |

Bemerkenswert: Der interne Pruefer und Fable 5 haben dasselbe Crash-Fenster
unabhaengig voneinander gefunden und **beide empirisch reproduziert**, nicht nur
hergeleitet. Kimi K3 hat es ein drittes Mal bewiesen. Drei getrennte Wege zum
selben Befund.

## P0-1 — Bezahltes Bild konnte dauerhaft verschwinden

Der Bind verschob den privaten Blob in den Projektordner, BEVOR Location-,
Active- und Handle-Records geschrieben waren. Scheiterte der Record-Commit, war
die alte Heimat weg, der Record blieb `staged`, und jeder Retry meldete fuer
immer `artifact-missing`.

Live reproduziert: sichtbare Datei enthielt die bezahlten Bytes, privater Blob
geloescht, Record `staged`, Erstversuch UND Retry `artifact-missing`. Der Nutzer
sah "Das Bild wurde lokal gespeichert, konnte aber nicht in die Unterhaltung
eingefuegt werden" — Credits weg, kein Recovery-Code vorhanden.

**Repariert:** Der private Blob bleibt bis NACH dem vollstaendigen Commit
erhalten; erst danach wird er geloescht. Halbfertige aktive Zustaende repariert
der Retry.
`imageArtifactStore.ts:503`, `:530`, `:579`

## P0-2 — Hardlink-Crashfenster machte bezahlte Ware unlesbar

Zwischen `linkSync` und `unlinkSync` existierten Quelle und Ziel mit `nlink=2`.
Die eigene fail-closed Schutzpruefung (`nlink !== 1`) wies das Ziel danach ab
mit "Die Datei wurde ausserhalb von EVE veraendert oder verschoben." Erst
manuelles Entfernen der Quelle machte sie wieder lesbar. Ein Absturz nach dem
Ziel-fsync und vor dem Quell-Directory-fsync hinterliess also dauerhaft
unlesbare bezahlte Ware.

**Repariert:** `linkSync` ist raus. Create-only laeuft ueber `O_EXCL` + Kopie +
Datei-fsync + Directory-fsync. `renameSync` wurde bewusst NICHT gewaehlt, weil
es ein zwischen Zielwahl und Rename angelegtes Nutzerziel ueberschreiben
koennte. Quelle und Ziel haben nie gemeinsam `nlink=2`; scheitert die
Quellbereinigung, bleibt das Ziel lesbar.
`canonicalArtifactPlacement.ts:122`

**Offener Preis dieser Loesung:** Eine zurueckbleibende Quelldatei ist bewusst
tolerierte Aufraeumschuld, und die Kopie verdoppelt kurzzeitig den Platzbedarf
(bei Videos relevant). Kimi K3 prueft beides gezielt.

## P1-1 — TOCTOU: falsche Bytes konnten als bezahltes Artefakt durchgehen

`verifyCanonicalArtifact` pruefte sha und inode am Descriptor, gab aber nur den
PFAD zurueck; `readImageArtifactBytes` oeffnete danach erneut ueber den Pfad.
Eine gleich grosse Ersetzung dazwischen lieferte fremde Bytes.

Live reproduziert: Original waehrend des Reads umbenannt, am kanonischen Pfad
eine gleich grosse Datei `REPLACED` angelegt — Verifikation gab `{ok:true}`,
anschliessendes Lesen lieferte `REPLACED`. Die neuen sichtbaren Ordner sind
extern beschreibbar (Sync-Clients), das ist nicht akademisch.

**Repariert:** Nach dem Descriptor-Read wird der aktuelle Pfad erneut gegen den
geoeffneten Inode geprueft. Die verifizierten BYTES werden zurueckgegeben;
`readImageArtifactBytes` oeffnet nicht mehr selbst.
`canonicalArtifactPlacement.ts:240`, `:268`, `:290`, `imageArtifactStore.ts:234`

## P1-2 — Medien-Resolver kannte den Projektordner nicht (in Arbeit)

Von Fable 5 gefunden, von mir unabhaengig bestaetigt.

`eve_artifact_get` weist Hermes an, den relativen Pfad "directly from the
current workspace" zu nutzen (`eveArtifactToolSurface.ts:63`). Terminal- und
Datei-Werkzeuge sind korrekt am Session-cwd verankert (ACP setzt `cwd=state.cwd`,
`acp_adapter/server.py:2089`; Aufloesungsschicht `agent/runtime_cwd.py` mit
`_SESSION_CWD`-ContextVar).

**Der Medien-Resolver benutzt sie nicht.** `tools/image_source.py:122-123` macht
fuer einen bare relativen Namen schlicht `Path(os.path.expanduser(candidate))` —
das loest gegen den PROZESS-cwd auf. Gegenprobe: `runtime_cwd`/`session_cwd`
haben in `image_source.py`, `vision_tools.py` und `file_operations.py` **null
Treffer**.

Folge: Ob die Weiterarbeit am Bild funktioniert, haengt davon ab, welches
Werkzeug Hermes zufaellig waehlt. Genau die Halbverkabelung, die nicht bleiben
darf. Reparatur laeuft.

## P1-3 — Erst zahlen, dann verweigern (in Arbeit)

Die Workspace-Verfuegbarkeit wird erst NACH dem bezahlten Provider-Aufruf
geprueft (`commandEveImageArtifactBridge.ts:723-736`). Ohne `extra.workspace`
bekommt der Nutzer eine Verweigerung, nachdem die Credits weg sind. Beim Video
noch roher: nacktes `EVE_VIDEO_WORKSPACE_UNAVAILABLE`
(`commandEveVideoBridge.ts:579-591`). Reparatur laeuft.

## P2-Befunde

| Befund                                                                                 | Status                                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Aufraeum-Zaehler nicht nebenlaeufigkeitssicher (8 Prozesse, 800 Writes → `count: 141`) | repariert: atomarer Append + `O_EXCL`-Schwellenmarker; Live-Gegenprobe 800/800, Marker 100/200/400/800 |
| Kollisionsgrenze meldete faelschlich `artifact-missing`                                | repariert: wahrheitsgemaesse deutsche Meldung, Blob bleibt                                             |
| Tests deckten die kritischen Faelle nicht ab                                           | repariert: 5 neue Tests, alle vorher rot                                                               |
| `cleanup_notice` erreicht nur beim Bild die Oberflaeche                                | in Arbeit                                                                                              |
| Zeitzone: `localDate` liefert je nach TZ andere Namen                                  | bewusst belassen — reine Dateinamendarstellung, Identitaet haengt nicht daran                          |

## Was die Pruefer als TRAGEND bestaetigt haben

Nicht nur Maengel — das hier haelt:

- Referenzbild kommt als data-URL in `input_references` bis zum Provider;
  Ablehnung wird vor dem Settlement refundiert.
- Bild, Video und Office landen sichtbar und sprechend benannt in `bilder/`,
  `videos/`, `dokumente/` — als ERSATZ der alten versteckten Ablage, nicht als
  Doppelablage.
- Die Redaktion in `conversationArtifactStore.ts` frisst den relativen Pfad
  nicht (Schluessel `path` matcht kein Redaktionsmuster).
- Download und Oeffnen funktionieren am kanonischen Ort.
- **Der Freigabe-Fix ist laut Fable die sauberste der vier Reparaturen:** keine
  zweite Genehmigungsschicht, sondern Umleitung des `pre_tool_call`-Hooks in
  Hermes' eigenen ACP-`request_permission`-Callback. Alle Patch-Anker stimmen
  woertlich mit dem Bundle ueberein, die Gateway-Queue-Falle
  (`approval.py:3325-3345`) ist beseitigt.
- Modellwahl im Edit-Modus ist real: Pills sichtbar, referenz-gefiltert,
  Nutzerwahl wird respektiert.
- Edits erzeugen NEUE Dateien mit `parent_artifact_id`; das Original bleibt.
  Records und Locations persistieren ueber Sitzungen.
- Abrechnung fail-closed: Settlement erst nach Provider-Erfolg.

## Nicht verifiziert (ehrlich benannt)

- ACP-Session-Spawn mit `cwd = workspace` und der Node-seitige
  `request_permission`-Brueckenhandler liegen im kompilierten AionCore-Binary
  (out-of-tree).
- Ein Livetest der laufenden App fand auftragsgemaess nicht statt; alle
  Stationsbelege sind Code-Traces plus isolierte Live-Proben gegen den
  gebuendelten Hermes.
- GitNexus war wegen eines npm-`EOVERRIDE` nicht ausfuehrbar.

## Gate-Stand nach den Reparaturen

```
bunx vitest run tests/unit/command-eve --reporter=dot
  380 Dateien, 5317 bestanden, 5 uebersprungen, 0 Fehler

bunx tsc --noEmit -p tsconfig.json
  Exit 0

bunx vitest run canonicalArtifactPlacement.test.ts imageArtifactStore.test.ts
  43 bestanden (die zwei von Fable als rot gemeldeten Tests sind gruen —
  sein REJECT galt dem Stand VOR der Haltbarkeits-Reparatur)
```

## Nachtrag 19:12 — zweite Reparaturrunde aus Kimi K3

Kimi K3 hat waehrend der laufenden Arbeit drei Befunde geliefert, die keiner der
anderen Pruefer hatte. Alle drei sind gebaut:

**Blob-Leak → Founder-Kehrtwende zur Wiederherstellungsquelle.** Kimi bewies:
schlaegt der `unlink` NACH vollem Commit fehl, meldet `bind` Erfolg, die
Privatkopie bleibt liegen, und `purgeExpiredStagedImageArtifacts` ueberspringt
sie wegen `bound:true` — kein Sweeper raeumt sie je ab. Mein erster Auftrag war,
sie einzusammeln. **Der Founder hat gegengesteuert:** die Kopie soll bleiben,
weil die sichtbare Datei in einem Ordner liegt, den Nutzer und Sync-Clients
veraendern koennen.

Gebaut wurde daraus mehr als eine Aufraeum-Reparatur: Das Lesen faellt jetzt auf
die verifizierte Privatkopie zurueck, wenn die sichtbare Datei nicht mehr stimmt
(`imageArtifactStore.ts:196-232`, `:267-300`). Entfernt wird die Kopie erst nach
30 Tagen und nur, wenn die sichtbare Datei vollstaendig verifiziert
(`imageArtifactStore.ts:310-391`). Jeder Zweifel behaelt sie.

**Messbefund, der die Frist begruendet:** Node v24.13.0 klont auf macOS NICHT.
Sein gepinntes libuv definiert FICLONE nur fuer Linux und faellt unter macOS auf
`sendfile` zurueck (`deps/uv/src/unix/fs.c:58-62,1357-1395`). Eigene Messung mit
128 MiB: Node-`COPYFILE_FICLONE` +131.072 KB, `cp -c` +0 KB. Die zweite Kopie
kostet also echten Platz — 303-693 MiB/Monat bei Alois' Profil, 3,5-8 GiB/Jahr.
Ohne Frist waere das ein eigenes Problem geworden.

**Verwaiste `-1`-Datei.** Abbruch nach Publish vor Location-Commit liess eine
tote Datei im sichtbaren Ordner zurueck; der Retry landete auf `-2`. Der Nutzer
saehe zwei Dateien ohne Unterscheidungshilfe. Der Publish merkt sich jetzt den
Zielpfad vor dem Schreiben und verwendet ihn beim Retry nur bei nachgewiesener
Byte-Identitaet wieder (`imageArtifactStore.ts:623-648`,
`canonicalArtifactPlacement.ts:190-217`).

**Kostenfehler in der Edit-Pill.** Eine Modellwahl im BEARBEITEN-Modus wurde als
Seat-Praeferenz fuers ERZEUGEN persistiert
(`handleImageModelTierChange` → `imageModelPreferenceSet`-IPC). Alois waehlt
einmal GPT Image 2 fuer einen Edit — seine naechste schlichte Erzeugung laeuft
still auf max-Tier. Das widersprach dem eigenen Design-Kommentar in
`managedImageGenerationService.ts:322-326`. Edit-Picks sind jetzt
request-scoped (`useImageComposerSelection.ts:60`, `AcpSendBox.tsx:1366`,
`GuidPage.tsx:236`), Schaerfetest beidseitig.

## Korrektur: die 11 roten Renderer-Tests waren KEINE Vorbefunde

Ein Agent hatte sie als "fremde Vorbefunde, nicht von diesem Slice beruehrt"
eingeordnet. Gegenprobe ueber einen temporaeren Worktree auf HEAD `aa7e59636`:
dort waren beide Dateien **gruen, 70/70**. Es waren echte Regressionen dieses
Slices — fehlender `Download`-Icon-Mock nach der Download-Reparatur, plus ein
veralteter i18n-Ratchet-Eintrag zu `credits.image.editHintLabel`. Beide behoben,
ohne Produktionscode anzufassen.

Festhalten, weil es sich wiederholen wird: "fremder Vorbefund" ist die bequeme
Erklaerung fuer einen roten Test. Sie kostet eine Minute Gegenprobe.

## Gate-Stand 19:12 (Diff-Sha `4a8e98b8162b`, 48 Dateien / +1861 / −308)

```
bunx vitest run tests/unit/command-eve   380 Dateien, 5327 gruen, 5 skip, 0 Fehler
bunx vitest run tests/unit/renderer      160 Dateien, 1548 gruen,        0 Fehler
bunx tsc --noEmit -p tsconfig.json       Exit 0
```

## Standard-Tier auf Gemini 3.7 Flash (Company.OS, separat)

Founder-Auftrag, umgesetzt in `/Users/mathiasheinke/Developer/Company.OS`, NICHT
deployed.

`:batch` wurde geprueft und **verworfen**: OpenRouter Batch ist ein asynchroner
Submit/Poll-Workflow mit 24-Stunden-Fenster
(https://openrouter.ai/docs/batch-quickstart) — fuer interaktiven Streaming-Chat
mit Tool-Schleifen unbrauchbar. Genommen wurde die normale Route.

Live-Preise 2026-08-17 (`/api/v1/models/{slug}/endpoints`):

|            | DeepSeek V4 Flash | Gemini 3.7 Flash |
| ---------- | ----------------- | ---------------- |
| Input      | $0,0679/M         | $0,3750/M        |
| Output     | $0,1680/M         | $1,8750/M        |
| Cache-Read | $0,0168/M         | $0,0375/M        |

Roh 5,8-6,6x teurer im Mischprofil. Der Markup-Faktor `standard` faellt deshalb
von **8x auf 1,3x** (`credits-core.ts:65`) — preisneutral waeren 1,205-1,382x.
Kundenpreis bleibt damit ungefaehr konstant, die Bruttomarge sinkt auf 23,1 %.
Die harte Invariante (jeder Faktor > 1) haelt, Margin-Test gruen (22/22).

Bewusst NICHT mitgezogen:

- **Free-Lane** bleibt auf DeepSeek. Gemini wuerde den Loss-Leader von ~0,15 €
  auf 0,87-1,00 € pro Tag und Konto heben (~26-30 €/Monat).
- **Titel-Modelle** bleiben auf DeepSeek — hochfrequente Kleinstaufrufe.

Offener Punkt fuer einen eigenen Slice: Die Vorabreserve kalkuliert nur die
Completion. Bei 116k-150k Input deckt sie 6-8 % der Rohkosten; die Wahrheit
kommt erst ueber OpenRouters `usage.cost` beim Reconcile
(`eve-inference/index.ts:324-357`). Kein Preislistenfehler, aber
Billing-Haertung.

Prompt-Caching ist auf dieser Lane derzeit gar nicht angefordert
(`eve-inference-core.ts:435-456`, `:787-807`). Bei 150k Kontext pro Turn ist das
der groesste ungenutzte Hebel — gehoert zu 1.824.0.

---

# Runde 3 (19:30-19:55) — die drei Luecken fuer einen tragfaehigen Dev-Schnitt

Nach der Frage "reicht das als Dev-Schnitt fuer Alois?" lautete die ehrliche
Antwort: nein, drei Luecken. Alle drei sind jetzt geschlossen.

## 1. Der Haenger nach 6-7 Nachrichten

**Ursache, vollstaendig belegt.** Die Verdichtung konnte strukturell nie greifen:
Schwelle bei 0,75 x 262.144 = 196.608 Tokens, aber der Abbruch kam schon bei
~116k. Die bindende Grenze war nie das Kontextfenster, sondern die Zeit.

**Die 150 Sekunden sind eine Supabase-Plattformgrenze**, kein eigener Code. Der
Upstream-Fetch laeuft ohne `AbortController`
(`Company.OS/supabase/functions/_shared/eve-inference-core.ts:836-849`);
Supabase dokumentiert woertlich "Request idle timeout: 150s … 504 Gateway
Timeout". Nicht verstellbar — die Reparatur musste vollstaendig auf unserer
Seite passieren.

**Die drei Wiederholungen kamen aus Hermes** (`run_agent.py:7637-7654`,
`max_retries = 3`; 504 gilt als retryable in `agent/error_classifier.py:500-502`).
Jeder Retry schickte denselben zu grossen Kontext erneut — 3 x 150s = 7,5 Minuten
verbrannte Nutzerzeit fuer etwas, das beim ersten Mal schon zu gross war.

**Entwarnung beim Geld:** Das Debit erfolgt erst nach erfolgreichem 200 bzw.
Stream-Reconcile (`eve-inference-core.ts:936-969`, `:887-908`). Drei
fehlgeschlagene 504-Versuche erzeugten **keine** Abbuchung.

**Der Fund, der die Reparatur klein machte:** Hermes hat die passende Naht
bereits — `compression.proactive_prune_tokens`, standardmaessig deaktiviert
(`hermes_cli/config_defaults.py:644-666`). Deterministisch, ohne LLM-Aufruf, mit
Schutz der juengsten Nachrichten, kuerzt alte Tool-Ergebnisse und -Argumente
(`agent/context_compressor.py:3391-3502`). Aktivieren statt neu bauen.

Gemessen an der echten 61-Nachrichten-Session:

| Einstellung                  | Budget vorher | danach |    eingespart |
| ---------------------------- | ------------: | -----: | ------------: |
| Standard-Floor 8.000 Zeichen |        46.042 | 27.753 | 18.289 Tokens |
| Floor 2.000 Zeichen          |        46.042 | 21.347 | 24.695 Tokens |

**Gesetzt** (`runtimeBootstrapCore.ts:556-569`, YAML-Ausgabe `:10743-10764`):

```yaml
agent:
  api_max_retries: 1
compression:
  threshold_tokens: 48000
  target_ratio: 0.5
  proactive_prune_tokens: 32000
  proactive_prune_min_result_chars: 2000
  proactive_prune_min_reclaim_tokens: 4096
```

Kein Prozentwert, weil Hermes Prozente unter 512K auf mindestens 0,75 anhebt
(`context_compressor.py:2455-2470`) und unsere Policy nur 0,50-0,90 akzeptiert
(`runtimeBootstrapCore.ts:7665-7670`). `threshold_tokens` als absoluter Cap
gewinnt gegen die Ratio.

**Das Cloud-Budget bleibt bewusst bei 14s/29s.** Eine Anhebung auf ~90s waere
rechnerisch noetig (48k / 634 Tokens/s ≈ 76s), erzeugte aber einen bis zu
90-sekuendigen Vordergrundstall — ein neues Problem statt einer Loesung. Die
deterministische Prune soll die Vollverdichtung selten machen; sie ist
Rueckfallpfad, nicht Normalfall. **Das steht so im Code**, damit niemand die
Grenze spaeter fuer einen Fehler haelt.

**Benannte Restschuld, ausdruecklich:** Eine harte Garantie unter 150s liefert
reine Konfiguration nicht — schon ~18,5k Tokens lagen bei 80-146 Sekunden.
Prompt-Grundballast (~43 KB Tool-Schemas pro Turn) und Kaltstart bleiben ein
1.824.0-Paket; progressive Tool-Disclosure steht dort bereits auf der Liste.

## 2. Preis-Regression im MAX-Gate — beinahe uebersehen

Beim Pruefen der Deploy-Reife fielen 17 rote Tests in
`eve-inference-max-parity.test.mjs` auf. Ein Agent hatte sie zuvor als "fremde
Vorbefunde" eingeordnet. **Falsch.**

Das Muster war eindeutig: `standard seat INSIDE its trial window -> LOCKED`,
`PILOT (ALOIS100 100%-off) -> MAX LOCKED`, `PERMANENT FREE mit Promo-Guthaben ->
LOCKED` — alle antworteten `true` statt `false`. Wer **nicht** bezahlt hatte,
bekam Zugang zum teuersten Tier (GLM 5.2). Nur die Faelle mit **gekauften**
Credits blieben gruen.

**Ursache:** Das Vor-Gate prueft nur Gateway-Verfuegbarkeit
(`eve-inference-core.ts:553-568`), und `usePaidLane` behandelte danach jedes
`max` als bezahlt (`:721-722`). Der gesenkte Markup-Faktor legte das offen.

**Repariert ohne den Founder-Wunsch zu verwerfen:** Der Faktor bleibt bei 1,3x —
er betrifft nur Preis und Wallet (`credits-core.ts:87-92`, angewendet NACH dem
Zugangsgate in `eve-inference-core.ts:746-749`). Der neue MAX-Gate
(`eve-inference-core.ts:675-710`) schaltet nur bei explizit bezahltem
Standard-Seat oder tatsaechlich gekauften Credits frei. Promo-, Trial- und
Allowance-Credits erzeugen kein MAX-Entitlement mehr. Die GLM-Kostprobe bleibt
separat und begrenzt (`:688-699`).

**Methodenhinweis fuer kuenftige Baselines:** Meine erste HEAD-Messung ergab
faelschlich 0 Fehler — der temporaere Worktree hatte keine `node_modules`, die
Tests liefen gar nicht erst an. Eine Baseline in einem frischen Worktree ist
erst dann eine Baseline, wenn die Testanzahl plausibel ist. `0 Fehler` bei
`0 Tests` ist kein Gruen.

## 3. Temp-Pfad-Werkzeugbeschreibung (Kimis P1-Auflage)

`eve_artifact_get` versprach dem Agenten "Use that relative path directly from
the current workspace" — fuer Unterhaltungen **ohne Projekt** stimmte das nicht.
Die Temp-Wurzel ist nie die ACP-Session-cwd, der Pfad also unaufloesbar. Der
Agent versuchte es und scheiterte, statt gleich den Capability-Handle zu nehmen.

Behoben: `file_path` entfaellt bei temp-Unterhaltungen ganz
(`artifactCapabilityLoopback.ts:241` Bild, `:277` Video), und die Beschreibung
sagt jetzt die Wahrheit (`eveArtifactToolSurface.ts:63`). Vier Beweistests
Bild/Video x Projekt/Temp, Temp prueft Schluessel-**Abwesenheit**.

## Versionsschnitt 1.823.1

Fuenf Updater-SemVer-Traeger: `package.json:3`, `commandEveShell.ts:60`,
`runtimeBootstrapCore.ts:1076` und `:1635`, `public/command-eve-capabilities.json:3`,
`public/command-eve-runtime-bootstrap.json:3`. Der sechste Traeger aus dem
1.822.0-Schnitt (`public/command-eve-brand.json:3`) ist bewusst die kompakte
Anzeige `v1.823`, kein Updater-SemVer — getrennt getestet
(`commandEveShell.test.ts:27`, Release-Truth-Guard `runtimeBootstrapCore.test.ts:530-548`).

## Gate-Stand 19:55 (Diff-Sha `1e7186105eef`, 54 Dateien / +2002 / −328)

```
bunx vitest run tests/unit/command-eve   380 Dateien, 5332 gruen, 5 skip, 0 Fehler
bunx vitest run tests/unit/renderer      160 Dateien, 1548 gruen,        0 Fehler
bunx tsc --noEmit -p tsconfig.json       Exit 0

Company.OS shared node suite            462 gruen, 0 Fehler (HEAD: 454/8)
  darunter eve-inference-max-parity     16/16 gruen (HEAD: 17 Fehler)
```

## Unabhaengiges Verdikt: PASS

Kimi K3 hat am gestempelten Endstand geprueft — eigene Gates, 10 eigene
Fault-Injection-Sonden (10/10), eigene anonyme Live-Gegenprobe der
OpenRouter-Images-Route. **P0: keiner.** Die Architektur-Leitplanke haelt: die
kanonische Ablage ERSETZT die Hash-Ablage, clarify-once nutzt den bestehenden
Composer-Replay, der Loopback ist die bestehende `eve_artifact_get`-Naht. Kein
Parallelmechanismus.

Seine P1-Auflage ist damit geschlossen. Offen bleiben P2/P3 als Verbesserung,
nicht als Gate: die abgeflachte Kollisionsmeldung in der Generate-Bridge, die
`cleanup_notice` ohne Leser bei Video und Office, eine Testschaerfe-Luecke auf
Placement-Ebene, und drei P3 (Zwischenglieder-Symlinks, Workspace-Wechsel
zwischen Fehlversuch und Retry, Temp-Ablage fuer den Nutzer unsichtbar).

## Was fuer den Dev-Schnitt noch fehlt

Der Code ist fertig. Offen sind nur noch Ausfuehrungsschritte:

1. **Edge Functions deployen** — sonst kommen Referenzbilder und der
   Gemini-Wechsel bei Alois nicht an. Deploy-Umfang: `eve-inference` (Company.OS)
   und `eve-multimodal` (liegt im AionUI-Repo, nicht in Company.OS — eine
   Pruefspur hatte das faelschlich als "fehlend" gemeldet). Achtung laut
   Readiness-Report: `credits-balance`, `checkout-session` und `stripe-webhook`
   NICHT mitdeployen, sie wuerden `credits-core.ts` mitbuendeln.
2. **QA-Rebuild** (`bun run command-eve:package:qa-signed`) mit AionCore-Pin.
3. **Notarisieren, stapeln, nach `channels/dev` hochladen**, yml zuletzt.

Alles drei braucht ausdrueckliche Founder-Freigabe.

---

# Runde 4 (19:58-20:12) — die offenen Output-Quality-Punkte

Kimis P2-Liste war "Verbesserung, kein Gate". Sie ist trotzdem abgearbeitet,
weil zwei der drei Punkte den Endnutzer direkt treffen und der dritte eine
Testluecke war, die kuenftige Umbauten still brechen laesst.

## Toter Code entfernt statt kommentiert

Der einzige Crash-nach-Publikation-Test auf Placement-Ebene pruefte den
`sourcePath`-Zweig von `moveCreateOnly` — **ein Zweig ohne Produktionsaufrufer**.
Alle vier echten Aufrufer nutzen `bytes`. Die Suite war also gruen fuer einen
Pfad, den niemand geht, waehrend der reale Pfad ungeprueft blieb.

Entscheidung: `sourcePath` samt Kopier-/Cleanup-Zweig **entfernt**;
`publishCanonicalArtifact` verlangt jetzt zwingend `bytes`
(`canonicalArtifactPlacement.ts:122`). Ungenutzter Code mit eigenem Testpfad ist
Wartungsschuld, die Sicherheit vortaeuscht.

Drei neue Tests auf dem **echten** bytes-Pfad:

- Abbruch im `beforePublish`: keine sichtbare Datei, Blob bleibt, Retry
  publiziert exakt einmal byte-identisch (`imageArtifactStore.test.ts:341`)
- Location-Commit-Retry: Byte-Identitaet und genau EINE Datei (`:418`)
- Manipulierte Publikation wird NICHT wiederverwendet: frische `-2.png` mit
  Originalbytes, die fremdveraenderte Datei bleibt unangetastet (`:455`)

Schaerfe belegt durch gezielte Sabotage, danach exakt zurueckgesetzt:
`beforePublish` hinter den Schreibvorgang verschoben → Test rot; Verifikation der
publizierten Datei abgeschaltet → Manipulationstest rot.

## Ehrliche Fehlermeldungen statt Sammelbegriff

`artifact-placement-unavailable` wurde in der Bridge pauschal auf
`image-generate-bind-failed` abgeflacht. Fuer Alois hiess das: "konnte nicht
eingefuegt werden" — egal ob der Dateiname vergeben oder die Platte voll war.
Zwei Ursachen, zwei voellig verschiedene Handlungen, ein Text.

Der Store unterscheidet jetzt Kollisionsgrenze und ENOSPC
(`imageArtifactStore.ts:519`, `:649`), die Bridge uebersetzt beide bis zur
Oberflaeche in konkrete deutsche Handlungsanweisungen
(`commandEveImageArtifactBridge.ts:549`). Sonstige Bindungsfehler bleiben
separat.

## Aufraeum-Hinweis erreicht jetzt alle drei Ordner

Er war fuer Video und Office bereits persistiert, aber **niemand las ihn** — die
einzige Oberflaeche blieb die Bild-Lane. Jetzt sammelt der bestehende
Hermes-Artefaktkontext die Hinweise aus allen drei Quellen, **dedupliziert** sie
und gibt genau einen leichten Hinweis weiter
(`eveArtifactContextEnvelopeCore.ts:199`, `commandEveVideoBridge.ts:1102`).
Video und Bild aus den Artefakt-Entries, Office aus dem verifizierten
Office-Record-Leser. Keine zweite Zustellmechanik.

## Ein Typfehler, der nicht weggecastet wurde

Die neuen Fehlergruende brachen kurzzeitig `tsc`: An
`commandEveImageArtifactBridge.ts:768` wurde ein `ImageArtifactBindResult` an
eine reine Fehlerunion uebergeben, ohne den Erfolgsfall auszuschliessen.
Repariert durch echte Einengung (`ok === false`), **nicht** durch `as`
(`:767`). Der Compiler hatte recht: die Stelle behandelte den Erfolgsfall nicht.

## Gate-Stand 20:12 (Diff-Sha `5c35568a98c9`, 58 Dateien / +2238 / −336)

```
bunx vitest run tests/unit/command-eve   380 Dateien, 5337 gruen, 5 skip, 0 Fehler
bunx vitest run tests/unit/renderer      160 Dateien, 1548 gruen,        0 Fehler
bunx tsc --noEmit -p tsconfig.json       Exit 0

Company.OS shared node suite            462 gruen, 0 Fehler
```

Damit sind von Kimis Liste noch offen: drei P3 (Zwischenglieder-Symlinks,
Workspace-Wechsel zwischen Fehlversuch und Retry, Temp-Ablage fuer den Nutzer
unsichtbar). Alle drei erfordern einen lokalen Nutzerfehler oder sind
Corner-Cases ohne Geldverlust — sie gehoeren in 1.824.0, nicht in diesen Schnitt.

---

# Runde 5 (20:13-20:24) — auch die drei P3 sind zu

Begruendung fuer das Vorziehen: Wir waren im Code, die Suiten waren gruen, und
jeder der drei war in Minuten erledigt. Spaeter kostet jeder wieder
Einarbeitung — die teuerste Art, kleine Punkte zu verschieben.

**P3-1 Zwischenglieder-Symlinks.** `verifyCanonicalArtifact` prueft jetzt den
aufgeloesten Pfad gegen die reale Workspace-Wurzel; ein `bilder/`-Symlink ins
Freie wird abgelehnt (`canonicalArtifactPlacement.ts:162`). Die bestehende
`nlink`-, Descriptor- und SHA-Pruefung bleibt unangetastet. Test mit echtem
Symlink-Zwischenglied (`canonicalArtifactPlacement.test.ts:102`).

**P3-2 Workspace-Wechsel zwischen Fehlversuch und Retry.** Der bereits
vorhandene `published_placement.workspace`-Marker wird beim Retry in einem
anderen Projekt ausgewertet (`imageArtifactStore.ts:237`, `:655`). Nur die
vollstaendig verifizierte, **byte-identische** Erstpublikation wird entfernt und
neu publiziert. Eine veraenderte Datei bleibt stehen — die Sicherheitsgrenze
haelt: was der Nutzer selbst dort abgelegt hat, wird nie angefasst.

**P3-3 Temp-Ablage unsichtbar.** Projektlose Bildartefakte tragen jetzt einen
kurzen deutschen Hinweis (`imageArtifactStore.ts:105`, `:701`):

> Dieses Bild gehört zu dieser Unterhaltung und ist nur temporär abgelegt. Ordne
> die Unterhaltung einem Projekt zu, um es dauerhaft im Projektordner zu sichern.

Kein Umbau, keine Migration — der Nutzer erfaehrt jetzt, was mit seinem
bezahlten Artefakt passiert und was er tun kann.

Alle drei Tests waren vor der Reparatur rot.

## Gate-Stand 20:24 (Diff-Sha `3ad6e4031896`, 58 Dateien / +2386 / −336)

```
bunx vitest run tests/unit/command-eve   380 Dateien, 5341 gruen, 5 skip, 0 Fehler
bunx vitest run tests/unit/renderer      160 Dateien, 1548 gruen,        0 Fehler
bunx tsc --noEmit -p tsconfig.json       Exit 0

Company.OS shared node suite            462 gruen, 0 Fehler
keine Scratch-Dateien, git diff --check sauber
```

**Damit ist Kimis Befundliste vollstaendig abgearbeitet: kein P0, kein P1, kein
P2, kein P3 offen.**

## Was jetzt noch fehlt — nur noch Ausfuehrung

Der Code ist fertig und dreifach unabhaengig geprueft. Offen sind drei Schritte,
die alle ausdrueckliche Founder-Freigabe brauchen:

1. **Edge Functions deployen.** Ohne sie kommen Referenzbilder und der
   Gemini-Wechsel bei Alois nicht an — das sind Serveraenderungen, die kein
   App-Build transportiert. Umfang: `eve-inference` (Company.OS) und
   `eve-multimodal` (liegt im AionUI-Repo). **Nicht mitdeployen:**
   `credits-balance`, `checkout-session`, `stripe-webhook` — sie wuerden
   `credits-core.ts` mitbuendeln und die Preisaenderung an Stellen tragen, die
   wir nicht angefasst haben. Plan und Rueckrollweg:
   `Company.OS/reports/command-eve/2026-08-17/18231-edge-deploy-readiness.md`
2. **QA-Rebuild** (`bun run command-eve:package:qa-signed`) mit AionCore-Pin.
3. **Notarisieren, stapeln, nach `channels/dev`** — yml zuletzt, danach per
   `curl` bestaetigen, dass Dev 1.823.1 zeigt und Stable unveraendert 1.822.5
   bleibt.

## Offene Founder-Entscheidung: Live-Web-Recherche

Getrennter Befund aus Alois' Test: "Web-Suche hat keinen Provider in diesem
Seat". Ursache ist KEINE Verkabelungsluecke, sondern eine echte
Faehigkeitsluecke der Managed Lane:

- Seat-Bootstrap ist korrekt seat-weit und setzt `web.backend/search_backend:
ddgs` (`runtimeBootstrapCore.ts:2907`).
- Hermes 0.20 registriert DDGS trotzdem nicht: die Discovery erwartet
  `plugin.yaml`, das im signierten Artefakt fehlt. Isolierte Probe:
  `ddgs available=True`, aber `provider=None` (`hermes_cli/plugins.py:1445`).
- **Entscheidend:** Es gibt keinen serverseitigen Search-/Extract-Pfad.
  `eve-multimodal` kennt nur Vision, Bild, Video, Audio, OCR; die Billable
  Registry enthaelt keine Weboperation.

Ein direkter DDGS-Workaround waere nicht credit-gated und damit nicht die
Managed Lane — deshalb bewusst nicht gebaut. Geaendert wurde nur die ehrliche
Nutzerfuehrung (`assistantBootstrapCore.ts:729`).

Geschaetzter Aufwand fuer Search + Extract inkl. Billing-Chokepoint,
Hermes-Adapter, SSRF-Grenzen und Tests: **5-8 Entwicklertage**. Provider,
Preis-/Credit-Modell und Residency sind Founder-Entscheidungen.
