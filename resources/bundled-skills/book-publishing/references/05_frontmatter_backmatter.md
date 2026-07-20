---
phase_id: book-05-frontmatter-backmatter
phase: 5
title: Front-/Back-Matter
when_to_use: Wenn body.md steht, vor dem Interior-Build.
inputs: Titel, Autor, Herausgeber, genrepassender Backmatter-Plan, optional freigegebene CTA-URL
outputs: book-metadata.tex, frontmatter.tex, genrepassendes backmatter_cta.tex, ebook_front.md, ebook_cta.md mit optionalem CTA-Inhalt
templates: book-metadata.example.json, tex_metadata.py, frontmatter.tex, backmatter_cta.tex, ebook_front.md, ebook_cta.md
portable: true
---

# 05 · Front- und Back-Matter

Das Drumherum um den Buchkörper. Print (LaTeX-Includes) und eBook (Markdown)
sind getrennt, weil sie unterschiedlich gesetzt werden.

## Front-Matter (Buchanfang)

- **Schmutztitel** (half-title), **Titelseite** (Titel groß + Untertitel + Autor),
- **Impressum/Copyright:** `Copyright © JAHR Autor. Alle Rechte vorbehalten.` + Herausgeber
  + Haftungsausschluss („keine rechtliche/medizinische/finanzielle Beratung") + `Ausgabe: 1. Auflage, JAHR.`
- **Widmung** + **Epigraph** (ein starkes Zitat aus dem Buch — nicht generisch).
- **Inhaltsverzeichnis** (Print: automatisch; eBook: via `--toc`).

Print: `templates/frontmatter.tex` (wird via `-B frontmatter.tex` vor den Body gesetzt).
eBook: `templates/ebook_front.md` (Impressum + Widmung als `{.unnumbered .unlisted}`-Headings).

## Back-Matter (Buchende)

- Sachbuch optional: freigegebene Begleit-/Angebotsseite mit **QR-Code**.
- Roman optional: Über-den-Autor-, Serien-, Leseproben- oder Begleitseite; kein
  Beratungsfunnel-Zwang.
- **Über den Autor** (kurz, ein Foto optional).
- Print: `templates/backmatter_cta.tex` (via `-A backmatter_cta.tex` nach den Body).
  eBook: `templates/ebook_cta.md` (klickbare Links statt QR).

## Schritte

1. `book-metadata.example.json` kopieren, freigegebene Metadaten eintragen und
   mit `python3 tex_metadata.py book-metadata.json` eine TeX-sichere
   `book-metadata.tex` erzeugen. Die LaTeX-Templates nicht mit unescaped
   Metadaten editieren (`&`, `%`, `_`, `#` würden sonst Builds brechen).
2. Wenn der Positionierungsplan einen Print-CTA vorsieht, `cta-qr.png` aus der
   freigegebenen Ziel-URL erzeugen und mit einem echten Scan testen. URL und QR
   werden nicht direkt aus TeX erzeugt. Ohne CTA die Backmatter bewusst als
   Autoren-/Serienseite gestalten; kein QR ist dann erforderlich.
3. `ebook_front.md` + `ebook_cta.md` analog für die eBook-Fassung ausfüllen.
   Die Datei `ebook_cta.md` bleibt Build-Input; ohne CTA enthält sie nur
   freigegebene neutrale Backmatter oder ist leer.
   **Kindle-Link separat prüfen:** Er darf nicht zu einem Formular führen, das
   E-Mail-Adresse oder andere Kundendaten abfragt. Nutze eine neutrale
   Begleitseite oder lasse den Link weg.

## Outputs

- TeX-sichere Metadaten, optionales QR-Artefakt und genrepassende Dateien, bereit für
  Stufe 06 (Print) und Stufe 08 (eBook)

## Gotchas

- Print-QR und Kindle-Link sind verschiedene Compliance-Ziele; nicht dieselbe
  Lead-Capture-URL blind in beide Formate übernehmen.
- Impressum-Pflichtangaben je Land beachten (DE: verantwortliche Person/Herausgeber).

Vor dem Kindle-Upload die aktuellen Hyperlink-Regeln live prüfen:
https://kdp.amazon.com/en_US/help/topic/GQ6JQ7FM6C72HE4X
