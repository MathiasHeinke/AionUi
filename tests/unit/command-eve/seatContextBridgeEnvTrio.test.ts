/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Seat-Context-Bridge (S3 / spec B1) — env TRIO + label state tests.
 *
 * Proves:
 *  - the env bake sets COMMAND_EVE_ACTIVE_SEAT / _SEAT_LABEL after setActiveSeatId
 *    + setActiveSeatLabel;
 *  - legacy defaults (seat-1 / 'Founder');
 *  - HERMES_KANBAN_BOARD is ABSENT while the slug is empty (never overwrites a
 *    user's own value with '');
 *  - a switch mirrors the new id + label into the NEXT bake (applySeatSwitch →
 *    prepareEnv re-bake carries the target's id + label).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { prepareCommandEveRuntimeProcessEnv } from '@/process/commandEve/runtimeBootstrapCore';
import { applySeatSwitch, type SeatSwitchDeps } from '@process/commandEve/seatSwitchCore';
import {
  DEFAULT_SEAT_LABEL,
  LEGACY_SEAT_ID,
  __resetActiveSeatForTests,
  getActiveSeatBoardSlug,
  getActiveSeatLabel,
  setActiveSeatId,
  setActiveSeatLabel,
} from '@/process/commandEve/seatContextCore';

const SEAT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ce-env-trio-'));
}

beforeEach(() => {
  __resetActiveSeatForTests();
});
afterEach(() => {
  __resetActiveSeatForTests();
});

describe('B1 env trio — bake sets the self-knowledge trio', () => {
  it('sets ACTIVE_SEAT + SEAT_LABEL after setActiveSeatId + setActiveSeatLabel', () => {
    const root = makeRoot();
    setActiveSeatId(SEAT_A);
    setActiveSeatLabel('Acme GmbH');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(root, env);
    expect(env.COMMAND_EVE_ACTIVE_SEAT).toBe(SEAT_A);
    expect(env.COMMAND_EVE_SEAT_LABEL).toBe('Acme GmbH');
    // HERMES_HOME still baked (the pinning seam we hang off).
    expect(env.HERMES_HOME).toContain(path.join('seats', SEAT_A, 'home'));
  });

  it('legacy defaults: ACTIVE_SEAT=seat-1, SEAT_LABEL=Founder', () => {
    const root = makeRoot();
    // No setActiveSeatId → legacy default.
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(root, env);
    expect(env.COMMAND_EVE_ACTIVE_SEAT).toBe(LEGACY_SEAT_ID);
    expect(env.COMMAND_EVE_SEAT_LABEL).toBe(DEFAULT_SEAT_LABEL);
    expect(DEFAULT_SEAT_LABEL).toBe('Founder');
  });

  it('a blank/whitespace label folds back to the Founder default (never bakes empty)', () => {
    const root = makeRoot();
    setActiveSeatId(SEAT_A);
    setActiveSeatLabel('   ');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(root, env);
    expect(env.COMMAND_EVE_SEAT_LABEL).toBe(DEFAULT_SEAT_LABEL);
  });

  it('empty board slug → HERMES_KANBAN_BOARD is ABSENT and never overwrites an existing value', () => {
    const root = makeRoot();
    expect(getActiveSeatBoardSlug()).toBe(''); // no per-seat boards yet (S7)
    // Fresh env: the var is never introduced when the slug is empty.
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(root, env);
    expect(env.HERMES_KANBAN_BOARD).toBeUndefined();
    // A pre-existing user value survives (we never write '' over it).
    const env2: NodeJS.ProcessEnv = { PATH: '/usr/bin', HERMES_KANBAN_BOARD: 'user-board' };
    prepareCommandEveRuntimeProcessEnv(root, env2);
    expect(env2.HERMES_KANBAN_BOARD).toBe('user-board');
  });
});

describe('B1 env trio — switch mirror (applySeatSwitch → next bake)', () => {
  it('a switch carries the NEW id + label into the very next env bake', async () => {
    const root = makeRoot();
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    // The switch deps: prepareEnv re-bakes into our env (what the real bridge does).
    const deps: SeatSwitchDeps = {
      prepareEnv: () => {
        prepareCommandEveRuntimeProcessEnv(root, env);
      },
      restartBackend: () => {},
      rebindConfig: () => {},
    };

    const result = await applySeatSwitch(SEAT_A, deps, 'Acme GmbH');
    expect(result.ok).toBe(true);
    // The env baked DURING the switch already carries the target's id + label.
    expect(env.COMMAND_EVE_ACTIVE_SEAT).toBe(SEAT_A);
    expect(env.COMMAND_EVE_SEAT_LABEL).toBe('Acme GmbH');
    // And the process-local holders agree (single source, no store split).
    expect(getActiveSeatLabel()).toBe('Acme GmbH');
  });

  it('switching HOME to the legacy seat folds the label back to Founder', async () => {
    const root = makeRoot();
    setActiveSeatId(SEAT_A);
    setActiveSeatLabel('Acme GmbH');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const deps: SeatSwitchDeps = {
      prepareEnv: () => {
        prepareCommandEveRuntimeProcessEnv(root, env);
      },
      restartBackend: () => {},
      rebindConfig: () => {},
    };
    // A legacy target with any label folds to 'Founder' (isLegacySeatId guard).
    const result = await applySeatSwitch(LEGACY_SEAT_ID, deps, 'ignored-name');
    expect(result.ok).toBe(true);
    expect(env.COMMAND_EVE_ACTIVE_SEAT).toBe(LEGACY_SEAT_ID);
    expect(env.COMMAND_EVE_SEAT_LABEL).toBe(DEFAULT_SEAT_LABEL);
  });

  it('a failed re-spawn rolls the label back to the prior seat', async () => {
    const root = makeRoot();
    // Start on SEAT_A with a client label.
    setActiveSeatId(SEAT_A);
    setActiveSeatLabel('Acme GmbH');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const SEAT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const deps: SeatSwitchDeps = {
      prepareEnv: () => {
        prepareCommandEveRuntimeProcessEnv(root, env);
      },
      restartBackend: () => {
        throw new Error('respawn boom');
      },
      rebindConfig: () => {},
    };
    const result = await applySeatSwitch(SEAT_B, deps, 'Beta Ltd');
    expect(result.ok).toBe(false);
    expect(result.rolled_back).toBe(true);
    // Rolled back: id + label + baked env all point at the PRIOR seat, not the target.
    expect(env.COMMAND_EVE_ACTIVE_SEAT).toBe(SEAT_A);
    expect(env.COMMAND_EVE_SEAT_LABEL).toBe('Acme GmbH');
    expect(getActiveSeatLabel()).toBe('Acme GmbH');
  });
});
