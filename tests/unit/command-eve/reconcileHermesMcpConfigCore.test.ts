/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RECONCILE tests (S5 phase 2, arch §7/§12): config.yaml is a derived cache.
 *  - re-render runs BEFORE respawn, respawn EXACTLY once (approve/revoke);
 *  - respawnAfter:false (seat-switch) → re-render only, NO respawn;
 *  - re-render throws → respawn NEVER runs (fail-closed);
 *  - a respawn-owning call without an explicit lifecycle owner fails closed;
 *  - respawn throws → fail-closed receipt, connector_count preserved;
 *  - the receipt carries seat_id + connector_count + at.
 */

import { describe, expect, it, vi } from 'vitest';
import { reconcileHermesMcpConfigForActiveSeat } from '@/process/commandEve/reconcileHermesMcpConfigCore';

const FIXED = new Date('2026-07-02T12:00:00.000Z');

describe('reconcileHermesMcpConfigForActiveSeat', () => {
  it('re-renders then respawns EXACTLY once, in order (approve)', async () => {
    const calls: string[] = [];
    const reRenderConfig = vi.fn(async (seatId: string) => {
      calls.push(`render:${seatId}`);
      return 2;
    });
    const respawn = vi.fn(async () => {
      calls.push('respawn');
    });

    const receipt = await reconcileHermesMcpConfigForActiveSeat(
      { getActiveSeatId: () => 'seat-a', reRenderConfig, respawn, now: () => FIXED },
      { trigger: 'approve' }
    );

    expect(calls).toEqual(['render:seat-a', 'respawn']); // ORDER: render BEFORE respawn
    expect(respawn).toHaveBeenCalledTimes(1);
    expect(receipt).toEqual({ ok: true, seat_id: 'seat-a', connector_count: 2, at: FIXED.toISOString() });
  });

  it('respawnAfter:false (seat-switch) re-renders but does NOT respawn', async () => {
    const reRenderConfig = vi.fn(async () => 1);
    const respawn = vi.fn(async () => undefined);

    const receipt = await reconcileHermesMcpConfigForActiveSeat(
      { getActiveSeatId: () => 'seat-b', reRenderConfig, respawn, now: () => FIXED },
      { trigger: 'seat_switch', respawnAfter: false }
    );

    expect(reRenderConfig).toHaveBeenCalledTimes(1);
    expect(respawn).not.toHaveBeenCalled(); // the switch owns the single respawn
    expect(receipt.ok).toBe(true);
    expect(receipt.connector_count).toBe(1);
  });

  it('a re-render failure means respawn NEVER runs (fail-closed)', async () => {
    const respawn = vi.fn(async () => undefined);
    const receipt = await reconcileHermesMcpConfigForActiveSeat({
      getActiveSeatId: () => 'seat-a',
      reRenderConfig: () => {
        throw new Error('disk full');
      },
      respawn,
      now: () => FIXED,
    });
    expect(respawn).not.toHaveBeenCalled();
    expect(receipt.ok).toBe(false);
    expect(receipt.connector_count).toBe(0);
    expect(receipt.reason_code).toContain('RECONCILE_RERENDER_FAILED');
  });

  it('a respawn failure is reported fail-closed (connector_count preserved)', async () => {
    const receipt = await reconcileHermesMcpConfigForActiveSeat({
      getActiveSeatId: () => 'seat-a',
      reRenderConfig: async () => 3,
      respawn: async () => {
        throw new Error('backend dead');
      },
      now: () => FIXED,
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.connector_count).toBe(3);
    expect(receipt.reason_code).toContain('RECONCILE_RESPAWN_FAILED');
  });

  it('requires an explicit lifecycle owner whenever this reconcile owns the respawn', async () => {
    const receipt = await reconcileHermesMcpConfigForActiveSeat({
      getActiveSeatId: () => 'seat-a',
      reRenderConfig: async () => 2,
      now: () => FIXED,
    });

    expect(receipt).toEqual({
      ok: false,
      seat_id: 'seat-a',
      connector_count: 2,
      at: FIXED.toISOString(),
      reason_code: 'RECONCILE_RESPAWN_OWNER_REQUIRED',
    });
  });
});
