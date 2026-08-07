/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP-vault flag tests (S5 phase 2, arch §9/§11.5).
 *
 * REWRITTEN IN 1.821.0, NOT DELETED. This suite used to pin "the security
 * posture is the DEFAULT: unset / garbage → false; only an explicit truthy token
 * → true" — correct while the gate protected PER-CLIENT ISOLATION between paying
 * clients sharing one install. There are none, and the feeder, reconcile and
 * guided-auth surface behind it were finished and shipped inert.
 *
 * The flag is now a KILL SWITCH: unset means on, and only an explicit falsey
 * token turns it off. What survives unchanged is the strictness — a typo must
 * not silently flip the surface in EITHER direction, which is why the parse is
 * still an allow-list of exact tokens rather than a truthiness check.
 *
 * What is NOT weakened by this, and the distinction matters: the isolation
 * itself. The vetted set is read by file POSITION (founder vault ∪ this seat's
 * vault), never by filtering a shared list, so a seat-A record has nowhere to
 * appear in seat-B's set. The gate was a second belt around a structural
 * property, not the property.
 *
 * This falls back when an install first serves a second party's seat.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_MCP_VAULT_ENABLED_ENV,
  isMcpVaultEnabled,
  setMcpVaultEnabledForTests,
} from '@/process/commandEve/mcpVaultFlagCore';

afterEach(() => setMcpVaultEnabledForTests(undefined));

describe('isMcpVaultEnabled', () => {
  it('is ON when the env var is unset — the vault surface is the product now', () => {
    expect(isMcpVaultEnabled({})).toBe(true);
  });

  it('is OFF only for an explicit falsey token', () => {
    for (const raw of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
      expect(isMcpVaultEnabled({ [COMMAND_EVE_MCP_VAULT_ENABLED_ENV]: raw })).toBe(false);
    }
  });

  it('a typo does not silently disable it — the parse stayed strict', () => {
    // The old suite asserted the mirror image of this for the same reason: a
    // value nobody meant must never move the posture. Only the direction the
    // strictness protects has changed.
    for (const raw of ['', 'nonsense', 'disabled', 'nope', '00', ' ', '1', 'true', 'on', 'yes']) {
      expect(isMcpVaultEnabled({ [COMMAND_EVE_MCP_VAULT_ENABLED_ENV]: raw })).toBe(true);
    }
  });

  it('the test override wins over the env', () => {
    setMcpVaultEnabledForTests(true);
    expect(isMcpVaultEnabled({ [COMMAND_EVE_MCP_VAULT_ENABLED_ENV]: 'false' })).toBe(true);
    setMcpVaultEnabledForTests(false);
    expect(isMcpVaultEnabled({ [COMMAND_EVE_MCP_VAULT_ENABLED_ENV]: 'true' })).toBe(false);
    setMcpVaultEnabledForTests(undefined);
    expect(isMcpVaultEnabled({ [COMMAND_EVE_MCP_VAULT_ENABLED_ENV]: 'true' })).toBe(true);
  });
});
