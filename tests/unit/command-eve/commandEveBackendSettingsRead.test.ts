/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the SHARED backend batch reader (S9) — the generalization of the
 * proven `inferenceSelectionBackendRead` pattern to many keys in ONE GET.
 *
 * Pins the load-bearing contract each dead-control fix relies on:
 *   - ONE GET /api/settings/client serves ALL requested keys (no per-key HTTP);
 *   - a seat-scoped key is read under its seat-physical key, with a legacy-key
 *     fallback (so a value written before seat scoping is still found);
 *   - an install-global key is read verbatim (no seat prefix);
 *   - an absent key is OMITTED from the result (caller applies its default);
 *   - a backend error THROWS (so a caller can tell failure from absence — the
 *     money-bug resolver's last-known-good depends on that distinction).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const httpRequestMock = vi.fn();
vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: (...args: unknown[]) => httpRequestMock(...args),
}));

import { readCommandEveSettingsFromBackend } from '@process/commandEve/commandEveBackendSettingsRead';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';
import { __resetActiveSeatForTests, setActiveSeatId } from '@process/commandEve/seatContextCore';

describe('readCommandEveSettingsFromBackend (shared batch reader)', () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    __resetActiveSeatForTests();
  });
  afterEach(() => {
    __resetActiveSeatForTests();
  });

  it('reads MANY keys from ONE GET /api/settings/client', async () => {
    httpRequestMock.mockResolvedValue({
      'commandEve.teamWorkerStatus': { ceo: 'off' },
      'commandEve.localModelTierId': 'gemma4-12b',
      'commandEve.modelWarmupEnabled': false,
    });

    const bag = await readCommandEveSettingsFromBackend([
      'commandEve.teamWorkerStatus',
      'commandEve.localModelTierId',
      'commandEve.modelWarmupEnabled',
    ]);

    expect(bag['commandEve.teamWorkerStatus']).toEqual({ ceo: 'off' });
    expect(bag['commandEve.localModelTierId']).toBe('gemma4-12b');
    expect(bag['commandEve.modelWarmupEnabled']).toBe(false);
    // The whole point: a SINGLE HTTP call for all three keys.
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock).toHaveBeenCalledWith('GET', '/api/settings/client');
  });

  it('preserves the raw stored type per key (object / string / boolean)', async () => {
    httpRequestMock.mockResolvedValue({
      'commandEve.workerAssignments': { 'claude-code': { kind: 'claude-acp' } },
    });
    const bag = await readCommandEveSettingsFromBackend(['commandEve.workerAssignments']);
    expect(bag['commandEve.workerAssignments']).toEqual({ 'claude-code': { kind: 'claude-acp' } });
  });

  it('OMITS an absent key so `key in bag` is a clean "was it set?" probe', async () => {
    httpRequestMock.mockResolvedValue({ 'commandEve.localModelTierId': 'e4b' });
    const bag = await readCommandEveSettingsFromBackend([
      'commandEve.localModelTierId',
      'commandEve.modelWarmupEnabled',
    ]);
    expect('commandEve.localModelTierId' in bag).toBe(true);
    expect('commandEve.modelWarmupEnabled' in bag).toBe(false);
  });

  it('reads a SEAT-SCOPED key under its seat-physical key for a real seat', async () => {
    const seatId = 'seat-acme-gmbh';
    setActiveSeatId(seatId);
    httpRequestMock.mockResolvedValue({
      [seatScopedKey('commandEve.teamWorkerStatus', seatId)]: { ceo: 'paused' },
      // A stray un-prefixed value must NOT win over the seat-physical one.
      'commandEve.teamWorkerStatus': { ceo: 'active' },
    });
    const bag = await readCommandEveSettingsFromBackend(['commandEve.teamWorkerStatus']);
    expect(bag['commandEve.teamWorkerStatus']).toEqual({ ceo: 'paused' });
  });

  it('falls back to the un-prefixed (legacy) key when the seat-physical key is absent', async () => {
    const seatId = 'seat-acme-gmbh';
    setActiveSeatId(seatId);
    httpRequestMock.mockResolvedValue({ 'commandEve.teamWorkerStatus': { ceo: 'off' } });
    const bag = await readCommandEveSettingsFromBackend(['commandEve.teamWorkerStatus']);
    // No seat-physical key present → the legacy value is still found.
    expect(bag['commandEve.teamWorkerStatus']).toEqual({ ceo: 'off' });
  });

  it('C1 SECURITY: a real seat NEVER inherits the un-prefixed egressRedactionMode (no fail-open PII waiver)', async () => {
    const seatId = 'seat-acme-gmbh';
    setActiveSeatId(seatId);
    // The founder/legacy seat disabled redaction in HIS own brief (un-prefixed 'off').
    // A real client seat with no scoped value must NOT inherit that waiver.
    httpRequestMock.mockResolvedValue({ 'commandEve.egressRedactionMode': 'off' });
    const bag = await readCommandEveSettingsFromBackend(['commandEve.egressRedactionMode']);
    // The key is OMITTED (not inherited) → the egress resolver applies its safe default 'on'.
    expect('commandEve.egressRedactionMode' in bag).toBe(false);
  });

  it('C1: a real seat DOES read its OWN scoped egressRedactionMode (an explicit per-seat off is still honored)', async () => {
    const seatId = 'seat-acme-gmbh';
    setActiveSeatId(seatId);
    httpRequestMock.mockResolvedValue({
      [seatScopedKey('commandEve.egressRedactionMode', seatId)]: 'off',
      'commandEve.egressRedactionMode': 'on', // a stray legacy value must not interfere either way
    });
    const bag = await readCommandEveSettingsFromBackend(['commandEve.egressRedactionMode']);
    expect(bag['commandEve.egressRedactionMode']).toBe('off');
  });

  it('CEVE-18205 SECURITY: a real seat NEVER inherits the un-prefixed agentVideoGenerateEnabled', async () => {
    const seatId = 'seat-acme-gmbh';
    setActiveSeatId(seatId);
    // The FOUNDER seat released agent video generation for itself (un-prefixed
    // true). A client seat that never made that decision must NOT inherit it —
    // inheriting here does not merely leak a preference, it lets the model start
    // paid renders on THIS client's credits.
    httpRequestMock.mockResolvedValue({ 'commandEve.agentVideoGenerateEnabled': true });
    const bag = await readCommandEveSettingsFromBackend(['commandEve.agentVideoGenerateEnabled']);
    // OMITTED, not inherited → the resolver applies its fail-closed default (off).
    expect('commandEve.agentVideoGenerateEnabled' in bag).toBe(false);
  });

  it('CEVE-18205: a real seat DOES read its OWN scoped agentVideoGenerateEnabled', async () => {
    const seatId = 'seat-acme-gmbh';
    setActiveSeatId(seatId);
    httpRequestMock.mockResolvedValue({
      [seatScopedKey('commandEve.agentVideoGenerateEnabled', seatId)]: true,
      'commandEve.agentVideoGenerateEnabled': false, // a stray legacy value must not interfere either way
    });
    const bag = await readCommandEveSettingsFromBackend(['commandEve.agentVideoGenerateEnabled']);
    expect(bag['commandEve.agentVideoGenerateEnabled']).toBe(true);
  });

  it('reads an INSTALL-GLOBAL key verbatim (no seat prefix even under a real seat)', async () => {
    setActiveSeatId('seat-acme-gmbh');
    // localModelTierId is NOT seat-scoped → read under the un-prefixed key.
    httpRequestMock.mockResolvedValue({ 'commandEve.localModelTierId': 'gemma4-12b' });
    const bag = await readCommandEveSettingsFromBackend(['commandEve.localModelTierId']);
    expect(bag['commandEve.localModelTierId']).toBe('gemma4-12b');
  });

  it('THROWS on a backend error (caller distinguishes failure from absence)', async () => {
    httpRequestMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(readCommandEveSettingsFromBackend(['commandEve.localModelTierId'])).rejects.toThrow('ECONNREFUSED');
  });

  it('returns {} on a successful but non-object response (defensive)', async () => {
    httpRequestMock.mockResolvedValue(undefined);
    const bag = await readCommandEveSettingsFromBackend(['commandEve.localModelTierId']);
    expect(bag).toEqual({});
  });
});
