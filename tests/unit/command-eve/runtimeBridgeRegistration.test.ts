import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  __resetCommandEveBackendRestartForTests,
  failCommandEveBackendAuthorityClosed,
  restartCommandEveBackendForSeat,
  runCommandEveBackendCrashRecovery,
  runCommandEveBackendRespawnAfterStop,
  runCommandEveBackendRestartReservation as runCommandEveBackendRestartReservationWithOptions,
  setCommandEveBackendAuthorityFailClosed,
  setCommandEveBackendRestart,
  type CommandEveBackendRestartLease,
} from '@/process/commandEve/seatSwitchRuntime';
import {
  __resetActiveSeatForTests,
  getActiveSeatId,
  resolveActiveSeatScopedStorageRoots,
  setActiveSeatId,
} from '@/process/commandEve/seatContextCore';
import { resolveCommandEveRuntimeBootstrapPaths } from '@/process/commandEve/runtimeBootstrapCore';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  __resetCommandEveBackendRestartForTests();
  __resetActiveSeatForTests();
});

const AUTHORITY_TEST_USER_DATA = '/tmp/command-eve-backend-authority-test';
const AUTHORITY_SEAT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUTHORITY_SEAT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function runCommandEveBackendRestartReservation<T>(
  operation: (lease: CommandEveBackendRestartLease) => Promise<T>
): Promise<T> {
  return runCommandEveBackendRestartReservationWithOptions(operation, { queueWaitTimeoutMs: 90_000 });
}

