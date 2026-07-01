/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S10 — honest Company.OS root resolution. Pins the decision the startup setter
 * makes so the command-center / status-surface cores get a root ONLY when a real
 * checkout exists, and stay fail-closed (env unset) on an end-user machine.
 */

import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildCompanyOsRootCandidates,
  COMPANY_OS_ROOT_ENV_KEYS,
  COMPANY_OS_ROOT_MARKER,
  resolveCompanyOsRoot,
} from '@process/commandEve/companyOsRootResolveCore';

describe('resolveCompanyOsRoot (honest root resolution)', () => {
  it('RESPECTS an already-set COMMAND_EVE_COMPANY_OS_ROOT (E2E / explicit) — never overrides', () => {
    const res = resolveCompanyOsRoot({
      env: { COMMAND_EVE_COMPANY_OS_ROOT: '/explicit/company-os' },
      candidates: ['/somewhere/else'],
      markerExists: () => true, // even if a candidate would validate, the explicit value wins
    });
    expect(res).toEqual({
      action: 'respect-existing',
      root: '/explicit/company-os',
      envKey: 'COMMAND_EVE_COMPANY_OS_ROOT',
    });
  });

  it('respects the alias env keys in precedence order', () => {
    const res = resolveCompanyOsRoot({
      env: { COMPANY_OS_ROOT: '/alias/root' },
      candidates: [],
      markerExists: () => false,
    });
    expect(res).toEqual({ action: 'respect-existing', root: '/alias/root', envKey: 'COMPANY_OS_ROOT' });
  });

  it('DETECTS the first candidate that actually contains the read-model CLI marker', () => {
    const good = '/Users/dev/Company.OS';
    const res = resolveCompanyOsRoot({
      env: {},
      candidates: ['/no/marker/here', good, '/also/valid'],
      markerExists: (root) => root === good, // only the real checkout has the marker
    });
    expect(res).toEqual({ action: 'detected', root: good });
  });

  it('leaves the env UNSET when NO candidate contains the marker (end-user machine)', () => {
    const res = resolveCompanyOsRoot({
      env: {},
      candidates: ['/Applications/CommandEVE.app', '/Users/enduser'],
      markerExists: () => false, // no Company.OS checkout anywhere
    });
    expect(res.action).toBe('unset');
    if (res.action === 'unset') {
      // reports what it checked (for the honest log), and picked nothing.
      expect(res.checked).toContain('/Applications/CommandEVE.app');
    }
  });

  it('an empty env + empty candidates → unset (never invents a path)', () => {
    const res = resolveCompanyOsRoot({ env: {}, candidates: [], markerExists: () => true });
    expect(res).toEqual({ action: 'unset', checked: [] });
  });

  it('ignores empty/whitespace env values (blank is not "set")', () => {
    const res = resolveCompanyOsRoot({
      env: { COMMAND_EVE_COMPANY_OS_ROOT: '   ' },
      candidates: ['/valid'],
      markerExists: () => true,
    });
    expect(res).toEqual({ action: 'detected', root: '/valid' });
  });

  it('de-dupes repeated candidates before probing', () => {
    let probes = 0;
    const res = resolveCompanyOsRoot({
      env: {},
      candidates: ['/a', '/a', '/a'],
      markerExists: () => {
        probes += 1;
        return false;
      },
    });
    expect(res.action).toBe('unset');
    expect(probes).toBe(1); // '/a' probed once, not three times
  });
});

describe('buildCompanyOsRootCandidates', () => {
  it('walks up from appPath and cwd and offers a Company.OS sibling at each level', () => {
    const candidates = buildCompanyOsRootCandidates(
      '/Users/dev/Developer/eve-app',
      '/Users/dev/Developer/eve-app/packages/desktop',
      '/Users/dev'
    );
    // The founder layout: a Company.OS sibling of the app checkout under ~/Developer.
    expect(candidates).toContain(path.join('/Users/dev/Developer', 'Company.OS'));
    // The conventional home-dir dev root is included (marker-validated later).
    expect(candidates).toContain(path.join('/Users/dev', 'Developer', 'Company.OS'));
    // It includes the walked-up levels themselves too (a checkout could BE the root).
    expect(candidates).toContain('/Users/dev/Developer/eve-app');
  });

  it('produces a non-empty, de-duplicated list even when appPath === cwd', () => {
    const candidates = buildCompanyOsRootCandidates('/x/y', '/x/y', '/home/u');
    expect(candidates.length).toBeGreaterThan(0);
    expect(new Set(candidates).size).toBe(candidates.length); // no dupes
  });

  it('the marker constant is the read-model CLI path the cores require', () => {
    expect(COMPANY_OS_ROOT_MARKER).toBe(
      path.join('scripts', 'command-center', 'command-center-read-model.mjs')
    );
  });

  it('the env-key precedence list is the one the cores read', () => {
    expect(COMPANY_OS_ROOT_ENV_KEYS).toEqual([
      'COMMAND_EVE_COMPANY_OS_ROOT',
      'COMPANY_OS_ROOT',
      'COMMAND_EVE_SOURCE_ROOT',
    ]);
  });
});
