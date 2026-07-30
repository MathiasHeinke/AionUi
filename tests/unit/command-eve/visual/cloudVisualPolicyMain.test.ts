/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCommandEveCloudVisualPolicyReceiptsForTests,
  issueCommandEveCloudVisualPolicyReceipt,
  readCommandEveCloudVisualPolicy,
  retireCommandEveCloudVisualPolicyReceipt,
  setCommandEveCloudVisualPolicy,
  verifyCommandEveCloudVisualPolicyReceipt,
} from '@/process/commandEve/visual/cloudVisualPolicyMain';

const SEAT_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const SEAT_B = 'ffeeddcc-bbaa-4321-9988-776655443322';
const LOGICAL_KEY = 'commandEve.cloudVisualAnalysisEnabled';
const KEY_A = `seat:${SEAT_A}:${LOGICAL_KEY}`;
const KEY_B = `seat:${SEAT_B}:${LOGICAL_KEY}`;
const FLOW_A = 'visual_flow_0123456789abcdef';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(initial: Record<string, unknown> = {}, seatId = SEAT_A) {
  let activeSeatId = seatId;
  let revision = 1;
  const bag = { ...initial };
  const deps = {
    getActiveSeatId: () => activeSeatId,
    getActiveSeatContextRevision: () => revision,
    readSettings: async (): Promise<unknown> => ({ ...bag }),
    writeSettings: async (patch: Readonly<Record<string, unknown>>): Promise<void> => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete bag[key];
        else bag[key] = value;
      }
    },
  };
  return {
    bag,
    deps,
    switchSeat(nextSeatId: string) {
      activeSeatId = nextSeatId;
      revision += 1;
    },
  };
}

beforeEach(() => {
  clearCommandEveCloudVisualPolicyReceiptsForTests();
});

afterEach(() => {
  clearCommandEveCloudVisualPolicyReceiptsForTests();
});

describe('strict exact-key visual policy read', () => {
  it('maps healthy absence, exact true, and exact false', async () => {
    const state = harness();
    await expect(readCommandEveCloudVisualPolicy(state.deps)).resolves.toMatchObject({
      status: 'enabled',
      reason: 'enabled_by_product_default',
      seatId: SEAT_A,
      physicalKey: KEY_A,
    });

    state.bag[KEY_A] = true;
    await expect(readCommandEveCloudVisualPolicy(state.deps)).resolves.toMatchObject({
      status: 'enabled',
      reason: 'enabled_explicit_compat',
    });

    state.bag[KEY_A] = false;
    await expect(readCommandEveCloudVisualPolicy(state.deps)).resolves.toMatchObject({
      status: 'disabled',
      reason: 'disabled_by_operator',
    });
  });

  it.each([null, undefined, 'true', 1, {}, []])('treats own malformed value %j as unavailable', async (value) => {
    const state = harness({ [KEY_A]: value });
    await expect(readCommandEveCloudVisualPolicy(state.deps)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'malformed_stored_value',
    });
  });

  it.each([null, undefined, 'bad', 1, []])('treats malformed settings response %j as unavailable', async (value) => {
    const state = harness();
    await expect(
      readCommandEveCloudVisualPolicy({ ...state.deps, readSettings: async () => value })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_settings_response' });
  });

  it('treats a settings read error as unavailable', async () => {
    const state = harness();
    await expect(
      readCommandEveCloudVisualPolicy({
        ...state.deps,
        readSettings: async () => {
          throw new Error('backend down');
        },
      })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'settings_read_failed' });
  });

  it('never inherits the legacy key or another real seat key', async () => {
    const state = harness({ [LOGICAL_KEY]: false, [KEY_B]: false });
    await expect(readCommandEveCloudVisualPolicy(state.deps)).resolves.toMatchObject({
      status: 'enabled',
      reason: 'enabled_by_product_default',
      physicalKey: KEY_A,
    });
  });

  it('uses the unprefixed key only for the legacy owner seat', async () => {
    const state = harness({ [LOGICAL_KEY]: false }, 'seat-1');
    await expect(readCommandEveCloudVisualPolicy(state.deps)).resolves.toMatchObject({
      status: 'disabled',
      physicalKey: LOGICAL_KEY,
      seatId: 'seat-1',
    });
  });

  it('rejects A→B and A→B→A races while a read is pending', async () => {
    const pendingAB = deferred<unknown>();
    const stateAB = harness();
    const readAB = readCommandEveCloudVisualPolicy({ ...stateAB.deps, readSettings: () => pendingAB.promise });
    stateAB.switchSeat(SEAT_B);
    pendingAB.resolve({});
    await expect(readAB).resolves.toMatchObject({ status: 'unavailable', reason: 'seat_changed' });

    const pendingABA = deferred<unknown>();
    const stateABA = harness();
    const readABA = readCommandEveCloudVisualPolicy({ ...stateABA.deps, readSettings: () => pendingABA.promise });
    stateABA.switchSeat(SEAT_B);
    stateABA.switchSeat(SEAT_A);
    pendingABA.resolve({});
    await expect(readABA).resolves.toMatchObject({ status: 'unavailable', reason: 'seat_changed' });
  });
});

