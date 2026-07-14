/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildErsteSchritteHubSteps, type ErsteSchritteItemState } from '@/common/config/ersteSchritteHubCore';

const EXPECTED_ORDER = [
  'ki-spur',
  'company-brain',
  'kunde',
  'connectors',
  'team',
  'skills',
  'privacy',
  'budget',
  'name',
];

describe('ersteSchritteHubCore — the Day-0 hub steps (honest status)', () => {
  it('returns all 9 steps in first-value-reachability order', () => {
    const steps = buildErsteSchritteHubSteps({ firstValueReady: true, identityState: 'ok' });
    expect(steps.map((s) => s.id)).toEqual(EXPECTED_ORDER);
  });

  it('maps every step to an existing route; only "kunde" is a web intent', () => {
    const steps = buildErsteSchritteHubSteps({ firstValueReady: true, identityState: 'ok' });
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(byId['ki-spur'].route).toBe('/settings/model');
    expect(byId['company-brain'].route).toBe('/settings/company-brain');
    expect(byId['kunde'].route).toBe('/account?intent=add_seat');
    expect(byId['kunde'].isWebIntent).toBe(true);
    expect(byId['connectors'].route).toBe('/settings/connectors');
    expect(byId['team'].route).toBe('/settings/eve-runtime');
    expect(byId['skills'].route).toBe('/settings/capabilities?tab=skills');
    expect(byId['privacy'].route).toBe('/settings/privacy');
    expect(byId['budget'].route).toBe('/settings/billing');
    expect(byId['name'].route).toBe('/settings/account');
    // Only the seat-add step leaves the app.
    expect(steps.filter((s) => s.isWebIntent).map((s) => s.id)).toEqual(['kunde']);
  });

  it("marks the cloud lane 'done' ONLY when first value is proven ready", () => {
    const ready = buildErsteSchritteHubSteps({ firstValueReady: true, identityState: 'skipped' });
    expect(ready.find((s) => s.id === 'ki-spur')?.status).toBe('done');

    const notReady = buildErsteSchritteHubSteps({ firstValueReady: false, identityState: 'skipped' });
    // Never 'attention' (the readiness block above alarms an unready lane); neutral.
    expect(notReady.find((s) => s.id === 'ki-spur')?.status).toBe('optional');
  });

  it('maps identity state honestly: ok→done, blocked→attention, skipped/unknown→optional', () => {
    const cases: Array<[ErsteSchritteItemState, string]> = [
      ['ok', 'done'],
      ['blocked', 'attention'],
      ['skipped', 'optional'],
      ['unknown', 'optional'],
    ];
    for (const [state, expected] of cases) {
      const steps = buildErsteSchritteHubSteps({ firstValueReady: true, identityState: state });
      expect(steps.find((s) => s.id === 'name')?.status).toBe(expected);
    }
  });

  it('never fabricates a done/attention for the un-provable steps (they stay neutral)', () => {
    const steps = buildErsteSchritteHubSteps({ firstValueReady: true, identityState: 'ok' });
    const neutralIds = ['company-brain', 'kunde', 'connectors', 'team', 'skills', 'privacy', 'budget'];
    for (const id of neutralIds) {
      expect(steps.find((s) => s.id === id)?.status).toBe('optional');
    }
  });

  it('HONESTY: a null-ish read (not ready, identity unknown) yields ZERO done and ZERO attention', () => {
    const steps = buildErsteSchritteHubSteps({ firstValueReady: false, identityState: 'unknown' });
    expect(steps.some((s) => s.status === 'done')).toBe(false);
    expect(steps.some((s) => s.status === 'attention')).toBe(false);
    expect(steps.every((s) => s.status === 'optional')).toBe(true);
  });
});
