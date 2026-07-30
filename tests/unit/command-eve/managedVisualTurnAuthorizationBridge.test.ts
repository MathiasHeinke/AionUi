/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registered = new Map<string, (request?: unknown) => Promise<unknown>>();
const { getEntitlementStatusMock, readLicenseWireMock } = vi.hoisted(() => ({
  getEntitlementStatusMock: vi.fn(() => ({ state: 'entitled', has_paid_seat: true })),
  readLicenseWireMock: vi.fn(() => ({ ok: true, wire: 'CEVE.v2.synthetic.test' })),
}));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: (channel: string) => ({
      provider: (fn: (request?: unknown) => Promise<unknown>) => {
        registered.set(channel, fn);
        return { channel };
      },
    }),
  },
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: () => undefined, getSync: () => undefined, set: () => {} },
  getSkillsDir: () => '/tmp/skills',
  getCronSkillsDir: () => '/tmp/cron-skills',
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/command-eve-managed-visual-bridge' }));
vi.mock('@process/commandEve/seatWireFetchCore', () => ({ readMySeatsWire: vi.fn(async () => null) }));
vi.mock('@process/commandEve/entitlementCore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@process/commandEve/entitlementCore')>();
  return {
    ...original,
    getEntitlementStatus: (...args: unknown[]) => getEntitlementStatusMock(...args),
  };
});
vi.mock('@/common/config/licenseWireAtRest', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/common/config/licenseWireAtRest')>();
  return {
    ...original,
    readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
  };
});
vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: vi.fn(async (method: string) => {
    if (method === 'GET') return {};
    return undefined;
  }),
}));

import { initCommandEveBridge } from '@process/bridge/commandEveBridge';
import {
  clearCommandEveManagedVisualTurnAuthorizationsForTests,
  resolveCommandEveManagedVisualTurn,
} from '@process/commandEve/managedVisualTurnAuthorizationCore';
import {
  clearCommandEveCloudVisualPolicyReceiptsForTests,
  verifyCommandEveCloudVisualPolicyReceipt,
} from '@process/commandEve/visual/cloudVisualPolicyMain';
import {
  __resetActiveSeatForTests,
  getActiveSeatContextRevision,
  setActiveSeatId,
} from '@process/commandEve/seatContextCore';

const SEAT_ID = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const FLOW_ID = 'visual_flow_0123456789abcdef';

type BridgeEnvelope<T> = {
  success: boolean;
  msg?: string;
  data?: T;
};

type ReceiptResult = {
  ok: boolean;
  receipt?: {
    version: 'command-eve-cloud-visual-policy/v1';
    receiptId: string;
    flowId: string;
    expiresAt: string;
  };
};

type AuthorizationResult = {
  ok: boolean;
  reason_code?: string;
  marker?: string;
};

const issueReceipt = () =>
  (
    registered.get('command-eve.cloud-visual-policy-receipt') as (
      request: unknown
    ) => Promise<BridgeEnvelope<ReceiptResult>>
  )({ flowId: FLOW_ID });

const authorize = (request: unknown) =>
  (
    registered.get('command-eve.managed-visual-turn-authorize') as (
      value: unknown
    ) => Promise<BridgeEnvelope<AuthorizationResult>>
  )(request);

describe('managed visual authorization bridge receipt retirement', () => {
  beforeEach(() => {
    registered.clear();
    clearCommandEveCloudVisualPolicyReceiptsForTests();
    clearCommandEveManagedVisualTurnAuthorizationsForTests();
    __resetActiveSeatForTests();
    setActiveSeatId(SEAT_ID);
    getEntitlementStatusMock.mockClear();
    readLicenseWireMock.mockClear();
    initCommandEveBridge();
  });

  afterEach(() => {
    clearCommandEveCloudVisualPolicyReceiptsForTests();
    clearCommandEveManagedVisualTurnAuthorizationsForTests();
    __resetActiveSeatForTests();
    vi.clearAllMocks();
  });

  it('retires one flow receipt only after a successful final marker mint', async () => {
    const issued = await issueReceipt();
    expect(issued).toMatchObject({ success: true, data: { ok: true } });
    const receipt = issued.data?.receipt;
    if (!receipt) throw new Error('expected visual-policy receipt');

    const malformed = await authorize({
      flowId: FLOW_ID,
      visualPolicyReceipt: receipt,
      preferredTier: 'high',
      sourceCount: 7,
    });
    expect(malformed).toMatchObject({
      success: false,
      data: { ok: false, reason_code: 'EVE_MANAGED_VISUAL_BAD_SOURCE_COUNT' },
    });
    expect(verifyCommandEveCloudVisualPolicyReceipt(receipt, FLOW_ID).ok).toBe(true);

    const request = {
      flowId: FLOW_ID,
      visualPolicyReceipt: receipt,
      preferredTier: 'high',
      sourceCount: 1,
    };
    const first = await authorize(request);
    expect(first).toMatchObject({ success: true, data: { ok: true, marker: expect.any(String) } });
    expect(verifyCommandEveCloudVisualPolicyReceipt(receipt, FLOW_ID)).toEqual({
      ok: false,
      reason: 'receipt_unknown',
    });

    const second = await authorize(request);
    expect(second).toMatchObject({
      success: false,
      data: { ok: false, reason_code: 'EVE_MANAGED_VISUAL_POLICY_RECEIPT_REQUIRED' },
    });

    const marker = first.data?.marker;
    if (!marker) throw new Error('expected managed visual marker');
    const body = { messages: [{ role: 'user', content: `${marker}\nAnalyze the selected files.` }] };
    expect(resolveCommandEveManagedVisualTurn(body, SEAT_ID, getActiveSeatContextRevision())).toMatchObject({
      status: 'authorized',
    });
    expect(resolveCommandEveManagedVisualTurn(body, SEAT_ID, getActiveSeatContextRevision())).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_UNKNOWN',
    });
  });
});
