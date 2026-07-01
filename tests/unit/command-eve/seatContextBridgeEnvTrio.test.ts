/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Seat-Context-Bridge (S3 / spec B1) — env + label state tests.
 *
 * Proves:
 *  - the env bake sets the OPAQUE COMMAND_EVE_ACTIVE_SEAT after setActiveSeatId;
 *  - H3 (isolation): the SEAT DISPLAY LABEL is NEVER written into the process env
 *    (the client's real name must not reach any child-process env, incl. delegated
 *    third-party CLI workers) — but the process-local label STATE (getActiveSeatLabel)
 *    still carries it for the internal prompt block;
 *  - legacy default id (seat-1);
 *  - H5: HERMES_KANBAN_BOARD is ABSENT while the slug is empty AND is DELETED
 *    symmetrically on a re-bake (no cross-seat carryover);
 *  - a switch mirrors the new id into the NEXT bake and the label STATE follows
 *    (applySeatSwitch → prepareEnv re-bake), rollback reverts the label state.
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

describe('B1 env bake — opaque id in env, label NEVER in env (H3)', () => {
  it('sets the OPAQUE ACTIVE_SEAT but NEVER the SEAT_LABEL (label stays in state)', () => {
    const root = makeRoot();
    setActiveSeatId(SEAT_A);
    setActiveSeatLabel('Acme GmbH');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(root, env);
    // The opaque seat id is safe for the whole child subtree.
    expect(env.COMMAND_EVE_ACTIVE_SEAT).toBe(SEAT_A);
    // H3: the client's real name must NOT reach child-process env.
    expect(env.COMMAND_EVE_SEAT_LABEL).toBeUndefined();
    // …but the process-local label STATE still carries it (for the prompt block).
    expect(getActiveSeatLabel()).toBe('Acme GmbH');
    // HERMES_HOME still baked (the pinning seam we hang off).
    expect(env.HERMES_HOME).toContain(path.join('seats', SEAT_A, 'home'));
  });

  it('a stale COMMAND_EVE_SEAT_LABEL in a caller-seeded env is DELETED by the bake', () => {
    const root = makeRoot();
    setActiveSeatId(SEAT_A);
    setActiveSeatLabel('Acme GmbH');
    // A hostile / stale env that already carried the clear name must be scrubbed.
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', COMMAND_EVE_SEAT_LABEL: 'Leaked Client Name' };
    prepareCommandEveRuntimeProcessEnv(root, env);
    expect(env.COMMAND_EVE_SEAT_LABEL).toBeUndefined();
  });

  it('legacy default: ACTIVE_SEAT=seat-1, no label in env, Founder in state', () => {
    const root = makeRoot();
    // No setActiveSeatId → legacy default.
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(root, env);
    expect(env.COMMAND_EVE_ACTIVE_SEAT).toBe(LEGACY_SEAT_ID);
    expect(env.COMMAND_EVE_SEAT_LABEL).toBeUndefined();
    expect(getActiveSeatLabel()).toBe(DEFAULT_SEAT_LABEL);
    expect(DEFAULT_SEAT_LABEL).toBe('Founder');
  });

  it('a blank/whitespace label folds back to the Founder default in STATE (never in env)', () => {
    const root = makeRoot();
    setActiveSeatId(SEAT_A);
    setActiveSeatLabel('   ');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(root, env);
    expect(env.COMMAND_EVE_SEAT_LABEL).toBeUndefined();
    expect(getActiveSeatLabel()).toBe(DEFAULT_SEAT_LABEL);
  });

  it('H5: empty board slug → HERMES_KANBAN_BOARD ABSENT + DELETED symmetrically (no carryover)', () => {
    const root = makeRoot();
    expect(getActiveSeatBoardSlug()).toBe(''); // no per-seat board PINS yet (S7)
    // Fresh env: the var is never introduced when the slug is empty.
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(root, env);
    expect(env.HERMES_KANBAN_BOARD).toBeUndefined();
    // Carryover guard: a value present on a re-baked env (a prior seat's pin, or a
    // user value) is DELETED when the current slug is empty — seat isolation outranks
    // any ambient pin; the wheel falls back to its own 'default' board.
    const env2: NodeJS.ProcessEnv = { PATH: '/usr/bin', HERMES_KANBAN_BOARD: 'prior-seat-board' };
    prepareCommandEveRuntimeProcessEnv(root, env2);
    expect(env2.HERMES_KANBAN_BOARD).toBeUndefined();
  });
});

