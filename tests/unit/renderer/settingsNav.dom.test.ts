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
import { BUILTIN_TAB_IDS, isSettingsPathActive } from '@/renderer/pages/settings/components/SettingsSider';

const t = (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key;

describe('getBuiltinSettingsNavItems', () => {
  it('returns one well-formed entry per BUILTIN_TAB_ID — no undefined holes', () => {
    const items = getBuiltinSettingsNavItems(true, t);
    // length match means EVERY id resolved (the filter would shorten it otherwise)
    expect(items.length).toBe(BUILTIN_TAB_IDS.length);
    expect(items.every((item) => item && typeof item.id === 'string' && item.id.length > 0)).toBe(true);
  });

  it('includes billing + account (the keys whose absence white-screened the app)', () => {
    const ids = getBuiltinSettingsNavItems(true, t).map((item) => item.id);
    expect(ids).toContain('billing');
    expect(ids).toContain('account');
  });

  it('includes the Company Brain tab (fix #4) with the company-brain route path', () => {
    const items = getBuiltinSettingsNavItems(true, t);
    const companyBrain = items.find((item) => item.id === 'companyBrain');
    expect(companyBrain).toBeDefined();
    expect(companyBrain?.path).toBe('company-brain');
  });

  it('covers every BUILTIN_TAB_ID exactly', () => {
    const ids = new Set(getBuiltinSettingsNavItems(true, t).map((item) => item.id));
    for (const id of BUILTIN_TAB_IDS) expect(ids.has(id)).toBe(true);
  });

  it('keeps one provider-owned icon vocabulary without local stroke, fill or theme overrides', () => {
    const items = getBuiltinSettingsNavItems(true, t);
    for (const item of items) {
      expect(item.icon).toBeTruthy();
      expect(item.icon.props).not.toHaveProperty('strokeWidth');
      expect(item.icon.props).not.toHaveProperty('fill');
      expect(item.icon.props).not.toHaveProperty('theme');
    }
  });
});

describe('isSettingsPathActive', () => {
  it('does not select Runtime when EVE-Runtime is active', () => {
    expect(isSettingsPathActive('/settings/eve-runtime', 'eve-runtime')).toBe(true);
    expect(isSettingsPathActive('/settings/eve-runtime', 'runtime')).toBe(false);
  });

  it('supports exact routes and nested extension routes without substring collisions', () => {
    expect(isSettingsPathActive('/settings/runtime', 'runtime')).toBe(true);
    expect(isSettingsPathActive('/settings/ext/acme/details', 'ext/acme')).toBe(true);
    expect(isSettingsPathActive('/settings/ext/acme-tools', 'ext/acme')).toBe(false);
  });
});
