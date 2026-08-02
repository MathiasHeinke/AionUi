/**
 * THE APPROVED-COPY MANIFEST FOR THE CLIENT'S LOCALE SURFACES.
 *
 * WHAT THIS GATE IS, STATED BEFORE ANYTHING ELSE, BECAUSE THE FAILURE MODE IT REPLACES
 * IS "A TEST PASSED WHILE THE PROPERTY IT NAMED WAS FALSE":
 *
 *   THIS IS NOT A TRUTH ORACLE, AND IT IS NOT A DETECTOR.
 *
 *   CI cannot infer truth semantically. It cannot read a German sentence and decide
 *   whether the business behind it can underwrite the promise in it. The sibling web repo
 *   tried exactly that, twice, and lost twice:
 *
 *     v1 — a fixed-phrase blocklist of guarantee wordings. A novel guarantee sharing no
 *          literal with the list shipped GREEN.
 *     v2 — a CATEGORY rule (an outcome noun within one clause of an un-negated guarantee
 *          word), proven by five probes that all reddened. Then one isolated probe
 *          defeated it:
 *              "Wir sichern dir den ersten zahlenden Auftraggeber binnen vier Wochen zu."
 *          separable "sichern … zu" instead of *garantieren*, *Auftraggeber* instead of
 *          *Kunde*. Neither token was in the vocabulary. MEASURED: exit 0.
 *
 *   A SYNONYM VOCABULARY IS NOT SEMANTIC COVERAGE. The next sentence is always drawn from
 *   outside whatever vocabulary was written.
 *
 * THIS REPOSITORY HAD THE SAME DEFECT IN A WORSE FORM. The desktop client ships its live
 * product, pricing and trial copy in packages/desktop/src/renderer/services/i18n/locales/**
 * — de-DE/registrationGate.json states the 99 €/100.000-credit terms — and no committed
 * test enumerated that copy as a reviewed contract. (One test,
 * tests/unit/renderer/eveMaxLabels.i18n.test.ts, loads the DE/EN bundles to prove six
 * named MAX keys RESOLVE; it asserts nothing about what any other string says.) A
 * guarantee sentence added to a locale file would have shipped green.
 *
 * SO THE BOUNDARY HERE IS PROCEDURAL, NOT SEMANTIC. Every translated string on every
 * covered locale surface is listed verbatim in approved-copy.manifest.txt, and these tests
 * FAIL CLOSED on any difference: a new string, a changed string, a string that vanished, a
 * surface that appeared, a surface that disappeared, an occurrence count that moved.
 * Editing product copy REQUIRES a visible, verbatim manifest diff. THE DIFF IS THE REVIEW.
 *
 * WHAT THAT DOES NOT BUY, SO NOBODY INHERITS A CLAIM THAT WAS NEVER MADE:
 *   * A reviewer can approve a FALSE sentence and this gate goes green. What becomes
 *     impossible is shipping the sentence without someone looking at it, in a diff, beside
 *     the sentence it replaced.
 *   * IT DOES NOT COVER THE EIGHT OTHER BUNDLED LANGUAGES' own translations. See the
 *     honest-boundary test below, which asserts the measured reason that gap is narrow
 *     rather than merely claiming it.
 *   * IT DOES NOT COVER COPY THAT IS NOT IN A LOCALE FILE — hardcoded .tsx strings,
 *     main-process strings, bundled skill text, the marketing website. Those are other
 *     lanes and other gates; this one stops at the locale tree and says so.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COVERED_LOCALES,
  EXCLUDED_FILENAMES,
  LOCALES_ROOT,
  LOCALES_ROOT_ID,
  MANIFEST_PATH,
  REPO_ROOT,
  activeSurfaces,
  allLocalesOnDisk,
  FREE_WORD,
  ZERO_COST_CLAIM,
  diffContract,
  discoverSurfaces,
  extractCopy,
  observeContract,
  readManifest,
  serialiseManifest,
  uncoveredLocales,
} from '../../../scripts/approved-copy/core.mjs';

const SURFACES = discoverSurfaces();
const ACTIVE_SURFACES = activeSurfaces(SURFACES);
const OBSERVED = observeContract(SURFACES);
const MANIFEST = readManifest();
const MANIFEST_TEXT = readFileSync(MANIFEST_PATH, 'utf8');

/**
 * The nine Command EVE product namespaces. Named, not counted: a count still passes when
 * the walk quietly stops reaching a file, and these are the pricing, credits, trial, seat,
 * local-runtime and operator-cockpit surfaces.
 */
