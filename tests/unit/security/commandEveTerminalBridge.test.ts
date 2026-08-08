import { beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_EVE_TERMINAL_CHANNELS } from '@/common/config/commandEveTerminalChannels';

const handlers = new Map<string, (event: FakeEvent, value: unknown) => unknown>();
const state = vi.hoisted(() => ({ trusted: true }));

type FakeEvent = {
  sender: {
    id: number;
    isDestroyed: () => boolean;
    once: (name: string, callback: () => void) => void;
    send: (channel: string, payload: unknown) => void;
  };
};

const ptyState = vi.hoisted(() => {
  const callbacks = {
    data: null as ((data: string) => void) | null,
    exit: null as ((event: { exitCode: number; signal: number }) => void) | null,
  };
  const process = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((callback: (data: string) => void) => {
      callbacks.data = callback;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((callback: (event: { exitCode: number; signal: number }) => void) => {
      callbacks.exit = callback;
      return { dispose: vi.fn() };
    }),
  };
  return { callbacks, process, spawn: vi.fn(() => process) };
});

vi.mock('@/common/adapter/main', () => ({
  isTrustedAdapterIpcSender: () => state.trusted,
}));

vi.mock('node-pty', () => ({ spawn: ptyState.spawn }));

vi.mock('electron', () => ({
  app: { once: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (event: FakeEvent, value: unknown) => unknown) => handlers.set(channel, handler),
  },
}));

const createEvent = () => {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const destroyedCallbacks: Array<() => void> = [];
  const event: FakeEvent = {
    sender: {
      id: 42,
      isDestroyed: () => false,
      once: (_name, callback) => destroyedCallbacks.push(callback),
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
  return { event, sent, destroyedCallbacks };
};

beforeEach(async () => {
  handlers.clear();
  state.trusted = true;
  ptyState.spawn.mockClear();
  ptyState.process.write.mockClear();
  ptyState.process.resize.mockClear();
  ptyState.process.kill.mockClear();
  ptyState.callbacks.data = null;
  ptyState.callbacks.exit = null;
  vi.resetModules();
  const bridge = await import('@/process/bridge/commandEveTerminalBridge');
  bridge.initCommandEveTerminalBridge();
});

describe('Command EVE terminal IPC bridge', () => {
  it('registers the bounded PTY operations and blocks untrusted renderers', async () => {
    expect([...handlers.keys()].toSorted()).toEqual(
      [
        COMMAND_EVE_TERMINAL_CHANNELS.start,
        COMMAND_EVE_TERMINAL_CHANNELS.write,
        COMMAND_EVE_TERMINAL_CHANNELS.resize,
        COMMAND_EVE_TERMINAL_CHANNELS.close,
      ].toSorted()
    );
    state.trusted = false;
    const { event } = createEvent();
    await expect(handlers.get(COMMAND_EVE_TERMINAL_CHANNELS.start)!(event, { cwd: '/tmp' })).rejects.toThrow(
      'untrusted'
    );
    expect(ptyState.spawn).not.toHaveBeenCalled();
  });

  it('starts an owned shell with a filtered environment and routes data only to its renderer', async () => {
    const { event, sent } = createEvent();
    const result = (await handlers.get(COMMAND_EVE_TERMINAL_CHANNELS.start)!(event, {
      cwd: '/tmp',
      cols: 90,
      rows: 28,
    })) as { terminalId: string; cwd: string };

    expect(result.cwd).toBe('/tmp');
    expect(result.terminalId).toMatch(/^[a-f0-9-]+$/i);
    const options = ptyState.spawn.mock.calls[0]?.[2] as { env: Record<string, string>; cwd: string };
    expect(options.cwd).toBe('/tmp');
    expect(options.env.TERM_PROGRAM).toBe('CommandEVE');
    expect(options.env).not.toHaveProperty('OPENROUTER_API_KEY');

    ptyState.callbacks.data?.('ready\r\n');
    expect(sent).toContainEqual({
      channel: COMMAND_EVE_TERMINAL_CHANNELS.data,
      payload: { terminalId: result.terminalId, data: 'ready\r\n' },
    });

    await handlers.get(COMMAND_EVE_TERMINAL_CHANNELS.write)!(event, {
      terminalId: result.terminalId,
      data: 'pwd\r',
    });
    expect(ptyState.process.write).toHaveBeenCalledWith('pwd\r');
  });

  it('rejects cross-renderer access to an existing PTY', async () => {
    const owner = createEvent();
    const result = (await handlers.get(COMMAND_EVE_TERMINAL_CHANNELS.start)!(owner.event, { cwd: '/tmp' })) as {
      terminalId: string;
    };
    const other = createEvent();
    other.event.sender.id = 84;

    expect(() =>
      handlers.get(COMMAND_EVE_TERMINAL_CHANNELS.write)!(other.event, {
        terminalId: result.terminalId,
        data: 'whoami\r',
      })
    ).toThrow('not available');
    expect(ptyState.process.write).not.toHaveBeenCalled();
  });
});
