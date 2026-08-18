/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * @vitest-environment node
 */

/**
 * THE WIRING TEST for the lost-reply dead end — the half the pure derivation
 * test cannot reach.
 *
 * `bridgeInvocationRecovery.test.ts` proves the callback name and the failure
 * payload are correct. That is necessary and not sufficient: a correct name that
 * nobody emits leaves the caller stranded exactly as before. THIS file drives the
 * real Electron adapter registered by `common/adapter/browser.ts` and asserts the
 * behaviour end to end — a rejected `emit` MUST produce the reply the pending
 * invocation is waiting on.
 *
 * WHY THIS IS THE FIRST-RUN LOGIN BUG. `ipcMain.handle` throws for a blocked or
 * unknown provider ("Blocked unknown adapter bridge event." — present in the
 * shipped 2026-08-17/18 logs), the preload's `ipcRenderer.invoke` therefore
 * rejects, and the platform's invoke promise has no rejection path to receive it.
 * The caller awaits forever, its `finally` never runs, and a screen that disables
 * its controls while busy never re-enables them.
 *
 * SHARPNESS: revert `emit` to `return electronAPI.emit(name, data)` and the first
 * case below fails — no callback is ever emitted, which is precisely the hang.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type BridgeEmitter = { emit: (name: string, data: unknown) => void };
type BridgeAdapter = { emit: (name: string, data: unknown) => unknown; on: (emitter: BridgeEmitter) => void };

const platformMock = vi.hoisted(() => ({ adapter: vi.fn(), provider: vi.fn() }));

vi.mock('@office-ai/platform', () => ({
  bridge: { adapter: platformMock.adapter },
  logger: { provider: platformMock.provider },
}));

/** Load the adapter with an Electron-style `window.electronAPI` present. */
async function loadElectronAdapter(emitImpl: (name: string, data: unknown) => Promise<unknown>) {
  vi.resetModules();
  platformMock.adapter.mockClear();
  platformMock.provider.mockClear();

  const electronEmit = vi.fn(emitImpl);
  vi.stubGlobal('window', {
    electronAPI: { emit: electronEmit, on: vi.fn() },
    location: { protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:13400', pathname: '/', hash: '' },
    setTimeout: setTimeout as unknown as Window['setTimeout'],
    clearTimeout: clearTimeout as unknown as Window['clearTimeout'],
  });

  await import('@/common/adapter/browser');

  const adapter = platformMock.adapter.mock.calls[0]?.[0] as BridgeAdapter | undefined;
  if (!adapter) throw new Error('electron adapter did not initialize');

  // The platform registers its emitter synchronously at adapter() time; mirror
  // that so the adapter holds the same reference a real invoke would listen on.
  const emit = vi.fn();
  adapter.on({ emit });
  return { adapter, emit, electronEmit };
}

const PROVIDER_KEY = 'command-eve.auth-web-login';
const INVOCATION_ID = `${PROVIDER_KEY}9f3c1d20`;

describe('Electron bridge adapter — a rejected emit must not strand its caller', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('settles the pending invocation with a typed failure when main refuses it', async () => {
    const blocked = new Error('Blocked unknown adapter bridge event.');
    const { adapter, emit } = await loadElectronAdapter(() => Promise.reject(blocked));

    await adapter.emit(`subscribe-${PROVIDER_KEY}`, { id: INVOCATION_ID, data: { intent: 'login' } });

    // EXACTLY the wire the platform's pending promise subscribed to. Without this
    // emit the caller's await never returns — the measured first-run dead end.
    expect(emit).toHaveBeenCalledTimes(1);
    const [wireName, payload] = emit.mock.calls[0];
    expect(wireName).toBe(`subscribe.callback-${PROVIDER_KEY}${INVOCATION_ID}`);
    expect(payload).toMatchObject({ success: false });
    expect(String((payload as { msg?: string }).msg)).toContain('Blocked unknown adapter bridge event.');
  });

  it('stays silent on a SUCCESSFUL emit — main sends the real reply, we must not race it', async () => {
    const { adapter, emit } = await loadElectronAdapter(() => Promise.resolve(undefined));

    await adapter.emit(`subscribe-${PROVIDER_KEY}`, { id: INVOCATION_ID, data: { intent: 'login' } });

    // A synthetic failure here would BEAT the genuine reply and turn a working
    // login into a spurious error. Nothing may be emitted on the happy path.
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not fabricate a reply for traffic that has no waiting promise', async () => {
    const { adapter, emit } = await loadElectronAdapter(() => Promise.reject(new Error('nope')));

    await adapter.emit('command-eve.browser-context-changed', { id: INVOCATION_ID });
    await adapter.emit(`subscribe-${PROVIDER_KEY}`, { id: 'foreign-id-1a2b' });

    expect(emit).not.toHaveBeenCalled();
  });

  it('never rethrows, so a failed emit cannot surface as an unhandled rejection', async () => {
    const { adapter } = await loadElectronAdapter(() => Promise.reject(new Error('Blocked unknown adapter bridge event.')));

    await expect(
      adapter.emit(`subscribe-${PROVIDER_KEY}`, { id: INVOCATION_ID, data: { intent: 'login' } })
    ).resolves.toBeUndefined();
  });
});
