/**
 * 1.823.0 — autonomous agent video generation stays fail-closed until a
 * confirmed turn can mint a single-use spend permit. The explicit composer
 * video lane is tested separately and is not governed by this MCP fence.
 */

import { describe, expect, it, vi } from 'vitest';

const readSettingsMock = vi.fn(async () => ({ 'commandEve.agentVideoGenerateEnabled': true }));

vi.mock('@/process/commandEve/commandEveBackendSettingsRead', () => ({
  readCommandEveSettingsFromBackend: (...args: unknown[]) => readSettingsMock(...args),
}));

vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/eve-agent-video-generate-fence' }));

vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: () => ({ ok: true, wire: 'CEVE.v2.payload.sig' }),
}));

const { AGENT_VIDEO_GENERATE_TURN_AUTHORITY_READY } = await import('@/common/config/agentVideoGenerateReleaseCore');
const { productionAgentVideoGenerateGate } = await import('@/process/commandEve/agentVideoGenerateGateMain');

describe('agent video generate 1.823.0 release fence', () => {
  it('refuses before reading an otherwise-enabled per-seat release', async () => {
    expect(AGENT_VIDEO_GENERATE_TURN_AUTHORITY_READY).toBe(false);
    await expect(productionAgentVideoGenerateGate()).resolves.toBe(false);
    expect(readSettingsMock).not.toHaveBeenCalled();
  });
});
