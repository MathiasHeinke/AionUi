/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE DEFAULTVALUE-ONLY KEY GATE — the whole class was invisible.
 *
 * WHAT SHIPPED. `SendBox` renders a send failure as
 *
 *     t('messages.sendFailedWithReason', { defaultValue: 'Senden fehlgeschlagen: {{reason}}' })
 *
 * and neither `messages.sendFailed` nor `messages.sendFailedWithReason` existed in ANY
 * locale file. i18next then falls through to the inline `defaultValue`, so the string
 * renders — in GERMAN — for a Japanese, Korean, Turkish, Russian, Ukrainian, Brazilian or
 * Chinese user, and every committed gate stayed green:
 *
 *   * `check-i18n.js` compares locales AGAINST EACH OTHER, so a key that is in none of
 *     them is missing from none of them. Its `checkLiteralKeyUsages` pass does notice
 *     unknown literal keys — as a WARNING, on a script that exits 0 with warnings.
 *   * the approved-copy manifest covers strings that ARE in a locale file, by
 *     construction; a string that never reached one is outside its boundary and it says so.
 *   * a `defaultValue` makes the call site LOOK complete, which is why this survives review.
 *
 * So the failure mode is precise: the more careful the author was — supplying a fallback so
 * nothing renders as a raw key — the more invisible the untranslated string becomes.
 *
 * THIS GATE MAKES THE CLASS VISIBLE AND STOPS IT GROWING. Every `t('<ns>.<key>', { …
 * defaultValue … })` call in the renderer is resolved against the reference locale. A key
 * that resolves is fine. A key that does not is DEBT, and the debt is ENUMERATED below.
 *
 * IT IS A RATCHET, NOT A CLEAN BILL OF HEALTH — stated plainly, because a gate whose
 * boundary is inherited rather than written down is how this repo got here:
 *   * 74 keys are outstanding TODAY, measured, listed verbatim in {@link KNOWN_DEBT}.
 *     Translating them is not in this change's scope and this gate does not pretend it was.
 *   * A key NOT on that list is RED. That is the whole point: the 71st can not be added
 *     silently.
 *   * A list entry that has been FIXED is also RED, so the debt list can only shrink. A
 *     frozen baseline nobody prunes becomes a permanent excuse.
 *
 * NAMING: `*.i18n.test.ts` matches the vitest `node` project's `tests/unit/**\/*.test.ts`
 * and is not a `.dom.` file. Pure file reads.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LOCALES_ROOT = path.join(REPO_ROOT, 'packages/desktop/src/renderer/services/i18n/locales');
const RENDERER_ROOT = path.join(REPO_ROOT, 'packages/desktop/src/renderer');
const I18N_CONFIG = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'packages/desktop/src/common/config/i18n-config.json'), 'utf8')
) as { referenceLanguage: string; fallbackLanguage: string; supportedLanguages: string[] };

/**
 * THE OUTSTANDING DEBT, MEASURED — every key rendered from an inline `defaultValue` that
 * no locale file carries. Verbatim, sorted, and allowed to SHRINK ONLY.
 *
 * Note what is NOT here: `messages.sendFailed` and `messages.sendFailedWithReason`. They
 * were on this list when it was first measured; they are the two this change translated
 * across all ten bundled locales, and the row below pins that they resolve.
 */
