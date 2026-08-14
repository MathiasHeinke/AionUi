/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AionrsSendBox from '@/renderer/pages/conversation/platforms/aionrs/AionrsSendBox';
import type { AionrsModelSelection } from '@/renderer/pages/conversation/platforms/aionrs/useAionrsModelSelection';

const {
  sendMessageInvokeMock,
  sendBoxPropsMock,
  sendBoxMessageMock,
  queueEnqueueMock,
  queuePauseMock,
  shouldEnqueueMock,
  runtimeViewMock,
  draftDataMock,
  draftMutateMock,
  setUploadFileMock,
  clearFilesMock,
  emitterEmitMock,
  getModeInvokeMock,
  setModeInvokeMock,
  layoutIsMobileMock,
  mobileActionSheetPropsMock,
  messageErrorMock,
  messageWarningMock,
  translationMock,
} = vi.hoisted(() => ({
  sendMessageInvokeMock: vi.fn(),
  sendBoxPropsMock: { current: null as Record<string, unknown> | null },
  sendBoxMessageMock: { current: 'Hello' },
  queueEnqueueMock: vi.fn(),
  queuePauseMock: vi.fn(),
  shouldEnqueueMock: vi.fn(),
  runtimeViewMock: {
    hydrated: true,
    isProcessing: false,
    canSendMessage: true,
    activeTurnId: null as string | null,
    captureSeatTicket: vi.fn(() => ({
      conversationId: 'conv-1',
      seatId: 'seat-1',
      rebindEpoch: 0,
      seatGeneration: 0,
    })),
    isSeatTicketCurrent: vi.fn(() => true),
    issueSendAttempt: vi.fn(() => ({
      kind: 'send',
      conversationId: 'conv-1',
      seatId: 'seat-a',
      seatGeneration: 0,
      attemptId: 1,
    })),
    markSendStarted: vi.fn(() => true),
    markSendAccepted: vi.fn(() => true),
    markSendFailed: vi.fn(() => true),
    issueStopAttempt: vi.fn(() => ({
      kind: 'stop',
      conversationId: 'conv-1',
      seatId: 'seat-a',
      seatGeneration: 0,
      attemptId: 2,
    })),
    markStopRequested: vi.fn(() => true),
    markStopAcknowledged: vi.fn(() => true),
    resetLocalGate: vi.fn(() => true),
    abandonAttempt: vi.fn(() => true),
  },
  draftDataMock: {
    current: {
      atPath: [] as string[],
      uploadFile: [] as string[],
      content: '',
    },
  },
  draftMutateMock: vi.fn(),
  setUploadFileMock: vi.fn(),
  clearFilesMock: vi.fn(),
  emitterEmitMock: vi.fn(),
  getModeInvokeMock: vi.fn(),
  setModeInvokeMock: vi.fn(),
  layoutIsMobileMock: { current: false },
  mobileActionSheetPropsMock: { current: null as Record<string, unknown> | null },
  messageErrorMock: vi.fn(),
  messageWarningMock: vi.fn(),
  translationMock: vi.fn((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key),
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      sendMessage: { invoke: sendMessageInvokeMock },
      stop: { invoke: vi.fn().mockResolvedValue({ runtime: null }) },
    },
    acpConversation: {
      getMode: { invoke: getModeInvokeMock },
      setMode: { invoke: setModeInvokeMock },
    },
  },
}));

