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
  imagePrepareInvokeMock,
  presentationPrepareInvokeMock,
  cloudVisualPolicyReceiptInvokeMock,
  managedVisualTurnAuthorizeInvokeMock,
  videoGenerateInvokeMock,
  pptPreviewStartInvokeMock,
  pptPreviewStopInvokeMock,
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
  queueOnExecuteMock,
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
  modalConfirmMock,
  configGetMock,
  configSetMock,
  initialMessageParamsMock,
  buildDisplayMessageMock,
} = vi.hoisted(() => ({
  sendMessageInvokeMock: vi.fn(),
  steerInvokeMock: vi.fn(),
  pdfPrepareInvokeMock: vi.fn(),
  imagePrepareInvokeMock: vi.fn(),
  presentationPrepareInvokeMock: vi.fn(),
  cloudVisualPolicyReceiptInvokeMock: vi.fn(),
  managedVisualTurnAuthorizeInvokeMock: vi.fn(),
  videoGenerateInvokeMock: vi.fn(),
  pptPreviewStartInvokeMock: vi.fn(),
  pptPreviewStopInvokeMock: vi.fn(),
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
  queueOnExecuteMock: {
    current: null as ((item: Record<string, unknown>) => Promise<void>) | null,
  },
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
  modalConfirmMock: vi.fn(),
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
      imagePrepare: {
        invoke: imagePrepareInvokeMock,
      },
      presentationPrepare: {
        invoke: presentationPrepareInvokeMock,
      },
      cloudVisualPolicyReceipt: {
        invoke: cloudVisualPolicyReceiptInvokeMock,
      },
      managedVisualTurnAuthorize: {
        invoke: managedVisualTurnAuthorizeInvokeMock,
      },
      videoGenerate: {
        invoke: videoGenerateInvokeMock,
      },
    },
    pptPreview: {
      start: {
        invoke: pptPreviewStartInvokeMock,
      },
      stop: {
        invoke: pptPreviewStopInvokeMock,
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
  default: (props: {
    onSend: (message: string) => Promise<void>;
    rightTools?: React.ReactNode;
    prefix?: React.ReactNode;
  }) => {
    sendBoxPropsMock.current = props as unknown as Record<string, unknown>;
    return (
      <>
        {/* The real SendBox renders `prefix` (the draft band: file chips, folder
            tags, the video-quality picker). The double used to drop it, which
            made anything mounted there invisible to these tests. */}
        {props.prefix}
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
// The non-EVE model picker lives in the bottom bar's modelSlot. An EVE composer
// has NO cloud intelligence picker at all (MAT-1749) — only the MAX toggle, which
// is stubbed here so this test stays focused on the send/reset path, mirroring
// the AgentModeSelector stub.
vi.mock('@/renderer/components/agent/AcpModelSelector', () => ({ default: () => null }));
vi.mock('@/renderer/components/agent/EveMaxToggle', () => ({ default: () => null }));
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
  useConversationCommandQueue: (input: { onExecute: (item: Record<string, unknown>) => Promise<void> }) => {
    queueOnExecuteMock.current = input.onExecute;
    return {
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
    };
  },
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
  Modal: {
    confirm: modalConfirmMock,
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
    queueOnExecuteMock.current = null;
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
    imagePrepareInvokeMock.mockReset();
    presentationPrepareInvokeMock.mockReset();
    cloudVisualPolicyReceiptInvokeMock.mockReset();
    managedVisualTurnAuthorizeInvokeMock.mockReset();
    videoGenerateInvokeMock.mockReset();
    videoGenerateInvokeMock.mockResolvedValue({
      success: true,
      data: {
        ok: true,
        artifact: {
          mimeType: 'video/mp4',
          dataBase64: 'AAAA',
          bytes: 3,
          sha256: 'e'.repeat(64),
          resolution: '720p',
          model: 'grok-imagine-video',
          tierId: 'fast',
          durationSeconds: 5,
          estimatedCredits: 700,
        },
        conversationArtifact: {
          id: 'video-artifact-1',
          conversation_id: 'conv-1',
          kind: 'video',
          status: 'active',
          payload: {
            artifact_type: 'video',
            title: 'Video 720p',
            description: '720p · 5s · ca. 700 Credits · grok-imagine-video',
            path: '/tmp/Downloads/video-artifact-1.mp4',
            mime_type: 'video/mp4',
            hash: 'e'.repeat(64),
            size: 3,
          },
          created_at: 1000,
          updated_at: 1000,
        },
      },
    });
    pptPreviewStartInvokeMock.mockReset();
    pptPreviewStopInvokeMock.mockReset();
    modalConfirmMock.mockReset();
    pptPreviewStartInvokeMock.mockResolvedValue({ url: '/api/ppt-proxy/41000' });
    pptPreviewStopInvokeMock.mockResolvedValue(undefined);
    cloudVisualPolicyReceiptInvokeMock.mockImplementation(({ flowId }: { flowId: string }) =>
      Promise.resolve({
        success: true,
        data: {
          ok: true,
          policy: {
            status: 'enabled',
            reason: 'enabled_by_product_default',
            seatId: 'owner',
            physicalKey: 'commandEve.cloudVisualAnalysisEnabled',
          },
          receipt: {
            version: 'command-eve-cloud-visual-policy/v1',
            receiptId: 'R'.repeat(43),
            flowId,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        },
      })
    );
    managedVisualTurnAuthorizeInvokeMock.mockResolvedValue({
      success: true,
      data: {
        ok: true,
        marker: `[[COMMAND_EVE_MANAGED_VISUAL_TURN:${'V'.repeat(43)}]]`,
        tier: 'high',
      },
    });
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

  it('inspects a cached PPTX locally and mints one receipt only before the managed marker', async () => {
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/board-deck.pptx'], content: '' };
    presentationPrepareInvokeMock.mockResolvedValue({
      success: true,
      data: {
        ok: true,
        documents: [
          {
            source_path: '/tmp/board-deck.pptx',
            source_name: 'board-deck.pptx',
            sidecar_path: '/tmp/hermes/document-intelligence/presentation/deck/document.md',
            prompt_context: '## PPTX slide 1\n\nTitle slide.',
          },
        ],
      },
    });
    sendMessageInvokeMock.mockResolvedValue({
      turn_id: 'turn-pptx',
      msg_id: 'message-pptx',
      runtime: {
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        pending_confirmations: 0,
        turn_id: 'turn-pptx',
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

    await act(async () => screen.getByRole('button', { name: 'send' }).click());

    await waitFor(() => expect(presentationPrepareInvokeMock).toHaveBeenCalledTimes(1));
    expect(cloudVisualPolicyReceiptInvokeMock).toHaveBeenCalledTimes(1);
    const { flowId } = cloudVisualPolicyReceiptInvokeMock.mock.calls[0][0] as { flowId: string };
    const authority = {
      flowId,
      visualPolicyReceipt: expect.objectContaining({
        version: 'command-eve-cloud-visual-policy/v1',
        flowId,
      }),
    };
    expect(presentationPrepareInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePaths: ['/tmp/board-deck.pptx'],
        privacyLane: 'cloud_auto',
      })
    );
    expect(presentationPrepareInvokeMock.mock.calls[0]?.[0]).not.toHaveProperty('flowId');
    expect(presentationPrepareInvokeMock.mock.calls[0]?.[0]).not.toHaveProperty('visualPolicyReceipt');
    expect(presentationPrepareInvokeMock.mock.calls[0]?.[0]).not.toHaveProperty('allowCloudVision');
    expect(presentationPrepareInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      cloudVisualPolicyReceiptInvokeMock.mock.invocationCallOrder[0]
    );
    expect(cloudVisualPolicyReceiptInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      managedVisualTurnAuthorizeInvokeMock.mock.invocationCallOrder[0]
    );
    expect(modalConfirmMock).not.toHaveBeenCalled();
    expect(managedVisualTurnAuthorizeInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({ ...authority, preferredTier: 'high', sourceCount: 1 })
    );
    await waitFor(() =>
      expect(sendMessageInvokeMock).toHaveBeenCalledWith({
        input: expect.stringContaining('Hello'),
        conversation_id: 'conv-1',
        files: ['/tmp/board-deck.pptx', '/tmp/hermes/document-intelligence/presentation/deck/document.md'],
      })
    );
    expect(pptPreviewStartInvokeMock).not.toHaveBeenCalled();
    expect(pdfPrepareInvokeMock).not.toHaveBeenCalled();
  });

  it('validates a PPTX before bootstrapping a missing OfficeCLI engine', async () => {
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/board-deck.pptx'], content: '' };
    presentationPrepareInvokeMock
      .mockResolvedValueOnce({
        success: false,
        data: {
          ok: false,
          reason_code: 'EVE_PRESENTATION_ENGINE_UNAVAILABLE',
          requires_cloud_vision_consent: false,
          documents: [],
          prepared_files: [],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          ok: true,
          documents: [
            {
              source_path: '/tmp/board-deck.pptx',
              source_name: 'board-deck.pptx',
              sidecar_path: '/tmp/hermes/document-intelligence/presentation/deck/document.md',
              prompt_context: '## PPTX slide 1\n\nTitle slide.',
            },
          ],
        },
      });
    sendMessageInvokeMock.mockResolvedValue({
      turn_id: 'turn-pptx-bootstrap',
      msg_id: 'message-pptx-bootstrap',
      runtime: {
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        pending_confirmations: 0,
        turn_id: 'turn-pptx-bootstrap',
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

    await act(async () => screen.getByRole('button', { name: 'send' }).click());

    await waitFor(() => expect(presentationPrepareInvokeMock).toHaveBeenCalledTimes(2));
    expect(cloudVisualPolicyReceiptInvokeMock).toHaveBeenCalledTimes(1);
    expect(presentationPrepareInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      cloudVisualPolicyReceiptInvokeMock.mock.invocationCallOrder[0]
    );
    expect(presentationPrepareInvokeMock.mock.calls[0]?.[0]).not.toHaveProperty('visualPolicyReceipt');
    expect(presentationPrepareInvokeMock.mock.calls[1]?.[0]).not.toHaveProperty('visualPolicyReceipt');
    expect(pptPreviewStartInvokeMock).toHaveBeenCalledTimes(1);
    expect(pptPreviewStartInvokeMock).toHaveBeenCalledWith({
      file_path: '/tmp/board-deck.pptx',
      workspace: '/tmp/workspace',
    });
    expect(presentationPrepareInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      pptPreviewStartInvokeMock.mock.invocationCallOrder[0]
    );
    expect(pptPreviewStartInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      presentationPrepareInvokeMock.mock.invocationCallOrder[1]
    );
    await waitFor(() => expect(pptPreviewStopInvokeMock).toHaveBeenCalledWith({ file_path: '/tmp/board-deck.pptx' }));
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(modalConfirmMock).not.toHaveBeenCalled();
  });

  it('inspects a cached image locally and mints one receipt only before the managed marker', async () => {
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/screenshot.png'], content: '' };
    imagePrepareInvokeMock.mockResolvedValue({
      success: true,
      data: {
        ok: true,
        documents: [
          {
            source_path: '/tmp/screenshot.png',
            source_name: 'screenshot.png',
            sidecar_path: '/tmp/hermes/document-intelligence/image/hash/document.md',
            prompt_context: '## Image 1\n\nA screenshot.',
          },
        ],
      },
    });
    sendMessageInvokeMock.mockResolvedValue({
      turn_id: 'turn-image',
      msg_id: 'message-image',
      runtime: {
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        pending_confirmations: 0,
        turn_id: 'turn-image',
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

    await act(async () => screen.getByRole('button', { name: 'send' }).click());

    await waitFor(() => expect(imagePrepareInvokeMock).toHaveBeenCalledTimes(1));
    expect(cloudVisualPolicyReceiptInvokeMock).toHaveBeenCalledTimes(1);
    const { flowId } = cloudVisualPolicyReceiptInvokeMock.mock.calls[0][0] as { flowId: string };
    expect(imagePrepareInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePaths: ['/tmp/screenshot.png'],
        privacyLane: 'cloud_auto',
      })
    );
    expect(imagePrepareInvokeMock.mock.calls[0]?.[0]).not.toHaveProperty('flowId');
    expect(imagePrepareInvokeMock.mock.calls[0]?.[0]).not.toHaveProperty('visualPolicyReceipt');
    expect(imagePrepareInvokeMock.mock.calls[0]?.[0]).not.toHaveProperty('allowCloudVision');
    expect(imagePrepareInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      cloudVisualPolicyReceiptInvokeMock.mock.invocationCallOrder[0]
    );
    expect(cloudVisualPolicyReceiptInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      managedVisualTurnAuthorizeInvokeMock.mock.invocationCallOrder[0]
    );
    expect(modalConfirmMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(sendMessageInvokeMock).toHaveBeenCalledWith({
        input: expect.stringContaining('Hello'),
        conversation_id: 'conv-1',
        files: ['/tmp/screenshot.png', '/tmp/hermes/document-intelligence/image/hash/document.md'],
      })
    );
    expect(managedVisualTurnAuthorizeInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({ flowId, preferredTier: 'high', sourceCount: 1 })
    );
    expect(pptPreviewStartInvokeMock).not.toHaveBeenCalled();
    expect(pdfPrepareInvokeMock).not.toHaveBeenCalled();
  });

  it('starts mixed image and PPTX inspection locally, then retries both with one shared receipt', async () => {
    draftDataMock.current = {
      atPath: [],
      uploadFile: ['/tmp/board-deck.pptx', '/tmp/screenshot.png'],
      content: '',
    };
    presentationPrepareInvokeMock
      .mockResolvedValueOnce({
        success: false,
        data: {
          ok: false,
          reason_code: 'EVE_PRESENTATION_CLOUD_VISUAL_POLICY_REQUIRED',
          documents: [],
          prepared_files: [],
          requires_cloud_vision_consent: false,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          ok: true,
          documents: [
            {
              source_path: '/tmp/board-deck.pptx',
              source_name: 'board-deck.pptx',
              sidecar_path: '/tmp/hermes/document-intelligence/presentation/deck/document.md',
              prompt_context: '## PPTX slide 1\n\nTitle slide.',
            },
          ],
        },
      });
    imagePrepareInvokeMock
      .mockResolvedValueOnce({
        success: false,
        data: {
          ok: false,
          reason_code: 'EVE_IMAGE_CLOUD_VISUAL_POLICY_REQUIRED',
          documents: [],
          prepared_files: [],
          requires_cloud_vision_consent: false,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          ok: true,
          documents: [
            {
              source_path: '/tmp/screenshot.png',
              source_name: 'screenshot.png',
              sidecar_path: '/tmp/hermes/document-intelligence/image/hash/document.md',
              prompt_context: '## Image 1\n\nA screenshot.',
            },
          ],
        },
      });
    sendMessageInvokeMock.mockResolvedValue({});

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await act(async () => screen.getByRole('button', { name: 'send' }).click());

    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(cloudVisualPolicyReceiptInvokeMock).toHaveBeenCalledTimes(2);
    expect(presentationPrepareInvokeMock).toHaveBeenCalledTimes(2);
    expect(imagePrepareInvokeMock).toHaveBeenCalledTimes(2);
    const { flowId } = cloudVisualPolicyReceiptInvokeMock.mock.calls[0][0] as { flowId: string };
    const { flowId: dispatchFlowId } = cloudVisualPolicyReceiptInvokeMock.mock.calls[1][0] as { flowId: string };
    expect(dispatchFlowId).not.toBe(flowId);
    expect(presentationPrepareInvokeMock.mock.calls[0]?.[0]).not.toHaveProperty('visualPolicyReceipt');
    expect(imagePrepareInvokeMock.mock.calls[0]?.[0]).not.toHaveProperty('visualPolicyReceipt');
    expect(presentationPrepareInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      cloudVisualPolicyReceiptInvokeMock.mock.invocationCallOrder[0]
    );
    expect(imagePrepareInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      cloudVisualPolicyReceiptInvokeMock.mock.invocationCallOrder[0]
    );
    expect(presentationPrepareInvokeMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ flowId, visualPolicyReceipt: expect.objectContaining({ flowId }) })
    );
    expect(imagePrepareInvokeMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ flowId, visualPolicyReceipt: expect.objectContaining({ flowId }) })
    );
    expect(managedVisualTurnAuthorizeInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: dispatchFlowId,
        visualPolicyReceipt: expect.objectContaining({ flowId: dispatchFlowId }),
        sourceCount: 2,
      })
    );
    expect(modalConfirmMock).not.toHaveBeenCalled();
  });

  it('inspects locally before a denied receipt and preserves the draft with no bypass dialog', async () => {
    draftDataMock.current = {
      atPath: ['/tmp/context.png'],
      uploadFile: ['/tmp/screenshot.png'],
      content: 'Keep this visual draft',
    };
    sendBoxMessageMock.current = 'Keep this visual draft';
    imagePrepareInvokeMock.mockResolvedValue({
      success: false,
      data: {
        ok: false,
        reason_code: 'EVE_IMAGE_CLOUD_VISUAL_POLICY_REQUIRED',
        documents: [],
        prepared_files: [],
        requires_cloud_vision_consent: false,
      },
    });
    cloudVisualPolicyReceiptInvokeMock.mockResolvedValue({
      success: false,
      data: {
        ok: false,
        policy: {
          status: 'disabled',
          reason: 'disabled_by_operator',
          seatId: 'owner',
          physicalKey: 'commandEve.cloudVisualAnalysisEnabled',
        },
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
    await act(async () => screen.getByRole('button', { name: 'send' }).click());

    await waitFor(() => expect(messageErrorMock).toHaveBeenCalledTimes(1));
    expect(presentationPrepareInvokeMock).not.toHaveBeenCalled();
    expect(imagePrepareInvokeMock).toHaveBeenCalledTimes(1);
    expect(imagePrepareInvokeMock.mock.calls[0]?.[0]).not.toHaveProperty('visualPolicyReceipt');
    expect(imagePrepareInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      cloudVisualPolicyReceiptInvokeMock.mock.invocationCallOrder[0]
    );
    expect(managedVisualTurnAuthorizeInvokeMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    expect(modalConfirmMock).not.toHaveBeenCalled();
    expect(setUploadFileMock).toHaveBeenCalledWith(['/tmp/screenshot.png']);
    expect(draftMutateMock).toHaveBeenCalled();
    expect(emitterEmitMock).toHaveBeenCalledWith('acp.selected.file', ['/tmp/context.png']);
  });

  it('rejects more than six visual sources before receipt or preparation', async () => {
    draftDataMock.current = {
      atPath: [],
      uploadFile: Array.from({ length: 7 }, (_, index) => `/tmp/image-${index + 1}.png`),
      content: 'Keep this draft',
    };

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await act(async () => screen.getByRole('button', { name: 'send' }).click());

    await waitFor(() => expect(messageErrorMock).toHaveBeenCalledTimes(1));
    expect(cloudVisualPolicyReceiptInvokeMock).not.toHaveBeenCalled();
    expect(imagePrepareInvokeMock).not.toHaveBeenCalled();
    expect(presentationPrepareInvokeMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    expect(modalConfirmMock).not.toHaveBeenCalled();
  });

  it('keeps PDF OCR consent separate from visual policy receipts', async () => {
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/scanned.pdf'], content: '' };
    pdfPrepareInvokeMock
      .mockResolvedValueOnce({
        success: false,
        data: {
          ok: false,
          requires_cloud_ocr_consent: true,
          pending_source_names: ['scanned.pdf'],
          documents: [],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          ok: true,
          documents: [
            {
              source_path: '/tmp/scanned.pdf',
              sidecar_path: '/tmp/hermes/document-intelligence/scanned.md',
            },
          ],
        },
      });
    modalConfirmMock.mockImplementation((options: { onOk?: () => void }) => options.onOk?.());
    sendMessageInvokeMock.mockResolvedValue({});

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await act(async () => screen.getByRole('button', { name: 'send' }).click());

    await waitFor(() => expect(pdfPrepareInvokeMock).toHaveBeenCalledTimes(2));
    expect(modalConfirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'conversation.pdf.cloudOcrTitle',
        okText: 'conversation.pdf.cloudOcrConfirm',
      })
    );
    expect(cloudVisualPolicyReceiptInvokeMock).not.toHaveBeenCalled();
    expect(managedVisualTurnAuthorizeInvokeMock).not.toHaveBeenCalled();
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
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

  it('hides legacy HG4 delegation on mobile and publishes only a real backend mode', async () => {
    layoutIsMobileMock.current = true;
    agentModesMock.current = [
      { value: 'default', label: 'Ask every time' },
      { value: 'dont_ask', label: 'Auto' },
      { value: COMMAND_EVE_HG4_DELEGATED_MODE, label: 'Legacy Guarded Auto' },
    ];
    setModeInvokeMock.mockResolvedValue({ mode: 'dont_ask', initialized: true });

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
    expect(
      permissionEntry?.submenu?.options.find((option) => option.key === COMMAND_EVE_HG4_DELEGATED_MODE)
    ).toBeUndefined();
    expect(permissionEntry?.submenu?.options.find((option) => option.key === 'dont_ask')).toBeTruthy();

    act(() => permissionEntry?.submenu?.onSelect('dont_ask'));
    await waitFor(() =>
      expect(setModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1', mode: 'dont_ask' })
    );
    await waitFor(() => expect(configSetMock).toHaveBeenCalled());
    expect(emitterEmitMock).toHaveBeenCalledWith('acp.permission.mode', {
      conversation_id: 'conv-1',
      mode: 'dont_ask',
    });
  });

  it('ignores a persisted mobile HG4 record and shows only the real backend mode', async () => {
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
      expect(permissionEntry?.submenu?.options.find((option) => option.key === 'dont_ask')?.active).toBe(true);
      expect(
        permissionEntry?.submenu?.options.find((option) => option.key === COMMAND_EVE_HG4_DELEGATED_MODE)
      ).toBeUndefined();
    });
    expect(setModeInvokeMock).not.toHaveBeenCalled();
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
  // -------------------------------------------------------------------------
  // Video lane: the inline quality picker (1.820.1)
  // -------------------------------------------------------------------------
  // The pre-submit cost wall is gone — asking for a video IS the authorisation
  // for it. Removing it also removed the only surface that could select 1080p,
  // so HD came back as an inline picker. These tests pin the two things that
  // must both hold: HD reaches the dispatched request, and nothing asks a second
  // question on the way there.

  it('offers the quality picker only once the draft actually routes to video', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'summarise this meeting' };
    const { rerender } = render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();

    draftDataMock.current = { atPath: [], uploadFile: [], content: 'erstelle ein Video über unser Produkt' };
    rerender(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-selected-tier', 'fast');
  });

  it('sends a video at the default tier without any confirmation step, and never dispatches to the agent', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'erstelle ein Video über unser Produkt' };
    sendBoxMessageMock.current = 'erstelle ein Video über unser Produkt';

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

    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    expect(videoGenerateInvokeMock.mock.calls[0][0]).toMatchObject({ tierId: 'fast', conversationId: 'conv-1' });
    // The wall is gone: no modal was opened on the way to dispatch. And there is
    // no second path to the agent for a managed video request.
    expect(modalConfirmMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('refuses a 1080p tier the provider cannot produce from a text prompt', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'erstelle ein Video über unser Produkt' };
    sendBoxMessageMock.current = 'erstelle ein Video über unser Produkt';

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    // There is no 1080p option at all for a text draft: grok-imagine-video stops
    // at 720p and grok-imagine-video-1.5, which reaches 1080p, cannot take a bare
    // prompt. The picker therefore never renders it.
    expect(screen.queryByTestId('video-quality-option-hd')).toBeNull();

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    // It generates at a tier that CAN be produced, and never claims 1080p.
    expect(videoGenerateInvokeMock.mock.calls[0][0]).toMatchObject({ tierId: 'fast' });
    expect(modalConfirmMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });
  it('ignores a tier the user never saw: no visible picker means the cheap default', async () => {
    // CAO's divergence case, made structural. SendBox enriches the draft before
    // onSend (reply quote, DOM snippets, a speech transcript captured at send
    // time), so a message can route to video while the draft alone does not —
    // and the picker was therefore never shown. The double models exactly that:
    // the draft is inert, the dispatched message is the video request.
    // Step 1: a real video draft, so the picker IS shown and HD IS chosen. Without
    // this the test would pass on the default alone and prove nothing.
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'erstelle ein Video über unser Produkt' };

    const { rerender } = render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    act(() => {
      screen.getByTestId('video-quality-option-sd').click();
    });
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-selected-tier', 'sd');

    // Step 2: the draft becomes inert, so the picker disappears — but the message
    // SendBox hands to onSend still carries the video intent via the reply quote.
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'ja bitte, mach das' };
    sendBoxMessageMock.current = '> Sollen wir ein Video über den Launch erstellen?\n\nja bitte, mach das';
    rerender(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    // It still routes to video (the enriched message carries the intent) — but at
    // the cheap default, never at a stale HD pick the user cannot connect to it.
    expect(videoGenerateInvokeMock.mock.calls[0][0]).toMatchObject({ tierId: 'fast' });
  });

  it('does not let an HD pick outlive its own send', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'erstelle ein Video über unser Produkt' };
    sendBoxMessageMock.current = 'erstelle ein Video über unser Produkt';

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    act(() => {
      screen.getByTestId('video-quality-option-sd').click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });
    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    expect(videoGenerateInvokeMock.mock.calls[0][0]).toMatchObject({ tierId: 'sd' });

    // "Default stays Fast/Standard" has to hold for the NEXT video too.
    await waitFor(() => expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-selected-tier', 'fast'));

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });
    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(2));
    expect(videoGenerateInvokeMock.mock.calls[1][0]).toMatchObject({ tierId: 'fast' });
  });

  it('keeps the cheaper pick standing when the send was REFUSED', async () => {
    // Found live, not in a test: a 480p request was refused, the draft came
    // back, and the picker read 720p. The obvious next action — send the
    // restored draft again — would then have cost 700 credits instead of 500,
    // with nothing on screen saying the price had changed. Resetting to the
    // default is only ever cheaper when the user picked HD.
    videoGenerateInvokeMock.mockResolvedValue({
      success: true,
      data: {
        ok: false,
        reasonCode: 'request-replayed',
        message: 'Dieses Video wurde bereits erstellt.',
        retryable: false,
      },
    });
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'erstelle ein Video über unser Produkt' };
    sendBoxMessageMock.current = 'erstelle ein Video über unser Produkt';

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    act(() => {
      screen.getByTestId('video-quality-option-sd').click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    expect(videoGenerateInvokeMock.mock.calls[0][0]).toMatchObject({ tierId: 'sd' });
    await waitFor(() => expect(messageErrorMock).toHaveBeenCalled());

    // The choice the user made moments ago is still the choice.
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-selected-tier', 'sd');

    // And a resend stays at the price the picker is showing.
    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });
    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(2));
    expect(videoGenerateInvokeMock.mock.calls[1][0]).toMatchObject({ tierId: 'sd' });
  });

  it('calls the REAL video endpoint, not just a prompt stamp', async () => {
    // The defect this closes: the lane used to stamp "[EVE:VIDEO ...]" into the
    // text and stop. The deployed gateway had no video branch at all, so the
    // stamp travelled and nothing generated. A stamp alone is not a video.
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'erstelle ein Video über unser Produkt' };
    sendBoxMessageMock.current = 'erstelle ein Video über unser Produkt';
    sendMessageInvokeMock.mockResolvedValue({});

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

    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    const sent = videoGenerateInvokeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.tierId).toBe('fast');
    expect(sent.prompt).toContain('Video');
    expect(typeof sent.durationSeconds).toBe('number');
  });

  it('shows the server reason when a video is refused, not a generic sentence', async () => {
    // Six distinct refusals exist server-side; flattening them here would waste
    // every one of them. This pins that the spend-cap sentence reaches the user.
    videoGenerateInvokeMock.mockResolvedValue({
      success: true,
      data: {
        ok: false,
        reasonCode: 'spend_cap_exceeded',
        message: 'Dieses Video würde das Ausgabenlimit für den aktuellen Zeitraum überschreiten.',
        retryable: false,
      },
    });
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'erstelle ein Video über unser Produkt' };
    sendBoxMessageMock.current = 'erstelle ein Video über unser Produkt';

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
    const shown = messageErrorMock.mock.calls.at(-1)?.[0] as { content?: string } | undefined;
    expect(shown?.content).toContain('Ausgabenlimit');
    // A refusal must never create a fake success artifact — there is nothing to show.
    expect(emitterEmitMock).not.toHaveBeenCalledWith('acp.video.generated', expect.anything());
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('starts exactly one provider job per send, and never dispatches the same intent to the agent', async () => {
    // A managed video request used to ALSO dispatch a `[EVE:VIDEO ...]`-stamped
    // message into the normal ACP turn — a second path that could ask the
    // agent/runtime to execute the same generation intent again. One user send
    // must call videoGenerate exactly once and must never send that message.
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'erstelle ein Video über unser Produkt' };
    sendBoxMessageMock.current = 'erstelle ein Video über unser Produkt';

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

    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('forwards the attached image path and conversation id for image-to-video, without any cloud vision call', async () => {
    // A video intent must never trigger presentation/image cloud analysis: the
    // attached image is a VIDEO SOURCE, not a vision-analysis request. The old
    // ordering ran the image-intelligence pipeline (and its visual-policy
    // receipt) for every send, including a video one, before routing was even
    // decided — this pins that it no longer does.
    draftDataMock.current = {
      atPath: [],
      uploadFile: ['/tmp/photo.png'],
      content: 'erstelle ein Video über unser Produkt',
    };
    sendBoxMessageMock.current = 'erstelle ein Video über unser Produkt';

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

    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    const sent = videoGenerateInvokeMock.mock.calls[0][0] as Record<string, unknown>;
    // Only the PATH crosses the boundary — Main re-reads and re-hashes it. The
    // renderer never computes or forwards bytes/a digest itself.
    expect(sent.imagePath).toBe('/tmp/photo.png');
    expect(sent.conversationId).toBe('conv-1');
    expect(sent).not.toHaveProperty('imageBase64');
    expect(sent).not.toHaveProperty('imageSha256');
    // Hard assertion (not a mocked workaround): the vision-analysis pipeline and
    // its visual-policy receipt are never invoked for an image->video send.
    expect(imagePrepareInvokeMock).not.toHaveBeenCalled();
    expect(cloudVisualPolicyReceiptInvokeMock).not.toHaveBeenCalled();
    expect(managedVisualTurnAuthorizeInvokeMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('a text-only send never carries an image path', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'erstelle ein Video über unser Produkt' };
    sendBoxMessageMock.current = 'erstelle ein Video über unser Produkt';
    sendMessageInvokeMock.mockResolvedValue({});

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

    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    const sent = videoGenerateInvokeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('imagePath');
  });

  it('a successful generation emits the durable, path-based artifact for this conversation', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'erstelle ein Video über unser Produkt' };
    sendBoxMessageMock.current = 'erstelle ein Video über unser Produkt';
    sendMessageInvokeMock.mockResolvedValue({});

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
      expect(emitterEmitMock).toHaveBeenCalledWith('acp.video.generated', {
        conversation_id: 'conv-1',
        artifact: expect.objectContaining({
          id: 'video-artifact-1',
          conversation_id: 'conv-1',
          kind: 'video',
          status: 'active',
          payload: expect.objectContaining({
            artifact_type: 'video',
            // A local file PATH, never a data: URL — the ephemeral,
            // does-not-survive-reload shape this lane must not repeat.
            path: '/tmp/Downloads/video-artifact-1.mp4',
          }),
        }),
      })
    );
  });
});
