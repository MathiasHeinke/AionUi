import { describe, expect, it } from 'vitest';

import { evaluateCommandEveEgressBoundary } from '@/process/commandEve/egressBoundaryCore';

/**
 * v1.6 Egress-Korpus-Gate (Spec §7.1, docs/strategy/command-eve-16-onboarding-spec-2026-07-02.md).
 *
 * The onboarding "Spiegel" turn sends the operator BRIEF — free-form German
 * business text, typically carrying phone numbers, addresses, emails, an
 * Impressum block, sometimes an IBAN — through the egress boundary toward the
 * cloud lane. Historical fault line: an over-greedy German-phone regex false
 * positive turned numeric noise into a hard 451 block → the agent aborted
 * mid-turn and the UI hung (fixed in 1.2.0 by a tighter regex + default
 * redact-and-continue).
 *
 * This gate pins, against the REAL core function in its live default mode
 * (the shim calls with policyAction 'redact' + toggleMode 'on' — see
 * packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts), that
 * realistic German operator briefs SURVIVE the boundary:
 *   (a) never blocked (no 451 equivalent), never thrown, bounded time;
 *   (b) non-PII business content passes through VERBATIM;
 *   (c) genuine PII spans are replaced with placeholders and never leak —
 *       not in the forwarded text, not in the receipt (IST contract pinned:
 *       street+number is redacted, PLZ+city survives; USt-IdNr survives);
 *   (d) the historical false-positive class (prices, dates, customer numbers,
 *       percentages, "24/7", version numbers) is NOT redacted.
 *
 * All PII below is SYNTHETIC — invented businesses, invented numbers.
 */

// Mirrors the cloud-lane provider the shim constructs for EVE Inference.
const CLOUD_PROVIDER = {
  kind: 'cloud' as const,
  name: 'EVE Inference',
  model: 'standard',
  baseUrl: 'https://example.invalid/functions/v1/eve-inference',
};

// Hard upper bound per brief. A catastrophic-backtracking regression on any
// rule regex would blow way past this; normal evaluation is single-digit ms.
const MAX_MS_PER_BRIEF = 2000;

/** The DEFAULT mode of the live cloud lane: redact-and-continue, toggle 'on'. */
async function evaluateDefault(text: string) {
  return evaluateCommandEveEgressBoundary({
    text,
    provider: CLOUD_PROVIDER,
    policyAction: 'redact',
    toggleMode: 'on',
  });
}

type OperatorBrief = {
  id: string;
  /** Reseller-operator persona the brief belongs to (business context only). */
  operator: string;
  text: string;
  /** PII-free business-core sentences that MUST remain verbatim (b + d). */
  mustKeep: string[];
  /** Exact synthetic-PII spans that MUST NOT survive into allowedText or receipt (c). */
  mustRedact: string[];
  /** Placeholders the redaction MUST leave behind (empty ⇒ clean brief, decision 'allow'). */
  expectPlaceholders: string[];
};

