/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18205-FLAG — the per-seat release resolver.
 *
 * THE CLAIM WORTH MONEY: every uncertainty resolves to OFF. Not "usually", not
 * "for the cases we thought of" — an absent key, a value nobody meant as consent,
 * a backend that throws, a backend that returns nonsense. This file enumerates
 * them rather than sampling, because the failure mode it guards is a seat
 * spending a client's credits on an answer we never actually read.
 *
 * It also pins the direction that DIFFERS from the two resolvers next door, and
 * the difference is the whole reason this module exists separately:
 *
 *   - `egressRedactionModeResolverCore` fail-SAFEs to `'on'` (always redact);
 *   - the worker-roster resolver holds a LAST-KNOWN-GOOD so a hiccup cannot
 *     resurrect a fired worker;
 *   - this one holds NOTHING. A last-known-good here would mean a backend outage
 *     keeps a spending tool OPEN on a seat whose current answer is unreadable.
 *     `it('never holds a last-known-good')` is the test that would fail if
 *     someone added a cache by analogy with the roster.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_VIDEO_GENERATE_SEAT_CONFIG_KEY as KEY,
  createAgentVideoGenerateGate,
  createAgentVideoGenerateSeatResolver,
  normalizeAgentVideoGenerateSeatValue,
} from '@/process/commandEve/agentVideoGenerateSeatResolver';
import { SEAT_SCOPED_CONFIG_KEYS, isSeatScopedConfigKey } from '@/common/config/seatConfigKeyCore';

/**
 * The STORE-SPLIT half of the claim.
 *
 * These two assertions belong conceptually in `storeSplitGuard.test.ts`, which
 * enumerates every renderer-written `commandEve.*` key and proves no main-process
 * file reads it from the WRONG store. That file is currently carrying unrelated
 * in-flight edits from another workstream, so the coverage lives here rather than
 * being tangled into someone else's commit. It should be folded back into the
 * canonical guard when that lands.
 */
describe('the key is wired into both allowlists (the seat-isolation half)', () => {
  it('is seat-scoped, so a client seat cannot read the founder seat row', () => {
    expect(SEAT_SCOPED_CONFIG_KEYS.has(KEY)).toBe(true);
    expect(isSeatScopedConfigKey(KEY)).toBe(true);
  });

  it('is in NO_LEGACY_INHERIT_KEYS — the fail-OPEN half that seat scoping alone does not close', () => {
    // Seat scoping decides WHERE the value is written. Legacy inheritance decides
    // what happens when a real seat has no value of its own — and the default
    // fallback is to read the un-prefixed founder row. For a spend switch that is
    // fail-open, so the key must appear in the reader's deny-list too. Asserted
    // against the SOURCE because the set is deliberately module-private.
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/process/commandEve/commandEveBackendSettingsRead.ts'),
      'utf8'
    );
    const denyList = source.slice(source.indexOf('NO_LEGACY_INHERIT_KEYS'), source.indexOf('function physicalKeyFor'));
    expect(denyList).toContain(KEY);
    // Positive control: the probe is looking at a real, populated slice.
    expect(denyList).toContain('commandEve.egressRedactionMode');
  });
});

describe('normalize is fail-closed and exact', () => {
  it('accepts only true / "true" / 1 / "1"', () => {
    for (const raw of [true, 'true', 1, '1']) {
      expect(normalizeAgentVideoGenerateSeatValue(raw), `${JSON.stringify(raw)} must enable`).toBe(true);
    }
  });

  it('rejects everything else, including the near-misses', () => {
    const rejected: unknown[] = [
      undefined,
      null,
      false,
      'false',
      '0',
      0,
      '',
      ' ',
      'yes',
      'on',
      'enabled',
      'TRUE', // deliberately NOT case-folded: consent is exact
      'True',
      ' true ', // untrimmed is not the value a checkbox writes
      2,
      -1,
      {},
      [],
      [true],
      { enabled: true },
      NaN,
    ];
    for (const raw of rejected) {
      expect(normalizeAgentVideoGenerateSeatValue(raw), `${JSON.stringify(raw)} must NOT enable`).toBe(false);
    }
  });
});

