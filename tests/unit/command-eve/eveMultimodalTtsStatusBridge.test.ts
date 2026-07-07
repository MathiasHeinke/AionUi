/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE cloud TTS activation status IPC, tested through the REAL bridge
 * seam. The provider must expose only gate booleans/reasons and must not make a
 * cloud request while the main-owned egress/deploy gates are closed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const registered = new Map<string, (req?: unknown) => Promise<unknown>>();
vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: (channel: string) => ({
      provider: (fn: (req?: unknown) => Promise<unknown>) => {
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

vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/ce-tts-status-bridge' }));
vi.mock('@process/commandEve/seatWireFetchCore', () => ({ readMySeatsWire: vi.fn(async () => null) }));

const readLicenseWireMock = vi.fn(() => ({ ok: true, wire: 'test-license-wire' }));
vi.mock('@/common/config/licenseWireAtRest', () => ({
  clearLicenseWire: vi.fn(),
  hasLicenseWire: vi.fn(() => true),
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
  storeLicenseWire: vi.fn(),
}));

import { initCommandEveBridge } from '@process/bridge/commandEveBridge';

type StatusEnvelope = {
  success: boolean;
  data?: {
    ok?: boolean;
    enabled?: boolean;
    reason_code?: string;
    privacyLane?: string;
    residencyLane?: string;
    requirements?: {
      desktopCloudEgressGate?: boolean;
      mainOwnedPrivacyConsent?: boolean;
      serverGateway?: boolean;
      licenseBearer?: boolean;
      residencyAvailable?: boolean;
    };
  };
};

const call = (channel: string, req?: unknown) =>
  (registered.get(channel) as (request?: unknown) => Promise<StatusEnvelope>)(req);

const dataPath = '/tmp/ce-tts-status-bridge';
const consentPath = path.join(dataPath, 'command-eve-multimodal-tts-consent.json');

describe('Command EVE multimodal TTS status bridge', () => {
  beforeEach(() => {
    fs.rmSync(consentPath, { force: true });
    registered.clear();
    readLicenseWireMock.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('cloud fetch must not run for status');
      })
    );
    initCommandEveBridge();
    readLicenseWireMock.mockClear();
    vi.mocked(globalThis.fetch).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('registers the read-only activation status provider', () => {
    expect(registered.has('command-eve.multimodal-tts-status')).toBe(true);
  });

  it('registers main-owned consent providers', () => {
    expect(registered.has('command-eve.multimodal-tts-consent-get')).toBe(true);
    expect(registered.has('command-eve.multimodal-tts-consent-set')).toBe(true);
  });

  it('reports closed main gates without calling the cloud gateway', async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);

    const result = await call('command-eve.multimodal-tts-status');

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      enabled: false,
      reason_code: 'EVE_MULTIMODAL_TTS_NOT_ENABLED',
      privacyLane: 'cloud_auto',
      residencyLane: 'us_cloud',
      requirements: {
        desktopCloudEgressGate: false,
        mainOwnedPrivacyConsent: false,
        serverGateway: true,
        licenseBearer: true,
        residencyAvailable: true,
      },
    });
    expect(readLicenseWireMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result.data)).not.toContain('test-license-wire');
  });

  it('uses the main-owned privacy lane instead of renderer status payloads', async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);

    const setResult = await call('command-eve.multimodal-tts-consent-set', {
      data: { consent: true, privacyLane: 'local_only' },
    });
    expect(setResult).toMatchObject({ success: true, data: { consent: true, privacyLane: 'local_only' } });

    const result = await call('command-eve.multimodal-tts-status', { data: { privacyLane: 'cloud_us' } });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      enabled: false,
      reason_code: 'EVE_MULTIMODAL_TTS_LOCAL_ONLY_PRIVACY',
      privacyLane: 'local_only',
      residencyLane: 'blocked',
      requirements: {
        desktopCloudEgressGate: false,
        mainOwnedPrivacyConsent: true,
        serverGateway: true,
        licenseBearer: true,
        residencyAvailable: false,
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result.data)).not.toContain('test-license-wire');
  });
});
