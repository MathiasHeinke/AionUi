/**
 * A MARGIN FIGURE IN THE CLIENT IS OUTSIDE EVERY GATE THAT FORBIDS ONE.
 *
 * Company.OS ships `supabase/functions/_shared/margin-claim-honesty.test.mjs`, which
 * rejects a pinned margin/markup percentage anywhere in the SERVER money tree. Its
 * scan root is `supabase/functions/**`. It therefore could never see this repository,
 * and this repository had no equivalent — so `common/config/creditsCore.ts` carried
 * `export const CREDIT_PACK_MARKUP = 0.4`, a margin RATE pinned in the desktop, while
 * the estate's only anti-margin rule was green. A rule that cannot reach the file is
 * not protection; it is a rule about somewhere else.
 *
 * This is the desktop half. The three PERCENTAGE shapes are ported from the server
 * gate deliberately unchanged, so the two trees are judged by one rule and a future
 * edit cannot make one tree quietly laxer than the other. A FOURTH shape is added that
 * the server gate had no reason to need, because the desktop's instance was not a
 * percentage at all:
 *
 *   a constant NAMED as a margin/markup and bound to a RATE (a fraction below 1).
 *
 * WHAT IS DELIBERATELY NOT A MARGIN CLAIM, and must keep passing:
 *   * a markup FACTOR (`VIDEO_MARKUP_FACTOR = 2`) — a multiplier the code applies, and
 *     the Standard-tier 10x ladder is the same shape. That IS the code;
 *   * layout and budget margins (`PANEL_MARGIN = 12`,
 *     `..._COMPRESSION_MARGIN_TOKENS = 4_096`) — the word "margin" carrying no money;
 *   * reserve deltas, discount/bonus/clamp percentages — inputs the code reads, not
 *     outcomes it claims.
 * A gate that cried wolf on those would be loosened by whoever hit it next.
 *
 * COMMENTS ARE IN SCOPE ON PURPOSE, and a tombstone that QUOTES the removed figure is
 * NOT exempt — same rule as the server gate, same reason: a reader lifting "90 %
 * margin" out of the money core into a deck cannot tell a tombstone from a claim.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const THIS_FILE = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(THIS_FILE), '../../..');

/** The trees that carry money decisions on the desktop. */
const MONEY_TREES = ['packages/desktop/src/common/config', 'packages/desktop/src/process/commandEve'];

/** The money tree, DISCOVERED — never a hand-listed set of files. */
function discoverMoneySources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(full);
    }
  };
  for (const sub of MONEY_TREES) {
    const dir = path.join(repoRoot, sub);
    try {
      if (statSync(dir).isDirectory()) walk(dir);
    } catch {
      /* a tree missing from this checkout is not a failure */
    }
  }
  return found.toSorted();
}

const SOURCES = discoverMoneySources();

type Rule = { id: string; rx: RegExp };

/**
 * A percentage ASSERTED AS A MARGIN / MARKUP OUTCOME. Each is a SHAPE, never a list of
 * numbers. Ported verbatim from the Company.OS server gate.
 */
const MARGIN_CLAIM: Rule[] = [
  {
    id: 'a percentage labelled as the margin/markup',
    rx: /\b\d{1,3}(?:[.,]\d+)?\s*%\s*(?:gross\s+|brutto-?|netto-?)?(?:margins?|marge|markup|aufschlag|rohertrag|deckungsbeitrag)\b/i,
  },
  {
    id: 'a margin/markup labelled with a percentage',
    rx: /(?:margins?|marge|markup|aufschlag|rohertrag|deckungsbeitrag)\b[^.\n]{0,14}?\b\d{1,3}(?:[.,]\d+)?\s*%/i,
  },
  {
    id: 'a multiplier converted straight into a percentage',
    rx: /\b\d{1,3}(?:[.,]\d+)?\s*[x×]\s*(?:->|=>|→|=|:)\s*(?:~|ca\.?\s*|about\s*)?\d{1,3}(?:[.,]\d+)?\s*%/i,
  },
  {
    // THE SHAPE THE DESKTOP ACTUALLY SHIPPED, and the one no percentage rule could see.
    // A constant whose NAME claims a margin/markup and whose VALUE is a RATE — a bare
    // fraction below 1, i.e. "+40 %" written as 0.4. A FACTOR (>= 1) is excluded by the
    // leading `0\.`: `VIDEO_MARKUP_FACTOR = 2` and a 10x tier factor are the code.
    id: 'a margin/markup constant pinned as a RATE rather than a factor',
    rx: /\b(?:export\s+)?const\s+[A-Za-z_0-9]*(?:MARKUP|MARGIN|MARGE|AUFSCHLAG|ROHERTRAG)[A-Za-z_0-9]*\s*(?::\s*number\s*)?=\s*-?0[.,]\d/i,
  },
];

