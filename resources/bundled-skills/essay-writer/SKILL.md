---
name: essay-writer
description: "Schreibt persönlich-philosophische ESSAYS mit Heldenreise, echter Autorenstimme und kuratiertem Apparat — von Rohmaterial (Diktat, Notizen, Biografie-Bruch) über Entwurf, adversariales Review und Straffung (minus 15 bis 20 Prozent) bis zur publikationsreifen Fassung mit sauberen Fußnoten. Länge standardmäßig 3.500 bis 6.000 Wörter (nach Straffung 4.000 bis 5.000). Nutzen bei Trigger wie «schreib einen Essay», «mach aus meinen Notizen oder Diktaten einen Essay», «hilf mir meinen Essay zu schärfen oder straffen» — auch in der Stimme eines anderen Autors (Voice-Profil via founder-voice, mit dessen Freigabe). Produziert Markdown-Master plus optional DOCX und PDF plus Redaktionsnotiz. Niemals veröffentlichen ohne Human-Gate."
---

# Essay Writer

## Was dieser Skill ist — und was nicht

Ein Weltbild-Essay mit autobiografischem Kern: Der Autor argumentiert aus bezahlter Erfahrung, nicht aus Quellenlage. Quellen zeigen nur, dass die Denktradition existiert. Das ist KEIN Blogpost (dafür: blog-writer), keine Reportage, keine akademische Abhandlung — akademisch geschärft heißt hier: saubere Begriffe, verifizierte Verweise, korrekter Apparat. Der Essay bleibt trotzdem Bekenntnis und Form, nicht Fußnoten-Maschine.

## Voraussetzungen

- **Voice-Profil** des Autors (aus founder-voice / USER.md). Existiert keins: Samples erfragen oder mit vorhandenem Material arbeiten und niedrige Konfidenz offen markieren. NIEMALS eine Stimme erfinden.
- **Rohmaterial**: persönliche Geschichte, mindestens eine Bruch-Szene, Arbeitsthese, Zielleser. Fehlt die Bruchszene: gezielt danach fragen — ohne sie wird der Essay dünn.
- **Fremdautor**: dessen Samples + ausdrückliche Freigabe; Profil nur in dessen Seat, nie mischen (per-client isolation).

## Die 12 Bausteine (Qualitätsgerüst)

