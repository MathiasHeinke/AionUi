/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP-vault build flag tests (S5 phase 2, arch §9/§11.5). The security posture is
 * the DEFAULT: unset / garbage → false; only an explicit truthy token → true.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_MCP_VAULT_ENABLED_ENV,
  isMcpVaultEnabled,
  setMcpVaultEnabledForTests,
} from '@/process/commandEve/mcpVaultFlagCore';

afterEach(() => setMcpVaultEnabledForTests(undefined));

describe('isMcpVaultEnabled', () => {
  it('defaults to FALSE when the env var is unset', () => {
    expect(isMcpVaultEnabled({})).toBe(false);
  });

  it('is FALSE for any non-truthy token (fail-closed)', () => {
    for (const raw of ['', '0', 'false', 'off', 'no', 'FALSE', 'enabled', 'nonsense', ' ']) {
      expect(isMcpVaultEnabled({ [COMMAND_EVE_MCP_VAULT_ENABLED_ENV]: raw })).toBe(false);
    }
  });

  it('is TRUE only for an explicit truthy token', () => {
    for (const raw of ['1', 'true', 'on', 'yes', 'TRUE', ' True ']) {
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
