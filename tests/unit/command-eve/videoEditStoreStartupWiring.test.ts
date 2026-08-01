/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 round 5 — THE STARTUP CALL IS EXECUTED, not merely written down.
 *
 * `videoEditStoreHealthBoundary.test.ts` proves what the sweep and the gate DO.
 * This file proves that main-process startup actually performs the sweep, by
 * running the real `initializeProcess` from `packages/desktop/src/process/index.ts`
 * — the function `packages/desktop/src/index.ts` awaits during app boot — rather
 * than by asserting that a line exists somewhere.
 *
 * Only the Electron-shaped seams around it are stubbed: the electron module
 * itself, the storage init, the bridge registration and i18n. The video spend
 * store, the filesystem and the health state are the real ones.
 *
 * WHY IT MATTERS THAT THIS RUNS. The refusal after a restart is guaranteed by
 * the gate in the paid handler whether or not startup sweeps; what the sweep buys
 * is the other half of the contract — a COMPLETED edit stays recoverable from its
 * receipt after a restart instead of being refused until the user happens to send
 * something. A startup that silently stopped sweeping would turn a free retry
 * into a refusal, and nothing else in the app would notice.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataRoot: string;

// The Electron-shaped seams. None of them is on the path under test.
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('@/common/platform/register-electron', () => ({}));
vi.mock('@process/utils/configureChromium', () => ({}));
vi.mock('@process/utils/initBridge', () => ({}));
vi.mock('@process/services/i18n', () => ({}));
vi.mock('@process/utils/initStorage', () => ({ default: async () => undefined }));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => dataRoot }));

import {
  isVideoEditSpendStoreHealthy,
  readVideoEditSpendStoreHealth,
} from '@/process/commandEve/videoEditSpendPermitStore';

const spendPermitDir = () => path.join(dataRoot, 'command-eve-artifact-capabilities', 'spend-permits');

/**
 * A live permit record and an active-turn pointer left behind by a previous
 * process — written by hand so this file does not depend on the mint path.
 */
function seedLiveAuthorities(): { record: string; pointer: string; receipt: string } {
  const key = 'a'.repeat(64);
  const dir = spendPermitDir();
  fs.mkdirSync(path.join(dir, 'turns'), { recursive: true, mode: 0o700 });
  const record = path.join(dir, `${key}.json`);
  fs.writeFileSync(
    record,
    `${JSON.stringify({
      conversation_id: 'conv-1',
      operation: 'video_edit',
      user_turn_sha256: 'b'.repeat(64),
      allowed_artifact_sha256: ['c'.repeat(64)],
      issued_at_ms: Date.now(),
      expires_at_ms: Date.now() + 900_000,
    })}\n`
  );
  const pointer = path.join(dir, 'turns', `${'d'.repeat(64)}.active.json`);
  fs.writeFileSync(pointer, `${JSON.stringify({ user_turn_sha256: 'b'.repeat(64), observed_at_ms: Date.now() })}\n`);
  // A completed receipt, which must survive.
  const receipt = path.join(dir, `${key}.result.json`);
  fs.writeFileSync(receipt, `${JSON.stringify({ artifact_id: 'video-1', completed_at_ms: Date.now() })}\n`);
  return { record, pointer, receipt };
}

beforeEach(() => {
  vi.clearAllMocks();
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-startup-'));
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('MAT-1747 round 5 — main-process startup really reinitializes the video-edit spend store', () => {
  it('initializeProcess deletes the live authorities left by a previous process and proves the store', async () => {
    const seeded = seedLiveAuthorities();
    // The state a freshly started process is in before startup runs.
    expect(readVideoEditSpendStoreHealth()).toBe('unproven');
    expect(isVideoEditSpendStoreHealthy()).toBe(false);

    const { initializeProcess } = await import('@/process/index');
    await initializeProcess();

    // Live authority: gone.
    expect(fs.existsSync(seeded.record)).toBe(false);
    expect(fs.existsSync(seeded.pointer)).toBe(false);
    // Completed receipt: kept, because it is what stops a legitimate retry
    // becoming a second charge.
    expect(fs.existsSync(seeded.receipt)).toBe(true);
    // And the process now has something it can honestly claim.
    expect(readVideoEditSpendStoreHealth()).toBe('healthy');
    expect(isVideoEditSpendStoreHealthy()).toBe(true);
  });
});
