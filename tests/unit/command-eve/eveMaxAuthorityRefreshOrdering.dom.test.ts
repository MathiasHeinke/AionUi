/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE MAX REFRESH MUST WAIT ON THE WRITE — not on the notification, not on a clock.
 *
 * THE DEFECT (CAO round 10, F1). `useEveMaxAuthority` re-asks the MAIN process
 * whenever the persisted inference selection changes. That is the right
 * architecture — but `configService.set` used to call `notify()` BEFORE awaiting
 * the backend PUT. So the re-ask raced the write: main answers by reading the
 * PERSISTED selection, and at that instant the persisted selection was still the
 * OLD one. The composer could paint a decision for the value the user had just
 * replaced. And a PUT that FAILED still signalled, painting a state nothing was
 * in.
 *
 * WHAT THIS TEST REFUSES TO DO. It does not mock configService, it does not
 * re-implement the ordering, and it does not assert on a spy that the test
 * itself sequenced. It drives the REAL `configService` and the REAL
 * `useEveMaxAuthority` hook, and mocks only the two genuine process boundaries:
 *
 *   - `fetch`   — the backend HTTP PUT (held open / failed on demand)
 *   - ipcBridge — the Electron IPC to the main process
 *
 * The observable is a single ordered event log, appended to from inside those
 * boundaries. If production emitted the refresh signal before awaiting the PUT,
 * the log order inverts and this file goes red. Nothing here supplies the
 * ordering that production must supply.
 *
 * NO FAKE TIMERS ANYWHERE IN THIS FILE, deliberately. The fix must be a
 * happens-after relationship on the write, not a delay — a timer would convert a
 * deterministic race into an intermittent one, and a timer-based test would
 * happily pass against a timer-based "fix".
 *
 * IT ALSO PINS THE TWO INVARIANTS THE NEW CHANNEL INTRODUCES:
 *   A — a throwing/rejecting listener must not corrupt the write, and must not
 *       starve the listeners after it;
 *   B — the startup theme migration now routes through the same funnel, so it
 *       must be proven that it cannot re-ask the authority mid-init.
 *
 * NAMING: `.dom.test.ts` — the `node` vitest project excludes `*.dom.test.ts`
 * and the `dom` project includes ONLY `*.dom.test.ts(x)`. A plain `.test.tsx`
 * would match NEITHER project and "pass" by never running.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SELECTION_KEY = 'commandEve.inferenceSelection';
const MAX_SELECTION = 'command-eve-inference:eve-max';
const DEFAULT_SELECTION = 'command-eve-inference:eve-standard';
/** configService's default binding; useActiveSeatId reports the same id. */
const SEAT = 'seat-1';
const REVISION = 11;

/** The single ordered observable. Appended to ONLY from inside the two boundaries. */
const events: string[] = [];

// ---------------------------------------------------------------------------
// BOUNDARY 1 — the Electron IPC to the main process.
// ---------------------------------------------------------------------------
const main = {
  /** What MAIN would answer if it were asked RIGHT NOW. */
  maxActive: false,
  laneDecisionCalls: 0,
};

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    inferenceLaneDecision: {
      invoke: vi.fn(async () => {
        main.laneDecisionCalls += 1;
        events.push('main:lane-decision');
        return {
          success: true,
          data: {
            seatId: SEAT,
            seatContextRevision: REVISION,
            maxActive: main.maxActive,
            wireTier: main.maxActive ? 'max' : 'standard',
          },
        };
      }),
    },
    seatContext: {
      invoke: vi.fn(async () => ({ success: true, data: { seatContextRevision: REVISION } })),
    },
    activeSeat: {
      invoke: vi.fn(async () => ({ success: true, data: { ok: true, seat_id: SEAT } })),
    },
  },
}));

// ---------------------------------------------------------------------------
// BOUNDARY 2 — the backend HTTP call. The PUT is gated so the test controls
// exactly WHEN the durable write lands, without touching any clock.
// ---------------------------------------------------------------------------
type Gate = { promise: Promise<void>; release: () => void };
function makeGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const put: { gate: Gate | null; failWith: number | null } = { gate: null, failWith: null };

