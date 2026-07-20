---
phase_id: book-09-kdp-account-and-tax
phase: 9
title: KDP-Konto & Steuer
when_to_use: Einmalig vor dem ersten Publish.
inputs: Rechtsform, Steuer-IDs, Bankverbindung
outputs: publikationsfähiges KDP-Konto (Steuerprofil + Payout)
portable: true
human_gate: Login, Steuerfelder, Bankdaten = Mensch. Agent berät nur.
---

# 09 · KDP-Konto & Steuer

Einmal-Setup. **Sensible Zone:** Login, Identitätsprüfung, Steuer-Interview-Eingaben
und Bankdaten macht der Mensch selbst. Ein Agent darf die offizielle Dokumentation
zusammenstellen und eine Fragenliste vorbereiten, aber keine Rechts-/Steuer-Attestierungen
abgeben und keine Kontodaten verarbeiten.

## Konto

- KDP-Konto anhand des tatsächlichen wirtschaftlich Berechtigten und der tatsächlichen
  Rechts-/Steuerklassifikation anlegen. Ein Imprint ist kein Ersatz für die korrekte
  Kontoinhaber- und Steuerangabe.

## US-Steuer-Interview

KDP verlangt ein Steuerprofil für US-Quellensteuer und Reporting. Welches Formular,
welcher wirtschaftlich Berechtigte, welche TIN und ob ein Abkommenssatz greift, hängt
von Eigentümer, Ansässigkeit, Entity-Klassifikation und möglichen Elections ab.

- **Nicht aus dem Skill ableiten.** Vor Eingabe die aktuelle KDP-Hilfe, die aktuellen
  IRS-Formularanweisungen und bei Gesellschaften/Abkommensclaims eine Steuerberatung prüfen.
- Bei einer für US-Zwecke disregarded entity dokumentiert grundsätzlich der Eigentümer
  den Status; Sonderfälle wie Entity-Elections, hybride Entities oder ein Entity-Eigentümer
  können ein anderes Formular erfordern.
- Keine TIN, EIN, Steuer-ID oder Bankverbindung in Repo, Chat, Report oder Cloud-Memory kopieren.
- Offizielle Ausgangspunkte:
  - https://www.irs.gov/instructions/iw8ben
  - https://www.irs.gov/instructions/iw8bene
  - die im KDP-Steuerinterview verlinkte aktuelle Hilfe

## MwSt.-Grundlagen (für die Preis-Skills 10/11)

- **Print in EU/UK:** KDP verwendet den eingegebenen Print-Listenpreis exklusive lokaler
  Umsatzsteuer und zeigt einen geschätzten Kundenpreis inklusive Steuer. Prüfe die aktuelle
  Marketplace-Vorschau; Steuersätze und Produktklassifikation können abweichen.
- **eBook:** KDP berücksichtigt USt. in den Preis- und Tantiemengrenzen. Verlasse dich auf
  die aktuelle KDP-Vorschau statt auf eine fest codierte Netto-/Brutto-Formel.
- Offizielle Ausgangspunkte:
  - https://kdp.amazon.com/de_DE/help/topic/GPQL5W3J6WNRCZTV
  - https://kdp.amazon.com/de_DE/help/topic/G201645450

## Outputs

- KDP-Konto mit menschlich bestätigtem Steuerprofil und Payout eingerichtet

## Gotchas

- Das KDP-Steuerinterview ersetzt keine Steuererklärung im Ansässigkeitsstaat.
- Der Skill gibt Prozesshilfe, keine individuelle Rechts- oder Steuerberatung.
