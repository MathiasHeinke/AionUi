/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HONCHO-Inc.3 / P5 — the NON-blocking onboarding memory-lane. Pins: a not-ready
 * Honcho is a soft SKIP (never 'blocked', never alarming), and it NEVER factors
 * into first_value_ready (licensed + cloud bearer only).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCommandEveOnboardingStatus,
  type CommandEveOnboardingStatusModel,
  type CommandEveOnboardingStatusOptions,
} from '@/process/commandEve/onboardingStatusCore';
import {
  HONCHO_REASON_DECLINED,
  HONCHO_REASON_DERIVER_UNREACHABLE,
  HONCHO_STATE_DEGRADED,
  HONCHO_STATE_READY,
  type HonchoReadinessState,
} from '@/process/commandEve/honchoReadinessCore';

type Ent = ReturnType<NonNullable<CommandEveOnboardingStatusOptions['readEntitlement']>>;
const ent = (state: string, reason_code?: string): Ent => ({ state, reason_code }) as unknown as Ent;

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-honcho-onboard-'));
});
afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

let seq = 0;
const MISSING = () => path.join(tmp, `nope-${seq++}.json`);

function build(opts: Partial<CommandEveOnboardingStatusOptions>): CommandEveOnboardingStatusModel {
  const res = buildCommandEveOnboardingStatus({
    userDataPath: tmp,
    receiptPath: MISSING(),
    firstRunProfilePath: MISSING(),
    now: () => new Date('2026-07-04T00:00:00.000Z'),
    readEntitlement: opts.readEntitlement ?? (() => ent('entitled')),
    readLicenseWirePresence: opts.readLicenseWirePresence ?? (() => true),
    ...opts,
  });
  expect(res.ok, `${res.reason_code ?? ''} ${res.message ?? ''}`).toBe(true);
  return res.model!;
}
const memoryItem = (m: CommandEveOnboardingStatusModel) => m.items.find((i) => i.id === 'memory-lane');

const READY: HonchoReadinessState = { seatId: 'a1', state: HONCHO_STATE_READY, serverUp: true, deriverReachable: true, probedAt: '2026-07-04T00:00:00.000Z' };

describe('onboarding memory-lane (P5) — present + non-blocking', () => {
  it('is always present in the items list', () => {
    expect(memoryItem(build({}))).toBeDefined();
  });

  it('no honcho state ⇒ soft skip (memory falls back to Company Brain)', () => {
    const it0 = memoryItem(build({}));
    expect(it0?.state).toBe('skipped');
    expect(it0?.remediation_kind).toBe('none');
  });

  it('ready ⇒ ok', () => {
    const it0 = memoryItem(build({ readHonchoState: () => READY }));
    expect(it0?.state).toBe('ok');
  });

  it('declined ⇒ skip with the declined reason (not blocked)', () => {
    const it0 = memoryItem(build({ readHonchoState: () => ({ ...READY, state: 'off', serverUp: false, deriverReachable: false, reasonCode: HONCHO_REASON_DECLINED }) }));
    expect(it0?.state).toBe('skipped');
    expect(it0?.reason_code).toBe(HONCHO_REASON_DECLINED);
  });

  it('degraded/unreachable ⇒ soft skip, NEVER blocked', () => {
    const it0 = memoryItem(build({ readHonchoState: () => ({ ...READY, state: HONCHO_STATE_DEGRADED, deriverReachable: false, reasonCode: HONCHO_REASON_DERIVER_UNREACHABLE }) }));
    expect(it0?.state).toBe('skipped');
    expect(it0?.state).not.toBe('blocked');
  });
});

describe('onboarding memory-lane (P5) — first_value_ready is untouched', () => {
  it('a NOT-ready Honcho does not lower first_value_ready for a licensed+bearer user', () => {
    const m = build({ readLicenseWirePresence: () => true, readHonchoState: () => undefined });
    expect(m.first_value_ready).toBe(true);
  });
  it('a READY Honcho does not raise first_value_ready for an unlicensed user', () => {
    const m = build({ readEntitlement: () => ent('registered_unlicensed'), readLicenseWirePresence: () => false, readHonchoState: () => READY });
    expect(m.first_value_ready).toBe(false);
  });
});