function httpResponse(body: unknown, status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// The REAL configService — imported after the mocks are declared, never mocked.
import { configService } from '@/common/config/configService';
import { useEveMaxAuthority } from '@renderer/hooks/agent/useEveMaxAuthority';

beforeEach(() => {
  events.length = 0;
  main.maxActive = false;
  main.laneDecisionCalls = 0;
  put.gate = null;
  put.failWith = null;
  configService.reset();
  configService.setLocal(SELECTION_KEY, DEFAULT_SELECTION);

  vi.stubGlobal('fetch', async (_url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'PUT') return httpResponse({}, 200);
    // Held until the test releases it — this is the "the write has not landed
    // yet" window in which nothing may refresh and nothing may paint.
    if (put.gate) await put.gate.promise;
    if (put.failWith !== null) {
      events.push(`put:failed:${put.failWith}`);
      return httpResponse({ error: 'nope' }, put.failWith);
    }
    events.push('put:resolved');
    return httpResponse({}, 200);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  configService.reset();
});

/** Mount the real hook and wait out its initial (mount-time) read of main. */
async function mountAuthority() {
  const view = renderHook(() => useEveMaxAuthority());
  await waitFor(() => expect(main.laneDecisionCalls).toBe(1));
  await waitFor(() => expect(view.result.current.state.status).not.toBe('loading'));
  return view;
}

/**
 * Let every already-scheduled microtask AND macrotask drain, several times over.
 * This is the honest way to say "give the wrong implementation every chance to
 * fire" without advancing a clock: a `notify`-before-`await` emit would have
 * reached main many times over inside this window.
 */
async function letEverythingSettle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('MAX refresh ordering — the signal waits on the durable write', () => {
  it('ORDER: the PUT resolves, THEN the notification, THEN main is re-read', async () => {
    // The test observer is registered BEFORE the hook mounts, so it sits ahead of
    // the hook in the subscriber set and observes the channel at the instant it
    // fires — i.e. it can only be recorded EARLIER than the hook's reaction, never
    // later. That makes "persisted before main:lane-decision" a real ordering
    // claim rather than an artefact of when the log entry was appended.
    const unsubscribe = configService.subscribePersisted(SELECTION_KEY, () => {
      events.push('persisted-signal');
    });
    const view = await mountAuthority();
    events.length = 0;
    main.laneDecisionCalls = 0;

    put.gate = makeGate();
    let settled = false;
    const write = configService.set(SELECTION_KEY, MAX_SELECTION).then(() => {
      settled = true;
    });

    // The write is in flight and has NOT landed.
    await letEverythingSettle();
    expect(settled, 'the PUT must still be in flight').toBe(false);
    expect(events, 'nothing may be signalled or re-read before the write lands').toEqual([]);

    // Land the write.
    main.maxActive = true; // main will now answer "max" — because the value IS stored
    await act(async () => {
      put.gate!.release();
      await write;
    });
    await waitFor(() => expect(main.laneDecisionCalls).toBe(1));

    expect(events).toEqual(['put:resolved', 'persisted-signal', 'main:lane-decision']);
    // ...and the painted state is the one main decided, not the one the renderer stored.
    await waitFor(() => expect(view.result.current.maxActive).toBe(true));

    unsubscribe();
  });

  it('A FAILED PUT cannot refresh, and cannot paint', async () => {
    const view = await mountAuthority();
    expect(view.result.current.maxActive).toBe(false);
    events.length = 0;
    main.laneDecisionCalls = 0;

    // If the refresh were to fire, main would answer "max" and the composer would
    // paint. It must never be asked: the write did not land, so the persisted
    // state main reads is still the routine lane.
    main.maxActive = true;
    put.failWith = 500;

    let rejected = false;
    await act(async () => {
      await configService.set(SELECTION_KEY, MAX_SELECTION).catch(() => {
        rejected = true;
      });
    });
    await letEverythingSettle();

    expect(rejected, 'the failing PUT must actually reject — otherwise this proves nothing').toBe(true);
    expect(events).toEqual(['put:failed:500']);
    expect(main.laneDecisionCalls, 'a failed write must not re-ask main').toBe(0);
    expect(view.result.current.maxActive, 'a failed write must not paint MAX').toBe(false);
  });

  it('A SLOW PUT cannot refresh early — the refresh waits on the write, not the clock', async () => {
    const view = await mountAuthority();
    events.length = 0;
    main.laneDecisionCalls = 0;

    put.gate = makeGate();
    main.maxActive = true;
    const write = configService.set(SELECTION_KEY, MAX_SELECTION);

    // REAL elapsed time, repeatedly, with the write still outstanding. A
    // timer-based "fix" (refresh after N ms) would have fired inside this window;
    // a happens-after-the-write fix cannot.
    for (let round = 0; round < 4; round += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(main.laneDecisionCalls, `re-read fired on round ${round} while the write was still open`).toBe(0);
      expect(view.result.current.maxActive, 'painted MAX before the write landed').toBe(false);
    }

    await act(async () => {
      put.gate!.release();
      await write;
    });

    await waitFor(() => expect(main.laneDecisionCalls).toBe(1));
    await waitFor(() => expect(view.result.current.maxActive).toBe(true));
    expect(events[0]).toBe('put:resolved');
  });

  it('setLocal persists nothing, so it must not refresh either', async () => {
    // The mirror case: a purely in-memory write has no durable state for main to
    // read, so triggering a re-ask off it would reintroduce the same race from the
    // other side.
    const view = await mountAuthority();
    main.laneDecisionCalls = 0;
    main.maxActive = true;

    await act(async () => {
      configService.setLocal(SELECTION_KEY, MAX_SELECTION);
    });
    await letEverythingSettle();

    expect(main.laneDecisionCalls).toBe(0);
    expect(view.result.current.maxActive).toBe(false);
  });

  it('EVERY persisting path signals — setBatch and remove, not just set', async () => {
    // The guarantee has to be structural. `persist()` is the only PUT issuer, so
    // every persisting method inherits it; these assert that inheritance rather
    // than trusting the funnel by inspection.
    const seen: string[] = [];
    const unsubscribe = configService.subscribePersisted(SELECTION_KEY, () => seen.push('signal'));

    await configService.setBatch({ [SELECTION_KEY]: MAX_SELECTION });
    expect(seen).toEqual(['signal']);

    await configService.remove(SELECTION_KEY);
    expect(seen).toEqual(['signal', 'signal']);

    // ...and neither of them signals when the write fails.
    put.failWith = 503;
    await configService.setBatch({ [SELECTION_KEY]: DEFAULT_SELECTION }).catch(() => undefined);
    await configService.remove(SELECTION_KEY).catch(() => undefined);
    expect(seen).toEqual(['signal', 'signal']);

    unsubscribe();
  });
});

/**
 * INVARIANT A — a listener bug is a listener bug, not a persistence failure.
 *
 * The emit now happens AFTER the durable write has succeeded. That creates a new
 * way to be wrong: if a callback throws, the exception unwinds through
 * `persist()` and out of `set()`, so the caller is told the write FAILED when it
 * actually landed — and every subscriber registered after the thrower is
 * skipped, which here means the MAX authority silently never refreshes because
 * something unrelated blew up first.
 *
 * These drive the REAL configService with REAL throwing listeners. Nothing is
 * simulated: the exception is thrown from inside the production dispatch path.
 */
describe('a persisted-subscriber cannot corrupt the write it observes', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it('a THROWING subscriber still leaves the write successful AND persisted', async () => {
    const boom = new Error('listener exploded');
    const unsubscribe = configService.subscribePersisted(SELECTION_KEY, () => {
      throw boom;
    });

    // The write must RESOLVE. If the throw escaped, this rejects.
    await expect(configService.set(SELECTION_KEY, MAX_SELECTION)).resolves.toBeUndefined();
    // ...and the value really is the persisted one, not rolled back.
    expect(events).toContain('put:resolved');
    expect(configService.get(SELECTION_KEY)).toBe(MAX_SELECTION);

    unsubscribe();
  });

  it('a THROWING subscriber does not starve the ones registered after it', async () => {
    // Registration order matters and is the point: the thrower goes FIRST.
    const fired: string[] = [];
    const un1 = configService.subscribePersisted(SELECTION_KEY, () => {
      fired.push('first');
      throw new Error('first exploded');
    });
    const un2 = configService.subscribePersisted(SELECTION_KEY, () => fired.push('second'));
    const un3 = configService.subscribePersisted(SELECTION_KEY, () => fired.push('third'));

    await configService.set(SELECTION_KEY, MAX_SELECTION);

    expect(fired).toEqual(['first', 'second', 'third']);

    un1();
    un2();
    un3();
  });

  it('an ASYNC subscriber that REJECTS gets the same two guarantees, with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent): void => {
      unhandled.push(event.reason);
    };
    window.addEventListener('unhandledrejection', onUnhandled);
    const nodeUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', nodeUnhandled);

    const fired: string[] = [];
    const un1 = configService.subscribePersisted(SELECTION_KEY, async () => {
      fired.push('async-first');
      throw new Error('async listener exploded');
    });
    const un2 = configService.subscribePersisted(SELECTION_KEY, () => fired.push('second'));

    await expect(configService.set(SELECTION_KEY, MAX_SELECTION)).resolves.toBeUndefined();
    expect(fired).toEqual(['async-first', 'second']);
    expect(configService.get(SELECTION_KEY)).toBe(MAX_SELECTION);

    // Give the adopted promise a full turn to settle before checking.
    await letEverythingSettle();
    expect(unhandled, 'a rejected listener promise was left unhandled').toEqual([]);
    // The rejection was REPORTED, not merely absorbed.
    expect(consoleError).toHaveBeenCalled();
    expect(String(consoleError.mock.calls.at(-1)?.[0])).toContain('persisted-subscriber');

    un1();
    un2();
    window.removeEventListener('unhandledrejection', onUnhandled);
    process.off('unhandledRejection', nodeUnhandled);
  });

  it('the error is OBSERVABLE — reported with its key and the original error', async () => {
    const boom = new Error('listener exploded');
    const unsubscribe = configService.subscribePersisted(SELECTION_KEY, () => {
      throw boom;
    });

    await configService.set(SELECTION_KEY, MAX_SELECTION);

    expect(consoleError).toHaveBeenCalledTimes(1);
    const [message, reported] = consoleError.mock.calls[0] as [string, unknown];
    expect(message).toContain('[configService]');
    expect(message).toContain(SELECTION_KEY);
    expect(message).toContain('SUCCESSFUL write');
    // The ORIGINAL error object, not a stringified husk.
    expect(reported).toBe(boom);

    unsubscribe();
  });

  it('a throwing MAX-authority listener does not stop the surface from being re-asked', async () => {
    // The concrete consequence, end to end: an unrelated subscriber registered
    // BEFORE the authority hook throws, and the authority must still refresh.
    const un = configService.subscribePersisted(SELECTION_KEY, () => {
      throw new Error('unrelated subscriber exploded');
    });
    const view = await mountAuthority();
    main.laneDecisionCalls = 0;
    main.maxActive = true;

    await act(async () => {
      await configService.set(SELECTION_KEY, MAX_SELECTION);
    });

    await waitFor(() => expect(main.laneDecisionCalls).toBe(1));
    await waitFor(() => expect(view.result.current.maxActive).toBe(true));

    un();
  });
});

