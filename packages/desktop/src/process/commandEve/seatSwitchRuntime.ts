/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE SEAT-SWITCH RUNTIME WIRING (Phase 4 / A5, SLICE B).
 *
 * The seat-switch ORCHESTRATOR (seatSwitchCore.applySeatSwitch) is pure +
 * injectable; the BACKEND re-spawn it needs lives in index.ts (which owns the
 * single `backendManager` instance + getSystemDir + getDataPath). The bridge
 * that exposes the switch over IPC lives in process/bridge/commandEveBridge.ts.
 *
 * This tiny module is the seam that connects the two WITHOUT making the bridge
 * import the Electron entrypoint (a circular/electron-only dependency). index.ts
 * REGISTERS a concrete backend-restart thunk here at boot; the bridge READS it.
 *
 * FAIL-CLOSED: if no restart hook has been registered (e.g. a non-Electron /
 * web-host build, or boot has not reached the registration point), the default
 * thunk THROWS — applySeatSwitch then rolls back to the prior seat rather than
 * silently "switching" without re-spawning the agent (which would leak seat-A's
 * still-running agent into seat-B). A switch is never reported as succeeding
 * unless a real re-spawn ran.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const commandEveBackendRestartLeaseBrand: unique symbol = Symbol('command-eve-backend-restart-lease');

/**
 * An opaque, runtime-validated capability proving that the caller owns the
 * shared backend lifecycle FIFO. The brand is module-private and every use is
 * checked against the active WeakSet, so a cast or a retained expired object
 * cannot bypass serialization.
 */
export type CommandEveBackendRestartLease = Readonly<{
  [commandEveBackendRestartLeaseBrand]: true;
}>;

/** A backend re-spawn thunk: stop the running aioncore, then start it fresh so
 * the new agent inherits the freshly-baked process.env.HERMES_HOME. The active
 * lease is passed explicitly so recursive lifecycle work cannot inherit broad
 * ambient async context. */
export type CommandEveBackendRestart = (lease: CommandEveBackendRestartLease) => Promise<void>;

export type CommandEveStoppedBackendRespawn<T> = Readonly<{
  beforeStop?: () => Promise<void>;
  stop: () => Promise<void>;
  afterStop: () => Promise<T>;
  clearDeadBackendPort: () => void;
}>;

export type CommandEveCrashRecoveryTransaction<T> = Readonly<{
  claimIfCurrent: () => boolean;
  recover: (lease: CommandEveBackendRestartLease) => Promise<T>;
  clearDeadBackendPort: () => void;
  queueWaitTimeoutMs: number;
}>;

let restartHook: CommandEveBackendRestart | null = null;
let restartQueueTail: Promise<void> = Promise.resolve();
const activeRestartLeases = new WeakSet<CommandEveBackendRestartLease>();
const executingRestartLeases = new WeakSet<CommandEveBackendRestartLease>();
// Denial-only ambient context. It never grants authority: the opaque lease is
// still required for every in-reservation restart. Its sole purpose is to turn
// an accidental unleased nested reservation/restart into an immediate error
// instead of queueing behind itself forever.
const restartReservationContext = new AsyncLocalStorage<boolean>();

export type CommandEveBackendRestartReservationOptions = Readonly<{
  /**
   * Bound queue admission only. Once an operation owns the lease it is never
   * expired by a timer: releasing a still-mutating authority transaction would
   * be unsafe. A timed-out waiter is removed before it can mutate anything.
   */
  queueWaitTimeoutMs?: number;
}>;

function enqueueCommandEveBackendLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const queued = restartQueueTail.then(operation);
  // A rejected transaction releases the FIFO for the next caller rather than
  // poisoning the shared lifecycle lane.
  restartQueueTail = queued.then(
    (): void => undefined,
    (): void => undefined
  );
  return queued;
}

function createCommandEveBackendRestartLease(): CommandEveBackendRestartLease {
  return Object.freeze({
    [commandEveBackendRestartLeaseBrand]: true,
  });
}

async function invokeCommandEveBackendRestartHook(lease: CommandEveBackendRestartLease): Promise<void> {
  if (!activeRestartLeases.has(lease)) {
    throw new Error('Command EVE: backend restart lease is invalid or expired.');
  }
  if (executingRestartLeases.has(lease)) {
    throw new Error('Command EVE: recursive backend restart refused; the shared lifecycle lock is non-reentrant.');
  }
  const hook = restartHook;
  if (!hook) {
    throw new Error(
      'Command EVE: no backend-restart hook registered; refusing to switch seats without re-spawning the agent (fail-closed).'
    );
  }
  executingRestartLeases.add(lease);
  try {
    await hook(lease);
  } finally {
    executingRestartLeases.delete(lease);
  }
}

