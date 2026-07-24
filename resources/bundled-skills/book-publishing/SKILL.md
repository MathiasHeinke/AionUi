---
name: book-publishing
description: 'A-bis-Z-Produktionspipeline für Sachbuch oder Roman: Positionierung, genreabhängige Evidence- oder Kanon-Arbeit, Draft, unabhängiger Audit, Front-/Backmatter, Print-PDF, Cover, EPUB, KDP-Konto, Paperback, Kindle und Launch. Nutze diesen Skill, um ein Buch zu veröffentlichen, auf KDP zu bringen, ein Print-PDF oder EPUB zu bauen oder die Buchproduktion zu steuern. Literarisches Schreiben bleibt bei autor-studio. Rechte, ISBN/Imprint, KI-Offenlegung, DRM, KDP Select, Preis, öffentliche Launch-Aktionen und finaler Publish-Klick sind Human-Gates.'
---

# Book Publishing (A–Z, Idee → KDP-live)

## Was dieser Skill ist — und was nicht

Die Produktions- und Veröffentlichungspipeline für Bücher. Er schreibt nicht
die literarische Qualität einzelner Kapitel (das ist **autor-studio**), sondern
führt genreabhängig von Evidence- oder Kanon-Arbeit über Audit und Build bis zum
vorbereiteten Livegang auf Amazon KDP (Taschenbuch + Kindle). Der Agent bereitet
Dateien, Prüfungen und Decision Cards vor; authentifizierte KDP-Uploads,
Formularbestätigungen und Publikationsmutationen führt der Mensch aus.

## Goldene Regeln (teuer gelernt)

1. **Wirkungsziel genreabhängig festlegen.** Sachbuch kann Umsatzprodukt,
   Autoritäts-Asset oder Lead-Kanal sein; Roman kann Leseraufbau, Serienbindung,
   Verkäufe oder Reads priorisieren. Kein Funnel ist Pflicht. Ziele getrennt
   messen (Stufe 12).
2. **Publikationsentscheidungen bleiben beim Menschen.** Dazu gehören Rechte
   und Territorien, ISBN/Imprint, KI-Offenlegung, DRM, KDP Select, Preis,
   öffentliche Launch-Aktionen und der finale Publish-Klick. KDP erlaubt
   DRM-Änderungen seit 2026, aber bereits heruntergeladene DRM-freie Dateien
   bleiben bei Lesern.
3. **Sensible Felder bleiben beim Menschen:** Login, Steuer-Interview,
   Bankdaten und Rechts-/Steuer-Attestierungen. Der Agent darf Entwürfe und eine
   Decision Card vorbereiten, aber keine Auswahl bestätigen oder absenden.
4. **Preislogik live verifizieren:** KDP behandelt Print- und eBook-Listenpreise in EU-Märkten unterschiedlich. Vor jedem Release die aktuelle KDP-Preisvorschau, USt.-Behandlung und Tantiemenstufe prüfen; keine historischen Schwellen blind übernehmen.
5. **EPUB immer mit `--syntax-highlighting=none`** bauen, sonst schneidet Kindle Code-Blöcke ab.
6. **Keine harte Zahl ohne belegte Quelle.** Quellen-URLs vor dem finalen Build auf Erreichbarkeit und passenden Zielinhalt prüfen; Weiterleitungen sind erlaubt, tote oder inhaltlich falsche Ziele nicht.

## Die 12 Stufen (Runbook)

1. **Konzept & Positionierung** — Kernbotschaft, Zielleser, Abgrenzung, Arbeitstitel. Output: positioning.md.
2. **Research, Evidence oder Kanon** — Sachbuch: jede harte Behauptung bekommt
   Claim-ID, Beweisklasse und Quelle. Roman: Figuren-, Welt- und Zeitlinien-
   Kanon mit bewusst markierten offenen Fragen. Output genreabhängig:
   `claim-inventory.md` + `sources.md` oder `story-canon.md`.
