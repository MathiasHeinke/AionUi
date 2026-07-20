# Checkliste — Pre-Publish QA (vor beiden Uploads)

## Inhalt

- [ ] Alle Kapitel als `# Kapitel N` (konsistente Heading-Ebene)
- [ ] Sachbuch: Claim-Inventory vollständig; Roman: nur realweltliche harte
      Claims belegt, sonst Story-Kanon statt Claim-Ledger
- [ ] Sachbuch: jeder veröffentlichte Claim hat lesbare Fußnote/Endnote oder
      Bibliografiebeleg; `body.md` enthält keine interne `CHNN-CNNN`-ID
- [ ] Roman: Figuren, POV, Weltregeln, Namen und Zeitlinie gegen `story-canon.md` geprüft
- [ ] Falls `sources.md` existiert: alle verwendeten URLs erreichbar und
      inhaltlich korrekt (0 tot/falsch)
- [ ] Blind-Audit + Ceiling-Review pro Kapitel = PASS
- [ ] Rechtschreibung geprüft (englische Fachbegriffe = erwartbare False Positives)
- [ ] `ai-content-inventory.md`: KI-generiert vs. KI-assistiert für Text,
      Übersetzung und alle Bilder/Cover dokumentiert; menschliche Offenlegung vorbereitet

## Front-/Back-Matter

- [ ] Titelseite: Titel + Untertitel + Autor korrekt
- [ ] Impressum: Copyright, Herausgeber, Haftungsausschluss, „1. Auflage, JAHR"
- [ ] Widmung + Epigraph vorhanden (nicht generisch)
- [ ] Falls Print-CTA vorgesehen: Ziel-URL + QR per echtem Scan getestet; sonst
      Backmatter bewusst ohne Funnel-Link freigegeben

## Print-Interieur

- [ ] `bash build_interior.sh` läuft fehlerfrei
- [ ] Keine überlaufenden URLs (Umlaut-URLs prozent-kodiert)
- [ ] `pdfinfo` Seitenzahl notiert (für Buchrücken)
- [ ] Stichproben-Seiten: Ränder/Bundsteg ok

## Cover

- [ ] Buchrücken-Breite aus aktueller Seitenzahl gerechnet
- [ ] Gegen KDP-Cover-Template gelegt (Maße + Barcode-Zone frei)
- [ ] Front-Bild 1800×2700, Titel lesbar auch als Thumbnail
- [ ] Barcode-Reserve aus aktuellem KDP-Template im Wrap tatsächlich frei

## eBook

- [ ] `build_ebook.sh` mit `--syntax-highlighting=none`
- [ ] Cover als JPEG (klein)
- [ ] Kindle-Cover in aktueller Empfehlung (derzeit ca. 1,6:1, z. B. 1600×2560)
- [ ] Kindle-Links live geprüft: kein Formular zur Erfassung von E-Mail oder anderen Kundendaten
- [ ] Alle Kapitel im TOC
- [ ] Code-Block bei großer Schrift = bricht um (kein Abschneiden)
