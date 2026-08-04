import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readLicenseWireMock } = vi.hoisted(() => ({
  readLicenseWireMock: vi.fn(() => ({ ok: true, wire: 'CEVE.v2.test-wire' })),
}));

vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
}));

import {
  COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG,
  isAgentImageEditAdvertisingEnabled,
  isAgentImageEditEnabled,
  resolveAgentImageEditAdvertisement,
} from '@/process/commandEve/agentImageEditFlag';

beforeEach(() => {
  readLicenseWireMock.mockReset();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'CEVE.v2.test-wire' });
});

describe('the image edit advertisement flag', () => {
  it('the child reads exactly "1" and nothing else', () => {
    expect(isAgentImageEditEnabled({ [COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG]: '1' })).toBe(true);
    expect(isAgentImageEditEnabled({ [COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG]: 'true' })).toBe(false);
    expect(isAgentImageEditEnabled({ [COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG]: '0' })).toBe(false);
    expect(isAgentImageEditEnabled({})).toBe(false);
  });

  it('kill-switch first: "0" closes even an eligible seat', () => {
    expect(
      resolveAgentImageEditAdvertisement({
        env: { [COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG]: '0' },
        licenseWirePresent: true,
      })
    ).toBe(false);
  });

  it('an eligible seat advertises by default; "1" is a no-op that cannot bypass eligibility', () => {
    expect(resolveAgentImageEditAdvertisement({ env: {}, licenseWirePresent: true })).toBe(true);
    expect(resolveAgentImageEditAdvertisement({ env: {}, licenseWirePresent: false })).toBe(false);
    expect(
      resolveAgentImageEditAdvertisement({
        env: { [COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG]: '1' },
        licenseWirePresent: false,
      })
    ).toBe(false);
  });

  it('the production read fails closed on a missing or unreadable wire', () => {
    expect(isAgentImageEditAdvertisingEnabled('/tmp/unused-seat', {})).toBe(true);
    readLicenseWireMock.mockReturnValue({ ok: false, reason_code: 'LICENSE_WIRE_MISSING' });
    expect(isAgentImageEditAdvertisingEnabled('/tmp/unused-seat', {})).toBe(false);
  });
});
