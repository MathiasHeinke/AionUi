---
name: autor-studio
description: 'Dach und Intent-Router für Schreibaufträge, mit belastbaren Pfaden für Essay, Kurzgeschichte und Sachbuch sowie einem vorbereitenden, zustandsgeführten Romanpfad. Nutze diesen Skill für genregebundene Schreibaufträge und die Wahl des passenden Produktionspfads. Gemeinsame Grundform: Voice, Kern, Skelett, Entwurf, Blind-Review, Straffung, Autoren-Abgleich und Export mit Human-Gate. Das gewünschte Genre bleibt verbindlich: Ein Essay-Auftrag erzeugt keinen Buchentwurf. Andere Textformen werden in ihrem genannten Format weitergegeben, nie umgedeutet. Orchestriert essay-writer für Essays und book-publishing für Buchproduktion/KDP.'
---

# Autor Studio — eine Grundform, vier Genres

## Was dieser Skill ist

Der Einstieg und Intent-Router für Schreibaufträge. Er enthält für Essay,
Kurzgeschichte, Sachbuch und Roman die gemeinsame **Grundform** und die jeweils
eigene Struktur. Er dupliziert nicht: Essay-Handwerk liefert **essay-writer**,
Produktion und KDP liefert **book-publishing**.

## Die Intent-Regel (verbindlich)