describe('B1 switch mirror (applySeatSwitch → next bake): id in env, label in state', () => {
  it('a switch carries the NEW opaque id into the next bake; the label follows in STATE only', async () => {
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
    // The env baked DURING the switch carries the target's opaque id …
    expect(env.COMMAND_EVE_ACTIVE_SEAT).toBe(SEAT_A);
    // … but NEVER the clear name (H3).
    expect(env.COMMAND_EVE_SEAT_LABEL).toBeUndefined();
    // The process-local label STATE holds the name (the prompt block reads it there).
    expect(getActiveSeatLabel()).toBe('Acme GmbH');
  });

  it('switching HOME to the legacy seat folds the label STATE back to Founder (env has no label)', async () => {
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
    expect(env.COMMAND_EVE_SEAT_LABEL).toBeUndefined();
    expect(getActiveSeatLabel()).toBe(DEFAULT_SEAT_LABEL);
  });

  it('a failed re-spawn rolls the label STATE back to the prior seat (env still label-free)', async () => {
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
    // Rolled back: id + label STATE point at the PRIOR seat, not the target. The env
    // never carried the label at all (H3), and the rollback re-bake keeps it absent.
    expect(env.COMMAND_EVE_ACTIVE_SEAT).toBe(SEAT_A);
    expect(env.COMMAND_EVE_SEAT_LABEL).toBeUndefined();
    expect(getActiveSeatLabel()).toBe('Acme GmbH');
    // The target's name (Beta Ltd) never leaked into the env on the failed attempt.
    expect(Object.values(env)).not.toContain('Beta Ltd');
  });
});

// ── H3 trace — the client's real name cannot reach a DELEGATED worker's env ─────
// The backend is spawned with `...process.env` (the bake target), and a delegated
// third-party CLI worker (claude-agent-acp) is in turn spawned by the backend, so
// it INHERITS the backend's env transitively. The ONLY place the clear name could
// enter that chain is prepareCommandEveRuntimeProcessEnv (the bake). This test
// walks the exact inheritance hops and asserts the name is absent at each — while
// the OPAQUE seat id is present (safe to inherit).

describe('H3 — delegated-worker env inheritance (clear name cannot pass)', () => {
  const CLIENT_NAME = 'Bäckerei Müller GmbH'; // a real client company name

  it('the clear name is absent at every spawn hop; only the opaque id inherits', () => {
    const root = makeRoot();
    setActiveSeatId(SEAT_A);
    setActiveSeatLabel(CLIENT_NAME);

    // A realistic process.env that even already carries a stale leaked label — the
    // bake must SCRUB it, not just refrain from adding one.
    const processEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/op',
      COMMAND_EVE_SEAT_LABEL: 'previously-leaked-name',
    };

    // (1) BAKE — what index.ts runs before backendManager.start(...process.env).
    prepareCommandEveRuntimeProcessEnv(root, processEnv);

    // (2) BACKEND spawn env = a copy of process.env (web-host buildSpawnEnv shape).
    const backendEnv: NodeJS.ProcessEnv = { ...processEnv };

    // (3) DELEGATED WORKER (claude-agent-acp) spawn env = inherits the backend env.
    const delegatedWorkerEnv: NodeJS.ProcessEnv = { ...backendEnv };

    for (const [label, env] of [
      ['process.env (bake target)', processEnv],
      ['backend spawn env', backendEnv],
      ['delegated claude-agent-acp env', delegatedWorkerEnv],
    ] as const) {
      // The clear client name is nowhere in this env (no key holds it).
      expect(Object.values(env), `clear name leaked into ${label}`).not.toContain(CLIENT_NAME);
      // The dedicated label key is scrubbed at every hop.
      expect(env.COMMAND_EVE_SEAT_LABEL, `SEAT_LABEL present in ${label}`).toBeUndefined();
      // The OPAQUE seat id DID inherit (that is the intended, safe identifier).
      expect(env.COMMAND_EVE_ACTIVE_SEAT, `opaque id missing in ${label}`).toBe(SEAT_A);
    }

    // The name still lives in process-local STATE for the internal prompt block.
    expect(getActiveSeatLabel()).toBe(CLIENT_NAME);
  });
});
