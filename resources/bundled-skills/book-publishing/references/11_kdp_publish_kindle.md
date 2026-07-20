---
phase_id: book-11-kdp-publish-kindle
phase: 11
title: KDP Publish — Kindle eBook
when_to_use: Direkt nach dem Taschenbuch (verknüpft beide).
inputs: book.epub, Cover-JPEG, Preis
outputs: veröffentlichtes Kindle eBook (mit Taschenbuch verknüpft)
human_gate: Rechte, KI-Offenlegung, DRM, KDP Select, Preis, Termin und Publish = Mensch
portable: true
---

# 11 · KDP Publish — Kindle eBook

Vom Taschenbuch aus **„+ Kindle eBook erstellen"** → kopiert Metadaten automatisch
und **verknüpft beide Formate auf einer Amazon-Produktseite**. Drei Tabs.

## Tab 1 — Details
- Metadaten können vorbefüllt sein; Titel, Autor, Beschreibung, Rechte und
  Keywords erneut gegen die freigegebene Fassung prüfen. Rechte bestätigt der
  Mensch.
- **Kategorien neu wählen** — der Kindle-Kategoriebaum ist ein anderer als beim Print.

## Tab 2 — Inhalt
- **Mensch lädt nach Preflight hoch:** `book.epub` (KDP konvertiert; DOCX nur
  als bewusst geprüfter Fallback).
- **DRM bewusst entscheiden:** KDP erlaubt die Einstellung seit 2026 nachträglich zu ändern.
  DRM-freie Käufer können EPUB/PDF herunterladen; bereits heruntergeladene Dateien bleiben
  bei ihnen, auch wenn später DRM aktiviert wird. → **Human Gate.**
- **KI-Offenlegung:** KDP verlangt aktuell die Offenlegung KI-generierter Texte, Bilder oder
  Übersetzungen; rein KI-assistierte Arbeit muss derzeit nicht offengelegt werden. Die aktuelle
  Definition im Formular lesen, verwendete Verfahren inventarisieren und eine
  Antwort vorschlagen. **Der Mensch bestätigt und sendet die Offenlegung.**
- **Cover:** Mensch lädt das freigegebene Front-JPEG hoch.
- **Barrierefreiheit:** bei reinem Text ohne informative Bilder die „alles zugänglich"-Option.
- **Vorschau:** Mensch startet den Kindle-Previewer; Agent kann anhand
  freigegebener Screenshots/Reports auf schmalstem Gerät + **großer Schrift** prüfen,
  dass Code-Blöcke/Tabellen **umbrechen** (der `--syntax-highlighting=none`-Test aus Stufe 08).

## Tab 3 — Preise
- **KDP Select:** 90-tägige Digitalexklusivität mit eigenen Chancen und Einschränkungen.
  Nur nach **menschlicher Entscheidung** wählen, wenn keine kollidierende
  eBook-Distribution geplant ist.
- **Tantiemenplan:** 35 % oder 70 % anhand der aktuellen Markt-, Preis-, Gebiets- und
  Inhaltsbedingungen wählen; historische Preisgrenzen nicht blind übernehmen.
- **Listenpreis:** KDP berücksichtigt USt. und zeigt Liefergebühr sowie geschätzte Tantieme.
  Die Marketplace-Vorschau vor dem Human-Gate prüfen.
- **Veröffentlichen oder Vorbestellung absenden** ← **menschlicher Klick nach
  Decision Card.** Vorbestellungsfristen und Sperrfolgen live in KDP prüfen.

## Outputs

- Kindle eBook „Wird geprüft" → live, mit dem Taschenbuch als **ein** Titel verknüpft

## Live-Quellen vor dem Human-Gate

- DRM und nachträgliche Änderungen:
  https://kdp.amazon.com/de_DE/help/topic/GDDXGH9VR22ACM8U
- KI-generiert vs. KI-assistiert:
  https://kdp.amazon.com/en_US/help/topic/G200672390
- eBook-Tantiemen:
  https://kdp.amazon.com/de_DE/help/topic/G200644210
- Kindle-Vorbestellung und Fristen:
  https://kdp.amazon.com/en_US/help/topic/G201499380

## Gotchas

- **DRM wirkt über die Zukunft hinaus.** Änderungen sind möglich, bereits heruntergeladene
  DRM-freie Dateien werden dadurch aber nicht zurückgerufen.
- Preis-, USt.- und Tantiemenbedingungen ändern sich; die aktuelle KDP-Vorschau ist maßgeblich.
- „Serie" ≠ Formatverknüpfung. Formate werden automatisch verknüpft; Serie ist nur für
  mehrere eigenständige Bände — für ein Einzelbuch **keine** Serie anlegen.
