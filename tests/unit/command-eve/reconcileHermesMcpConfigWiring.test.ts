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

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reconcileVaultConfigAfterConnectorChange,
  reconcileVaultConfigForSeatSwitch,
} from '@/process/commandEve/reconcileHermesMcpConfigWiring';
import { setMcpVaultEnabledForTests } from '@/process/commandEve/mcpVaultFlagCore';
import {
  __resetCommandEveBackendRestartForTests,
  runCommandEveBackendRestartReservation,
} from '@/process/commandEve/seatSwitchRuntime';

afterEach(() => {
  setMcpVaultEnabledForTests(undefined);
  __resetCommandEveBackendRestartForTests();
});

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

  it('holds the shared lifecycle reservation from connector render through respawn terminal', async () => {
    setMcpVaultEnabledForTests(true);
    const order: string[] = [];
    let markRenderEntered!: () => void;
    let releaseRender!: () => void;
    const renderEntered = new Promise<void>((resolve) => {
      markRenderEntered = resolve;
    });
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const connector = reconcileVaultConfigAfterConnectorChange('approve', {
      reRenderConfig: async () => {
        order.push('connector:render');
        markRenderEntered();
        await renderGate;
        return 1;
      },
      respawn: async () => {
        order.push('connector:respawn');
      },
    });
    await renderEntered;

    const queuedSeatSwitch = runCommandEveBackendRestartReservation(async () => {
      order.push('seat-switch:enter');
    });
    await Promise.resolve();
    expect(order).toEqual(['connector:render']);

    releaseRender();
    await Promise.all([connector, queuedSeatSwitch]);
    expect(order).toEqual(['connector:render', 'connector:respawn', 'seat-switch:enter']);
  });

  it('production re-render threads the canonical root and strict packaged runtime contract', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/process/commandEve/reconcileHermesMcpConfigWiring.ts'),
      'utf8'
    );
    expect(source).toContain('getCanonicalDataPath as realGetCanonicalDataPath');
    expect(source).toContain('canonicalUserDataPath,');
    expect(source).toContain('resourcesPath: process.resourcesPath');
    expect(source).toContain('requireBundledPython: packagedMac');
    expect(source).toContain("app.isPackaged && process.platform === 'darwin'");
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