const PRODUCT_NAMESPACES = [
  'commandCenter',
  'commandEve',
  'connectorCatalog',
  'credits',
  'deinTeam',
  'kanban',
  'localRuntime',
  'registrationGate',
  'skillLibrary',
];

describe('APPROVED-COPY MANIFEST — the covered locale surfaces', () => {
  it('the covered surface roster is EXACTLY the manifest roster', () => {
    const d = diffContract(OBSERVED, MANIFEST);
    expect(
      d.newSurfaces,
      'a covered locale surface exists that the approved-copy manifest does not list. A ' +
        'surface silently outside the manifest is the exact defect this replaces. Run: ' +
        `node scripts/approved-copy/update.mjs, then review the diff.\n${d.newSurfaces.join('\n')}`
    ).toEqual([]);
    expect(
      d.missingSurfaces,
      'the manifest lists a surface that no longer exists. A stale entry must not rot ' +
        `silently — delete it deliberately.\n${d.missingSurfaces.join('\n')}`
    ).toEqual([]);
  });

  it('every product/pricing/trial/MAX/cockpit namespace is covered in BOTH shipped languages', () => {
    for (const locale of ['de-DE', 'en-US']) {
      expect(COVERED_LOCALES, `${locale} dropped out of the covered locale set`).toContain(locale);
      for (const ns of [...PRODUCT_NAMESPACES, 'common', 'conversation', 'settings', 'login']) {
        const required = `${locale}/${ns}.json`;
        expect(MANIFEST.surfaces, `${required} is not covered by the approved-copy manifest`).toContain(required);
        expect(ACTIVE_SURFACES, `${required} dropped out of the covered surface walk`).toContain(required);
      }
    }
    // The measured hole this whole mechanism was built for, pinned by content and not only
    // by filename: the 99 EUR / 100.000-credit terms are inside the contract, in both
    // languages, verbatim.
    expect(MANIFEST.copy.get('de-DE/registrationGate.json')?.size ?? 0).toBeGreaterThan(30);
    expect([...(MANIFEST.copy.get('de-DE/registrationGate.json')?.keys() ?? [])]).toContain(
      'Standard: 99 €/Monat — inkl. 100.000 Credits und allen Seats (Team, Projekte, Kunden) ohne Aufpreis.'
    );
    expect([...(MANIFEST.copy.get('en-US/registrationGate.json')?.keys() ?? [])]).toContain(
      'Standard: 99 €/month — incl. 100,000 credits and every seat (team, projects, clients) at no extra charge.'
    );
  });

  it('no unapproved, changed or vanished copy on any covered surface', () => {
    const d = diffContract(OBSERVED, MANIFEST);
    const report = [
      ...d.unknown.map((s: string) => `ADDED or CHANGED (not approved): ${s}`),
      ...d.miscounted.map((s: string) => `OCCURRENCE COUNT MOVED: ${s}`),
      ...d.rotted.map((s: string) => `APPROVED BUT GONE (stale manifest entry): ${s}`),
    ];
    expect(
      report,
      'locale copy differs from the reviewed manifest. This gate makes NO judgement about ' +
        'whether the sentence is true — CI cannot infer truth semantically. It requires that ' +
        'a human SAW it: run `node scripts/approved-copy/update.mjs` and get the resulting ' +
        `manifest diff reviewed. The diff IS the review.\n${report.join('\n')}`
    ).toEqual([]);
  });

  it('the declared counts match the records (a truncated manifest is a red gate)', () => {
    expect(MANIFEST.declaredSurfaces, 'the header declares a different surface count than it lists').toBe(
      MANIFEST.surfaces.length
    );
    expect(MANIFEST.declaredEntries, 'the header declares a different entry count than it lists').toBe(
      MANIFEST.entries
    );
    expect(MANIFEST.entries, `only ${MANIFEST.entries} approved strings — the manifest was gutted`).toBeGreaterThan(
      6000
    );
    // The committed file must be exactly what the updater produces from the surfaces as
    // they stand. Anything else means it was hand-edited into agreement rather than
    // regenerated, which would let a reviewer approve a line that is not in the product.
    expect(
      MANIFEST_TEXT === serialiseManifest(OBSERVED),
      'the committed manifest is not byte-identical to what scripts/approved-copy/update.mjs produces'
    ).toBe(true);
  });
});

