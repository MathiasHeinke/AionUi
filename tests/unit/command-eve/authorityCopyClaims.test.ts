/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The authority panel's copy, checked as a CLAIM rather than as a string.
 *
 * A settings page that overstates what it enforces is worse than one that says
 * nothing: the user acts on it. The money field is the sharp case — half of it
 * is genuinely enforced (no amount, no open seal) and half of it is not (the
 * amount is never counted, and never even reaches EVE). Copy that blurs the two
 * is what this suite is here to prevent.
 *
 * It reads the shipped locale files directly, deliberately. A test against
 * component output would pass while the German string said whatever it liked,
 * because the DOM suite renders i18n KEYS.
 */

import { describe, expect, it } from 'vitest';
import deCommandEve from '@/renderer/services/i18n/locales/de-DE/commandEve.json';
import enCommandEve from '@/renderer/services/i18n/locales/en-US/commandEve.json';

/**
 * Formulations that assert an enforced ceiling or a value handed to EVE.
 *
 * Every one of these is currently false: `spentTodayCents` has no store behind
 * it (eveAuthorityCore:126 declares it, :206 reads it, nothing writes it), and
 * the approval endpoint answers with `{decision, edit_policy, ladder}` only
 * (ollamaOpenAiShim:2667-2671), so the number never crosses to EVE at all.
 */
const FORBIDDEN = [
  'Vorgabe an EVE',
  'Limit gilt',
  'höchstens',
  'Höchstens',
  'Budget wird eingehalten',
  'pro Tag gedeckelt',
  'at most',
  'At most',
  'limit applies',
  'budget is respected',
  'capped per day',
];

const LOCALES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['de-DE', deCommandEve as unknown as Record<string, unknown>],
  ['en-US', enCommandEve as unknown as Record<string, unknown>],
];

function authorityCopy(bundle: Record<string, unknown>): string {
  return JSON.stringify((bundle as { authority: unknown }).authority);
}

describe('authority copy claims only what the code enforces', () => {
  for (const [name, bundle] of LOCALES) {
    it(`${name} asserts no enforced spending ceiling anywhere`, () => {
      const copy = authorityCopy(bundle);
      for (const phrase of FORBIDDEN) {
        expect(copy).not.toContain(phrase);
      }
    });

    it(`${name} carries the money caveat, and it says all three things`, () => {
      const note = (bundle as { authority: { budgetNotEnforced?: string } }).authority.budgetNotEnforced;
      expect(typeof note).toBe('string');
      expect(note!.length).toBeGreaterThan(80);
    });
  }

  it('the German caveat is the agreed wording, verbatim', () => {
    // Pinned in full. This sentence was negotiated against measured behaviour;
    // a paraphrase is exactly how the enforced half and the unenforced half get
    // blurred back together.
    expect((deCommandEve as unknown as { authority: { budgetNotEnforced: string } }).authority.budgetNotEnforced).toBe(
      'Ohne Betrag bleibt das Geld-Siegel geschlossen — das wird technisch erzwungen. ' +
        'Der Betrag selbst wird in dieser Version noch nicht gegen tatsächliche Ausgaben gezählt ' +
        'und nicht an EVE übermittelt. Er ist deine festgehaltene Obergrenze; durchgesetzt wird ' +
        'sie erst mit einer kommenden Version.'
    );
  });

  it('both locales describe the same six things this page does not decide', () => {
    for (const [name, bundle] of LOCALES) {
      const authority = (bundle as { authority: Record<string, unknown> }).authority;
      for (const key of ['limitScreen', 'limitScanner', 'limitMemory', 'limitWebsites', 'limitTimeout', 'limitMoney']) {
        expect(typeof authority[key], `${name}.${key}`).toBe('string');
      }
    }
  });
});