/**
 * Reserve the single backend lifecycle FIFO for one complete authority
 * transaction. Seat switching holds this lease across identity mutation,
 * target preparation, restart and rollback; connector reconciliation holds it
 * across re-render + restart. The lease expires when the callback settles.
 */
export function runCommandEveBackendRestartReservation<T>(
  operation: (lease: CommandEveBackendRestartLease) => Promise<T>,
  options: CommandEveBackendRestartReservationOptions = {}
): Promise<T> {
  if (restartReservationContext.getStore() === true) {
    return Promise.reject(
      new Error(
        'Command EVE: nested backend lifecycle reservation refused; the active reservation must pass its explicit lease.'
      )
    );
  }

  let entered = false;
  let cancelledBeforeEntry = false;
  const queued = enqueueCommandEveBackendLifecycle(async () => {
    if (cancelledBeforeEntry) {
      throw new Error('Command EVE: backend lifecycle reservation timed out before acquiring the shared lane.');
    }
    entered = true;
    const lease = createCommandEveBackendRestartLease();
    activeRestartLeases.add(lease);
    try {
      return await restartReservationContext.run(true, () => operation(lease));
    } finally {
      activeRestartLeases.delete(lease);
      executingRestartLeases.delete(lease);
    }
  });

  const queueWaitTimeoutMs = options.queueWaitTimeoutMs;
  if (!Number.isFinite(queueWaitTimeoutMs) || (queueWaitTimeoutMs ?? 0) <= 0) return queued;

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Never time out an operation after it has entered: it may already own
      // identity, vault or process mutations. Only a not-yet-entered waiter is
      // safe to cancel without weakening serialization.
      if (entered) return;
      cancelledBeforeEntry = true;
      reject(new Error('Command EVE: backend lifecycle reservation timed out before acquiring the shared lane.'));
    }, queueWaitTimeoutMs);
    timeout.unref?.();
    void queued.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

/**
 * Register the concrete backend re-spawn implementation (called once from
 * index.ts after the backendManager + system dirs are available).
 */
export function setCommandEveBackendRestart(hook: CommandEveBackendRestart | null): void {
  restartHook = hook;
}

/** True when a real restart hook is wired (a switch can actually re-spawn). */
export function hasCommandEveBackendRestart(): boolean {
  return restartHook !== null;
}

/**
 * The restart thunk applySeatSwitch injects. FAIL-CLOSED: throws if no hook is
 * registered, so a switch never reports success without a real agent re-spawn.
 */
export async function restartCommandEveBackendForSeat(lease?: CommandEveBackendRestartLease): Promise<void> {
  if (lease) {
    await invokeCommandEveBackendRestartHook(lease);
    return;
  }
  if (restartReservationContext.getStore() === true) {
    throw new Error(
      'Command EVE: unleased backend restart refused inside an active lifecycle reservation; pass the explicit lease.'
    );
  }
  await runCommandEveBackendRestartReservation((ownedLease) => invokeCommandEveBackendRestartHook(ownedLease));
}

/**
 * beforeStop owns admission that must preserve the currently-live backend on
 * failure (including a cold runtime whose deferred bootstrap is unfinished).
 *
 * Once stop() completes, every later failure must make the published port
 * truthful before the seat-switch rollback observes it. The caller keeps the
 * generation check inside clearDeadBackendPort so an older respawn cannot erase
 * a newer live port.
 */
export async function runCommandEveBackendRespawnAfterStop<T>(input: CommandEveStoppedBackendRespawn<T>): Promise<T> {
  await input.beforeStop?.();
  try {
    // stop() may terminate the child successfully and then throw while cleaning
    // its process registry. From this call onward the published port is no
    // longer trustworthy, so the same cleanup boundary owns stop itself.
    await input.stop();
    return await input.afterStop();
  } catch (error) {
    input.clearDeadBackendPort();
    throw error;
  }
}

/**
 * Run crash recovery as a complete Command-EVE-owned lifecycle transaction.
 * The exact crashed child is claimed only after FIFO acquisition. A stale timer
 * therefore cannot start over a newer child, while an admission failure before
 * stop still clears the dead published port. Queue waiting is bounded; active
 * mutations are never expired by a timer.
 */
export async function runCommandEveBackendCrashRecovery<T>(
  input: CommandEveCrashRecoveryTransaction<T>
): Promise<T | undefined> {
  try {
    return await runCommandEveBackendRestartReservation(
      async (restartLease) => {
        if (!input.claimIfCurrent()) return undefined;
        return input.recover(restartLease);
      },
      { queueWaitTimeoutMs: input.queueWaitTimeoutMs }
    );
  } catch (error) {
    if (input.claimIfCurrent()) input.clearDeadBackendPort();
    throw error;
  }
}

/** Test-only: clear the registered hook between tests. */
export function __resetCommandEveBackendRestartForTests(): void {
  restartHook = null;
  restartQueueTail = Promise.resolve();
}
