/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, useEffect } from 'react';
import { classifyAcpStreamWatchdog, useAcpMessage } from '@/renderer/pages/conversation/platforms/acp/useAcpMessage';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { AcpPermissionRequest } from '@/common/types/platform/acpTypes';
import { emitter } from '@/renderer/utils/emitter';
import { COMMAND_EVE_HG4_DELEGATED_MODE } from '@/renderer/utils/model/agentModes';
import {
  ACP_EXTERNAL_WRITE_RECOVERY_MAX_MARKDOWN_BYTES,
  classifyAcpExternalWriteBlock,
} from '@/renderer/pages/conversation/Messages/acp/externalWriteRecoveryPolicy';
import {
  localSendAccepted,
  localSendStarted,
  resetConversationRuntimeViewStoreForTest,
} from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';
import { useConversationArtifactsById } from '@/renderer/pages/conversation/Messages/artifacts';
import { registerPreviewPageReader } from '@/renderer/pages/conversation/Preview/services/previewReader';
import { registerConversationTerminalReader } from '@/renderer/pages/conversation/Preview/services/terminalReader';
import {
  getCurrentLiveDelegationObservation,
  resetConversationDelegationActivityForTest,
  useConversationDelegationActivity,
} from '@/renderer/pages/conversation/runtime/conversationDelegationActivityStore';

const {
  addOrUpdateMessageMock,
  responseStreamOnMock,
  responseStreamHandlerRef,
  conversationGetInvokeMock,
  conversationGetUsageInvokeMock,
  confirmMessageInvokeMock,
  respondReadPreviewInvokeMock,
  respondReadTerminalInvokeMock,
  reportInferenceErrorMock,
  ensureAutoProjectInvokeMock,
  conversationStopInvokeMock,
  reportStageWorkspaceInvokeMock,
  openPreviewMock,
  launchPreviewMock,
  imageArtifactBindInvokeMock,
  previewContextState,
  realtimeConnectedHandlers,
} = vi.hoisted(() => ({
  addOrUpdateMessageMock: vi.fn(),
  responseStreamOnMock: vi.fn(),
  responseStreamHandlerRef: {
    current: undefined as ((message: IResponseMessage) => void) | undefined,
  },
  conversationGetInvokeMock: vi.fn(),
  conversationGetUsageInvokeMock: vi.fn().mockResolvedValue(null),
  confirmMessageInvokeMock: vi.fn(),
  respondReadPreviewInvokeMock: vi.fn(),
  respondReadTerminalInvokeMock: vi.fn(),
  conversationStopInvokeMock: vi.fn(),
  reportStageWorkspaceInvokeMock: vi.fn(),
  openPreviewMock: vi.fn(),
  launchPreviewMock: vi.fn(async () => undefined),
  imageArtifactBindInvokeMock: vi.fn(async () => undefined),
  realtimeConnectedHandlers: new Set<(event: { reconnected?: boolean }) => void>(),
  previewContextState: {
    activeTabId: 'browser-tab' as string | null,
    isOpen: true,
    tabs: [
      {
        id: 'browser-tab',
        title: 'Browser',
        content: 'https://example.com',
        content_type: 'url',
        isDirty: false,
        originalContent: 'https://example.com',
        metadata: { conversation_id: 'conv-1', title: 'Browser' },
      },
    ] as Array<Record<string, unknown>>,
  },
  // Default: NO quota/cap signal recognized → the error path renders the cold bubble
  // exactly as before. Tests flip this to true to exercise the suppression (M-quotawall).
  reportInferenceErrorMock: vi.fn((): boolean => false),
  // 1.820.4 (MAT-1772): the post-turn auto-project IPC hint (fire-and-forget).
  ensureAutoProjectInvokeMock: vi.fn().mockResolvedValue({ status: 'noop' }),
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    activeTabId: previewContextState.activeTabId,
    isOpen: previewContextState.isOpen,
    openPreview: openPreviewMock,
    tabs: previewContextState.tabs,
  }),
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  conversation: {
    confirmMessage: {
      invoke: confirmMessageInvokeMock,
    },
    respondReadPreview: {
      invoke: respondReadPreviewInvokeMock,
    },
    respondReadTerminal: {
      invoke: respondReadTerminalInvokeMock,
    },
  },
}));

vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  useAddOrUpdateMessage: () => addOrUpdateMessageMock,
}));

// B7 (CEVE-1821): the hook now opens an html artifact from disk once its write
// completes, via usePreviewLauncher. That hook reads PreviewContext and THROWS
// without a PreviewProvider — in production the provider is app-level
// (main.tsx:246) and useAcpMessage's only caller sits under it (AcpChat.tsx:102),
// but this suite renders the hook bare. Mocked rather than wrapped: these tests
// are about the message lifecycle, and a real preview launcher would drag the
// whole conversation context in with it.
vi.mock('@renderer/hooks/file/usePreviewLauncher', () => ({
  usePreviewLauncher: () => ({ launchPreview: launchPreviewMock, loading: false, errorKind: null }),
}));

vi.mock('@renderer/hooks/useQuotaWall', () => ({
  useQuotaWall: () => ({
    body: null,
    jobInFlight: false,
    dailyCapReached: false,
    autoReload: false,
    reportInferenceError: reportInferenceErrorMock,
    closeWall: vi.fn(),
    setAutoReload: vi.fn(),
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      responseStream: {
        on: responseStreamOnMock.mockImplementation((handler: (message: IResponseMessage) => void) => {
          responseStreamHandlerRef.current = handler;
          return vi.fn();
        }),
      },
    },
    conversation: {
      get: {
        invoke: conversationGetInvokeMock,
      },
      stop: {
        invoke: conversationStopInvokeMock,
      },
      activeCount: {
        invoke: vi.fn().mockResolvedValue({ count: 0 }),
      },
      warmup: {
        invoke: vi.fn().mockResolvedValue(undefined),
      },
      getSlashCommands: {
        invoke: vi.fn().mockResolvedValue([]),
      },
      getUsage: {
        invoke: conversationGetUsageInvokeMock,
      },
      // MAT-1773 — the shared artifact store's durable sources; a store
      // subscriber in these tests loads from them.
      listArtifacts: {
        invoke: vi.fn().mockResolvedValue([]),
      },
      artifactStream: {
        on: vi.fn(() => () => {}),
      },
      realtimeConnected: {
        on: (handler: (event: { reconnected?: boolean }) => void) => {
          realtimeConnectedHandlers.add(handler);
          return () => realtimeConnectedHandlers.delete(handler);
        },
      },
    },
    commandEve: {
      videoArtifactsList: {
        invoke: vi.fn().mockResolvedValue({ success: true, data: [] }),
      },
      imageArtifactsList: {
        invoke: vi.fn().mockResolvedValue({ success: true, data: [] }),
      },
      imageArtifactsChanged: {
        on: vi.fn(() => () => {}),
      },
      imageArtifactBind: {
        invoke: imageArtifactBindInvokeMock,
      },
    },
    projectWorkspace: {
      ensureAfterSuccessfulTurn: {
        invoke: ensureAutoProjectInvokeMock,
      },
    },
    report: {
      stageWorkspace: {
        invoke: reportStageWorkspaceInvokeMock,
      },
    },
  },
}));

const makeExternalWriteFailure = (
  overrides: Record<string, unknown> = {},
  turnId = 'turn-write-recovery'
): IResponseMessage => ({
  type: 'acp_tool_call',
  data: {
    session_id: 'session-write',
    update: {
      sessionUpdate: 'tool_call_update',
      tool_call_id: 'write-call-1',
      status: 'failed',
      title: 'Write report',
      kind: 'edit',
      raw_input: {
        path: '/Users/operator/Desktop/Quarterly Report.pdf',
        content: '# Quarterly report\n\nRecovered body.',
      },
      content: [{ type: 'content', content: { type: 'text', text: 'RESULT: HardBlocked' } }],
      ...overrides,
    },
  },
  msg_id: 'message-write-call-1',
  turn_id: turnId,
  conversation_id: 'conv-1',
});

