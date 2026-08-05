/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import AcpSendBox from '@/renderer/pages/conversation/platforms/acp/AcpSendBox';
import type { UseAcpMessageReturn } from '@/renderer/pages/conversation/platforms/acp/useAcpMessage';
import { COMMAND_EVE_HG4_DELEGATED_MODE } from '@/renderer/utils/model/agentModes';
import { stripCommandEvePreparedContext } from '@/common/config/evePreparedContextCore';
import { ConversationArtifactProvider } from '@/renderer/pages/conversation/Messages/artifacts';

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
  maxAuthorityMock,
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
  artifactContextEnvelopeInvokeMock,
  videoCapabilitiesInvokeMock,
  artifactTurnSteerInvokeMock,
  imageModelPreferenceReadInvokeMock,
  imageModelPreferenceSetInvokeMock,
  imageCapabilitiesInvokeMock,
  cloudVisualPolicySetInvokeMock,
  listArtifactsInvokeMock,
  videoArtifactsListInvokeMock,
  imageArtifactsListInvokeMock,
  chatHistoryRefreshHandlerMock,
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
  // What MAIN reports about the lane. Default = a decided, unheld lane, which
  // is what every pre-existing case in this file assumes.
  maxAuthorityMock: { maxActive: false, entitlementPending: false },
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
  artifactContextEnvelopeInvokeMock: vi.fn(),
  videoCapabilitiesInvokeMock: vi.fn(),
  artifactTurnSteerInvokeMock: vi.fn(),
  imageModelPreferenceReadInvokeMock: vi.fn(),
  imageModelPreferenceSetInvokeMock: vi.fn(),
  imageCapabilitiesInvokeMock: vi.fn(),
  cloudVisualPolicySetInvokeMock: vi.fn(),
  listArtifactsInvokeMock: vi.fn(),
  videoArtifactsListInvokeMock: vi.fn(),
  imageArtifactsListInvokeMock: vi.fn(),
  chatHistoryRefreshHandlerMock: { current: null as null | (() => void) },
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
      listArtifacts: {
        invoke: listArtifactsInvokeMock,
      },
      artifactStream: {
        on: vi.fn(() => () => {}),
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
      cloudVisualPolicySet: {
        invoke: cloudVisualPolicySetInvokeMock,
      },
      managedVisualTurnAuthorize: {
        invoke: managedVisualTurnAuthorizeInvokeMock,
      },
      videoGenerate: {
        invoke: videoGenerateInvokeMock,
      },
      artifactContextEnvelope: {
        invoke: artifactContextEnvelopeInvokeMock,
      },
      videoCapabilities: {
        invoke: videoCapabilitiesInvokeMock,
      },
      artifactTurnSteer: {
        invoke: artifactTurnSteerInvokeMock,
      },
      imageModelPreferenceRead: {
        invoke: imageModelPreferenceReadInvokeMock,
      },
      imageModelPreferenceSet: {
        invoke: imageModelPreferenceSetInvokeMock,
      },
      imageCapabilities: {
        invoke: imageCapabilitiesInvokeMock,
      },
      videoArtifactsList: {
        invoke: videoArtifactsListInvokeMock,
      },
      imageArtifactsList: {
        invoke: imageArtifactsListInvokeMock,
      },
      imageArtifactsChanged: { on: () => () => undefined },
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
    // AcpSendBox now reads the MAIN-process lane decision (useEveMaxAuthority →
    // useActiveSeatId), so the stub has to cover the seat-binding surface too.
    getCurrentSeatId: () => 'seat-1',
    onSeatRebind: () => () => undefined,
    subscribePersisted: vi.fn(() => vi.fn()),
  },
}));

// MAT-1747 round 5 — the PRODUCTION-ROUTE suite at the bottom of this file runs
// the REAL main-process handlers behind the bridge mock above, so that the
// renderer seam a correction actually travels is proven end to end instead of
// asserted against a spy.
//
// Two seams have to be stubbed for a main handler to run inside a renderer test,
// and neither is on the path under test: Main reads the CEVE licence wire from
// disk (there is no account here), and it resolves the seat data directory from
// Electron. The data path used by the assertions is INJECTED per call instead,
// so nothing in these tests depends on this stub returning anything real.
// Nothing under `packages/desktop/src/renderer` imports either module.
vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: () => ({ ok: true, wire: 'ceve-wire-token' }),
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/eve-data-unused' }));