const CORPUS: OperatorBrief[] = [
  {
    id: 'handwerker-sanitaer',
    operator: 'Sanitärbetrieb',
    text:
      'Ich betreibe einen Sanitärbetrieb mit vier Gesellen in Augsburg. ' +
      'Wir wollen die Terminvergabe für Notfälle automatisieren. ' +
      'Kunden erreichen uns unter +49 171 2345678 oder per Mail an notdienst@sanitaer-huber-beispiel.de. ' +
      'Im Schnitt fahren wir 60 Einsätze pro Monat.',
    mustKeep: ['Wir wollen die Terminvergabe für Notfälle automatisieren.', 'Im Schnitt fahren wir 60 Einsätze pro Monat.'],
    mustRedact: ['+49 171 2345678', 'notdienst@sanitaer-huber-beispiel.de'],
    expectPlaceholders: ['[REDACTED_PHONE]', '[REDACTED_EMAIL]'],
  },
  {
    id: 'business-coach',
    operator: 'Business-Coach',
    text:
      'Als Business-Coach begleite ich Gründerinnen in den ersten zwölf Monaten. ' +
      'Mein Kennenlernpaket kostet 1.500 € und läuft über sechs Wochen. ' +
      'Rückfragen gern an mich direkt unter 0170-1234567. ' +
      'Ziel ist ein automatisierter Follow-up-Funnel nach jedem Erstgespräch.',
    mustKeep: ['Mein Kennenlernpaket kostet 1.500 € und läuft über sechs Wochen.', 'Ziel ist ein automatisierter Follow-up-Funnel nach jedem Erstgespräch.'],
    mustRedact: ['0170-1234567'],
    expectPlaceholders: ['[REDACTED_PHONE]'],
  },
  {
    id: 'agentur-impressum',
    operator: 'Social-Media-Agentur (Impressum-Passage)',
    text:
      'Wir sind eine Social-Media-Agentur mit acht Mitarbeitenden und betreuen 14 Mandate. ' +
      'Für die neue Website brauche ich ein sauberes Impressum: Muster Media GmbH, Musterstraße 12, 80331 München, ' +
      'Telefon +49 89 1234567, E-Mail info@muster-media-beispiel.de, USt-IdNr. DE812345678. ' +
      'Der Rest der Seite ist fertig.',
    mustKeep: [
      'Wir sind eine Social-Media-Agentur mit acht Mitarbeitenden und betreuen 14 Mandate.',
      'Der Rest der Seite ist fertig.',
      // IST contract pinned deliberately: only Straße+Hausnummer is an address
      // finding — PLZ+Ort survive the boundary. So does the USt-IdNr (a public
      // business identifier, not covered by any rule; the IBAN rule requires
      // ≥2 four-char groups after the checksum and correctly skips it).
      '80331 München',
      'USt-IdNr. DE812345678',
    ],
    mustRedact: ['Musterstraße 12', '+49 89 1234567', 'info@muster-media-beispiel.de'],
    expectPlaceholders: ['[REDACTED_ADDRESS]', '[REDACTED_PHONE]', '[REDACTED_EMAIL]'],
  },
  {
    id: 'steuerberater-iban-bic',
    operator: 'Steuerkanzlei',
    text:
      'Unsere Kanzlei stellt auf digitale Belegverarbeitung um. ' +
      'Mandanten überweisen Vorschüsse auf das Konto DE89 3704 0044 0532 0130 00, BIC: COBADEFFXXX. ' +
      'Bitte entwirf eine E-Mail-Vorlage, die Mandanten an fehlende Belege erinnert. ' +
      'Die Frist für den Jahresabschluss ist der 31.07.2026.',
    mustKeep: ['Bitte entwirf eine E-Mail-Vorlage, die Mandanten an fehlende Belege erinnert.', 'Die Frist für den Jahresabschluss ist der 31.07.2026.'],
    mustRedact: ['DE89 3704 0044 0532 0130 00', 'COBADEFFXXX'],
    expectPlaceholders: ['[REDACTED_IBAN]', '[REDACTED_BIC]'],
  },
  {
    id: 'physio-praxis',
    operator: 'Physiotherapie-Praxis',
    text:
      'Meine Physiotherapie-Praxis in Leipzig hat sechs Behandlungsräume. ' +
      'Neue Anfragen warten aktuell drei Wochen auf einen Termin. ' +
      'Die Praxis liegt am Lindenweg 3, 04109 Leipzig, Rezeption: 03412345678. ' +
      'Ich möchte einen digitalen Warteliste-Workflow aufsetzen.',
    mustKeep: ['Neue Anfragen warten aktuell drei Wochen auf einen Termin.', 'Ich möchte einen digitalen Warteliste-Workflow aufsetzen.', '04109 Leipzig'],
    mustRedact: ['Lindenweg 3', '03412345678'],
    expectPlaceholders: ['[REDACTED_ADDRESS]', '[REDACTED_PHONE]'],
  },
  {
    id: 'restaurant',
    operator: 'Restaurant',
    text:
      'Unser Restaurant macht ab dem 01.09.2026 eine neue Mittagskarte. ' +
      'Reservierungen kommen aktuell chaotisch über drei Kanäle rein. ' +
      'Schick Vorschläge bitte an reservierung@trattoria-beispiel.de. ' +
      'Wir haben täglich von 11:30 bis 23:00 geöffnet.',
    mustKeep: ['Unser Restaurant macht ab dem 01.09.2026 eine neue Mittagskarte.', 'Wir haben täglich von 11:30 bis 23:00 geöffnet.'],
    mustRedact: ['reservierung@trattoria-beispiel.de'],
    expectPlaceholders: ['[REDACTED_EMAIL]'],
  },
  {
    id: 'immobilienmakler',
    operator: 'Immobilienmakler',
    text:
      'Ich vermakle Bestandsimmobilien im Rhein-Main-Gebiet, etwa 30 Objekte pro Jahr. ' +
      'Exposés schreibe ich bisher komplett von Hand. ' +
      'Interessenten melden sich unter 0151 23456789. ' +
      'Ein Objekt an der Gartenallee 7a in Frankfurt geht nächste Woche live.',
    mustKeep: ['Exposés schreibe ich bisher komplett von Hand.', 'in Frankfurt geht nächste Woche live.'],
    mustRedact: ['0151 23456789', 'Gartenallee 7a'],
    expectPlaceholders: ['[REDACTED_PHONE]', '[REDACTED_ADDRESS]'],
  },
  {
    id: 'fahrschule-clean',
    operator: 'Fahrschule (kein PII — Kundennummer + Prozentwert)',
    text:
      'Unsere Fahrschule hat 240 aktive Fahrschüler und eine Bestehensquote von 78 %. ' +
      'Die Theorieprüfung buchen wir über das Portal mit der Kundennummer 4711. ' +
      'Ich brauche eine automatische Erinnerung 48 Stunden vor jeder Fahrstunde.',
    mustKeep: ['eine Bestehensquote von 78 %', 'mit der Kundennummer 4711', 'Erinnerung 48 Stunden vor jeder Fahrstunde'],
    mustRedact: [],
    expectPlaceholders: [],
  },
  {
    id: 'online-shop-clean',
    operator: 'Online-Shop (kein PII — 24/7, Version, Warenkorbwert)',
    text:
      'Wir betreiben einen Online-Shop für Hundezubehör mit 1.200 Artikeln. ' +
      'Der Support soll künftig 24/7 über einen Chatbot laufen. ' +
      'Unser Shopsystem läuft auf Version 2.4.1 und wird im Oktober aktualisiert. ' +
      'Der durchschnittliche Warenkorb liegt bei 64,90 €.',
    mustKeep: ['24/7 über einen Chatbot', 'Version 2.4.1', 'Warenkorb liegt bei 64,90 €'],
    mustRedact: [],
    expectPlaceholders: [],
  },
  {
    id: 'rechtsanwalt',
    operator: 'Kanzlei für Arbeitsrecht',
    text:
      'Unsere Kanzlei für Arbeitsrecht sitzt in Berlin und betreut 90 laufende Mandate. ' +
      'Erstberatungen vergeben wir telefonisch unter 030/1234567. ' +
      'Zuarbeiten gehen an kanzlei@recht-beispiel.de. ' +
      'Entwirf bitte eine Vorlage für Fristverlängerungsanträge.',
    mustKeep: ['betreut 90 laufende Mandate.', 'Entwirf bitte eine Vorlage für Fristverlängerungsanträge.'],
    mustRedact: ['030/1234567', 'kanzlei@recht-beispiel.de'],
    expectPlaceholders: ['[REDACTED_PHONE]', '[REDACTED_EMAIL]'],
  },
  {
    id: 'baeckerei',
    operator: 'Bäckerei',
    text:
      'Unsere Bäckerei beliefert 17 Cafés im Umkreis von Augsburg. ' +
      'Bestellungen nehmen wir bis 16:00 Uhr unter 0821 4567890 an. ' +
      'Die Tourenplanung für die Fahrer kostet mich jeden Abend eine Stunde. ' +
      'Das will ich automatisieren.',
    mustKeep: ['Unsere Bäckerei beliefert 17 Cafés im Umkreis von Augsburg.', 'Bestellungen nehmen wir bis 16:00 Uhr', 'Die Tourenplanung für die Fahrer kostet mich jeden Abend eine Stunde.'],
    mustRedact: ['0821 4567890'],
    expectPlaceholders: ['[REDACTED_PHONE]'],
  },
  {
    id: 'fitnessstudio-clean',
    operator: 'Fitnessstudio (kein PII — Tarife + Quote)',
    text:
      'Unser Fitnessstudio hat 850 Mitglieder und drei Tarife: 29,90 €, 39,90 € und 49,90 € im Monat. ' +
      'Die Kündigungsquote liegt bei 3,2 % pro Quartal. ' +
      'Ich will einen Reaktivierungs-Funnel für ehemalige Mitglieder.',
    mustKeep: ['drei Tarife: 29,90 €, 39,90 € und 49,90 € im Monat.', 'Die Kündigungsquote liegt bei 3,2 % pro Quartal.'],
    mustRedact: [],
    expectPlaceholders: [],
  },
  {
    id: 'fotograf-paren-phone',
    operator: 'Hochzeitsfotograf',
    text:
      'Ich fotografiere Hochzeiten und Firmenevents rund um München. ' +
      'Buchungsanfragen kommen über das Studio unter (089) 1234567 oder an studio@licht-beispiel.de. ' +
      'Pro Saison schaffe ich maximal 35 Hochzeiten. ' +
      'Ich brauche ein besseres Angebots-Template.',
    mustKeep: ['Pro Saison schaffe ich maximal 35 Hochzeiten.', 'Ich brauche ein besseres Angebots-Template.'],
    // IST contract: "(089) 1234567" IS redacted today — but by the
    // north-american-phone rule (the paren form + 7 local digits happens to fit
    // the NANP shape), NOT by german-phone-number. See the dedicated pin +
    // it.fails below for the 8-digit sibling this accident does NOT cover.
    mustRedact: ['(089) 1234567', 'studio@licht-beispiel.de'],
    expectPlaceholders: ['[REDACTED_PHONE]', '[REDACTED_EMAIL]'],
  },
  {
    id: 'hausverwaltung-iban-contiguous',
    operator: 'Hausverwaltung',
    text:
      'Wir verwalten 42 Wohneinheiten in Dresden und Umgebung. ' +
      'Die Nebenkostenabrechnung 2025 muss bis Ende des Quartals raus. ' +
      'Mieteingänge laufen über DE02120300000000202051. ' +
      'Entwirf ein Anschreiben für die Betriebskostenanpassung von 4,8 %.',
    mustKeep: ['Die Nebenkostenabrechnung 2025 muss bis Ende des Quartals raus.', 'Betriebskostenanpassung von 4,8 %'],
    mustRedact: ['DE02120300000000202051'],
    expectPlaceholders: ['[REDACTED_IBAN]'],
  },
  {
    id: 'it-systemhaus',
    operator: 'IT-Systemhaus',
    text:
      'Wir betreuen als IT-Systemhaus 60 kleine Unternehmen im Münsterland. ' +
      'Störungen melden Kunden über die Hotline +49 (0) 251 987654. ' +
      'Unser Ticketsystem erzeugt daraus bisher keine sauberen Berichte. ' +
      'Monatsreports für die fünf größten Kunden wären der Anfang.',
    mustKeep: ['Unser Ticketsystem erzeugt daraus bisher keine sauberen Berichte.', 'Monatsreports für die fünf größten Kunden wären der Anfang.'],
    mustRedact: ['+49 (0) 251 987654'],
    expectPlaceholders: ['[REDACTED_PHONE]'],
  },
  {
    id: 'hochzeitsplanerin-clean',
    operator: 'Hochzeitsplanerin (kein PII — Budgets + Datum)',
    text:
      'Als Hochzeitsplanerin koordiniere ich zwölf Feiern pro Saison. ' +
      'Das Budget pro Hochzeit liegt zwischen 15.000 € und 45.000 €. ' +
      'Am 15.08.2026 habe ich eine Doppelbuchung entdeckt. ' +
      'Hilf mir, einen Konfliktcheck für den Kalender zu bauen.',
    mustKeep: ['zwischen 15.000 € und 45.000 €', 'Am 15.08.2026 habe ich eine Doppelbuchung entdeckt.'],
    mustRedact: [],
    expectPlaceholders: [],
  },
  {
    id: 'autowerkstatt-contiguous-phone',
    operator: 'Freie Autowerkstatt',
    text:
      'Unsere freie Werkstatt macht 30 Ölwechsel pro Woche. ' +
      'Der Hol- und Bringservice wird unter 01761234567 vereinbart. ' +
      'Für Stammkunden wie den Wagen mit dem Kennzeichen M-AB 1234 wollen wir automatische Serviceerinnerungen. ' +
      'HU-Termine verwalten wir noch auf Papier.',
    // The contiguous no-separator mobile is the dominant German typing form —
    // a v1.1.78-era tighten regressed it to raw egress once; never again.
    mustKeep: ['Kennzeichen M-AB 1234', 'HU-Termine verwalten wir noch auf Papier.'],
    mustRedact: ['01761234567'],
    expectPlaceholders: ['[REDACTED_PHONE]'],
  },
  {
    id: 'nachhilfe-clean',
    operator: 'Nachhilfe-Institut (kein PII — Steuernummer bleibt)',
    text:
      'Unser Nachhilfe-Institut betreut 130 Schüler in Mathe und Physik. ' +
      'Die Steuernummer 143/456/78901 brauche ich für die neue Rechnungsvorlage. ' +
      'Im Schuljahr 2025/26 sind die Anmeldungen um 22 % gestiegen. ' +
      'Baue mir bitte eine Vorlage für Elternbriefe.',
    // IST contract: a German Steuernummer in 3/3/5 slash form is NOT covered by
    // any rule today and passes through (it does not fit the phone shapes).
    mustKeep: ['Die Steuernummer 143/456/78901 brauche ich für die neue Rechnungsvorlage.', 'Im Schuljahr 2025/26 sind die Anmeldungen um 22 % gestiegen.'],
    mustRedact: [],
    expectPlaceholders: [],
  },
  {
    id: 'galabau',
    operator: 'Garten- und Landschaftsbau',
    text:
      'Unser Garten- und Landschaftsbau-Betrieb baut gerade drei Musterterrassen. ' +
      'Das Büro am Beispielplatz 5 in Kassel ist donnerstags besetzt. ' +
      'Angebote fasse ich unter 0049 561 334455 nach. ' +
      'Die Materialpreise sind seit März um 8 % gestiegen.',
    mustKeep: ['in Kassel ist donnerstags besetzt.', 'Die Materialpreise sind seit März um 8 % gestiegen.'],
    mustRedact: ['Beispielplatz 5', '0049 561 334455'],
    expectPlaceholders: ['[REDACTED_ADDRESS]', '[REDACTED_PHONE]'],
  },
  {
    id: 'friseursalon',
    operator: 'Friseursalon',
    text:
      'Unser Friseursalon hat vier Stühle und arbeitet zu 92 % ausgelastet. ' +
      'Terminausfälle kosten uns rund 950 € pro Monat. ' +
      'Erinnerungen gehen bisher manuell per Mail an termine@salon-beispiel.de raus. ' +
      'Ich will das automatisieren, ohne neue Software zu kaufen.',
    mustKeep: ['arbeitet zu 92 % ausgelastet.', 'Terminausfälle kosten uns rund 950 € pro Monat.'],
    mustRedact: ['termine@salon-beispiel.de'],
    expectPlaceholders: ['[REDACTED_EMAIL]'],
  },
  {
    id: 'usa-berater-intl-phone',
    operator: 'Markteintritts-Berater (US-Kontakt)',
    text:
      'Ich berate deutsche Softwarefirmen beim Markteintritt in die USA. ' +
      'Mein Ansprechpartner bei der Handelskammer in Chicago ist unter +1 312 555 0148 erreichbar. ' +
      'Der Beratungstag kostet 2.400 € netto. ' +
      'Baue mir eine zweisprachige Angebotsvorlage.',
    mustKeep: ['Der Beratungstag kostet 2.400 € netto.', 'Baue mir eine zweisprachige Angebotsvorlage.'],
    mustRedact: ['+1 312 555 0148'],
    expectPlaceholders: ['[REDACTED_PHONE]'],
  },
];

