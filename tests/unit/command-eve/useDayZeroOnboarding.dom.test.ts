/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fix #4 + ISO-3 — the forced "Seed your Company Brain" modal must show AT MOST
 * ONCE, AND the "seeded?" truth is now sourced from per-seat ON-DISK evidence
 * (commandEve.companyBrainStatus) rather than a shared global config flag.
 *
 * `useDayZeroOnboarding` decides whether the FORCED Day-0 modal pops. These tests
 * prove the non-nagging contract:
 *  - it forces only on a first run (entitled, never seeded, never dismissed);
 *  - a "Later"/dismiss is STICKY (persists `commandEve.clientSeedDismissed`,
 *    seat-scoped per ISO-2) so it never re-pops on a later launch;
 *  - a real seed PERSISTS via the per-seat write seam (companyBrainStatus then
 *    reports seeded:true) — same non-nag result;
 *  - `enabled:false` (the Settings → Company Brain panel) NEVER force-pops, yet
 *    still exposes the seed status + records a seed.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// store/subscribers at module scope so the hoisted vi.mock captures them.
const store: Map<string, unknown> = new Map();
// Per-key config subscribers (mirrors configService.subscribe) so useConfig's
// useSyncExternalStore re-reads when set() notifies the dismissed key.
const keySubs: Map<string, Set<() => void>> = new Map();
const notifyKey = (key: string) => {
  for (const cb of keySubs.get(key) ?? []) cb();
};

vi.mock('@/common/config/configService', () => {
  const whenReady = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    configService: {
      whenReady,
      // Single-seat / legacy: the active seat never changes, so no rebind ever
      // fires and useActiveSeatId returns a stable id (byte-identical path).
      getCurrentSeatId: () => 'legacy',
      onSeatRebind: () => () => {},
      subscribe: (key: string, cb: () => void) => {
        if (!keySubs.has(key)) keySubs.set(key, new Set());
        keySubs.get(key)!.add(cb);
        return () => keySubs.get(key)?.delete(cb);
      },
      get: (k: string) => store.get(k),
      set: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
        // Notify synchronously so the useConfig read flips immediately (mirrors
        // the real configService.set, which notifies before the async PUT).
        notifyKey(k);
      }),
    },
  };
});

// ISO-3: the hook reads seeded? from commandEve.companyBrainStatus and writes
// via commandEve.companyBrainSeed. Mock a simple in-memory seeded flag.
let onDiskSeeded = false;
const companyBrainSeedInvoke = vi.fn(async (_req: { seed: { value: string } }) => {
  onDiskSeeded = true;
  return { success: true, data: { ok: true } };
});
const companyBrainStatusInvoke = vi.fn(async () => ({
  success: true,
  data: { seeded: onDiskSeeded, record: null },
}));
vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    companyBrainSeed: { invoke: (req: { seed: { value: string } }) => companyBrainSeedInvoke(req) },
    companyBrainStatus: { invoke: () => companyBrainStatusInvoke() },
  },
}));

import { useDayZeroOnboarding } from '@renderer/hooks/useDayZeroOnboarding';
import { configService } from '@/common/config/configService';

describe('useDayZeroOnboarding (fix #4: at-most-once forced modal)', () => {
  beforeEach(() => {
    store.clear();
    keySubs.clear();
    onDiskSeeded = false;
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

  it('recordSeed() with an explicit sink flips seeded and stops forcing (no global flag)', async () => {
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
    // ISO-3: the global clientSeeded flag is NEVER written anymore.
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.clientSeeded', true);
  });

  it('recordSeed() with the DEFAULT sink persists via the per-seat write seam', async () => {
    const { result } = renderHook(() => useDayZeroOnboarding({ enabled: true }));
    await waitFor(() => expect(result.current.shouldForce).toBe(true));
    await act(async () => {
      await result.current.recordSeed({ kind: 'paste_brief', value: 'real client brief' });
    });
    expect(result.current.seeded).toBe(true);
    expect(result.current.shouldForce).toBe(false);
    // The real per-seat write seam was hit (NOT a no-op, NOT the config store).
    expect(companyBrainSeedInvoke).toHaveBeenCalledOnce();
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.clientSeeded', true);
  });

  it('a per-seat on-disk seed means it never force-pops again', async () => {
    onDiskSeeded = true;
    const { result } = renderHook(() => useDayZeroOnboarding({ enabled: true }));
    await waitFor(() => expect(result.current.seeded).toBe(true));
    expect(result.current.shouldForce).toBe(false);
  });

  it('a blank/whitespace seed does NOT satisfy the requirement (no write, no flip)', async () => {
    const { result } = renderHook(() => useDayZeroOnboarding({ enabled: true }));
    await waitFor(() => expect(result.current.shouldForce).toBe(true));
    await act(async () => {
      await result.current.recordSeed({ kind: 'paste_brief', value: '   ' });
    });
    expect(result.current.seeded).toBe(false);
    expect(companyBrainSeedInvoke).not.toHaveBeenCalled();
  });
});
