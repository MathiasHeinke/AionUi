---
phase_id: book-08-ebook-build-epub
phase: 8
title: eBook-Build (EPUB)
when_to_use: Parallel/nach dem Print-Interieur.
inputs: body.md, ebook_front.md, ebook_cta.md, Cover-JPEG, epub.css
outputs: book.epub (Kindle-Upload-fertig)
templates: build_ebook.sh, epub.css, ebook_front.md, ebook_cta.md
tools: pandoc>=3.9, sips oder ImageMagick
portable: true
---

# 08 · eBook-Build (EPUB)

Aus demselben `body.md` wird ein reflow-fähiges EPUB. Reflow = der Text passt sich
jeder Bildschirmgröße/Schriftgröße an. Der eine Fallstrick ist Code/Tabellen.

## Der Build (exakt)

`templates/build_ebook.sh`:

```bash
pandoc ebook_front.md body.md ebook_cta.md \
  -o book.epub \
  --metadata title="…" --metadata author="…" --metadata lang=de-DE \
  --epub-cover-image=cover.jpg \
  --css=epub.css \
  --toc --toc-depth=1 \
  --top-level-division=chapter \
  --syntax-highlighting=none \
  -f markdown+autolink_bare_uris
```

## Die kritische Regel: `--syntax-highlighting=none`

Mit Syntax-Highlighting injiziert pandoc pro Kapitel ein `<style>` mit
`pre > code.sourceCode { white-space: pre; }`. Das ist **spezifischer** als jede
eigene Regel und **schneidet Code-Blöcke auf schmalen Kindle-Screens ab** statt
umzubrechen. Ohne Highlighting greift `epub.css`:
`pre, code { white-space: pre-wrap !important; overflow-wrap: anywhere; }`.
→ **Immer `--syntax-highlighting=none`, wenn das Buch Code/YAML/strukturierte Blöcke hat.**

## Cover als JPEG, nicht PNG

`--epub-cover-image=cover.jpg`. Ein sinnvoll komprimiertes JPEG statt eines unnötig großen
PNG hält das EPUB klein und kann bei der 70-%-Option die dateigrößenabhängige Liefergebühr
senken. Ergebnisgröße und aktuelle KDP-Bedingungen im Release prüfen.
Für Kindle ein eigenes Cover im aktuell empfohlenen Seitenverhältnis erzeugen
(derzeit 1,6:1, z. B. 1600×2560 px), nicht das 6×9-Printbild blind übernehmen.
Konvertieren auf macOS:
`sips -s format jpeg -s formatOptions 82 cover.png --out cover.jpg`.
Plattformübergreifend:
`magick cover.png -quality 82 cover.jpg`.

## Schritte

1. `ebook_front.md` und `ebook_cta.md` füllen. Der Kindle-Link darf keine
   Kundendaten-Erfassung öffnen; Zielseite live gegen die aktuellen KDP-
   Hyperlink-Regeln prüfen oder den CTA entfernen.
2. Cover-Front als JPEG bereitstellen.
3. `bash build_ebook.sh` → `book.epub`.
4. **Verifizieren:** `unzip -l book.epub` (Struktur ok?), Kapitelzahl prüfen. Optional:
   in einem EPUB-Reader alle Kapitel + ein Code-Block bei großer Schrift ansehen (bricht um?).
5. Finaler Render-Check kommt im KDP-Kindle-Previewer (Stufe 11).

## Outputs

- `book.epub` — reflowbar, Code bricht um, Cover eingebettet

## Gotchas

- **Kindle schneidet Code ab?** Highlighting war an. Neu bauen mit `--syntax-highlighting=none`.
- Lange Pfade/Tokens ohne Leerzeichen brauchen `overflow-wrap: anywhere` im CSS (in `epub.css` drin).
- Alle Kapitel im TOC? `--toc-depth=1` listet die `#`-Kapitel. Fehlt eins → Heading-Ebene im body.md prüfen.

Live-Quellen vor dem Upload:

- Kindle-Hyperlinks:
  https://kdp.amazon.com/en_US/help/topic/GQ6JQ7FM6C72HE4X
- eBook-Cover:
  https://kdp.amazon.com/en_US/help/topic/G200645690