describe('margin-claim honesty (desktop money tree)', () => {
  it('the money tree is really being scanned (the walk cannot silently empty out)', () => {
    expect(
      SOURCES.length,
      `only ${SOURCES.length} money sources discovered — the walk is broken`
    ).toBeGreaterThanOrEqual(120);
    // The files the rule was written for must be inside the scan, BY PATH.
    for (const required of [
      'packages/desktop/src/common/config/creditsCore.ts',
      'packages/desktop/src/common/config/eveInferenceCore.ts',
      'packages/desktop/src/common/config/videoCostCore.ts',
    ]) {
      expect(
        SOURCES.some((f) => path.relative(repoRoot, f).split(path.sep).join('/') === required),
        `${required} is no longer in the scanned money tree`
      ).toBe(true);
    }
  });

  it('NO source in the desktop money tree pins a margin percentage or a margin rate', () => {
    const violations: string[] = [];
    for (const file of SOURCES) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const { id, rx } of MARGIN_CLAIM) {
            const hit = line.match(rx);
            if (hit) violations.push(`${rel}:${i + 1}  ${id} -> "${hit[0].trim()}"`);
          }
        });
    }
    expect(
      violations,
      'a margin/markup rate or percentage is pinned in the desktop money tree. The client ' +
        'charges nothing and re-derives no money — the server is authoritative on every ' +
        'debit — so it cannot know a margin to state. State the factor, not the rate.\n' +
        violations.join('\n')
    ).toEqual([]);
  });

  it('the retired CREDIT_PACK_MARKUP symbol does not come back', () => {
    // A named tombstone, the way the server gate keeps the retired seat-ladder symbols
    // out. `marginClaimHonesty` (this file) is the only place the name may appear.
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // The deletion note in creditsCore.ts names the symbol in prose on purpose;
          // what must not exist is a DECLARATION of it.
          if (/\b(?:export\s+)?const\s+CREDIT_PACK_MARKUP\b/.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(offenders, 'CREDIT_PACK_MARKUP is declared again — it pinned a margin rate in the client').toEqual([]);
  });

  it('SELF-TEST: each rule fires on a claim it has never been shown', () => {
    const MUST_FIRE = [
      'der Aufschlag liegt bei 63 % auf den Einkauf',
      'we retain a markup of 300% on that rung',
      'Rohertrag: 41,5 % nach Abzug der Upstream-Kosten',
      'ninety looks better than a 55% gross margin on paper',
      'die Marge beträgt 88 %',
      '7x -> 86%',
      '1.5x = 33,3 %',
      '4× → 75%',
      // The desktop's own instance, and three ways of retyping it.
      'export const CREDIT_PACK_MARKUP = 0.4;',
      'const PACK_MARGIN = 0,37;',
      'export const TOPUP_MARKUP: number = 0.55;',
      'const blendedMarginRate = 0.62;',
    ];
    for (const probe of MUST_FIRE) {
      const fired = MARGIN_CLAIM.filter(({ rx }) => rx.test(probe)).map((r) => r.id);
      expect(fired.length, `no rule fires on a margin claim: "${probe}"`).toBeGreaterThan(0);
    }
    // …and each rule is individually alive, so a dead one cannot hide behind a sibling.
    const COVERS: Record<string, string> = {
      'a percentage labelled as the margin/markup': 'Rohertrag knapp 41,5 % Marge',
      'a margin/markup labelled with a percentage': 'die Marge beträgt 88 %',
      'a multiplier converted straight into a percentage': '7x -> 86%',
      'a margin/markup constant pinned as a RATE rather than a factor': 'export const CREDIT_PACK_MARKUP = 0.4;',
    };
    for (const { id, rx } of MARGIN_CLAIM) {
      expect(rx.test(COVERS[id]), `the rule "${id}" no longer fires on its own probe`).toBe(true);
    }
  });

  it('SELF-TEST: the rule does NOT fire on the honest numbers this tree really carries', () => {
    const MUST_NOT_FIRE = [
      // FACTORS are the code — the Standard 10x ladder and the video multiplier.
      'export const VIDEO_MARKUP_FACTOR = 2;',
      'export const DEFAULT_MARKUP_FACTOR = 2;',
      '//   standard (Flash) 10x   high (Pro) 4x   xhigh 2x   max 2x',
      'billed at raw upstream cost × this factor',
      // The word "margin" carrying no money at all.
      'export const COMMAND_EVE_CONTEXT_COMPRESSION_MARGIN_TOKENS = 4_096;',
      'const PANEL_MARGIN = 12;',
      'const VIEWPORT_MARGIN_PX = 16;',
      // Reserve deltas and clamp/bonus inputs.
      'over-reserved it by ~81%, which only tightens the pre-call wall',
      'a <0.05% under-reserve inherited from the original table',
      '// Clamped to [0, 9000] (never >90% — a near-free first period invites abuse).',
      'export const MAX_BONUS_FRACTION = 0.15;',
      'export const CREDIT_UNIT_EUR = 0.001;',
      // The deletion note itself must survive: if the rule ever swallowed its own fix,
      // this line reds instead of the fix being quietly reverted.
      '// `CREDIT_PACK_MARKUP` IS GONE (founder ruling 1.820.2). It pinned a MARGIN RATE —',
      '// a fraction, in the CLIENT — under a comment that already admitted it was superseded',
    ];
    for (const honest of MUST_NOT_FIRE) {
      const fired = MARGIN_CLAIM.filter(({ rx }) => rx.test(honest)).map((r) => r.id);
      expect(fired, `false positive on an honest line: ${honest} -> ${fired}`).toEqual([]);
    }
  });
});