vi.mock('@/renderer/components/chat/SendBox', () => ({
  default: (props: {
    onSend: (message: string) => Promise<void>;
    rightTools?: React.ReactNode;
    prefix?: React.ReactNode;
  }) => {
    sendBoxPropsMock.current = props as unknown as Record<string, unknown>;
    return (
      // The real SendBox renders this surface around the composer; the glow
      // state stamping (1.820.5) needs it present in the double too.
      <div className='sendbox-panel eve-panel eve-composer-surface' data-testid='composer-surface'>
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
      </div>
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
// The MAIN-process lane decision. AcpSendBox reads it to decide whether the
// composer may submit at all; it is an external boundary here, supplied rather
// than derived (the decision logic itself is covered in the hold suites).
vi.mock('@/renderer/hooks/agent/useEveMaxAuthority', () => ({
  useEveMaxAuthority: () => ({
    maxActive: maxAuthorityMock.maxActive,
    entitlementPending: maxAuthorityMock.entitlementPending,
    state: { status: 'ready' as const },
    refresh: vi.fn(),
  }),
}));
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
  // The artifact provider's history-refresh subscription (1.820.3 display
  // gap). Tests fire the handler via chatHistoryRefreshHandlerMock.current.
  addEventListener: vi.fn((event: string, handler: () => void) => {
    if (event === 'chat.history.refresh') chatHistoryRefreshHandlerMock.current = handler;
    return () => {
      if (event === 'chat.history.refresh') chatHistoryRefreshHandlerMock.current = null;
    };
  }),
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
    maxAuthorityMock.maxActive = false;
    maxAuthorityMock.entitlementPending = false;
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
    cloudVisualPolicySetInvokeMock.mockReset();
    listArtifactsInvokeMock.mockReset();
    listArtifactsInvokeMock.mockResolvedValue([]);
    videoArtifactsListInvokeMock.mockReset();
    videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [] });
    imageArtifactsListInvokeMock.mockReset();
    imageArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [] });
    chatHistoryRefreshHandlerMock.current = null;
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
    // MAT-1747: the default is an EMPTY envelope, which is what a conversation
    // with no artifacts produces. Every pre-existing assertion in this file
    // therefore keeps asserting the byte-identical message it always did.
    artifactContextEnvelopeInvokeMock.mockResolvedValue({ success: true, data: { envelope: '' } });
    // MAT-1753: the DEFAULT seat has neither capability, which is the fail-closed
    // production default (both env flags off). Every pre-existing assertion in
    // this file therefore keeps the tier options and prices it always had; the
    // entitled cases opt in explicitly.
    videoCapabilitiesInvokeMock.mockResolvedValue({
      success: true,
      data: { hd15Available: false, presetVoicesAvailable: false },
    });
    // MAT-1747: a steer retires the outstanding spend permit. Default is "there
    // was nothing to retire", which is what every seat with the default-off paid
    // path reports, so no pre-existing assertion in this file changes meaning.
    artifactTurnSteerInvokeMock.mockReset();
    artifactTurnSteerInvokeMock.mockResolvedValue({ success: true, data: { revoked: 0 } });
    // MAT-1769: the image model preference defaults to a resolved seat on the
    // product default tier ('quality'), and the registry defaults to UNPROVEN —
    // the fail-closed production reading before the gateway has answered, so no
    // pre-existing assertion in this file sees a price it did not opt into.
    imageModelPreferenceReadInvokeMock.mockResolvedValue({
      success: true,
      data: {
        status: 'resolved',
        tier: 'quality',
        source: 'product_default',
        seatId: 'seat-1',
        physicalKey: 'commandEve.imageModelPreference',
      },
    });
    imageModelPreferenceSetInvokeMock.mockResolvedValue({
      success: true,
      data: {
        ok: true,
        preference: {
          status: 'resolved',
          tier: 'quality',
          source: 'stored_explicit',
          seatId: 'seat-1',
          physicalKey: 'commandEve.imageModelPreference',
        },
      },
    });
    imageCapabilitiesInvokeMock.mockResolvedValue({
      success: false,
      msg: 'capabilities_unparseable',
      data: { ok: false, reason: 'capabilities_unparseable' },
    });
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

  it('MAT-1747: folds the artifact registry into the turn while the sent text stays byte-identical', async () => {
    // ACCEPTANCE 1 + 2 at the real call site. The registry rides the turn the
    // user was already sending — there is no second sendMessage, so no extra
    // inference turn — and the user's words survive verbatim once the prepared
    // context block is stripped, which is exactly what MessageText does when it
    // renders the message back to them.
    draftDataMock.current = { atPath: [], uploadFile: [], content: '' };
    artifactContextEnvelopeInvokeMock.mockResolvedValue({
      success: true,
      data: { envelope: '- artifact_id=video-aubergine kind=video editable=true edit_handle=evecap_' + 'a'.repeat(64) },
    });
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

    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    // The RAW user turn goes with the request, byte-identical to the text that
    // is displayed: Main hashes exactly these bytes into this send's single-use
    // spend permit. It does NOT prove a human pressed send — Main cannot observe
    // an active turn on the pinned AionCore — it proves the permit is bound to
    // the same bytes the user sees.
    expect(artifactContextEnvelopeInvokeMock).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userTurnText: 'Hello',
    });
    const sent = String(sendMessageInvokeMock.mock.calls[0][0].input);
    expect(sent).toContain('artifact_id=video-aubergine');
    expect(stripCommandEvePreparedContext(sent)).toBe('Hello');
    // Exactly ONE turn. A hidden announcement turn would show up here as a
    // second call, which is the whole reason this assertion exists.
    expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1);
  });

  it('MAT-1747: a REJECTED envelope lookup never costs the user their message', async () => {
    // THE ACP SEND LIFECYCLE, and the reason the envelope call has a try/catch of
    // its own rather than living under the enclosing one. The enclosing catch
    // turns a throw into a FAILED SEND — so without the inner catch, any hiccup
    // in a local artifact registry (an unwritable store, a busy disk, an IPC
    // blip) would stop the person's message from reaching the model at all.
    //
    // A registry that cannot be read is not a failed send. It is a send without
    // a registry, which is exactly what this app did before MAT-1747 existed.
    //
    // Nothing exercised this: every other test in this file resolves the mock.
    draftDataMock.current = { atPath: [], uploadFile: [], content: '' };
    artifactContextEnvelopeInvokeMock.mockRejectedValue(new Error('artifact store unreadable'));
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

    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(artifactContextEnvelopeInvokeMock).toHaveBeenCalledTimes(1);
    // The turn is byte-identical to what it would be with no artifacts at all —
    // no half-written block, no delimiter left open.
    const sent = String(sendMessageInvokeMock.mock.calls[0][0].input);
    expect(sent).toBe('Hello');
    expect(sent).not.toContain('COMMAND_EVE_PREPARED_CONTEXT');
  });

  it('MAT-1747: an UNSUCCESSFUL envelope response is treated as no envelope, not as a failure', async () => {
    // The other shape a bridge can answer with. `success: false` is a normal
    // outcome (Main declines to build one), and it must read as "nothing to
    // add", never as a reason to withhold the message.
    draftDataMock.current = { atPath: [], uploadFile: [], content: '' };
    artifactContextEnvelopeInvokeMock.mockResolvedValue({ success: false, msg: 'no store' });
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

    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(String(sendMessageInvokeMock.mock.calls[0][0].input)).toBe('Hello');
  });

  it('MAT-1747: a non-string envelope is ignored rather than stringified into the turn', async () => {
    // `typeof … === 'string'` is the guard. Without it an object would arrive in
    // the prompt as `[object Object]` — inside prepared-context delimiters, so
    // the user would never see it and the model would read it as context.
    draftDataMock.current = { atPath: [], uploadFile: [], content: '' };
    artifactContextEnvelopeInvokeMock.mockResolvedValue({ success: true, data: { envelope: { entries: [] } } });
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

    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    const sent = String(sendMessageInvokeMock.mock.calls[0][0].input);
    expect(sent).toBe('Hello');
    expect(sent).not.toContain('object Object');
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

  it('HOLDS submission while the MAX entitlement is unverified — and only then', async () => {
    // THE SUBMISSION HOLD, at the seam that carries it. `disabled` is what SendBox
    // gates BOTH the button and the Enter key on (see sendBoxHoldGate.dom), so
    // this asserts the composer actually hands the hold down rather than merely
    // knowing about it.
    //
    // The DEFAULT is the control: an EVE composer whose lane is decided must stay
    // sendable, otherwise "held" would be indistinguishable from "always off".
    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    expect(sendBoxPropsMock.current?.disabled).toBe(false);

    cleanup();
    sendBoxPropsMock.current = null;
    maxAuthorityMock.entitlementPending = true;
    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    expect(sendBoxPropsMock.current?.disabled).toBe(true);

    // ...and a NON-EVE conversation is never held by an EVE lane decision: it has
    // no MAX lane, so it has nothing to wait for.
    cleanup();
    sendBoxPropsMock.current = null;
    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='claude'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    expect(sendBoxPropsMock.current?.disabled).toBe(false);
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

  it('inspects locally before a denied receipt and raises the one-time Vision enablement prompt, never a dead-end toast', async () => {
    // INVERTED (MAT-1769): this case used to assert the disabled policy died in
    // a Message.error. The 1.820.2 contract asks ONCE, in chat, with "Vision
    // aktivieren" / "Nicht jetzt" — so the same setup must now render the card
    // and NO error toast, with everything else (local inspection first, no
    // upload, no provider, no send) unchanged.
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

    // The card is the answer — a labelled group, not a modal, with both actions.
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'conversation.visual.enablement.title' })).toBeTruthy()
    );
    expect(screen.getByRole('button', { name: 'conversation.visual.enablement.confirm' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'conversation.visual.enablement.decline' })).toBeTruthy();
    // NO dead-end error toast, and nothing left the device: no upload retry with
    // a receipt, no provider marker, no send.
    expect(messageErrorMock).not.toHaveBeenCalled();
    expect(presentationPrepareInvokeMock).not.toHaveBeenCalled();
    expect(imagePrepareInvokeMock).toHaveBeenCalledTimes(1);
    expect(imagePrepareInvokeMock.mock.calls[0]?.[0]).not.toHaveProperty('visualPolicyReceipt');
    expect(imagePrepareInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      cloudVisualPolicyReceiptInvokeMock.mock.invocationCallOrder[0]
    );
    expect(managedVisualTurnAuthorizeInvokeMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    expect(modalConfirmMock).not.toHaveBeenCalled();
    expect(cloudVisualPolicySetInvokeMock).not.toHaveBeenCalled();
    // The draft and files are preserved exactly as before.
    expect(setUploadFileMock).toHaveBeenCalledWith(['/tmp/screenshot.png']);
    expect(draftMutateMock).toHaveBeenCalled();
    expect(emitterEmitMock).toHaveBeenCalledWith('acp.selected.file', ['/tmp/context.png']);
  });

  it('MAT-1769: "Vision aktivieren" persists the policy through Main and re-drives the exact parked send', async () => {
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/screenshot.png'], content: 'Look at this' };
    sendBoxMessageMock.current = 'Look at this';
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
    cloudVisualPolicyReceiptInvokeMock.mockResolvedValueOnce({
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
    cloudVisualPolicySetInvokeMock.mockResolvedValue({ success: true, data: { ok: true } });
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
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'conversation.visual.enablement.title' })).toBeTruthy()
    );

    await act(async () => screen.getByRole('button', { name: 'conversation.visual.enablement.confirm' }).click());

    // The ONE-TIME decision goes through the Main-authoritative policy path…
    await waitFor(() =>
      expect(cloudVisualPolicySetInvokeMock).toHaveBeenCalledWith({ expectedSeatId: 'seat-1', enabled: true })
    );
    // …the card leaves…
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'conversation.visual.enablement.title' })).toBeNull()
    );
    // …and the identical send is re-driven: preparation runs again, the receipt
    // now issues, and the message actually goes out. No second question.
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(imagePrepareInvokeMock).toHaveBeenCalledTimes(2);
    expect(messageErrorMock).not.toHaveBeenCalled();
    expect(configSetMock).not.toHaveBeenCalledWith('commandEve.visionEnablementDeclined', true);
  });

  it('MAT-1769: "Nicht jetzt" persists the decline and nothing is uploaded, provided or debited', async () => {
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/screenshot.png'], content: 'Look at this' };
    sendBoxMessageMock.current = 'Look at this';
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
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'conversation.visual.enablement.title' })).toBeTruthy()
    );

    await act(async () => screen.getByRole('button', { name: 'conversation.visual.enablement.decline' }).click());

    // The decline is the one-time decision, persisted per seat…
    await waitFor(() => expect(configSetMock).toHaveBeenCalledWith('commandEve.visionEnablementDeclined', true));
    // …the card leaves…
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'conversation.visual.enablement.title' })).toBeNull()
    );
    // …and NOTHING happened: no policy change, no upload, no provider marker,
    // no send. The quiet notice says where to change it later.
    expect(cloudVisualPolicySetInvokeMock).not.toHaveBeenCalled();
    expect(imagePrepareInvokeMock).toHaveBeenCalledTimes(1);
    expect(managedVisualTurnAuthorizeInvokeMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    expect(messageErrorMock).not.toHaveBeenCalled();
    expect(messageWarningMock).toHaveBeenCalledTimes(1);
  });

  it('MAT-1769: a seat that already declined gets the quiet notice and is never asked again', async () => {
    configGetMock.mockImplementation((key: string) =>
      key === 'commandEve.visionEnablementDeclined'
        ? true
        : key === 'acp.config'
          ? { hermes: { preferredMode: 'default' } }
          : undefined
    );
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/screenshot.png'], content: 'Another image' };
    sendBoxMessageMock.current = 'Another image';
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

    await waitFor(() => expect(messageWarningMock).toHaveBeenCalledTimes(1));
    // NO card, no policy write, no send — the persisted decision is honoured.
    expect(screen.queryByRole('group', { name: 'conversation.visual.enablement.title' })).toBeNull();
    expect(cloudVisualPolicySetInvokeMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  it('MAT-1769: an unavailable policy gets the honest notice and no fake enablement toggle', async () => {
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/screenshot.png'], content: 'Look at this' };
    sendBoxMessageMock.current = 'Look at this';
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
          status: 'unavailable',
          reason: 'cloud_visual_unavailable',
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

    // Unavailable is not disabled: a toggle cannot fix it, so there is no card —
    // only the honest notice, and nothing is sent.
    await waitFor(() => expect(messageErrorMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('group', { name: 'conversation.visual.enablement.title' })).toBeNull();
    expect(cloudVisualPolicySetInvokeMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
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
    // `waitFor`, not a bare assertion: the duplicate is refused SYNCHRONOUSLY by
    // the promotion guard, so awaiting it says nothing about how far the first
    // one has got. Counting the sends after they have had a chance to happen is
    // the claim this test is actually making — that two rapid promotions produce
    // ONE correction — and it does not weaken with the number of awaits the
    // dispatch path happens to contain today.
    await waitFor(() => expect(steerInvokeMock).toHaveBeenCalledTimes(1));

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

  it('MAT-1747: retires the outstanding spend permit BEFORE the correction reaches the run', async () => {
    // THE round-2 hole, at the only call site that can close it. A steer never
    // builds a context envelope — it is an HTTP call straight to the runtime —
    // so the permit minted for the previous turn stayed live right across the
    // user saying something else. Nothing else in this app can notice a steer.
    //
    // The ORDER is the assertion that matters: retire first, then correct. The
    // other way round leaves a window in which the model has both the new
    // instruction and the old permit.
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

    expect(artifactTurnSteerInvokeMock).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      // The bytes that actually reach the run, so the recorded turn is the turn
      // the agent was given and not a prettier version of it.
      steerText: '/steer Correct the active run',
    });
    expect(steerInvokeMock).toHaveBeenCalledTimes(1);
    expect(artifactTurnSteerInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      steerInvokeMock.mock.invocationCallOrder[0]
    );
  });

  it('MAT-1747: a failed retire never blocks the correction itself', async () => {
    // HALF ONE of the round-4 split, at the renderer boundary. Retiring the
    // permit is a local file operation, and a user correcting a running model
    // must not be refused because it failed — so the rejection is caught here
    // and the correction still goes.
    //
    // What this does NOT mean any more is that the failure is free. Round 3 paid
    // for this with a permit that outlived the steer; round 4 pays for it in
    // main instead, where the handler retires the conversation's spend authority
    // on every path that could not prove the permit gone. That half is pinned by
    // `videoEditSpendDeny.test.ts` — a renderer test cannot see it, and saying
    // so here is the point.
    draftDataMock.current = { atPath: [], uploadFile: [], content: '/steer Correct the active run' };
    sendBoxMessageMock.current = '/steer Correct the active run';
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    runtimeViewMock.activeTurnId = 'turn-1';
    artifactTurnSteerInvokeMock.mockRejectedValue(new Error('permit store unavailable'));
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

    expect(steerInvokeMock).toHaveBeenCalledTimes(1);
    expect(messageErrorMock).not.toHaveBeenCalled();
    // Still awaited first even when it rejects, so main always gets its chance
    // to retire the conversation before the correction reaches the run.
    expect(artifactTurnSteerInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      steerInvokeMock.mock.invocationCallOrder[0]
    );
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

    // MAT-1753: the reason there is no 1080p option here is the ENTITLEMENT, not
    // the input mode. This seat has no grok-imagine-video-1.5 (the default mock),
    // and 1.5 is the only model that reaches 1080p. An earlier version of this
    // comment said 1.5 "cannot take a bare prompt", which was false — see the
    // test below, where the same bare prompt reaches 1080p on an entitled seat.
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

  it('MAT-1753: a bare TEXT prompt reaches 1080p once the seat has 1.5', async () => {
    videoCapabilitiesInvokeMock.mockResolvedValue({
      success: true,
      data: { hd15Available: true, presetVoicesAvailable: false },
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

    // The option renders for a TEXT draft with NO attachment at all — since
    // F8b as the 1080p entry of the resolution dropdown.
    await waitFor(() => expect(screen.getByTestId('video-resolution-dropdown-trigger')).toBeTruthy());
    await act(async () => {
      screen.getByTestId('video-resolution-dropdown-trigger').click();
    });
    await act(async () => {
      screen.getByTestId('video-resolution-option-1080p').click();
    });

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    const sent = videoGenerateInvokeMock.mock.calls[0][0];
    expect(sent).toMatchObject({ tierId: 'hd' });
    // No image travelled — the whole point of the correction.
    expect(sent.imagePath).toBeUndefined();
    expect(sent.referenceImagePaths).toBeUndefined();
  });

  it('1.820.4: sends the contextual video model and duration selected in the composer', async () => {
    videoCapabilitiesInvokeMock.mockResolvedValue({
      success: true,
      data: { hd15Available: true, presetVoicesAvailable: false },
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

    await waitFor(() => expect(screen.getByTestId('video-model-dropdown-trigger')).toBeTruthy());
    await act(async () => {
      screen.getByTestId('video-model-dropdown-trigger').click();
    });
    await act(async () => {
      screen.getByTestId('video-model-entry-x-ai/grok-imagine-video-1.5').click();
    });
    await waitFor(() =>
      expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-model', 'grok-imagine-video-1.5')
    );
    await act(async () => {
      screen.getByTestId('video-duration-dropdown-trigger').click();
    });
    await act(async () => {
      screen.getByTestId('video-duration-option-10').click();
    });
    await waitFor(() =>
      expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-duration-seconds', '10')
    );
    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    expect(videoGenerateInvokeMock.mock.calls[0][0]).toMatchObject({
      tierId: 'fast',
      modelId: 'grok-imagine-video-1.5',
      durationSeconds: 10,
    });
    expect(modalConfirmMock).not.toHaveBeenCalled();
  });

  it('1.820.5: stamps the MAX glow state on the composer surface from the runtime phase', async () => {
    // The composer glow follows maxActive (main authority) + runtimeActivity.phase
    // — the SAME truth the status footer reads. MAX on + thinking => denk-puls.
    maxAuthorityMock.maxActive = true;
    const messageState = {
      ...makeMessageState(),
      runtimeActivity: { phase: 'thinking', updatedAt: 0 } as UseAcpMessageReturn['runtimeActivity'],
    };
    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={messageState}
      />
    );
    await waitFor(() => expect(screen.getByTestId('composer-surface')).toHaveAttribute('data-eve-glow', 'denk-puls'));
  });

  it('1.820.5: no glow attribute with MAX off — the standard composer keeps its neutral look', async () => {
    maxAuthorityMock.maxActive = false;
    const messageState = {
      ...makeMessageState(),
      runtimeActivity: { phase: 'thinking', updatedAt: 0 } as UseAcpMessageReturn['runtimeActivity'],
    };
    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={messageState}
      />
    );
    await waitFor(() => expect(screen.getByTestId('composer-surface')).toBeTruthy());
    expect(screen.getByTestId('composer-surface').hasAttribute('data-eve-glow')).toBe(false);
  });

  it('LIVE REGRESSION (packaged 1.820.5): the pill still renders when the capabilities bridge rejects', async () => {
    // QA 2026-08-05: on the packaged build against the OLD deployed server
    // (v27, no /video-model-capabilities endpoint) the pill never appeared.
    // The capabilities answer must be irrelevant to the VISIBILITY gate: the
    // bundled snapshot stands in, and the pill renders on a create intent.
    videoCapabilitiesInvokeMock.mockRejectedValue(new Error('ipc bridge unavailable'));
    draftDataMock.current = {
      atPath: [],
      uploadFile: [],
      content: 'Erstelle ein Video: eine lila Aubergine dreht sich langsam.',
    };
    sendBoxMessageMock.current = 'Erstelle ein Video: eine lila Aubergine dreht sich langsam.';

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await waitFor(() => expect(screen.getByTestId('video-quality-pill')).toBeTruthy());
    expect(screen.getByTestId('video-model-dropdown-trigger')).toBeTruthy();
  });

  it('LIVE REGRESSION (packaged 1.820.5): the pill renders when the capabilities answer carries no catalog', async () => {
    // The old-server shape: Main proves the seat flags but no catalog fields —
    // the pill must fall back to the bundled snapshot and still render.
    videoCapabilitiesInvokeMock.mockResolvedValue({
      success: true,
      data: { hd15Available: true, presetVoicesAvailable: false },
    });
    draftDataMock.current = {
      atPath: [],
      uploadFile: [],
      content: 'Erstelle ein Video: eine lila Aubergine dreht sich langsam.',
    };
    sendBoxMessageMock.current = 'Erstelle ein Video: eine lila Aubergine dreht sich langsam.';

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await waitFor(() => expect(screen.getByTestId('video-quality-pill')).toBeTruthy());
    expect(screen.getByTestId('video-model-dropdown-trigger')).toBeTruthy();
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-model', 'grok-imagine-video-1.5');
  });

  it('MAT-1753: several attached images become ONE reference request, with no second picker', async () => {
    videoCapabilitiesInvokeMock.mockResolvedValue({
      success: true,
      data: { hd15Available: true, presetVoicesAvailable: false },
    });
    draftDataMock.current = {
      atPath: [],
      uploadFile: ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'],
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

    // The reference images are the files ALREADY on the draft: no second picker
    // renders, and none is needed.
    await waitFor(() => expect(screen.getByTestId('video-quality-pill')).toBeTruthy());
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-mode', 'reference');
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-model', 'grok-imagine-video-1.5');
    // 1080p is not offered in reference mode — it clamps to 720p.
    expect(screen.queryByTestId('video-quality-option-hd')).toBeNull();
    // The PRICE follows the model: `data-model` above is the 1.5 the plan chose,
    // so the estimate rendered here is 1.5's 720p rate. (The number itself is
    // asserted in VideoQualityPill.dom.test.tsx — this file's i18n double does not
    // interpolate, so asserting the digits here would assert the double.)

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    const sent = videoGenerateInvokeMock.mock.calls[0][0];
    expect(sent.referenceImagePaths).toEqual(['/tmp/a.png', '/tmp/b.png', '/tmp/c.png']);
    // EXCLUSIVE: a reference send carries no image->video source.
    expect(sent.imagePath).toBeUndefined();
    // No preset voices for an unentitled seat, so the field never appears.
    expect(sent.presetVoiceIds).toBeUndefined();
  });
  it('1.820.3: the image model picker shows for an image intent and persists clicks through Main', async () => {
    // CONTEXTUAL since 1.820.3: the control follows intent, not the bare EVE
    // conversation. An explicit image draft reveals it…
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'Erstelle ein Bild: eine lila Aubergine als Icon.' };
    // Main stores what it is asked and answers with the value it re-proved.
    imageModelPreferenceSetInvokeMock.mockImplementation(async (request: { tier: string }) => ({
      success: true,
      data: {
        ok: true,
        preference: {
          status: 'resolved',
          tier: request.tier,
          source: 'stored_explicit',
          seatId: 'seat-1',
          physicalKey: 'commandEve.imageModelPreference',
        },
      },
    }));

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await waitFor(() => expect(screen.getByTestId('image-model-pill')).toBeTruthy());
    expect(screen.getByTestId('image-model-pill')).toHaveAttribute('data-selected-tier', 'quality');
    // The capabilities default in this file is UNPROVEN — no price may appear.
    expect(screen.getByTestId('image-model-pill-estimate')).toHaveAttribute('data-quote-state', 'unavailable');

    await act(async () => {
      screen.getByTestId('image-model-option-max').click();
    });

    await waitFor(() => expect(imageModelPreferenceSetInvokeMock).toHaveBeenCalledTimes(1));
    expect(imageModelPreferenceSetInvokeMock).toHaveBeenCalledWith({ expectedSeatId: 'seat-1', tier: 'max' });
    // The checked radio adopts what Main actually stored.
    await waitFor(() => expect(screen.getByTestId('image-model-pill')).toHaveAttribute('data-selected-tier', 'max'));
  });

  it('MAT-1769: a failed preference write rolls the pill back to what Main will actually bill', async () => {
    // Grok review MAJOR 1: an optimistic tier that never landed must not keep
    // quoting one model while Main bills another. The write rejects; the pill
    // must re-read Main and adopt the stored value.
    imageModelPreferenceSetInvokeMock.mockRejectedValue(new Error('ipc down'));
    imageModelPreferenceReadInvokeMock.mockResolvedValue({
      success: true,
      data: { status: 'resolved', tier: 'quality', source: 'stored_default', seatId: 'seat-1' },
    });
    // 1.820.3: the rollback case only matters when the pill is VISIBLE, so
    // the draft carries an explicit image intent.
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'Erstelle ein Bild: eine lila Aubergine als Icon.' };

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await waitFor(() => expect(screen.getByTestId('image-model-pill')).toBeTruthy());

    await act(async () => {
      screen.getByTestId('image-model-option-max').click();
    });

    // The write was attempted… and the rollback read followed it.
    await waitFor(() => expect(imageModelPreferenceSetInvokeMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(imageModelPreferenceReadInvokeMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    // The pill shows Main's value again, not the optimistic click.
    await waitFor(() =>
      expect(screen.getByTestId('image-model-pill')).toHaveAttribute('data-selected-tier', 'quality')
    );
  });

  // ---------------------------------------------------------------------
  // 1.820.3 — contextual media controls (Founder contract + CoS boundaries)
  // ---------------------------------------------------------------------

  const VIDEO_SOURCE_ARTIFACT = {
    id: 'video-artifact-1',
    conversation_id: 'conv-1',
    kind: 'video' as const,
    status: 'active' as const,
    created_at: 1000,
    updated_at: 1000,
    payload: {
      artifact_type: 'video' as const,
      title: 'Video 720p',
      description: '720p · 5s · ca. 700 Credits · grok-imagine-video',
      path: '/tmp/Downloads/video-artifact-1.mp4',
      mime_type: 'video/mp4',
      hash: 'e'.repeat(64),
      size: 598145,
      duration_seconds: 5,
      origin_capability: 'video_generation',
      tier_id: 'fast',
    },
  };

  const renderWithVideoArtifact = () => {
    videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [VIDEO_SOURCE_ARTIFACT] });
    return render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <AcpSendBox
          conversation_id='conv-1'
          backend='hermes'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      </ConversationArtifactProvider>
    );
  };

  it('1.820.3: a plain draft shows ZERO media controls, even in an EVE conversation', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: '' };

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).toBeTruthy());
    expect(screen.queryByTestId('image-model-pill')).toBeNull();
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();
    expect(screen.queryByTestId('video-edit-hint')).toBeNull();
  });

  it('1.820.3: an image draft shows ONLY the image controls', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'Erstelle ein Bild: eine lila Aubergine als Icon.' };

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await waitFor(() => expect(screen.getByTestId('image-model-pill')).toBeTruthy());
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();
    expect(screen.queryByTestId('video-edit-hint')).toBeNull();
  });

  it('1.820.3: a video draft shows ONLY the video creation controls', async () => {
    draftDataMock.current = {
      atPath: [],
      uploadFile: [],
      content: 'Erstelle ein kurzes Video (480p): eine Aubergine dreht sich.',
    };

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await waitFor(() => expect(screen.getByTestId('video-quality-pill')).toBeTruthy());
    expect(screen.queryByTestId('image-model-pill')).toBeNull();
    expect(screen.queryByTestId('video-edit-hint')).toBeNull();
  });

  it('1.820.3: removing or changing the intent hides the stale controls, with no layout ghost', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'Erstelle ein Bild: eine Aubergine.' };
    const { rerender } = render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await waitFor(() => expect(screen.getByTestId('image-model-pill')).toBeTruthy());

    // image → plain: everything hides.
    draftDataMock.current = { atPath: [], uploadFile: [], content: '' };
    rerender(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await waitFor(() => expect(screen.queryByTestId('image-model-pill')).toBeNull());
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();

    // plain → video: the video creation controls appear.
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'Erstelle ein kurzes Video: Aubergine.' };
    rerender(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await waitFor(() => expect(screen.getByTestId('video-quality-pill')).toBeTruthy());
    expect(screen.queryByTestId('image-model-pill')).toBeNull();

    // video → plain: clean again.
    draftDataMock.current = { atPath: [], uploadFile: [], content: '' };
    rerender(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await waitFor(() => expect(screen.queryByTestId('video-quality-pill')).toBeNull());
  });

  it('1.820.3: the canonical follow-up shows the edit-hint, no creation selector, and the send stays a normal Hermes turn', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'Gib der Aubergine im Video ein Gesicht.' };
    sendBoxMessageMock.current = 'Gib der Aubergine im Video ein Gesicht.';
    sendMessageInvokeMock.mockResolvedValue({});

    renderWithVideoArtifact();

    // The compact affordance with the honest edit price — and NO creation
    // settings the edit tool cannot honour (no quality/resolution selector).
    await waitFor(() => expect(screen.getByTestId('video-edit-hint')).toBeTruthy());
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();
    expect(screen.queryByTestId('video-quality-option-hd')).toBeNull();
    expect(screen.queryByTestId('image-model-pill')).toBeNull();

    await act(async () => screen.getByRole('button', { name: 'send' }).click());

    // Execution boundary: a NORMAL Hermes dispatch — never the direct
    // generation branch — and no selectedArtifactIds inferred from "latest".
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(videoGenerateInvokeMock).not.toHaveBeenCalled();
    await waitFor(() => expect(artifactContextEnvelopeInvokeMock).toHaveBeenCalled());
    for (const call of artifactContextEnvelopeInvokeMock.mock.calls) {
      expect(call[0]).not.toHaveProperty('selectedArtifactIds');
    }
  });

  it('1.820.3: a dismissed artifact cannot activate the edit-hint', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'Gib der Aubergine im Video ein Gesicht.' };
    videoArtifactsListInvokeMock.mockResolvedValue({
      success: true,
      data: [{ ...VIDEO_SOURCE_ARTIFACT, status: 'dismissed' as const }],
    });

    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <AcpSendBox
          conversation_id='conv-1'
          backend='hermes'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      </ConversationArtifactProvider>
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).toBeTruthy());
    expect(screen.queryByTestId('video-edit-hint')).toBeNull();
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();
    expect(screen.queryByTestId('image-model-pill')).toBeNull();
  });

  it('1.820.3: revealing controls never calls a provider, upload, receipt or paid lane', async () => {
    draftDataMock.current = {
      atPath: [],
      uploadFile: [],
      content: 'Erstelle ein Bild: eine Aubergine.',
    };
    const { rerender } = render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await waitFor(() => expect(screen.getByTestId('image-model-pill')).toBeTruthy());

    draftDataMock.current = { atPath: [], uploadFile: [], content: 'Erstelle ein kurzes Video: Aubergine.' };
    rerender(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await waitFor(() => expect(screen.getByTestId('video-quality-pill')).toBeTruthy());

    expect(videoGenerateInvokeMock).not.toHaveBeenCalled();
    expect(imagePrepareInvokeMock).not.toHaveBeenCalled();
    expect(cloudVisualPolicyReceiptInvokeMock).not.toHaveBeenCalled();
    expect(managedVisualTurnAuthorizeInvokeMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it.each(['Gib mir ein Video von einer Aubergine.', 'Give me a video of an eggplant.'])(
    '1.820.3 ROUTING PARITY: the unambiguous request idiom "%s" shows video controls AND reaches exactly one direct video job',
    async (message) => {
      // The visible selection/quote and the send path use the SAME shared
      // predicate — a control that shows must be a job that runs, exactly once.
      draftDataMock.current = { atPath: [], uploadFile: [], content: message };
      sendBoxMessageMock.current = message;

      render(
        <AcpSendBox
          conversation_id='conv-1'
          backend='hermes'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      );
      await waitFor(() => expect(screen.getByTestId('video-quality-pill')).toBeTruthy());

      await act(async () => screen.getByRole('button', { name: 'send' }).click());

      await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
      // Exactly the single direct job — no second path through a normal turn.
      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    }
  );

  it('1.820.3: "Add a video to the page" stays quiet — no controls, no direct job', async () => {
    // 'add' is neither a strong creation verb nor edit semantics: no media
    // controls, and the send is a plain Hermes turn with no paid job.
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'Add a video of the product to the page.' };
    sendBoxMessageMock.current = 'Add a video of the product to the page.';
    sendMessageInvokeMock.mockResolvedValue({});

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).toBeTruthy());
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();

    await act(async () => screen.getByRole('button', { name: 'send' }).click());
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(videoGenerateInvokeMock).not.toHaveBeenCalled();
  });

  it('1.820.3: an explicit video creation keeps the existing direct videoGenerate path (unchanged boundary)', async () => {
    // The other half of the boundary: create+video MAY use the direct lane.
    // This pins that the contextual gate did not disturb the shipped path.
    draftDataMock.current = {
      atPath: [],
      uploadFile: [],
      content: 'Erstelle ein kurzes Video (480p, 5 Sekunden): eine lila Aubergine, die sich dreht.',
    };
    sendBoxMessageMock.current = 'Erstelle ein kurzes Video (480p, 5 Sekunden): eine lila Aubergine, die sich dreht.';

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await waitFor(() => expect(screen.getByTestId('video-quality-pill')).toBeTruthy());
    await act(async () => screen.getByRole('button', { name: 'send' }).click());
    await waitFor(() => expect(videoGenerateInvokeMock).toHaveBeenCalledTimes(1));
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it.each(['Schneide das Video.', 'Mach das Video heller.', 'Animate this video.'])(
    '1.820.3 EDIT VETO: "%s" never direct-generates — edit-hint shown, exactly one normal Hermes dispatch',
    async (message) => {
      draftDataMock.current = { atPath: [], uploadFile: [], content: message };
      sendBoxMessageMock.current = message;
      sendMessageInvokeMock.mockResolvedValue({});

      renderWithVideoArtifact();

      // The shared veto drives BOTH surfaces: the compact edit affordance is
      // visible (explicit medium noun + edit semantics over an eligible
      // source), the creation pill is NOT…
      await waitFor(() => expect(screen.getByTestId('video-edit-hint')).toBeTruthy());
      expect(screen.queryByTestId('video-quality-pill')).toBeNull();

      await act(async () => screen.getByRole('button', { name: 'send' }).click());

      // …and the send NEVER reaches the direct paid generation branch, even
      // though these texts also satisfy the creation regex. Exactly one
      // normal Hermes dispatch; no selectedArtifactIds inferred.
      await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
      expect(videoGenerateInvokeMock).not.toHaveBeenCalled();
      for (const call of artifactContextEnvelopeInvokeMock.mock.calls) {
        expect(call[0]).not.toHaveProperty('selectedArtifactIds');
      }
    }
  );

  it('1.820.3: umlaut edit intents bind correctly — Ändere das Video => video edit-hint, Ändere das Bild => image affordance', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'Ändere das Video.' };
    sendBoxMessageMock.current = 'Ändere das Video.';
    sendMessageInvokeMock.mockResolvedValue({});

    renderWithVideoArtifact();
    await waitFor(() => expect(screen.getByTestId('video-edit-hint')).toBeTruthy());
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();
    expect(screen.queryByTestId('image-model-pill')).toBeNull();
  });

  it('1.820.3: an ambiguous follow-up without a medium noun shows NO hint, but the Hermes turn still goes out', async () => {
    // Precision over recall: "Gib der Aubergine ein Gesicht" (no medium noun)
    // is ordinary text for the UI gate — Hermes still receives the full
    // conversation + artifact envelope and can perform the edit.
    draftDataMock.current = { atPath: [], uploadFile: [], content: 'Gib der Aubergine ein Gesicht.' };
    sendBoxMessageMock.current = 'Gib der Aubergine ein Gesicht.';
    sendMessageInvokeMock.mockResolvedValue({});

    renderWithVideoArtifact();
    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).toBeTruthy());
    expect(screen.queryByTestId('video-edit-hint')).toBeNull();
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();
    expect(screen.queryByTestId('image-model-pill')).toBeNull();

    await act(async () => screen.getByRole('button', { name: 'send' }).click());
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    expect(videoGenerateInvokeMock).not.toHaveBeenCalled();
  });

  it('1.820.3: the image-edit affordance shows ONLY the reference-capable tier with its edit quote, never the full selector', async () => {
    imageCapabilitiesInvokeMock.mockResolvedValue({
      success: true,
      data: {
        ok: true,
        registry: {
          version: 'command-eve-image-model-registry/v1',
          enabled: true,
          default_tier: 'quality',
          tiers: [
            {
              id: 'fast',
              slug: 'x-ai/grok-imagine-image-quality',
              display_name: 'Schnell',
              premium: false,
              supports_references: false,
              resolutions: ['1K', '2K'],
              quotes: {
                generate_credits: { '1K': 460, '2K': 644 },
                edit_credits: { '1K': 460, '2K': 644 },
                per_input_reference_credits: 0,
              },
            },
            {
              id: 'quality',
              slug: 'google/gemini-3.1-flash-image',
              display_name: 'Nano Banana 2',
              premium: false,
              supports_references: true,
              resolutions: ['1K', '2K'],
              quotes: {
                generate_credits: { '1K': 1380, '2K': 1380 },
                edit_credits: { '1K': 1380, '2K': 1380 },
                per_input_reference_credits: 0,
              },
            },
            {
              id: 'max',
              slug: 'openai/gpt-image-2',
              display_name: 'GPT Image 2',
              premium: true,
              supports_references: false,
              resolutions: ['1K', '2K'],
              quotes: {
                generate_credits: { '1K': 2300, '2K': 2300 },
                edit_credits: { '1K': 2300, '2K': 2300 },
                per_input_reference_credits: 0,
              },
            },
          ],
        },
      },
    });
    draftDataMock.current = {
      atPath: [],
      uploadFile: [],
      content: 'Bearbeite das Bild und gib der Aubergine ein Gesicht.',
    };
    videoArtifactsListInvokeMock.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'image-artifact-1',
          conversation_id: 'conv-1',
          kind: 'image' as const,
          status: 'active' as const,
          created_at: 900,
          updated_at: 900,
          payload: {
            artifact_type: 'image' as const,
            title: 'Bild',
            path: '/tmp/img-1.jpg',
            mime_type: 'image/jpeg',
          },
        },
        VIDEO_SOURCE_ARTIFACT, // newer, but IRRELEVANT: the explicit image edit binds to the image
      ].map((artifact, index) => ({ ...artifact, created_at: 900 + index, updated_at: 900 + index })),
    });

    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <AcpSendBox
          conversation_id='conv-1'
          backend='hermes'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      </ConversationArtifactProvider>
    );

    await waitFor(() => expect(screen.getByTestId('image-edit-hint')).toBeTruthy());
    // The full three-tier selector is NOT offered for an edit…
    expect(screen.queryByTestId('image-model-pill')).toBeNull();
    // …the affordance names the reference-capable tier and a quote LINE.
    const hint = screen.getByTestId('image-edit-hint');
    const hintText = hint.textContent ?? '';
    expect(hintText).toContain('Nano Banana 2');
    expect(hintText).toContain('Credits (1K)');
    expect(hintText).not.toContain('GPT Image 2');
    expect(hintText).not.toContain('Schnell');
    // …and the newer video does NOT produce a video affordance either.
    expect(screen.queryByTestId('video-edit-hint')).toBeNull();
  });

  it('1.820.3 price truth: the hint carries edit_credits (never generate_credits) from the effective reference-capable tier', async () => {
    // DELIBERATELY DIVERGENT fixture: generate and edit figures differ on
    // every tier, so a mode mix-up cannot hide. `quality` is the only
    // reference-capable tier; its EDIT figure is 980, not 1380.
    imageCapabilitiesInvokeMock.mockResolvedValue({
      success: true,
      data: {
        ok: true,
        registry: {
          version: 'command-eve-image-model-registry/v1',
          enabled: true,
          default_tier: 'quality',
          tiers: [
            {
              id: 'fast',
              slug: 'x-ai/grok-imagine-image-quality',
              display_name: 'Schnell',
              premium: false,
              supports_references: false,
              resolutions: ['1K', '2K'],
              quotes: {
                generate_credits: { '1K': 460, '2K': 644 },
                edit_credits: { '1K': 400, '2K': 560 },
                per_input_reference_credits: 0,
              },
            },
            {
              id: 'quality',
              slug: 'google/gemini-3.1-flash-image',
              display_name: 'Nano Banana 2',
              premium: false,
              supports_references: true,
              resolutions: ['1K', '2K'],
              quotes: {
                generate_credits: { '1K': 1380, '2K': 1380 },
                edit_credits: { '1K': 980, '2K': 980 },
                per_input_reference_credits: 0,
              },
            },
            {
              id: 'max',
              slug: 'openai/gpt-image-2',
              display_name: 'GPT Image 2',
              premium: true,
              supports_references: false,
              resolutions: ['1K', '2K'],
              quotes: {
                generate_credits: { '1K': 2300, '2K': 2300 },
                edit_credits: { '1K': 1900, '2K': 1900 },
                per_input_reference_credits: 0,
              },
            },
          ],
        },
      },
    });
    draftDataMock.current = {
      atPath: [],
      uploadFile: [],
      content: 'Bearbeite das Bild und gib der Aubergine ein Gesicht.',
    };
    videoArtifactsListInvokeMock.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'image-artifact-1',
          conversation_id: 'conv-1',
          kind: 'image' as const,
          status: 'active' as const,
          created_at: 900,
          updated_at: 900,
          payload: {
            artifact_type: 'image' as const,
            title: 'Bild',
            path: '/tmp/img-1.jpg',
            mime_type: 'image/jpeg',
          },
        },
      ],
    });

    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <AcpSendBox
          conversation_id='conv-1'
          backend='hermes'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      </ConversationArtifactProvider>
    );

    await waitFor(() => expect(screen.getByTestId('image-edit-hint')).toBeTruthy());
    const hint = screen.getByTestId('image-edit-hint');
    // The effective tier is the reference-capable one…
    expect(hint).toHaveAttribute('data-effective-tier', 'quality');
    // …and the quote on it is the EDIT figure (980), never the generate
    // figure (1380) — the exact blocker this surface exists to pin.
    expect(hint).toHaveAttribute('data-edit-credits-1k', '980');
    expect(hint).toHaveAttribute('data-edit-credits-2k', '980');
    expect(hint.getAttribute('data-edit-credits-1k')).not.toBe('1380');
  });

  it('MAT-1769: Vision accept is single-flight — a double-click buys one enablement and one re-drive', async () => {
    // Grok review MAJOR 2: the busy guard must hold synchronously, before the
    // first re-render, or two clicks run the policy write and the paid
    // re-drive twice.
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/screenshot.png'], content: 'Look at this' };
    sendBoxMessageMock.current = 'Look at this';
    const policySet = createDeferred<unknown>();
    cloudVisualPolicySetInvokeMock.mockReturnValue(policySet.promise);
    // Implementations survive vi.clearAllMocks() (clear ≠ reset): name the
    // happy-path send explicitly instead of inheriting whichever mock an
    // earlier test left behind.
    sendMessageInvokeMock.mockResolvedValue({});
    // After the enablement lands the world looks different: the receipt issues
    // and preparation succeeds. The disabled answers are ONCE-only, so the
    // re-driven send meets the enabled seat (the beforeEach defaults).
    cloudVisualPolicyReceiptInvokeMock.mockResolvedValueOnce({
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
    imagePrepareInvokeMock.mockReset();
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
      .mockResolvedValue({
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

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );
    await act(async () => screen.getByRole('button', { name: 'send' }).click());
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'conversation.visual.enablement.title' })).toBeTruthy()
    );

    // Two clicks, same synchronous window — the second must be refused by the
    // ref guard, not by the rendered disabled state (which lags a render).
    await act(async () => {
      screen.getByRole('button', { name: 'conversation.visual.enablement.confirm' }).click();
      screen.getByRole('button', { name: 'conversation.visual.enablement.confirm' }).click();
    });
    expect(cloudVisualPolicySetInvokeMock).toHaveBeenCalledTimes(1);

    // Let the single flight finish: the parked send re-drives exactly once.
    await act(async () => {
      policySet.resolve({ success: true, data: { ok: true } });
    });
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'conversation.visual.enablement.title' })).toBeNull()
    );
    expect(cloudVisualPolicySetInvokeMock).toHaveBeenCalledTimes(1);
  });

  it('MAT-1769: a decline that fails to persist says so honestly instead of claiming never-again', async () => {
    // Grok review MAJOR 3: the one-time claim needs the write to have landed.
    // A rejected persist keeps everything free (no upload, no provider, no
    // send) but tells the user the question will come back.
    configSetMock.mockRejectedValue(new Error('store full'));
    draftDataMock.current = { atPath: [], uploadFile: ['/tmp/screenshot.png'], content: 'Look at this' };
    sendBoxMessageMock.current = 'Look at this';
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
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'conversation.visual.enablement.title' })).toBeTruthy()
    );

    await act(async () => screen.getByRole('button', { name: 'conversation.visual.enablement.decline' }).click());

    await waitFor(() => expect(messageWarningMock).toHaveBeenCalledTimes(1));
    expect(messageWarningMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('decision could not be saved'),
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'conversation.visual.enablement.title' })).toBeNull()
    );
    expect(cloudVisualPolicySetInvokeMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  it('MAT-1769: no image model picker outside a managed EVE conversation', async () => {
    draftDataMock.current = { atPath: [], uploadFile: [], content: '' };

    render(
      <AcpSendBox
        conversation_id='conv-1'
        backend='claude'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).toBeTruthy());
    expect(screen.queryByTestId('image-model-pill')).toBeNull();
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

/**
 * MAT-1747 round 5 — THE PRODUCTION ROUTE OF A CORRECTION, END TO END.
 *
 * WHY THIS SUITE EXISTS. An earlier round recorded a substrate gap that read, in
 * effect, "`artifactTurnSteer` is a Main bridge provider while
 * `acpConversation.steer` is an httpPost straight from the renderer to the
 * backend" — and the honest reading of that sentence is a question nobody had
 * answered: does the retirement run in production at all, or is it security
 * logic on a path a real correction never takes? Dead logic that is counted as
 * coverage is worse than no logic.
 *
 * THE ANSWER, established by reading the real call sites and pinned here:
 *
 *   BOTH legs are production, and they are two different transports.
 *
 *   leg 1  AcpSendBox `dispatchSteer` -> `ipcBridge.commandEve.artifactTurnSteer`
 *          -> `@office-ai/platform` bridge -> `electronAPI.emit`
 *          (`preload/main.ts`) -> `ipcRenderer.invoke('office-ai-bridge-adapter')`
 *          -> `ipcMain.handle` (`common/adapter/main.ts:127`) -> the provider
 *          registered at `process/bridge/commandEveBridge.ts:2155` ->
 *          `handleCommandEveArtifactTurnSteerBridge`. MAIN observes the
 *          correction.
 *
 *   leg 2  the same `dispatchSteer` -> `ipcBridge.acpConversation.steer` ->
 *          `httpPost` -> `http://127.0.0.1:<port>/api/conversations/<id>/steer`
 *          -> the aioncore BINARY (`process/backend/binaryResolver.ts`). A
 *          separate process; Main never sees this one.
 *
 * So the tests below drive the renderer seam a user's correction really goes
 * through — the send box, with the same busy-mode promotion a real user gets —
 * and put the REAL Main handler behind the bridge mock, which is exactly what
 * the IPC transport does. Nothing is hand-called.
 *
 * The assertions are on the fetch spy and the debit spy DIRECTLY. A refusal that
 * had already called the provider would satisfy `ok === false` and still cost
 * money.
 *
 * SABOTAGE-CHECKED: deleting the `artifactTurnSteer.invoke` call from
 * `dispatchSteer` turns the first test red. The wiring is load-bearing, not
 * decorative.
 */
describe('MAT-1747 round 5 — the production route of a correction, renderer seam to Main', () => {
  type StoreModule = typeof import('@/process/commandEve/videoEditSpendPermitStore');
  type BridgeModule = typeof import('@/process/bridge/commandEveVideoBridge');
  type HandleStoreModule = typeof import('@/process/commandEve/artifactCapabilityHandleStore');
  type ArtifactStoreModule = typeof import('@/process/commandEve/videoArtifactStore');

  const SOURCE_BYTES = Buffer.from('the founders five second aubergine clip');
  const SOURCE_SHA = crypto.createHash('sha256').update(SOURCE_BYTES).digest('hex');
  const editedBody = {
    ok: true,
    artifact: { mime_type: 'video/mp4', data_base64: 'QUJD', bytes: 3, sha256: 'e'.repeat(64) },
    video_edit: {
      model: 'grok-imagine-video',
      tier: 'sd',
      source_duration_seconds: 5,
      source_sha256: SOURCE_SHA,
      prompt_sha256: 'd'.repeat(64),
      estimated_credits: 1000,
    },
  };

  let dataRoot: string;
  let videoRoot: string;
  let store: StoreModule;
  let bridge: BridgeModule;
  let handleStore: HandleStoreModule;
  let artifactStore: ArtifactStoreModule;

  /** Everything main-side is loaded here so the rest of this file's graph is untouched. */
  async function bootMain() {
    store = await import('@/process/commandEve/videoEditSpendPermitStore');
    bridge = await import('@/process/bridge/commandEveVideoBridge');
    handleStore = await import('@/process/commandEve/artifactCapabilityHandleStore');
    artifactStore = await import('@/process/commandEve/videoArtifactStore');
  }

  async function seedSource(conversationId: string, id: string) {
    const { buildVideoConversationArtifact } = await import('@/common/config/videoGenerationRequestCore');
    const clipPath = path.join(videoRoot, `${id}.mp4`);
    fs.writeFileSync(clipPath, SOURCE_BYTES);
    const artifact = buildVideoConversationArtifact({
      id,
      conversationId,
      createdAtMs: 1_754_000_000_000,
      path: clipPath,
      artifact: {
        mimeType: 'video/mp4',
        sha256: SOURCE_SHA,
        bytes: SOURCE_BYTES.byteLength,
        durationSeconds: 5,
        resolution: '480p',
        estimatedCredits: 500,
        model: 'grok-imagine-video',
        dataBase64: '',
        tierId: 'sd',
      } as never,
    });
    artifactStore.saveVideoArtifactRecord(dataRoot, artifact);
    return artifact;
  }

  /** The ordinary send that mints the permit, through the real envelope handler. */
  async function armConversation(conversationId: string, turn: string) {
    const source = await seedSource(conversationId, `video-${conversationId}`);
    const handle = handleStore.ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const { envelope } = await bridge.handleCommandEveArtifactContextEnvelope(
      { conversationId, requestedEditOperation: 'video_edit', userTurnText: turn },
      {
        getDataPath: () => dataRoot,
        buildEntries: handleStore.buildConversationArtifactEnvelopeEntries,
        isVideoEditEnabled: () => true,
      }
    );
    const permit = /evespend_[0-9a-f]{64}/.exec(envelope)?.[0];
    expect(permit).toBeTruthy();
    return { handle, permit: permit! };
  }

  /** One edit attempt with the two spies the requirement names. */
  async function attemptEdit(input: { handle: string; permit: string; instruction: string }) {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(editedBody), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    // Wraps the REAL atomic consume rather than replacing it, so a green result
    // still went through the same one-shot claim production uses.
    const debitSpy = vi.fn((...args: Parameters<StoreModule['consumeVideoEditSpendPermit']>) =>
      store.consumeVideoEditSpendPermit(...args)
    );
    const result = await bridge.handleCommandEveVideoEdit(
      { handle: input.handle, permit: input.permit, instruction: input.instruction },
      {
        getDataPath: () => dataRoot,
        fetch: fetchSpy as unknown as typeof fetch,
        newRequestId: () => 'req-fixed',
        newArtifactId: () => 'video-edited',
        getActiveSeatId: () => 'seat-1',
        areFileSelectionPathsGranted: () => true,
        readImageSource: () => ({ bytes: new Uint8Array([1, 2, 3, 4]) }),
        saveVideoFile: (saveInput) => {
          const savedPath = path.join(videoRoot, `${saveInput.artifactId}.mp4`);
          fs.writeFileSync(savedPath, Buffer.from(saveInput.dataBase64, 'base64'));
          return savedPath;
        },
        saveArtifactRecord: artifactStore.saveVideoArtifactRecord,
        isVideoEditEnabled: () => true,
        consumeSpendPermit: debitSpy,
      }
    );
    return { result, fetchSpy, debitSpy };
  }

  /** Type the correction into the send box and press send, exactly as a user does. */
  async function sendCorrectionThroughTheSendBox(conversationId: string, correction: string) {
    draftDataMock.current = { atPath: [], uploadFile: [], content: correction };
    sendBoxMessageMock.current = correction;
    // The busy state is what promotes a plain message into a correction.
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    runtimeViewMock.activeTurnId = 'turn-1';

    render(
      <AcpSendBox
        conversation_id={conversationId}
        backend='hermes'
        workspacePath='/tmp/workspace'
        messageState={makeMessageState()}
      />
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-route-'));
    videoRoot = path.join(dataRoot, 'videos');
    fs.mkdirSync(videoRoot, { recursive: true });

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
    buildDisplayMessageMock.mockImplementation((input: string) => input);
    artifactContextEnvelopeInvokeMock.mockResolvedValue({ success: true, data: { envelope: '' } });
    steerInvokeMock.mockReset();
    steerInvokeMock.mockResolvedValue({ msg_id: 'correction-1', turn_id: 'turn-1', accepted: true, runtime: null });

    await bootMain();

    // THE WIRING UNDER TEST. This is what the Electron IPC transport does: it
    // carries the renderer's `invoke` payload to the provider main registered at
    // `commandEveBridge.ts:2155`. Only the serialization hop is stood in for;
    // the handler, the store and the disk are the real ones.
    artifactTurnSteerInvokeMock.mockReset();
    artifactTurnSteerInvokeMock.mockImplementation((request: { conversationId: string; steerText?: string }) =>
      bridge.handleCommandEveArtifactTurnSteerBridge(request, { getDataPath: () => dataRoot })
    );
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  // The `/steer ` prefix is what promotes a message typed during a run into a
  // correction, and the bytes that reach the runtime keep it — so these are the
  // bytes Main is given too.
  const MINTING_TURN = '/steer gib der Aubergine ein Gesicht';

  it('a correction typed in the send box leaves the old permit with ZERO provider fetch and ZERO debit', async () => {
    const armed = await armConversation('conv-1', MINTING_TURN);

    // The correction is BYTE-IDENTICAL to the minting turn on purpose: the
    // turn-pointer defence must not be able to mask the result, so the only
    // thing left standing between the model and a charge is what the correction
    // did in Main.
    await sendCorrectionThroughTheSendBox('conv-1', MINTING_TURN);

    // The renderer really did take the correction path — leg 2, to aioncore.
    expect(steerInvokeMock).toHaveBeenCalledTimes(1);

    const attempt = await attemptEdit({
      handle: armed.handle,
      permit: armed.permit,
      instruction: 'gib der Aubergine ein Gesicht',
    });
    expect(attempt.fetchSpy).not.toHaveBeenCalled();
    expect(attempt.debitSpy).not.toHaveBeenCalled();
    expect(attempt.result.ok).toBe(false);
  });

  it('POSITIVE CONTROL: without the correction the very same permit reaches the provider and the debit exactly once', async () => {
    // Without this, a permanently broken harness would satisfy the test above.
    const armed = await armConversation('conv-1', MINTING_TURN);

    const attempt = await attemptEdit({
      handle: armed.handle,
      permit: armed.permit,
      instruction: 'gib der Aubergine ein Gesicht',
    });
    expect(attempt.result.ok).toBe(true);
    expect(attempt.fetchSpy).toHaveBeenCalledTimes(1);
    expect(attempt.debitSpy).toHaveBeenCalledTimes(1);
  });

  it('the correction reaches Main BEFORE it reaches the runtime, and Main really wrote the retirement', async () => {
    // Order, because the other way round leaves a window in which the model
    // holds the new instruction and the old permit at the same time.
    await armConversation('conv-1', MINTING_TURN);

    const correction = '/steer warte, mach lieber den Hintergrund blau';
    await sendCorrectionThroughTheSendBox('conv-1', correction);

    expect(artifactTurnSteerInvokeMock).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      steerText: correction,
    });
    expect(artifactTurnSteerInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      steerInvokeMock.mock.invocationCallOrder[0]
    );
    // Not a status string: the state Main actually left on disk.
    expect(store.readVideoEditSpendDenyState(dataRoot, 'conv-1').durable).toBe(true);
    expect(store.readActiveUserTurn(dataRoot, 'conv-1')?.user_turn_sha256).toBe(
      crypto.createHash('sha256').update(correction).digest('hex')
    );
  });

  // -------------------------------------------------------------------------
  // MAT-1747 round 8 — WHAT EACH BINDING ACTUALLY BINDS, measured at the seam
  // -------------------------------------------------------------------------
  //
  // An audit rejected a blanket "every binding is the exact raw user bytes"
  // claim, and it was right: `dispatchSteer` sends `normalizedInput`. Rather
  // than argue, the claim is now SCOPED, and these tests are what makes the
  // scoped version checkable instead of merely written down.
  //
  // TWO invariants, not one:
  //
  //   ORDINARY TURN (the only path that MINTS) — the permit binds the EXACT RAW
  //   bytes of the user's turn, at mint AND at redeem. Leading and trailing
  //   whitespace is load-bearing and survives end to end.
  //
  //   CORRECTION (the path that RETIRES) — nothing is minted, and the turn
  //   pointer binds the bytes ACTUALLY DELIVERED TO THE RUNTIME. Those are
  //   trimmed, and for a plain message typed during a run they are not even
  //   text the user typed: the busy-mode promotion prepends `/steer `. A
  //   raw-keystroke binding is therefore not merely unimplemented on this path,
  //   it is not the right rule for it — the correct thing for a retirement to
  //   name is what superseded the instruction IN THE RUN.
  //
  // These drive the real send box, the real bridge payload, the real Main
  // handlers and the real store. Nothing hand-calls a hashing helper.

  /** The ORDINARY send, through the send box, with the REAL Main envelope handler behind the IPC. */
  async function sendOrdinaryThroughTheSendBox(
    conversationId: string,
    text: string,
    options: { visibleVideoSource?: unknown } = {}
  ) {
    draftDataMock.current = { atPath: [], uploadFile: [], content: text };
    sendBoxMessageMock.current = text;
    runtimeViewMock.isProcessing = false;
    runtimeViewMock.canSendMessage = true;
    runtimeViewMock.activeTurnId = null;

    // 1.820.3 fail-closed gate: the send box passes `requestedEditOperation`
    // only when its authorization resolver sees BOTH the edit intent AND the
    // canonically editable source — and the source reaches it through the REAL
    // artifact provider, so the fixture exposes the seeded clip the same way
    // production does. `video-edit-hint` appearing is the deterministic proof
    // the provider has loaded before the send reads the source truth.
    if (options.visibleVideoSource) {
      videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [options.visibleVideoSource] });
    }

    // Same wiring idea as the steer leg above: only the serialization hop is
    // stood in for. The handler, the store and the disk are the real ones, so
    // the digest under assertion is the one production would write.
    artifactContextEnvelopeInvokeMock.mockImplementation((request: { conversationId: string; userTurnText?: string }) =>
      bridge.handleCommandEveArtifactContextEnvelopeBridge(request, {
        getDataPath: () => dataRoot,
        buildEntries: handleStore.buildConversationArtifactEnvelopeEntries,
        isVideoEditEnabled: () => true,
      })
    );
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
      },
    });

    render(
      <ConversationArtifactProvider conversation_id={conversationId}>
        <AcpSendBox
          conversation_id={conversationId}
          backend='hermes'
          workspacePath='/tmp/workspace'
          messageState={makeMessageState()}
        />
      </ConversationArtifactProvider>
    );

    if (options.visibleVideoSource) {
      await screen.findByTestId('video-edit-hint');
    }

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));
    return String(sendMessageInvokeMock.mock.calls[0][0].input);
  }

  const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

  // Padded on BOTH ends, and the padding is the whole point of the fixture.
  // 1.820.3: the sentence is an EXPLICIT video edit, because the fail-closed
  // gate mints only for a resolved edit operation — a bare "Hello" resolves to
  // no operation and carries no permit at all (that case is pinned in the
  // `editAuthorizationCore` / permit-gate suites).
  const PADDED_TURN = '   Bearbeite das Video   ';

  it('ORDINARY TURN: the padded raw bytes reach the mint AND the runtime, and the pointer is those bytes', async () => {
    const source = await seedSource('conv-raw', 'video-conv-raw');
    handleStore.ensureVideoEditCapabilityHandle(dataRoot, source);

    const sent = await sendOrdinaryThroughTheSendBox('conv-raw', PADDED_TURN);

    // 1. THE MINT was handed the padded bytes, untouched.
    expect(artifactContextEnvelopeInvokeMock).toHaveBeenCalledWith({
      conversationId: 'conv-raw',
      userTurnText: PADDED_TURN,
    });
    // 2. THE RUNTIME was handed the same padded bytes. `endsWith` rather than
    //    equality because the envelope block rides in front of them — which is
    //    exactly the thing that could have eaten the whitespace and did not.
    expect(sent.endsWith(PADDED_TURN)).toBe(true);
    // 3. THE POINTER Main wrote is the digest of the padded bytes, and provably
    //    NOT the digest of the trimmed ones.
    expect(store.readActiveUserTurn(dataRoot, 'conv-raw')?.user_turn_sha256).toBe(sha256(PADDED_TURN));
    expect(store.readActiveUserTurn(dataRoot, 'conv-raw')?.user_turn_sha256).not.toBe(sha256(PADDED_TURN.trim()));
  });

  it('ORDINARY TURN: the permit minted for the padded turn spends exactly once — POSITIVE CONTROL', async () => {
    // Without this, the refusal in the next test could be a broken fixture
    // rather than the whitespace mattering.
    const source = await seedSource('conv-raw', 'video-conv-raw');
    const handle = handleStore.ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const sent = await sendOrdinaryThroughTheSendBox('conv-raw', PADDED_TURN, { visibleVideoSource: source });

    // The permit is read out of the bytes the MODEL received, not out of a
    // handler return value — this is the credential the model actually holds.
    const permit = /evespend_[0-9a-f]{64}/.exec(sent)?.[0];
    expect(permit).toBeTruthy();

    const attempt = await attemptEdit({ handle, permit: permit!, instruction: 'mach es kuerzer' });
    expect(attempt.result.ok).toBe(true);
    expect(attempt.fetchSpy).toHaveBeenCalledTimes(1);
    expect(attempt.debitSpy).toHaveBeenCalledTimes(1);
  });

  it('ORDINARY TURN: REDEEM is byte-exact too — a pointer moved to the TRIMMED turn refuses the spend', async () => {
    // The invariant is "at BOTH mint and redeem". The mint half is above; this
    // is the redeem half. Whitespace is the only difference between the two
    // digests, and it is enough to close the paid path.
    const source = await seedSource('conv-raw', 'video-conv-raw');
    const handle = handleStore.ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const sent = await sendOrdinaryThroughTheSendBox('conv-raw', PADDED_TURN, { visibleVideoSource: source });
    const permit = /evespend_[0-9a-f]{64}/.exec(sent)?.[0];
    expect(permit).toBeTruthy();

    store.recordActiveUserTurn(dataRoot, 'conv-raw', sha256(PADDED_TURN.trim()));

    const attempt = await attemptEdit({ handle, permit: permit!, instruction: 'mach es kuerzer' });
    expect(attempt.result.ok).toBe(false);
    expect(attempt.fetchSpy).not.toHaveBeenCalled();
    expect(attempt.debitSpy).not.toHaveBeenCalled();
  });

  it('CORRECTION: the retire and the runtime get the SAME bytes, and they are the trimmed ones', async () => {
    await armConversation('conv-1', MINTING_TURN);

    const typedWithPadding = '  /steer mach den Hintergrund blau   ';
    const delivered = '/steer mach den Hintergrund blau';
    await sendCorrectionThroughTheSendBox('conv-1', typedWithPadding);

    // Leg 1 (Main) and leg 2 (the runtime) carry ONE value between them. That
    // identity is the invariant a retirement needs; being raw is not.
    expect(artifactTurnSteerInvokeMock).toHaveBeenCalledWith({ conversationId: 'conv-1', steerText: delivered });
    expect(String(steerInvokeMock.mock.calls[0][0].input)).toBe(delivered);
    expect(String(steerInvokeMock.mock.calls[0][0].input)).not.toBe(typedWithPadding);

    // And the pointer on disk is the DELIVERED digest, not the padded one.
    expect(store.readActiveUserTurn(dataRoot, 'conv-1')?.user_turn_sha256).toBe(sha256(delivered));
    expect(store.readActiveUserTurn(dataRoot, 'conv-1')?.user_turn_sha256).not.toBe(sha256(typedWithPadding));
  });

  it('CORRECTION: a promoted queued command is REWRITTEN, so no raw-keystroke binding exists to have', async () => {
    // The reason the two paths cannot share one rule, on the other production
    // route into `dispatchSteer`: promoting a queued message into the running
    // turn. What the runtime receives is `/steer …` — a command string the
    // person never typed, built by `buildConversationBusyControlCommand`.
    // Binding the pointer to raw keystrokes would bind it to text the agent
    // never saw, which is not a stricter rule, just a wrong one.
    await armConversation('conv-2', MINTING_TURN);

    const queuedItem = { id: 'queued-1', input: '   mach den Hintergrund blau   ', files: [], created_at: 1 };
    const delivered = '/steer mach den Hintergrund blau';
    queueItemsMock.current = [queuedItem];
    runtimeViewMock.isProcessing = true;
    runtimeViewMock.canSendMessage = false;
    runtimeViewMock.activeTurnId = 'turn-1';

    render(
      <AcpSendBox
        conversation_id='conv-2'
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

    expect(artifactTurnSteerInvokeMock).toHaveBeenCalledWith({ conversationId: 'conv-2', steerText: delivered });
    expect(String(steerInvokeMock.mock.calls[0][0].input)).toBe(delivered);
    expect(String(steerInvokeMock.mock.calls[0][0].input)).not.toBe(queuedItem.input);
    expect(store.readActiveUserTurn(dataRoot, 'conv-2')?.user_turn_sha256).toBe(sha256(delivered));
    expect(store.readActiveUserTurn(dataRoot, 'conv-2')?.user_turn_sha256).not.toBe(sha256(queuedItem.input));
  });

  it('CORRECTION: whitespace never buys a spend back — the retirement still refuses with ZERO fetch and ZERO debit', async () => {
    // The scoping is a documentation fix, not a weakening. The load-bearing
    // defence on this path is the revoke plus the unconditional deny, and
    // neither depends on which bytes the pointer holds.
    const armed = await armConversation('conv-1', MINTING_TURN);

    await sendCorrectionThroughTheSendBox('conv-1', `  ${MINTING_TURN}  `);

    expect(store.readVideoEditSpendDenyState(dataRoot, 'conv-1').durable).toBe(true);
    const attempt = await attemptEdit({
      handle: armed.handle,
      permit: armed.permit,
      instruction: 'gib der Aubergine ein Gesicht',
    });
    expect(attempt.fetchSpy).not.toHaveBeenCalled();
    expect(attempt.debitSpy).not.toHaveBeenCalled();
    expect(attempt.result.ok).toBe(false);
  });
});
