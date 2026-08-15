import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import { useAionrsMessage } from '@/renderer/pages/conversation/platforms/aionrs/useAionrsMessage';
import { ACP_PERFORMANCE_MARK_EVENT, type AcpPerformanceMark } from '@/renderer/utils/performance/acpPerformanceMarks';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { responseStreamHandlerRef } = vi.hoisted(() => ({
  responseStreamHandlerRef: {
    current: undefined as ((message: IResponseMessage) => void) | undefined,
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: {
        on: (handler: (message: IResponseMessage) => void) => {
          responseStreamHandlerRef.current = handler;
          return () => {
            if (responseStreamHandlerRef.current === handler) responseStreamHandlerRef.current = undefined;
          };
        },
      },
      update: { invoke: vi.fn() },
    },
  },
}));

vi.mock('@/common/chat/chatLib', () => ({
  isErrorTipMessage: () => false,
  transformMessage: () => ({ id: 'rendered-message' }),
}));

vi.mock('@/common/utils', () => ({ uuid: () => 'uuid' }));
vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({ useAddOrUpdateMessage: () => vi.fn() }));
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  logStreamTerminalObserved: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: () => Promise.resolve(null),
}));
vi.mock('@/renderer/pages/conversation/utils/conversationRuntime', () => ({
  isConversationProcessing: () => false,
}));
vi.mock('@/renderer/pages/conversation/platforms/aionrs/localCronCommands', () => ({
  processLocalCronResponse: () => Promise.resolve({ displayContent: undefined, systemResponses: [] }),
}));

describe('useAionrsMessage performance marks', () => {
  beforeEach(() => {
    responseStreamHandlerRef.current = undefined;
  });

  it('emits first text and finish once for the accepted AionRS turn only', async () => {
    const marks: AcpPerformanceMark[] = [];
    const listener = (event: Event) => marks.push((event as CustomEvent<AcpPerformanceMark>).detail);
    window.addEventListener(ACP_PERFORMANCE_MARK_EVENT, listener);
    const { result } = renderHook(() => useAionrsMessage('conv-1'));
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));

    act(() => result.current.setActiveMsgId('msg-current'));
    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'content',
        data: 'alt',
        msg_id: 'msg-old',
        turn_id: 'turn-old',
        conversation_id: 'conv-1',
      } as IResponseMessage);
      responseStreamHandlerRef.current?.({
        type: 'content',
        data: 'Hallo',
        msg_id: 'msg-current',
        turn_id: 'turn-current',
        conversation_id: 'conv-1',
      } as IResponseMessage);
      responseStreamHandlerRef.current?.({
        type: 'content',
        data: ' Welt',
        msg_id: 'msg-current',
        turn_id: 'turn-current',
        conversation_id: 'conv-1',
      } as IResponseMessage);
      responseStreamHandlerRef.current?.({
        type: 'finish',
        data: {},
        msg_id: 'msg-current',
        turn_id: 'turn-current',
        conversation_id: 'conv-1',
      } as IResponseMessage);
      responseStreamHandlerRef.current?.({
        type: 'finish',
        data: {},
        msg_id: 'msg-current',
        turn_id: 'turn-current',
        conversation_id: 'conv-1',
      } as IResponseMessage);
    });

    expect(marks.map(({ stage, turnId }) => ({ stage, turnId }))).toEqual([
      { stage: 'acp_first_text', turnId: 'turn-current' },
      { stage: 'response_finished', turnId: 'turn-current' },
    ]);
    window.removeEventListener(ACP_PERFORMANCE_MARK_EVENT, listener);
  });
});
