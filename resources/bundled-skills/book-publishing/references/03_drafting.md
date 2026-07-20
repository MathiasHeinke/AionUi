---
phase_id: book-03-drafting
phase: 3
title: Draft schreiben (body.md)
when_to_use: Nach Outline + erster Research-Runde.
inputs: Outline, Claim-Inventory oder Story-Kanon, Kernbotschaft oder Prämisse, Stimme/Voice
outputs: body.md (der ganze Buchkörper in Markdown)
portable: true
---

# 03 · Draft schreiben (body.md)

Der ganze Buchkörper lebt in **einer** Markdown-Datei `body.md`. Das ist die
Single Source, aus der später Print-PDF **und** eBook gebaut werden. Ein Format,
zwei Ausgaben.

## Markdown-Konventionen (Pflicht, damit der Build stimmt)

- Kapitel = `# Kapitel N: Titel` (Level-1-Heading). Der Interior-Build nutzt
  `--top-level-division=chapter`, d.h. jedes `#` startet ein neues Kapitel auf neuer Seite.
- Abschnitte = `## Zwischenüberschrift`.
- Code/YAML/strukturierte Blöcke = Fenced Code (```). Wichtig für eBook-Reflow (Stufe 08).
- Blockzitate = `> …`. Tabellen = Pipe-Tabellen.
- Nackte Quellen-URLs einfach als Text einfügen — der Build macht sie via
  `+autolink_bare_uris` klickbar/umbruchfähig.

## Schritte

1. **Stimme definieren** (einmal, als kurze „SOUL"-Notiz): Tonfall, Perspektive, Verbote
   (z.B. keine Hype-Wörter). Alle Kapitel folgen ihr.
2. **Genre-Muster:** Sachbuch: Aufhänger → These → Beweis (aus
   Claim-Inventory) → Konsequenz → Überleitung. Roman: Szenenziel → Konflikt →
   Veränderung → Folgewirkung; jede Szene muss den Zustand der Geschichte
   verändern.
3. **Durchschreiben, nicht durchpolieren.** Erst der ganze Draft, dann Stufe 04. Perfektion
   pro Absatz killt Momentum.
4. **Wahrheit verankern.** Sachbuch-Claims referenzieren eine Claim-ID aus
   Stufe 02. Roman-Szenen bleiben mit Figuren-, Welt- und Zeitlinien-Kanon
   konsistent; realweltliche harte Behauptungen werden trotzdem belegt.
5. **Kadenz prüfen:** Absätze atmen lassen, nicht 12 Zeilen am Stück. Laut lesen.
6. **Arbeits-ID in Leserbeleg übersetzen.** Während des Drafts darf die Claim-ID
   neben dem Satz stehen; vor dem Content-Freeze wird sie durch eine lesbare
   Markdown-Fußnote/Endnote ersetzt und in die Bibliografie aufgenommen.

## Outputs

- `body.md` — vollständiger Draft, valide Markdown-Struktur
- beim finalen Build keine interne Claim-ID (`CH03-C001`) mehr in `body.md`

## Gotchas

- Uneinheitliche Kapitel-Heading-Ebene (mal `#`, mal `##`) zerlegt später die TOC. Konsequent `#`.
- Sonderzeichen in Code-Blöcken sind okay; sie werden in Stufe 06/08 korrekt behandelt.
