---
phase_id: book-02-research-and-evidence
phase: 2
title: Research & Evidence
when_to_use: Parallel zum Outline und während des Schreibens.
inputs: Outline, Kernbotschaft oder Prämisse, Genre
outputs: Claim-Inventory und Quellen oder Story-Kanon
portable: true
---

# 02 · Research & Evidence

Ein Sachbuch braucht eine belastbare Beweiskette; ein Roman braucht einen
belastbaren Story-Kanon. Beide werden **mit** dem Entwurf gebaut, nicht erst
nachträglich rekonstruiert.

## Sachbuch: Evidence

1. **Claim-Inventory anlegen.** Eine Liste: jede harte Behauptung bekommt eine ID
   (`CH03-C001`), den Wortlaut, die Quelle und eine Beweisklasse (belegt / abgeleitet /
   Hypothese). Das ist das Faktencheck-Backbone für Stufe 04.
2. **Quellen sammeln + fixieren.** Für jede Zahl/Studie: URL + Zugriffsdatum. Bevorzugt
   Primärquellen (Statistikamt, Originalstudie), nicht Blog-über-Blog.
3. **Beweisklassen ehrlich markieren.** Was du nicht belegen kannst, wird als „Beobachtung"
   oder „These" formuliert — nicht als Fakt getarnt.
4. **Leserbeleg planen.** Jede interne Claim-ID bekommt die vorgesehene
   lesbare Form: Markdown-Fußnote, Endnote oder Bibliografieeintrag. Die ID ist
   Arbeitsprovenienz und darf nicht im veröffentlichten Text stehen.
5. **URL-Hygiene.** Führe eine `sources.md`. Später (Stufe 04/06) alle URLs auf
   Erreichbarkeit und passenden Zielinhalt prüfen. Weiterleitungen auf das richtige Ziel sind okay,
   tote oder inhaltlich falsche Links nicht.
6. **Umlaut-Falle vormerken.** Quellen-URLs mit Umlauten (ü, ä) brechen im Print-Satz nicht
   um → sie müssen später prozent-kodiert werden (ü→`%C3%BC`), siehe `templates/umlaut.py`.

## Outputs

- `claim-inventory.md` — IDs, Wortlaut, Quelle, Beweisklasse
- `sources.md` — alle URLs + Zugriffsdatum, geprüft (0 tot oder inhaltlich falsch)
- lesbare Fußnoten/Endnoten und Bibliografie-Zuordnung pro Claim-ID

## Roman: Story-Kanon

1. `story-canon.md` anlegen: Figuren, Ziele, Wunden, Beziehungen, Orte,
   Weltregeln, Zeitlinie und unverrückbare Fakten.
2. Offene Fragen als `OPEN`, bewusste Geheimnisse als `HIDDEN` markieren. Der
   Agent erfindet keine rückwirkende Erklärung, um einen Widerspruch zu retten.
3. Jede Szene referenziert betroffene Kanon-Fakten; Änderungen werden als
   bewusste Kanon-Revision mit Autorfreigabe protokolliert.
4. Recherche für reale Orte, Geschichte, Technik oder Wissenschaft folgt der
   Sachbuch-Evidence-Disziplin, ohne die Fiktion als Tatsache auszugeben.

Output: `story-canon.md`; bei realweltlichen Claims zusätzlich `sources.md`.

## Gotchas

- **Nie eine Zahl erfinden, um einen Satz runder zu machen.** Der eine erfundene Wert, den ein
  Leser prüft, kostet das ganze Buch an Vertrauen.
- Zitate wörtlich + Quelle. Paraphrasen als Paraphrasen kennzeichnen.
