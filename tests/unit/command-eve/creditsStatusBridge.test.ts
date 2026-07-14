/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registered = new Map<string, (request?: unknown) => Promise<unknown>>();

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

vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/command-eve-credits-test' }));

vi.mock('@/common/config/licenseWireAtRest', () => ({
  clearLicenseWire: vi.fn(),
  hasLicenseWire: vi.fn(() => true),
  readLicenseWire: vi.fn(() => ({ ok: true, wire: 'CEVE.v2.synthetic.test' })),
  storeLicenseWire: vi.fn(),
}));

import { initCommandEveBridge } from '@process/bridge/commandEveBridge';

type CreditsEnvelope = {
  success: boolean;
  data?: {
    ok?: boolean;
    reason_code?: string;
    has_active_topup?: boolean;
  };
};

describe('command-eve.credits-status unavailable truth', () => {
  beforeEach(() => {
    registered.clear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));
    initCommandEveBridge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not turn a network failure into a confirmed no-top-up verdict', async () => {
    const provider = registered.get('command-eve.credits-status');
    expect(provider).toBeDefined();

    const result = (await provider?.()) as CreditsEnvelope;

    expect(result).toMatchObject({
      success: false,
      data: { ok: false, reason_code: 'CREDITS_STATUS_NETWORK' },
    });
    expect(result.data).not.toHaveProperty('has_active_topup');
  });
});
