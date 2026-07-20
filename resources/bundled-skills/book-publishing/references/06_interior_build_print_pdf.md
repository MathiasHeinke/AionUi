---
phase_id: book-06-interior-build-print-pdf
phase: 6
title: Interior-Build (Print-PDF)
when_to_use: Wenn body.md + Front/Back-Matter final sind.
inputs: body.md, book-metadata.tex, header.tex, frontmatter.tex, backmatter_cta.tex, optional cta-qr.png
outputs: interior.pdf (druckfertiges Buch-Innenteil)
templates: build_interior.sh, header.tex, frontmatter.tex, backmatter_cta.tex, umlaut.py
tools: pandoc>=3.9, tectonic, poppler
portable: true
---

# 06 · Interior-Build (Print-PDF)

Aus `body.md` wird das druckfertige Innenteil-PDF — via **pandoc + tectonic**
(XeTeX), ohne TeX-Live-Installation. Reproduzierbar über ein Skript.

## Der Build (exakt)

`templates/build_interior.sh`:
```bash
pandoc body.md -o interior.pdf \
  --pdf-engine=tectonic \
  --top-level-division=chapter \
  -V documentclass=book -V fontsize=11pt -V lang=de-DE \
  -f markdown+autolink_bare_uris \
  -H header.tex -B frontmatter.tex -A backmatter_cta.tex
```
- `-H header.tex` = der komplette 6×9-Interior-Stil (Geometrie, Schrift, Kapitel-/Kolumnen-Design,
  Code-Umbruch via `fvextra`, Blocksatz-Tuning). Liegt fertig in `templates/header.tex`.
- `--top-level-division=chapter` = jedes `#` = neues Kapitel.
- `-f markdown+autolink_bare_uris` = **der URL-Fix**: nackte Quellen-URLs werden zu `\url{}`
  (xurl bricht sie um) → behebt den KDP-Previewer-Fehler „Text außerhalb der Ränder".

## Trim-Size & Geometrie

- Standard-Sachbuch: **6×9 Zoll** (in `header.tex` als `paperwidth=6in,paperheight=9in`).
  Für ein anderes Format nur die `geometry`-Zeile ändern.
- Ränder sind bereits KDP-tauglich gesetzt (inner 0.8in für den Bundsteg).

## Schritte

1. `body.md`, `book-metadata.tex`, `header.tex`, `frontmatter.tex`,
   `backmatter_cta.tex` und `build_interior.sh` in **einen** Ordner. Wenn
   ein Print-CTA freigegeben ist, zusätzlich die gescannte `cta-qr.png` ablegen.
   Dieses Template erzeugt ein 6×9-Zoll-Interieur **ohne Bleed**;
   entsprechend im KDP-Formular `No Bleed` wählen. Für Bleed zuerst Geometrie
   und Seitengröße nach der aktuellen KDP-Spezifikation neu bauen.
2. **Umlaut-URL-Fix im tatsächlichen Build-Input:** URLs mit ü/ä
   prozent-kodieren (`ü→%C3%BC`, `ä→%C3%A4` …). Helfer zunächst als Dry-Run auf
   `body.md` und allen eingebundenen Front-/Backmatter-Dateien ausführen, dann
   bewusst mit `--apply`. `sources.md` allein zu ändern reicht nicht, wenn sie
   nicht in das Buch eingebunden ist.
3. **Evidence-Leak-Gate (Sachbuch):**
   `rg -n 'CH[0-9]{2}-C[0-9]{3}' body.md` muss ohne Treffer enden; interne
   Claim-IDs vorher in lesbare Fußnoten/Endnoten und Bibliografie übersetzen.
4. **Verifizieren:** `pdfinfo interior.pdf` (Seitenzahl merken — für den
   Buchrücken, Stufe 07). Erste, mittlere und letzte Seite anhand der echten
   Seitenzahl mit `pdftoppm -f <seite> -l <seite>` rendern; keine hart codierte
   hohe Seitennummer verwenden.
5. Gegen KDP-Previewer prüfen (Stufe 10): kein „Unzureichender Bundsteg", kein Text im Anschnitt.

## Outputs

- `interior.pdf` — druckfertig
- **Seitenzahl** (Input für die Buchrücken-Breite in Stufe 07)

## Gotchas

- **KDP-Previewer flaggt Seiten mit langen URLs?** Fast immer nackte oder umlaut-haltige URLs.
  Erst `+autolink_bare_uris` (im Build drin), dann Umlaut-URLs prozent-kodieren.
- Nach jeder Body-Änderung neu bauen — die Seitenzahl kann sich ändern → Buchrücken neu rechnen.
- `tectonic` lädt beim ersten Lauf Pakete nach (Internet nötig), danach gecacht.

Aktuelle KDP-Bleed-Maße vor jeder abweichenden Geometrie prüfen:
https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6
