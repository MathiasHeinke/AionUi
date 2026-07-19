/**
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SocketListenerMap = {
  open: Array<() => void>;
  close: Array<(event: CloseEvent) => void>;
  error: Array<(event: Event) => void>;
  message: Array<(event: MessageEvent) => void>;
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  readonly listeners: SocketListenerMap = { open: [], close: [], error: [], message: [] };

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener<K extends keyof SocketListenerMap>(type: K, listener: SocketListenerMap[K][number]): void {
    (this.listeners[type] as Array<typeof listener>).push(listener);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  send(message: string): void {
    this.sent.push(message);
  }

  dispatchOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.listeners.open.forEach((listener) => listener());
  }

  dispatchClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.listeners.close.forEach((listener) => listener({ code: 1006, reason: 'test' } as CloseEvent));
  }

  dispatchMessage(name: string, data?: unknown): void {
    this.listeners.message.forEach((listener) => listener({ data: JSON.stringify({ name, data }) } as MessageEvent));
  }
}

describe('httpBridge realtime recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { __backendPort: 13400 });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('announces reconnects and forwards the backend resync signal', async () => {
    const { wsEmitter } = await import('@/common/adapter/httpBridge');
    const connected = vi.fn();
    const resync = vi.fn();
    wsEmitter<{ reconnected: boolean }>('realtime.connected').on(connected);
    wsEmitter<{ reason: string }>('realtime.resync_required').on(resync);

    expect(FakeWebSocket.instances).toHaveLength(1);
    const first = FakeWebSocket.instances[0];
    first.dispatchOpen();
    expect(connected).toHaveBeenLastCalledWith({ reconnected: false });

    first.dispatchMessage('realtime.resync_required', { reason: 'lagged' });
    expect(resync).toHaveBeenCalledWith({ reason: 'lagged' });

    first.dispatchClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].dispatchOpen();
    expect(connected).toHaveBeenLastCalledWith({ reconnected: true });
  });

  it('answers the AionCore heartbeat so a mounted chat keeps its realtime stream', async () => {
    const { wsEmitter } = await import('@/common/adapter/httpBridge');
    const internalPing = vi.fn();
    wsEmitter('ping').on(internalPing);

    const socket = FakeWebSocket.instances[0];
    socket.dispatchOpen();
    socket.dispatchMessage('ping', { timestamp: 123 });
    socket.dispatchMessage('ping');

    expect(socket.sent).toEqual([
      JSON.stringify({ name: 'pong', data: { timestamp: 123 } }),
      JSON.stringify({ name: 'pong', data: {} }),
    ]);
    expect(internalPing).not.toHaveBeenCalled();
  });

  it('does not answer a heartbeat before the socket is open', async () => {
    const { wsEmitter } = await import('@/common/adapter/httpBridge');
    const internalPing = vi.fn();
    wsEmitter('ping').on(internalPing);

    const socket = FakeWebSocket.instances[0];
    socket.dispatchMessage('ping', { timestamp: 123 });

    expect(socket.sent).toEqual([]);
    expect(internalPing).not.toHaveBeenCalled();
  });
});