describe('Command EVE runtime bridge registration', () => {
  it('pins packaged license-key resolution to Electron signed resources unconditionally', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const markerStart = source.indexOf('// ============ Command EVE license-key resolution');
    const markerEnd = source.indexOf('// ============ Single Instance Lock', markerStart);
    const markerSource = source.slice(markerStart, markerEnd);

    expect(markerSource).toContain('if (app.isPackaged) {');
    expect(markerSource).toContain('process.env.COMMAND_EVE_RESOURCES_PATH = process.resourcesPath;');
    expect(markerSource).not.toContain('app.isPackaged && !process.env.COMMAND_EVE_RESOURCES_PATH');
  });

  it('registers every renderer-declared runtime provider in the active app entrypoint', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    for (const provider of [
      'runtimeStatus',
      'ensureAssistant',
      'ensureLocalModelTier',
      'warmLocalModel',
      'evaluateGateDecision',
    ]) {
      expect(source).toContain(`ipcBridge.commandEve.${provider}.provider`);
    }
  });

  it('registers and navigation-guards browser guests in MAIN before renderer crash recovery', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const didAttach = source.indexOf("mainWindow.webContents.on('did-attach-webview'");
    const rendererGone = source.indexOf("mainWindow.webContents.on('render-process-gone'");

    expect(didAttach).toBeGreaterThan(-1);
    const guestLifecycle = source.slice(didAttach, rendererGone);
    expect(guestLifecycle).toContain('getCdpBridgeHandle()?.registerGuest(guest)');
    expect(guestLifecycle).toContain("guest.on('will-navigate'");
    expect(guestLifecycle).toContain("guest.on('will-redirect'");
    expect(guestLifecycle).toContain("guest.setWindowOpenHandler(() => ({ action: 'deny' }))");
    expect(source.slice(rendererGone, rendererGone + 800)).toContain(
      "getCdpBridgeHandle()?.detachActiveTarget('main renderer process exited')"
    );
  });

  it('decides ABI recovery before AionCore starts while compatible warm boots remain deferred', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const bootstrapOptions = source.indexOf('const bootstrapOptions =');
    const deferredHelper = source.indexOf('const deferRemainingRuntimeBootstrap =');
    const automaticWait = source.indexOf('let automaticRuntimeRepairReason:');
    const earlyFailClosed = source.indexOf('commandEveAutomaticRuntimeRepairRequired = app.isPackaged;');
    const ancestryGate = source.indexOf('!commandEveRuntimeManagedAncestryIsSafe({', automaticWait);
    const shimStart = source.indexOf('const shimUrl = rememberCommandEveOllamaShimUrl(', automaticWait);
    const waitDecision = source.indexOf('const mustWaitForRuntimeBootstrap =');
    const blockingBootstrapStart = source.indexOf(
      'const receipt = await ensureCommandEveRuntimeBootstrap({',
      waitDecision
    );
    const deferredBootstrapStart = source.indexOf(
      'void ensureCommandEveRuntimeBootstrap(bootstrapOptions)',
      deferredHelper
    );
    const backendStart = source.indexOf('// Start aioncore only after initializeProcess()', waitDecision);

    expect(earlyFailClosed).toBeGreaterThan(-1);
    expect(automaticWait).toBeGreaterThan(earlyFailClosed);
    expect(ancestryGate).toBeGreaterThan(automaticWait);
    expect(shimStart).toBeGreaterThan(ancestryGate);
    expect(bootstrapOptions).toBeGreaterThan(shimStart);
    expect(deferredHelper).toBeGreaterThan(bootstrapOptions);
    expect(deferredBootstrapStart).toBeGreaterThan(deferredHelper);
    expect(waitDecision).toBeGreaterThan(-1);
    expect(waitDecision).toBeGreaterThan(bootstrapOptions);
    expect(blockingBootstrapStart).toBeGreaterThan(waitDecision);
    expect(backendStart).toBeGreaterThan(blockingBootstrapStart);
    expect(source.slice(automaticWait, backendStart)).toContain('commandEveAutomaticRuntimeRepairRequired ||');
    expect(source.slice(automaticWait, backendStart)).toContain('canonicalUserDataPath: canonicalRuntimeUserDataPath');
    expect(source.slice(earlyFailClosed, automaticWait)).toContain(
      "const requirePackagedHermesRuntime = app.isPackaged && process.platform === 'darwin'"
    );
    expect(source.slice(automaticWait, backendStart)).toContain('requireBundledPython: requirePackagedHermesRuntime');
    expect(source.slice(bootstrapOptions, waitDecision)).toContain(
      'requireBundledPython: requirePackagedHermesRuntime'
    );
    expect(source.slice(waitDecision, backendStart)).toContain(
      'stopAfterHermesRuntimeReady: commandEveAutomaticRuntimeRepairRequired'
    );
    expect(source.slice(waitDecision, backendStart)).toContain('deferRemainingRuntimeBootstrap(true)');
    expect(source.slice(automaticWait, backendStart)).toContain('inspectCommandEveRuntimeBackendAdmission');
    expect(source.slice(automaticWait, backendStart)).toContain('throw new Error(');
    expect(source.slice(automaticWait, waitDecision)).toContain(
      "automaticRuntimeRepairReason = 'python_venv_recovery'"
    );
    expect(source.slice(backendStart - 500, backendStart)).toContain(
      '!commandEveOllamaShimUrl || commandEveAutomaticRuntimeRepairRequired'
    );
  });

  it('repairs and re-proves the active seat runtime before every packaged macOS respawn', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const assignment = source.indexOf('ensureCommandEveRuntimeAdmissionForRespawn = requirePackagedHermesRuntime');
    const initialAdmission = source.indexOf('await ensureCommandEveRuntimeAdmissionForRespawn(true)', assignment);
    const initialRepair = source.indexOf('repairCommandEveAssistantStorage', initialAdmission);
    const initialRecheck = source.indexOf('recheckCommandEveRuntimeBeforeInitialStart?.();', initialRepair);
    const initialStart = source.indexOf('const backendPort = await backendManager.start(', initialAdmission);
    const hook = source.indexOf('setCommandEveBackendRestart(async (restartLease) => {');
    const admission = source.indexOf('await ensureCommandEveRuntimeAdmissionForRespawn(false)', hook);
    const stop = source.indexOf('stop: () => backendManager.stop()', hook);
    const awaitGapRecheck = source.indexOf('recheckCommandEveRuntimeBeforeRespawn?.();', admission);
    const start = source.indexOf('return backendManager.start(', admission);

    expect(assignment).toBeGreaterThan(-1);
    expect(source.slice(assignment, hook)).toContain(
      'ensureCommandEveRuntimeBackendAdmission(bootstrapOptions, process.env, {'
    );
    expect(source.slice(assignment, hook)).toContain('allowFullBootstrapRepair');
    expect(initialAdmission).toBeGreaterThan(assignment);
    expect(initialRepair).toBeGreaterThan(initialAdmission);
    expect(initialRecheck).toBeGreaterThan(initialRepair);
    expect(initialStart).toBeGreaterThan(initialAdmission);
    expect(initialStart).toBeGreaterThan(initialRecheck);
    expect(source.slice(initialRecheck, initialStart)).not.toContain('await ');
    expect(source.slice(assignment, initialAdmission)).toContain('commandEvePackagedRuntimeExistedAtBoot');
    expect(hook).toBeGreaterThan(assignment);
    expect(admission).toBeGreaterThan(hook);
    expect(stop).toBeGreaterThan(admission);
    expect(awaitGapRecheck).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(admission);
    expect(start).toBeGreaterThan(awaitGapRecheck);
    expect(source.slice(awaitGapRecheck, start)).not.toContain('await ');
    expect(source.slice(admission, start)).toContain('Dev/Windows preserve the existing lightweight env bake.');
    expect(source).toContain('restartAfterCrash: runCommandEveCrashRestartUnderReservation');
    expect(source).toContain('runCommandEveBackendCrashRecovery({');
    expect(source).toContain('await restartCommandEveBackendForSeat(restartLease);');
    expect(source).toContain('queueWaitTimeoutMs: COMMAND_EVE_CRASH_RECOVERY_QUEUE_WAIT_MS');
    expect(source.match(/commandEveBackendStartOptions/g)).toHaveLength(3);
  });

  it('reserves the shared lifecycle before the seat authority holder can move', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/process/bridge/commandEveBridge.ts'),
      'utf8'
    );
    const switchProvider = source.indexOf(".buildProvider('command-eve.switch-seat')");
    const reservation = source.indexOf('runCommandEveBackendRestartReservation(', switchProvider);
    const explicitLease = source.indexOf('async (restartLease) => {', reservation);
    const authorityMutation = source.indexOf('applySeatSwitch(', reservation);
    const leasedRestart = source.indexOf('restartCommandEveBackendForSeat(restartLease)', authorityMutation);
    const terminalRefresh = source.indexOf('await refreshBrowserWorkbenchContextBestEffort();', leasedRestart);
    const reservationEnd = source.indexOf('return switchResult;', terminalRefresh);

    expect(switchProvider).toBeGreaterThan(-1);
    expect(reservation).toBeGreaterThan(switchProvider);
    expect(explicitLease).toBeGreaterThan(reservation);
    expect(explicitLease).toBeLessThan(authorityMutation);
    expect(authorityMutation).toBeGreaterThan(reservation);
    expect(leasedRestart).toBeGreaterThan(authorityMutation);
    expect(terminalRefresh).toBeGreaterThan(leasedRestart);
    expect(reservationEnd).toBeGreaterThan(terminalRefresh);
  });

  it('routes guided approval through the behavior-tested atomic authority transaction seam', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/process/bridge/commandEveBridge.ts'),
      'utf8'
    );
    const provider = source.indexOf(".buildProvider('command-eve.guided-auth-setup')");
    const inFlightBlock = source.indexOf('if (commandEveSwitchSeatInFlight) {', provider);
    const transaction = source.indexOf('return await runConnectorAuthorityMutationTransaction({', provider);
    const canonicalRequest = source.indexOf('resolveCanonicalConnectorId(request?.connectorId)', transaction);
    const exactManifest = source.indexOf('entry.id === connectorId', canonicalRequest);
    const firstSeatRead = source.indexOf("const seatId = scope === 'seat' ? getActiveSeatId() : undefined;", provider);
    const vaultMutation = source.indexOf('const result = runGuidedApiKeySetup({', provider);
    const byteSnapshot = source.indexOf('readVaultRecordFileSnapshot(vaultDir, connectorId)', provider);
    const byteRollback = source.indexOf('restoreVaultRecordFileSnapshot(', vaultMutation);
    const responseTerminal = source.indexOf('authority_transaction:', byteRollback);
    const providerEnd = source.indexOf(".buildProvider('command-eve.skill-library')", responseTerminal);

    expect(provider).toBeGreaterThan(-1);
    expect(providerEnd).toBeGreaterThan(responseTerminal);
    expect(inFlightBlock).toBeGreaterThan(provider);
    expect(transaction).toBeGreaterThan(inFlightBlock);
    expect(canonicalRequest).toBeGreaterThan(transaction);
    expect(exactManifest).toBeGreaterThan(canonicalRequest);
    expect(firstSeatRead).toBeGreaterThan(transaction);
    expect(byteSnapshot).toBeGreaterThan(firstSeatRead);
    expect(vaultMutation).toBeGreaterThan(byteSnapshot);
    expect(byteRollback).toBeGreaterThan(vaultMutation);
    expect(responseTerminal).toBeGreaterThan(byteRollback);
    expect(source.slice(provider, providerEnd)).toContain(
      "sanitizeConnectorAuthorityDiagnostic(error, 'Command EVE guided auth setup bridge failed.')"
    );
  });

  it('preserves the live port and never stops or starts when pre-stop admission fails', async () => {
    const stop = vi.fn(async () => {});
    const admission = vi.fn(async () => {
      throw new Error('COMMAND_EVE_RUNTIME_BACKEND_INADMISSIBLE: python_abi_unproven');
    });
    const start = vi.fn(async () => 3210);
    const clearDeadBackendPort = vi.fn();

    await expect(
      runCommandEveBackendRespawnAfterStop({
        beforeStop: admission,
        stop,
        clearDeadBackendPort,
        afterStop: start,
      })
    ).rejects.toThrow('COMMAND_EVE_RUNTIME_BACKEND_INADMISSIBLE: python_abi_unproven');

    expect(stop).not.toHaveBeenCalled();
    expect(clearDeadBackendPort).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('clears the dead port when the await-gap recheck detects a launcher mutation', async () => {
    const stop = vi.fn(async () => {});
    const start = vi.fn(async () => 3210);
    const clearDeadBackendPort = vi.fn();
    let mutableArtifactsExact = true;

    await expect(
      runCommandEveBackendRespawnAfterStop({
        stop,
        clearDeadBackendPort,
        afterStop: async () => {
          await Promise.resolve();
          mutableArtifactsExact = false;
          if (!mutableArtifactsExact) {
            throw new Error('COMMAND_EVE_RUNTIME_MUTABLE_ARTIFACTS_CHANGED_BEFORE_START');
          }
          return start();
        },
      })
    ).rejects.toThrow('COMMAND_EVE_RUNTIME_MUTABLE_ARTIFACTS_CHANGED_BEFORE_START');

    expect(stop).toHaveBeenCalledOnce();
    expect(clearDeadBackendPort).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it('clears the dead port when backend start fails after a successful admission', async () => {
    const start = vi.fn(async () => {
      throw new Error('backend spawn failed');
    });
    const clearDeadBackendPort = vi.fn();

    await expect(
      runCommandEveBackendRespawnAfterStop({
        beforeStop: async () => {},
        stop: async () => {},
        clearDeadBackendPort,
        afterStop: start,
      })
    ).rejects.toThrow('backend spawn failed');

    expect(clearDeadBackendPort).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it('serializes concurrent shared-hook callers without overlapping child ownership or port publication', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let markFirstStopped!: () => void;
    let markSecondStopped!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBarrier = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const firstStopped = new Promise<void>((resolve) => {
      markFirstStopped = resolve;
    });
    const secondStopped = new Promise<void>((resolve) => {
      markSecondStopped = resolve;
    });
    const events: string[] = [];
    let call = 0;
    let childProcess: string | null = 'child-0';
    let publishedPort = 4100;
    setCommandEveBackendRestart(async () => {
      const id = ++call;
      events.push(`stop:${id}:${childProcess}`);
      childProcess = null;
      if (id === 1) {
        markFirstStopped();
        await firstBarrier;
      } else {
        markSecondStopped();
        await secondBarrier;
      }
      childProcess = `child-${id}`;
      publishedPort = 4100 + id;
      events.push(`publish:${id}:${publishedPort}`);
    });

    const first = runCommandEveBackendRestartReservation((restartLease) =>
      restartCommandEveBackendForSeat(restartLease)
    );
    await firstStopped;
    const second = runCommandEveBackendRestartReservation((restartLease) =>
      restartCommandEveBackendForSeat(restartLease)
    );
    await Promise.resolve();
    expect(events).toEqual(['stop:1:child-0']);
    expect(childProcess).toBeNull();
    expect(publishedPort).toBe(4100);

    releaseFirst();
    await first;
    await secondStopped;
    expect(events).toEqual(['stop:1:child-0', 'publish:1:4101', 'stop:2:child-1']);
    expect(childProcess).toBeNull();

    releaseSecond();
    await second;
    expect(events).toEqual(['stop:1:child-0', 'publish:1:4101', 'stop:2:child-1', 'publish:2:4102']);
    expect(childProcess).toBe('child-2');
    expect(publishedPort).toBe(4102);
  });

  it('drains an older connector before authority mutation and excludes later connector work until switch terminal', async () => {
    type AuthoritySnapshot = Readonly<{
      operation: string;
      seatId: string;
      hermesHome: string;
      managedSkillsRoot: string;
      backendDataDir: string;
      kanbanDb: string;
    }>;
    const snapshots: AuthoritySnapshot[] = [];
    const events: string[] = [];
    let publishedPort = 4400;
    let markOldConnectorEntered!: () => void;
    let releaseOldConnector!: () => void;
    let markSwitchEntered!: () => void;
    let releaseSwitchPreparation!: () => void;
    const oldConnectorEntered = new Promise<void>((resolve) => {
      markOldConnectorEntered = resolve;
    });
    const oldConnectorGate = new Promise<void>((resolve) => {
      releaseOldConnector = resolve;
    });
    const switchEntered = new Promise<void>((resolve) => {
      markSwitchEntered = resolve;
    });
    const switchPreparationGate = new Promise<void>((resolve) => {
      releaseSwitchPreparation = resolve;
    });
    const capture = (operation: string): AuthoritySnapshot => {
      const seatId = getActiveSeatId();
      const runtime = resolveCommandEveRuntimeBootstrapPaths(AUTHORITY_TEST_USER_DATA);
      const storage = resolveActiveSeatScopedStorageRoots(AUTHORITY_TEST_USER_DATA, AUTHORITY_TEST_USER_DATA, seatId);
      const snapshot = {
        operation,
        seatId,
        hermesHome: runtime.hermesHome,
        managedSkillsRoot: runtime.managedSkillsRoot,
        backendDataDir: storage.workRoot,
        kanbanDb: path.join(runtime.hermesHome, 'kanban.db'),
      };
      snapshots.push(snapshot);
      return snapshot;
    };

    setActiveSeatId(AUTHORITY_SEAT_A);
    setCommandEveBackendRestart(async () => {
      const snapshot = capture(`restart:${snapshots.length}`);
      publishedPort += 1;
      events.push(`publish:${snapshot.seatId}:${publishedPort}`);
    });

    const oldConnector = runCommandEveBackendRestartReservation(async (restartLease) => {
      events.push('connector-old:enter');
      capture('connector-old:render');
      markOldConnectorEntered();
      await oldConnectorGate;
      await restartCommandEveBackendForSeat(restartLease);
      events.push('connector-old:terminal');
    });
    await oldConnectorEntered;

    const switchTransaction = runCommandEveBackendRestartReservation(async (restartLease) => {
      events.push('switch:enter');
      setActiveSeatId(AUTHORITY_SEAT_B);
      capture('switch:prepare');
      markSwitchEntered();
      await switchPreparationGate;
      await restartCommandEveBackendForSeat(restartLease);
      events.push('switch:terminal');
    });
    const laterConnector = runCommandEveBackendRestartReservation(async (restartLease) => {
      events.push('connector-later:enter');
      capture('connector-later:render');
      await restartCommandEveBackendForSeat(restartLease);
      events.push('connector-later:terminal');
    });

    await Promise.resolve();
    expect(getActiveSeatId()).toBe(AUTHORITY_SEAT_A);
    expect(events).toEqual(['connector-old:enter']);

    releaseOldConnector();
    await oldConnector;
    await switchEntered;
    expect(getActiveSeatId()).toBe(AUTHORITY_SEAT_B);
    expect(events).not.toContain('connector-later:enter');

    releaseSwitchPreparation();
    await Promise.all([switchTransaction, laterConnector]);
    expect(events).toEqual([
      'connector-old:enter',
      `publish:${AUTHORITY_SEAT_A}:4401`,
      'connector-old:terminal',
      'switch:enter',
      `publish:${AUTHORITY_SEAT_B}:4402`,
      'switch:terminal',
      'connector-later:enter',
      `publish:${AUTHORITY_SEAT_B}:4403`,
      'connector-later:terminal',
    ]);
    expect(publishedPort).toBe(4403);

    for (const snapshot of snapshots) {
      expect(snapshot.hermesHome).toContain(snapshot.seatId);
      expect(snapshot.managedSkillsRoot).toContain(snapshot.seatId);
      expect(snapshot.backendDataDir).toContain(snapshot.seatId);
      expect(snapshot.kanbanDb).toContain(snapshot.seatId);
    }
  });

  it('holds the lease through failed target restart, rollback identity and rollback restart terminal', async () => {
    const events: string[] = [];
    let restartAttempt = 0;
    let publishedPort: number | undefined = 4490;
    let markRollbackRestartEntered!: () => void;
    let releaseRollbackRestart!: () => void;
    const rollbackRestartEntered = new Promise<void>((resolve) => {
      markRollbackRestartEntered = resolve;
    });
    const rollbackRestartGate = new Promise<void>((resolve) => {
      releaseRollbackRestart = resolve;
    });

    setActiveSeatId(AUTHORITY_SEAT_A);
    setCommandEveBackendRestart(async () => {
      restartAttempt += 1;
      events.push(`restart:${restartAttempt}:${getActiveSeatId()}`);
      if (restartAttempt === 1) {
        publishedPort = undefined;
        throw new Error('target restart failed after destructive stop');
      }
      markRollbackRestartEntered();
      await rollbackRestartGate;
      publishedPort = 4492;
      events.push(`publish:${getActiveSeatId()}:${publishedPort}`);
    });

    const switchTransaction = runCommandEveBackendRestartReservation(async (restartLease) => {
      setActiveSeatId(AUTHORITY_SEAT_B);
      try {
        await restartCommandEveBackendForSeat(restartLease);
      } catch {
        setActiveSeatId(AUTHORITY_SEAT_A);
        await restartCommandEveBackendForSeat(restartLease);
      }
      events.push('switch:terminal');
    });
    const laterConnector = runCommandEveBackendRestartReservation(async () => {
      events.push(`connector-later:${getActiveSeatId()}:${String(publishedPort)}`);
    });

    await rollbackRestartEntered;
    expect(getActiveSeatId()).toBe(AUTHORITY_SEAT_A);
    expect(publishedPort).toBeUndefined();
    expect(events).not.toContain(`connector-later:${AUTHORITY_SEAT_A}:undefined`);

    releaseRollbackRestart();
    await Promise.all([switchTransaction, laterConnector]);
    expect(events).toEqual([
      `restart:1:${AUTHORITY_SEAT_B}`,
      `restart:2:${AUTHORITY_SEAT_A}`,
      `publish:${AUTHORITY_SEAT_A}:4492`,
      'switch:terminal',
      `connector-later:${AUTHORITY_SEAT_A}:4492`,
    ]);
  });

  it('queues a crash timer behind seat preparation and suppresses its stale child after target start', async () => {
    const events: string[] = [];
    const crashedChild = { id: 'crashed-seat-a' };
    let currentChild = crashedChild;
    let markSwitchPreparationEntered!: () => void;
    let releaseSwitchPreparation!: () => void;
    const switchPreparationEntered = new Promise<void>((resolve) => {
      markSwitchPreparationEntered = resolve;
    });
    const switchPreparationGate = new Promise<void>((resolve) => {
      releaseSwitchPreparation = resolve;
    });

    setActiveSeatId(AUTHORITY_SEAT_A);
    setCommandEveBackendRestart(async () => {
      currentChild = { id: `live-${getActiveSeatId()}` };
      events.push(`switch:publish:${currentChild.id}`);
    });
    const switchTransaction = runCommandEveBackendRestartReservation(async (restartLease) => {
      setActiveSeatId(AUTHORITY_SEAT_B);
      events.push('switch:prepare');
      markSwitchPreparationEntered();
      await switchPreparationGate;
      await restartCommandEveBackendForSeat(restartLease);
      events.push('switch:terminal');
    });
    await switchPreparationEntered;

    const crashTimer = runCommandEveBackendCrashRecovery({
      claimIfCurrent: () => {
        events.push('crash-owner:enter');
        if (currentChild !== crashedChild) {
          events.push('crash-owner:suppressed-stale-child');
          return false;
        }
        return true;
      },
      recover: async () => {
        events.push('crash-owner:unexpected-start');
      },
      clearDeadBackendPort: () => {
        events.push('crash-owner:clear-port');
      },
      queueWaitTimeoutMs: 30_000,
    });
    await Promise.resolve();
    expect(events).toEqual(['switch:prepare']);

    releaseSwitchPreparation();
    await Promise.all([switchTransaction, crashTimer]);
    expect(events).toEqual([
      'switch:prepare',
      `switch:publish:live-${AUTHORITY_SEAT_B}`,
      'switch:terminal',
      'crash-owner:enter',
      'crash-owner:suppressed-stale-child',
    ]);
    expect(currentChild.id).toBe(`live-${AUTHORITY_SEAT_B}`);
  });

  it('rejects a recursive restart instead of deadlocking the shared FIFO', async () => {
    setCommandEveBackendRestart(async (restartLease) => {
      await restartCommandEveBackendForSeat(restartLease);
    });

    await expect(
      runCommandEveBackendRestartReservation((restartLease) => restartCommandEveBackendForSeat(restartLease))
    ).rejects.toThrow('recursive backend restart refused; the shared lifecycle lock is non-reentrant');
  });

  it('lets a child exit callback acquire fresh crash authority after its spawn reservation terminates', async () => {
    const events: string[] = [];
    let settleCrash!: (value: number | undefined) => void;
    let rejectCrash!: (error: unknown) => void;
    const crashTerminal = new Promise<number | undefined>((resolve, reject) => {
      settleCrash = resolve;
      rejectCrash = reject;
    });
    setCommandEveBackendRestart(async () => {
      events.push('start:spawned');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 25)'], { stdio: 'ignore' });
      child.once('exit', () => {
        void runCommandEveBackendCrashRecovery({
          claimIfCurrent: () => {
            events.push('crash:claimed');
            return true;
          },
          recover: async () => {
            events.push('crash:recovered');
            return 4701;
          },
          clearDeadBackendPort: () => events.push('crash:cleared'),
          queueWaitTimeoutMs: 1_000,
        }).then(settleCrash, rejectCrash);
      });
    });

    await runCommandEveBackendRestartReservation(async (restartLease) => {
      await restartCommandEveBackendForSeat(restartLease);
      events.push('start:reservation-terminal');
    });
    await expect(crashTerminal).resolves.toBe(4701);
    expect(events).toEqual(['start:spawned', 'start:reservation-terminal', 'crash:claimed', 'crash:recovered']);

    const runtimeSource = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/process/commandEve/seatSwitchRuntime.ts'),
      'utf8'
    );
    expect(runtimeSource).not.toContain('AsyncLocalStorage');
    expect(runtimeSource).not.toContain('restartReservationContext');
  });

  it('uses explicit leases at every production restart callsite inside the shared lifecycle lane', () => {
    const root = path.resolve(__dirname, '../../../packages/desktop/src');
    const sources = [
      path.join(root, 'index.ts'),
      path.join(root, 'process/bridge/commandEveBridge.ts'),
      path.join(root, 'process/commandEve/reconcileHermesMcpConfigWiring.ts'),
      path.join(root, 'process/commandEve/seatSwitchRuntime.ts'),
    ].map((file) => fs.readFileSync(file, 'utf8'));
    const combined = sources.join('\n');

    expect(combined).not.toMatch(/restartCommandEveBackendForSeat\(\s*\)/);
    expect(sources[0]).toContain('await restartCommandEveBackendForSeat(restartLease);');
    expect(sources[1]).toContain('restartBackend: () => restartCommandEveBackendForSeat(restartLease)');
    expect(sources[2]).toContain('respawn: deps.respawn ?? (() => restartCommandEveBackendForSeat(ownedLease))');
    expect(sources[2]).toContain('runConnectorAuthorityMutationTransaction');
  });

  it('rejects an aliased unleased restart immediately instead of queuing behind its owner', async () => {
    const restart = vi.fn(async () => {});
    setCommandEveBackendRestart(restart);
    const aliasedRestart = restartCommandEveBackendForSeat;
    await runCommandEveBackendRestartReservation(async () => {
      await expect(aliasedRestart(undefined as unknown as Parameters<typeof aliasedRestart>[0])).rejects.toThrow(
        'backend restart requires an explicit active lifecycle lease'
      );
    });
    expect(restart).not.toHaveBeenCalled();

    await expect(
      runCommandEveBackendRestartReservation((restartLease) => aliasedRestart(restartLease))
    ).resolves.toBeUndefined();
    expect(restart).toHaveBeenCalledOnce();
  });

  it('requires an exact active lease for terminal authority fail-closed cleanup', async () => {
    const calls: string[] = [];
    let retainedLease: Parameters<typeof failCommandEveBackendAuthorityClosed>[0] | undefined;
    setCommandEveBackendAuthorityFailClosed(async (lease) => {
      calls.push('fail-closed');
      expect(lease).toBe(retainedLease);
    });

    await runCommandEveBackendRestartReservation(async (restartLease) => {
      retainedLease = restartLease;
      await failCommandEveBackendAuthorityClosed(restartLease);
    });
    expect(calls).toEqual(['fail-closed']);
    await expect(failCommandEveBackendAuthorityClosed(retainedLease!)).rejects.toThrow(
      'backend authority fail-closed lease is invalid or expired'
    );
  });

  it('bounds a crash-recovery queue wait without expiring the transaction that already owns mutations', async () => {
    vi.useFakeTimers();
    let markOwnerEntered!: () => void;
    let releaseOwner!: () => void;
    const ownerEntered = new Promise<void>((resolve) => {
      markOwnerEntered = resolve;
    });
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const first = runCommandEveBackendRestartReservation(async () => {
      markOwnerEntered();
      await ownerGate;
    });
    await ownerEntered;

    const recover = vi.fn(async () => 4900);
    const clearDeadBackendPort = vi.fn();
    const timedOut = runCommandEveBackendCrashRecovery({
      claimIfCurrent: () => true,
      recover,
      clearDeadBackendPort,
      queueWaitTimeoutMs: 50,
    });
    const timeoutAssertion = expect(timedOut).rejects.toThrow(
      'backend lifecycle reservation timed out before acquiring the shared lane'
    );
    await vi.advanceTimersByTimeAsync(50);
    await timeoutAssertion;
    expect(recover).not.toHaveBeenCalled();
    expect(clearDeadBackendPort).toHaveBeenCalledOnce();

    releaseOwner();
    await first;
    await expect(runCommandEveBackendRestartReservation(async () => 'next')).resolves.toBe('next');
  });

  it('rejects a nonpositive explicit queue bound before reservation work enters', async () => {
    const operation = vi.fn(async () => 'never');
    await expect(
      runCommandEveBackendRestartReservationWithOptions(operation, { queueWaitTimeoutMs: 0 })
    ).rejects.toThrow('requires a positive queue timeout');
    expect(operation).not.toHaveBeenCalled();
  });

  it('honors the callers explicit 90s queue bound instead of imposing a hidden 30s default', async () => {
    vi.useFakeTimers();
    let markOwnerEntered!: () => void;
    let releaseOwner!: () => void;
    const ownerEntered = new Promise<void>((resolve) => {
      markOwnerEntered = resolve;
    });
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const events: string[] = [];
    const owner = runCommandEveBackendRestartReservation(async () => {
      events.push('owner');
      markOwnerEntered();
      await ownerGate;
    });
    await ownerEntered;
    const waiter = runCommandEveBackendRestartReservation(async () => {
      events.push('waiter');
    });

    await vi.advanceTimersByTimeAsync(31_000);
    expect(events).toEqual(['owner']);
    releaseOwner();
    await Promise.all([owner, waiter]);
    expect(events).toEqual(['owner', 'waiter']);
  });

  it('clears dead published-port truth when crash admission fails before backend mutation', async () => {
    const clearDeadBackendPort = vi.fn();
    const recover = vi.fn(async () => {
      throw new Error('COMMAND_EVE_RUNTIME_MUTABLE_ARTIFACTS_CHANGED_BEFORE_START');
    });

    await expect(
      runCommandEveBackendCrashRecovery({
        claimIfCurrent: () => true,
        recover,
        clearDeadBackendPort,
        queueWaitTimeoutMs: 50,
      })
    ).rejects.toThrow('COMMAND_EVE_RUNTIME_MUTABLE_ARTIFACTS_CHANGED_BEFORE_START');

    expect(recover).toHaveBeenCalledOnce();
    expect(clearDeadBackendPort).toHaveBeenCalledOnce();
  });

  it('rejects a retained lease after its reservation has terminated', async () => {
    let retainedLease: Parameters<typeof restartCommandEveBackendForSeat>[0];
    setCommandEveBackendRestart(async () => {});
    await runCommandEveBackendRestartReservation(async (restartLease) => {
      retainedLease = restartLease;
    });

    expect(retainedLease).toBeDefined();
    await expect(restartCommandEveBackendForSeat(retainedLease!)).rejects.toThrow(
      'backend restart lease is invalid or expired'
    );
  });

  it('releases the FIFO after a rejected transaction so the next owner can restart', async () => {
    let attempt = 0;
    setCommandEveBackendRestart(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('first restart rejected');
    });

    await expect(
      runCommandEveBackendRestartReservation((restartLease) => restartCommandEveBackendForSeat(restartLease))
    ).rejects.toThrow('first restart rejected');
    await expect(
      runCommandEveBackendRestartReservation((restartLease) => restartCommandEveBackendForSeat(restartLease))
    ).resolves.toBeUndefined();
    expect(attempt).toBe(2);
  });

  it('clears the published port when stop kills the child and then throws during cleanup', async () => {
    let childProcess: string | null = 'child-live';
    let publishedPort: number | undefined = 4199;
    const afterStop = vi.fn(async () => 4200);

    await expect(
      runCommandEveBackendRespawnAfterStop({
        stop: async () => {
          childProcess = null;
          throw new Error('process registry cleanup failed');
        },
        clearDeadBackendPort: () => {
          publishedPort = undefined;
        },
        afterStop,
      })
    ).rejects.toThrow('process registry cleanup failed');

    expect(childProcess).toBeNull();
    expect(publishedPort).toBeUndefined();
    expect(afterStop).not.toHaveBeenCalled();
  });

  it('never falls back to loading a local model before backend settings are readable', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const warmupStart = source.indexOf('function scheduleCommandEveLocalModelWarmup(');
    const warmupEnd = source.indexOf('function registerCronResumeBridge(', warmupStart);
    const warmupSource = source.slice(warmupStart, warmupEnd);

    expect(warmupSource).toContain('await waitForCommandEveBackendPort(30_000)');
    expect(warmupSource).toContain('skipping speculative warm-up');
    expect(warmupSource).not.toContain("lane = { lane: 'local' }");
  });

  it('never schedules a cloud inference warm-up, and never warns about not doing it', () => {
    // MAT-1749. Startup used to fire a metered EVE turn to warm the edge, then warn
    // whenever that failed. Both are gone: no scheduler call, so no request and no
    // per-launch warning. A warning here would describe a decision, not a problem,
    // and would train operators to ignore the warnings that do matter.
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const warmupStart = source.indexOf('function scheduleCommandEveLocalModelWarmup(');
    const warmupEnd = source.indexOf('function registerCronResumeBridge(', warmupStart);
    const warmupSource = source.slice(warmupStart, warmupEnd);

    const eveBranchStart = warmupSource.indexOf("if (lane.lane === 'eve') {");
    const eveBranchEnd = warmupSource.indexOf('// Local lane:', eveBranchStart);
    expect(eveBranchStart).toBeGreaterThan(-1);
    expect(eveBranchEnd).toBeGreaterThan(eveBranchStart);
    const eveBranch = warmupSource.slice(eveBranchStart, eveBranchEnd);

    // The cloud branch does nothing and says nothing. (The lane-RESOLUTION failure
    // above it still warns, and should — that one is a genuine problem.)
    expect(eveBranch).not.toContain('console.warn');
    expect(eveBranch).not.toContain('Warmup(');
    expect(warmupSource).not.toContain('scheduleCommandEveEveLaneWarmup');
    expect(warmupSource).not.toContain('eveWarmup');
    // Gone from the file, not merely unreferenced from this branch.
    expect(source).not.toContain('function scheduleCommandEveEveLaneWarmup(');
    // The LOCAL model warm-up must survive untouched — this fix must not cost the
    // local lane its warm start.
    expect(warmupSource).toContain('ensureCommandEveLocalModelWarmup(receipt, shimUrl, warmup, mark)');
  });

  it('gates every managed local route on the exact release receipt and never downloads from chat', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const resolverStart = source.indexOf('function buildCommandEveManagedLocalOpenAiRoutingResolver(');
    const resolverEnd = source.indexOf('function buildCommandEveShimEgressRedactionModeResolver(', resolverStart);
    const resolverSource = source.slice(resolverStart, resolverEnd);

    expect(resolverSource).toContain(
      'runtimeReceiptAllowsLocalModelRequest(receipt, app.getVersion(), normalizedModel)'
    );
    expect(resolverSource).not.toContain("requestedTier.runtime === 'ollama'");
    expect(resolverSource).toContain('autoProvision: false');
    expect(resolverSource).not.toContain('autoProvision: true');
  });

  it('allows the 384 GB Colibri download only through the explicit model-settings action', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const providerStart = source.indexOf('ipcBridge.commandEve.ensureLocalModelTier.provider');
    const providerEnd = source.indexOf('ipcBridge.commandEve.warmLocalModel.provider', providerStart);
    const providerSource = source.slice(providerStart, providerEnd);

    expect(providerSource).toContain('allowColibriDownload: true');
  });

  it('threads the trusted canonical Electron data root through every production bootstrap entrypoint', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const ensureStart = source.indexOf('ipcBridge.commandEve.ensureLocalModelTier.provider');
    const warmStart = source.indexOf('ipcBridge.commandEve.warmLocalModel.provider', ensureStart);
    const providerEnd = source.indexOf('ipcBridge.commandEve.evaluateGateDecision.provider', warmStart);
    const ensureSource = source.slice(ensureStart, warmStart);
    const warmSource = source.slice(warmStart, providerEnd);
    const bootStart = source.indexOf('commandEveAutomaticRuntimeRepairRequired = app.isPackaged;');
    const bootEnd = source.indexOf('// Start aioncore only after initializeProcess()', bootStart);
    const bootSource = source.slice(bootStart, bootEnd);

    for (const entrypoint of [ensureSource, warmSource]) {
      expect(entrypoint).toContain('getCanonicalDataPath');
      expect(entrypoint).toContain('canonicalUserDataPath');
      expect(entrypoint).toContain("app.isPackaged && process.platform === 'darwin'");
      expect(entrypoint).toContain('requireBundledPython');
    }
    expect(bootSource).toContain('const canonicalRuntimeUserDataPath = getCanonicalDataPath();');
    expect(bootSource).not.toContain("path.join(\n      app.getPath('userData')");

    const utilsSource = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/process/utils/utils.ts'),
      'utf8'
    );
    expect(utilsSource).toContain('export const getCanonicalDataPath = (): string =>');
    expect(utilsSource).toContain('const dataPath = getCanonicalDataPath();');
  });

  it('cancels deferred runtime work after a known backend startup failure', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const warmupStart = source.indexOf('function scheduleCommandEveLocalModelWarmup(');
    const warmupEnd = source.indexOf('function registerCronResumeBridge(', warmupStart);
    const warmupSource = source.slice(warmupStart, warmupEnd);
    const backendFailureStart = source.indexOf("console.error('[CommandEVE] Failed to start aioncore:'");
    const backendFailureEnd = source.indexOf('// One-shot WebUI admin credential migration', backendFailureStart);
    const backendFailureSource = source.slice(backendFailureStart, backendFailureEnd);

    expect(warmupSource).toContain('if (backendStartupFailed) return;');
    expect(backendFailureSource).toContain('runDeferredCommandEveRuntimeBootstrap = undefined;');
  });
});
