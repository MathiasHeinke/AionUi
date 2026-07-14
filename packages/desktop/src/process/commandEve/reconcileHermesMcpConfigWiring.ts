/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RECONCILE WIRING (S5 phase 2, arch §7) — the main-process seam that binds the
 * PURE reconcileHermesMcpConfigCore to the concrete `ensureCommandEveRuntimeBootstrap`
 * re-render + the seatSwitchRuntime respawn hook. It exists so the bridge's
 * approve / revoke / seat-switch call-sites share ONE flag-gated entry instead of
 * each re-deriving the closure.
 *
 * SAFETY GATE (arch §7/§8/§11.5): the whole re-render is behind
 * `COMMAND_EVE_MCP_VAULT_ENABLED` (default false). While the flag is off the
 * `reRenderConfig` closure is a NO-OP that returns 0 — it does NOT run the (heavy)
 * bootstrap, so seat-switch / approve / revoke behavior stays BYTE-IDENTICAL to
 * today (no extra config.yaml write, no behavior change). Only when the flag flips
 * (the separate GATE-NULL slice) does the closure actually re-render config.yaml
 * from the vault.
 *
 * getDataPath is injected (defaults to the real one) so this is unit-testable.
 */

import { reconcileHermesMcpConfigForActiveSeat, type ReconcileReceipt } from './reconcileHermesMcpConfigCore';
import { isMcpVaultEnabled } from './mcpVaultFlagCore';
import { getDataPath as realGetDataPath } from '../utils/utils';

/** Injectable seams for the wiring (defaults = the real main-process cores). */
export interface ReconcileWiringDeps {
  /** Resolve the userData root. Defaults to utils.getDataPath. */
  getDataPath?: () => string;
  /**
   * FULL config.yaml re-render for a seat (the fs side effect). Defaults to a
   * closure over `ensureCommandEveRuntimeBootstrap` in check/auto mode. Returns the
   * emitted vetted-connector count. ONLY invoked when the flag is ON.
   */
  reRenderConfig?: (seatId: string) => Promise<number>;
  /** STOP + RE-SPAWN the backend. Defaults to seatSwitchRuntime.restartCommandEveBackendForSeat. */
  respawn?: () => void | Promise<void>;
  /** Test clock. */
  now?: () => Date;
}

/**
 * Default full re-render: run the idempotent bootstrap (which writes config.yaml
 * 0600 with the vault-fed `mcp_servers:` block) and return the vetted count. Lazy
 * imports keep the Electron-only bootstrap out of the pure core's import graph.
 * Only reached when the flag is ON.
 */
async function defaultReRenderConfig(getDataPath: () => string): Promise<number> {
  const {
    ensureCommandEveRuntimeBootstrap,
    countVettedMcpServersForSeat,
    buildMcpInvocationResolver,
    resolveCommandEveRuntimeBootstrapPaths,
    DEFAULT_COMMAND_EVE_CAPABILITY_PACK,
  } = await import('./runtimeBootstrapCore');
  const { getActiveSeatId } = await import('./seatContextCore');
  const userDataPath = getDataPath();
  // Re-run the bootstrap in check mode: idempotent, re-writes config.yaml from the
  // (now vault-fed) feeder. This is the arch §7 "full re-render via the existing
  // bootstrap path" recommendation.
  await ensureCommandEveRuntimeBootstrap({ userDataPath, mode: 'check' });
  // Informational count for the receipt (does not write anything).
  const paths = resolveCommandEveRuntimeBootstrapPaths(userDataPath);
  return countVettedMcpServersForSeat(DEFAULT_COMMAND_EVE_CAPABILITY_PACK, getActiveSeatId(), {
    userDataPath: paths.userDataPath,
    configRoot: paths.hermesRoot,
    mcpInvocationFor: buildMcpInvocationResolver({}),
  });
}

/**
 * Reconcile the active seat's config.yaml from the vault + respawn the backend.
 * Used on connector APPROVE and REVOKE (arch §7). Behind the flag: a NO-OP receipt
 * (connector_count 0, no respawn) while COMMAND_EVE_MCP_VAULT_ENABLED is off.
 */
export async function reconcileVaultConfigAfterConnectorChange(
  trigger: 'approve' | 'revoke',
  deps: ReconcileWiringDeps = {}
): Promise<ReconcileReceipt> {
  const getDataPath = deps.getDataPath ?? realGetDataPath;
  // FLAG OFF → NO-OP: do not re-render, do not respawn (byte-identical to today).
  if (!isMcpVaultEnabled()) {
    const { getActiveSeatId } = await import('./seatContextCore');
    const now = deps.now ?? (() => new Date());
    return { ok: true, seat_id: getActiveSeatId(), connector_count: 0, at: now().toISOString() };
  }
  return reconcileHermesMcpConfigForActiveSeat(
    {
      reRenderConfig: deps.reRenderConfig ?? ((_seatId) => defaultReRenderConfig(getDataPath)),
      respawn: deps.respawn,
      now: deps.now,
    },
    { trigger, respawnAfter: true }
  );
}

/**
 * Refresh the TARGET seat's config.yaml from the vault DURING a seat switch,
 * WITHOUT respawning (applySeatSwitch owns the single respawn — arch §7). Behind
 * the flag: a NO-OP (no re-render) while COMMAND_EVE_MCP_VAULT_ENABLED is off, so
 * seat switch stays byte-identical to today.
 */
export async function reconcileVaultConfigForSeatSwitch(deps: ReconcileWiringDeps = {}): Promise<ReconcileReceipt> {
  const getDataPath = deps.getDataPath ?? realGetDataPath;
  if (!isMcpVaultEnabled()) {
    const { getActiveSeatId } = await import('./seatContextCore');
    const now = deps.now ?? (() => new Date());
    return { ok: true, seat_id: getActiveSeatId(), connector_count: 0, at: now().toISOString() };
  }
  return reconcileHermesMcpConfigForActiveSeat(
    {
      reRenderConfig: deps.reRenderConfig ?? ((_seatId) => defaultReRenderConfig(getDataPath)),
      respawn: deps.respawn,
      now: deps.now,
    },
    { trigger: 'seat_switch', respawnAfter: false }
  );
}
