/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S9 #1 — the team-worker-status resolver CORE, in isolation (fake reader, no
 * HTTP). Pins the fresh-read + last-known-good fail-direction the shim depends on:
 *   - success → return the fresh map AND refresh last-known-good;
 *   - success-but-key-absent → undefined (no gating) AND seed last-known-good = {};
 *   - error → return last-known-good (undefined until a first success).
 */

import { describe, expect, it, vi } from 'vitest';
import { createTeamWorkerStatusResolver } from '@process/commandEve/teamWorkerStatusResolverCore';

const KEY = 'commandEve.teamWorkerStatus';

describe('createTeamWorkerStatusResolver (fresh read + last-known-good)', () => {
  it('a fresh successful read returns the live status map', async () => {
    const read = vi.fn().mockResolvedValue({ [KEY]: { ceo: 'off' } });
    const resolver = createTeamWorkerStatusResolver(read);
    expect(await resolver()).toEqual({ ceo: 'off' });
    expect(read).toHaveBeenCalledWith([KEY]);
  });

  it('reads FRESH every call (no TTL cache): a status change is seen on the next call', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ [KEY]: { ceo: 'active' } })
      .mockResolvedValueOnce({ [KEY]: { ceo: 'off' } });
    const resolver = createTeamWorkerStatusResolver(read);
    expect(await resolver()).toEqual({ ceo: 'active' });
    expect(await resolver()).toEqual({ ceo: 'off' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('an error AFTER a successful read returns the LAST-KNOWN-GOOD map', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ [KEY]: { ceo: 'off' } })
      .mockRejectedValueOnce(new Error('backend down'));
    const onError = vi.fn();
    const resolver = createTeamWorkerStatusResolver(read, undefined, onError);

    expect(await resolver()).toEqual({ ceo: 'off' }); // seeds last-known-good
    expect(await resolver()).toEqual({ ceo: 'off' }); // hiccup → holds the line
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("SEAT-KEYED last-known-good: a hiccup on seat B never serves seat A's roster", async () => {
    // Seat B fires a worker (off); switch to seat A (worker active); switch back to
    // seat B and the read HICCUPS — the resolver must hold seat B's OWN 'off', never
    // resurrect seat B's worker from seat A's 'active'.
    let seat = 'seat-B';
    const read = vi
      .fn()
      .mockResolvedValueOnce({ [KEY]: { worker: 'off' } }) // seat B read
      .mockResolvedValueOnce({ [KEY]: { worker: 'active' } }) // seat A read
      .mockRejectedValueOnce(new Error('backend hiccup')); // seat B read fails
    const resolver = createTeamWorkerStatusResolver(read, () => seat);

    expect(await resolver()).toEqual({ worker: 'off' }); // seat B — LKG[B] = off
    seat = 'seat-A';
    expect(await resolver()).toEqual({ worker: 'active' }); // seat A — LKG[A] = active
    seat = 'seat-B';
    // Seat B hiccup → returns seat B's own LKG ('off'), NOT seat A's 'active'.
    expect(await resolver()).toEqual({ worker: 'off' });
  });

  it('SEAT-KEYED: a hiccup on a never-read seat returns undefined (no cross-seat gating leak)', async () => {
    let seat = 'seat-A';
    const read = vi
      .fn()
      .mockResolvedValueOnce({ [KEY]: { worker: 'off' } }) // seat A read
      .mockRejectedValueOnce(new Error('backend hiccup')); // seat C read fails (never read)
    const resolver = createTeamWorkerStatusResolver(read, () => seat);
    expect(await resolver()).toEqual({ worker: 'off' }); // seat A
    seat = 'seat-C';
    expect(await resolver()).toBeUndefined(); // seat C never read → no roster, no gating
  });

  it('an error BEFORE any successful read returns undefined (fail-open, no gating)', async () => {
    const read = vi.fn().mockRejectedValue(new Error('backend down'));
    const resolver = createTeamWorkerStatusResolver(read);
    expect(await resolver()).toBeUndefined();
  });

  it('a successful-but-absent read returns undefined and cannot be resurrected by a later error', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({}) // key absent → no map
      .mockRejectedValueOnce(new Error('backend down'));
    const resolver = createTeamWorkerStatusResolver(read);
    expect(await resolver()).toBeUndefined(); // seeds last-known-good = {}
    // A later hiccup must NOT resurrect a stale roster: last-known-good is {}.
    expect(await resolver()).toEqual({});
  });
});
