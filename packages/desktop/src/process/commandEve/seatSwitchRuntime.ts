/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

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

/** A backend re-spawn thunk: stop the running aioncore, then start it fresh so
 * the new agent inherits the freshly-baked process.env.HERMES_HOME. */
export type CommandEveBackendRestart = () => Promise<void>;

export type CommandEveStoppedBackendRespawn<T> = Readonly<{
  beforeStop?: () => Promise<void>;
  stop: () => Promise<void>;
  afterStop: () => Promise<T>;
  clearDeadBackendPort: () => void;
}>;

let restartHook: CommandEveBackendRestart | null = null;
let restartQueueTail: Promise<void> = Promise.resolve();
const restartExecutionContext = new AsyncLocalStorage<boolean>();

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
export async function restartCommandEveBackendForSeat(): Promise<void> {
  if (restartExecutionContext.getStore() === true) {
    throw new Error('Command EVE: recursive backend restart refused; the shared lifecycle lock is non-reentrant.');
  }
  const queuedRestart = restartQueueTail.then(async () => {
    const hook = restartHook;
    if (!hook) {
      throw new Error(
        'Command EVE: no backend-restart hook registered; refusing to switch seats without re-spawning the agent (fail-closed).'
      );
    }
    await restartExecutionContext.run(true, hook);
  });
  // A rejected transaction must release the FIFO for the next caller rather
  // than poisoning the shared lifecycle lane.
  restartQueueTail = queuedRestart.catch(() => {});
  await queuedRestart;
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

/** Test-only: clear the registered hook between tests. */
export function __resetCommandEveBackendRestartForTests(): void {
  restartHook = null;
  restartQueueTail = Promise.resolve();
}