/**
 * INVARIANT B — the startup theme migration must not re-ask the authority.
 *
 * The migration now goes through the same `persist()` funnel, so it DOES emit a
 * persisted signal during `initialize()`. The question the auditor raised is
 * whether that can reach the MAX authority before init completes.
 *
 * It cannot, for two INDEPENDENT reasons, and this block proves both instead of
 * asserting either:
 *   1. the signal is KEY-SCOPED, and migrateThemeConfig writes only
 *      `theme.activeId` / `theme.userThemes` — disjoint from the selection key;
 *   2. the migration call is `void`ed, so it yields at persist()'s first await
 *      and `initialized = true` runs before the PUT can possibly resolve.
 *
 * No suppression code was added, because none is earned. Reason 1 is enforced by
 * the key-set assertion below: extend the migration to touch the selection key
 * and this block goes red.
 */
describe('the startup theme migration cannot refresh the authority', () => {
  it('sanity: the migration really does run and really does persist', async () => {
    // Without this, every assertion below could pass on a migration that never
    // happened — the classic vacuous green.
    const themeSignals: string[] = [];
    const un = configService.subscribePersisted('theme.activeId', () => themeSignals.push('theme'));

    await configService.initialize();
    await letEverythingSettle();

    expect(events).toContain('put:resolved');
    expect(themeSignals).toEqual(['theme']);
    expect(configService.get('theme.activeId')).toBeTruthy();

    un();
  });

  it('the migration signals its OWN keys only — the selection key is never touched', async () => {
    const selectionSignals: string[] = [];
    const un = configService.subscribePersisted(SELECTION_KEY, () => selectionSignals.push('selection'));

    await configService.initialize();
    await letEverythingSettle();

    expect(events).toContain('put:resolved');
    expect(selectionSignals).toEqual([]);

    un();
  });

  it('a mounted authority is NOT re-asked across a migrating init', async () => {
    const view = await mountAuthority();
    main.laneDecisionCalls = 0;
    main.maxActive = true; // if it were asked, it would flip — so it must not be

    await act(async () => {
      await configService.initialize();
    });
    await letEverythingSettle();

    expect(events, 'the migration PUT must have happened for this to prove anything').toContain('put:resolved');
    expect(main.laneDecisionCalls, 'the migration re-asked main mid-init').toBe(0);
    expect(view.result.current.maxActive).toBe(false);
  });

  it('when the migration signal fires, init has ALREADY completed', async () => {
    // The second, independent reason. Even for the keys it DOES notify, the emit
    // is strictly after `initialized = true` — so no consumer can ever observe a
    // persisted signal against a half-initialised service.
    const observed: boolean[] = [];
    const un = configService.subscribePersisted('theme.activeId', () => {
      observed.push(configService.isInitialized());
    });

    await configService.initialize();
    await letEverythingSettle();

    expect(observed).toEqual([true]);

    un();
  });

  it('the migration KEY SET is disjoint from the selection key — enforced, not assumed', async () => {
    const { migrateThemeConfig } = await import('@/common/theme/migrateThemeConfig');
    const keys = Object.keys(migrateThemeConfig({}));
    expect(keys.toSorted()).toEqual(['theme.activeId', 'theme.userThemes']);
    expect(keys).not.toContain(SELECTION_KEY);
  });
});
