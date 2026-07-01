/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RECONCILE WIRING tests (S5 phase 2, arch §7/§11.5). The FLAG-OFF no-op is the
 * safety property: with COMMAND_EVE_MCP_VAULT_ENABLED off, neither approve/revoke
 * nor seat-switch runs the (heavy) re-render OR a respawn — so behavior stays
 * byte-identical to today. Flag-ON delegates to the pure core with the right
 * respawnAfter.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reconcileVaultConfigAfterConnectorChange,
  reconcileVaultConfigForSeatSwitch,
} from '@/process/commandEve/reconcileHermesMcpConfigWiring';
import { setMcpVaultEnabledForTests } from '@/process/commandEve/mcpVaultFlagCore';

afterEach(() => setMcpVaultEnabledForTests(undefined));

describe('reconcile wiring — flag OFF is a NO-OP (byte-identical safety)', () => {
  it('reconcileVaultConfigAfterConnectorChange does NOT re-render or respawn when the flag is off', async () => {
    setMcpVaultEnabledForTests(false);
    const reRenderConfig = vi.fn(async () => 5);
    const respawn = vi.fn(async () => undefined);
    const receipt = await reconcileVaultConfigAfterConnectorChange('approve', {
      getDataPath: () => '/tmp/x',
      reRenderConfig,
      respawn,
    });
    expect(reRenderConfig).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(receipt.ok).toBe(true);
    expect(receipt.connector_count).toBe(0);
  });

  it('reconcileVaultConfigForSeatSwitch does NOT re-render or respawn when the flag is off', async () => {
    setMcpVaultEnabledForTests(false);
    const reRenderConfig = vi.fn(async () => 5);
    const respawn = vi.fn(async () => undefined);
    const receipt = await reconcileVaultConfigForSeatSwitch({
      getDataPath: () => '/tmp/x',
      reRenderConfig,
      respawn,
    });
    expect(reRenderConfig).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(receipt.ok).toBe(true);
    expect(receipt.connector_count).toBe(0);
  });
});

describe('reconcile wiring — flag ON delegates to the pure core', () => {
  it('approve/revoke re-renders AND respawns (respawnAfter true)', async () => {
    setMcpVaultEnabledForTests(true);
    const order: string[] = [];
    const reRenderConfig = vi.fn(async () => {
      order.push('render');
      return 1;
    });
    const respawn = vi.fn(async () => {
      order.push('respawn');
    });
    const receipt = await reconcileVaultConfigAfterConnectorChange('revoke', {
      getDataPath: () => '/tmp/x',
      reRenderConfig,
      respawn,
    });
    expect(order).toEqual(['render', 'respawn']);
    expect(receipt.ok).toBe(true);
    expect(receipt.connector_count).toBe(1);
  });

  it('seat-switch re-renders but does NOT respawn (respawnAfter false — switch owns it)', async () => {
    setMcpVaultEnabledForTests(true);
    const reRenderConfig = vi.fn(async () => 2);
    const respawn = vi.fn(async () => undefined);
    const receipt = await reconcileVaultConfigForSeatSwitch({
      getDataPath: () => '/tmp/x',
      reRenderConfig,
      respawn,
    });
    expect(reRenderConfig).toHaveBeenCalledTimes(1);
    expect(respawn).not.toHaveBeenCalled();
    expect(receipt.ok).toBe(true);
    expect(receipt.connector_count).toBe(2);
  });
});
