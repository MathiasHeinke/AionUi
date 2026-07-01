/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S11 — the PII/DSGVO egress-redaction-mode resolver CORE, in isolation.
 *
 * Pins the FAIL-SAFE fail-direction the shim depends on (DIFFERENT from the money
 * resolver — there is NO last-known-good here; Privacy always fails to 'on'):
 *   - successful read of 'off' → 'off' (the conscious operator waiver);
 *   - successful read of 'on' / absent / a typo / non-string → 'on' (redact);
 *   - a backend ERROR → 'on' (always redact — never leak PII on a hiccup);
 *   - reads FRESH every call (a toggle flip is seen on the very next request).
 *
 * The last block wires the REAL backend batch reader (httpBridge + seat context
 * mocked) to prove the PER-SEAT contract end-to-end: seat A 'off' + seat B 'on'
 * each resolve correctly through the seat-scoped key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEgressRedactionModeResolver,
  normalizeEgressRedactionMode,
} from '@process/commandEve/egressRedactionModeResolverCore';

const KEY = 'commandEve.egressRedactionMode';

describe('normalizeEgressRedactionMode (fail-safe: only exact "off" disables)', () => {
  it('maps the exact string "off" to off', () => {
    expect(normalizeEgressRedactionMode('off')).toBe('off');
  });
  it('maps "on" / absent / a typo / non-string to on (redact)', () => {
    expect(normalizeEgressRedactionMode('on')).toBe('on');
    expect(normalizeEgressRedactionMode(undefined)).toBe('on');
    expect(normalizeEgressRedactionMode(null)).toBe('on');
    expect(normalizeEgressRedactionMode('Off')).toBe('on'); // case-sensitive on purpose
    expect(normalizeEgressRedactionMode('disabled')).toBe('on');
    expect(normalizeEgressRedactionMode(false)).toBe('on');
    expect(normalizeEgressRedactionMode(0)).toBe('on');
  });
});

describe('createEgressRedactionModeResolver (fresh read + fail-SAFE)', () => {
  it('a successful read of "off" returns off (the operator waiver)', async () => {
    const read = vi.fn().mockResolvedValue({ [KEY]: 'off' });
    const resolver = createEgressRedactionModeResolver(read);
    expect(await resolver()).toBe('off');
    expect(read).toHaveBeenCalledWith([KEY]);
  });

  it('a successful read of "on" returns on', async () => {
    const read = vi.fn().mockResolvedValue({ [KEY]: 'on' });
    const resolver = createEgressRedactionModeResolver(read);
    expect(await resolver()).toBe('on');
  });

  it('an ABSENT key returns on (fail-safe default = redact)', async () => {
    const read = vi.fn().mockResolvedValue({});
    const resolver = createEgressRedactionModeResolver(read);
    expect(await resolver()).toBe('on');
  });

  it('a backend ERROR returns on (fail-SAFE — no last-known-good; never leak on a hiccup)', async () => {
    const onError = vi.fn();
    // Even after a successful 'off', a subsequent error must still fail to 'on' —
    // Privacy has NO last-known-good, unlike the money resolver.
    const read = vi
      .fn()
      .mockResolvedValueOnce({ [KEY]: 'off' })
      .mockRejectedValueOnce(new Error('backend down'));
    const resolver = createEgressRedactionModeResolver(read, onError);
    expect(await resolver()).toBe('off');
    expect(await resolver()).toBe('on'); // error → redact, NOT the last 'off'
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reads FRESH every call (a toggle flip is seen on the next request)', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ [KEY]: 'on' })
      .mockResolvedValueOnce({ [KEY]: 'off' });
    const resolver = createEgressRedactionModeResolver(read);
    expect(await resolver()).toBe('on');
    expect(await resolver()).toBe('off');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

// --- PER-SEAT end-to-end through the REAL backend batch reader --------------
const httpRequestMock = vi.fn();
vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: (...args: unknown[]) => httpRequestMock(...args),
}));

import { readCommandEveSettingsFromBackend } from '@process/commandEve/commandEveBackendSettingsRead';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';
import { __resetActiveSeatForTests, setActiveSeatId } from '@process/commandEve/seatContextCore';

describe('S11 per-seat: seat A off + seat B on each resolve correctly (real batch reader)', () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    __resetActiveSeatForTests();
  });
  afterEach(() => __resetActiveSeatForTests());

  it('two seats hold independent egress modes through the seat-scoped key', async () => {
    const seatA = 'seat-alpha-gmbh';
    const seatB = 'seat-beta-ag';
    // ONE backend bag holds BOTH seats' seat-physical keys (the store shape).
    httpRequestMock.mockResolvedValue({
      [seatScopedKey(KEY, seatA)]: 'off',
      [seatScopedKey(KEY, seatB)]: 'on',
    });
    const resolver = createEgressRedactionModeResolver(readCommandEveSettingsFromBackend);

    // Active seat A → reads its 'off' (operator waiver on this seat only).
    setActiveSeatId(seatA);
    expect(await resolver()).toBe('off');

    // Active seat B → reads its own 'on' (still protected — the waiver did not leak).
    setActiveSeatId(seatB);
    expect(await resolver()).toBe('on');
  });

  it('a seat with NO explicit mode falls back to on (fail-safe) even when another seat is off', async () => {
    const seatA = 'seat-alpha-gmbh';
    const seatC = 'seat-gamma-kg';
    httpRequestMock.mockResolvedValue({
      [seatScopedKey(KEY, seatA)]: 'off',
      // seat C has no key at all.
    });
    const resolver = createEgressRedactionModeResolver(readCommandEveSettingsFromBackend);

    setActiveSeatId(seatC);
    expect(await resolver()).toBe('on'); // absent → redact
  });
});
