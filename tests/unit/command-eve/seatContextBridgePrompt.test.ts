/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Seat-Context-Bridge (S3 / spec B3) — seat-aware PROMPT block tests.
 *
 * Proves:
 *  - a real-seat block has its OWN label + the INTERN/EXTERN sentence + NO roster;
 *  - the roster path is STRUCTURALLY unreachable from a real seat (the wire is
 *    NEVER read when the active seat is not legacy — the isolation invariant);
 *  - the founder block has the roster when the wire resolves, and degrades
 *    honestly ("keine Seats geladen") when the wire is null;
 *  - the prompt consumes the SAME values the env bake sets (env == prompt —
 *    the anti-store-split test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  renderSeatContextBlock,
  resolveSeatContextBlock,
  type CommandEveSeatRosterEntry,
} from '@/process/commandEve/assistantBootstrapCore';
import { prepareCommandEveRuntimeProcessEnv } from '@/process/commandEve/runtimeBootstrapCore';
import {
  DEFAULT_SEAT_LABEL,
  LEGACY_SEAT_ID,
  __resetActiveSeatForTests,
  getActiveSeatId,
  getActiveSeatLabel,
  isActiveSeatLegacy,
  setActiveSeatId,
  setActiveSeatLabel,
} from '@/process/commandEve/seatContextCore';

const SEAT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

beforeEach(() => {
  __resetActiveSeatForTests();
});
afterEach(() => {
  __resetActiveSeatForTests();
  vi.restoreAllMocks();
});

describe('B3 renderSeatContextBlock (pure) — real seat', () => {
  it('real seat: own label + client + INTERN/EXTERN sentence, NO roster', () => {
    const block = renderSeatContextBlock({
      seatLabel: 'Acme GmbH',
      seatId: SEAT_A,
      legacy: false,
      clientEntity: 'Acme GmbH (Bäckerei)',
      boardSlug: '',
      locale: 'de-DE',
    });
    expect(block).toContain('Acme GmbH');
    expect(block).toContain('für Acme GmbH (Bäckerei)');
    expect(block).toContain('Aktives Board: keins');
    expect(block).toContain('der Seat-Name erscheint NIE in Deliverables');
    // A real-seat block NEVER lists a roster.
    expect(block).not.toContain('Angelegte Seats');
    expect(block).not.toContain('Founder-Seat');
  });

  it('founder seat with a roster: header + roster rows + orchestration line', () => {
    const roster: CommandEveSeatRosterEntry[] = [
      { label: 'Acme GmbH', purpose: 'Client-Seat (isoliert)' },
      { label: 'Beta Ltd', purpose: 'Client-Seat (isoliert)' },
    ];
    const block = renderSeatContextBlock({
      seatLabel: 'Founder',
      seatId: LEGACY_SEAT_ID,
      legacy: true,
      founderName: 'Mathias',
      roster,
      locale: 'de-DE',
    });
    expect(block).toContain('Founder-Seat von Mathias');
    expect(block).toContain('- Acme GmbH: Client-Seat (isoliert)');
    expect(block).toContain('- Beta Ltd: Client-Seat (isoliert)');
    expect(block).toContain('Von hier orchestrierst du');
  });

  it('founder seat with a NULL roster: honest "keine Seats geladen" omission', () => {
    const block = renderSeatContextBlock({
      seatLabel: 'Founder',
      seatId: LEGACY_SEAT_ID,
      legacy: true,
      founderName: 'Mathias',
      roster: null,
      locale: 'de-DE',
    });
    expect(block).toContain('keine Seats geladen');
    // Never fabricates a roster row.
    expect(block).not.toContain('- ');
  });
});

describe('K3 renderSeatContextBlock — kind-conditioned real-seat orientation', () => {
  const real = { seatLabel: 'FYN Labs', seatId: SEAT_A, legacy: false as const, clientEntity: 'FYN Labs GmbH', boardSlug: '' };

  it('client (default) is BYTE-IDENTICAL to an explicit client kind (both locales)', () => {
    for (const locale of ['de-DE', 'en-US'] as const) {
      expect(renderSeatContextBlock({ ...real, locale })).toBe(renderSeatContextBlock({ ...real, seatKind: 'client', locale }));
    }
  });

  it('own_company DROPS the invisible-delivery clause and uses own-project framing', () => {
    const de = renderSeatContextBlock({ ...real, seatKind: 'own_company', locale: 'de-DE' });
    expect(de).not.toContain('NIE in Deliverables');
    expect(de).toContain('eigenes Projekt/eigene Firma des Operators');
    expect(de).toContain('Der Operator ist hier selbst der Auftraggeber');
    const en = renderSeatContextBlock({ ...real, seatKind: 'own_company', locale: 'en-US' });
    expect(en).not.toContain('NEVER appears in deliverables');
    expect(en).toContain("operator's own project/firm");
  });

  it('department KEEPS the invisible-delivery clause (conservative) with department framing', () => {
    const de = renderSeatContextBlock({ ...real, seatKind: 'department', locale: 'de-DE' });
    expect(de).toContain('NIE in Deliverables');
    expect(de).toContain('Abteilung/Bereich des Operators');
    const en = renderSeatContextBlock({ ...real, seatKind: 'department', locale: 'en-US' });
    expect(en).toContain('NEVER appears in deliverables');
    expect(en).toContain('department/area of the operator');
  });
});

