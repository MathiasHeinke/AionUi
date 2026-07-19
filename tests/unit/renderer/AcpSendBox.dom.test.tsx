/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import AcpSendBox from '@/renderer/pages/conversation/platforms/acp/AcpSendBox';
import type { UseAcpMessageReturn } from '@/renderer/pages/conversation/platforms/acp/useAcpMessage';
import { COMMAND_EVE_HG4_DELEGATED_MODE } from '@/renderer/utils/model/agentModes';

const {
  sendMessageInvokeMock,
  steerInvokeMock,
  pdfPrepareInvokeMock,
  addOrUpdateMessageMock,
  resetStateMock,
  emitterEmitMock,
  setSendBoxHandlerMock,
  sendBoxPropsMock,
  speechTranscribePendingMock,
  queuePanelPropsMock,
  queueItemsMock,
  queueEnqueueMock,
  queueRemoveMock,
  queueRestoreMock,
  queuePauseMock,
  queueLockMock,
  queueUnlockMock,
  shouldEnqueueMock,
  runtimeViewMock,
  draftDataMock,
  draftMutateMock,
  setUploadFileMock,
  sendBoxMessageMock,
  layoutIsMobileMock,
  mobileActionSheetPropsMock,
  agentModesMock,
  getModeInvokeMock,
  setModeInvokeMock,
  messageErrorMock,
  messageWarningMock,
  configGetMock,
  configSetMock,
  initialMessageParamsMock,
  buildDisplayMessageMock,
} = vi.hoisted(() => ({
  sendMessageInvokeMock: vi.fn(),
  steerInvokeMock: vi.fn(),
  pdfPrepareInvokeMock: vi.fn(),
  addOrUpdateMessageMock: vi.fn(),
  resetStateMock: vi.fn(),
  emitterEmitMock: vi.fn(),
  setSendBoxHandlerMock: vi.fn(),
  sendBoxPropsMock: { current: null as Record<string, unknown> | null },
  speechTranscribePendingMock: vi.fn().mockResolvedValue('spoken prompt'),
  queuePanelPropsMock: { current: null as Record<string, unknown> | null },
  queueItemsMock: {
    current: [] as Array<{ id: string; input: string; files: string[]; created_at: number }>,
  },
  queueEnqueueMock: vi.fn(),
  queueRemoveMock: vi.fn(),
  queueRestoreMock: vi.fn(),
  queuePauseMock: vi.fn(),
  queueLockMock: vi.fn(),
  queueUnlockMock: vi.fn(),
  shouldEnqueueMock: vi.fn(),
  runtimeViewMock: {
    hydrated: true,
    isProcessing: false,
    canSendMessage: true,
    activeTurnId: null as string | null,
    markSendStarted: vi.fn(),
    markSendAccepted: vi.fn(),
    markSendFailed: vi.fn(),
    markStopRequested: vi.fn(),
    markStopAcknowledged: vi.fn(),
    resetLocalGate: vi.fn(),
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
  sendBoxMessageMock: { current: 'Hello' },
  layoutIsMobileMock: { current: false },
  mobileActionSheetPropsMock: { current: null as Record<string, unknown> | null },
  agentModesMock: {
    current: [] as Array<{ value: string; label: string; description?: string }>,
  },
  getModeInvokeMock: vi.fn(),
  setModeInvokeMock: vi.fn(),
  messageErrorMock: vi.fn(),
  messageWarningMock: vi.fn(),
  configGetMock: vi.fn(),
  configSetMock: vi.fn(),
  initialMessageParamsMock: {
    current: null as { sendInitialMessage?: (input: string, files: string[]) => Promise<boolean> } | null,
  },
  buildDisplayMessageMock: vi.fn((input: string) => input),
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
    acpConversation: {
      sendMessage: {
        invoke: sendMessageInvokeMock,
      },
      steer: {
        invoke: steerInvokeMock,
      },
      getMode: {
        invoke: getModeInvokeMock,
      },
      setMode: {
        invoke: setModeInvokeMock,
      },
    },
    conversation: {
      stop: {
        invoke: vi.fn().mockResolvedValue({ runtime: null }),
      },
    },
    commandEve: {
      pdfPrepare: {
        invoke: pdfPrepareInvokeMock,
      },
    },
  },
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    set: configSetMock,
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('@/renderer/components/chat/SendBox', () => ({
  default: (props: { onSend: (message: string) => Promise<void>; rightTools?: React.ReactNode }) => {
    sendBoxPropsMock.current = props as unknown as Record<string, unknown>;
    return (
      <>
        {props.rightTools}
        <button
          type='button'
          onClick={() => {
            void props.onSend(sendBoxMessageMock.current).catch(() => {});
          }}
        >
          send
        </button>
      </>
    );
  },
}));

vi.mock('@/renderer/components/chat/UnifiedSendBar', () => ({
  default: (props: {
    busyModeSlot?: React.ReactNode;
    modelSlot?: React.ReactNode;
    permissionSlot?: React.ReactNode;
    contextSlot?: React.ReactNode;
    micSlot?: React.ReactNode;
  }) => (
    <>
      {props.busyModeSlot}
      {props.modelSlot}
      {props.permissionSlot}
      {props.contextSlot}
      {props.micSlot}
    </>
  ),
}));

vi.mock('@/renderer/components/agent/AgentModeSelector', () => ({ default: () => null }));
// The in-chat model/inference picker now lives in the bottom bar's modelSlot
// (founder mandate: moved out of the chat header). Stub both pickers so this
// test stays focused on the send/reset path, mirroring the AgentModeSelector stub.
vi.mock('@/renderer/components/agent/AcpModelSelector', () => ({ default: () => null }));
vi.mock('@/renderer/components/agent/EveInferencePicker', () => ({ default: () => null }));
vi.mock('@/renderer/components/chat/SpeechInputButton', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    default: ReactActual.forwardRef(
      (
        props: { onStatusChange?: (status: string) => void },
        ref: React.ForwardedRef<{
          hasPendingAudio: () => boolean;
          transcribePendingAudio: (options?: { emit?: boolean }) => Promise<string | null>;
        }>
      ) => {
        ReactActual.useImperativeHandle(ref, () => ({
          hasPendingAudio: () => true,
          transcribePendingAudio: speechTranscribePendingMock,
        }));
        ReactActual.useEffect(() => {
          props.onStatusChange?.('recording');
        }, [props.onStatusChange]);
        return <button type='button'>mic</button>;
      }
    ),
  };
});
vi.mock('@/renderer/components/chat/CommandQueuePanel', () => ({
  default: (props: Record<string, unknown>) => {
    queuePanelPropsMock.current = props;
    return null;
  },
}));
vi.mock('@/renderer/components/chat/MobileActionSheet', () => ({
  default: (props: Record<string, unknown>) => {
    mobileActionSheetPropsMock.current = props;
    return null;
  },
  useAttachEntry: () => ({ entries: [], hiddenFileInput: null }),
}));
vi.mock('@/renderer/components/chat/ThoughtDisplay', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/FileAttachButton', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/FilePreview', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/HorizontalFileList', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/renderer/hooks/agent/useAcpModelInfo', () => ({
  useAcpModelInfo: () => ({
    model_info: null,
    canSwitch: false,
    selectModel: vi.fn(),
  }),
}));
vi.mock('@/renderer/hooks/agent/useAgentModesForBackend', () => ({
  useAgentModesForBackend: () => agentModesMock.current,
}));
vi.mock('@/renderer/hooks/chat/useSendBoxDraft', () => ({
  getSendBoxDraftHook: () => () => ({
    data: draftDataMock.current,
    mutate: draftMutateMock,
  }),
}));
vi.mock('@/renderer/hooks/chat/useSendBoxFiles', () => ({
  useSendBoxFiles: () => ({
    handleFilesAdded: vi.fn(),
    clearFiles: vi.fn(),
  }),
  createSetUploadFile: () => setUploadFileMock,
}));
vi.mock('@/renderer/hooks/chat/useAutoTitle', () => ({
  useAutoTitle: () => ({
    checkAndUpdateTitle: vi.fn(),
  }),
}));
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => null,
}));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: layoutIsMobileMock.current }),
}));
vi.mock('@/renderer/hooks/file/useOpenFileSelector', () => ({
  useOpenFileSelector: () => ({
    openFileSelector: vi.fn(),
    onSlashBuiltinCommand: vi.fn(),
  }),
}));
vi.mock('@/renderer/hooks/ui/useLatestRef', () => ({
  useLatestRef: <T,>(value: T) => ({ current: value }),
}));
vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  useAddOrUpdateMessage: () => addOrUpdateMessageMock,
}));
vi.mock('@/renderer/pages/conversation/platforms/useConversationCommandQueue', () => ({
  buildConversationBusyControlCommand: ({ input, mode }: { input: string; mode: 'queue' | 'steer' }) => {
    const trimmed = input.trim();
    if (trimmed.startsWith('/steer ')) return { mode: 'steer', input: trimmed };
    const queueMatch = trimmed.match(/^\/(?:queue|q)\s+([\s\S]+)$/i);
    if (queueMatch) return { mode: 'queue', input: `/queue ${queueMatch[1].trim()}` };
    return mode === 'steer' ? { mode, input: `/steer ${trimmed}` } : null;
  },
  shouldEnqueueConversationCommand: shouldEnqueueMock,
  useConversationCommandQueue: () => ({
    items: queueItemsMock.current,
    isPaused: false,
    isInteractionLocked: false,
    hasPendingCommands: false,
    enqueue: queueEnqueueMock,
    remove: queueRemoveMock,
    restore: queueRestoreMock,
    clear: vi.fn(),
    reorder: vi.fn(),
    pause: queuePauseMock,
    resume: vi.fn(),
    lockInteraction: queueLockMock,
    unlockInteraction: queueUnlockMock,
    resetActiveExecution: vi.fn(),
  }),
}));
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => ({
    ...runtimeViewMock,
    view: {
      hydrated: runtimeViewMock.hydrated,
      isProcessing: runtimeViewMock.isProcessing,
      canSendMessage: runtimeViewMock.canSendMessage,
      activeTurnId: runtimeViewMock.activeTurnId,
    },
  }),
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    setSendBoxHandler: setSendBoxHandlerMock,
  }),
}));
vi.mock('@/renderer/pages/conversation/utils/warmupConversation', () => ({
  warmupConversation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/renderer/pages/team/hooks/TeamPermissionContext', () => ({
  useTeamPermission: () => null,
}));
vi.mock('@/renderer/services/FileService', () => ({
  allSupportedExts: [],
}));
vi.mock('@/renderer/utils/emitter', () => ({
  emitter: {
    emit: emitterEmitMock,
  },
  useAddEventListener: vi.fn(),
}));
vi.mock('@/renderer/utils/file/fileSelection', () => ({
  mergeFileSelectionItems: vi.fn(),
}));
vi.mock('@/renderer/utils/file/messageFiles', () => ({
  buildDisplayMessage: buildDisplayMessageMock,
}));
vi.mock('@/renderer/pages/conversation/platforms/acp/useAcpInitialMessage', () => ({
  useAcpInitialMessage: (params: { sendInitialMessage?: (input: string, files: string[]) => Promise<boolean> }) => {
    initialMessageParamsMock.current = params;
  },
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type='button' {...props}>
      {children}
    </button>
  ),
  Dropdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Menu: Object.assign(({ children }: { children?: React.ReactNode }) => <>{children}</>, {
    Item: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  }),
  Message: {
    success: vi.fn(),
    error: messageErrorMock,
    warning: messageWarningMock,
  },
  Popover: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Radio: Object.assign(({ children }: { children?: React.ReactNode }) => <>{children}</>, {
    Group: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  }),
  Tag: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

const makeMessageState = (): UseAcpMessageReturn =>
  ({
    thought: { subject: '', description: '' },
    setThought: vi.fn(),
    running: true,
    hasHydratedRunningState: true,
    acpStatus: null,
    aiProcessing: false,
    setAiProcessing: vi.fn(),
    resetState: resetStateMock,
    tokenUsage: null,
    context_limit: 0,
    hasThinkingMessage: false,
    slashCommands: [],
    fetchSlashCommands: vi.fn(),
    // STEP 2/STEP 4: AcpSendBox reads runtimeActivity.modelId when building the
    // UnifiedSendBar's ContextUsageIndicator, so the message-state stub must
    // provide it (was undefined → crash). quotaWall is part of the contract too.
    runtimeActivity: { phase: 'idle', updatedAt: 0 },
    quotaWall: {
      visible: false,
      body: null,
      jobInFlight: false,
      open: vi.fn(),
      dismiss: vi.fn(),
    },
  }) as unknown as UseAcpMessageReturn;

describe('AcpSendBox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendBoxPropsMock.current = null;
    queuePanelPropsMock.current = null;
    mobileActionSheetPropsMock.current = null;
    initialMessageParamsMock.current = null;
    queueItemsMock.current = [];
    queueEnqueueMock.mockReturnValue({ id: 'queued', input: 'queued', files: [], created_at: 1 });
    shouldEnqueueMock.mockReturnValue(false);
    runtimeViewMock.hydrated = true;
    runtimeViewMock.isProcessing = false;
    runtimeViewMock.canSendMessage = true;
    runtimeViewMock.activeTurnId = null;
    draftDataMock.current = { atPath: [], uploadFile: [], content: '' };
    sendBoxMessageMock.current = 'Hello';
    layoutIsMobileMock.current = false;
    agentModesMock.current = [];
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });
    setModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });
    configGetMock.mockImplementation((key: string) =>
      key === 'acp.config' ? { hermes: { preferredMode: 'default' } } : undefined
    );
    configSetMock.mockResolvedValue(undefined);
    pdfPrepareInvokeMock.mockReset();
    steerInvokeMock.mockReset();
    buildDisplayMessageMock.mockImplementation((input: string) => input);
    queueRemoveMock.mockResolvedValue(undefined);
    queueRestoreMock.mockResolvedValue(undefined);
  });

  it('shows PDF preparation before dispatching the analysis to EVE', async () => {
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/report.pdf'], content: '' };
    const preparation = createDeferred<unknown>();
    pdfPrepareInvokeMock.mockReturnValue(preparation.promise);
    const send = createDeferred<unknown>();
    sendMessageInvokeMock.mockReturnValue(send.promise);

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    act(() => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    expect(await screen.findByTestId('acp-document-preparation')).toHaveTextContent('reading_local');
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();

    await act(async () => {
      preparation.resolve({
        success: true,
        data: {
          ok: true,
          documents: [
            {
              source_path: '/tmp/report.pdf',
              sidecar_path: '/tmp/hermes/document-intelligence/report.md',
            },
          ],
        },
      });
    });

    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('acp-document-preparation')).toHaveTextContent('handoff');
    expect(sendMessageInvokeMock).toHaveBeenCalledWith({
      input: 'Hello',
      conversation_id: 'conv-1',
      files: ['/tmp/report.pdf', '/tmp/hermes/document-intelligence/report.md'],
    });
    expect(buildDisplayMessageMock).toHaveBeenCalledWith('Hello', ['/tmp/report.pdf'], '/tmp/workspace');

    await act(async () => {
      send.resolve({});
    });
    await waitFor(() => expect(screen.queryByTestId('acp-document-preparation')).toBeNull());
  });

  it('keeps a second PDF submit visible instead of silently dropping it', async () => {
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/report.pdf'], content: '' };
    const preparation = createDeferred<unknown>();
    pdfPrepareInvokeMock.mockReturnValue(preparation.promise);
    sendMessageInvokeMock.mockResolvedValue({
      turn_id: 'turn-1',
      msg_id: 'message-1',
      runtime: {
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        pending_confirmations: 0,
        turn_id: 'turn-1',
      },
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    act(() => {
      screen.getByRole('button', { name: 'send' }).click();
    });
    expect(await screen.findByTestId('acp-document-preparation')).toHaveTextContent('reading_local');

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    expect(pdfPrepareInvokeMock).toHaveBeenCalledTimes(1);
    expect(messageWarningMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      preparation.resolve({
        success: true,
        data: {
          ok: true,
          documents: [
            {
              source_path: '/tmp/report.pdf',
              sidecar_path: '/tmp/hermes/document-intelligence/report.md',
            },
          ],
        },
      });
    });
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
  });

  it('routes a fresh-chat PDF through the same native preparation path', async () => {
    const preparation = createDeferred<unknown>();
    pdfPrepareInvokeMock.mockReturnValue(preparation.promise);
    sendMessageInvokeMock.mockResolvedValue({
      turn_id: 'turn-1',
      msg_id: 'message-1',
      runtime: {
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        pending_confirmations: 0,
        turn_id: 'turn-1',
      },
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    let submission!: Promise<boolean>;
    act(() => {
      submission = initialMessageParamsMock.current?.sendInitialMessage?.('Read this PDF', [
        '/tmp/report.pdf',
      ]) as Promise<boolean>;
    });

    expect(await screen.findByTestId('acp-document-preparation')).toHaveTextContent('reading_local');
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();

    await act(async () => {
      preparation.resolve({
        success: true,
        data: {
          ok: true,
          documents: [
            {
              source_path: '/tmp/report.pdf',
              sidecar_path: '/tmp/hermes/document-intelligence/report.md',
            },
          ],
        },
      });
      await submission;
    });

    expect(sendMessageInvokeMock).toHaveBeenCalledWith({
      input: 'Read this PDF',
      conversation_id: 'conv-1',
      files: ['/tmp/report.pdf', '/tmp/hermes/document-intelligence/report.md'],
    });
    expect(buildDisplayMessageMock).toHaveBeenCalledWith('Read this PDF', ['/tmp/report.pdf'], '/tmp/workspace');
  });

  it('keeps an internal PDF sidecar out of the visible queued attachment list', async () => {
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/report.pdf'], content: '' };
    shouldEnqueueMock.mockReturnValue(true);
    pdfPrepareInvokeMock.mockResolvedValue({
      success: true,
      data: {
        ok: true,
        documents: [
          {
            source_path: '/tmp/report.pdf',
            sidecar_path: '/tmp/hermes/document-intelligence/report.md',
          },
        ],
      },
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() =>
      expect(queueEnqueueMock).toHaveBeenCalledWith({
        input: 'Hello',
        files: ['/tmp/report.pdf', '/tmp/hermes/document-intelligence/report.md'],
        displayFiles: ['/tmp/report.pdf'],
      })
    );
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('surfaces a PDF preparation failure without starting a model turn', async () => {
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/broken.pdf'], content: 'Keep this draft' };
    pdfPrepareInvokeMock.mockRejectedValue(new Error('local PDF extraction failed'));

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('error');
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    expect(sendBoxPropsMock.current?.loading).toBe(false);
  });

  it('resets ACP loading state when sendMessage fails before any stream error arrives', async () => {
    sendMessageInvokeMock.mockRejectedValue(
      new BackendHttpError({
        method: 'POST',
        path: '/api/conversations/conv-1/messages',
        status: 400,
        body: {
          success: false,
          code: 'WORKSPACE_PATH_RUNTIME_UNAVAILABLE',
          error: 'Workspace path is unavailable during execution: /tmp/missing',
          details: { workspace_path: '/tmp/missing' },
        },
      })
    );

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='claude'
        workspacePath='/tmp/missing'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => {
      expect(resetStateMock).toHaveBeenCalledTimes(1);
    });
  });

  it('passes external speech recording state and transcription control into SendBox', async () => {
    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='claude'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await waitFor(() => {
      expect(sendBoxPropsMock.current?.hasPendingSpeechInput).toBe(true);
    });

    const transcribePendingSpeechInput = sendBoxPropsMock.current?.transcribePendingSpeechInput as
      | ((options?: { emit?: boolean }) => Promise<string | null>)
      | undefined;
    await expect(transcribePendingSpeechInput?.({ emit: false })).resolves.toBe('spoken prompt');
    expect(speechTranscribePendingMock).toHaveBeenCalledWith({ emit: false });
  });

  it('removes a queued text command before promoting it into the running turn', async () => {
    const queuedItem = {
      id: 'queued-1',
      input: 'Use the corrected customer segment',
      files: [],
      created_at: 1,
    };
    queueItemsMock.current = [queuedItem];
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    runtimeViewMock.activeTurnId = 'turn-1';
    steerInvokeMock.mockResolvedValue({
      msg_id: 'correction-1',
      turn_id: 'turn-1',
      accepted: true,
      runtime: null,
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    const onPromote = queuePanelPropsMock.current?.onPromote as
      | ((item: typeof queuedItem) => Promise<void>)
      | undefined;
    expect(onPromote).toBeTypeOf('function');
    await act(async () => {
      await onPromote?.(queuedItem);
    });

    expect(steerInvokeMock).toHaveBeenCalledWith({
      input: '/steer Use the corrected customer segment',
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
      request_id: 'queued-1',
    });
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    expect(queueRemoveMock).toHaveBeenCalledWith('queued-1');
    expect(queueRemoveMock.mock.invocationCallOrder[0]).toBeLessThan(steerInvokeMock.mock.invocationCallOrder[0]);
    expect(queueRestoreMock).not.toHaveBeenCalled();
    expect(queueLockMock).toHaveBeenCalledTimes(1);
    expect(queueUnlockMock).toHaveBeenCalledTimes(1);
  });

  it('restores a promoted command when the running-turn correction fails', async () => {
    const queuedItem = {
      id: 'queued-1',
      input: 'Use the corrected customer segment',
      files: [],
      created_at: 1,
    };
    queueItemsMock.current = [queuedItem];
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    runtimeViewMock.activeTurnId = 'turn-1';
    steerInvokeMock.mockRejectedValue(new Error('steer rejected'));

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    const onPromote = queuePanelPropsMock.current?.onPromote as
      | ((item: typeof queuedItem) => Promise<void>)
      | undefined;
    expect(onPromote).toBeTypeOf('function');
    await act(async () => {
      await onPromote?.(queuedItem);
    });

    expect(queueRemoveMock).toHaveBeenCalledWith('queued-1');
    expect(queueRestoreMock).toHaveBeenCalledWith(queuedItem);
    expect(queueUnlockMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates rapid promotion attempts for the same queued command', async () => {
    const queuedItem = {
      id: 'queued-1',
      input: 'Use the corrected customer segment',
      files: [],
      created_at: 1,
    };
    queueItemsMock.current = [queuedItem];
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    runtimeViewMock.activeTurnId = 'turn-1';
    const send = createDeferred<unknown>();
    steerInvokeMock.mockReturnValue(send.promise);

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    const onPromote = queuePanelPropsMock.current?.onPromote as
      | ((item: typeof queuedItem) => Promise<void>)
      | undefined;
    const first = onPromote?.(queuedItem);
    const duplicate = onPromote?.(queuedItem);
    await duplicate;

    expect(queueRemoveMock).toHaveBeenCalledTimes(1);
    expect(steerInvokeMock).toHaveBeenCalledTimes(1);

    send.resolve({});
    await act(async () => {
      await first;
    });
  });

  it('routes a correction-now command through the active Hermes turn instead of starting a second turn', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: '/steer Correct the active run' };
    sendBoxMessageMock.current = '/steer Correct the active run';
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    runtimeViewMock.activeTurnId = 'turn-1';
    steerInvokeMock.mockResolvedValue({
      msg_id: 'correction-1',
      turn_id: 'turn-1',
      accepted: true,
      runtime: null,
    });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    expect(steerInvokeMock).toHaveBeenCalledWith({
      input: '/steer Correct the active run',
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
      request_id: expect.any(String),
    });
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('reuses the same correction request id after a transport failure', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: '/steer Correct the active run' };
    sendBoxMessageMock.current = '/steer Correct the active run';
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    runtimeViewMock.activeTurnId = 'turn-1';
    steerInvokeMock
      .mockRejectedValueOnce(new Error('transport timeout'))
      .mockResolvedValueOnce({ msg_id: 'correction-1', turn_id: 'turn-1', accepted: true, runtime: null });

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });
    await waitFor(() => expect(steerInvokeMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });
    await waitFor(() => expect(steerInvokeMock).toHaveBeenCalledTimes(2));

    expect(steerInvokeMock.mock.calls[1][0].request_id).toBe(steerInvokeMock.mock.calls[0][0].request_id);
  });

  it('queues an explicit queue command without sending it to the active Hermes turn', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: '/queue Run the tests afterwards' };
    sendBoxMessageMock.current = '/queue Run the tests afterwards';
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    runtimeViewMock.activeTurnId = 'turn-1';
    shouldEnqueueMock.mockReturnValue(true);

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    expect(queueEnqueueMock).toHaveBeenCalledWith({
      input: 'Run the tests afterwards',
      files: [],
      displayFiles: [],
    });
    expect(steerInvokeMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('restores the draft after a correction-now request is rejected', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: '/steer Correct the active run' };
    sendBoxMessageMock.current = '/steer Correct the active run';
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    runtimeViewMock.activeTurnId = 'turn-1';
    steerInvokeMock.mockRejectedValue(new Error('correction rejected'));

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => expect(messageErrorMock).toHaveBeenCalled());
    const restoredStates = draftMutateMock.mock.calls.map(([updater]) =>
      typeof updater === 'function' ? updater(draftDataMock.current) : updater
    );
    expect(restoredStates).toContainEqual(expect.objectContaining({ content: '/steer Correct the active run' }));
    expect(setUploadFileMock).toHaveBeenCalledWith([]);
    expect(emitterEmitMock).toHaveBeenCalledWith('acp.selected.file', []);
  });

  it('restores the draft and files when enqueue rejects the command', async () => {
    draftDataMock.current = {
      atPath: ['/tmp/workspace/context.md'],
      uploadFile: ['/tmp/upload.txt'],
      content: 'Queue this with context',
    };
    sendBoxMessageMock.current = 'Queue this with context';
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    shouldEnqueueMock.mockReturnValue(true);
    queueEnqueueMock.mockReturnValue(null);

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='claude'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    expect(queueEnqueueMock).toHaveBeenCalledWith({
      input: 'Queue this with context',
      files: ['/tmp/upload.txt', '/tmp/workspace/context.md'],
      displayFiles: ['/tmp/upload.txt', '/tmp/workspace/context.md'],
    });
    const restoredStates = draftMutateMock.mock.calls.map(([updater]) =>
      typeof updater === 'function' ? updater(draftDataMock.current) : updater
    );
    expect(restoredStates).toContainEqual(expect.objectContaining({ content: 'Queue this with context' }));
    expect(restoredStates).toContainEqual(expect.objectContaining({ atPath: ['/tmp/workspace/context.md'] }));
    expect(setUploadFileMock).toHaveBeenCalledWith(['/tmp/upload.txt']);
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('warns and queues a correction that includes files', async () => {
    draftDataMock.current = {
      atPath: [],
      uploadFile: ['/tmp/evidence.txt'],
      content: '/steer Use this evidence',
    };
    sendBoxMessageMock.current = '/steer Use this evidence';
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    shouldEnqueueMock.mockReturnValue(true);

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='claude'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    expect(messageWarningMock).toHaveBeenCalled();
    expect(queueEnqueueMock).toHaveBeenCalledWith({
      input: 'Use this evidence',
      files: ['/tmp/evidence.txt'],
      displayFiles: ['/tmp/evidence.txt'],
    });
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('pauses queued work before stopping the active turn', async () => {
    runtimeViewMock.activeTurnId = 'turn-1';

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='claude'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    const onStop = sendBoxPropsMock.current?.onStop as (() => Promise<void>) | undefined;
    await act(async () => {
      await onStop?.();
    });

    expect(queuePauseMock).toHaveBeenCalledTimes(1);
    expect(runtimeViewMock.markStopRequested).toHaveBeenCalledWith('turn-1');
  });

  it('offers a per-chat HG4 delegation on mobile and publishes it only after backend ack and persistence', async () => {
    layoutIsMobileMock.current = true;
    agentModesMock.current = [
      { value: 'default', label: 'Ask every time' },
      { value: 'dont_ask', label: 'Auto' },
    ];
    const backendAck = createDeferred<{ mode: string; initialized: boolean }>();
    const persistence = createDeferred<void>();
    setModeInvokeMock.mockReturnValue(backendAck.promise);
    configSetMock.mockReturnValue(persistence.promise);

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        session_mode='default'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    const entries = mobileActionSheetPropsMock.current?.entries as
      | Array<{
          key: string;
          submenu?: {
            options: Array<{ key: string; label: string; description?: string }>;
            onSelect: (key: string) => void;
          };
        }>
      | undefined;
    const permissionEntry = entries?.find((entry) => entry.key === 'permission');
    const delegatedOption = permissionEntry?.submenu?.options.find(
      (option) => option.key === COMMAND_EVE_HG4_DELEGATED_MODE
    );
    expect(delegatedOption?.label).toContain('this chat');
    expect(delegatedOption?.description).toContain('this conversation');

    act(() => permissionEntry?.submenu?.onSelect(COMMAND_EVE_HG4_DELEGATED_MODE));
    await waitFor(() =>
      expect(setModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1', mode: 'dont_ask' })
    );
    expect(configSetMock).not.toHaveBeenCalled();
    expect(emitterEmitMock).not.toHaveBeenCalledWith('acp.permission.mode', {
      conversation_id: 'conv-1',
      mode: COMMAND_EVE_HG4_DELEGATED_MODE,
    });

    await act(async () => backendAck.resolve({ mode: 'dont_ask', initialized: true }));
    await waitFor(() => expect(configSetMock).toHaveBeenCalled());
    expect(configSetMock).toHaveBeenCalledWith(
      'acp.config',
      expect.objectContaining({
        hermes: expect.objectContaining({
          preferredMode: 'dont_ask',
          hg4Delegations: expect.objectContaining({
            'conv-1': expect.objectContaining({
              active: true,
              scope: 'conversation',
              authority: 'through_hg3_5',
            }),
          }),
        }),
      })
    );
    expect(emitterEmitMock).not.toHaveBeenCalledWith('acp.permission.mode', {
      conversation_id: 'conv-1',
      mode: COMMAND_EVE_HG4_DELEGATED_MODE,
    });

    await act(async () => persistence.resolve(undefined));
    await waitFor(() =>
      expect(emitterEmitMock).toHaveBeenCalledWith('acp.permission.mode', {
        conversation_id: 'conv-1',
        mode: COMMAND_EVE_HG4_DELEGATED_MODE,
      })
    );
  });

  it('restores and immediately revokes a persisted mobile grant even when backend setMode fails', async () => {
    layoutIsMobileMock.current = true;
    agentModesMock.current = [
      { value: 'default', label: 'Ask every time' },
      { value: 'dont_ask', label: 'Auto' },
    ];
    configGetMock.mockImplementation((key: string) =>
      key === 'acp.config'
        ? {
            hermes: {
              preferredMode: 'dont_ask',
              hg4Delegations: {
                'conv-1': {
                  active: true,
                  scope: 'conversation',
                  authority: 'through_hg3_5',
                  conversationId: 'conv-1',
                  backendMode: 'dont_ask',
                  grantedAt: '2026-07-17T18:00:00.000Z',
                  riskAcknowledgedAt: '2026-07-17T18:00:00.000Z',
                  updatedAt: '2026-07-17T18:00:00.000Z',
                },
              },
            },
          }
        : undefined
    );
    getModeInvokeMock.mockResolvedValue({ mode: 'dont_ask', initialized: true });
    setModeInvokeMock.mockRejectedValue(new Error('backend unavailable'));

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        session_mode='dont_ask'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    act(() => (sendBoxPropsMock.current?.onMobilePlusClick as (() => void) | undefined)?.());
    await waitFor(() => expect(getModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1' }));
    await waitFor(() => {
      const entries = mobileActionSheetPropsMock.current?.entries as
        | Array<{
            key: string;
            submenu?: { options: Array<{ key: string; active?: boolean }>; onSelect: (key: string) => void };
          }>
        | undefined;
      const permissionEntry = entries?.find((entry) => entry.key === 'permission');
      expect(
        permissionEntry?.submenu?.options.find((option) => option.key === COMMAND_EVE_HG4_DELEGATED_MODE)?.active
      ).toBe(true);
    });

    const entries = mobileActionSheetPropsMock.current?.entries as
      | Array<{ key: string; submenu?: { onSelect: (key: string) => void } }>
      | undefined;
    act(() => entries?.find((entry) => entry.key === 'permission')?.submenu?.onSelect('default'));

    await waitFor(() => expect(setModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1', mode: 'default' }));
    expect(emitterEmitMock).toHaveBeenCalledWith('acp.permission.mode', {
      conversation_id: 'conv-1',
      mode: 'default',
    });
    expect(configSetMock).toHaveBeenCalledWith(
      'acp.config',
      expect.objectContaining({
        hermes: expect.objectContaining({
          preferredMode: 'default',
          hg4Delegations: expect.objectContaining({
            'conv-1': expect.objectContaining({ active: false, revokedAt: expect.any(String) }),
          }),
          hg4DelegationAudit: expect.arrayContaining([
            expect.objectContaining({ event: 'revoked', conversationId: 'conv-1' }),
          ]),
        }),
      })
    );
    expect(emitterEmitMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
      configSetMock.mock.invocationCallOrder.at(-1)!
    );
    expect(emitterEmitMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
      setModeInvokeMock.mock.invocationCallOrder.at(-1)!
    );
  });

  it('publishes a restrictive mobile permission mode before backend acknowledgement', async () => {
    layoutIsMobileMock.current = true;
    agentModesMock.current = [
      { value: 'default', label: 'Ask every time' },
      { value: 'dont_ask', label: 'Do not ask' },
    ];
    const setMode = createDeferred<{ mode: string; initialized: boolean }>();
    setModeInvokeMock.mockReturnValue(setMode.promise);

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        session_mode='dont_ask'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    const entries = mobileActionSheetPropsMock.current?.entries as
      | Array<{ key: string; submenu?: { onSelect: (key: string) => void } }>
      | undefined;
    const permissionEntry = entries?.find((entry) => entry.key === 'permission');
    expect(permissionEntry?.submenu).toBeDefined();

    act(() => {
      permissionEntry?.submenu?.onSelect('default');
    });
    await waitFor(() => {
      expect(setModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1', mode: 'default' });
    });
    expect(emitterEmitMock).toHaveBeenCalledWith('acp.permission.mode', {
      conversation_id: 'conv-1',
      mode: 'default',
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
