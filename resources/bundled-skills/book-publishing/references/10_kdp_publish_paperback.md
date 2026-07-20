---
phase_id: book-10-kdp-publish-paperback
phase: 10
title: KDP Publish — Taschenbuch
when_to_use: Wenn interior.pdf + cover_wrap.pdf final sind.
inputs: interior.pdf, cover_wrap.pdf, Metadaten, Preis
outputs: zur Veröffentlichung eingereichtes Taschenbuch + KDP-Status/Receipt
human_gate: Rechte, ISBN/Imprint, Territorien, Preis, Release-Termin und Publish = Mensch
portable: true
---

# 10 · KDP Publish — Taschenbuch

Browser-Flow auf kdp.amazon.com → „Neuen Titel erstellen" → **Taschenbuch**.
Der Agent darf Felder und Optionen vorbereiten, aber keine Rechte attestieren,
ISBN zuweisen, Territorien oder Preis bestätigen und nicht veröffentlichen.

## Tab 1 — Details
- Sprache, **Buchtitel** + **Untertitel**, Serie (überspringen), Auflage, **Autor**,
  Mitwirkende (optional).
- **Beschreibung** (Verkaufstext, ~200–4000 Zeichen; Schmerz → Versprechen → für wen).
- Veröffentlichungsrechte: tatsächliche Rechtslage dokumentieren; **der Mensch
  attestiert die zutreffende Auswahl**.
- **KI-Offenlegung:** verwendete KI-generierte Texte, Bilder (einschließlich
  Cover) und Übersetzungen formatübergreifend inventarisieren. Aktuelle
  KDP-Definition lesen; **der Mensch bestätigt und sendet die Antwort**.
- **Keywords** und **Kategorien** nach den aktuell im KDP-Formular angebotenen Feldern
  ausfüllen; keine historische Feldanzahl voraussetzen.
- Altersfreigabe und Release-Termin anhand des Launch-Plans vorbereiten; der
  Mensch entscheidet zwischen sofortiger und geplanter Veröffentlichung.

## Tab 2 — Inhalt
- **ISBN/Imprint:** kostenlose KDP-ISBN und eigene ISBN vergleichen. KDPs freie
  ISBN gilt nur auf KDP und führt zum Imprint „Independently published"; eigene
  ISBN muss mit den Daten der ISBN-Agentur übereinstimmen. **Nicht autonom
  zuweisen.**
- **Druckoptionen:** Papier (weiß/creme), **Trimmgröße 6×9**, Bleed, Cover matt/glänzend.
- **Mensch lädt nach Preflight hoch:** `interior.pdf`.
- **Mensch lädt das freigegebene Cover hoch:** `cover_wrap.pdf` (oder Cover Creator). Hier auch das **Cover-Template
  herunterladen** (exakte Maße + Barcode-Zone, Stufe 07).
- **Vorschau starten (Previewer):** Ränder/Bleed/**Bundsteg** prüfen. Häufigster Fehler:
  „Unzureichender Bundsteg" durch überlaufende URLs → zurück zu Stufe 06 (URL-Fix).
- Agent prüft bereitgestellte Preview-Screenshots/Report; der Mensch
  **genehmigt die Buchvorschau** im KDP-Konto.

## Tab 3 — Rechte & Preisgestaltung
- **Gebiete:** nur die Territorien auswählen, für die tatsächlich
  Veröffentlichungsrechte vorliegen; **menschliche Attestierung**.
- **Primärer Marktplatz:** z.B. Amazon.de.
- **Tantieme:** KDP nutzt aktuell preisabhängig **50 % oder 60 %** für Amazon-Verkäufe
  (auf Amazon.de derzeit 60 % ab 9,99 EUR Listenpreis; Schwelle vor jedem Release live prüfen),
  jeweils abzüglich Druckkosten. Expanded Distribution folgt einer eigenen Stufe.
- **Listenpreis exklusive lokaler USt.** eingeben. KDP zeigt den geschätzten Kundenpreis
  inklusive Steuer sowie Druckkosten und Tantieme; die Live-Vorschau ist maßgeblich.
- **Veröffentlichen** ← **menschlicher Klick nach Decision Card.** Keine feste
  Prüf- oder Live-Zeit versprechen; den von KDP angezeigten Status beobachten.

## Outputs

- Taschenbuch im Bücherregal, „Wird geprüft" → live

## Live-Quellen vor dem Human-Gate

- Paperback-Tantiemen und aktuelle Schwellen:
  https://kdp.amazon.com/en_US/help/topic/G201834330
- EU-/UK-Steuerbehandlung für Print-Listenpreise:
  https://kdp.amazon.com/de_DE/help/topic/GPQL5W3J6WNRCZTV
- ISBN- und Imprint-Optionen:
  https://kdp.amazon.com/en_US/help/topic/GTJ8LBXL6Z4WV5QX
- Geplantes Print-Release:
  https://kdp.amazon.com/en_US/help/topic/GDTMGBCWHAY35NK4
- KI-generiert vs. KI-assistiert:
  https://kdp.amazon.com/en_US/help/topic/G200672390

## Gotchas

- Previewer-Fehler ernst nehmen — nicht „trotzdem veröffentlichen".
- Steuerbehandlung oder Tantiemenstufe verwechselt = falscher Kundenpreis bzw. falsche Marge.
  Die Marketplace-Vorschau vor dem Human-Gate prüfen.
- Kategorien/Keywords bestimmen Auffindbarkeit stärker als der Titel — sorgfältig wählen.
