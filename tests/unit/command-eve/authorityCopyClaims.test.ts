/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The authority panel's money copy, checked as a CLAIM rather than as a string.
 *
 * A settings page that overstates what it enforces is worse than one that says
 * nothing: the user acts on it. Money is the sharp case, because exactly one
 * part of it is enforced (generic money operations never inherit an unattended
 * boolean) and the rest is not — the amount is not yet counted in a daily
 * ledger.
 *
 * HOW THIS SUITE IS BUILT, AND WHY IT CHANGED. The first cut guarded the copy
 * with a denylist of forbidden phrases. That is the wrong shape for this job: a
 * denylist can only catch the wordings someone already thought of, and every
 * paraphrase walks straight through it — "wird nicht überschritten",
 * "daily cap enforced", "we keep you under" would all have passed a suite that
 * looked green. A denylist cannot enumerate the ways a sentence can lie.
 *
 * So the safeguard is now an ALLOWLIST: all three money-claim strings are
 * pinned verbatim, in both languages. Any edit to any of them turns this suite
 * red and forces the new wording to be read. The denylist survives underneath
 * as a cheap second net for copy this file does not pin, but it is explicitly
 * no longer the thing being relied on.
 *
 * The verbatim pins are deliberately paired with a separate CONTENT test. The
 * pin catches accidental drift; the content test says what a DELIBERATE
 * rewording must still carry, so re-pinning a new sentence cannot quietly drop
 * one of the three claims.
 *
 * It reads the shipped locale files directly. A test against component output
 * would pass while the German string said whatever it liked, because the DOM
 * suites render i18n KEYS, not translations.
 */

import { describe, expect, it } from 'vitest';
import deCommandEve from '@/renderer/services/i18n/locales/de-DE/commandEve.json';
import enCommandEve from '@/renderer/services/i18n/locales/en-US/commandEve.json';

/**
 * THE SAFEGUARD. Every money claim the panel makes, verbatim, per locale.
 *
 * Each of these was written against measured behaviour:
 *   - `budgetMissing`   — what an amount-less money seal actually blocks. It
 *     may state the SEAL outcome only; the seal matcher is self-declared not a
 *     security boundary (eveAuthorityRuntimeCore:117-121) and the agent video
 *     lane spends without consulting the authority layer at all, so no string
 *     here may claim that EVE spends nothing overall.
 *   - `budgetNotEnforced` — the enforced half and the unenforced half, named
 *     separately.
 *   - `limitMoney`      — the same fact restated in the "what this page does
 *     not decide" list.
 */
const PINNED_CLAIMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'de-DE': {
    budgetMissing:
      'Ohne Betrag bleibt das Geld-Siegel zu. Geld-Befehle, die EVE als solche erkennt, kommen dann nicht durch.',
    budgetNotEnforced:
      'Der Betrag wird gespeichert, aber in dieser Version noch nicht als Tageszähler durchgesetzt. Erkannte Geldbefehle fragt EVE deshalb weiterhin einzeln ab. Wenn du autonome Browser-/Desktop-Steuerung aktivierst, begrenzt dieser Betrag deren Klicks technisch nicht. Das eingetragene Limit ist kein Blankoscheck.',
    limitMoney:
      'Tagesbetrag: Der Betrag wird gespeichert, aber noch nicht gegen einen Tagesverbrauch gebucht. Erkannte Geldbefehle bleiben einzeln freigabepflichtig. Eine aktivierte Browser-/Desktop-Autonomie kann Bezahlvorgänge über die Oberfläche ausführen, ohne dass dieser Betrag sie technisch begrenzt.',
    opaqueUiWarning:
      'Breite Freigabe: Ein Klick kann indirekt bezahlen, veröffentlichen, löschen, Zugangsdaten offenlegen oder Produktion verändern. Die fünf Wirkungssiegel und der gespeicherte Tagesbetrag begrenzen solche Browser-/Desktop-Schritte technisch noch nicht.',
  },
  'en-US': {
    budgetMissing:
      'Without an amount the money seal stays shut. Money commands EVE recognises as such do not get through.',
    budgetNotEnforced:
      'The amount is saved, but this version does not yet enforce it as a daily ledger. EVE therefore still asks separately for recognised money commands. If you enable autonomous Browser/Desktop control, this amount does not technically constrain its clicks. The configured limit is not a blank cheque.',
    limitMoney:
      'Daily amount: the amount is saved, but is not yet booked against daily usage. Recognised money commands still require a separate approval. Enabled Browser/Desktop autonomy may complete payments through the UI without this amount technically constraining them.',
    opaqueUiWarning:
      'Broad permission: a click may indirectly pay, publish, delete, reveal credentials or change production. The five effect seals and recorded daily amount do not yet technically constrain such Browser/Desktop steps.',
  },
};