const KNOWN_DEBT: readonly string[] = [
  'common.next',
  'common.previous',
  'conversation.presentation.contextTooLarge',
  'conversation.runtimeStatus.laneCloud',
  'conversation.runtimeStatus.laneLocal',
  // MAT-1769: the image-model pill, same debt class as the video pill below —
  // de-DE/en-US carry the copy; the eight unsupported locales render the
  // fallback until a translation pass covers credits.* wholesale.
  'credits.image.editEstimateTitle',
  'credits.image.estimateUnavailable',
  'credits.image.inlineEstimate',
  'credits.image.modelLabel',
  'credits.onboarding.briefPlaceholder',
  'credits.onboarding.connectClient',
  'credits.onboarding.connectPlaceholder',
  'credits.onboarding.lede',
  'credits.onboarding.pasteBrief',
  'credits.onboarding.skip',
  'credits.onboarding.submit',
  'credits.onboarding.title',
  // 1.820.3: the compact video-edit affordance, same debt class as the rest
  // of credits.video.* below.
  'credits.video.editHintLabel',
  'credits.video.inlineEstimate',
  'credits.video.qualityLabel',
  'credits.video.voiceLabel',
  'eveRuntime.humanGate.autonomous',
  'eveRuntime.humanGate.autonomousMeaning',
  'eveRuntime.humanGate.ceo',
  'eveRuntime.humanGate.ceoMeaning',
  'eveRuntime.humanGate.eve',
  'eveRuntime.humanGate.eveMeaning',
  'eveRuntime.humanGate.founder',
  'eveRuntime.humanGate.founderMeaning',
  'eveRuntime.humanGate.readonlyFooter',
  'eveRuntime.humanGate.subtitle',
  'eveRuntime.humanGate.title',
  'eveRuntime.subtitle',
  'eveRuntime.tab.agents',
  'eveRuntime.tab.assistants',
  'eveRuntime.tab.orchestration',
  'eveRuntime.title',
  'eveRuntime.workerAssignment.add',
  'eveRuntime.workerAssignment.claudeAuth',
  'eveRuntime.workerAssignment.cliPathLabel',
  'eveRuntime.workerAssignment.codexDeferred',
  'eveRuntime.workerAssignment.codexDeferredHint',
  'eveRuntime.workerAssignment.codexOptionSoon',
  'eveRuntime.workerAssignment.empty',
  'eveRuntime.workerAssignment.kindLabel',
  'eveRuntime.workerAssignment.modalNote',
  'eveRuntime.workerAssignment.modalTitle',
  'eveRuntime.workerAssignment.remove',
  'eveRuntime.workerAssignment.roleLabel',
  'eveRuntime.workerAssignment.rolePlaceholder',
  'eveRuntime.workerAssignment.saveInvalid',
  'eveRuntime.workerAssignment.saved',
  'eveRuntime.workerAssignment.statusActive',
  'eveRuntime.workerAssignment.statusOff',
  'eveRuntime.workerAssignment.statusPaused',
  'eveRuntime.workerAssignment.subtitle',
  'eveRuntime.workerAssignment.testConnection',
  'eveRuntime.workerAssignment.testInvalid',
  'eveRuntime.workerAssignment.testOk',
  'eveRuntime.workerAssignment.title',
  'preview.export.failed',
  'preview.export.markdown',
  'preview.export.pdf',
  'preview.export.success',
  'preview.export.title',
  'preview.export.word',
  'settings.commandEveKanbanAutoApprove',
  'settings.commandEveKanbanAutoApproveDesc',
  'settings.commandEveKanbanAutoApproveError',
  'settings.commandEvePiiProtectionSaveFailed',
  'settings.companyBrain',
  'settings.extensionSkills',
  'settings.extensionSkillsBadge',
  'settings.providerIdConflict',
];

/** The two keys this change translated — asserted to be OFF the debt list and RESOLVABLE. */
const FIXED_HERE = ['messages.sendFailed', 'messages.sendFailedWithReason'] as const;

function flatten(node: unknown, prefix: string, out: Set<string>): void {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  if (prefix) out.add(prefix);
}

/** Every `<module>.<path>` key a locale carries. Modules DISCOVERED, never hand-listed. */
function keysOfLocale(locale: string): Set<string> {
  const out = new Set<string>();
  for (const entry of readdirSync(path.join(LOCALES_ROOT, locale), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const moduleName = entry.name.replace(/\.json$/, '');
    flatten(JSON.parse(readFileSync(path.join(LOCALES_ROOT, locale, entry.name), 'utf8')), moduleName, out);
  }
  return out;
}

function rendererFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'out'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && entry.name !== 'i18n-keys.d.ts') out.push(full);
    }
  };
  walk(RENDERER_ROOT);
  return out.toSorted();
}

