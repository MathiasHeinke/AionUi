/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const registered = new Map<string, (request?: unknown) => Promise<unknown>>();
const { silentResumeMock } = vi.hoisted(() => ({ silentResumeMock: vi.fn() }));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: (channel: string) => ({
      provider: (handler: (request?: unknown) => Promise<unknown>) => {
        registered.set(channel, handler);
        return { channel };
      },
    }),
  },
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: vi.fn(() => undefined), getSync: vi.fn(() => undefined), set: vi.fn() },
  getSkillsDir: () => '/tmp/skills',
  getCronSkillsDir: () => '/tmp/cron-skills',
}));

vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/command-eve-auth-resume-test' }));

vi.mock('@/common/config/licenseWireAtRest', () => ({
  clearLicenseWire: vi.fn(),
  hasLicenseWire: vi.fn(() => true),
  readLicenseWire: vi.fn(() => ({ ok: true, wire: 'CEVE.v2.synthetic.test' })),
  storeLicenseWire: vi.fn(),
}));

vi.mock('@process/commandEve/accountAuthOrchestratorCore', () => ({
  activateEntitlementFromSession: vi.fn(),
  silentResumeAccountAuth: silentResumeMock,
}));

import { initCommandEveBridge } from '@process/bridge/commandEveBridge';

type ResumeEnvelope = {
  success: boolean;
  data?: {
    version?: string;
    ok?: boolean;
    outcome?: string;
    entitled?: boolean;
    reason_code?: string;
    status?: { state?: string };
  };
};

describe('command-eve.auth-resume bridge', () => {
  beforeEach(() => {
    registered.clear();
    vi.clearAllMocks();
    silentResumeMock.mockResolvedValue({ outcome: 'skipped' });
    initCommandEveBridge();
    // initCommandEveBridge performs one startup resume; isolate the explicit
    // renderer-triggered provider call below.
    silentResumeMock.mockClear();
  });

  it('reuses the native silent-resume path and returns only typed entitlement status', async () => {
    silentResumeMock.mockResolvedValueOnce({
      outcome: 'resumed',
      activated: true,
      status: {
        version: 'command-eve-entitlement/v0',
        ok: true,
        required: false,
        state: 'entitled',
        reason_code: 'ENTITLED',
        tenant_id: 'tenant-1',
        edition: 'free',
        expires_at: null,
        trial_ends_at: null,
      },
    });

    const provider = registered.get('command-eve.auth-resume');
    expect(provider).toBeDefined();
    const result = (await provider?.()) as ResumeEnvelope;

    expect(silentResumeMock).toHaveBeenCalledTimes(1);
    expect(silentResumeMock).toHaveBeenCalledWith(
      '/tmp/command-eve-auth-resume-test',
      expect.objectContaining({ storeLicenseWire: expect.any(Function) })
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        version: 'command-eve-account-auth/v0',
        ok: true,
        outcome: 'resumed',
        entitled: true,
        status: { state: 'entitled' },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/access_token|refresh_token|CEVE\.v2/);
  });

  it('fails closed without inventing entitlement when resume throws', async () => {
    silentResumeMock.mockRejectedValueOnce(new Error('refresh unavailable'));
    const provider = registered.get('command-eve.auth-resume');

    const result = (await provider?.()) as ResumeEnvelope;

    expect(result).toMatchObject({
      success: false,
      data: {
        ok: false,
        outcome: 'error',
        entitled: false,
        reason_code: 'AUTH_RESUME_BRIDGE_FAILED',
      },
    });
  });
});
