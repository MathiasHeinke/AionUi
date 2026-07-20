---
phase_id: book-07-cover-and-back
phase: 7
title: Cover & Rückseite (Print-Wrap)
when_to_use: Wenn interior.pdf steht (Seitenzahl bekannt).
inputs: Seitenzahl, Titel, Autor, Klappentext, Autorenbio, Front-Bild
outputs: cover_wrap.pdf (Vorderseite + Rücken + Rückseite in einem)
templates: cover_wrap.tex, front_cover_green.tex, back_cover.tex (preview only), book-metadata.example.json, tex_metadata.py
tools: Bildgenerator (GPT Image 2.0 o.ä.), tectonic
portable: true
---

# 07 · Cover & Rückseite (Print-Wrap)

Ein Print-Cover ist **ein** durchgehendes Bild: Rückseite | Buchrücken | Vorderseite,
plus Anschnitt (Bleed) rundum. Die Rücken-Breite hängt an der Seitenzahl.

## Geometrie (der springende Punkt)

- **Buchrücken-Breite** hängt von Seitenzahl, Papier und dem aktuell gültigen KDP-Faktor ab.
  Nutze die Werte nur zur Vorplanung und übernimm die finalen Maße aus dem live erzeugten
  KDP-Cover-Template.
- **Anschnitt (Bleed):** 0,125" an jeder Außenkante.
- **Gesamtbreite** = 2×Trim-Breite + Rücken + 2×Bleed. **Gesamthöhe** =
  Trim-Höhe + 2×Bleed. Die konkreten Werte kommen aus dem KDP-Template.
- **Autoritativ ist das KDP-Cover-Template:** In der KDP-Content-Seite (Stufe 10) kannst du
  ein PDF/PNG-Template mit **exakten** Maßen + eingezeichneter Barcode-Zone herunterladen.
  Immer dagegen bauen. `templates/cover_wrap.tex` ist die TikZ-Umsetzung dieses Layouts.

## Vorderseite (Front-Bild)

- Optional generieren oder gestalten: **1800×2700 px** = 6×9 bei 300 dpi,
  randlos. Herkunft und Bearbeitung in `ai-content-inventory.md` festhalten;
  KI-generierte Coverelemente fallen unter die KDP-Offenlegung.
- Brief: knallt als Thumbnail, premium, Titel groß + lesbar, ein starkes Motiv.
- Kein Text vom Generator „einbrennen" lassen, wenn du Titel/Autor sauber willst — dann
  Bild als Hintergrund und Typo im `.tex` (siehe `front_cover_green.tex`).

## Rückseite

- **Klappentext** (3–5 Sätze: Schmerz → Versprechen → für wen), **Kurz-Bio + Autorenfoto**
  (Foto als abgerundetes Rechteck wirkt ruhiger als Kreis), ein Schlusssatz.
- **Barcode-Zone freihalten** (unten rechts, ~2×1,2"): bei kostenloser KDP-ISBN setzt Amazon
  den Barcode dort automatisch — nichts drüberlegen.
- `templates/back_cover.tex` ist nur eine optionale Design-Vorschau. Das echte
  Upload-PDF entsteht ausschließlich aus `templates/cover_wrap.tex`; akzeptierte
  Layoutänderungen müssen dort stehen.

## Schritte

1. Rücken-Breite aus der Seitenzahl rechnen (oder KDP-Template ziehen).
2. Front-Bild gestalten; Klappentext + Bio schreiben; KI-Herkunft inventarisieren.
3. Metadaten über `tex_metadata.py` erzeugen und `cover_wrap.tex` füllen
   (Maße, feste Bilddateien, Rücken-Text, Rückseiten-Inhalt),
   `tectonic cover_wrap.tex` → `cover_wrap.pdf`.
4. In `cover_wrap.tex` die Barcode-Reserve aus dem aktuellen KDP-Template
   eintragen, QA-Guide temporär aktivieren und gegen das Template legen:
   Rücken-Text mittig, kein Text/Bild im Bleed oder Barcode-Feld. Guide vor dem
   finalen Build wieder deaktivieren.

## Outputs

- `cover_wrap.pdf` — ein Wrap, KDP-Upload-fertig (Stufe 10)

## Gotchas

- **Seitenzahl geändert → Rücken neu rechnen → Cover neu bauen.** Sonst passt der Rücken nicht.
- Zu wenig Kontrast Rücken-Text/Hintergrund = unleserlich bei dünnen Büchern.
- Alternative ohne LaTeX: KDP **Cover Creator** (im Browser) mit eigenem Front-Bild — schneller,
  weniger Kontrolle.

Aktuelle KDP-Barcode-Vorgaben vor dem finalen Wrap prüfen:
https://kdp.amazon.com/en_US/help/topic/G5HDYGP4BXLX4RUW