describe('v1.6 egress brief corpus gate — realistic German operator briefs survive the boundary', () => {
  for (const brief of CORPUS) {
    it(`[${brief.id}] ${brief.operator}: survives, keeps business core, strips PII`, async () => {
      // (a) The Spiegel turn must never throw and never hang: bounded wall time.
      const startedAt = performance.now();
      const result = await evaluateDefault(brief.text);
      const elapsedMs = performance.now() - startedAt;
      expect(elapsedMs).toBeLessThan(MAX_MS_PER_BRIEF);

      // (a) Never the 451 equivalent: the default lane redacts-and-continues.
      expect(result.decision).not.toBe('block');
      expect(result.allowedText).toBeDefined();
      const forwarded = result.allowedText as string;

      // (b) + (d) Business-core sentences (incl. prices, dates, customer
      // numbers, percentages, 24/7, version numbers) remain VERBATIM.
      for (const keep of brief.mustKeep) {
        expect(forwarded).toContain(keep);
      }

      if (brief.mustRedact.length === 0) {
        // Clean brief: byte-identical pass-through, zero findings.
        expect(result.decision).toBe('allow');
        expect(forwarded).toBe(brief.text);
        expect(result.receipt.finding_count).toBe(0);
        return;
      }

      // (c) Genuine PII spans are replaced in the default redact mode.
      expect(result.decision).toBe('redact');
      for (const pii of brief.mustRedact) {
        expect(forwarded).not.toContain(pii);
      }
      for (const placeholder of brief.expectPlaceholders) {
        expect(forwarded).toContain(placeholder);
      }

      // The receipt is evidence, not a leak: hashes only, never raw PII.
      expect(result.receipt.raw_text_stored).toBe(false);
      expect(result.receipt.finding_count).toBeGreaterThan(0);
      const receiptJson = JSON.stringify(result.receipt);
      for (const pii of brief.mustRedact) {
        expect(receiptJson).not.toContain(pii);
      }
    });
  }

  it('legacy path (no toggle context) forwards byte-identical text for every brief — no drift between caller paths', async () => {
    for (const brief of CORPUS) {
      const gatePath = await evaluateDefault(brief.text);
      const legacyPath = await evaluateCommandEveEgressBoundary({
        text: brief.text,
        provider: CLOUD_PROVIDER,
        policyAction: 'redact',
      });
      expect(legacyPath.decision).toBe(gatePath.decision);
      expect(legacyPath.allowedText).toBe(gatePath.allowedText);
    }
  });

  it('regression (1.2.0 fault line): the numeric false-positive class is never redacted and never blocks', async () => {
    // Prices, dates, order/customer numbers, percentages, 24/7, versions —
    // exactly the class the old greedy phone regex turned into 99 phantom
    // findings and a hard 451 → tool hang.
    const numericNoiseBrief =
      'Unser Angebot Nr. 2026-118 über 12.500 € netto gilt bis 15.08.2026. ' +
      'Die Anzahlung von 30 % ist am 01.09.2026 fällig, Restzahlung nach Abnahme. ' +
      'Support erreichen Sie 24/7 über das Kundenportal, Version 3.2.1 des Portals erscheint am 01.10.2026. ' +
      'Ihre Kundennummer lautet 2026-4711, die Auftragsnummer 0815 bleibt bestehen.';

    const result = await evaluateDefault(numericNoiseBrief);

    expect(result.decision).toBe('allow');
    expect(result.allowedText).toBe(numericNoiseBrief);
    expect(result.receipt.finding_count).toBe(0);
    expect(result.receipt.findings.some((finding) => finding.rule_id === 'german-phone-number')).toBe(false);
  });

  it('"(089) 1234567" (paren form, 7 local digits) is caught by the GERMAN rule (branch C), no NANP accident anymore', async () => {
    // History: before branch (C) this form was redacted only by ACCIDENT — 7
    // local digits happen to fit the NANP (NNN) NNN-NNNN shape. The corpus gate
    // exposed the 8-digit sibling leaking raw; branch (C) now covers the
    // parenthesised German trunk properly, so the GERMAN rule owns this match.
    const result = await evaluateDefault('Buchungsanfragen kommen über das Studio unter (089) 1234567 herein.');

    expect(result.decision).toBe('redact');
    expect(result.allowedText).not.toContain('1234567');
    expect(result.receipt.findings.some((finding) => finding.rule_id === 'german-phone-number')).toBe(true);
  });

  it('GATE FINDING CLOSED: "(089) 12345678" — paren city code + 8 local digits — is redacted (was a raw leak)', async () => {
    // Found by this corpus gate on 2026-07-03: the completely common German
    // landline spelling "(089) 12345678" was matched by NO rule (german-phone
    // broke its 0-trunk tail at the ")", NANP needs exactly 3+4 local digits)
    // and egressed RAW to the cloud lane. Branch (C) in german-phone-number
    // closes it; the 1.2.0 false-positive regression list below stays green.
    const result = await evaluateDefault('Sie erreichen unsere Zentrale unter (089) 12345678 am Vormittag.');

    expect(result.decision).toBe('redact');
    expect(result.allowedText).not.toContain('12345678');
    expect(result.receipt.findings.some((finding) => finding.rule_id === 'german-phone-number')).toBe(true);
  });
});