describe('exact-key visual policy mutation', () => {
  it('writes false to disable and null-removes exactly that key to re-enable', async () => {
    const state = harness({ [KEY_B]: false });
    await expect(
      setCommandEveCloudVisualPolicy({ expectedSeatId: SEAT_A, enabled: false }, state.deps)
    ).resolves.toMatchObject({ ok: true, policy: { status: 'disabled' } });
    expect(state.bag[KEY_A]).toBe(false);
    expect(state.bag[KEY_B]).toBe(false);

    await expect(
      setCommandEveCloudVisualPolicy({ expectedSeatId: SEAT_A, enabled: true }, state.deps)
    ).resolves.toMatchObject({
      ok: true,
      policy: { status: 'enabled', reason: 'enabled_by_product_default' },
    });
    expect(Object.hasOwn(state.bag, KEY_A)).toBe(false);
    expect(state.bag[KEY_B]).toBe(false);
  });

  it('rejects a stale expected seat and performs no write', async () => {
    const state = harness();
    await expect(
      setCommandEveCloudVisualPolicy({ expectedSeatId: SEAT_B, enabled: false }, state.deps)
    ).resolves.toMatchObject({ ok: false, policy: { reason: 'seat_changed' } });
    expect(state.bag).toEqual({});
  });

  it('does not report success if the seat changes during the write', async () => {
    const pending = deferred<void>();
    const state = harness();
    const mutation = setCommandEveCloudVisualPolicy(
      { expectedSeatId: SEAT_A, enabled: false },
      { ...state.deps, writeSettings: () => pending.promise }
    );
    state.switchSeat(SEAT_B);
    pending.resolve();
    await expect(mutation).resolves.toMatchObject({ ok: false, policy: { reason: 'seat_changed' } });
  });

  it('keeps the verification read bound to the original capture across A→B→A', async () => {
    const state = harness();
    let seatReads = 0;
    const deps = {
      ...state.deps,
      getActiveSeatId: () => {
        seatReads += 1;
        if (seatReads === 3) {
          state.switchSeat(SEAT_B);
          state.switchSeat(SEAT_A);
        }
        return state.deps.getActiveSeatId();
      },
    };

    await expect(
      setCommandEveCloudVisualPolicy({ expectedSeatId: SEAT_A, enabled: false }, deps)
    ).resolves.toMatchObject({ ok: false, policy: { status: 'unavailable', reason: 'seat_changed' } });
  });
});