const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * `t('<ns>.<key>', { … defaultValue … })` — the call shape this gate is about. The options
 * object is matched with one level of nesting allowed, which covers every call in the tree
 * (`{ defaultValue: 'x', count: n }`, `{ count, defaultValue }`, multi-line forms).
 */
const T_WITH_DEFAULT = /\bt\(\s*(['"])([^'"`]+)\1\s*,\s*\{(?:[^{}]|\{[^{}]*\})*?\bdefaultValue\b/g;

type Site = { key: string; file: string };

function defaultValueSites(): Site[] {
  const sites: Site[] = [];
  for (const file of rendererFiles()) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const m of code.matchAll(T_WITH_DEFAULT)) {
      const key = m[2].trim();
      if (!key.includes('.') || key.includes('${')) continue;
      sites.push({ key, file: path.relative(REPO_ROOT, file) });
    }
  }
  return sites;
}

const SITES = defaultValueSites();
const REFERENCE_KEYS = keysOfLocale(I18N_CONFIG.referenceLanguage);
const UNRESOLVED = [...new Set(SITES.filter((s) => !REFERENCE_KEYS.has(s.key)).map((s) => s.key))].toSorted();

describe('i18n — a key rendered from an inline defaultValue must exist in the locale files', () => {
  it('the scan is really scanning: the renderer walk and the locale read both found something', () => {
    // Every assertion below is vacuous if either side comes back empty, and an empty scan
    // is indistinguishable from a clean tree unless it is asserted.
    expect(SITES.length, 'no t(key, { defaultValue }) call sites found — the walk is broken').toBeGreaterThan(500);
    expect(REFERENCE_KEYS.size, 'the reference locale read came back empty').toBeGreaterThan(1000);
  });

  it('NO NEW defaultValue-only key: anything outside the measured debt list is RED', () => {
    const known = new Set(KNOWN_DEBT);
    const added = UNRESOLVED.filter((k) => !known.has(k));
    expect(
      added,
      'a key is rendered from an inline defaultValue and exists in NO locale file. It will ' +
        'render its German fallback verbatim in every other language. Add it to the locale ' +
        'modules (all bundled locales), or — if it is genuinely temporary — add it to ' +
        'KNOWN_DEBT with the reason, which makes it visible instead of invisible.'
    ).toEqual([]);
  });

  it('THE RATCHET: a debt entry that has been FIXED must be REMOVED from the list', () => {
    const outstanding = new Set(UNRESOLVED);
    const stale = KNOWN_DEBT.filter((k) => !outstanding.has(k));
    expect(
      stale,
      'these keys now resolve, so the debt list is claiming a gap that no longer exists. ' +
        'Delete them from KNOWN_DEBT — a baseline nobody prunes becomes a permanent excuse.'
    ).toEqual([]);
  });

  it('the two keys this change fixed resolve in EVERY bundled locale, not only the covered two', () => {
    // The leak was that a missing key falls back to the de-DE bundle, so the German string
    // renders for every other language. Asserting only the covered locales would have left
    // exactly that hole open.
    const locales = readdirSync(LOCALES_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .toSorted();
    expect(locales.length).toBeGreaterThanOrEqual(10);
    for (const locale of locales) {
      const keys = keysOfLocale(locale);
      for (const key of FIXED_HERE) {
        expect(keys.has(key), `${locale} is missing ${key} — it would render the German fallback`).toBe(true);
      }
    }
    for (const key of FIXED_HERE) expect(KNOWN_DEBT).not.toContain(key);
  });

  it('the debt list is sorted, unique, and really outstanding — a list nobody can read is not a record', () => {
    expect(KNOWN_DEBT).toEqual([...KNOWN_DEBT].toSorted());
    expect(new Set(KNOWN_DEBT).size).toBe(KNOWN_DEBT.length);
    // And it is not aspirational: every entry is a key the scan actually found.
    const seen = new Set(SITES.map((s) => s.key));
    expect(KNOWN_DEBT.filter((k) => !seen.has(k))).toEqual([]);
  });
});
