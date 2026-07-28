/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The start screen must state the ACTIVE seat's mode — including downwards.
 *
 * Found in the packaged 1.820.0 build, not deduced: switching from a seat at
 * "Auto-Edits" into a seat that had never chosen anything left "Auto-Edits" on
 * screen. Subscribing to the seat-scoped grant (so the effect re-runs at all)
 * was necessary and not sufficient — the resolution itself could only ever
 * RAISE the displayed mode. A seat with no stored preference matched neither
 * branch, so the previous seat's answer simply stood.
 *
 * That is the same leak 1.820 exists to close, taking a different door: not a
 * shared config key this time, but shared in-memory state. The start screen is
 * where a session is opened, so the mode it displays is the mode the seat runs
 * at.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/common/config/configService', () => ({
  configService: { get: () => undefined, set: async () => {} },
}));

const { resolveStartScreenMode } = await import('@/renderer/pages/guid/hooks/agentSelectionUtils');

const base = { agentKey: 'hermes', preferred: undefined, yoloMode: false, fallbackMode: 'default' };

describe('the start screen states the seat it is in', () => {
  it('falls back to the default when the new seat stored nothing', () => {
    // The load-bearing case. Seat A was at accept_edits; seat B chose nothing.
    expect(resolveStartScreenMode({ ...base, seatChanged: true })).toBe('default');
  });

  it('shows what THIS seat stored', () => {
    expect(resolveStartScreenMode({ ...base, preferred: 'accept_edits', seatChanged: true })).toBe('accept_edits');
  });

  it('leaves the mode alone when nothing is stored and the seat did not change', () => {
    // An SWR revalidation re-runs the effect with the same grant. Resetting here
    // is the start-screen permission-reset bug: it would clobber a pick that has
    // been made but whose write has not come back yet.
    expect(resolveStartScreenMode({ ...base, seatChanged: false })).toBeUndefined();
  });

  it('prefers a stored value over the reset even on a seat switch', () => {
    // Ordering matters: a seat that DID choose must not be reset to the default
    // just because the switch happened.
    expect(resolveStartScreenMode({ ...base, preferred: 'dont_ask', seatChanged: true })).toBe('dont_ask');
  });

  it('ignores a stored value this backend cannot offer', () => {
    // A mode the backend does not expose would leave the selector showing a
    // value nothing enforces — the same defect as rung 4 on the Freigaben page.
    expect(resolveStartScreenMode({ ...base, preferred: 'not-a-real-mode', seatChanged: true })).toBe('default');
  });

  it('still honours a legacy yolo install', () => {
    // Pre-1.820 installs carry `yoloMode` rather than a mode string. EVE spells
    // it `dont_ask`; the bare 'yolo' fallback is a value hermes does not know.
    expect(resolveStartScreenMode({ ...base, yoloMode: true, seatChanged: true })).toBe('dont_ask');
    expect(resolveStartScreenMode({ ...base, agentKey: 'gemini', yoloMode: true, seatChanged: true })).toBe('yolo');
  });

  it('does not let a legacy yolo flag survive into a seat that stored nothing', () => {
    // yoloMode comes from the SAME per-seat read as `preferred`. If the new seat
    // reports neither, the reset must win — otherwise the legacy branch would be
    // the new way one seat's autonomy reaches another.
    expect(resolveStartScreenMode({ ...base, yoloMode: false, seatChanged: true })).toBe('default');
  });
});