3. **Draft (body.md)** — Ganzes Manuskript in EINER Markdown-Datei. Kapitel =
   `# Kapitel N: Titel`, Abschnitte = `##`. Sachbuch: Aufhänger → These →
   Beweis → Konsequenz → Überleitung. Roman: Szene → Ziel/Konflikt → Veränderung
   → Folgewirkung; jeder Bruch gegen den Kanon wird markiert. Literarisches
   Kapitel-Handwerk kommt aus dem gewählten **autor-studio**-Buchpfad, nie aus
   `essay-writer`.
4. **Redigieren & Audit** — drei getrennte Durchgänge: (A) unabhängiger
   Blind-Audit: beim Sachbuch Claims/Hypothesen/Zahlen, beim Roman POV, Kanon,
   Kausalität und Zeitlinie; Verdikt pro Kapitel: PASS / PASS_WITH_PATCHES /
   REJECT. (B) Ceiling-Review für Stimme, Schärfe, Kadenz und Redundanzen,
   inklusive Straffung. (C) Sachbuch: Quellen-/Glossar-Konsistenz; Roman:
   Kanon-/Namens-/Zeitlinien-Konsistenz. **Nach dem finalen Autoren-Read keine
   autonomen Body-Edits mehr.**
5. **Front-/Backmatter** — Impressum, Widmung, TOC und genrepassende
   Autoren-/Serien-/optionale CTA-Seite. Templates:
   `references/templates/frontmatter.tex`, `backmatter_cta.tex`.
6. **Interior-Build (Print-PDF)** — pandoc + tectonic, `--top-level-division=chapter`. Skript: references/templates/build_interior.sh, header.tex. QA: references/checklists/pre_publish_qa_checklist.md.
7. **Cover & Rückseite** — Wrap-Geometrie (Rückenbreite aus Seitenzahl), Front-Bild via Bildgenerator, Rückseiten-Text. Templates: cover_wrap.tex, back_cover.tex, front_cover_green.tex.
8. **eBook-Build (EPUB)** — pandoc mit epub.css, `--syntax-highlighting=none`. Skript: build_ebook.sh; ebook_front.md, ebook_cta.md.
9. **KDP-Konto & Steuer** — Konto, wirtschaftlich Berechtigten, Steuerprofil und Bankverbindung anhand der tatsächlichen Rechts-/Steuersituation klären. **Mensch bzw. Steuerberatung führt aus.**
10. **KDP Publish Paperback** — Print-Listenpreis, aktuelle Tantiemenstufe,
    Druckoptionen und Probedruck prüfen. Rechte, Territorien, ISBN/Imprint,
    Preisfreigabe und Publish sind Human Gates.
11. **KDP Publish Kindle** — eBook-Preis und aktuelle Bedingungen prüfen.
    Rechte, KI-Offenlegung, DRM, KDP Select, Preis und Publish sind Human Gates.
12. **Launch & Funnel** — passendes Ziel für Sachbuch oder Roman definieren;
    öffentliche Posts, Mailings, Reviewer-Anfragen oder bezahlte Maßnahmen nur
    nach menschlicher Freigabe ausführen.

## Detail-Runbooks (nur die aktuelle Stufe laden)

Vor Beginn einer Stufe die direkt verlinkte Phasen-Datei vollständig lesen.
Checklisten und Templates erst laden, wenn die Phase sie nennt. Nicht alle
Referenzen pauschal in den Kontext ziehen.

1. [Konzept & Positionierung](references/01_concept_and_positioning.md)
2. [Research, Evidence und Kanon](references/02_research_and_evidence.md)
3. [Draft](references/03_drafting.md)
4. [Redigieren & Audit](references/04_editing_and_audit.md)
5. [Front-/Backmatter](references/05_frontmatter_backmatter.md)
6. [Print-Interieur](references/06_interior_build_print_pdf.md)
7. [Cover & Rückseite](references/07_cover_and_back.md)
8. [EPUB](references/08_ebook_build_epub.md)
9. [KDP-Konto & Steuer](references/09_kdp_account_and_tax.md)
10. [KDP Taschenbuch](references/10_kdp_publish_paperback.md)
11. [KDP Kindle](references/11_kdp_publish_kindle.md)
12. [Launch & Funnel](references/12_launch_and_funnel.md)