describe('classifyAcpExternalWriteBlock', () => {
  it.each([
    '/tmp/client-report.pdf',
    '/Users/operator/Desktop/client-report.docx',
    '/Users/operator/Downloads/client-report.md',
    'C:\\Users\\operator\\Desktop\\client-report.pdf',
  ])('accepts a failed external report write with an exact HardBlocked RESULT marker: %s', (requestedPath) => {
    const message = makeExternalWriteFailure({
      rawInput: JSON.stringify({ path: requestedPath, markdown: '# Report' }),
      raw_input: undefined,
    });
    expect(classifyAcpExternalWriteBlock(message.data)).toEqual({
      toolCallId: 'write-call-1',
      requestedPath,
      suggestedName: requestedPath.split(/[\\/]/).at(-1),
      markdown: '# Report',
    });
  });

  it('reads the marker only from tool result content, never from report text itself', () => {
    const markerOnlyInReport = makeExternalWriteFailure({
      raw_input: { path: '/tmp/report.md', content: '# Report\n\nRESULT: HardBlocked' },
      content: [{ type: 'content', content: { type: 'text', text: 'permission denied' } }],
    });
    expect(classifyAcpExternalWriteBlock(markerOnlyInReport.data)).toBeUndefined();

    const markerMixedWithResultProse = makeExternalWriteFailure({
      raw_input: { path: '/tmp/report.md', content: '# Report' },
      content: [{ type: 'content', content: { type: 'text', text: 'permission denied\nRESULT: HardBlocked' } }],
    });
    expect(classifyAcpExternalWriteBlock(markerMixedWithResultProse.data)).toBeUndefined();

    const equalsMarker = makeExternalWriteFailure({
      content: [{ type: 'content', content: { type: 'text', text: 'RESULT=HardBlocked' } }],
    });
    expect(classifyAcpExternalWriteBlock(equalsMarker.data)).toBeUndefined();

    const untypedMarker = makeExternalWriteFailure({ content: [{ content: { text: 'RESULT: HardBlocked' } }] });
    expect(classifyAcpExternalWriteBlock(untypedMarker.data)).toBeUndefined();
  });

  it('falls back from malformed rawInput to a valid raw_input compatibility payload', () => {
    const message = makeExternalWriteFailure({
      rawInput: '{malformed',
      raw_input: { path: '/tmp/report.md', content: '# Compatible report' },
    });
    expect(classifyAcpExternalWriteBlock(message.data)?.markdown).toBe('# Compatible report');
  });

  it.each([
    ['shell error', { kind: 'execute' }],
    ['read error', { kind: 'read' }],
    ['relative target', { raw_input: { path: 'reports/report.md', content: '# Report' } }],
    ['missing path', { raw_input: { content: '# Report' } }],
    ['missing markdown', { raw_input: { path: '/tmp/report.md' } }],
    ['malformed raw input', { rawInput: '{bad-json', raw_input: undefined }],
    ['missing tool session update', { sessionUpdate: undefined }],
    ['non-failed status', { status: 'completed' }],
  ])('fails closed for %s', (_label, update) => {
    expect(classifyAcpExternalWriteBlock(makeExternalWriteFailure(update).data)).toBeUndefined();
  });

  it('rejects markdown beyond the UTF-8 byte limit', () => {
    const message = makeExternalWriteFailure({
      raw_input: {
        path: '/tmp/report.md',
        content: 'ä'.repeat(ACP_EXTERNAL_WRITE_RECOVERY_MAX_MARKDOWN_BYTES),
      },
    });
    expect(classifyAcpExternalWriteBlock(message.data)).toBeUndefined();
  });
});

const makePermissionRequest = (callId: string): AcpPermissionRequest => ({
  session_id: 'session-1',
  options: [
    { option_id: 'allow-once', name: 'Allow', kind: 'allow_once' },
    { option_id: 'reject-once', name: 'Reject', kind: 'reject_once' },
  ],
  tool_call: {
    tool_call_id: callId,
    kind: 'edit',
    title: 'Approve edit',
    raw_input: { description: 'write file' },
  },
});

const emitPermission = (callId: string): void => {
  responseStreamHandlerRef.current?.({
    type: 'acp_permission',
    data: makePermissionRequest(callId),
    msg_id: `message-${callId}`,
    conversation_id: 'conv-1',
  });
};

const PassiveGrantPublisher = () => {
  useEffect(() => {
    emitter.emit('acp.permission.mode', {
      conversation_id: 'conv-1',
      mode: COMMAND_EVE_HG4_DELEGATED_MODE,
    });
  }, []);
  return null;
};

const PermissionMountHarness = () => {
  useAcpMessage('conv-1');
  return createElement(PassiveGrantPublisher);
};