describe('the per-seat resolver reads fresh and fails closed', () => {
  it('enables when the seat persisted a true', async () => {
    const read = vi.fn(async () => ({ [KEY]: true }));
    await expect(createAgentVideoGenerateSeatResolver(read)()).resolves.toBe(true);
    expect(read).toHaveBeenCalledWith([KEY]);
  });

  it('is OFF when the key is absent (a seat that never decided has not consented)', async () => {
    await expect(createAgentVideoGenerateSeatResolver(async () => ({}))()).resolves.toBe(false);
  });

  it('is OFF when the backend throws — and does NOT rethrow', async () => {
    const onError = vi.fn();
    const resolver = createAgentVideoGenerateSeatResolver(async () => {
      throw new Error('backend unreachable');
    }, onError);
    await expect(resolver()).resolves.toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('never holds a last-known-good: a true followed by an outage closes the tool', async () => {
    // THE regression this file exists for. The money-roster resolver next door
    // deliberately holds its last good answer; copying that here would keep a
    // spending tool open across an outage.
    let mode: 'ok' | 'down' = 'ok';
    const resolver = createAgentVideoGenerateSeatResolver(async () => {
      if (mode === 'down') throw new Error('backend unreachable');
      return { [KEY]: true };
    });
    await expect(resolver()).resolves.toBe(true);
    mode = 'down';
    await expect(resolver()).resolves.toBe(false);
  });

  it('re-reads on every call — no caching, so a flip takes effect immediately', async () => {
    let persisted: unknown = true;
    const read = vi.fn(async () => ({ [KEY]: persisted }));
    const resolver = createAgentVideoGenerateSeatResolver(read);
    await expect(resolver()).resolves.toBe(true);
    persisted = false;
    await expect(resolver()).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('the composed gate', () => {
  function gate(over: Partial<Parameters<typeof createAgentVideoGenerateGate>[0]> = {}) {
    return createAgentVideoGenerateGate({
      readSeatRelease: async () => true,
      isKillSwitched: () => false,
      isLicenseEligible: () => true,
      ...over,
    });
  }

  it('opens only when all three conditions hold', async () => {
    await expect(gate()()).resolves.toBe(true);
  });

  it('the env kill-switch closes an otherwise-open seat', async () => {
    await expect(gate({ isKillSwitched: () => true })()).resolves.toBe(false);
  });

  it('an ineligible seat stays closed even with the config set', async () => {
    await expect(gate({ isLicenseEligible: () => false })()).resolves.toBe(false);
  });

  it('the per-seat config is the authority — no env value can grant it', async () => {
    // The inverse of the kill-switch test, and the point of the whole change:
    // with no kill-switch and a valid licence, a seat that did not tick the box
    // is still closed. There is no env spelling that overrides this.
    await expect(gate({ readSeatRelease: async () => false })()).resolves.toBe(false);
  });

  it('short-circuits before the backend read when kill-switched or ineligible', async () => {
    // Not a performance nicety: a closed seat must not emit an HTTP read whose
    // answer it could not act on, and a test that only checked the boolean would
    // pass while the read still happened.
    const readSeatRelease = vi.fn(async () => true);
    await gate({ isKillSwitched: () => true, readSeatRelease })();
    await gate({ isLicenseEligible: () => false, readSeatRelease })();
    expect(readSeatRelease).not.toHaveBeenCalled();
  });

  it('is OFF when a dependency throws', async () => {
    const onError = vi.fn();
    const thrower = gate({
      isLicenseEligible: () => {
        throw new Error('keychain locked');
      },
      onError,
    });
    await expect(thrower()).resolves.toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