vi.mock('@/renderer/components/agent/AgentModeSelector', () => ({ default: () => null }));
vi.mock('@/renderer/components/chat/CommandQueuePanel', () => ({ default: () => null }));
vi.mock('@/renderer/components/chat/MobileActionSheet', () => ({
  default: (props: Record<string, unknown>) => {
    mobileActionSheetPropsMock.current = props;
    return null;
  },
  useAttachEntry: () => ({ entries: [], hiddenFileInput: null }),
}));
vi.mock('@/renderer/components/chat/SendBox', () => ({
  default: (props: { onSend: (message: string) => Promise<void> }) => {
    sendBoxPropsMock.current = props as unknown as Record<string, unknown>;
    return (
      <button type='button' onClick={() => void props.onSend(sendBoxMessageMock.current).catch(() => {})}>
        send
      </button>
    );
  },
}));
vi.mock('@/renderer/components/chat/ThoughtDisplay', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/FileAttachButton', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/FilePreview', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/HorizontalFileList', () => ({ default: () => null }));
vi.mock('@renderer/services/commandEveGenerationActivity', () => ({
  markConversationGenerating: vi.fn(),
  clearConversationGenerating: vi.fn(),
}));
vi.mock('@/renderer/hooks/agent/useEveInferenceSelection', () => ({
  useEveInferenceSelection: () => ({ groups: [], selectedItem: null, selection: '', commit: vi.fn() }),
}));
vi.mock('@/renderer/hooks/chat/useAutoTitle', () => ({
  useAutoTitle: () => ({ checkAndUpdateTitle: vi.fn() }),
}));
vi.mock('@/renderer/hooks/chat/useSendBoxDraft', () => ({
  getSendBoxDraftHook: () => () => ({ data: draftDataMock.current, mutate: draftMutateMock }),
}));
vi.mock('@/renderer/hooks/chat/useSendBoxFiles', () => ({
  useSendBoxFiles: () => ({ handleFilesAdded: vi.fn(), clearFiles: clearFilesMock }),
  createSetUploadFile: () => setUploadFileMock,
}));
vi.mock('@/renderer/hooks/chat/useSlashCommands', () => ({ useSlashCommands: () => [] }));
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({ useConversationContextSafe: () => null }));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: layoutIsMobileMock.current }),
}));
vi.mock('@/renderer/hooks/useActiveSeatId', () => ({ useActiveSeatId: () => 'seat-1' }));
vi.mock('@/renderer/hooks/file/useOpenFileSelector', () => ({
  useOpenFileSelector: () => ({ openFileSelector: vi.fn(), onSlashBuiltinCommand: vi.fn() }),
}));
vi.mock('@/renderer/hooks/ui/useLatestRef', () => ({
  useLatestRef: <T,>(value: T) => ({ current: value }),
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ setSendBoxHandler: vi.fn() }),
}));
vi.mock('@/renderer/pages/conversation/platforms/aionrs/commandEveLocalIntent', () => ({
  createCommandEveLocalIntentClientToken: vi.fn(),
  parseCommandEveLocalMarketingIntent: () => null,
}));
vi.mock('@/renderer/pages/conversation/shared/projectChatIntentGate', () => ({
  runProjectChatIntentGate: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/renderer/pages/conversation/platforms/aionrs/useAionrsMessage', () => ({
  useAionrsMessage: () => ({
    thought: null,
    running: false,
    setActiveMsgId: vi.fn(),
    setWaitingResponse: vi.fn(),
    resetState: vi.fn(),
  }),
}));
vi.mock('@/renderer/pages/conversation/platforms/useConversationCommandQueue', () => ({
  buildConversationBusyControlCommand: ({ input, mode }: { input: string; mode: 'queue' | 'steer' }) => {
    const trimmed = input.trim();
    if (trimmed.startsWith('/steer ')) return { mode: 'steer', input: trimmed };
    return mode === 'steer' ? { mode, input: `/steer ${trimmed}` } : null;
  },
  shouldEnqueueConversationCommand: shouldEnqueueMock,
  useConversationCommandQueue: () => ({
    items: [],
    isPaused: false,
    isInteractionLocked: false,
    hasPendingCommands: false,
    enqueue: queueEnqueueMock,
    remove: vi.fn(),
    clear: vi.fn(),
    reorder: vi.fn(),
    pause: queuePauseMock,
    resume: vi.fn(),
    lockInteraction: vi.fn(),
    unlockInteraction: vi.fn(),
    resetActiveExecution: vi.fn(),
  }),
}));
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => runtimeViewMock,
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/renderer/pages/conversation/utils/warmupConversation', () => ({
  warmupConversation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/renderer/pages/team/hooks/TeamPermissionContext', () => ({ useTeamPermission: () => null }));
vi.mock('@/renderer/services/FileService', () => ({ allSupportedExts: [] }));
vi.mock('@/renderer/utils/emitter', () => ({
  emitter: { emit: emitterEmitMock },
  useAddEventListener: vi.fn(),
}));
vi.mock('@/renderer/utils/file/fileSelection', () => ({ mergeFileSelectionItems: vi.fn() }));
vi.mock('@/renderer/utils/file/messageFiles', () => ({
  buildDisplayMessage: (input: string) => input,
  collectSelectedFiles: (uploadFiles: string[], atPath: Array<string | { path: string }>) => [
    ...uploadFiles,
    ...atPath.map((item) => (typeof item === 'string' ? item : item.path)),
  ],
}));
vi.mock('@arco-design/web-react', () => ({
  Message: {
    error: messageErrorMock,
    success: vi.fn(),
    warning: messageWarningMock,
  },
  Tag: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translationMock,
  }),
}));

const modelSelection = {
  current_model: { id: 'provider', use_model: 'model' },
  providers: [],
  getAvailableModels: () => [],
  handleSelectModel: vi.fn(),
} as unknown as AionrsModelSelection;

