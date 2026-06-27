/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Proves the founder's EVE permission-mode labels actually RESOLVE through i18n
 * (Standard / Änderungen übernehmen / YOLO in DE) — not a reasoning claim. Loads the
 * real de-DE / en-US locale modules exactly as the app does (addResourceBundle into
 * the single 'translation' namespace, deep=true) and asserts the agentMode.eve.* keys
 * the createModeLabelFormatter uses resolve. Guards against the agentMode-vs-common
 * collision the adversarial reviewer flagged.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import i18next, { type i18n as I18nType } from 'i18next';
import deDE from '@/renderer/services/i18n/locales/de-DE';
import enUS from '@/renderer/services/i18n/locales/en-US';

let inst: I18nType;

describe('EVE permission-mode labels resolve through i18n', () => {
  beforeAll(async () => {
    inst = i18next.createInstance();
    await inst.init({ lng: 'de-DE', fallbackLng: 'en-US', resources: {}, interpolation: { escapeValue: false } });
    inst.addResourceBundle('de-DE', 'translation', deDE, true, true);
    inst.addResourceBundle('en-US', 'translation', enUS, true, true);
  });

  it('DE: the 3 honest EVE modes render the founder labels', () => {
    inst.changeLanguage('de-DE');
    expect(inst.t('agentMode.eve.ask')).toBe('Standard');
    expect(inst.t('agentMode.eve.acceptEdits')).toBe('Änderungen übernehmen');
    expect(inst.t('agentMode.eve.yolo')).toBe('YOLO');
    // Sanity: the existing dropdown header the founder's screenshot showed also resolves
    expect(inst.t('agentMode.switchMode')).toBe('Berechtigungsmodus');
    expect(inst.t('agentMode.permission')).toBe('Berechtigung');
  });

  it('EN: the same keys render English (no German-only hardcoding)', () => {
    inst.changeLanguage('en-US');
    expect(inst.t('agentMode.eve.ask')).toBe('Ask every time');
    expect(inst.t('agentMode.eve.acceptEdits')).toBe('Accept Edits');
    expect(inst.t('agentMode.eve.yolo')).toBe('YOLO');
  });

  it('the agentMode object is NOT clobbered by common.agentMode (the reviewer’s concern)', () => {
    inst.changeLanguage('de-DE');
    // agentMode resolves as an object namespace (eve.ask present), NOT the flat
    // common.agentMode string "Agent-Modus".
    expect(inst.t('agentMode.eve.ask')).not.toBe('Agent-Modus');
    expect(inst.t('common.agentMode')).toBe('Agent-Modus'); // the flat string lives under common
  });
});
