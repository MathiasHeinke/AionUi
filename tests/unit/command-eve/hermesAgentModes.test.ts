/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  boundCommandEveModeMenu,
  commandEveBackendMode,
  COMMAND_EVE_HG4_DELEGATED_MODE,
  getAgentModes,
  isCommandEveModeExpansion,
  mergeWithCapabilities,
  supportsModeSwitch,
} from '@/renderer/utils/model/agentModes';

// The permission modes that gate Hermes (Command EVE) tool execution. These ids
// MUST match Hermes' ACP-advertised session modes (acp_adapter server
// _session_modes: default / accept_edits / dont_ask) so the desktop's static
// labels line up with the live ACP capability list.
describe('Command EVE / Hermes permission modes', () => {
  it('exposes ask-every-time / semi-autonomous / Auto for the hermes backend', () => {
    const modes = getAgentModes('hermes');
    expect(modes.map((m) => m.value)).toEqual(['default', 'accept_edits', 'dont_ask']);
    expect(modes.map((m) => m.label)).toEqual(['Ask every time', 'Semi-autonomous', 'Auto']);
  });

  it('reports that hermes supports mode switching (so the selector renders)', () => {
    expect(supportsModeSwitch('hermes')).toBe(true);
  });

  it('mode ids match Hermes ACP session modes so live capabilities override labels cleanly', () => {
    // When the ACP session reports its modes, mergeWithCapabilities keeps the
    // static labels for known ids and title-cases unknown ones.
    const merged = mergeWithCapabilities('hermes', ['default', 'accept_edits', 'dont_ask']);
    expect(merged.map((m) => m.value)).toEqual(['default', 'accept_edits', 'dont_ask']);
    // Known ids keep their static (human) labels rather than title-casing.
    expect(merged.find((m) => m.value === 'accept_edits')?.label).toBe('Semi-autonomous');
  });

  it('bounds the conversation menu to real Hermes modes and hides legacy Guarded Auto', () => {
    const bounded = boundCommandEveModeMenu(
      [
        ...getAgentModes('hermes'),
        { value: 'untrusted_runtime_mode', label: 'Untrusted' },
        { value: 'dont_ask', label: 'Misleading runtime label' },
      ],
      true
    );

    expect(bounded.map((mode) => mode.value)).toEqual(['default', 'accept_edits', 'dont_ask']);
    expect(bounded.some((mode) => mode.value === COMMAND_EVE_HG4_DELEGATED_MODE)).toBe(false);
    expect(commandEveBackendMode(COMMAND_EVE_HG4_DELEGATED_MODE)).toBe('default');
    expect(isCommandEveModeExpansion('dont_ask', COMMAND_EVE_HG4_DELEGATED_MODE)).toBe(true);
    expect(isCommandEveModeExpansion(COMMAND_EVE_HG4_DELEGATED_MODE, 'default')).toBe(false);
  });

  it('keeps the restrictive default escape when runtime capabilities are incomplete', () => {
    expect(boundCommandEveModeMenu([{ value: 'dont_ask', label: 'Auto' }], true).map((mode) => mode.value)).toEqual([
      'default',
      'dont_ask',
    ]);
  });
});
