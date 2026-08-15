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
  runConnectorAuthorityMutationTransaction,
} from '@/process/commandEve/reconcileHermesMcpConfigWiring';
import { setMcpVaultEnabledForTests } from '@/process/commandEve/mcpVaultFlagCore';
import {
  __resetCommandEveBackendRestartForTests,
  runCommandEveBackendRestartReservation,
  setCommandEveBackendRestart,
} from '@/process/commandEve/seatSwitchRuntime';
import { __resetActiveSeatForTests, getActiveSeatId, setActiveSeatId } from '@/process/commandEve/seatContextCore';

afterEach(() => {
  setMcpVaultEnabledForTests(undefined);
  __resetCommandEveBackendRestartForTests();
  __resetActiveSeatForTests();
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

  it('keeps approve mutation, leased reconcile and response terminal ahead of a later seat switch', async () => {
    setMcpVaultEnabledForTests(true);
    const seatA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const seatB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const order: string[] = [];
    let releaseResponse!: () => void;
    let markResponsePending!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const responsePending = new Promise<void>((resolve) => {
      markResponsePending = resolve;
    });
    setActiveSeatId(seatA);
    setCommandEveBackendRestart(async () => {
      order.push(`approve:respawn:${getActiveSeatId()}`);
    });

    const approve = runCommandEveBackendRestartReservation(async (restartLease) => {
      order.push(`approve:mutation:${getActiveSeatId()}`);
      await reconcileVaultConfigAfterConnectorChange(
        'approve',
        {
          reRenderConfig: async () => {
            order.push(`approve:render:${getActiveSeatId()}`);
            return 1;
          },
        },
        restartLease
      );
      markResponsePending();
      await responseGate;
      order.push(`approve:response:${getActiveSeatId()}`);
    });
    await responsePending;
    const seatSwitch = runCommandEveBackendRestartReservation(async () => {
      setActiveSeatId(seatB);
      order.push(`switch:${getActiveSeatId()}`);
    });
    await Promise.resolve();

    expect(getActiveSeatId()).toBe(seatA);
    expect(order).toEqual([`approve:mutation:${seatA}`, `approve:render:${seatA}`, `approve:respawn:${seatA}`]);
    releaseResponse();
    await Promise.all([approve, seatSwitch]);
    expect(order).toEqual([
      `approve:mutation:${seatA}`,
      `approve:render:${seatA}`,
      `approve:respawn:${seatA}`,
      `approve:response:${seatA}`,
      `switch:${seatB}`,
    ]);
  });

  it('keeps revoke rollback on its original seat and blocks a queued switch until the failure response is terminal', async () => {
    setMcpVaultEnabledForTests(true);
    const seatA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const seatB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const order: string[] = [];
    let markRollbackEntered!: () => void;
    let releaseRollback!: () => void;
    const rollbackEntered = new Promise<void>((resolve) => {
      markRollbackEntered = resolve;
    });
    const rollbackGate = new Promise<void>((resolve) => {
      releaseRollback = resolve;
    });
    setActiveSeatId(seatA);

    const revoke = runCommandEveBackendRestartReservation(async (restartLease) => {
      order.push(`revoke:mutation:${getActiveSeatId()}`);
      try {
        const receipt = await reconcileVaultConfigAfterConnectorChange(
          'revoke',
          {
            reRenderConfig: async () => {
              order.push(`revoke:render:${getActiveSeatId()}`);
              throw new Error('render rejected');
            },
          },
          restartLease
        );
        if (!receipt.ok) throw new Error(receipt.reason_code);
      } catch {
        order.push(`revoke:rollback:${getActiveSeatId()}`);
        markRollbackEntered();
        await rollbackGate;
        order.push(`revoke:response:${getActiveSeatId()}`);
      }
    });
    await rollbackEntered;
    const seatSwitch = runCommandEveBackendRestartReservation(async () => {
      setActiveSeatId(seatB);
      order.push(`switch:${getActiveSeatId()}`);
    });
    await Promise.resolve();

    expect(getActiveSeatId()).toBe(seatA);
    expect(order).toEqual([`revoke:mutation:${seatA}`, `revoke:render:${seatA}`, `revoke:rollback:${seatA}`]);
    releaseRollback();
    await Promise.all([revoke, seatSwitch]);
    expect(order).toEqual([
      `revoke:mutation:${seatA}`,
      `revoke:render:${seatA}`,
      `revoke:rollback:${seatA}`,
      `revoke:response:${seatA}`,
      `switch:${seatB}`,
    ]);
  });

  it('restores vault, rendered config, backend, port and provider after a post-publish approval failure', async () => {
    setMcpVaultEnabledForTests(true);
    const state: {
      vault: string;
      config: string;
      backend: string;
      managerPort: number;
      globalPort: number | undefined;
      provider: string;
    } = {
      vault: 'prior-authority',
      config: 'prior-authority',
      backend: 'prior-authority',
      managerPort: 4100,
      globalPort: 4100,
      provider: 'prior-authority',
    };
    const order: string[] = [];
    let respawnAttempt = 0;
    let markResponseEntered!: () => void;
    let releaseResponse!: () => void;
    const responseEntered = new Promise<void>((resolve) => {
      markResponseEntered = resolve;
    });
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });

    const approval = runConnectorAuthorityMutationTransaction({
      trigger: 'approve',
      mutate: () => {
        state.vault = 'new-authority';
        order.push('vault:new');
        return {
          value: { connector_id: 'notion-workspace' },
          accepted: true,
          rollbackTrigger: 'revoke' as const,
          rollback: () => {
            state.vault = 'prior-authority';
            order.push('vault:prior');
            return true;
          },
        };
      },
      reconcileDeps: {
        reRenderConfig: async () => {
          state.config = state.vault;
          order.push(`render:${state.config}`);
          return 1;
        },
        respawn: async () => {
          respawnAttempt += 1;
          state.backend = state.config;
          state.managerPort = 4100 + respawnAttempt;
          state.globalPort = state.managerPort;
          state.provider = state.config;
          order.push(`publish:${state.backend}:${state.globalPort}`);
          if (respawnAttempt === 1) {
            throw new Error('post-start provider check failed api_key=do-not-leak');
          }
        },
      },
      finalize: async (outcome) => {
        order.push(`response:${outcome.terminal_state}:pending`);
        markResponseEntered();
        await responseGate;
        order.push(`response:${outcome.terminal_state}:terminal`);
        return outcome;
      },
    });
    await responseEntered;
    const laterSeatSwitch = runCommandEveBackendRestartReservation(async () => {
      order.push('seat-switch:enter');
    });
    await Promise.resolve();
    expect(order).not.toContain('seat-switch:enter');

    releaseResponse();
    const [outcome] = await Promise.all([approval, laterSeatSwitch]);
    expect(outcome.ok).toBe(false);
    expect(outcome.terminal_state).toBe('prior_authority_restored');
    expect(outcome.original_error).toContain('api_key=[redacted]');
    expect(outcome.original_error).not.toContain('do-not-leak');
    expect(outcome.rollback?.mutation_restored).toBe(true);
    expect(outcome.rollback?.reconcile?.ok).toBe(true);
    expect(state).toEqual({
      vault: 'prior-authority',
      config: 'prior-authority',
      backend: 'prior-authority',
      managerPort: 4102,
      globalPort: 4102,
      provider: 'prior-authority',
    });
    expect(order).toEqual([
      'vault:new',
      'render:new-authority',
      'publish:new-authority:4101',
      'vault:prior',
      'render:prior-authority',
      'publish:prior-authority:4102',
      'response:prior_authority_restored:pending',
      'response:prior_authority_restored:terminal',
      'seat-switch:enter',
    ]);
  });

  it('reports termination unproven with redacted diagnostics when fail-closed itself throws without proof', async () => {
    setMcpVaultEnabledForTests(true);
    const state: {
      vault: string;
      config: string;
      backend: string;
      managerPort: number;
      globalPort: number | undefined;
      provider: string;
    } = {
      vault: 'prior-authority',
      config: 'prior-authority',
      backend: 'prior-authority',
      managerPort: 4200,
      globalPort: 4200,
      provider: 'prior-authority',
    };
    let respawnAttempt = 0;
    const outcome = await runConnectorAuthorityMutationTransaction({
      trigger: 'approve',
      mutate: () => {
        state.vault = 'new-authority';
        return {
          value: { connector_id: 'notion-workspace' },
          accepted: true,
          rollbackTrigger: 'revoke' as const,
          rollback: () => {
            state.vault = 'prior-authority';
            return true;
          },
        };
      },
      reconcileDeps: {
        reRenderConfig: async () => {
          state.config = state.vault;
          return 1;
        },
        respawn: async () => {
          respawnAttempt += 1;
          state.backend = state.config;
          state.managerPort = 4200 + respawnAttempt;
          state.globalPort = state.managerPort;
          state.provider = state.config;
          throw new Error(
            respawnAttempt === 1
              ? 'primary provider validation failed NOTION_TOKEN=primary-secret'
              : 'rollback provider validation failed VENDOR_API_KEY=rollback-secret'
          );
        },
      },
      failClosed: async () => {
        state.backend = 'down';
        state.managerPort = 0;
        state.globalPort = undefined;
        state.provider = 'unavailable';
        throw new Error('registry cleanup failed SERVICE_SECRET=cleanup-secret');
      },
      finalize: (transaction) => transaction,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.terminal_state).toBe('termination_unproven');
    expect(outcome.original_error).toContain('NOTION_TOKEN=[redacted]');
    expect(outcome.rollback?.error).toContain('VENDOR_API_KEY=[redacted]');
    expect(outcome.rollback?.fail_closed_error).toContain('SERVICE_SECRET=[redacted]');
    expect(JSON.stringify(outcome)).not.toMatch(/primary-secret|rollback-secret|cleanup-secret/);
    expect(state).toEqual({
      vault: 'prior-authority',
      config: 'prior-authority',
      backend: 'down',
      managerPort: 0,
      globalPort: undefined,
      provider: 'unavailable',
    });
  });

  it('claims backend_fail_closed only after an explicit safe-down proof', async () => {
    setMcpVaultEnabledForTests(true);
    const failClosed = vi.fn(async () => undefined);
    const outcome = await runConnectorAuthorityMutationTransaction({
      trigger: 'approve',
      mutate: () => ({
        value: { connector_id: 'notion-workspace' },
        accepted: true,
        rollbackTrigger: 'revoke' as const,
        rollback: () => false,
      }),
      reconcileDeps: {
        reRenderConfig: async () => {
          throw new Error('primary projection failed');
        },
      },
      failClosed,
      finalize: (transaction) => transaction,
    });

    expect(failClosed).toHaveBeenCalledOnce();
    expect(outcome.terminal_state).toBe('backend_fail_closed');
  });

  it('keeps a proven stop with a tagged cleanup diagnostic distinct from termination_unproven', async () => {
    setMcpVaultEnabledForTests(true);
    const outcome = await runConnectorAuthorityMutationTransaction({
      trigger: 'approve',
      mutate: () => ({
        value: { connector_id: 'notion-workspace' },
        accepted: true,
        rollbackTrigger: 'revoke' as const,
        rollback: () => false,
      }),
      reconcileDeps: {
        reRenderConfig: async () => {
          throw new Error('primary projection failed');
        },
      },
      failClosed: async () => {
        throw Object.assign(new Error('cleanup NOTION_TOKEN=do-not-leak'), {
          code: 'COMMAND_EVE_BACKEND_FAIL_CLOSED_PROVEN_WITH_CLEANUP_ERROR',
        });
      },
      finalize: (transaction) => transaction,
    });

    expect(outcome.terminal_state).toBe('backend_fail_closed');
    expect(outcome.rollback?.fail_closed_error).toContain('NOTION_TOKEN=[redacted]');
    expect(JSON.stringify(outcome)).not.toContain('do-not-leak');
  });

  it('uses the same atomic seam for a generic revoke and restores prior authority on failure', async () => {
    setMcpVaultEnabledForTests(true);
    let vault = 'prior-authority';
    let config = 'prior-authority';
    let backend = 'prior-authority';
    let attempt = 0;
    const outcome = await runConnectorAuthorityMutationTransaction({
      trigger: 'revoke',
      mutate: () => {
        vault = 'absent';
        return {
          value: { connector_id: 'notion-workspace' },
          accepted: true,
          rollbackTrigger: 'approve' as const,
          rollback: () => {
            vault = 'prior-authority';
            return true;
          },
        };
      },
      reconcileDeps: {
        reRenderConfig: async () => {
          config = vault;
          return vault === 'absent' ? 0 : 1;
        },
        respawn: async () => {
          attempt += 1;
          backend = config;
          if (attempt === 1) throw new Error('revoke publish failed');
        },
      },
      finalize: (transaction) => transaction,
    });

    expect(outcome.terminal_state).toBe('prior_authority_restored');
    expect({ vault, config, backend }).toEqual({
      vault: 'prior-authority',
      config: 'prior-authority',
      backend: 'prior-authority',
    });
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
