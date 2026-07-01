/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RECONCILE — config.yaml as a DERIVED CACHE of the vault (S5 phase 2, arch §7).
 *
 * config.yaml's `mcp_servers:` block is a CACHE; the VAULT is the truth. Whenever
 * the vetted set for the active seat can change — a connector is APPROVED, a
 * connector is REVOKED, or the operator ENTERS a seat (applySeatSwitch) — the
 * config.yaml must be re-derived from the vault and the backend re-spawned so the
 * running Hermes agent reads the fresh set.
 *
 * `reconcileHermesMcpConfigForActiveSeat(deps)`:
 *   1. resolve the ACTIVE seat id (getActiveSeatId);
 *   2. FULL re-render config.yaml via the existing bootstrap path
 *      (ensureCommandEveRuntimeBootstrap is idempotent + writes config.yaml 0600
 *      — arch §7 recommendation: prefer the full re-render, fewer special cases,
 *      the feeder inside it already reads the vault for the active seat);
 *   3. trigger the backend re-spawn via the existing seatSwitchRuntime restart
 *      hook (restartCommandEveBackendForSeat) so the new agent inherits the fresh
 *      config.yaml.
 *
 * SAFETY GATE (arch §7/§8/§11.5): the feeder inside the re-render is behind
 * `COMMAND_EVE_MCP_VAULT_ENABLED` (default false). With the flag off the re-render
 * emits an EMPTY vetted set → `mcp_servers: {}` (a no-op in practice today — the
 * config.yaml stays byte-identical to what the last bootstrap wrote). Reconcile is
 * therefore SAFE to wire NOW: it changes nothing observable until the flag flips.
 *
 * PURE resolve + INJECTABLE fs/respawn (arch §7). Every side effect is a dep, so
 * this unit-tests with mocks (no Electron, no real backend) and asserts the
 * ORDER: re-render BEFORE respawn, respawn called exactly once.
 */

import { getActiveSeatId as realGetActiveSeatId } from './seatContextCore';
import { restartCommandEveBackendForSeat as realRestart } from './seatSwitchRuntime';

/** The reconcile receipt (arch §7: `{ seatId, connector_count, at }`). */
export interface ReconcileReceipt {
  ok: boolean;
  /** The seat the config.yaml was reconciled for. */
  seat_id: string;
  /** How many vetted MCP connectors ended up in the re-rendered config.yaml. */
  connector_count: number;
  /** ISO timestamp of the reconcile. */
  at: string;
  /** Present on the failure path. */
  reason_code?: string;
}

/** What triggered this reconcile (audit / receipt breadcrumb only). */
export type ReconcileTrigger = 'approve' | 'revoke' | 'seat_switch' | 'manual';

/**
 * Reconcile options. `respawnAfter` defaults to TRUE (approve/revoke: reconcile
 * OWNS the respawn). The SEAT-SWITCH path passes FALSE — applySeatSwitch runs its
 * OWN restartBackend right after prepareEnv, so reconcile there must only REFRESH
 * config.yaml from the vault and NOT respawn (a second respawn would be wasteful
 * and could race the switch's ordered lifecycle). Arch §7: reconcile is "a STEP in
 * applySeatSwitch BEFORE the re-spawn" — the switch's respawn is the single one.
 */
export interface ReconcileOptions {
  trigger?: ReconcileTrigger;
  respawnAfter?: boolean;
}

/**
 * Injectable seams (arch §7 "pure resolve + injectable fs/respawn"). All default
 * to the real cores so production wiring is a single call; tests inject mocks.
 */
export interface ReconcileDeps {
  /** Resolve the active seat id. Defaults to seatContextCore.getActiveSeatId. */
  getActiveSeatId?: () => string;
  /**
   * FULL re-render of config.yaml for the active seat (the fs side effect). MUST
   * write config.yaml 0600 and return how many vetted MCP connectors it emitted.
   * Defaults to the caller-supplied bootstrap re-render (no built-in default —
   * the bootstrap entry needs userDataPath/options the reconcile core does not own;
   * the main-process wiring passes a closure over ensureCommandEveRuntimeBootstrap).
   */
  reRenderConfig: (seatId: string) => Promise<number> | number;
  /** STOP + RE-SPAWN the backend so the new agent reads the fresh config.yaml. */
  respawn?: () => void | Promise<void>;
  /** ISO clock (injectable for deterministic tests). */
  now?: () => Date;
}

/**
 * Re-derive config.yaml from the vault for the ACTIVE seat, then re-spawn the
 * backend. Fail-closed: if the re-render throws we DO NOT respawn (a respawn onto
 * a half-written config is worse than leaving the last-known-good config running);
 * the receipt carries `ok:false` + a reason code.
 *
 * ORDER (asserted by tests): re-render → respawn (respawn AT MOST ONCE, and never
 * when the re-render failed).
 */
export async function reconcileHermesMcpConfigForActiveSeat(
  deps: ReconcileDeps,
  options: ReconcileOptions = {}
): Promise<ReconcileReceipt> {
  const getActiveSeatId = deps.getActiveSeatId ?? realGetActiveSeatId;
  const respawn = deps.respawn ?? realRestart;
  const now = deps.now ?? (() => new Date());
  const respawnAfter = options.respawnAfter ?? true;
  const seatId = getActiveSeatId();

  let connectorCount: number;
  try {
    // 2. FULL re-render (the fs side effect). Idempotent; writes config.yaml 0600.
    connectorCount = await deps.reRenderConfig(seatId);
  } catch (error) {
    return {
      ok: false,
      seat_id: seatId,
      connector_count: 0,
      at: now().toISOString(),
      reason_code: error instanceof Error ? `RECONCILE_RERENDER_FAILED: ${error.message}` : 'RECONCILE_RERENDER_FAILED',
    };
  }

  // 3. Re-spawn so the running agent reads the fresh config.yaml — UNLESS the
  // caller (seat-switch) owns the single respawn itself. Runs ONLY after a
  // successful re-render (never respawn onto a half-written config).
  if (respawnAfter) {
    try {
      await respawn();
    } catch (error) {
      return {
        ok: false,
        seat_id: seatId,
        connector_count: connectorCount,
        at: now().toISOString(),
        reason_code: error instanceof Error ? `RECONCILE_RESPAWN_FAILED: ${error.message}` : 'RECONCILE_RESPAWN_FAILED',
      };
    }
  }

  return { ok: true, seat_id: seatId, connector_count: connectorCount, at: now().toISOString() };
}
