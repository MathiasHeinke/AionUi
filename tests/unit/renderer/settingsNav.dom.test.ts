/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression guard for the settings/profile WHITE-SCREEN crash.
 *
 * The settings nav was built from BUILTIN_TAB_IDS via a separate `builtinMap`;
 * when `billing` + `account` were added to BUILTIN_TAB_IDS but not the map, the
 * mapper produced `undefined` holes that later threw `result[i].id` → the whole
 * app white-screened. These tests force the map to stay complete (length match)
 * AND prove the hardened filter drops unknown ids instead of crashing.
 */

import { describe, expect, it } from 'vitest';
import { getBuiltinSettingsNavItems } from '@/renderer/pages/settings/components/SettingsPageWrapper';
import { BUILTIN_TAB_IDS } from '@/renderer/pages/settings/components/SettingsSider';

const t = (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key;

describe('getBuiltinSettingsNavItems', () => {
  it('returns one well-formed entry per BUILTIN_TAB_ID — no undefined holes', () => {
    const items = getBuiltinSettingsNavItems(true, t);
    // length match means EVERY id resolved (the filter would shorten it otherwise)
    expect(items.length).toBe(BUILTIN_TAB_IDS.length);
    expect(items.every((it) => it && typeof it.id === 'string' && it.id.length > 0)).toBe(true);
  });

  it('includes billing + account (the keys whose absence white-screened the app)', () => {
    const ids = getBuiltinSettingsNavItems(true, t).map((it) => it.id);
    expect(ids).toContain('billing');
    expect(ids).toContain('account');
  });

  it('covers every BUILTIN_TAB_ID exactly', () => {
    const ids = new Set(getBuiltinSettingsNavItems(true, t).map((it) => it.id));
    for (const id of BUILTIN_TAB_IDS) expect(ids.has(id)).toBe(true);
  });
});
