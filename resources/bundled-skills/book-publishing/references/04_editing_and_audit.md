---
phase_id: book-04-editing-and-audit
phase: 4
title: Redigieren & Audit
when_to_use: Nach dem Draft, vor Front/Back-Matter und Build.
inputs: body.md, Claim-Inventory und Quellen oder Story-Kanon
outputs: redigiertes body.md, PASS-Vermerk pro Kapitel
portable: true
---

# 04 · Redigieren & Audit

Redigieren trennt **Wahrheits-/Kanoncheck** von **Stimme/Kadenz**. Sonst
übersieht man Fakten oder Story-Widersprüche, weil man an Formulierungen hängt.

## Durchgang A — Blind-Audit (Sachbuch oder Roman)

Ein *unabhängiger* Blick (anderer Agent / anderer Tag / Kollege), der das Kapitel
**ohne** deine Absichten liest:

- Sachbuch: belegte Claims, keine getarnten Hypothesen, konsistente Zahlen und
  Datumsangaben.
- Roman: POV-Disziplin, Figurenmotiv, Kausalität, Weltregeln, Namen und
  Zeitlinie gegen `story-canon.md`.
- Beide: Verdikt je Kapitel `PASS` / `PASS_WITH_PATCHES` / `REJECT` plus
  konkrete Patches.

## Durchgang B — Ceiling-Review (Stimme, Schärfe, Kadenz)

Bewusster Qualitäts-Pass: Ist es scharf, ehrlich, ohne Hype? Redundanzen raus,
schwache Öffnungen/Schlüsse stärken, Kadenz glätten. Laut lesen.

## Durchgang C — Quellen & Konsistenz

- Sachbuch: alle URLs in `sources.md` auf Erreichbarkeit und richtigen
  Zielinhalt prüfen (0 tot/falsch).
- Sachbuch: jede belegpflichtige Passage besitzt einen lesbaren Beleg im
  Manuskript; `rg -n 'CH[0-9]{2}-C[0-9]{3}' body.md` liefert keinen Treffer.
- Roman: `story-canon.md`, Namen, Orte, Weltregeln und Zeitlinie vollständig
  gegen den finalen Text prüfen.
- Namen/Begriffe/Schreibweisen vereinheitlichen (ein Glossar hilft beiden).
- Rechtschreibung (KDP zeigt später eine Rechtschreibprüfung — englische Fachbegriffe/Marken
  lösen dort *erwartbar* viele False Positives aus, kein Blocker).

## Outputs

- redigiertes `body.md`
- pro Kapitel ein Audit-Verdikt + geschlossene Patches
- `sources.md` final geprüft
- Sachbuch: reader-facing Fußnoten/Endnoten und Bibliografie vollständig, keine
  internen Claim-IDs im Build-Input

## Gotchas

- **Keine weiteren autonomen Body-Edits nach dem finalen Autoren-Read.** Ab da nur noch
  bewusst freigegebene Änderungen — sonst schleichen sich neue, ungeprüfte Claims ein.