describe('AionrsSendBox queue recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendBoxPropsMock.current = null;
    mobileActionSheetPropsMock.current = null;
    sendBoxMessageMock.current = 'Hello';
    draftDataMock.current = { atPath: [], uploadFile: [], content: '' };
    shouldEnqueueMock.mockReturnValue(false);
    queueEnqueueMock.mockReturnValue({ id: 'queued', input: 'queued', files: [], created_at: 1 });
    runtimeViewMock.hydrated = true;
    runtimeViewMock.isProcessing = false;
    runtimeViewMock.canSendMessage = true;
    runtimeViewMock.activeTurnId = null;
    layoutIsMobileMock.current = false;
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });
    setModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });
  });

  it('restores the draft after a correction-now request is rejected', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: '/steer Correct the active run' };
    sendBoxMessageMock.current = '/steer Correct the active run';
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    sendMessageInvokeMock.mockRejectedValue(new Error('correction rejected'));

    render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => expect(messageErrorMock).toHaveBeenCalledWith('correction rejected'));
    const restoredStates = draftMutateMock.mock.calls.map(([updater]) =>
      typeof updater === 'function' ? updater(draftDataMock.current) : updater
    );
    expect(restoredStates).toContainEqual(expect.objectContaining({ content: '/steer Correct the active run' }));
    expect(setUploadFileMock).toHaveBeenCalledWith([]);
  });

  it('suppresses late AionRS send side effects when its seat ticket is stale', async () => {
    const send = createDeferred<unknown>();
    sendMessageInvokeMock.mockReturnValue(send.promise);
    runtimeViewMock.markSendAccepted.mockReturnValueOnce(false);

    render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);
    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    emitterEmitMock.mockClear();

    await act(async () => {
      send.resolve({ turn_id: 'turn-seat-a', msg_id: 'message-seat-a', runtime: null });
    });

    expect(emitterEmitMock).not.toHaveBeenCalledWith('chat.history.refresh');
    expect(emitterEmitMock).not.toHaveBeenCalledWith('aionrs.workspace.refresh');
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  it('warns and restores files when a steer-with-files enqueue is rejected', async () => {
    draftDataMock.current = {
      atPath: ['/tmp/context.md'],
      uploadFile: ['/tmp/evidence.txt'],
      content: '/steer Use this evidence',
    };
    sendBoxMessageMock.current = '/steer Use this evidence';
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    shouldEnqueueMock.mockReturnValue(true);
    queueEnqueueMock.mockReturnValue(null);

    render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    expect(messageWarningMock).toHaveBeenCalled();
    expect(queueEnqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: '/steer Use this evidence',
        files: ['/tmp/evidence.txt', '/tmp/context.md'],
      })
    );
    expect(setUploadFileMock).toHaveBeenCalledWith(['/tmp/evidence.txt']);
    expect(emitterEmitMock).toHaveBeenCalledWith('aionrs.selected.file', ['/tmp/context.md']);
  });

  it('pauses queued work before stopping the active turn', async () => {
    runtimeViewMock.activeTurnId = 'turn-1';
    render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);

    const onStop = sendBoxPropsMock.current?.onStop as (() => Promise<void>) | undefined;
    await act(async () => {
      await onStop?.();
    });

    expect(queuePauseMock).toHaveBeenCalledTimes(1);
    expect(runtimeViewMock.markStopRequested).toHaveBeenCalledWith(
      runtimeViewMock.issueStopAttempt.mock.results[0]?.value,
      'turn-1'
    );
  });

  it('publishes a restrictive mobile permission mode before backend acknowledgement', async () => {
    layoutIsMobileMock.current = true;
    const setMode = createDeferred<{ mode: string; initialized: boolean }>();
    setModeInvokeMock.mockReturnValue(setMode.promise);

    render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} session_mode='yolo' />);

    const entries = mobileActionSheetPropsMock.current?.entries as
      | Array<{ key: string; submenu?: { onSelect: (key: string) => void } }>
      | undefined;
    const permissionEntry = entries?.find((entry) => entry.key === 'permission');
    expect(permissionEntry?.submenu).toBeDefined();

    act(() => {
      permissionEntry?.submenu?.onSelect('default');
    });

    expect(emitterEmitMock).toHaveBeenCalledWith('acp.permission.mode', {
      conversation_id: 'conv-1',
      mode: 'default',
    });
    await waitFor(() => {
      expect(setModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1', mode: 'default' });
    });
    expect(emitterEmitMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
      setModeInvokeMock.mock.invocationCallOrder.at(-1)!
    );

    await act(async () => {
      setMode.resolve({ mode: 'default', initialized: true });
    });
    expect(emitterEmitMock).toHaveBeenCalledTimes(1);
  });
});
