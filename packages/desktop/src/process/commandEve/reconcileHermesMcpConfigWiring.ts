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
 * `COMMAND_EVE_MCP_VAULT_ENABLED`, now a kill switch rather than an opt-in
 * (1.821.0). While that switch is set the
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
import {
  failCommandEveBackendAuthorityClosed,
  restartCommandEveBackendForSeat,
  runCommandEveBackendRestartReservation,
  type CommandEveBackendRestartLease,
} from './seatSwitchRuntime';
import { getCanonicalDataPath as realGetCanonicalDataPath, getDataPath as realGetDataPath } from '../utils/utils';

/** Injectable seams for the wiring (defaults = the real main-process cores). */
export interface ReconcileWiringDeps {
  /** Resolve the userData root. Defaults to utils.getDataPath. */
  getDataPath?: () => string;
  /** Resolve the trusted real Electron data root behind the macOS CLI alias. */
  getCanonicalDataPath?: () => string;
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

export type ConnectorAuthorityMutation<T> = Readonly<{
  value: T;
  accepted: boolean;
  failureReason?: string;
  rollback: () => boolean | Promise<boolean>;
  rollbackTrigger: 'approve' | 'revoke';
}>;

export type ConnectorAuthorityTransactionOutcome<T> = Readonly<{
  ok: boolean;
  value: T;
  terminal_state: 'committed' | 'mutation_rejected' | 'prior_authority_restored' | 'backend_fail_closed';
  reconcile?: ReconcileReceipt;
  original_error?: string;
  rollback?: Readonly<{
    mutation_restored: boolean;
    reconcile?: ReconcileReceipt;
    error?: string;
    fail_closed_error?: string;
  }>;
}>;

export type ConnectorAuthorityTransactionInput<T, R> = Readonly<{
  trigger: 'approve' | 'revoke';
  mutate: () => ConnectorAuthorityMutation<T> | Promise<ConnectorAuthorityMutation<T>>;
  finalize: (outcome: ConnectorAuthorityTransactionOutcome<T>) => R | Promise<R>;
  reconcileDeps?: ReconcileWiringDeps;
  failClosed?: (lease: CommandEveBackendRestartLease) => void | Promise<void>;
}>;

function sanitizeConnectorAuthorityDiagnostic(value: unknown, fallback: string): string {
  const message = (value instanceof Error ? value.message : typeof value === 'string' ? value : fallback)
    .replace(/\b(keychain:v1:)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(authorization)(\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/\b(api[_-]?key|token|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .trim();
  return (message || fallback).slice(0, 600);
}

function sanitizeConnectorAuthorityReceipt(receipt: ReconcileReceipt): ReconcileReceipt {
  if (!receipt.reason_code) return receipt;
  return {
    ...receipt,
    reason_code: sanitizeConnectorAuthorityDiagnostic(receipt.reason_code, 'CONNECTOR_AUTHORITY_RECONCILE_FAILED'),
  };
}

/**
 * Atomic connector authority transaction. Reservation begins before `mutate`
 * (and therefore before its first seat read/vault write), stays held through
 * primary projection, complete rollback and `finalize`, and is usable by both
 * the real approve surface and a future revoke owner without inventing an IPC.
 */
export function runConnectorAuthorityMutationTransaction<T, R>(
  input: ConnectorAuthorityTransactionInput<T, R>
): Promise<R> {
  return runCommandEveBackendRestartReservation(async (restartLease) => {
    const mutation = await input.mutate();
    if (!mutation.accepted) {
      return input.finalize({
        ok: false,
        value: mutation.value,
        terminal_state: 'mutation_rejected',
        original_error: sanitizeConnectorAuthorityDiagnostic(
          mutation.failureReason,
          'CONNECTOR_AUTHORITY_MUTATION_REJECTED'
        ),
      });
    }

    const primary = sanitizeConnectorAuthorityReceipt(
      await reconcileVaultConfigAfterConnectorChange(input.trigger, input.reconcileDeps, restartLease)
    );
    if (primary.ok) {
      return input.finalize({
        ok: true,
        value: mutation.value,
        terminal_state: 'committed',
        reconcile: primary,
      });
    }

    const originalError = sanitizeConnectorAuthorityDiagnostic(
      primary.reason_code,
      'CONNECTOR_AUTHORITY_PRIMARY_RECONCILE_FAILED'
    );
    let mutationRestored = false;
    let mutationRollbackError: string | undefined;
    try {
      mutationRestored = (await mutation.rollback()) === true;
      if (!mutationRestored) mutationRollbackError = 'CONNECTOR_AUTHORITY_VAULT_ROLLBACK_FAILED';
    } catch (error) {
      mutationRollbackError = sanitizeConnectorAuthorityDiagnostic(error, 'CONNECTOR_AUTHORITY_VAULT_ROLLBACK_FAILED');
    }

    let rollbackReconcile: ReconcileReceipt | undefined;
    let rollbackError = mutationRollbackError;
    if (mutationRestored) {
      rollbackReconcile = sanitizeConnectorAuthorityReceipt(
        await reconcileVaultConfigAfterConnectorChange(mutation.rollbackTrigger, input.reconcileDeps, restartLease)
      );
      if (rollbackReconcile.ok) {
        return input.finalize({
          ok: false,
          value: mutation.value,
          terminal_state: 'prior_authority_restored',
          reconcile: primary,
          original_error: originalError,
          rollback: { mutation_restored: true, reconcile: rollbackReconcile },
        });
      }
      rollbackError = sanitizeConnectorAuthorityDiagnostic(
        rollbackReconcile.reason_code,
        'CONNECTOR_AUTHORITY_ROLLBACK_RECONCILE_FAILED'
      );
    }

    let failClosedError: string | undefined;
    try {
      await (input.failClosed ?? failCommandEveBackendAuthorityClosed)(restartLease);
    } catch (error) {
      // The production hook clears manager/global port truth in `finally`, so a
      // cleanup error is diagnostic, not permission to report the backend live.
      failClosedError = sanitizeConnectorAuthorityDiagnostic(error, 'CONNECTOR_AUTHORITY_FAIL_CLOSED_ERROR');
    }
    return input.finalize({
      ok: false,
      value: mutation.value,
      terminal_state: 'backend_fail_closed',
      reconcile: primary,
      original_error: originalError,
      rollback: {
        mutation_restored: mutationRestored,
        ...(rollbackReconcile ? { reconcile: rollbackReconcile } : {}),
        ...(rollbackError ? { error: rollbackError } : {}),
        ...(failClosedError ? { fail_closed_error: failClosedError } : {}),
      },
    });
  });
}

/**
 * Default full re-render: run the idempotent bootstrap (which writes config.yaml
 * 0600 with the vault-fed `mcp_servers:` block) and return the vetted count. Lazy
 * imports keep the Electron-only bootstrap out of the pure core's import graph.
 * Only reached when the flag is ON.
 */
async function defaultReRenderConfig(getDataPath: () => string, getCanonicalDataPath: () => string): Promise<number> {
  const {
    ensureCommandEveRuntimeBootstrap,
    countVettedMcpServersForSeat,
    buildMcpInvocationResolver,
    resolveCommandEveRuntimeBootstrapPaths,
    DEFAULT_COMMAND_EVE_CAPABILITY_PACK,
  } = await import('./runtimeBootstrapCore');
  const { app } = await import('electron');
  const { getActiveSeatId } = await import('./seatContextCore');
  const userDataPath = getDataPath();
  const canonicalUserDataPath = getCanonicalDataPath();
  const packagedMac = app.isPackaged && process.platform === 'darwin';
  // Re-run the bootstrap in check mode: idempotent, re-writes config.yaml from the
  // (now vault-fed) feeder. This is the arch §7 "full re-render via the existing
  // bootstrap path" recommendation.
  await ensureCommandEveRuntimeBootstrap({
    userDataPath,
    canonicalUserDataPath,
    resourcesPath: process.resourcesPath,
    requireBundledPython: packagedMac,
    mode: 'check',
  });
  // Informational count for the receipt (does not write anything).
  const paths = resolveCommandEveRuntimeBootstrapPaths(
    userDataPath,
    undefined,
    process.platform,
    canonicalUserDataPath
  );
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
  deps: ReconcileWiringDeps = {},
  restartLease?: CommandEveBackendRestartLease
): Promise<ReconcileReceipt> {
  const getDataPath = deps.getDataPath ?? realGetDataPath;
  const getCanonicalDataPath = deps.getCanonicalDataPath ?? realGetCanonicalDataPath;
  // FLAG OFF → NO-OP: do not re-render, do not respawn (byte-identical to today).
  if (!isMcpVaultEnabled()) {
    const { getActiveSeatId } = await import('./seatContextCore');
    const now = deps.now ?? (() => new Date());
    return { ok: true, seat_id: getActiveSeatId(), connector_count: 0, at: now().toISOString() };
  }
  const reconcileUnderLease = (ownedLease: CommandEveBackendRestartLease) =>
    reconcileHermesMcpConfigForActiveSeat(
      {
        reRenderConfig: deps.reRenderConfig ?? ((_seatId) => defaultReRenderConfig(getDataPath, getCanonicalDataPath)),
        respawn: deps.respawn ?? (() => restartCommandEveBackendForSeat(ownedLease)),
        now: deps.now,
      },
      { trigger, respawnAfter: true }
    );
  // A guided connector transaction reserves BEFORE its first seat read and
  // passes that exact lease through vault mutation, render and respawn. Direct
  // callers retain the safe standalone behavior and acquire their own lease.
  if (restartLease) return reconcileUnderLease(restartLease);
  return runCommandEveBackendRestartReservation(reconcileUnderLease);
}

/**
 * Refresh the TARGET seat's config.yaml from the vault DURING a seat switch,
 * WITHOUT respawning (applySeatSwitch owns the single respawn — arch §7). Behind
 * the flag: a NO-OP (no re-render) while COMMAND_EVE_MCP_VAULT_ENABLED is off, so
 * seat switch stays byte-identical to today.
 */
export async function reconcileVaultConfigForSeatSwitch(deps: ReconcileWiringDeps = {}): Promise<ReconcileReceipt> {
  const getDataPath = deps.getDataPath ?? realGetDataPath;
  const getCanonicalDataPath = deps.getCanonicalDataPath ?? realGetCanonicalDataPath;
  if (!isMcpVaultEnabled()) {
    const { getActiveSeatId } = await import('./seatContextCore');
    const now = deps.now ?? (() => new Date());
    return { ok: true, seat_id: getActiveSeatId(), connector_count: 0, at: now().toISOString() };
  }
  return reconcileHermesMcpConfigForActiveSeat(
    {
      reRenderConfig: deps.reRenderConfig ?? ((_seatId) => defaultReRenderConfig(getDataPath, getCanonicalDataPath)),
      respawn: deps.respawn,
      now: deps.now,
    },
    { trigger: 'seat_switch', respawnAfter: false }
  );
}
