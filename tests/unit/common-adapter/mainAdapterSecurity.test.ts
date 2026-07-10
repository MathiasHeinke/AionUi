/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handler: undefined as ((event: unknown, payload: unknown) => unknown) | undefined,
  emitter: { emit: vi.fn() },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((_channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      state.handler = handler;
    }),
  },
}));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    adapter: (adapter: { on: (emitter: typeof state.emitter) => void }) => adapter.on(state.emitter),
  },
}));

vi.mock('@/common/adapter/registry', () => ({
  registerWebSocketBroadcaster: vi.fn(),
  getBridgeEmitter: vi.fn(),
  setBridgeEmitter: vi.fn(),
  broadcastToAll: vi.fn(),
}));

type FakeWebContents = {
  mainFrame: object;
  isDestroyed: () => boolean;
};

beforeEach(() => {
  state.handler = undefined;
  state.emitter.emit.mockReset();
  vi.resetModules();
});

async function setup(): Promise<{ webContents: FakeWebContents; handler: NonNullable<typeof state.handler> }> {
  const module = await import('@/common/adapter/main');
  const webContents = { mainFrame: {}, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false, on: vi.fn() };
  module.initMainAdapterWithWindow(window as never);
  if (!state.handler) throw new Error('adapter handler was not registered');
  return { webContents, handler: state.handler };
}

describe('main adapter IPC trust boundary', () => {
  it('allows a registered main-frame sender', async () => {
    const { webContents, handler } = await setup();

    await handler(
      { sender: webContents, senderFrame: webContents.mainFrame },
      JSON.stringify({ name: 'settings.read', data: { id: 1 } })
    );

    expect(state.emitter.emit).toHaveBeenCalledWith('settings.read', { id: 1 });
  });

  it('blocks an unregistered renderer before dispatch', async () => {
    const { handler } = await setup();
    const foreign = { mainFrame: {}, isDestroyed: () => false };

    expect(() =>
      handler(
        { sender: foreign, senderFrame: foreign.mainFrame },
        JSON.stringify({ name: 'command-eve.entitlement-read', data: {} })
      )
    ).toThrow('untrusted');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it('blocks subframes from a trusted window', async () => {
    const { webContents, handler } = await setup();

    expect(() =>
      handler({ sender: webContents, senderFrame: {} }, JSON.stringify({ name: 'feedback:collect-logs', data: {} }))
    ).toThrow('untrusted');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });

  it('rejects malformed and oversized payloads before dispatch', async () => {
    const { webContents, handler } = await setup();
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    expect(() => handler(event, '{')).toThrow();
    expect(() => handler(event, JSON.stringify({ name: '', data: {} }))).toThrow('shape');
    expect(() => handler(event, 'x'.repeat(50 * 1024 * 1024 + 1))).toThrow('size');
    expect(state.emitter.emit).not.toHaveBeenCalled();
  });
});
