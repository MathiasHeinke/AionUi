/**
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';

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

  it('forwards non-durable live message metadata without reconstruction', async () => {
    const { wsEmitter } = await import('@/common/adapter/httpBridge');
    const stream = vi.fn();
    wsEmitter<IResponseMessage>('message.stream').on(stream);

    const socket = FakeWebSocket.instances[0];
    socket.dispatchOpen();
    const payload: IResponseMessage = {
      type: 'tips',
      data: { content: 'Safe retryable failure', type: 'error' },
      msg_id: 'ephemeral:turn-1:send-failure',
      turn_id: 'turn-1',
      conversation_id: 'conversation-1',
      durable: false,
      replace: false,
    };
    socket.dispatchMessage('message.stream', payload);

    expect(stream).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledWith(payload);
  });

  it('drops a queued old-seat start after transport rotation and accepts the new socket', async () => {
    const { rotateRealtimeTransportForSeatRebind, wsEmitter } = await import('@/common/adapter/httpBridge');
    const stream = vi.fn();
    wsEmitter<IResponseMessage>('message.stream').on(stream);

    const staleSocket = FakeWebSocket.instances[0];
    staleSocket.dispatchOpen();
    rotateRealtimeTransportForSeatRebind();

    expect(FakeWebSocket.instances).toHaveLength(2);
    const currentSocket = FakeWebSocket.instances[1];
    currentSocket.dispatchOpen();

    const staleStart: IResponseMessage = {
      type: 'start',
      data: {},
      msg_id: 'old-seat-message',
      turn_id: 'old-seat-turn',
      conversation_id: 'shared-conversation',
    };
    const currentStart: IResponseMessage = {
      ...staleStart,
      msg_id: 'new-seat-message',
      turn_id: 'new-seat-turn',
    };

    // Simulate a browser task that was already queued before close(). The old
    // socket object can still invoke its listener, but its generation is dead.
    staleSocket.dispatchMessage('message.stream', staleStart);
    expect(stream).not.toHaveBeenCalled();
    staleSocket.dispatchClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    currentSocket.dispatchMessage('message.stream', currentStart);
    expect(stream).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledWith(currentStart);
  });

  it('maps turn completion evidence fail-closed and preserves explicit AionCore proof', async () => {
    const { mapConversationTurnCompletedEvent } = await import('@/common/adapter/conversationTurnCompletedMapper');
    const legacy = mapConversationTurnCompletedEvent({
      conversation_id: 'conversation-legacy',
      turn_id: 'turn-legacy',
      status: 'finished',
    });
    const explicit = mapConversationTurnCompletedEvent({
      conversation_id: 'conversation-explicit',
      turn_id: 'turn-explicit',
      status: 'finished',
      state: 'ai_waiting_input',
      has_substantive_output: true,
      canSendMessage: true,
    });
    const malformed = mapConversationTurnCompletedEvent({
      conversation_id: 'conversation-malformed',
      turn_id: 'turn-malformed',
      state: 'ai_waiting_input',
      has_substantive_output: true,
      can_send_message: 'false',
    });

    expect(legacy).toMatchObject({
      session_id: 'conversation-legacy',
      turn_id: 'turn-legacy',
      state: 'unknown',
      has_substantive_output: false,
    });
    expect(explicit).toMatchObject({
      session_id: 'conversation-explicit',
      turn_id: 'turn-explicit',
      state: 'ai_waiting_input',
      has_substantive_output: true,
      can_send_message: true,
    });
    expect(malformed).toMatchObject({
      status: 'pending',
      state: 'ai_waiting_input',
      has_substantive_output: true,
      can_send_message: false,
    });
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
