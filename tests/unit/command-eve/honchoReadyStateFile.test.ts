/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HONCHO-Inc.3 / P6 — the readiness state-file bridge. Round-trips a snapshot and
 * pins the FAIL-SAFE read: absent / corrupt / non-object ⇒ undefined (never throw,
 * never a false-ready).
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  HONCHO_READINESS_FILENAME,
  honchoReadinessPath,
  readHonchoReadyState,
  writeHonchoReadyState,
} from '@/process/commandEve/honchoReadyStateFile';
import { HONCHO_STATE_READY } from '@/process/commandEve/honchoReadinessCore';

const dirs: string[] = [];
function tmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'honcho-ready-'));
  dirs.push(d);
  return path.join(d, 'honcho'); // a not-yet-existing honchoHome (write must mkdir)
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SNAP = {
  seatId: 'a1b2',
  state: HONCHO_STATE_READY,
  serverUp: true,
  deriverReachable: true,
  probedAt: '2026-07-04T12:00:00.000Z',
};

describe('honchoReadyStateFile — round trip', () => {
  it('writes (creating the dir) and reads back an identical snapshot', () => {
    const home = tmpHome();
    writeHonchoReadyState(home, SNAP);
    expect(fs.existsSync(honchoReadinessPath(home))).toBe(true);
    expect(readHonchoReadyState(home)).toEqual(SNAP);
    expect(honchoReadinessPath(home).endsWith(HONCHO_READINESS_FILENAME)).toBe(true);
  });

  it('the last write wins (atomic overwrite)', () => {
    const home = tmpHome();
    writeHonchoReadyState(home, SNAP);
    writeHonchoReadyState(home, { ...SNAP, state: 'degraded', deriverReachable: false });
    expect(readHonchoReadyState(home)?.state).toBe('degraded');
  });
});

describe('honchoReadyStateFile — fail-safe read', () => {
  it('returns undefined for an absent file (never throws)', () => {
    expect(readHonchoReadyState(tmpHome())).toBeUndefined();
  });
  it('returns undefined for invalid JSON', () => {
    const home = tmpHome();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(honchoReadinessPath(home), '{ not json', 'utf8');
    expect(readHonchoReadyState(home)).toBeUndefined();
  });
  it('returns undefined for a non-object JSON (array / scalar)', () => {
    const home = tmpHome();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(honchoReadinessPath(home), '[1,2,3]', 'utf8');
    expect(readHonchoReadyState(home)).toBeUndefined();
    fs.writeFileSync(honchoReadinessPath(home), '42', 'utf8');
    expect(readHonchoReadyState(home)).toBeUndefined();
  });
});