describe('bounded process-local flow receipts', () => {
  it('issues a versioned receipt and verifies flow, seat, revision, and expiry', async () => {
    const state = harness();
    const issued = await issueCommandEveCloudVisualPolicyReceipt(FLOW_A, state.deps, {
      nowMs: 1_000,
      randomReceiptId: () => 'r'.repeat(43),
    });
    expect(issued).toMatchObject({
      ok: true,
      receipt: {
        version: 'command-eve-cloud-visual-policy/v1',
        receiptId: 'r'.repeat(43),
        flowId: FLOW_A,
        expiresAt: new Date(301_000).toISOString(),
      },
    });
    if (!issued.ok) throw new Error('receipt was not issued');

    expect(verifyCommandEveCloudVisualPolicyReceipt(issued.receipt, FLOW_A, state.deps, 300_999)).toMatchObject({
      ok: true,
      seatId: SEAT_A,
      flowId: FLOW_A,
    });
    expect(
      verifyCommandEveCloudVisualPolicyReceipt({ ...issued.receipt, flowId: `${FLOW_A}_tampered` }, FLOW_A, state.deps)
    ).toEqual({ ok: false, reason: 'receipt_invalid' });

    state.switchSeat(SEAT_B);
    expect(verifyCommandEveCloudVisualPolicyReceipt(issued.receipt, FLOW_A, state.deps, 2_000)).toEqual({
      ok: false,
      reason: 'receipt_seat_mismatch',
    });
    state.switchSeat(SEAT_A);
    expect(verifyCommandEveCloudVisualPolicyReceipt(issued.receipt, FLOW_A, state.deps, 2_000)).toEqual({
      ok: false,
      reason: 'seat_changed',
    });
  });

  it('keeps preparation verification reusable, then retires exactly once for final marker mint', async () => {
    const state = harness();
    const issued = await issueCommandEveCloudVisualPolicyReceipt(FLOW_A, state.deps, {
      nowMs: 1_000,
      randomReceiptId: () => 'r'.repeat(43),
    });
    if (!issued.ok) throw new Error('receipt was not issued');

    const verified = verifyCommandEveCloudVisualPolicyReceipt(issued.receipt, FLOW_A, state.deps, 2_000);
    if (!verified.ok) throw new Error('receipt was not verified');
    expect(verifyCommandEveCloudVisualPolicyReceipt(issued.receipt, FLOW_A, state.deps, 2_000).ok).toBe(true);

    expect(retireCommandEveCloudVisualPolicyReceipt(issued.receipt, FLOW_A, verified, state.deps, 2_000)).toBe(true);
    expect(verifyCommandEveCloudVisualPolicyReceipt(issued.receipt, FLOW_A, state.deps, 2_000)).toEqual({
      ok: false,
      reason: 'receipt_unknown',
    });
    expect(retireCommandEveCloudVisualPolicyReceipt(issued.receipt, FLOW_A, verified, state.deps, 2_000)).toBe(false);
  });

  it('does not retire a receipt against a stale or mismatched verified claim', async () => {
    const state = harness();
    const issued = await issueCommandEveCloudVisualPolicyReceipt(FLOW_A, state.deps, {
      nowMs: 1_000,
      randomReceiptId: () => 'r'.repeat(43),
    });
    if (!issued.ok) throw new Error('receipt was not issued');

    const verified = verifyCommandEveCloudVisualPolicyReceipt(issued.receipt, FLOW_A, state.deps, 2_000);
    if (!verified.ok) throw new Error('receipt was not verified');
    expect(
      retireCommandEveCloudVisualPolicyReceipt(
        issued.receipt,
        FLOW_A,
        { ...verified, seatContextRevision: verified.seatContextRevision + 1 },
        state.deps,
        2_000
      )
    ).toBe(false);
    expect(verifyCommandEveCloudVisualPolicyReceipt(issued.receipt, FLOW_A, state.deps, 2_000).ok).toBe(true);
  });

  it('does not issue on disabled, unavailable, or invalid flow IDs', async () => {
    const disabled = harness({ [KEY_A]: false });
    await expect(issueCommandEveCloudVisualPolicyReceipt(FLOW_A, disabled.deps)).resolves.toMatchObject({
      ok: false,
      policy: { status: 'disabled' },
    });

    const unavailable = harness({ [KEY_A]: null });
    await expect(issueCommandEveCloudVisualPolicyReceipt(FLOW_A, unavailable.deps)).resolves.toMatchObject({
      ok: false,
      policy: { status: 'unavailable' },
    });

    const enabled = harness();
    await expect(issueCommandEveCloudVisualPolicyReceipt('bad flow', enabled.deps)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('uses one capture and refuses an A→B→A switch after the policy read', async () => {
    const state = harness();
    let seatReads = 0;
    const deps = {
      ...state.deps,
      getActiveSeatId: () => {
        seatReads += 1;
        if (seatReads === 3) {
          state.switchSeat(SEAT_B);
          state.switchSeat(SEAT_A);
        }
        return state.deps.getActiveSeatId();
      },
    };

    const issued = await issueCommandEveCloudVisualPolicyReceipt(FLOW_A, deps, {
      nowMs: 1_000,
      randomReceiptId: () => 'x'.repeat(43),
    });
    expect(issued).toMatchObject({
      ok: false,
      policy: { status: 'unavailable', reason: 'seat_changed' },
    });
    expect(
      verifyCommandEveCloudVisualPolicyReceipt(
        {
          version: 'command-eve-cloud-visual-policy/v1',
          receiptId: 'x'.repeat(43),
          flowId: FLOW_A,
          expiresAt: new Date(301_000).toISOString(),
        },
        FLOW_A,
        state.deps,
        2_000
      )
    ).toEqual({ ok: false, reason: 'receipt_unknown' });
  });

  it('expires receipts and evicts the oldest entry at capacity', async () => {
    const state = harness();
    let firstReceipt: Awaited<ReturnType<typeof issueCommandEveCloudVisualPolicyReceipt>> | undefined;
    let latestReceipt: Awaited<ReturnType<typeof issueCommandEveCloudVisualPolicyReceipt>> | undefined;
    for (let index = 0; index < 65; index += 1) {
      const issued = await issueCommandEveCloudVisualPolicyReceipt(
        `visual_flow_${String(index).padStart(16, '0')}`,
        state.deps,
        {
          nowMs: 1_000,
          randomReceiptId: () => `${String(index).padStart(32, '0')}receipt`,
        }
      );
      if (index === 0) firstReceipt = issued;
      if (index === 64) latestReceipt = issued;
    }
    if (!firstReceipt?.ok || !latestReceipt?.ok) throw new Error('capacity receipts were not issued');

    expect(
      verifyCommandEveCloudVisualPolicyReceipt(firstReceipt.receipt, firstReceipt.receipt.flowId, state.deps, 2_000)
    ).toEqual({
      ok: false,
      reason: 'receipt_unknown',
    });
    expect(
      verifyCommandEveCloudVisualPolicyReceipt(latestReceipt.receipt, latestReceipt.receipt.flowId, state.deps, 2_000)
        .ok
    ).toBe(true);
    expect(
      verifyCommandEveCloudVisualPolicyReceipt(latestReceipt.receipt, latestReceipt.receipt.flowId, state.deps, 301_000)
    ).toEqual({
      ok: false,
      reason: 'receipt_expired',
    });
  });
});
