/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Proves the MAX control's user-facing strings actually RESOLVE through i18n in
 * BOTH languages.
 *
 * WHY THIS FILE EXISTS: `scripts/check-i18n.js` only WARNS on unknown literal
 * keys, so a `conversation.eveMax.*` key that was never added to the bundles
 * would sail through the push gate and silently render its English fallback (or
 * the raw key) in German. This loads the real locale modules exactly as the app
 * does — addResourceBundle into the single 'translation' namespace, deep=true —
 * and asserts each key resolves to a real sentence.
 *
 * It also pins the founder mandate on this surface: the ONLY user-visible word
 * for the strong lane is "MAX", and no translation may leak a model id.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import i18next, { type i18n as I18nType } from 'i18next';
import deDE from '@/renderer/services/i18n/locales/de-DE';
import enUS from '@/renderer/services/i18n/locales/en-US';

const MAX_KEYS = [
  'conversation.eveMax.label',
  'conversation.eveMax.availableHint',
  'conversation.eveMax.engagedHint',
  'conversation.eveMax.lockedHint',
  // The fifth state: a lapsed seat that still holds a persisted MAX intent.
  'conversation.eveMax.lockedEngagedHint',
  'conversation.eveMax.upgrade',
] as const;

let inst: I18nType;

describe('MAX lane labels resolve through i18n', () => {
  beforeAll(async () => {
    inst = i18next.createInstance();
    await inst.init({ lng: 'de-DE', fallbackLng: 'en-US', resources: {}, interpolation: { escapeValue: false } });
    inst.addResourceBundle('de-DE', 'translation', deDE, true, true);
    inst.addResourceBundle('en-US', 'translation', enUS, true, true);
  });

  it('every MAX key exists in BOTH bundles', () => {
    for (const lng of ['de-DE', 'en-US'] as const) {
      inst.changeLanguage(lng);
      for (const key of MAX_KEYS) {
        expect(inst.exists(key), `${key} missing in ${lng}`).toBe(true);
        const value = inst.t(key);
        expect(value, `${key} unresolved in ${lng}`).not.toBe(key);
        expect(value.length, `${key} empty in ${lng}`).toBeGreaterThan(0);
      }
    }
  });

  it('DE: the control names the lane MAX and states the purchase gate as an upsell', () => {
    inst.changeLanguage('de-DE');
    expect(inst.t('conversation.eveMax.label')).toBe('MAX');
    expect(inst.t('conversation.eveMax.lockedHint')).toContain('MAX');
    // The locked sentence must read as an UPSELL (what unlocks it), never as an
    // auth error — refusing a paid upgrade is a sale, not a permission failure.
    expect(inst.t('conversation.eveMax.lockedHint')).toMatch(/Tarif|Credits/);
    expect(inst.t('conversation.eveMax.engagedHint')).toContain('MAX');
  });

  it('EN: the same keys render English (no German-only hardcoding)', () => {
    inst.changeLanguage('en-US');
    expect(inst.t('conversation.eveMax.label')).toBe('MAX');
    expect(inst.t('conversation.eveMax.lockedHint')).toMatch(/paid plan|credits/i);
    expect(inst.t('conversation.eveMax.availableHint')).toMatch(/MAX/);
    // Distinct from DE — proves the EN bundle is not just falling through.
    inst.changeLanguage('de-DE');
    const de = inst.t('conversation.eveMax.lockedHint');
    inst.changeLanguage('en-US');
    expect(inst.t('conversation.eveMax.lockedHint')).not.toBe(de);
  });

  it('NO translation of the MAX surface leaks a model id or provider slug', () => {
    for (const lng of ['de-DE', 'en-US'] as const) {
      inst.changeLanguage(lng);
      for (const key of MAX_KEYS) {
        // Upstream ids in this system are `vendor/model` slugs; a '/' is the tell.
        expect(inst.t(key)).not.toContain('/');
      }
    }
  });

  it('NO translation of the MAX surface uses cloud-tier nomenclature', () => {
    // The routine lane is UNNAMED (Founder contract). The MAX copy must not
    // reintroduce a ladder by wording — not "Stufe"/"level"/"tier", and not the
    // old default label "Standard".
    const LADDER_WORDS = ['Stufe', 'Standard', 'Sehr hoch', 'Maximum', 'Ultra', 'level', 'Level', 'tier', 'Tier'];
    for (const lng of ['de-DE', 'en-US'] as const) {
      inst.changeLanguage(lng);
      for (const key of MAX_KEYS) {
        const value = inst.t(key);
        for (const word of LADDER_WORDS) {
          expect(value, `${key} (${lng}) must not say "${word}"`).not.toContain(word);
        }
      }
    }
  });

  it('the removed composer LANE row leaves NO orphaned key behind, in EITHER locale', () => {
    // Same rule as the "how EVE works" row below, applied to the mobile sheet's
    // `Verarbeitung → EVE Cloud / Lokal` entry. It was a composer lane-selection
    // affordance; the release removes it, so its vocabulary must leave the bundle
    // too. A shipped key is a standing invitation to re-mount the row.
    for (const lng of ['de-DE', 'en-US'] as const) {
      inst.changeLanguage(lng);
      for (const key of [
        'conversation.eveInference.lane',
        'conversation.eveInference.cloudLane',
        'conversation.eveInference.cloudLaneDescription',
      ] as const) {
        expect(inst.exists(key), `orphan lane key ${key} still in ${lng}`).toBe(false);
      }
    }
  });

  it('the SETTINGS local-lane keys exist and promise no cloud credits', () => {
    for (const lng of ['de-DE', 'en-US'] as const) {
      inst.changeLanguage(lng);
      expect(inst.exists('settings.commandEveLocalLane')).toBe(true);
      expect(inst.exists('settings.commandEveLocalLaneHint')).toBe(true);
      expect(inst.t('settings.commandEveLocalLaneHint')).toMatch(/Credits/i);
    }
  });

  it('the LAPSED-INTENT sentence says the intent is kept AND that it needs a plan', () => {
    // This is the fifth state's whole job: not "unavailable" (which reads as an
    // error) and not "on" (which would be a lie) — kept, and purchasable.
    inst.changeLanguage('de-DE');
    const de = inst.t('conversation.eveMax.lockedEngagedHint');
    expect(de).toContain('gemerkt');
    expect(de).toMatch(/Tarif|Credits/);
    inst.changeLanguage('en-US');
    const en = inst.t('conversation.eveMax.lockedEngagedHint');
    expect(en).toMatch(/remember/i);
    expect(en).toMatch(/paid plan|credits/i);
  });

  it('the removed intelligence row leaves NO orphaned key behind, in EITHER locale', () => {
    // The EVE menu's old first row ("Wie EVE arbeitet → Automatisch") was a
    // cloud-intelligence statement wearing a friendlier word. Deleting the row
    // without deleting its key would leave the vocabulary shipping in the
    // bundle, ready to be re-mounted by the next person who greps for it.
    for (const lng of ['de-DE', 'en-US'] as const) {
      inst.changeLanguage(lng);
      expect(inst.exists('conversation.eveControl.howEveWorks'), `orphan key still in ${lng}`).toBe(false);
    }
  });

  it('the pre-existing eveInference keys still resolve (no bundle was clobbered)', () => {
    for (const lng of ['de-DE', 'en-US'] as const) {
      inst.changeLanguage(lng);
      expect(inst.exists('conversation.eveInference.needsActivation')).toBe(true);
      expect(inst.exists('conversation.eveControl.privacy')).toBe(true);
    }
  });
});