/**
 * What a rewrite must still SAY, independent of how it is phrased.
 *
 * This replaces a `length > 80` check, which measured nothing: a string can be
 * four hundred characters long and still promise an enforced ceiling. Each
 * entry below is one of the three claims, named, so a failure points at the
 * claim that went missing rather than at a character count.
 */
const REQUIRED_CLAIMS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  'de-DE': [
    ['the amount is stored', 'Betrag wird gespeichert'],
    ['the daily ledger is not enforced', 'noch nicht als Tageszähler durchgesetzt'],
    ['money operations still ask', 'weiterhin einzeln ab'],
    ['the amount is not blanket authority', 'kein Blankoscheck'],
  ],
  'en-US': [
    ['the amount is stored', 'amount is saved'],
    ['the daily ledger is not enforced', 'does not yet enforce it as a daily ledger'],
    ['money operations still ask', 'still asks separately'],
    ['the amount is not blanket authority', 'not a blank cheque'],
  ],
};

/**
 * A SECOND NET, no longer the safeguard.
 *
 * Kept because it costs nothing and covers authority copy this file does not
 * pin verbatim. It must never again be mistaken for the guarantee: everything
 * it catches, the pins above catch too, and it misses every paraphrase.
 */
const FORBIDDEN = [
  'Vorgabe an EVE',
  'Limit gilt',
  'höchstens',
  'Höchstens',
  'Budget wird eingehalten',
  'pro Tag gedeckelt',
  'wird nicht überschritten',
  'at most',
  'At most',
  'limit applies',
  'budget is respected',
  'capped per day',
  'daily cap enforced',
];

const LOCALES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['de-DE', deCommandEve as unknown as Record<string, unknown>],
  ['en-US', enCommandEve as unknown as Record<string, unknown>],
];

function authority(bundle: Record<string, unknown>): Record<string, string> {
  return (bundle as { authority: Record<string, string> }).authority;
}

describe('authority copy claims only what the code enforces', () => {
  for (const [name, bundle] of LOCALES) {
    describe(name, () => {
      it('every money claim is the agreed wording, verbatim', () => {
        // The allowlist. Changing any of these three sentences in either
        // language must be a deliberate act that someone reads.
        for (const [key, expected] of Object.entries(PINNED_CLAIMS[name]!)) {
          expect(authority(bundle)[key], `${name}.${key}`).toBe(expected);
        }
      });

      it('the money caveat still carries all three claims', () => {
        const note = authority(bundle).budgetNotEnforced;
        expect(typeof note).toBe('string');
        for (const [claim, phrase] of REQUIRED_CLAIMS[name]!) {
          expect(note, `${name}: missing claim — ${claim}`).toContain(phrase);
        }
      });

      it('says that opaque UI auto-run can cross every effect boundary', () => {
        const warning = authority(bundle).opaqueUiWarning;
        expect(typeof warning).toBe('string');
        const required =
          name === 'de-DE'
            ? ['bezahlen', 'veröffentlichen', 'löschen', 'Zugangsdaten', 'Produktion', 'technisch noch nicht']
            : ['pay', 'publish', 'delete', 'credentials', 'production', 'do not yet technically'];
        for (const phrase of required) {
          expect(warning, name + ': missing opaque effect ' + phrase).toContain(phrase);
        }
      });

      it('asserts no enforced spending ceiling anywhere else either', () => {
        const copy = JSON.stringify(authority(bundle));
        for (const phrase of FORBIDDEN) {
          expect(copy, `${name} contains "${phrase}"`).not.toContain(phrase);
        }
      });

      it('describes the same six things this page does not decide', () => {
        for (const key of [
          'limitScreen',
          'limitScanner',
          'limitMemory',
          'limitWebsites',
          'limitTimeout',
          'limitMoney',
        ]) {
          expect(typeof authority(bundle)[key], `${name}.${key}`).toBe('string');
        }
      });
    });
  }

  it('both locales pin the same set of money claims', () => {
    // A pin that exists in one language and not the other is a hole with a
    // green tick on it.
    expect(Object.keys(PINNED_CLAIMS['de-DE']!).toSorted()).toStrictEqual(
      Object.keys(PINNED_CLAIMS['en-US']!).toSorted()
    );
  });
});