**Das genannte Genre ist das gelieferte Genre.** «Schreib einen Essay» → ein Essay. «Schreib eine Kurzgeschichte» → eine Kurzgeschichte. Niemals aus einem Essay-Auftrag ein Buch bauen. Wenn ein Text offensichtlich mehr tragen könnte, wird die Eskalation NACH der Lieferung als Vorschlag formuliert („Das könnte Kapitel 1 eines Buchs werden — willst du das?"), nie still ausgeführt.

Nennt der Auftrag eine andere Textform — etwa Rede, Blogpost, Drehbuch, Brief
oder Gedicht — bleibt genau diese Form verbindlich. An einen passenden Skill
weiterleiten, wenn einer existiert; sonst die Form direkt bearbeiten oder nur
bei einer ergebnisrelevanten Unklarheit nachfragen. Nie ersatzweise Essay,
Kurzgeschichte, Sachbuch oder Roman wählen. Ändert eine Unklarheit Form,
Fiktion/Nonfiction, Längenkorridor oder Evidence-/Kanon-Pipeline — etwa bei
„Schreib ein Buch" — **stoppen und das Genre vor Skelett oder Draft bestätigen
lassen**. Nur folgenlose Detailannahmen dürfen sichtbar markiert werden.

## Die Grundform (gilt für alle Genres)

1. **Voice zuerst** — vorhandenes Autorenprofil oder freigegebene Samples laden.
   Fehlen sie, mit vorhandenem Material in einer sichtbar provisorischen,
   neutralen Stimme arbeiten oder gezielt Samples erfragen; nie eine konkrete
   fremde Stimme vortäuschen. Fremdautor: dessen Profil, Freigabe und Seat.
   Fiktive Persona: deren Kanon-Datei als oberste Wahrheit.
2. **Kern in einem Satz** — These (Essay/Sachbuch) oder Prämisse (Kurzgeschichte/Roman). Kein Kern, kein Entwurf.
3. **Skelett vor Entwurf** — Struktur mit Funktion pro Abschnitt/Kapitel, vom Autor abgenickt bei langen Formen.
4. **Entwurf → Blind-Review → Reparatur → Straffung** — getrennte Durchgänge; Straffung −15 bis −20 % mit Schutzregeln (nie streichen: Bruchszene/Schlüsselszene, Punchlines, Verortung).
5. **Wahrheitsdisziplin je nach Genre** — Essay/Sachbuch: jede harte Behauptung belegt (Claim-Inventory) oder als These markiert. Fiktion: Welt- und Figurenkonsistenz statt Quellen (Kanon-Widersprüche = Fehler).
6. **Autoren-Abgleich** der Kernstellen (Bruch-/Schlüsselszene, persönliche Passagen). Autoren-Korrektur = Ground Truth. Danach keine autonomen Edits.
7. **Export synchron** (MD-Master, DOCX/PDF über EVEs verwalteten Dokument-
   Runtime; Buch: Build-Pipeline). Pandoc oder Office-CLIs nur als bereits
   vorhandene, separat verwaltete Spezial-Toolchain verwenden — niemals im
   Nutzerauftrag installieren. **Human-Gate vor jeder Veröffentlichung.**

## Die vier Genres

### 1. Essay (3.500–6.000 Wörter)

Persönlich-philosophischer Weltbild-Essay mit autobiografischem Kern. Struktur: die 12 Bausteine (These-Satz, Heldenreise, konkrete Bruchszene, Eskalationsbogen Ich→Wir→Welt, Selbst-Einwand, kuratierte Verweise 5–10, Immunisierung, 3–7 Aphorismen, Vakuum-Dynamik, Ringschluss, sauberer Apparat, Redaktionsnotiz). **Ausführung: essay-writer laden und folgen.**

### 2. Kurzgeschichte (1.000–7.500 Wörter)

Eine Erzählung, ein Bogen, ein POV. Struktur: Prämisse in einem Satz → eine zentrale Figur mit einem Mangel → EINE Schlüsselszene als Wendepunkt → Ende, das den Anfang neu lesbar macht. POV-Disziplin (kein Kopfwechsel), show don't tell, kein Quellenapparat. Straffung gilt ebenso; Dialog wird laut gelesen.

### 3. Sachbuch (50.000–90.000 Wörter)

Orchestrierte Kapitel, jede Kapitel-Thesis trägt einen Teil der Buchthese. Ablauf: Buchthese + Phasen-Dramaturgie (z. B. Aufwachen → Verstehen → Energie → Aktion) → Kapitel-Map → pro Kapitel das Sachkapitel-Muster (Aufhänger → These → Beweis → Konsequenz → Überleitung) → Claim-Inventory buchweit → Produktion und Publish mit **book-publishing** (Stufen 1–12). Kapitelstatus im vorhandenen Projekt-Ledger führen; ohne Ledger ist `manuscript-status.md` die lokale Statuswahrheit.

### 4. Roman (60.000–120.000 Wörter)

Narrative Architektur vor Szenenschreiben: Prämisse → `story-canon.md`
(Figuren, Wollen vs. Brauchen, Wunde, Beziehungen, Weltregeln, Zeitlinie) →
Akt-Struktur → `chapter-map.md` → Szenen-Kapitel (jede Szene verändert etwas)
→ Mittelpunkt-Spiegelung → Finale, das die Prämisse beantwortet. Nach jedem
Kapitel `manuscript-status.md` mit Kanon-Revisionen, offenen Fäden, Wortzahl
und nächstem Einstieg aktualisieren; vor dem nächsten Kapitel Kanon und letzte
Statuszeile laden. Der Konsistenz-Audit prüft POV, Namen, Weltregeln,
Kausalität und Zeitlinie. Produktion ab Redaktion via **book-publishing**.

Dieser Romanpfad ist **preparatory**, bis er an einem vollständigen Romanlauf
geschärft wurde. Keine 60–120k-Produktion allein aus diesem Absatz starten:
Prämisse, Kanon, Kapitel-Map, Resume-Protokoll und explizite Autorenfreigabe
müssen vorher stehen.

## Eskalationspfad Essay → Buch (nur auf Entscheidung)

1. Der Essay steht fertig; sein These-Satz wird Buchthese-Kandidat.
2. Die „Nächste Tür"-Notizen aus Essay-Redaktionsnotizen werden Kapitel-Map-Rohmaterial.
3. Autor entscheidet explizit: Essay-Serie oder Buch.
4. Bei Buch: Übergang in Genre 3/4 — Phasen-Dramaturgie, Kapitel-Map, dann book-publishing.

## Qualitätsschwellen (genre-übergreifend)

- Genre-Struktur eingehalten und Länge im Korridor des Genres
- Kern-Satz existiert und trägt den Text
- Straffung mit Wortzahl vorher/nachher belegt
- Voice-Check: klingt wie der Autor (bzw. die Persona), nicht wie generische KI
- 0 unbelegte harte Behauptungen (Nonfiction) bzw. 0 Kanon-Widersprüche (Fiktion)

## Hard rules

- **Intent ist verbindlich** — kein Genre-Drift ohne ausdrückliche Autoren-Entscheidung.
- **Kein Publish ohne Human-Gate**; Rechte-/Territorien-Attestierung,
  ISBN-/Imprint-Wahl, KI-Offenlegung, DRM, KDP Select, Preisfreigabe,
  öffentliche Launch-Aktionen und finaler Klick bleiben beim Menschen
  (book-publishing).
- **Per-client isolation** — Stimmen, Personas, Manuskripte nie über Seats mischen.
- **Keine erfundenen Quellen, Belege oder Stimmen.**