## Human-Decision-Matrix

| Entscheidung oder Mutation              | Agent darf                                                        | Mensch entscheidet/führt aus                              |
| --------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| Rechte, Territorien, Steuer-/Bankprofil | Fakten und Optionen vorbereiten                                   | attestieren, speichern, absenden                          |
| ISBN und Imprint                        | Optionen, Folgen und Datenabgleich darstellen                     | ISBN wählen/zuweisen und Imprint bestätigen               |
| KI-Offenlegung                          | verwendete Verfahren inventarisieren, Formularantwort vorschlagen | Antwort bestätigen und absenden                           |
| Titel, Cover und öffentliche Metadaten  | Varianten, QA und Preview vorbereiten                             | finale öffentliche Fassung freigeben                      |
| DRM und KDP Select                      | Folgen und Distributionskonflikte darstellen                      | auswählen oder ändern                                     |
| Preis und Release-Termin                | aktuelle Vorschau, Marge und Alternativen berechnen               | Preis und Termin freigeben                                |
| Publish                                 | Preflight und Decision Card erstellen                             | final klicken                                             |
| Launch, Reviewer, Mailings, Posts, Ads  | Entwürfe, Listen und Budgetvorschlag erstellen                    | externe Sends, Spend und öffentliche Mutationen freigeben |

## Werkzeuge (Voraussetzung)

`pandoc` ≥ 3.9, `tectonic` (XeTeX, baut Print-PDF ohne TeX-Live), `poppler`
(`pdfinfo`/`pdftoppm`), ein Bildwerkzeug (`sips` auf macOS oder ImageMagick
`magick` plattformübergreifend) und optional ein Bildgenerator fürs Cover.

Diese Spezialwerkzeuge bilden einen optionalen, separat signierten Publishing-
Toolchain-Pack und gehören nicht zum normalen Dokument-Runtime-Pack. Vor Phase 6
einmal read-only preflighten. Fehlt etwas, `BLOCKED_CAPABILITY` mit dem konkreten
Werkzeug melden und die editierbaren Quellen liefern; niemals während eines
Nutzerauftrags per Homebrew, pip oder anderem Paketmanager installieren und
keinen stillen Erstlauf-Download durch Tectonic auslösen.

## Output

- `positioning.md`, `body.md` (Single Source) und genreabhängig
  `claim-inventory.md` + `sources.md` oder `story-canon.md`
- Print-PDF (Interior) + Cover-Spread + EPUB
- Geprüfte Publish-Checklisten; Livegang nur nach menschlichem Gate

## Hard rules

- **Publikationsentscheidungen sind Human-Gates.** Kein Agent bestätigt Rechte,
  Territorien, ISBN/Imprint, KI-Offenlegung, finale Titel-/Cover-/Metadaten,
  DRM, KDP Select, Preis, öffentliche Launch-Mutationen oder „Veröffentlichen".
- **Keine erfundenen Quellen/Zahlen oder Kanon-Fakten** — Claim-/Kanon-Inventory,
  sichtbare Unsicherheit oder Streichung.
- **Keine Body-Edits nach finaler Autoren-Freigabe** ohne erneute Freigabe.
- **Per-client isolation** — Manuskripte, Personas und Konten eines Mandats bleiben im Seat.
- **Interne Claim-IDs sind nie Lesertext.** Vor dem Freeze in lesbare
  Fußnoten/Endnoten und Bibliografie übersetzen; `body.md` darf beim Build keine
  Arbeits-ID wie `CH03-C001` mehr enthalten.
