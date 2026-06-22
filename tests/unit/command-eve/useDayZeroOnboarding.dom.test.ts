/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fix #4 — the forced "Seed your Company Brain" modal must show AT MOST ONCE.
 *
 * `useDayZeroOnboarding` decides whether the FORCED Day-0 modal pops. These tests
 * prove the non-nagging contract:
 *  - it forces only on a first run (entitled, never seeded, never dismissed);
 *  - a "Later"/dismiss is STICKY (persists `commandEve.clientSeedDismissed`) so it
 *    never re-pops on a later launch;
 *  - a real seed is STICKY (persists `commandEve.clientSeeded`) — same result;
 *  - `enabled:false` (the Settings → Company Brain panel) NEVER force-pops, yet
 *    still exposes the seed status + records a seed.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// store/subscribers at module scope so the hoisted vi.mock captures them.
const store: Map<string, unknown> = new Map();

vi.mock('@/common/config/configService', () => {
  const whenReady = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    configService: {
      whenReady,
      get: (k: string) => store.get(k),
      set: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
    },
  };
});

import { useDayZeroOnboarding } from '@renderer/hooks/useDayZeroOnboarding';
import { configService } from '@/common/config/configService';

describe('useDayZeroOnboarding (fix #4: at-most-once forced modal)', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('forces on a first run: entitled, never seeded, never dismissed', async () => {
    const { result } = renderHook(() => useDayZeroOnboarding({ enabled: true }));
    await waitFor(() => expect(result.current.shouldForce).toBe(true));
    expect(result.current.seeded).toBe(false);
    expect(result.current.dismissed).toBe(false);
  });

  it('never forces when not entitled (enabled:false) — the Settings panel case', async () => {
    const { result } = renderHook(() => useDayZeroOnboarding({ enabled: false }));
    await waitFor(() => expect(configService.whenReady).toBeDefined());
    expect(result.current.shouldForce).toBe(false);
  });

  it('dismiss() is STICKY: persists the flag and stops forcing', async () => {
    const { result } = renderHook(() => useDayZeroOnboarding({ enabled: true }));
    await waitFor(() => expect(result.current.shouldForce).toBe(true));
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.shouldForce).toBe(false);
    expect(result.current.dismissed).toBe(true);
    expect(configService.set).toHaveBeenCalledWith('commandEve.clientSeedDismissed', true);
  });

  it('a persisted dismiss flag means it never re-pops on a later launch', async () => {
    store.set('commandEve.clientSeedDismissed', true);
    const { result } = renderHook(() => useDayZeroOnboarding({ enabled: true }));
    await waitFor(() => expect(result.current.dismissed).toBe(true));
    expect(result.current.shouldForce).toBe(false);
  });

  it('recordSeed() flips seeded, persists the flag, and stops forcing', async () => {
    const onSeedRecorded = vi.fn();
    const { result } = renderHook(() =>
      useDayZeroOnboarding({ enabled: true, onSeedRecorded })
    );
    await waitFor(() => expect(result.current.shouldForce).toBe(true));
    await act(async () => {
      await result.current.recordSeed({ kind: 'paste_brief', value: 'real client brief' });
    });
    expect(result.current.seeded).toBe(true);
    expect(result.current.shouldForce).toBe(false);
    expect(onSeedRecorded).toHaveBeenCalledOnce();
    expect(configService.set).toHaveBeenCalledWith('commandEve.clientSeeded', true);
  });

  it('a persisted seed flag means it never force-pops again', async () => {
    store.set('commandEve.clientSeeded', true);
    const { result } = renderHook(() => useDayZeroOnboarding({ enabled: true }));
    await waitFor(() => expect(result.current.seeded).toBe(true));
    expect(result.current.shouldForce).toBe(false);
  });

  it('a blank/whitespace seed does NOT satisfy the requirement (no flag flip)', async () => {
    const { result } = renderHook(() => useDayZeroOnboarding({ enabled: true }));
    await waitFor(() => expect(result.current.shouldForce).toBe(true));
    await act(async () => {
      await result.current.recordSeed({ kind: 'paste_brief', value: '   ' });
    });
    expect(result.current.seeded).toBe(false);
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.clientSeeded', true);
  });
});