describe('B3 resolveSeatContextBlock — isolation gate (roster unreachable from a real seat)', () => {
  it('a REAL seat NEVER reads the my-seats wire (structural gate)', async () => {
    const readMySeatsWire = vi.fn(async () => ({ account: { role: 'admin' }, seats: [] }));
    const parseRoster = vi.fn((): CommandEveSeatRosterEntry[] | null => [{ label: 'LEAK', purpose: 'x' }]);
    const block = await resolveSeatContextBlock({
      getActiveSeatId: () => SEAT_A,
      getActiveSeatLabel: () => 'Acme GmbH',
      isActiveSeatLegacy: () => false, // REAL seat
      readMySeatsWire,
      parseRoster,
      clientEntity: 'Acme GmbH',
      boardSlug: '',
      locale: 'de-DE',
    });
    // The wire was NEVER touched — roster is structurally unreachable here.
    expect(readMySeatsWire).not.toHaveBeenCalled();
    expect(parseRoster).not.toHaveBeenCalled();
    expect(block).not.toContain('LEAK');
    expect(block).toContain('Acme GmbH');
  });

  it('the FOUNDER seat DOES read the wire and renders the roster', async () => {
    const readMySeatsWire = vi.fn(async () => ({ ok: true }));
    const parseRoster = vi.fn(
      (): CommandEveSeatRosterEntry[] | null => [{ label: 'Acme GmbH', purpose: 'Client-Seat' }]
    );
    const block = await resolveSeatContextBlock({
      getActiveSeatId: () => LEGACY_SEAT_ID,
      getActiveSeatLabel: () => 'Founder',
      isActiveSeatLegacy: () => true, // FOUNDER seat
      readMySeatsWire,
      parseRoster,
      founderName: 'Mathias',
      locale: 'de-DE',
    });
    expect(readMySeatsWire).toHaveBeenCalledTimes(1);
    expect(block).toContain('- Acme GmbH: Client-Seat');
  });

  it('a wire error degrades honestly (null roster → "keine Seats geladen")', async () => {
    const readMySeatsWire = vi.fn(async () => {
      throw new Error('offline');
    });
    const block = await resolveSeatContextBlock({
      getActiveSeatId: () => LEGACY_SEAT_ID,
      getActiveSeatLabel: () => 'Founder',
      isActiveSeatLegacy: () => true,
      readMySeatsWire,
      parseRoster: () => [{ label: 'never', purpose: 'x' }],
      founderName: 'Mathias',
      locale: 'de-DE',
    });
    expect(block).toContain('keine Seats geladen');
    expect(block).not.toContain('never');
  });
});

describe('B3 consistency — env id == prompt, label in STATE not env (H3 anti store-split)', () => {
  it('the prompt block consumes the SAME id (env) + label (STATE); the label is NOT in env', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-consistency-'));
    // Set the live process-local seat state (as a switch/boot would).
    setActiveSeatId(SEAT_A);
    setActiveSeatLabel('Acme GmbH');

    // 1) Bake the env from the live state.
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(root, env);

    // 2) Build the prompt block from the SAME live readers (no injected overrides).
    const block = await resolveSeatContextBlock({
      getActiveSeatId,
      getActiveSeatLabel,
      isActiveSeatLegacy,
      readMySeatsWire: async () => null, // real seat → never called anyway
      parseRoster: () => null,
      clientEntity: 'Acme GmbH',
      locale: 'de-DE',
    });

    // The opaque id appears in env; the CLEAR NAME does NOT (H3).
    expect(env.COMMAND_EVE_ACTIVE_SEAT).toBe(SEAT_A);
    expect(env.COMMAND_EVE_SEAT_LABEL).toBeUndefined();
    // The prompt block still carries the label — read from process-local STATE, so
    // env and prompt cannot diverge even though the label is not in env.
    expect(getActiveSeatLabel()).toBe('Acme GmbH');
    expect(block).toContain('Acme GmbH');
  });

  it('legacy defaults are consistent across env id + prompt (Founder / seat-1)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-consistency-legacy-'));
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(root, env);
    const block = await resolveSeatContextBlock({
      getActiveSeatId,
      getActiveSeatLabel,
      isActiveSeatLegacy,
      readMySeatsWire: async () => null,
      parseRoster: () => null,
      founderName: 'Mathias',
      locale: 'de-DE',
    });
    expect(env.COMMAND_EVE_ACTIVE_SEAT).toBe(LEGACY_SEAT_ID);
    expect(env.COMMAND_EVE_SEAT_LABEL).toBeUndefined();
    expect(getActiveSeatLabel()).toBe(DEFAULT_SEAT_LABEL);
    expect(block).toContain('Founder-Seat');
  });
});