describe('useAcpMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConversationRuntimeViewStoreForTest();
    resetConversationDelegationActivityForTest();
    responseStreamHandlerRef.current = undefined;
    confirmMessageInvokeMock.mockResolvedValue(undefined);
    respondReadPreviewInvokeMock.mockResolvedValue({ accepted: true });
    respondReadTerminalInvokeMock.mockResolvedValue({ accepted: true });
    previewContextState.activeTabId = 'browser-tab';
    previewContextState.isOpen = true;
    previewContextState.tabs = [
      {
        id: 'browser-tab',
        title: 'Browser',
        content: 'https://example.com',
        content_type: 'url',
        isDirty: false,
        originalContent: 'https://example.com',
        metadata: { conversation_id: 'conv-1', title: 'Browser' },
      },
    ];
    reportInferenceErrorMock.mockReturnValue(false);
    conversationStopInvokeMock.mockResolvedValue({
      runtime: {
        state: 'idle',
        can_send_message: true,
        has_task: false,
        task_status: 'finished',
        is_processing: false,
        pending_confirmations: 0,
        turn_id: null,
      },
    });
    reportStageWorkspaceInvokeMock.mockResolvedValue({
      success: true,
      data: {
        version: 'command-eve-report-stage-workspace/v0',
        ok: true,
        file_name: 'quarterly-report.md',
        size_bytes: 35,
      },
    });
  });

  it('keeps one response-stream subscription across stream-driven renders', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    renderHook(() => useAcpMessage('conv-1'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(responseStreamOnMock).toHaveBeenCalledTimes(1);

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: null,
        msg_id: 'msg-1',
        conversation_id: 'conv-1',
      });
    });

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'text',
        data: 'Visible without remount',
        msg_id: 'msg-1',
        conversation_id: 'conv-1',
      });
    });

    expect(responseStreamOnMock).toHaveBeenCalledTimes(1);
    expect(addOrUpdateMessageMock).toHaveBeenCalled();
  });

  it('downgrades a prior observed worker immediately when ACP start binds a new session', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const { result } = renderHook(() => {
      useAcpMessage('conv-1');
      return useConversationDelegationActivity('conv-1');
    });
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-a' },
        msg_id: 'start-session-a',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: 'worker-a',
            status: 'in_progress',
            title: 'delegate: Worker A',
            kind: 'execute',
            rawInput: { goal: 'Worker A' },
          },
        },
        msg_id: 'worker-a-message',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
    });
    expect(result.current).toMatchObject([{ id: 'worker-a:0', observedLive: true }]);
    expect(getCurrentLiveDelegationObservation('conv-1', 'worker-a:0')).toMatchObject({ acpSessionId: 'session-a' });

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-b' },
        msg_id: 'start-session-b',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
    });

    expect(result.current).toMatchObject([{ id: 'worker-a:0', observedLive: false }]);
    expect(getCurrentLiveDelegationObservation('conv-1', 'worker-a:0')).toBeNull();
  });

  it('revokes all prior authority on malformed starts before admitting a later valid start', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const emitSpy = vi.spyOn(emitter, 'emit');
    const { result } = renderHook(() => {
      useAcpMessage('conv-1');
      return useConversationDelegationActivity('conv-1');
    });
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-a' },
        msg_id: 'start-session-a',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'worker-a',
            status: 'in_progress',
            title: 'delegate: Worker A',
            kind: 'execute',
            raw_input: { goal: 'Worker A' },
          },
        },
        msg_id: 'worker-a-live',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      for (const data of [null, { session_id: ' ' }, { session_id: 7 }]) {
        responseStreamHandlerRef.current?.({
          type: 'start',
          data,
          msg_id: `invalid-start-${String(data)}`,
          turn_id: 'turn-b',
          conversation_id: 'conv-1',
        });
      }
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'old-a-preview',
            status: 'completed',
            kind: 'execute',
            title: 'open_preview',
            raw_input: { url: 'https://old-a.example', label: 'Old A' },
          },
        },
        msg_id: 'old-a-preview',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'old-a-pane',
            status: 'completed',
            kind: 'execute',
            title: 'focus_pane',
            raw_input: { pane: 'files' },
          },
        },
        msg_id: 'old-a-pane',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'old-a-html',
            status: 'in_progress',
            kind: 'edit',
            title: 'write: old-a.html',
            locations: [{ path: 'old-a.html' }],
          },
        },
        msg_id: 'old-a-html',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'old-a-image',
            status: 'completed',
            kind: 'execute',
            title: 'image generation',
            content: [{ type: 'content', content: { type: 'text', text: `img_h_${'a'.repeat(64)}` } }],
          },
        },
        msg_id: 'old-a-image',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'old-a-typed-ui',
            status: 'completed',
            kind: 'execute',
            title: 'mcp__aionui_eve_artifacts__eve_typed_ui_publish',
            result_display: {
              ok: true,
              artifact_type: 'file',
              mime_type: 'application/vnd.command-eve.typed-ui+json',
            },
          },
        },
        msg_id: 'old-a-typed-ui',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
    });

    expect(result.current).toMatchObject([{ id: 'worker-a:0', observedLive: false }]);
    expect(getCurrentLiveDelegationObservation('conv-1', 'worker-a:0')).toBeNull();
    expect(openPreviewMock).not.toHaveBeenCalled();
    expect(launchPreviewMock).not.toHaveBeenCalled();
    expect(imageArtifactBindInvokeMock).not.toHaveBeenCalled();
    expect(emitSpy.mock.calls.filter(([event]) => event === 'commandEve.workbench.reveal')).toEqual([]);
    expect(addOrUpdateMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'old-a-preview' }));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-c' },
        msg_id: 'start-session-c',
        turn_id: 'turn-c',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-c',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'worker-c',
            status: 'in_progress',
            title: 'delegate: Worker C',
            kind: 'execute',
            raw_input: { goal: 'Worker C' },
          },
        },
        msg_id: 'worker-c-live',
        turn_id: 'turn-c',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-c',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'worker-c-preview',
            status: 'completed',
            kind: 'execute',
            title: 'open_preview',
            raw_input: { url: 'https://session-c.example', label: 'Session C' },
          },
        },
        msg_id: 'worker-c-preview',
        turn_id: 'turn-c',
        conversation_id: 'conv-1',
      });
    });

    expect(result.current).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'worker-c:0', observedLive: true })])
    );
    expect(openPreviewMock).toHaveBeenCalledWith('https://session-c.example', 'url', {
      title: 'Session C',
      conversation_id: 'conv-1',
    });
    expect(addOrUpdateMessageMock).toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'worker-c-preview' }));
    emitSpy.mockRestore();
  });

  it.each([
    ['a null session', { session_id: null }, 'turn-b'],
    ['a blank session', { session_id: ' ' }, 'turn-b'],
    ['a non-string session', { session_id: 7 }, 'turn-b'],
    ['a missing turn', { session_id: 'session-b' }, undefined],
    ['a blank turn', { session_id: 'session-b' }, ' '],
  ])('does not restore old authority when hydration resolves after %s', async (_label, data, turnId) => {
    let resolveHydration: ((value: unknown) => void) | undefined;
    conversationGetInvokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHydration = resolve;
        })
    );
    const { result } = renderHook(() => {
      useAcpMessage('conv-1');
      return useConversationDelegationActivity('conv-1');
    });
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));
    await waitFor(() => expect(resolveHydration).toBeTypeOf('function'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-a' },
        msg_id: 'start-session-a',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'worker-a',
            status: 'in_progress',
            title: 'delegate: Worker A',
            kind: 'execute',
            raw_input: { goal: 'Worker A' },
          },
        },
        msg_id: 'worker-a-live',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'start',
        data,
        msg_id: `invalid-start-${_label}`,
        ...(turnId === undefined ? {} : { turn_id: turnId }),
        conversation_id: 'conv-1',
      });
    });

    await act(async () => {
      resolveHydration?.({
        id: 'conv-1',
        type: 'acp',
        status: 'finished',
        extra: { acp_session_id: 'session-a', backend: 'hermes' },
      });
      await Promise.resolve();
    });

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'worker-a-replay',
            status: 'completed',
            title: 'open_preview',
            kind: 'execute',
            raw_input: { url: 'https://old-a.example', label: 'Old A' },
          },
        },
        msg_id: 'worker-a-replay',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
    });

    expect(result.current).toMatchObject([{ id: 'worker-a:0', observedLive: false }]);
    expect(getCurrentLiveDelegationObservation('conv-1', 'worker-a:0')).toBeNull();
    expect(openPreviewMock).not.toHaveBeenCalled();
    expect(addOrUpdateMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'worker-a-replay' }));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-c' },
        msg_id: 'start-session-c',
        turn_id: 'turn-c',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-c',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'worker-c',
            status: 'in_progress',
            title: 'delegate: Worker C',
            kind: 'execute',
            raw_input: { goal: 'Worker C' },
          },
        },
        msg_id: 'worker-c-live',
        turn_id: 'turn-c',
        conversation_id: 'conv-1',
      });
    });

    expect(result.current).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'worker-c:0', observedLive: true })])
    );
    expect(getCurrentLiveDelegationObservation('conv-1', 'worker-c:0')).toMatchObject({ acpSessionId: 'session-c' });
  });

  it('keeps session-info display-only and rejects a delayed tool frame from the prior session', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const { result } = renderHook(() => {
      useAcpMessage('conv-1');
      return useConversationDelegationActivity('conv-1');
    });
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-a' },
        msg_id: 'start-session-a',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: 'worker-a',
            status: 'in_progress',
            title: 'delegate: Worker A',
            kind: 'execute',
            rawInput: { goal: 'Worker A' },
          },
        },
        msg_id: 'worker-a-message',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
    });
    expect(result.current).toMatchObject([{ id: 'worker-a:0', observedLive: true }]);

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'acp_session_info',
        data: {
          session_id: 'session-a',
          title: null,
          updated_at: null,
          _meta: {},
        },
        msg_id: 'session-info-b',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
    });

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-b' },
        msg_id: 'start-session-b',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
    });
    expect(result.current).toMatchObject([{ id: 'worker-a:0', observedLive: false }]);
    expect(getCurrentLiveDelegationObservation('conv-1', 'worker-a:0')).toBeNull();

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: 'worker-a-replay',
            status: 'in_progress',
            title: 'delegate: Worker A replay',
            kind: 'execute',
            rawInput: { goal: 'Worker A replay' },
          },
        },
        msg_id: 'worker-a-replay-message',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
    });

    expect(result.current).toMatchObject([{ id: 'worker-a:0', observedLive: false }]);
    expect(result.current.find(({ id }) => id === 'worker-a-replay:0')).toBeUndefined();
    expect(getCurrentLiveDelegationObservation('conv-1', 'worker-a:0')).toBeNull();
  });

  it('retains the already-bound session after reconnect and drops an old-session tool replay', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const { result } = renderHook(() => {
      useAcpMessage('conv-1');
      return useConversationDelegationActivity('conv-1');
    });
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-b' },
        msg_id: 'start-session-b',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-b',
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: 'worker-b',
            status: 'in_progress',
            title: 'delegate: Worker B',
            kind: 'execute',
            rawInput: { goal: 'Worker B' },
          },
        },
        msg_id: 'worker-b-message',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
      realtimeConnectedHandlers.forEach((handler) => handler({ reconnected: true }));
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: 'worker-a-replay',
            status: 'in_progress',
            title: 'delegate: Worker A replay',
            kind: 'execute',
            rawInput: { goal: 'Worker A replay' },
          },
        },
        msg_id: 'worker-a-replay-after-reconnect',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
    });

    expect(result.current).toMatchObject([{ id: 'worker-b:0', observedLive: false }]);
    expect(result.current.find(({ id }) => id === 'worker-a-replay:0')).toBeUndefined();
    expect(getCurrentLiveDelegationObservation('conv-1', 'worker-b:0')).toBeNull();
  });

  it('does not let a delayed session-info frame replace a newer start-bound session', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const { result } = renderHook(() => {
      useAcpMessage('conv-1');
      return useConversationDelegationActivity('conv-1');
    });
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-b' },
        msg_id: 'start-session-b',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_session_info',
        data: {
          session_id: 'session-a',
          title: null,
          updated_at: null,
          _meta: {},
        },
        msg_id: 'delayed-session-info-a',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: 'worker-a-replay',
            status: 'in_progress',
            title: 'delegate: Worker A replay',
            kind: 'execute',
            rawInput: { goal: 'Worker A replay' },
          },
        },
        msg_id: 'worker-a-replay-after-session-info',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-b',
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: 'worker-b',
            status: 'in_progress',
            title: 'delegate: Worker B',
            kind: 'execute',
            rawInput: { goal: 'Worker B' },
          },
        },
        msg_id: 'worker-b-message',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
    });

    expect(result.current.find(({ id }) => id === 'worker-a-replay:0')).toBeUndefined();
    expect(result.current).toMatchObject([{ id: 'worker-b:0', observedLive: true }]);
    expect(getCurrentLiveDelegationObservation('conv-1', 'worker-b:0')).toMatchObject({ acpSessionId: 'session-b' });
  });

  it('keeps a newer start binding when an earlier persisted hydration resolves late', async () => {
    let resolveHydration: ((value: unknown) => void) | undefined;
    conversationGetInvokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHydration = resolve;
        })
    );
    const { result } = renderHook(() => {
      useAcpMessage('conv-1');
      return useConversationDelegationActivity('conv-1');
    });
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));
    await waitFor(() => expect(resolveHydration).toBeTypeOf('function'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-b' },
        msg_id: 'start-session-b',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
    });

    await act(async () => {
      resolveHydration?.({
        id: 'conv-1',
        type: 'acp',
        status: 'finished',
        extra: { acp_session_id: 'session-a', backend: 'hermes' },
      });
      await Promise.resolve();
    });

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: 'worker-a-replay',
            status: 'in_progress',
            title: 'delegate: Worker A replay',
            kind: 'execute',
            rawInput: { goal: 'Worker A replay' },
          },
        },
        msg_id: 'worker-a-replay-after-hydration',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-b',
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: 'worker-b',
            status: 'in_progress',
            title: 'delegate: Worker B',
            kind: 'execute',
            rawInput: { goal: 'Worker B' },
          },
        },
        msg_id: 'worker-b-after-hydration',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
    });

    expect(result.current.find(({ id }) => id === 'worker-a-replay:0')).toBeUndefined();
    expect(result.current).toMatchObject([{ id: 'worker-b:0', observedLive: true }]);
    expect(getCurrentLiveDelegationObservation('conv-1', 'worker-b:0')).toMatchObject({ acpSessionId: 'session-b' });
  });

  it('binds a persisted ACP session when no newer start authority exists', async () => {
    conversationGetInvokeMock.mockResolvedValue({
      id: 'conv-1',
      type: 'acp',
      status: 'finished',
      extra: { acp_session_id: 'session-a', backend: 'hermes' },
    });
    const { result } = renderHook(() => {
      useAcpMessage('conv-1');
      return useConversationDelegationActivity('conv-1');
    });
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: 'worker-a',
            status: 'in_progress',
            title: 'delegate: Worker A',
            kind: 'execute',
            rawInput: { goal: 'Worker A' },
          },
        },
        msg_id: 'worker-a-after-hydration',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
    });

    expect(result.current).toMatchObject([{ id: 'worker-a:0', observedLive: true }]);
    expect(getCurrentLiveDelegationObservation('conv-1', 'worker-a:0')).toMatchObject({ acpSessionId: 'session-a' });
  });

  it('routes only session-bound Hermes preview and native-pane events', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const emitSpy = vi.spyOn(emitter, 'emit');
    renderHook(() => useAcpMessage('conv-1'));
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));
    await waitFor(() => expect(conversationGetInvokeMock).toHaveBeenCalled());

    const send = (event: string, payload: unknown, sessionId = 'acp-session-1') => {
      responseStreamHandlerRef.current?.({
        type: 'acp_session_info',
        data: {
          // Real ACP SessionInfoUpdate frames preserve unset optional fields
          // as null after AionCore's projection.
          title: null,
          updated_at: null,
          session_id: sessionId,
          _meta: {
            commandEveDesktop: {
              version: 'command-eve-desktop-event/v1',
              sessionId,
              event,
              payload,
            },
          },
        },
        msg_id: `desktop-${event}`,
        turn_id: 'turn-desktop-1',
        conversation_id: 'conv-1',
      });
    };

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'acp-session-1' },
        msg_id: 'desktop-start',
        turn_id: 'turn-desktop-1',
        conversation_id: 'conv-1',
      });
      localSendStarted('conv-1');
      localSendAccepted('conv-1', 'turn-desktop-1', {
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        pending_confirmations: 0,
        turn_id: 'turn-desktop-1',
      });
      send('preview.open', { url: 'https://example.com', label: 'Example' });
      send('pane.reveal', { pane: 'files' });
      send('preview.open', { url: 'https://foreign.example' }, 'foreign-session');
      responseStreamHandlerRef.current?.({
        type: 'acp_session_info',
        data: {
          title: null,
          updated_at: null,
          session_id: 'acp-session-1',
          _meta: {
            commandEveDesktop: {
              version: 'command-eve-desktop-event/v1',
              sessionId: 'acp-session-1',
              event: 'preview.open',
              payload: { url: 'https://stale-turn.example', label: 'Stale turn' },
            },
          },
        },
        msg_id: 'desktop-stale-turn',
        turn_id: 'turn-old',
        conversation_id: 'conv-1',
      });
      send('terminal.read', {});
      send('pane.reveal', { pane: 'terminal' });
      send('pane.reveal', { pane: 'kanban' });
    });

    expect(openPreviewMock).toHaveBeenCalledTimes(1);
    expect(openPreviewMock).toHaveBeenCalledWith('https://example.com', 'url', {
      title: 'Example',
      conversation_id: 'conv-1',
    });
    expect(emitSpy.mock.calls.filter(([event]) => event === 'commandEve.workbench.reveal')).toEqual([
      ['commandEve.workbench.reveal', { conversation_id: 'conv-1', pane: 'files' }],
      ['commandEve.workbench.reveal', { conversation_id: 'conv-1', pane: 'terminal' }],
    ]);
    emitSpy.mockRestore();
  });

  it('does not perform desktop side effects before a positive ACP session binding', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const emitSpy = vi.spyOn(emitter, 'emit');
    renderHook(() => useAcpMessage('conv-1'));
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'acp_session_info',
        data: {
          title: null,
          updated_at: null,
          session_id: 'session-a',
          _meta: {
            commandEveDesktop: {
              version: 'command-eve-desktop-event/v1',
              sessionId: 'session-a',
              event: 'preview.open',
              payload: { url: 'https://unbound.example', label: 'Unbound' },
            },
          },
        },
        msg_id: 'desktop-unbound',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
    });

    expect(openPreviewMock).not.toHaveBeenCalled();
    expect(emitSpy.mock.calls.filter(([event]) => event === 'commandEve.workbench.reveal')).toEqual([]);
    emitSpy.mockRestore();
  });

  it('blocks a foreign session tool frame before its desktop side effects', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const emitSpy = vi.spyOn(emitter, 'emit');
    const { result } = renderHook(() => {
      useAcpMessage('conv-1');
      return useConversationDelegationActivity('conv-1');
    });
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-b' },
        msg_id: 'start-session-b',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'session-a',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'foreign-open-preview',
            status: 'completed',
            kind: 'execute',
            title: 'open_preview',
            raw_input: { url: 'https://foreign.example', label: 'Foreign' },
          },
        },
        msg_id: 'foreign-tool-frame',
        turn_id: 'turn-a',
        conversation_id: 'conv-1',
      });
    });

    expect(openPreviewMock).not.toHaveBeenCalled();
    expect(emitSpy.mock.calls.filter(([event]) => event === 'commandEve.workbench.reveal')).toEqual([]);
    expect(result.current).toEqual([]);
    expect(addOrUpdateMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'foreign-tool-frame' }));
    emitSpy.mockRestore();
  });

  it('answers one strict session-bound read_preview request from the visibly active browser', async () => {
    conversationGetInvokeMock.mockResolvedValue({
      id: 'conv-1',
      type: 'acp',
      status: 'running',
      extra: { acp_session_id: 'acp-session-1', backend: 'hermes' },
    });
    const unregister = registerPreviewPageReader('browser-tab', async () => ({
      text: 'Visible page text',
      title: 'Live page',
      url: 'https://example.com/live',
    }));
    renderHook(() => useAcpMessage('conv-1'));
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));
    await waitFor(() => expect(conversationGetInvokeMock).toHaveBeenCalled());

    const request: IResponseMessage = {
      type: 'acp_read_preview_request',
      data: {
        version: 'command-eve-read-preview/v1',
        request_id: 'preview-request-1',
        session_id: 'acp-session-1',
        start: 0,
        count: 100,
      },
      msg_id: 'preview-request-message-1',
      turn_id: 'turn-preview-1',
      conversation_id: 'conv-1',
    };
    act(() => {
      responseStreamHandlerRef.current?.(request);
      responseStreamHandlerRef.current?.(request);
      responseStreamHandlerRef.current?.({
        ...request,
        data: { ...(request.data as object), request_id: 'foreign-request', session_id: 'foreign-session' },
      });
    });

    await waitFor(() => expect(respondReadPreviewInvokeMock).toHaveBeenCalledTimes(1));
    expect(respondReadPreviewInvokeMock).toHaveBeenCalledWith({
      conversation_id: 'conv-1',
      version: 'command-eve-read-preview/v1',
      request_id: 'preview-request-1',
      session_id: 'acp-session-1',
      result: {
        kind: 'url',
        url: 'https://example.com/live',
        title: 'Live page',
        text: 'Visible page text',
        start: 0,
        end: 17,
        total_chars: 17,
      },
    });
    expect(addOrUpdateMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ msg_id: 'preview-request-message-1' })
    );
    unregister();
  });

  it('answers one strict session-bound read_terminal request from the active terminal buffer', async () => {
    previewContextState.activeTabId = 'terminal-tab';
    previewContextState.tabs = [
      {
        id: 'terminal-tab',
        title: 'Terminal',
        content: 'terminal:conv-1',
        content_type: 'terminal',
        isDirty: false,
        originalContent: 'terminal:conv-1',
        metadata: { conversation_id: 'conv-1', title: 'Terminal' },
      },
    ];
    conversationGetInvokeMock.mockResolvedValue({
      id: 'conv-1',
      type: 'acp',
      status: 'running',
      extra: { acp_session_id: 'acp-session-1', backend: 'hermes' },
    });
    const unregister = registerConversationTerminalReader('conv-1', 'terminal-tab', () => ({
      total_lines: 42,
      start: 32,
      end: 42,
      viewport_rows: 10,
      cursor_row: 41,
      text: 'terminal output',
    }));
    renderHook(() => useAcpMessage('conv-1'));
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));
    await waitFor(() => expect(conversationGetInvokeMock).toHaveBeenCalled());

    const request: IResponseMessage = {
      type: 'acp_read_terminal_request',
      data: {
        version: 'command-eve-read-terminal/v1',
        request_id: 'terminal-request-1',
        session_id: 'acp-session-1',
        start: 32,
        count: 10,
      },
      msg_id: 'terminal-request-message-1',
      turn_id: 'turn-terminal-1',
      conversation_id: 'conv-1',
    };
    act(() => {
      responseStreamHandlerRef.current?.(request);
      responseStreamHandlerRef.current?.(request);
      responseStreamHandlerRef.current?.({
        ...request,
        data: { ...(request.data as object), request_id: 'foreign-request', session_id: 'foreign-session' },
      });
    });

    await waitFor(() => expect(respondReadTerminalInvokeMock).toHaveBeenCalledTimes(1));
    expect(respondReadTerminalInvokeMock).toHaveBeenCalledWith({
      conversation_id: 'conv-1',
      version: 'command-eve-read-terminal/v1',
      request_id: 'terminal-request-1',
      session_id: 'acp-session-1',
      result: {
        total_lines: 42,
        start: 32,
        end: 42,
        viewport_rows: 10,
        cursor_row: 41,
        text: 'terminal output',
      },
    });
    expect(addOrUpdateMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ msg_id: 'terminal-request-message-1' })
    );
    unregister();
  });

  it('uses completed standard ACP desktop tool frames for the bound session and turn', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const emitSpy = vi.spyOn(emitter, 'emit');
    renderHook(() => useAcpMessage('conv-1'));
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));

    const sendCompletedTool = (toolCallId: string, title: string, rawInput: Record<string, unknown>) => {
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          session_id: 'acp-session-1',
          update: {
            session_update: 'tool_call_update',
            tool_call_id: toolCallId,
            status: 'completed',
            kind: 'execute',
            title,
            raw_input: rawInput,
          },
        },
        msg_id: toolCallId,
        turn_id: 'turn-desktop-tool-1',
        conversation_id: 'conv-1',
      });
    };

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'acp-session-1' },
        msg_id: 'desktop-start',
        turn_id: 'turn-desktop-tool-1',
        conversation_id: 'conv-1',
      });
      sendCompletedTool('open-tool-1', 'open_preview', { url: 'https://example.com/fallback', label: 'Fallback' });
      sendCompletedTool('focus-tool-1', 'focus_pane', { pane: 'files' });
      // Reconnect replay: neither visible action may run twice.
      sendCompletedTool('open-tool-1', 'open_preview', { url: 'https://example.com/fallback', label: 'Fallback' });
      sendCompletedTool('focus-tool-1', 'focus_pane', { pane: 'files' });
    });

    expect(openPreviewMock).toHaveBeenCalledTimes(1);
    expect(openPreviewMock).toHaveBeenCalledWith('https://example.com/fallback', 'url', {
      title: 'Fallback',
      conversation_id: 'conv-1',
    });
    expect(emitSpy.mock.calls.filter(([event]) => event === 'commandEve.workbench.reveal')).toEqual([
      ['commandEve.workbench.reveal', { conversation_id: 'conv-1', pane: 'files' }],
    ]);
    emitSpy.mockRestore();
  });

  it('rejects a stale same-session desktop event after runtime turn state has cleared', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const emitSpy = vi.spyOn(emitter, 'emit');
    renderHook(() => useAcpMessage('conv-1'));
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));

    const sendInfo = (turn_id: string, url: string) => {
      responseStreamHandlerRef.current?.({
        type: 'acp_session_info',
        data: {
          title: null,
          updated_at: null,
          session_id: 'session-b',
          _meta: {
            commandEveDesktop: {
              version: 'command-eve-desktop-event/v1',
              sessionId: 'session-b',
              event: 'preview.open',
              payload: { url, label: turn_id },
            },
          },
        },
        msg_id: `desktop-${turn_id}`,
        turn_id,
        conversation_id: 'conv-1',
      });
    };

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-b' },
        msg_id: 'start-session-b',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
      // There is no active runtime turn now; the Start-bound turn remains the
      // sole side-effect authority.
      sendInfo('turn-a', 'https://stale-turn.example');
      sendInfo('turn-b', 'https://current-turn.example');
    });

    expect(openPreviewMock).toHaveBeenCalledTimes(1);
    expect(openPreviewMock).toHaveBeenCalledWith('https://current-turn.example', 'url', {
      title: 'turn-b',
      conversation_id: 'conv-1',
    });
    expect(emitSpy.mock.calls.filter(([event]) => event === 'commandEve.workbench.reveal')).toEqual([]);
    emitSpy.mockRestore();
  });

  it('blocks unscoped tool frames before browser, HTML, image, typed-artifact, activity, or transcript effects', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const emitSpy = vi.spyOn(emitter, 'emit');
    const { result } = renderHook(() => {
      useAcpMessage('conv-1');
      return useConversationDelegationActivity('conv-1');
    });
    await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-b' },
        msg_id: 'start-session-b',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'unscoped-open-preview',
            status: 'completed',
            kind: 'execute',
            title: 'open_preview',
            raw_input: { url: 'https://unscoped.example', label: 'Unscoped' },
          },
        },
        msg_id: 'unscoped-tool-frame',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'unscoped-html',
            status: 'in_progress',
            kind: 'edit',
            title: 'write: report.html',
            locations: [{ path: 'report.html' }],
          },
        },
        msg_id: 'unscoped-html-start',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'unscoped-image',
            status: 'completed',
            kind: 'execute',
            title: 'image generation',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: `img_h_${'a'.repeat(64)}` },
              },
            ],
          },
        },
        msg_id: 'unscoped-image-result',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'acp_tool_call',
        data: {
          update: {
            session_update: 'tool_call_update',
            tool_call_id: 'unscoped-typed-ui',
            status: 'completed',
            kind: 'execute',
            title: 'mcp__aionui_eve_artifacts__eve_typed_ui_publish',
            result_display: {
              ok: true,
              artifact_type: 'file',
              mime_type: 'application/vnd.command-eve.typed-ui+json',
            },
          },
        },
        msg_id: 'unscoped-typed-artifact',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'finish',
        data: null,
        msg_id: 'finish-turn-b',
        turn_id: 'turn-b',
        conversation_id: 'conv-1',
      });
    });

    expect(openPreviewMock).not.toHaveBeenCalled();
    expect(launchPreviewMock).not.toHaveBeenCalled();
    expect(imageArtifactBindInvokeMock).not.toHaveBeenCalled();
    expect(emitSpy.mock.calls.filter(([event]) => event === 'commandEve.workbench.reveal')).toEqual([]);
    expect(result.current).toEqual([]);
    expect(addOrUpdateMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ msg_id: 'unscoped-tool-frame' }));
    emitSpy.mockRestore();
  });

  it('hydrates ACP usage after warmup and preserves it through the turn lifecycle', async () => {
    conversationGetInvokeMock.mockResolvedValue({
      id: 'conv-1',
      type: 'acp',
      status: 'finished',
      extra: { backend: 'hermes' },
    });
    conversationGetUsageInvokeMock.mockResolvedValue({ used: 42_000, size: 65_536 });

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => {
      expect(result.current.runtimeActivity.contextUsed).toBe(42_000);
      expect(result.current.runtimeActivity.contextSize).toBe(65_536);
    });

    for (const message of [
      { type: 'start', data: null },
      { type: 'text', data: 'Working' },
      { type: 'finish', data: null },
    ] as const) {
      act(() => {
        responseStreamHandlerRef.current?.({
          ...message,
          msg_id: 'msg-usage',
          conversation_id: 'conv-1',
        });
      });
    }

    expect(result.current.runtimeActivity.contextUsed).toBe(42_000);
    expect(result.current.runtimeActivity.contextSize).toBe(65_536);
  });

  it('1.820.3: the terminal finish emits commandEve.artifacts.refresh scoped to the conversation', async () => {
    conversationGetInvokeMock.mockResolvedValue({
      id: 'conv-1',
      type: 'acp',
      status: 'finished',
      extra: { backend: 'hermes' },
    });
    const emitSpy = vi.spyOn(emitter, 'emit');

    renderHook(() => useAcpMessage('conv-1'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-write' },
        msg_id: 'msg-refresh',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'text',
        data: 'Editing',
        msg_id: 'msg-refresh',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'finish',
        data: null,
        msg_id: 'msg-refresh',
        conversation_id: 'conv-1',
      });
    });

    // The TIMING contract: the artifact refresh fires on the terminal finish
    // (never at send acceptance), scoped to THIS conversation.
    const refreshCalls = emitSpy.mock.calls.filter((call) => call[0] === 'commandEve.artifacts.refresh');
    expect(refreshCalls).toEqual([['commandEve.artifacts.refresh', { conversation_id: 'conv-1' }]]);
    emitSpy.mockRestore();
  });

  it('MAT-1773: stages an in-session skill_suggest report into the shared artifact store', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    renderHook(() => useAcpMessage('conv-1'));
    const store = renderHook(() => useConversationArtifactsById('conv-1'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'skill_suggest',
        data: { cron_job_id: 'job-1', name: 'Wochenbericht', description: 'Erstellt den Wochenbericht' },
        msg_id: 'msg-skill-1',
        conversation_id: 'conv-1',
      });
    });

    await waitFor(() => {
      const staged = store.result.current.find((artifact) => artifact.kind === 'skill_suggest');
      expect(staged?.status).toBe('pending');
      expect((staged?.payload as { name?: string } | undefined)?.name).toBe('Wochenbericht');
    });
    // Still NOT a chat message — the tray renders it from the artifact store.
    expect(addOrUpdateMessageMock).not.toHaveBeenCalled();
  });

  it('MAT-1773: stages a cron_trigger report and never leaks it into another conversation', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    renderHook(() => useAcpMessage('conv-1'));
    const store = renderHook(() => useConversationArtifactsById('conv-1'));
    const otherStore = renderHook(() => useConversationArtifactsById('conv-2'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'cron_trigger',
        data: { cron_job_id: 'job-9', cron_job_name: 'Tagessync', triggered_at: 123 },
        msg_id: 'msg-cron-1',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.({
        type: 'skill_suggest',
        data: { cron_job_id: 'job-2', name: 'Fremder Skill', description: 'Gehört woanders hin' },
        msg_id: 'msg-skill-2',
        conversation_id: 'conv-2',
      });
    });

    await waitFor(() => {
      const staged = store.result.current.find((artifact) => artifact.kind === 'cron_trigger');
      expect(staged?.status).toBe('active');
      expect((staged?.payload as { cron_job_name?: string } | undefined)?.cron_job_name).toBe('Tagessync');
    });
    expect(otherStore.result.current.find((artifact) => artifact.kind === 'skill_suggest')).toBeUndefined();
    expect(store.result.current.find((artifact) => artifact.kind === 'skill_suggest')).toBeUndefined();
  });

  it('1.820.4: cancels and stages one qualifying blocked external write exactly once across replay', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const emitSpy = vi.spyOn(emitter, 'emit');
    const { result } = renderHook(() => useAcpMessage('conv-1'));
    await waitFor(() => expect(result.current.hasHydratedRunningState).toBe(true));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-write' },
        msg_id: 'message-write-call-1',
        turn_id: 'turn-write-recovery',
        conversation_id: 'conv-1',
      });
      localSendStarted('conv-1');
      localSendAccepted('conv-1', 'turn-write-recovery', {
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        pending_confirmations: 0,
        turn_id: 'turn-write-recovery',
      });
      responseStreamHandlerRef.current?.(makeExternalWriteFailure());
      responseStreamHandlerRef.current?.(makeExternalWriteFailure());
    });

    await waitFor(() => expect(reportStageWorkspaceInvokeMock).toHaveBeenCalledTimes(1));
    expect(conversationStopInvokeMock).toHaveBeenCalledTimes(1);
    expect(conversationStopInvokeMock).toHaveBeenCalledWith({
      conversation_id: 'conv-1',
      turn_id: 'turn-write-recovery',
    });
    expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);
    expect(addOrUpdateMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'acp_tool_call',
        content: expect.objectContaining({
          update: expect.objectContaining({ status: 'failed', tool_call_id: 'write-call-1' }),
        }),
      })
    );
    expect(reportStageWorkspaceInvokeMock).toHaveBeenCalledWith({
      conversation_id: 'conv-1',
      turn_id: 'turn-write-recovery',
      tool_call_id: 'write-call-1',
      markdown: '# Quarterly report\n\nRecovered body.',
      suggested_name: 'Quarterly Report.pdf',
    });
    const stageRequest = reportStageWorkspaceInvokeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(stageRequest).not.toHaveProperty('workspace');
    expect(stageRequest).not.toHaveProperty('path');
    expect(result.current.running).toBe(false);
    expect(result.current.aiProcessing).toBe(false);

    const previewCalls = emitSpy.mock.calls.filter((call) => call[0] === 'preview.open');
    expect(previewCalls).toEqual([
      [
        'preview.open',
        {
          content: '# Quarterly report\n\nRecovered body.',
          contentType: 'markdown',
          metadata: {
            title: 'quarterly-report',
            file_name: 'quarterly-report.md',
            conversation_id: 'conv-1',
          },
        },
      ],
    ]);
    emitSpy.mockRestore();
  });

  it('1.820.4: keeps the failed card but performs no uncancellable stage when the active turn is missing', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const { result } = renderHook(() => useAcpMessage('conv-1'));
    await waitFor(() => expect(result.current.hasHydratedRunningState).toBe(true));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-write' },
        msg_id: 'message-write-call-1',
        turn_id: 'turn-write-recovery',
        conversation_id: 'conv-1',
      });
      responseStreamHandlerRef.current?.(makeExternalWriteFailure());
    });

    expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);
    expect(conversationStopInvokeMock).not.toHaveBeenCalled();
    expect(reportStageWorkspaceInvokeMock).not.toHaveBeenCalled();
    // No matching runtime identity means the recovery lane must not mutate
    // turn state either; the ordinary start remains visible/running.
    expect(result.current.running).toBe(true);
  });

  it('1.820.4: a stale replay cannot cancel the current turn or stage old report bytes', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const { result } = renderHook(() => useAcpMessage('conv-1'));
    await waitFor(() => expect(result.current.hasHydratedRunningState).toBe(true));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: { session_id: 'session-write' },
        msg_id: 'message-current-turn',
        turn_id: 'turn-current',
        conversation_id: 'conv-1',
      });
      localSendStarted('conv-1');
      localSendAccepted('conv-1', 'turn-current', {
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        pending_confirmations: 0,
        turn_id: 'turn-current',
      });
      responseStreamHandlerRef.current?.(makeExternalWriteFailure({}, 'turn-old'));
    });

    expect(conversationStopInvokeMock).not.toHaveBeenCalled();
    expect(reportStageWorkspaceInvokeMock).not.toHaveBeenCalled();
    expect(result.current.running).toBe(true);
  });

  describe('ACP stream watchdog', () => {
    it('classifies stale buffered renderer work as ui_backlog', () => {
      expect(
        classifyAcpStreamWatchdog({
          now: 10_000,
          lastBackendEventAt: 9_900,
          lastRendererCommitAt: 1_000,
          pendingBufferedEvents: 1,
        })
      ).toBe('ui_backlog');
    });

    it('does not classify a first buffered event as backlog before a baseline exists', () => {
      expect(
        classifyAcpStreamWatchdog({
          now: 10_000,
          lastBackendEventAt: 9_900,
          pendingBufferedEvents: 1,
        })
      ).toBe('streaming');
    });

    it('uses the newer pending-buffer baseline instead of an old renderer commit', () => {
      expect(
        classifyAcpStreamWatchdog({
          now: 10_000,
          lastBackendEventAt: 9_900,
          lastRendererCommitAt: 1_000,
          pendingBufferedSinceAt: 9_900,
          pendingBufferedEvents: 1,
        })
      ).toBe('streaming');
    });

    it('classifies active tools before heartbeat-only streams', () => {
      expect(
        classifyAcpStreamWatchdog({
          now: 10_000,
          lastBackendEventAt: 1_000,
          lastRendererCommitAt: 1_000,
          pendingBufferedEvents: 0,
          activeToolName: 'Write file',
        })
      ).toBe('tool_wait');
    });

    it('distinguishes recent backend activity from heartbeat-only silence', () => {
      expect(
        classifyAcpStreamWatchdog({
          now: 10_000,
          lastBackendEventAt: 9_000,
          lastRendererCommitAt: 8_500,
          pendingBufferedEvents: 0,
        })
      ).toBe('streaming');

      expect(
        classifyAcpStreamWatchdog({
          now: 10_000,
          lastBackendEventAt: 4_000,
          lastRendererCommitAt: 4_000,
          pendingBufferedEvents: 0,
        })
      ).toBe('heartbeat_only');
    });

    it('surfaces heartbeat-only activity while a turn is still running', async () => {
      conversationGetInvokeMock.mockResolvedValue(null);
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useAcpMessage('conv-1'));

        await act(async () => {
          await Promise.resolve();
        });

        act(() => {
          responseStreamHandlerRef.current?.({
            type: 'start',
            data: null,
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
          });
        });

        act(() => {
          vi.advanceTimersByTime(6_000);
        });

        expect(result.current.runtimeActivity.phase).toBe('heartbeat_only');
      } finally {
        vi.useRealTimers();
      }
    });

    it('recovers from heartbeat-only to streaming when backend thinking resumes', async () => {
      conversationGetInvokeMock.mockResolvedValue(null);
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useAcpMessage('conv-1'));

        await act(async () => {
          await Promise.resolve();
        });

        act(() => {
          responseStreamHandlerRef.current?.({
            type: 'start',
            data: null,
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
          });
          vi.advanceTimersByTime(6_000);
        });
        expect(result.current.runtimeActivity.phase).toBe('heartbeat_only');

        act(() => {
          responseStreamHandlerRef.current?.({
            type: 'thinking',
            data: {
              content: 'still working',
              status: 'thinking',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
          });
          vi.advanceTimersByTime(1_000);
        });

        expect(result.current.runtimeActivity.phase).toBe('streaming');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not overwrite a specific thinking phase with generic streaming ticks', async () => {
      conversationGetInvokeMock.mockResolvedValue(null);
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useAcpMessage('conv-1'));

        await act(async () => {
          await Promise.resolve();
        });

        act(() => {
          responseStreamHandlerRef.current?.({
            type: 'request_trace',
            data: {
              timestamp: Date.now(),
              backend: 'hermes',
              model_id: 'model-1',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
          });
          responseStreamHandlerRef.current?.({
            type: 'thinking',
            data: {
              content: 'planning',
              status: 'thinking',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
          });
        });

        expect(result.current.runtimeActivity.phase).toBe('thinking');

        act(() => {
          vi.advanceTimersByTime(1_000);
        });

        expect(result.current.runtimeActivity.phase).toBe('thinking');
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps tool_wait active until all concurrent ACP tools finish', async () => {
      conversationGetInvokeMock.mockResolvedValue(null);
      const { result } = renderHook(() => useAcpMessage('conv-1'));

      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        responseStreamHandlerRef.current?.({
          type: 'start',
          data: { session_id: 'session-tools' },
          msg_id: 'start-session-tools',
          turn_id: 'turn-tools',
          conversation_id: 'conv-1',
        });
        responseStreamHandlerRef.current?.({
          type: 'acp_tool_call',
          data: {
            session_id: 'session-tools',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool-a',
              status: 'in_progress',
              title: 'Tool A',
              kind: 'execute',
            },
          },
          msg_id: 'msg-1',
          conversation_id: 'conv-1',
        });
        responseStreamHandlerRef.current?.({
          type: 'acp_tool_call',
          data: {
            session_id: 'session-tools',
            update: {
              sessionUpdate: 'tool_call',
              tool_call_id: 'tool-b',
              status: 'in_progress',
              title: 'Tool B',
              kind: 'execute',
            },
          },
          msg_id: 'msg-1',
          conversation_id: 'conv-1',
        });
      });

      expect(result.current.runtimeActivity.phase).toBe('tool_wait');
      expect(result.current.runtimeActivity.detail).toBe('Tool A');

      act(() => {
        responseStreamHandlerRef.current?.({
          type: 'acp_tool_call',
          data: {
            session_id: 'session-tools',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-a',
              status: 'completed',
              title: 'Tool A',
              kind: 'execute',
            },
          },
          msg_id: 'msg-1',
          conversation_id: 'conv-1',
        });
      });

      expect(result.current.runtimeActivity.phase).toBe('tool_wait');
      expect(result.current.runtimeActivity.detail).toBe('Tool B');

      act(() => {
        responseStreamHandlerRef.current?.({
          type: 'acp_tool_call',
          data: {
            session_id: 'session-tools',
            update: {
              session_update: 'tool_call_update',
              tool_call_id: 'tool-b',
              status: 'completed',
              title: 'Tool B',
              kind: 'execute',
            },
          },
          msg_id: 'msg-1',
          conversation_id: 'conv-1',
        });
      });

      expect(result.current.runtimeActivity.phase).toBe('streaming');
      expect(result.current.runtimeActivity.detail).toBeUndefined();
    });
  });

  it('completes hydration when the conversation lookup fails', async () => {
    conversationGetInvokeMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => {
      expect(result.current.hasHydratedRunningState).toBe(true);
    });

    expect(result.current.running).toBe(false);
    expect(result.current.aiProcessing).toBe(false);
  });

  it('clears a stuck composer when durable runtime recovery observes completion', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => expect(result.current.hasHydratedRunningState).toBe(true));
    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: null,
        msg_id: 'msg-1',
        conversation_id: 'conv-1',
      });
    });
    expect(result.current.running).toBe(true);

    act(() => {
      emitter.emit('conversation.runtime.recovered', {
        conversation_id: 'conv-1',
        recoveredTurnId: 'turn-1',
        runtime: {
          state: 'idle',
          can_send_message: true,
          has_task: false,
          task_status: 'finished',
          is_processing: false,
          pending_confirmations: 0,
          turn_id: null,
        },
      });
    });

    expect(result.current.running).toBe(false);
    expect(result.current.aiProcessing).toBe(false);
    expect(result.current.runtimeActivity.phase).toBe('idle');
  });

  it('does not let an older recovered turn clear a newer active composer run', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);
    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => expect(result.current.hasHydratedRunningState).toBe(true));
    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: null,
        msg_id: 'msg-new',
        conversation_id: 'conv-1',
      });
      localSendStarted('conv-1');
      localSendAccepted('conv-1', 'turn-new', {
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        pending_confirmations: 0,
        turn_id: 'turn-new',
      });
    });
    expect(result.current.running).toBe(true);

    act(() => {
      emitter.emit('conversation.runtime.recovered', {
        conversation_id: 'conv-1',
        recoveredTurnId: 'turn-old',
        runtime: {
          state: 'idle',
          can_send_message: true,
          has_task: false,
          task_status: 'finished',
          is_processing: false,
          pending_confirmations: 0,
          turn_id: null,
        },
      });
    });

    expect(result.current.running).toBe(true);
    expect(result.current.runtimeActivity.phase).not.toBe('idle');
  });

  it('emits a synthetic thinking done update on finish when the stream never sends one', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    const now = Date.now();
    renderHook(() => useAcpMessage('conv-1'));

    expect(responseStreamHandlerRef.current).toBeTypeOf('function');

    responseStreamHandlerRef.current?.({
      type: 'request_trace',
      data: {
        timestamp: now - 4200,
        backend: 'claude',
        model_id: 'model-1',
      },
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
    });

    responseStreamHandlerRef.current?.({
      type: 'thinking',
      data: {
        content: 'alpha',
        status: 'thinking',
      },
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
    });

    responseStreamHandlerRef.current?.({
      type: 'finish',
      data: null,
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
    });

    expect(addOrUpdateMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'thinking',
        msg_id: 'msg-1',
        conversation_id: 'conv-1',
        content: expect.objectContaining({
          status: 'done',
          duration: expect.any(Number),
        }),
      })
    );
  });

  it('completes thinking as soon as the first non-thinking message arrives', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    renderHook(() => useAcpMessage('conv-1'));

    responseStreamHandlerRef.current?.({
      type: 'thinking',
      data: {
        content: 'alpha',
        status: 'thinking',
      },
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
      created_at: 1_000,
    });

    responseStreamHandlerRef.current?.({
      type: 'text',
      data: 'beta',
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
      created_at: 4_200,
    });

    expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'thinking',
        msg_id: 'msg-1',
        content: expect.objectContaining({
          status: 'thinking',
        }),
      })
    );
    expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'thinking',
        msg_id: 'msg-1',
        content: expect.objectContaining({
          status: 'done',
          duration: 3200,
        }),
      })
    );
    expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        type: 'text',
        msg_id: 'msg-1',
      })
    );
  });

  it('throttles active thinking stream updates so inference start cannot flood the transcript', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => {
      expect(result.current.hasHydratedRunningState).toBe(true);
    });

    vi.useFakeTimers();
    try {
      act(() => {
        for (let i = 0; i < 20; i += 1) {
          responseStreamHandlerRef.current?.({
            type: 'thinking',
            data: {
              content: `chunk-${i} `,
              status: 'thinking',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
            created_at: 1_000 + i,
          });
        }
      });

      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(49);
      });
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(2);
      expect(addOrUpdateMessageMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            content: 'chunk-0 ',
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            content: Array.from({ length: 19 }, (_, index) => `chunk-${index + 1} `).join(''),
          }),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes pending thinking before the synthetic done update when final content arrives', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => {
      expect(result.current.hasHydratedRunningState).toBe(true);
    });

    vi.useFakeTimers();
    try {
      act(() => {
        for (let i = 0; i < 3; i += 1) {
          responseStreamHandlerRef.current?.({
            type: 'thinking',
            data: {
              content: `chunk-${i} `,
              status: 'thinking',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
            created_at: 1_000 + i,
          });
        }
      });

      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);

      act(() => {
        responseStreamHandlerRef.current?.({
          type: 'text',
          data: 'final',
          msg_id: 'msg-1',
          conversation_id: 'conv-1',
          created_at: 2_000,
        });
      });

      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            content: 'chunk-1 chunk-2 ',
            status: 'thinking',
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            status: 'done',
            duration: 1000,
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          type: 'text',
          msg_id: 'msg-1',
        })
      );

      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes pending thinking before an error message', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => {
      expect(result.current.hasHydratedRunningState).toBe(true);
    });

    vi.useFakeTimers();
    try {
      act(() => {
        for (let i = 0; i < 3; i += 1) {
          responseStreamHandlerRef.current?.({
            type: 'thinking',
            data: {
              content: `chunk-${i} `,
              status: 'thinking',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
            created_at: 1_000 + i,
          });
        }
      });

      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);

      act(() => {
        responseStreamHandlerRef.current?.({
          type: 'error',
          data: 'boom',
          msg_id: 'msg-1',
          conversation_id: 'conv-1',
          created_at: 2_000,
        });
      });

      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            content: 'chunk-1 chunk-2 ',
            status: 'thinking',
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            status: 'done',
            duration: 1000,
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          type: 'tips',
          msg_id: 'msg-1',
        })
      );

      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes pending thinking before starting a new thinking message id', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => {
      expect(result.current.hasHydratedRunningState).toBe(true);
    });

    vi.useFakeTimers();
    try {
      act(() => {
        for (let i = 0; i < 3; i += 1) {
          responseStreamHandlerRef.current?.({
            type: 'thinking',
            data: {
              content: `chunk-${i} `,
              status: 'thinking',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
            created_at: 1_000 + i,
          });
        }

        responseStreamHandlerRef.current?.({
          type: 'thinking',
          data: {
            content: 'next-0 ',
            status: 'thinking',
          },
          msg_id: 'msg-2',
          conversation_id: 'conv-1',
          created_at: 2_000,
        });
      });

      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            content: 'chunk-0 ',
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            content: 'chunk-1 chunk-2 ',
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-2',
          content: expect.objectContaining({
            content: 'next-0 ',
          }),
        })
      );

      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves slash-command metadata from available_commands stream updates', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'available_commands',
        data: {
          commands: [
            {
              name: 'review',
              description: 'Review the current diff',
              input: {
                hint: '⌘R',
              },
              _meta: {
                completion_behavior: 'neutral_tip_on_empty',
                empty_turn_tip_code: 'acp.empty_turn.choose_command',
                empty_turn_tip_params: {
                  command_count: 1,
                },
              },
            },
          ],
        },
        msg_id: 'cmd-1',
        conversation_id: 'conv-1',
      });
    });

    await waitFor(() => {
      expect(result.current.slashCommands).toEqual([
        {
          name: 'review',
          description: 'Review the current diff',
          hint: '⌘R',
          kind: 'template',
          source: 'acp',
          selectionBehavior: 'insert',
          completionBehavior: 'neutral_tip_on_empty',
          emptyTurnTipCode: 'acp.empty_turn.choose_command',
          emptyTurnTipParams: {
            command_count: 1,
          },
        },
      ]);
    });
  });

  describe('EVE permission acknowledgement seeding', () => {
    it('keeps first-delivery escalations gated even after backend request trace confirms plain dont_ask', async () => {
      conversationGetInvokeMock.mockResolvedValue({
        type: 'acp',
        status: 'idle',
        extra: { backend: 'hermes', session_mode: 'dont_ask' },
      });
      const { result } = renderHook(() => useAcpMessage('conv-1'));

      await waitFor(() => expect(result.current.hasHydratedRunningState).toBe(true));

      act(() => emitPermission('call-before-ack'));
      expect(confirmMessageInvokeMock).not.toHaveBeenCalled();
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);

      act(() => {
        responseStreamHandlerRef.current?.({
          type: 'request_trace',
          data: {
            backend: 'hermes',
            model_id: 'eve-local',
            session_mode: 'dont_ask',
          },
          msg_id: 'trace-1',
          conversation_id: 'conv-1',
        });
        emitPermission('call-after-ack');
      });

      expect(confirmMessageInvokeMock).not.toHaveBeenCalled();
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(2);
    });

    it('keeps a stale renderer HG3.5 publish gated', async () => {
      conversationGetInvokeMock.mockResolvedValue({
        type: 'acp',
        status: 'idle',
        extra: { backend: 'hermes', session_mode: 'default' },
      });
      const { result } = renderHook(() => useAcpMessage('conv-1'));

      await waitFor(() => expect(result.current.hasHydratedRunningState).toBe(true));
      act(() => {
        emitter.emit('acp.permission.mode', {
          conversation_id: 'conv-1',
          mode: COMMAND_EVE_HG4_DELEGATED_MODE,
        });
        emitPermission('call-selector-ack');
      });

      expect(confirmMessageInvokeMock).not.toHaveBeenCalled();
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);
    });

    it('does not let a child passive legacy grant widen authority during initial mount', async () => {
      conversationGetInvokeMock.mockResolvedValue({
        type: 'acp',
        status: 'idle',
        extra: { backend: 'hermes', session_mode: 'dont_ask' },
      });

      render(createElement(PermissionMountHarness));
      await waitFor(() => expect(responseStreamHandlerRef.current).toBeTypeOf('function'));
      act(() => emitPermission('call-restored-on-mount'));

      expect(confirmMessageInvokeMock).not.toHaveBeenCalled();
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);
    });

    it('does not let a stale backend trace widen authority after immediate local revocation', async () => {
      conversationGetInvokeMock.mockResolvedValue({
        type: 'acp',
        status: 'idle',
        extra: { backend: 'hermes', session_mode: 'dont_ask' },
      });
      const { result } = renderHook(() => useAcpMessage('conv-1'));

      await waitFor(() => expect(result.current.hasHydratedRunningState).toBe(true));
      act(() => {
        emitter.emit('acp.permission.mode', {
          conversation_id: 'conv-1',
          mode: COMMAND_EVE_HG4_DELEGATED_MODE,
        });
        emitter.emit('acp.permission.mode', { conversation_id: 'conv-1', mode: 'default' });
        responseStreamHandlerRef.current?.({
          type: 'request_trace',
          data: { backend: 'hermes', model_id: 'eve-local', session_mode: 'dont_ask' },
          msg_id: 'trace-after-revoke',
          conversation_id: 'conv-1',
        });
        emitPermission('call-after-revoke');
      });

      expect(confirmMessageInvokeMock).not.toHaveBeenCalled();
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('M-quotawall-suppress — the cold error bubble yields to a recognized warm wall', () => {
    const emitError = (): void => {
      // A turn must be in-flight so the wall would actually surface (both walls
      // idle-suppress on jobInFlight). A non-terminal message before the error sets
      // running=true → jobWasInFlight=true.
      responseStreamHandlerRef.current?.({ type: 'text', data: 'partial', msg_id: 'm-1', conversation_id: 'conv-1' });
      responseStreamHandlerRef.current?.({
        type: 'error',
        data: { code: 'eve_daily_cap' },
        msg_id: 'm-1',
        conversation_id: 'conv-1',
      });
    };

    it('suppresses the cold error message when a quota/cap signal is recognized AND a turn was in-flight', async () => {
      conversationGetInvokeMock.mockResolvedValue(null);
      reportInferenceErrorMock.mockReturnValue(true); // wall takes over
      renderHook(() => useAcpMessage('conv-1'));
      expect(responseStreamHandlerRef.current).toBeTypeOf('function');

      act(() => emitError());

      expect(reportInferenceErrorMock).toHaveBeenCalledWith({ code: 'eve_daily_cap' }, { jobInFlight: true });
      // Only the in-flight 'text' message reached the transcript; the error did NOT add
      // a second (cold) bubble — the warm wall owns the surface.
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);
    });

    it('STILL renders the cold error bubble when NO quota/cap signal is recognized (never swallow a real error)', async () => {
      conversationGetInvokeMock.mockResolvedValue(null);
      reportInferenceErrorMock.mockReturnValue(false); // ordinary error
      renderHook(() => useAcpMessage('conv-1'));

      act(() => emitError());

      // Both the 'text' message AND the error bubble reached the transcript.
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(2);
    });
  });
});
