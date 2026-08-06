/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18205-SETTINGS — the two things the modal-level test cannot reach.
 *
 * `SystemModalContent.dom.test.tsx` drives this switch through the real settings
 * list and proves the visible contract: default-off, reads an explicit `true`,
 * persists both directions, hidden for a non-entitled seat. What it cannot cover
 * is the FAILURE path, because its `configService.set` mock always resolves.
 *
 * That path is where the money is. A spend release that silently fails to persist
 * leaves the operator believing they granted — or revoked — something they did
 * not, and the main-process gate reads the backend, not the screen. So the two
 * claims here are:
 *
 *   1. a rejected write rolls the cache back AND says so, never silently;
 *   2. the rollback is SEAT-GUARDED — a rebind mid-flight must not land seat A's
 *      rollback in seat B's namespace, which for a spend switch would apply a
 *      grant (or a revocation) to the wrong client.
 *
 * Plus the pure visibility predicate, enumerated over every entitlement state
 * rather than sampled: it decides whether a paid control is offered at all.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { configValues, configSetMock, configSetLocalMock, getCurrentSeatIdMock, messageErrorMock } = vi.hoisted(() => ({
  configValues: new Map<string, unknown>(),
  configSetMock: vi.fn<(key: string, value: unknown) => Promise<void>>(),
  configSetLocalMock: vi.fn(),
  getCurrentSeatIdMock: vi.fn<() => string>(() => 'seat-acme'),
  messageErrorMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));

vi.mock('@/renderer/hooks/config/useConfig', () => ({
  useConfig: (key: string) => [configValues.get(key), vi.fn()],
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    set: configSetMock,
    setLocal: configSetLocalMock,
    getCurrentSeatId: getCurrentSeatIdMock,
  },
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, error: messageErrorMock } };
});

import AgentVideoGenerateToggle, {
  AGENT_VIDEO_GENERATE_TOGGLE_TESTID,
  isAgentVideoGenerateSettingVisible,
} from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/AgentVideoGenerateToggle';

const KEY = 'commandEve.agentVideoGenerateEnabled';

describe('isAgentVideoGenerateSettingVisible — only an entitled seat is offered the control', () => {
  it('shows for an entitled seat', () => {
    expect(isAgentVideoGenerateSettingVisible('entitled')).toBe(true);
  });

  it('hides for every other state, and for the not-yet-known window', () => {
    for (const state of ['unconfigured', 'unregistered', 'registered_unlicensed', 'expired'] as const) {
      expect(isAgentVideoGenerateSettingVisible(state), `"${state}" must hide the control`).toBe(false);
    }
    expect(isAgentVideoGenerateSettingVisible(undefined)).toBe(false);
    expect(isAgentVideoGenerateSettingVisible(null)).toBe(false);
  });
});

describe('AgentVideoGenerateToggle — the persistence failure path', () => {
  beforeEach(() => {
    cleanup();
    configValues.clear();
    vi.clearAllMocks();
    getCurrentSeatIdMock.mockReturnValue('seat-acme');
    configSetMock.mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  const toggle = () => screen.getByTestId(AGENT_VIDEO_GENERATE_TOGGLE_TESTID);

  it('reads a missing value as OFF — absent is never consent', () => {
    render(<AgentVideoGenerateToggle />);
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
  });

  it('reads only an exact true as ON', () => {
    for (const raw of ['true', 1, 'yes', {}, null]) {
      cleanup();
      configValues.set(KEY, raw);
      render(<AgentVideoGenerateToggle />);
      expect(toggle(), `${JSON.stringify(raw)} must not read as granted`).toHaveAttribute('aria-checked', 'false');
    }
    cleanup();
    configValues.set(KEY, true);
    render(<AgentVideoGenerateToggle />);
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });

  it('rolls the cache back and reports LOUDLY when the write is rejected', async () => {
    configSetMock.mockRejectedValueOnce(new Error('backend rejected'));
    render(<AgentVideoGenerateToggle />);

    fireEvent.click(toggle());

    await vi.waitFor(() => expect(configSetLocalMock).toHaveBeenCalledWith(KEY, false));
    // The write that was attempted, and the value rolled back to — a failed grant
    // must land on OFF, not on an optimistic true the backend never accepted.
    expect(configSetMock).toHaveBeenCalledWith(KEY, true);
    expect(messageErrorMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT roll back into another seat when a rebind lands mid-flight', async () => {
    configSetMock.mockRejectedValueOnce(new Error('backend rejected'));
    render(<AgentVideoGenerateToggle />);

    // The write is ISSUED for 'seat-acme' (first read); by the time it rejects the
    // operator has switched, so the second read answers 'seat-other'. Seat A's
    // rollback must not write into seat B's namespace.
    getCurrentSeatIdMock.mockReturnValueOnce('seat-acme').mockReturnValue('seat-other');
    fireEvent.click(toggle());

    await vi.waitFor(() => expect(messageErrorMock).toHaveBeenCalledTimes(1));
    expect(configSetLocalMock).not.toHaveBeenCalled();
  });
});