describe('APPROVED-COPY MANIFEST — the boundary is stated, not inherited', () => {
  it('the manifest itself declares what it is not, and what it does not cover', () => {
    for (const claim of [
      /IT IS NOT A TRUTH ORACLE/,
      /CI cannot infer truth semantically/,
      /WHAT IS NOT COVERED, STATED RATHER THAN INHERITED/,
      /THE OTHER BUNDLED LANGUAGES/,
      /COPY THAT IS NOT IN A LOCALE FILE/,
      /THE UPDATER IS MANUAL BY CONSTRUCTION AND THAT IS ENFORCED/,
    ]) {
      expect(MANIFEST_TEXT, `the manifest header no longer states: ${claim}`).toMatch(claim);
    }
  });

  it('the uncovered languages are REAL, ENUMERATED, and named in the header', () => {
    const uncovered = uncoveredLocales();
    // "Excluded" must describe something, or the exclusion is decoration.
    expect(uncovered.length, 'no uncovered locale exists — the stated exclusion describes nothing').toBeGreaterThan(0);
    // Every locale on disk is accounted for as either covered or explicitly uncovered.
    // A locale that fell into neither bucket would be invisible to both halves of the
    // boundary, which is the silent-hole shape this whole mechanism exists to end.
    expect([...COVERED_LOCALES, ...uncovered].toSorted()).toEqual(allLocalesOnDisk());
    for (const locale of uncovered) {
      expect(MANIFEST_TEXT, `${locale} is excluded but the manifest header never says so`).toContain(locale);
      expect(MANIFEST.surfaces.filter((id: string) => id.startsWith(`${locale}/`))).toEqual([]);
    }
  });

  it('the reason the gap is NARROW is MEASURED here, not asserted in prose', () => {
    // The header claims: the nine Command EVE product namespaces exist ONLY in the covered
    // locales, so every other language is rendered the covered de-DE strings through
    // mergeWithFallback. If that ever stops being true — someone adds registrationGate.json
    // to zh-CN — this reds, because at that moment untracked pricing copy exists.
    for (const locale of uncoveredLocales()) {
      const files = readdirSync(path.join(LOCALES_ROOT, locale));
      for (const ns of PRODUCT_NAMESPACES) {
        expect(
          files,
          `${locale}/${ns}.json now exists: product copy lives outside the manifest, and the ` +
            'header\'s "they inherit de-DE through mergeWithFallback" justification is no longer true.'
        ).not.toContain(`${ns}.json`);
      }
    }
    // …and the fallback really is a covered locale, which is the other half of that claim.
    const i18nConfig = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'packages/desktop/src/common/config/i18n-config.json'), 'utf8')
    );
    expect(COVERED_LOCALES).toContain(i18nConfig.fallbackLanguage);
    expect(COVERED_LOCALES.toSorted()).toEqual([...i18nConfig.supportedLanguages].toSorted());
  });

  it('the only non-.json file in a covered locale directory is the module index', () => {
    for (const locale of COVERED_LOCALES) {
      const strays = readdirSync(path.join(LOCALES_ROOT, locale)).filter(
        (f: string) => !f.endsWith('.json') && !EXCLUDED_FILENAMES.includes(f)
      );
      expect(
        strays,
        `${locale} carries file(s) that are neither a covered .json surface nor the module ` +
          `index. If they hold copy they are outside the contract.\n${strays.join('\n')}`
      ).toEqual([]);
    }
    expect(LOCALES_ROOT_ID).toBe('packages/desktop/src/renderer/services/i18n/locales');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// THE PROOF — one probe per property, every probe wording the RULES DO NOT KNOW
// ══════════════════════════════════════════════════════════════════════════════
//
// `contractOf` derives BOTH sides the same way the updater does, so this is a faithful
// simulation of "surface vs. manifest" rather than a second implementation that could
// agree with itself while the real one disagrees.
const contractOf = (id: string, source: string) => ({
  surfaces: [id],
  copy: new Map([[id, extractCopy(id, source)]]),
});
const compare = (id: string, source: string, approvedSource: string) =>
  diffContract(contractOf(id, source), contractOf(id, approvedSource));

const FIXTURE_ID = 'de-DE/registrationGate.json';
const APPROVED_FIXTURE = JSON.stringify(
  {
    curtain: {
      price: 'Standard: 99 €/Monat — inkl. 100.000 Credits und allen Seats (Team, Projekte, Kunden) ohne Aufpreis.',
      hint: 'Der Button öffnet dein Konto im Browser — kein Kauf passiert hier in der App und nichts wird automatisch verlängert.',
    },
  },
  null,
  2
);

const inject = (json: string, key: string, sentence: string): string => {
  const parsed = JSON.parse(json) as { curtain: Record<string, string> };
  parsed.curtain[key] = sentence;
  return JSON.stringify(parsed, null, 2);
};

/**
 * THE VOCABULARIES THAT WERE TRIED AND DEFEATED, reproduced verbatim from the sibling web
 * gate ONLY so the probes below can be proven BLIND to them.
 *
 * This is the anti-circularity apparatus, and it is the point. Twice in this estate an
 * outcome-guarantee gate was "proven" by probes drawn from the rule's own vocabulary
 * neighbourhood — the test passed, the property was false. If a future edit ever teaches
 * one of these rules one of the probes, the assertions below RED rather than the proof
 * quietly turning into a vocabulary demonstration that proves nothing about the manifest.
 */
const OUTCOME_NOUN =
  '(?:Kund(?:e|en|in|innen)\\w*|Neukund\\w*|Auftr(?:ag|äge|aege)\\w*|Deals?|Leads?|Buchung\\w*|Termin\\w*' +
  '|Umsatz(?!steuer)\\w*|Ergebnis\\w*|Resultat\\w*|clients?|customers?|deals?|leads?|bookings?' +
  '|appointments?|revenue|results?|outcomes?)';
const NEGATOR = '(?:kein|keine[nmrs]?|nicht|niemals|\\bnie\\b|ohne|\\bno\\b|\\bnot\\b|never|without|statt)';
const GUARANTEE_WORD =
  '(?:garantier\\w*|Garantie\\w*|zugesichert\\w*|erstatt\\w*|r(?:ü|ue)ckerstatt\\w*|Geld\\s*zur(?:ü|ue)ck' +
  '|zahlst\\s+du\\s+nichts|kostet\\s+(?:es\\s+|dich\\s+)?nichts|oder\\s+(?:es\\s+ist\\s+)?(?:gratis|kostenlos)' +
  "|guarantee\\w*|money[-\\s]?back|refund\\w*|or\\s+(?:it'?s\\s+)?free|no\\s+cure[,\\s]*no\\s+pay" +
  '|risikofrei|risk[-\\s]?free)';
const UNNEGATED_GUARANTEE = `(?<!${NEGATOR}\\s)(?<!${NEGATOR}\\s\\w{1,6}\\s)${GUARANTEE_WORD}`;
const REFUND_PROMISE =
  /wir\s+erstatten|wir\s+zahlen[^.\n]{0,25}zur(?:ü|ue)ck|Geld[-\s]?zur(?:ü|ue)ck[-\s]?Garantie|we(?:'ll| will)?\s+refund|refund\s+(?:you|your\s+money|everything|it\s+all)|money[-\s]?back\s+guarantee/i;
const OUTCOME_GUARANTEE = new RegExp(
  `${OUTCOME_NOUN}[^.\\n!?]{0,60}?${UNNEGATED_GUARANTEE}` +
    `|${UNNEGATED_GUARANTEE}[^.\\n!?]{0,60}?${OUTCOME_NOUN}` +
    `|${REFUND_PROMISE.source}`,
  'i'
);
const LEGACY_GUARANTEE_PHRASES =
  /14\s*Tage\s*oder\s*gratis|14\s*days?\s*or\s*(?:it'?s\s*)?free|Erster[-\s]?Kunde[-\s]?läuft|first[-\s]?client[-\s]?runs|Zwei Garantien|Two guarantees|zahlst du nichts|you pay nothing|Erfolgsgarantie|Liefergarantie|Geld[-\s]?zurück|money[-\s]?back/i;
// THE TWO ZERO-COST RULES NOW LIVE IN core.mjs, and are imported rather than declared.
// They stopped being private the moment a SECOND gate needed them: the same claim class
// ships in hardcoded .ts strings, which this manifest deliberately does not cover (see the
// header). One definition, two consumers — a rule copied into a second file is a rule that
// will eventually disagree with itself.

const VOCABULARY: { name: string; rx: RegExp }[] = [
  { name: 'OUTCOME_GUARANTEE (the category rule that v2 relied on)', rx: OUTCOME_GUARANTEE },
  { name: 'LEGACY_GUARANTEE_PHRASES (the v1 fixed-phrase blocklist)', rx: LEGACY_GUARANTEE_PHRASES },
  { name: 'REFUND_PROMISE', rx: REFUND_PROMISE },
  { name: 'FREE_WORD', rx: FREE_WORD },
  { name: 'ZERO_COST_CLAIM', rx: ZERO_COST_CLAIM },
];
const vocabularyHits = (s: string): string[] => VOCABULARY.filter(({ rx }) => rx.test(s)).map((r) => r.name);

/**
 * THE SECOND HALF OF THE ANTI-CIRCULARITY GUARD — AND ITS HONEST BOUND.
 *
 * The list above proves the probes are blind to the rules THIS FILE carries. This sweep
 * adds the other realistic circularity path: somebody pastes one of these probe sentences
 * into another gate as a literal, and from then on the probe is "caught" by wording that
 * was copied from the probe itself.
 *
 * IT SWEEPS DISTINCTIVE PHRASES, NOT SINGLE WORDS, AND THAT IS A MEASURED DECISION.
 *   * Single tokens are useless here: `Auftraggeber` is ordinary German business
 *     vocabulary and appears in three unrelated prompt fixtures in this repo
 *     (runtimeBootstrapCore, seatContextBridgePrompt, userMdTierStampCore). A sweep that
 *     reddens on those measures the German language, not circularity.
 *   * "Does ANY regex in the repo match the probe" is worse than useless: MEASURED across
 *     2069 extracted regex literals, 100 of them match a probe — because `/\s+/g` matches
 *     every sentence ever written. A sweep whose positives are dominated by `/\s+/` is a
 *     sweep nobody can act on.
 * So this is bounded to phrase-level literals, and the bound is written down instead of
 * being discovered later by whoever trusts it.
 */
const scanSources = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js|cjs)$/.test(entry.name)) found.push(full);
    }
  };
  for (const sub of ['tests', 'scripts']) walk(path.join(REPO_ROOT, sub));
  // The mechanism's OWN files are allowlisted: this gate and the two approved-copy
  // modules quote the probes in their prose on purpose, to explain why they exist. They
  // are documentation, not a rule that could catch anything.
  const own = [
    fileURLToPath(import.meta.url),
    path.join(REPO_ROOT, 'scripts/approved-copy/core.mjs'),
    path.join(REPO_ROOT, 'scripts/approved-copy/update.mjs'),
  ];
  for (const f of own) {
    if (!found.includes(f)) throw new Error(`the anti-circularity allowlist names a file that does not exist: ${f}`);
  }
  return found.filter((f) => !own.includes(f)).toSorted();
};
const OTHER_SOURCES = scanSources();