1. **These in einem Satz** — der zitierfähige Kern, blockquote-fähig (Bsp.: „Der Mensch hat nicht nur Gewohnheiten. Er wird zur Gewohnheit seiner Welt.")
2. **Heldenreise** — Ausgangswelt und Verheißung → Selbstbetrug → Bruch → Gegenbewegung → verwandelte Einsicht. Keine Chronik, sondern Verwandlung.
3. **Konkrete Bruchszene** — genau eine zentrale, sinnliche und datierbare
   Szene („Zahn bricht beim Frühstück ab"), niemals nur abstrakt („der Körper
   fiel aus"). Weitere Erinnerungen dürfen sie spiegeln, aber nicht als zweiter
   gleichgewichtiger Bruch konkurrieren.
4. **Eskalationsbogen** — Ich → Wir → Welt: persönlich beginnen, verallgemeinern, kulturell/politisch enden.
5. **Selbst-Hinterfragung** — der stärkste Einwand gegen die eigene These, ernst genommen und teilweise zugestanden („Dieser Einwand trifft einen Teil der Wahrheit"), dann die Grenze des Einwands gezeigt.
6. **Kuratierte Verweise** — 5–10 Quellen maximal, jede mit klarer Funktion (Anker / Folie / Beleg). Eine Gegenfolie ist erlaubt und stark (eigener Begriff gegen einen besetzten Fachbegriff, z. B. Über-Ich gegen Freud). Keine Zitat-Imponiererei.
7. **Immunisierung** — Fairness gegenüber der Gegenseite („Das ist kein Urteil über jeden X"), Milieu-Kritik ohne Lagergefühl, Selbstironie der eigenen Position erlaubt.
8. **Aphorismen** — 3–7 zitierfähige Sätze („Geliehene Macht verlangt Zinsen"). Knapp, rhythmisch, ohne Hype.
9. **Vakuum-Dynamik** — benennen, was das Fehlen der Form füllt; die Gegenbewegung braucht einen Gegendruck.
10. **Ringschluss** — das Ende spiegelt Titel und These.
11. **Sauberer Apparat** — Fußnoten in aufsteigender Zitatreihenfolge, Quellenliste mit Disclaimer („nicht automatisch Belege für jede Tatsachenbehauptung"), jede Tatsachenbehauptung verifiziert (web_search) oder als These markiert.
12. **Redaktionsnotiz** — Story dieses Essays / Spannungsbogen / Nächste Tür (macht den Essay serienfähig).

## Methode (SOP)

1. **Intake** — Thema, Zielleser, Arbeitsthese, Bruchmaterial, Ziel-Länge, Autor/Voice klären. Eine Frage nach der anderen, nicht alles auf einmal.
2. **Voice laden** — Profil aus USER.md/founder-voice lesen; bei Fremdautor dessen Profil. Stimm-Merkmale als harte Vorgabe, nicht als Inspiration.
3. **Skelett** — Kapitel-Ark entlang Heldenreise + Eskalationsbogen skizzieren (8–14 Kapitel), jedem Kapitel seine Funktion zuweisen.
4. **Entwurf** — on-voice schreiben. Kurze deklarative Sätze als Rhythmus-Default, „nicht X. Sondern Y."-Figuren sparsam, Triaden dosiert.
5. **Adversariales Review** — gezielt prüfen: Fußnoten-Reihenfolge, Begriffskollisionen (ist der Fachbegriff schon besetzt?), zirkuläre Definitionen, vage Bruchszene, dünne Kapitel-Brücken, Doppeldeutigkeiten, Quellenlage. Befunde als nummerierte Liste.
6. **Reparatur** — Befunde einarbeiten; neue Begriffe bewusst positionieren statt weichzeichnen.
7. **Straffung −15 bis −20 %** — Streichkandidaten: Füllsätze, Doppelungen, zweite Belege, Vorreden. NIEMALS streichen: Bruchszene, Punchlines, Verortung, Immunisierungen. Wortzahl vorher/nachher dokumentieren.
8. **Apparat & Verifikation** — Fußnoten-Regex-Check (aufsteigend, keine Lücken), Quellen via web_search verifizieren; nicht Verifizierbares allgemein formulieren („Interviews aus dem Jahr 2026") oder streichen — niemals erfinden.
9. **Autoren-Abgleich** — 2–3 Stellen gezielt gegenlesen lassen: Bruchszene, persönliche/politische Passagen. Deren Korrektur ist Ground Truth.
10. **Export** — Markdown-Master; DOCX via pandoc, PDF via LibreOffice (soffice --headless --convert-to pdf). Alle Formate synchron halten. **Human-Gate vor jeder Veröffentlichung.**

## Qualitätsschwellen

- Länge nach Straffung im Zielkorridor (Default 4.000–5.000 Wörter)
- Mindestens 1 These-Satz, 3–7 Aphorismen, genau eine konkrete Bruchszene
- Selbst-Einwand vorhanden und teilweise zugestanden
- Fußnoten aufsteigend in Zitatreihenfolge (Regex-geprüft), Quellen 5–10
- 0 unverifizierte Tatsachenbehauptungen ohne Markierung
- Straffung mit Wortzahl vorher/nachher belegt

## Pitfalls (aus echter Anwendung gelernt)

- **Fußnoten-Reihenfolge bricht**, wenn Quellen nachträglich eingefügt werden → Regex-Check immer am Schluss, nie dazwischen als erledigt ansehen.
- **Begriffskollisionen** (z. B. Über-Ich vs. Freud): besetzten Begriff nicht vermeiden, sondern bewusst dagegen positionieren — mit Quellenverweis auf den Besetzer als Gegenfolie.
- **Zirkuläre Definitionen** („Momentum ist der Moment, in dem…") — Definition nie aus dem zu definierenden Wort bauen.
- **Doppeldeutigkeiten** prüfen („kleiner Tod" = le petit mort) — im Kontext ungewollte Lesarten streichen.
- **Vage Bruchszene tötet Glaubwürdigkeit** — lieber ein hartes Detail als drei Andeutungen.
- **Quellen-Überfrachtung** wirkt wie Imponieren — 8 mit Funktion schlagen 15 ohne.
- **Straffung unter 15 %** ist Kosmetik; über 25 % frisst die Stimme. Bei ~20 % stoppen und benennen, welche Substanz-Kandidaten als Nächstes kämen.
- **PDF/DOCX nicht aus dem Kopf neu schreiben** — immer aus dem Markdown-Master erzeugen, sonst laufen Fassungen auseinander.

## Output

- Markdown-Master immer; DOCX und PDF nur wenn angefordert oder für den
  Zielkanal nötig, dann synchron aus dem Master erzeugt
- Redaktionsnotiz (Story / Spannungsbogen / Nächste Tür) im Dokument
- Kurzer Änderungsbericht im Chat: Wortzahlen, entfernte/ergänzte Verweise, offene Punkte

## Hard rules

- **Genre-Grenze:** Dieser Skill liefert ESSAYS — keine Kapitel-Serien, kein Buch. Eskalation Essay → Buch nur über autor-studio und nur nach ausdrücklicher Autoren-Entscheidung.
- **Kein Publish ohne Human-Gate** — vorbereiten ja, veröffentlichen nur nach ausdrücklichem Go.
- **Per-client isolation** — Voice-Profile, Material und Entwürfe eines Autors/Kunden nie in einen anderen Seat übertragen.
- **Keine erfundenen Quellen, Daten oder Belege** — Unverifizierbares kennzeichnen oder streichen.
- **Fremdautor nur mit Freigabe** — und im Export klar, wer der Autor ist.