const noOtherGateKnows = (tokens: RegExp[]): string[] => {
  const hits: string[] = [];
  for (const file of OTHER_SOURCES) {
    const text = readFileSync(file, 'utf8');
    for (const rx of tokens) {
      if (rx.test(text)) hits.push(`${path.relative(REPO_ROOT, file)} matches ${rx}`);
    }
  }
  return hits;
};

describe('SELF-TEST — the manifest carries what no vocabulary can', () => {
  it('the scan that proves the probes are novel is really scanning something', () => {
    expect(OTHER_SOURCES.length, 'the tests/scripts walk emptied out').toBeGreaterThan(400);
  });

  it('(a) catches the DE guarantee that DEFEATED the category rule — with NO rule firing', () => {
    const DEFEATED_V2 = 'Wir sichern dir den ersten zahlenden Auftraggeber binnen vier Wochen zu.';
    // Asserted BLIND first. If a future edit teaches a vocabulary rule this sentence, this
    // reds instead of the proof quietly becoming circular.
    expect(
      vocabularyHits(DEFEATED_V2),
      'a vocabulary rule now happens to catch this probe. That is not the point and it is ' +
        'not a closure: replace the probe with wording the rules do not know, or this is circular.'
    ).toEqual([]);
    expect(OUTCOME_GUARANTEE.test(DEFEATED_V2), 'the category rule is documented as BLIND to this').toBe(false);
    expect(LEGACY_GUARANTEE_PHRASES.test(DEFEATED_V2)).toBe(false);
    // NAME THE EXACT REASON IT ESCAPES, so a future edit that removes the reason reds here
    // rather than leaving a probe that "still passes" for a different reason than the one
    // documented. The outcome noun IS present (Auftraggeber matches Auftrag\w*); what is
    // absent is the GUARANTEE half, because "sichern … zu" is not in any guarantee
    // vocabulary. That asymmetry IS the defeat, and it is asserted, not narrated.
    expect(new RegExp(OUTCOME_NOUN, 'i').test(DEFEATED_V2), 'the outcome noun half is present').toBe(true);
    expect(
      new RegExp(GUARANTEE_WORD, 'i').test(DEFEATED_V2),
      'a guarantee word is now present in the probe, so the probe no longer demonstrates the defeat'
    ).toBe(false);
    expect(noOtherGateKnows([/sichern dir den ersten zahlenden/i, /binnen vier Wochen zu/i])).toEqual([]);

    // …and the manifest reds on it anyway, because it is a string nobody approved.
    const sabotaged = inject(APPROVED_FIXTURE, 'promise', DEFEATED_V2);
    const d = compare(FIXTURE_ID, sabotaged, APPROVED_FIXTURE);
    expect(d.unknown.length, `expected exactly one unapproved string, got ${JSON.stringify(d.unknown)}`).toBe(1);
    expect(d.unknown[0]).toMatch(/Auftraggeber binnen vier Wochen zu/);
    expect([d.rotted, d.miscounted, d.newSurfaces, d.missingSurfaces]).toEqual([[], [], [], []]);
  });

  it('(b) catches a NOVEL EN guarantee invented here, sharing no literal with any rule', () => {
    // Invented for this test, deliberately outside every vocabulary above and outside the
    // sibling repo's own probe: no guarantee/garantie/zusichern word, no refund/erstatten
    // word, no money-back, no risk-free, no free-word, no outcome noun (client, customer,
    // deal, lead, booking, appointment, revenue, result, outcome), no digit, no currency.
    const NOVEL_EN =
      'Should your calendar still stand empty when the eighth week closes, we wire the whole sum home to you.';
    expect(vocabularyHits(NOVEL_EN), 'a vocabulary rule fires on the novel probe, so it proves nothing').toEqual([]);
    expect(OUTCOME_GUARANTEE.test(NOVEL_EN)).toBe(false);
    expect(REFUND_PROMISE.test(NOVEL_EN)).toBe(false);
    expect(FREE_WORD.test(NOVEL_EN)).toBe(false);
    // BOTH halves absent this time, unlike probe (a) — this sentence is outside the outcome
    // vocabulary as well as the guarantee vocabulary, which is what "novel" has to mean.
    expect(new RegExp(OUTCOME_NOUN, 'i').test(NOVEL_EN), 'the probe drifted into the outcome vocabulary').toBe(false);
    expect(new RegExp(GUARANTEE_WORD, 'i').test(NOVEL_EN), 'the probe drifted into the guarantee vocabulary').toBe(
      false
    );
    expect(noOtherGateKnows([/eighth week closes/i, /wire the whole sum home/i])).toEqual([]);

    const sabotaged = inject(APPROVED_FIXTURE, 'promise', NOVEL_EN);
    const d = compare(FIXTURE_ID, sabotaged, APPROVED_FIXTURE);
    expect(d.unknown.length, `expected exactly one unapproved string, got ${JSON.stringify(d.unknown)}`).toBe(1);
    expect(d.unknown[0]).toMatch(/wire the whole sum home/);
    expect([d.rotted, d.miscounted, d.newSurfaces, d.missingSurfaces]).toEqual([[], [], [], []]);
  });

  it('EDITING a shipped sentence without updating the manifest is RED, and the stale entry is named', () => {
    const edited = APPROVED_FIXTURE.replace('99 €/Monat', '99 €/Monat, jederzeit kündbar');
    const d = compare(FIXTURE_ID, edited, APPROVED_FIXTURE);
    expect(d.unknown.length, 'the reworded sentence is not reported as unapproved').toBe(1);
    expect(d.unknown[0]).toMatch(/jederzeit kündbar/);
    // A change is BOTH halves: the approved sentence is now missing. That is what stops a
    // stale entry rotting silently when copy moves or disappears.
    expect(d.rotted.length, 'the replaced sentence is not reported as a stale manifest entry').toBe(1);
    expect(d.rotted[0]).toMatch(/inkl\. 100\.000 Credits/);

    // DELETING approved copy is red on its own.
    const parsed = JSON.parse(APPROVED_FIXTURE) as { curtain: Record<string, string> };
    delete parsed.curtain.hint;
    const dd = compare(FIXTURE_ID, JSON.stringify(parsed, null, 2), APPROVED_FIXTURE);
    expect(dd.unknown).toEqual([]);
    expect(dd.rotted.length, 'a deleted approved sentence left the gate green').toBe(1);

    // DUPLICATING it under a second key moves the occurrence count.
    const duplicated = inject(
      APPROVED_FIXTURE,
      'priceAgain',
      'Standard: 99 €/Monat — inkl. 100.000 Credits und allen Seats (Team, Projekte, Kunden) ohne Aufpreis.'
    );
    const dup = compare(FIXTURE_ID, duplicated, APPROVED_FIXTURE);
    expect(dup.miscounted.length, 'a duplicated approved sentence did not move the occurrence count').toBe(1);
  });

  it('a surface that APPEARS or DISAPPEARS is RED on its own', () => {
    const appeared = diffContract(
      { surfaces: ['de-DE/a.json', 'de-DE/b.json'], copy: new Map() },
      { surfaces: ['de-DE/a.json'], copy: new Map() }
    );
    expect(appeared.newSurfaces).toEqual(['de-DE/b.json']);
    const vanished = diffContract(
      { surfaces: ['de-DE/a.json'], copy: new Map() },
      { surfaces: ['de-DE/a.json', 'de-DE/b.json'], copy: new Map() }
    );
    expect(vanished.missingSurfaces, 'a manifest entry for a deleted surface may not rot silently').toEqual([
      'de-DE/b.json',
    ]);
  });

  it('approving BOTH the surface and the manifest passes — and the approval is VISIBLE as a diff', () => {
    const edited = APPROVED_FIXTURE.replace(
      'ohne Aufpreis.',
      'ohne Aufpreis. Monatlich kündbar, keine Mindestlaufzeit.'
    );
    const d = compare(FIXTURE_ID, edited, edited);
    expect(
      [d.unknown, d.rotted, d.miscounted, d.newSurfaces, d.missingSurfaces],
      'editing the surface AND the manifest together must pass, or copy could never change'
    ).toEqual([[], [], [], [], []]);

    // THE REVIEW-FORCING PROPERTY, ASSERTED RATHER THAN ASSUMED: approving the change moves
    // the manifest, verbatim, so the approval cannot be silent.
    const before = serialiseManifest(contractOf(FIXTURE_ID, APPROVED_FIXTURE)).split('\n');
    const after = serialiseManifest(contractOf(FIXTURE_ID, edited)).split('\n');
    const gone = before.filter((l: string) => l.startsWith('copy\t') && !after.includes(l));
    const arrived = after.filter((l: string) => l.startsWith('copy\t') && !before.includes(l));
    expect(gone.length, 'the replaced sentence does not leave a visible manifest line').toBe(1);
    expect(arrived.length, 'the new sentence does not arrive as a visible manifest line').toBe(1);
    expect(arrived[0]).toMatch(/Monatlich kündbar, keine Mindestlaufzeit\.$/);
  });

  it('NEGATIVE CONTROLS: the honest, factual copy is carried — no rule eats it, nothing is dropped', () => {
    // The sentences a gate must never eat: the factual 99 EUR / 100.000-credit terms, the
    // multiseat-included wording, the local on-device lane, and the factual trial
    // boundaries. Both languages, and the real shipped strings, placeholders and all.
    for (const control of [
      'Standard: 99 €/Monat — inkl. 100.000 Credits und allen Seats (Team, Projekte, Kunden) ohne Aufpreis.',
      'Standard: 99 €/month — incl. 100,000 credits and every seat (team, projects, clients) at no extra charge.',
      'Standard ist aktiv — {{eur}} €/Monat, inkl. {{credits}} Credits, alle Seats inklusive',
      'Ein Plan: Standard — {{eur}} €/Monat, inkl. {{credits}} Credits. Jeder weitere Seat (Team, Projekt, Kunde) ist ohne Aufpreis enthalten.',
      'Lokale Modelle sind nicht betroffen — dort verlassen Daten deinen Mac nie. Gilt nur für diesen Seat.',
      'Local models are not affected — there data never leaves your Mac. Applies to this seat only.',
      'Hier siehst du, ob EVEs lokale KI auf diesem Mac bereit ist. EVE verwaltet sie automatisch und nutzt die Cloud, wenn lokal etwas fehlt.',
      'Testphase — {{days}} Tage mit {{credits}} Credits. Sie endet mit deiner Entscheidung; es wird nichts automatisch abgebucht.',
      'Trial — {{days}} days with {{credits}} credits. It ends with your decision; nothing is charged automatically.',
      'Deine Testphase ist beendet — abgebucht wurde nichts.',
      '14 Tage · genau 100.000 Credits · Standard-Cloud-Inferenz · ein Nutzer.',
      '14 days · exactly 100,000 credits · Standard cloud inference · one user.',
    ]) {
      expect(vocabularyHits(control), `a vocabulary rule cried wolf on a negative control: ${control}`).toEqual([]);
      // Each control is real copy, so the manifest must be able to HOLD it: a control the
      // extractor silently dropped would be invisible to the contract, which is worse than a
      // false positive because it is silent.
      const held = extractCopy(FIXTURE_ID, JSON.stringify({ k: control }));
      expect(held.get(control), `the extractor does not carry this control: ${control}`).toBe(1);
      // …and injecting it AND regenerating the manifest is GREEN, which is the whole
      // deliberate half: honest copy ships, it just ships REVIEWED.
      const withControl = inject(APPROVED_FIXTURE, 'control', control);
      const d = compare(FIXTURE_ID, withControl, withControl);
      expect(
        [d.unknown, d.rotted, d.miscounted, d.newSurfaces, d.missingSurfaces],
        `an approved negative control did not go green: ${control}`
      ).toEqual([[], [], [], [], []]);
    }
  });

  it('there is NO length floor: a two-word promise is inside the contract', () => {
    // The sibling web manifest could not see fragments under 12 characters, because it had
    // to dig copy out of source next to Tailwind strings. This surface is a pure translation
    // dictionary, so that hole does not exist here — and this pins that it stays closed.
    const tiny = 'Erfolg garantiert';
    const sabotaged = inject(APPROVED_FIXTURE, 'tiny', tiny);
    const d = compare(FIXTURE_ID, sabotaged, APPROVED_FIXTURE);
    expect(d.unknown.length, 'a short promise slipped past the extractor').toBe(1);
    expect(d.unknown[0]).toMatch(/Erfolg garantiert/);
    expect(extractCopy(FIXTURE_ID, JSON.stringify({ a: 'Ja', b: 'Nein' })).size, 'even 2-char values are held').toBe(2);
  });
});
