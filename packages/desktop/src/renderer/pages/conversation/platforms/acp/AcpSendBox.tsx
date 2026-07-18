import { ipcBridge } from '@/common';
import type { IConversationMcpStatus } from '@/common/config/storage';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { isSideQuestionSupported } from '@/common/chat/sideQuestion';
import { parseError, uuid } from '@/common/utils';
import AgentModeSelector from '@/renderer/components/agent/AgentModeSelector';
import AcpModelSelector from '@/renderer/components/agent/AcpModelSelector';
import EveInferencePicker from '@/renderer/components/agent/EveInferencePicker';
import ContextUsageIndicator from '@/renderer/components/agent/ContextUsageIndicator';
import UnifiedSendBar from '@/renderer/components/chat/UnifiedSendBar';
import { WorkspaceContextControl } from '@/renderer/components/workspace';
import SpeechInputButton, { type SpeechInputButtonHandle } from '@/renderer/components/chat/SpeechInputButton';
import { appendSpeechTranscript, type SpeechInputStatus } from '@/renderer/hooks/system/useSpeechInput';
import CommandQueuePanel from '@/renderer/components/chat/CommandQueuePanel';
import MobileActionSheet, {
  type MobileActionSheetEntry,
  type MobileActionSheetOption,
  useAttachEntry,
} from '@/renderer/components/chat/MobileActionSheet';
import SendBox from '@/renderer/components/chat/SendBox';
import ThoughtDisplay from '@/renderer/components/chat/ThoughtDisplay';
import FileAttachButton from '@/renderer/components/media/FileAttachButton';
import FilePreview from '@/renderer/components/media/FilePreview';
import HorizontalFileList from '@/renderer/components/media/HorizontalFileList';
import { useAcpModelInfo } from '@/renderer/hooks/agent/useAcpModelInfo';
import { useAgentModesForBackend } from '@/renderer/hooks/agent/useAgentModesForBackend';
import {
  boundCommandEveModeMenu,
  commandEveBackendMode,
  COMMAND_EVE_HG4_DELEGATED_MODE,
  createModeLabelFormatter,
  hasActiveEveHg4Delegation,
  isCommandEveModeExpansion,
  persistEvePermissionAuthority,
} from '@/renderer/utils/model/agentModes';
import { useEveInferenceSelection } from '@/renderer/hooks/agent/useEveInferenceSelection';
import { isEveInferenceSelection } from '@/common/config/eveInferenceCore';
import { isCommandEveAcpConversation } from '@/common/config/commandEveShell';
import {
  markConversationGenerating,
  clearConversationGenerating,
} from '@renderer/services/commandEveGenerationActivity';
import { savePreferredMode } from '@/renderer/pages/guid/hooks/agentSelectionUtils';
import { useAutoTitle } from '@/renderer/hooks/chat/useAutoTitle';
import { getSendBoxDraftHook, type FileOrFolderItem } from '@/renderer/hooks/chat/useSendBoxDraft';
import { createSetUploadFile, useSendBoxFiles } from '@/renderer/hooks/chat/useSendBoxFiles';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { useOpenFileSelector } from '@/renderer/hooks/file/useOpenFileSelector';
import { useLatestRef } from '@/renderer/hooks/ui/useLatestRef';
import { useAddOrUpdateMessage } from '@/renderer/pages/conversation/Messages/hooks';
import {
  buildConversationBusyControlCommand,
  shouldEnqueueConversationCommand,
  useConversationCommandQueue,
  type ConversationBusyControlMode,
  type ConversationCommandQueueItem,
} from '@/renderer/pages/conversation/platforms/useConversationCommandQueue';
import ConversationBusyModeControl from '@/renderer/pages/conversation/platforms/ConversationBusyModeControl';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import {
  markConversationDocumentPreparationSettled,
  markConversationDocumentPreparationStarted,
} from '@/renderer/pages/conversation/runtime/conversationDocumentPreparationStore';
import { getConversationRuntimeWorkspaceErrorMessage } from '@/renderer/pages/conversation/utils/conversationCreateError';
import { warmupConversation } from '@/renderer/pages/conversation/utils/warmupConversation';
import { useTeamPermission } from '@/renderer/pages/team/hooks/TeamPermissionContext';
import { allSupportedExts } from '@/renderer/services/FileService';
import { iconColors } from '@/renderer/styles/colors';
import { emitter, useAddEventListener } from '@/renderer/utils/emitter';
import { mergeFileSelectionItems } from '@/renderer/utils/file/fileSelection';
import { buildDisplayMessage } from '@/renderer/utils/file/messageFiles';
import { isCommandEvePdfPath, mergeCommandEvePreparedPdfFiles } from '@/common/config/evePdfIntelligenceCore';
import { Message, Modal, Tag } from '@arco-design/web-react';
import { Brain, EditOne, MagicHat, Shield, Time } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildSendFailureError } from './buildSendFailureError';
import AcpDocumentPreparationStatus, { type AcpDocumentPreparationState } from './AcpDocumentPreparationStatus';
import { useAcpInitialMessage } from './useAcpInitialMessage';
import type { UseAcpMessageReturn } from './useAcpMessage';
import VideoCostWall from '@/renderer/components/billing/VideoCostWall';
import { useVideoCostWall } from '@/renderer/hooks/useVideoCostWall';
import { isVideoLaneRequest, buildResolvedVideoMessage, VIDEO_LANE_AGENT_ID } from '@/common/config/videoCostCore';
import { addressesVideoMarketer } from '@/common/config/eveTeamRoster';

const useAcpSendBoxDraft = getSendBoxDraftHook('acp', {
  _type: 'acp',
  atPath: [],
  content: '',
  uploadFile: [],
});

const EMPTY_AT_PATH: Array<string | FileOrFolderItem> = [];
const EMPTY_UPLOAD_FILES: string[] = [];

const useSendBoxDraft = (conversation_id: string) => {
  const { data, mutate } = useAcpSendBoxDraft(conversation_id);
  const atPath = data?.atPath ?? EMPTY_AT_PATH;
  const uploadFile = data?.uploadFile ?? EMPTY_UPLOAD_FILES;
  const content = data?.content ?? '';

  const setAtPath = useCallback(
    (nextAtPath: Array<string | FileOrFolderItem>) => {
      mutate((prev) => ({ ...prev, atPath: nextAtPath }));
    },
    [data, mutate]
  );

  const setUploadFile = createSetUploadFile(mutate, data);

  const setContent = useCallback(
    (nextContent: string) => {
      mutate((prev) => ({ ...prev, content: nextContent }));
    },
    [data, mutate]
  );

  return {
    atPath,
    uploadFile,
    setAtPath,
    setUploadFile,
    content,
    setContent,
  };
};

const AcpSendBox: React.FC<{
  conversation_id: string;
  backend: string;
  session_mode?: string;
  agent_name?: string;
  workspacePath?: string;
  messageState: UseAcpMessageReturn;
}> = ({ conversation_id, backend, session_mode, agent_name, workspacePath, messageState }) => {
  const {
    aiProcessing,
    setAiProcessing,
    resetState,
    hasThinkingMessage,
    slashCommands,
    fetchSlashCommands,
    tokenUsage,
    context_limit,
    runtimeActivity,
  } = messageState;
  const { t, i18n } = useTranslation();
  const teamPermission = useTeamPermission();
  // In team mode, all agents show the permission mode selector (members don't propagate)
  const showModeSelector = true;
  const isLeaderInTeam = teamPermission && conversation_id === teamPermission.leaderConversationId;
  const { checkAndUpdateTitle } = useAutoTitle();
  const { atPath, uploadFile, setAtPath, setUploadFile, content, setContent } = useSendBoxDraft(conversation_id);
  const speechInputRef = useRef<SpeechInputButtonHandle | null>(null);
  const [speechInputStatus, setSpeechInputStatus] = useState<SpeechInputStatus>('idle');
  const layout = useLayoutContext();
  const isMobile = Boolean(layout?.isMobile);
  const conversationContext = useConversationContextSafe();
  const loadedSkills = conversationContext?.loadedSkills ?? [];
  const loadedMcpStatuses =
    conversationContext?.loadedMcpStatuses ??
    (conversationContext?.loadedMcpServers ?? []).map<IConversationMcpStatus>((name) => ({
      id: name,
      name,
      status: 'loaded',
    }));
  const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);
  const [currentMode, setCurrentMode] = useState<string | undefined>(session_mode);
  const [busySendMode, setBusySendMode] = useState<ConversationBusyControlMode>('queue');
  const [documentPreparation, setDocumentPreparation] = useState<AcpDocumentPreparationState | null>(null);
  const documentPreparationInFlightRef = useRef(false);
  const promotingQueuedCommandIdsRef = useRef(new Set<string>());
  const [promotingQueuedCommandIds, setPromotingQueuedCommandIds] = useState<ReadonlySet<string>>(() => new Set());
  const prepareRuntimeSync = useCallback(async () => {
    if (teamPermission) {
      await teamPermission.warmupSession();
    }
    await warmupConversation(conversation_id);
  }, [conversation_id, teamPermission]);

  // Drive the mobile sheet's model entry off the same source AcpModelSelector uses
  const {
    model_info,
    canSwitch: canSwitchModel,
    selectModel,
  } = useAcpModelInfo({
    conversation_id,
    backend,
    prepareRuntime: prepareRuntimeSync,
    enabled: isMobile,
    onSelectModelSuccess: () => Message.success(t('agent.model.switchSuccess')),
    onSelectModelFailed: () => Message.error(t('agent.model.switchFailed')),
  });
  const availableAgentModes = useAgentModesForBackend(backend);
  const isEveConversation = isCommandEveAcpConversation(backend);
  const availablePermissionModes = useMemo(
    () => (isEveConversation ? boundCommandEveModeMenu(availableAgentModes, true) : availableAgentModes),
    [availableAgentModes, isEveConversation]
  );

  // EVE-aware permission-mode label formatter. For the Hermes/EVE backend it
  // maps the three honest modes to the clean EVE labels (Standard / Änderungen
  // übernehmen / YOLO) via agentMode.eve.*; for every other backend it keeps the
  // prior generic agentMode.<value> mapping untouched. Shared by the in-chat
  // pill and the mobile action sheet so both surfaces stay in lockstep.
  const formatModeLabel = useMemo(() => createModeLabelFormatter(backend, t), [backend, t]);

  // Command EVE (Hermes) conversations swap the raw ACP model row for the EVE
  // Inference tier picker (Standard/High/Max + Private). Same persistence key as
  // the desktop header + GuidPage picker, so a switch made in the sheet takes
  // effect on the next turn (the send shim re-reads the live selection).
  const eveInference = useEveInferenceSelection();

  // Model id handed to the context indicator/popover. On an EVE conversation the
  // runtime `request_trace.model_id` carries Hermes' LOCAL config model (one
  // managed Ollama config, reported on cloud turns too), so it reads as a local
  // 64k model — that is exactly why the cloud Max popover showed "55K / 65.5K"
  // instead of the model's real ~1M window: the resolver could not tell the turn
  // was a CLOUD turn from that local-looking id. When an EVE Inference (cloud)
  // tier is the active selection, use that cloud SELECTION id (e.g.
  // "command-eve-inference:eve-max") so the window resolver applies EVE's 256k
  // operating policy. Bearer availability is enforced fail-closed by the send
  // boundary; its asynchronous UI check must not transiently re-label a cloud
  // turn as the local 64k lane. A LOCAL selection keeps the live runtime model
  // id whose 64k is the real hardware-safe window.
  const cloudSelectionActive = isEveConversation && isEveInferenceSelection(eveInference.selection);
  const indicatorModelId = cloudSelectionActive ? eveInference.selection : runtimeActivity.modelId;

  // Mirror AgentModeSelector's getMode sync so the sheet shows the live mode label.
  useEffect(() => {
    if (!isMobile || !isMobileSheetOpen) return;
    if (!conversation_id) return;
    let cancelled = false;
    void prepareRuntimeSync()
      .then(() => ipcBridge.acpConversation.getMode.invoke({ conversation_id }))
      .then((result) => {
        if (cancelled || !result) return;
        if (result.initialized !== false) {
          setCurrentMode(
            isEveConversation && result.mode === 'dont_ask' && hasActiveEveHg4Delegation(backend, conversation_id)
              ? COMMAND_EVE_HG4_DELEGATED_MODE
              : result.mode
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [backend, conversation_id, isEveConversation, isMobile, isMobileSheetOpen, prepareRuntimeSync]);

  const handleSheetModeChange = useCallback(
    async (mode: string) => {
      if (mode === currentMode) return;
      const previousMode = currentMode ?? 'default';

      if (isEveConversation) {
        const requestedBackendMode = commandEveBackendMode(mode);
        const isExpansion = isCommandEveModeExpansion(previousMode, mode);
        const hg4Delegated = mode === COMMAND_EVE_HG4_DELEGATED_MODE;
        let restrictionPersistenceFailed = false;

        if (!isExpansion) {
          setCurrentMode(mode);
          emitter.emit('acp.permission.mode', { conversation_id, mode });
          try {
            await persistEvePermissionAuthority({
              backend,
              conversationId: conversation_id,
              preferredMode: requestedBackendMode,
              hg4Delegated: false,
            });
          } catch (error) {
            restrictionPersistenceFailed = true;
            console.error('[AcpSendBox] Failed to persist mobile EVE revocation:', error);
            Message.warning(
              t('agentMode.eve.revocationPersistFailed', {
                defaultValue: 'Restriction is active locally, but its audit record could not be persisted.',
              })
            );
          }
        }

        try {
          await prepareRuntimeSync();
          const confirmed = await ipcBridge.acpConversation.setMode.invoke({
            conversation_id,
            mode: requestedBackendMode,
          });
          const confirmedMode = confirmed.mode || requestedBackendMode;
          if (confirmedMode !== requestedBackendMode) {
            if (isExpansion) {
              setCurrentMode(confirmedMode);
              emitter.emit('acp.permission.mode', { conversation_id, mode: confirmedMode });
            }
            Message.error(t('agentMode.switchFailed'));
            return;
          }

          if (isExpansion) {
            try {
              await persistEvePermissionAuthority({
                backend,
                conversationId: conversation_id,
                preferredMode: requestedBackendMode,
                hg4Delegated,
              });
            } catch (error) {
              setCurrentMode(confirmedMode);
              emitter.emit('acp.permission.mode', { conversation_id, mode: confirmedMode });
              console.error('[AcpSendBox] Failed to persist mobile EVE expansion:', error);
              Message.warning(
                t('agentMode.eve.expansionPersistFailed', {
                  defaultValue: hg4Delegated
                    ? 'HG4 delegation was not persisted. Sensitive actions will continue to ask.'
                    : 'The mode is active for this conversation, but the preference was not persisted.',
                })
              );
              return;
            }
            setCurrentMode(mode);
            emitter.emit('acp.permission.mode', { conversation_id, mode });
          }

          if (isLeaderInTeam) teamPermission?.propagateMode?.(confirmedMode);
          if (!restrictionPersistenceFailed) Message.success(t('agentMode.switchSuccess'));
        } catch (error) {
          if (isExpansion) {
            setCurrentMode(previousMode);
            emitter.emit('acp.permission.mode', { conversation_id, mode: previousMode });
          }
          console.error('[AcpSendBox] Failed to switch EVE mode via sheet:', error);
          Message.error(t('agentMode.switchFailed'));
        }
        return;
      }

      const isExpansion = isCommandEveModeExpansion(currentMode ?? 'default', mode);

      if (!isExpansion) {
        setCurrentMode(mode);
        emitter.emit('acp.permission.mode', { conversation_id, mode });
      }

      try {
        await prepareRuntimeSync();
        const confirmed = await ipcBridge.acpConversation.setMode.invoke({ conversation_id, mode });
        const confirmedMode = confirmed.mode || mode;
        if (confirmedMode !== mode) {
          if (isExpansion) {
            setCurrentMode(confirmedMode);
            emitter.emit('acp.permission.mode', { conversation_id, mode: confirmedMode });
          }
          Message.error(t('agentMode.switchFailed'));
          return;
        }
        if (isExpansion) {
          setCurrentMode(confirmedMode);
          emitter.emit('acp.permission.mode', { conversation_id, mode: confirmedMode });
        }
        if (backend) void savePreferredMode(backend, confirmedMode);
        if (isLeaderInTeam) teamPermission?.propagateMode?.(confirmedMode);
        Message.success(t('agentMode.switchSuccess'));
      } catch (error) {
        console.error('[AcpSendBox] Failed to switch mode via sheet:', error);
        Message.error(t('agentMode.switchFailed'));
      }
    },
    [backend, conversation_id, currentMode, isEveConversation, isLeaderInTeam, prepareRuntimeSync, t, teamPermission]
  );

  const handleDesktopModeChanged = useCallback(
    (mode: string) => {
      setCurrentMode(mode);
      if (isLeaderInTeam) teamPermission?.propagateMode?.(mode);
    },
    [isLeaderInTeam, teamPermission]
  );

  // In team mode, warmup the agent then fetch slash commands
  useEffect(() => {
    if (!teamPermission) return;
    void teamPermission
      .warmupSession()
      .then(() => warmupConversation(conversation_id))
      .then(() => {
        fetchSlashCommands();
      })
      .catch((error) => {
        Message.error(getConversationRuntimeWorkspaceErrorMessage(error, t));
      });
  }, [teamPermission, conversation_id, fetchSlashCommands, t]);

  const handleContentChange = useCallback(
    (val: string) => {
      if (val && teamPermission) teamPermission.warmupSession();
      setContent(val);
    },
    [teamPermission, setContent]
  );
  const { setSendBoxHandler } = usePreviewContext();

  // Use useLatestRef to keep latest setters to avoid re-registering handler
  const setContentRef = useLatestRef(setContent);
  const contentRef = useLatestRef(content);
  const atPathRef = useLatestRef(atPath);

  // Mic transcript → append onto the draft content (same helper SendBox uses for
  // its internal mic). The mic now lives in the UnifiedSendBar cluster on BOTH
  // surfaces, so SendBox's own inline mic is suppressed (hideSpeechButton).
  const handleSpeechTranscript = useCallback(
    (transcript: string) => {
      setContentRef.current(appendSpeechTranscript(contentRef.current, transcript));
    },
    [setContentRef, contentRef]
  );
  const transcribePendingSpeechInput = useCallback(
    (options?: { emit?: boolean }) => speechInputRef.current?.transcribePendingAudio(options) ?? Promise.resolve(null),
    []
  );

  const addOrUpdateMessage = useAddOrUpdateMessage(); // Move this here so it's available in useEffect
  const addOrUpdateMessageRef = useLatestRef(addOrUpdateMessage);
  const runtimeView = useConversationRuntimeView(conversation_id);
  const activeSteerRequestsRef = useRef(new Map<string, Promise<unknown>>());

  // Shared file handling logic
  const { handleFilesAdded, clearFiles } = useSendBoxFiles({
    atPath,
    uploadFile,
    setAtPath,
    setUploadFile,
  });
  const isBusy = runtimeView.isProcessing || !runtimeView.canSendMessage;

  useEffect(() => {
    if (!runtimeView.isProcessing) {
      setBusySendMode('queue');
    }
  }, [runtimeView.isProcessing]);

  // Register handler for adding text from preview panel to sendbox
  useEffect(() => {
    const handler = (text: string) => {
      // If there's existing content, add newline and new text; otherwise just set the text
      const new_content = content ? `${content}\n${text}` : text;
      setContentRef.current(new_content);
    };
    setSendBoxHandler(handler);
  }, [setSendBoxHandler, content]);

  // Listen for sendbox.fill event to append text to sendbox
  useAddEventListener(
    'sendbox.fill',
    (text: string) => {
      const prev = contentRef.current;
      setContentRef.current(prev ? `${prev}${text}` : text);
    },
    []
  );

  const executeCommand = useCallback(
    async ({ input, files, displayFiles }: Pick<ConversationCommandQueueItem, 'input' | 'files' | 'displayFiles'>) => {
      const displayMessage = buildDisplayMessage(input, displayFiles ?? files, workspacePath || '');

      runtimeView.markSendStarted();
      // 1.7.3 (Codex #2): mark generation at SEND time so the seat-switch guard
      // covers the window between submit and the first `start` stream event, during
      // which the response stream is silent. The stream's finish/error clears it on
      // a real turn; the catch below clears it if the send never starts.
      markConversationGenerating(conversation_id);
      setAiProcessing(true);

      try {
        if (teamPermission) await teamPermission.warmupSession();
        void checkAndUpdateTitle(conversation_id, input);
        const result = await ipcBridge.acpConversation.sendMessage.invoke({
          input: displayMessage,
          conversation_id,
          files,
        });
        runtimeView.markSendAccepted(result.turn_id, result.runtime, result.msg_id);
        emitter.emit('chat.history.refresh');
      } catch (error: unknown) {
        const errorMsg =
          getConversationRuntimeWorkspaceErrorMessage(error, t) || parseError(error) || t('common.unknownError');
        runtimeView.markSendFailed(errorMsg);
        // 1.7.3: the send never became a running turn — clear the guard flag (the
        // non-error failure path emits no terminal stream event to clear it).
        clearConversationGenerating(conversation_id);

        // Archived conversation (e.g. legacy Gemini). Backend signals this
        // via HTTP 410 + code='CONVERSATION_ARCHIVED' — identified by code,
        // not by substring matching.
        if (isBackendHttpError(error) && error.code === 'CONVERSATION_ARCHIVED') {
          Message.error({
            content: error.backendMessage || errorMsg,
            duration: 6000,
          });
          setAiProcessing(false);
          throw error;
        }

        const isAuthError =
          errorMsg.includes('[ACP-AUTH-') ||
          errorMsg.includes('authentication failed') ||
          errorMsg.includes('认证失败');
        if (isAuthError) {
          const errorMessage = {
            id: uuid(),
            msg_id: uuid(),
            turn_id: '',
            conversation_id,
            type: 'error',
            data: t('acp.auth.failed', {
              backend,
              error: errorMsg,
              defaultValue: `${backend} authentication failed:

{{error}}

Please check your local CLI tool authentication status`,
            }),
          };

          ipcBridge.acpConversation.responseStream.emit(errorMessage);
        } else {
          addOrUpdateMessageRef.current(
            {
              id: uuid(),
              msg_id: uuid(),
              type: 'tips',
              position: 'center',
              conversation_id,
              created_at: Date.now(),
              content: {
                content: errorMsg,
                type: 'error',
                error: buildSendFailureError(error, errorMsg),
              },
            },
            true
          );
        }

        resetState();
        setAiProcessing(false);
        throw error;
      }

      if (files.length > 0) {
        emitter.emit('acp.workspace.refresh');
      }
    },
    [backend, checkAndUpdateTitle, conversation_id, resetState, runtimeView, setAiProcessing, t, workspacePath]
  );

  const {
    items: queuedCommands,
    isPaused: isQueuePaused,
    isInteractionLocked: isQueueInteractionLocked,
    hasPendingCommands,
    enqueue,
    remove,
    restore,
    clear,
    reorder,
    pause,
    resume,
    lockInteraction,
    unlockInteraction,
    resetActiveExecution,
  } = useConversationCommandQueue({
    conversation_id: conversation_id,
    enabled: true,
    isBusy,
    runtimeGate: {
      hydrated: runtimeView.hydrated,
      canSendMessage: runtimeView.canSendMessage,
      isProcessing: runtimeView.isProcessing,
    },
    onExecute: executeCommand,
  });

  // Video PRE-SUBMIT cost-wall controller (alpha.9 OI#2 wiring). Video is the
  // single most expensive action; this is the seam that guarantees the
  // transparent cost preview ALWAYS fires + requires an explicit confirm BEFORE
  // a video generation request is submitted. Fast/720p is the default; 1080p is
  // an explicit upgrade inside the wall.
  const videoCostWall = useVideoCostWall();

  const dispatchSteer = useCallback(
    (input: string, requestId?: string) => {
      const turnId = runtimeView.activeTurnId;
      if (!turnId) {
        return Promise.reject(
          new Error(
            t('conversation.commandQueue.activeTurnUnavailable', {
              defaultValue: 'The current run is not ready for a correction yet.',
            })
          )
        );
      }

      const normalizedInput = input.trim();
      const inFlightKey = `${turnId}\u0000${normalizedInput}`;
      const existingRequest = activeSteerRequestsRef.current.get(inFlightKey);
      if (existingRequest) return existingRequest;

      const pendingRequest = ipcBridge.acpConversation.steer.invoke({
        input: normalizedInput,
        conversation_id,
        turn_id: turnId,
        request_id: requestId ?? uuid(),
      });
      activeSteerRequestsRef.current.set(inFlightKey, pendingRequest);

      const clearRequest = () => {
        if (activeSteerRequestsRef.current.get(inFlightKey) === pendingRequest) {
          activeSteerRequestsRef.current.delete(inFlightKey);
        }
      };
      void pendingRequest.then(clearRequest, clearRequest);
      return pendingRequest;
    },
    [conversation_id, runtimeView.activeTurnId, t]
  );

  // The real dispatch (queue or execute) for an already-cleared message. Both
  // the normal send and the post-confirm video send route through this so the
  // queue/in-flight semantics are identical.
  const dispatchMessage = useCallback(
    async (message: string, agentFiles: string[], displayFiles: string[] = agentFiles) => {
      const requestedBusyControlCommand = runtimeView.isProcessing
        ? buildConversationBusyControlCommand({ input: message, mode: busySendMode })
        : null;
      const busyControlCommand = agentFiles.length === 0 ? requestedBusyControlCommand : null;

      if (agentFiles.length > 0 && requestedBusyControlCommand?.mode === 'steer') {
        Message.warning(
          t('conversation.commandQueue.steerFilesQueued', {
            defaultValue: 'Corrections cannot include files, so this message was queued for afterwards.',
          })
        );
      }

      if (busyControlCommand) {
        try {
          await dispatchSteer(busyControlCommand.input);
          emitter.emit('chat.history.refresh');
          return true;
        } catch (error) {
          Message.error({
            content:
              parseError(error) ||
              t('conversation.commandQueue.promoteFailed', {
                defaultValue: 'The correction could not be pushed into the current run.',
              }),
            duration: 5000,
          });
          return false;
        }
      }

      if (
        shouldEnqueueConversationCommand({
          enabled: true,
          isBusy,
          hasPendingCommands,
        })
      ) {
        return enqueue({ input: message, files: agentFiles, displayFiles }) !== null;
      }
      await executeCommand({ input: message, files: agentFiles, displayFiles });
      return true;
    },
    [busySendMode, dispatchSteer, enqueue, executeCommand, hasPendingCommands, isBusy, runtimeView.isProcessing, t]
  );

  const preparePdfFiles = useCallback(
    async (files: string[]): Promise<string[] | null> => {
      if (!isEveConversation) return files;
      const pdfFiles = files.filter(isCommandEvePdfPath);
      if (pdfFiles.length === 0) return files;

      const startedAt = Date.now();
      setDocumentPreparation({ phase: 'reading_local', fileCount: pdfFiles.length, startedAt });

      const invoke = (allowCloudOcr: boolean) =>
        ipcBridge.commandEve.pdfPrepare.invoke({
          filePaths: pdfFiles,
          allowCloudOcr,
          privacyLane: 'cloud_auto',
          requestId: `pdf-${Date.now().toString(36)}`,
        });
      try {
        let response = await invoke(false);
        if (response.success && response.data?.ok) {
          setDocumentPreparation({ phase: 'handoff', fileCount: pdfFiles.length, startedAt });
          return mergeCommandEvePreparedPdfFiles(files, response.data.documents);
        }

        const initialFailure = response.data?.ok === false ? response.data : undefined;
        if (initialFailure?.requires_cloud_ocr_consent !== true) {
          setDocumentPreparation({ phase: 'error', fileCount: pdfFiles.length, startedAt });
          Message.error({
            content: initialFailure?.message || t('conversation.pdf.prepareFailed'),
            duration: 6000,
          });
          return null;
        }

        setDocumentPreparation({ phase: 'awaiting_cloud_ocr', fileCount: pdfFiles.length, startedAt });

        const approved = await new Promise<boolean>((resolve) => {
          Modal.confirm({
            title: t('conversation.pdf.cloudOcrTitle'),
            content: t('conversation.pdf.cloudOcrDescription', {
              files: initialFailure.pending_source_names?.join(', ') || t('conversation.pdf.selectedDocuments'),
            }),
            okText: t('conversation.pdf.cloudOcrConfirm'),
            cancelText: t('common.cancel'),
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
            closable: true,
          });
        });
        if (!approved) {
          setDocumentPreparation(null);
          return null;
        }

        setDocumentPreparation({ phase: 'reading_cloud', fileCount: pdfFiles.length, startedAt });
        response = await invoke(true);
        if (!response.success || !response.data?.ok) {
          setDocumentPreparation({ phase: 'error', fileCount: pdfFiles.length, startedAt });
          const cloudFailure = response.data?.ok === false ? response.data : undefined;
          Message.error({
            content: cloudFailure?.message || t('conversation.pdf.cloudOcrFailed'),
            duration: 6000,
          });
          return null;
        }
        setDocumentPreparation({ phase: 'handoff', fileCount: pdfFiles.length, startedAt });
        return mergeCommandEvePreparedPdfFiles(files, response.data.documents);
      } catch (error) {
        setDocumentPreparation({ phase: 'error', fileCount: pdfFiles.length, startedAt });
        Message.error({
          content: getConversationRuntimeWorkspaceErrorMessage(error, t) || t('conversation.pdf.prepareFailed'),
          duration: 6000,
        });
        return null;
      }
    },
    [isEveConversation, t]
  );

  const submitMessage = useCallback(
    async (
      message: string,
      allFiles: string[],
      controls: { clearSelection: () => void; restoreDraftAndFiles: () => void }
    ): Promise<boolean> => {
      if (documentPreparationInFlightRef.current) {
        controls.restoreDraftAndFiles();
        return false;
      }

      const hasPdfFiles = isEveConversation && allFiles.some(isCommandEvePdfPath);
      if (hasPdfFiles) {
        documentPreparationInFlightRef.current = true;
        markConversationDocumentPreparationStarted(conversation_id);
      }

      const preparedFiles = await preparePdfFiles(allFiles);
      // A cancelled/failed OCR gate must leave the draft and selected files intact.
      if (preparedFiles === null) {
        controls.restoreDraftAndFiles();
        documentPreparationInFlightRef.current = false;
        markConversationDocumentPreparationSettled(conversation_id);
        return false;
      }

      controls.clearSelection();

      // Heavy-lane guardrail (DUX-6, FAIL-SAFE): every send surface, including
      // the fresh-chat handoff, reaches this same cost wall before video work.
      const routesToVideo =
        isEveConversation &&
        isVideoLaneRequest({
          message,
          resolvedAgentId: addressesVideoMarketer(message) ? VIDEO_LANE_AGENT_ID : null,
        });

      if (routesToVideo) {
        documentPreparationInFlightRef.current = false;
        setDocumentPreparation(null);
        videoCostWall.requestVideo(
          {},
          (resolved) => {
            const resolvedMessage = buildResolvedVideoMessage(message, resolved);
            const dispatch = dispatchMessage(resolvedMessage, preparedFiles, allFiles);
            markConversationDocumentPreparationSettled(conversation_id);
            void dispatch
              .then((accepted) => {
                if (!accepted) controls.restoreDraftAndFiles();
              })
              .catch(() => {
                controls.restoreDraftAndFiles();
              });
          },
          () => {
            controls.restoreDraftAndFiles();
            markConversationDocumentPreparationSettled(conversation_id);
          }
        );
        return true;
      }

      try {
        const accepted = await dispatchMessage(message, preparedFiles, allFiles);
        if (!accepted) controls.restoreDraftAndFiles();
        return accepted;
      } catch (error) {
        controls.restoreDraftAndFiles();
        throw error;
      } finally {
        documentPreparationInFlightRef.current = false;
        if (hasPdfFiles) {
          setDocumentPreparation(null);
          markConversationDocumentPreparationSettled(conversation_id);
        }
      }
    },
    [conversation_id, dispatchMessage, isEveConversation, preparePdfFiles, videoCostWall.requestVideo]
  );

  useEffect(
    () => () => {
      documentPreparationInFlightRef.current = false;
      markConversationDocumentPreparationSettled(conversation_id);
    },
    [conversation_id]
  );

  const onSendHandler = useCallback(
    async (message: string): Promise<void> => {
      const draftContent = content || message;
      const selectedAtPath = [...atPath];
      const selectedUploadFiles = [...uploadFile];
      const atPathFiles = selectedAtPath.map((item) => (typeof item === 'string' ? item : item.path));
      const allFiles = [...selectedUploadFiles, ...atPathFiles];

      await submitMessage(message, allFiles, {
        clearSelection: () => {
          clearFiles();
          emitter.emit('acp.selected.file.clear');
        },
        restoreDraftAndFiles: () => {
          setContent(draftContent);
          setUploadFile(selectedUploadFiles);
          setAtPath(selectedAtPath);
          emitter.emit('acp.selected.file', selectedAtPath);
        },
      });
    },
    [atPath, clearFiles, content, setAtPath, setContent, setUploadFile, submitMessage, uploadFile]
  );

  const sendInitialMessage = useCallback(
    async (input: string, files: string[]): Promise<boolean> => {
      try {
        return await submitMessage(input, files, {
          clearSelection: () => {},
          restoreDraftAndFiles: () => {
            setContent(input);
            setUploadFile(files);
            setAtPath([]);
            emitter.emit('acp.selected.file.clear');
          },
        });
      } catch {
        // executeCommand already rendered the structured failure and restored
        // the fresh-chat draft. Do not add a second generic error message here.
        return false;
      }
    },
    [setAtPath, setContent, setUploadFile, submitMessage]
  );

  // The Guid/startscreen handoff is only transport. All real submission work
  // stays in submitMessage so PDFs, video gates, queues, and recovery cannot drift.
  useAcpInitialMessage({
    conversation_id,
    sendInitialMessage,
    resetState,
    addOrUpdateMessage: addOrUpdateMessageRef.current,
  });

  const handleEditQueuedCommand = useCallback(
    (item: ConversationCommandQueueItem) => {
      remove(item.id);
      setContent(item.input);
      setUploadFile(Array.from(new Set(item.displayFiles ?? item.files)));
      setAtPath([]);
      emitter.emit('acp.selected.file.clear');
    },
    [remove, setAtPath, setContent, setUploadFile]
  );

  const handlePromoteQueuedCommand = useCallback(
    async (item: ConversationCommandQueueItem) => {
      if (item.files.length > 0) {
        Message.warning(
          t('conversation.commandQueue.promoteFilesUnsupported', {
            defaultValue: 'Corrections with files stay queued.',
          })
        );
        return;
      }

      if (!runtimeView.isProcessing) {
        return;
      }

      if (promotingQueuedCommandIdsRef.current.has(item.id) || isQueueInteractionLocked) {
        return;
      }

      promotingQueuedCommandIdsRef.current.add(item.id);
      setPromotingQueuedCommandIds(new Set(promotingQueuedCommandIdsRef.current));
      lockInteraction();

      try {
        // Remove before dispatch so a double click cannot send the same correction
        // twice. A failed dispatch restores the exact item below.
        await remove(item.id);
        const correction = buildConversationBusyControlCommand({ input: item.input, mode: 'steer' });
        if (!correction) {
          throw new Error('Queued correction is empty.');
        }
        await dispatchSteer(correction.input, item.id);
        emitter.emit('chat.history.refresh');
      } catch (error) {
        await restore(item);
        Message.error({
          content:
            parseError(error) ||
            t('conversation.commandQueue.promoteFailed', {
              defaultValue: 'The correction could not be pushed into the current run.',
            }),
          duration: 5000,
        });
      } finally {
        promotingQueuedCommandIdsRef.current.delete(item.id);
        setPromotingQueuedCommandIds(new Set(promotingQueuedCommandIdsRef.current));
        unlockInteraction();
      }
    },
    [
      dispatchSteer,
      isQueueInteractionLocked,
      lockInteraction,
      remove,
      restore,
      runtimeView.isProcessing,
      t,
      unlockInteraction,
    ]
  );

  const appendSelectedFiles = useCallback(
    (files: string[]) => {
      setUploadFile((prev) => [...prev, ...files]);
    },
    [setUploadFile]
  );
  const { openFileSelector, onSlashBuiltinCommand } = useOpenFileSelector({
    onFilesSelected: appendSelectedFiles,
  });

  const { entries: attachEntries, hiddenFileInput: attachHiddenInput } = useAttachEntry({
    openFileSelector,
    onLocalFilesAdded: handleFilesAdded,
  });

  const sheetEntries = useMemo<MobileActionSheetEntry[]>(() => {
    if (!isMobile) return [];

    const modeOptions: MobileActionSheetOption[] = availablePermissionModes.map((mode) => ({
      key: mode.value,
      label: formatModeLabel(mode),
      description: mode.description,
      active: currentMode === mode.value,
    }));

    const modelOptions: MobileActionSheetOption[] = canSwitchModel
      ? (model_info?.available_models ?? []).map((model) => ({
          key: model.id,
          label: model.label || model.id,
          active: model_info?.current_model_id === model.id,
        }))
      : [];

    const currentModelLabel =
      model_info?.current_model_label || model_info?.current_model_id || t('conversation.welcome.useCliModel');
    const currentModeLabel =
      modeOptions.find((opt) => opt.active)?.label ?? t('agentMode.default', { defaultValue: 'Default' });

    const entries: MobileActionSheetEntry[] = [];

    if (isEveConversation) {
      // EVE Inference STUFE entry (Standard/Hoch free · Max · Maximum + Private).
      // Max/Maximum stay greyed (disabled) while trialing via the shared core
      // gating; the paid levels carry a visible cost badge in the description so
      // the credit / ~5× cost is obvious in-chat, not only in the pre-chat picker.
      const eveOptions: MobileActionSheetOption[] = eveInference.groups.flatMap((group) =>
        group.items.map((item) => ({
          key: item.value,
          label:
            group.kind === 'eve'
              ? `EVE Cloud · ${item.label}`
              : `${t('common.localModel', { defaultValue: 'Lokal' })} · ${item.label}`,
          description: item.costBadge ? `${item.sublabel} · ${item.costBadge}` : item.sublabel,
          active: item.value === eveInference.selection && !item.disabled,
          disabled: item.disabled,
        }))
      );
      const currentEveLabel = eveInference.selectedItem
        ? eveInference.selectedItem.group === 'eve'
          ? `EVE Cloud · ${eveInference.selectedItem.label}`
          : `${t('common.localModel', { defaultValue: 'Lokal' })} · ${eveInference.selectedItem.label}`
        : t('conversation.eveInference.pick', { defaultValue: 'Modell wählen' });
      entries.push({
        key: 'eve-inference',
        icon: <Brain theme='outline' size='16' />,
        label: t('conversation.eveInference.title', { defaultValue: 'EVE Inference' }),
        meta: currentEveLabel,
        submenu: {
          title: t('conversation.eveInference.title', { defaultValue: 'EVE Inference' }),
          options: eveOptions,
          onSelect: (value) => eveInference.commit(value),
        },
      });
    } else if (modelOptions.length > 0) {
      // Model entry: only when the agent exposes a switchable list. Otherwise
      // (Codex with no list, no info) skip — exposing a no-op row would be noise.
      entries.push({
        key: 'model',
        icon: <Brain theme='outline' size='16' />,
        label: t('common.model', { defaultValue: 'Model' }),
        meta: currentModelLabel,
        submenu: {
          title: t('common.model', { defaultValue: 'Model' }),
          options: modelOptions,
          onSelect: (id) => selectModel(id),
        },
      });
    }

    if (modeOptions.length > 0) {
      entries.push({
        key: 'permission',
        icon: <Shield theme='outline' size='16' />,
        label: t('agentMode.permission', { defaultValue: 'Permission' }),
        meta: currentModeLabel,
        submenu: {
          title: t('agentMode.permission', { defaultValue: 'Permission' }),
          options: modeOptions,
          onSelect: (key) => void handleSheetModeChange(key),
        },
      });
    }

    if (runtimeView.isProcessing) {
      entries.push({
        key: 'busy-send-mode',
        icon: busySendMode === 'steer' ? <EditOne theme='outline' size='16' /> : <Time theme='outline' size='16' />,
        label: t('conversation.commandQueue.busyModeAria', { defaultValue: 'Busy send mode' }),
        meta: t(
          busySendMode === 'steer'
            ? 'conversation.commandQueue.busyModeSteer'
            : 'conversation.commandQueue.busyModeQueue',
          { defaultValue: busySendMode === 'steer' ? 'Correction' : 'Afterwards' }
        ),
        submenu: {
          title: t('conversation.commandQueue.busyModeAria', { defaultValue: 'Busy send mode' }),
          options: [
            {
              key: 'queue',
              label: t('conversation.commandQueue.busyModeQueue', { defaultValue: 'Afterwards' }),
              description: t('conversation.commandQueue.busyModeQueueTooltip', {
                defaultValue: 'Send after the current run finishes.',
              }),
              active: busySendMode === 'queue',
            },
            {
              key: 'steer',
              label: t('conversation.commandQueue.busyModeSteer', { defaultValue: 'Correction' }),
              description: t('conversation.commandQueue.busyModeSteerTooltip', {
                defaultValue: 'Push into the current run after the next tool step.',
              }),
              active: busySendMode === 'steer',
            },
          ],
          onSelect: (mode) => setBusySendMode(mode as ConversationBusyControlMode),
        },
      });
    }

    attachEntries.forEach((entry, idx) => {
      entries.push({
        ...entry,
        dividerBefore: idx === 0 ? entries.length > 0 : false,
      });
    });

    if (loadedSkills.length > 0) {
      const skillOptions: MobileActionSheetOption[] = loadedSkills.map((name) => ({
        key: name,
        label: `/${name}`,
      }));
      entries.push({
        key: 'skills',
        icon: <MagicHat theme='outline' size='16' />,
        label: t('common.skills', { defaultValue: 'Skills' }),
        variant: 'muted',
        submenu: {
          title: t('common.skills', { defaultValue: 'Skills' }),
          selectable: false,
          options: skillOptions,
          onSelect: (name) => {
            setContent(`/${name} `);
          },
        },
      });
    }

    if (loadedMcpStatuses.length > 0) {
      const mcpOptions: MobileActionSheetOption[] = loadedMcpStatuses.map((item) => ({
        key: item.id,
        label: item.name,
        description:
          item.status === 'loaded'
            ? undefined
            : item.reason
              ? `${t(`conversation.mcp.status.${item.status}` as const)} · ${item.reason}`
              : t(`conversation.mcp.status.${item.status}` as const),
      }));
      entries.push({
        key: 'mcp',
        icon: <Shield theme='outline' size='16' />,
        label: t('conversation.mcp.loaded', { defaultValue: 'Loaded MCP' }),
        variant: 'muted',
        submenu: {
          title: t('conversation.mcp.loaded', { defaultValue: 'Loaded MCP' }),
          selectable: false,
          options: mcpOptions,
          onSelect: () => undefined,
        },
      });
    }

    return entries;
  }, [
    attachEntries,
    availablePermissionModes,
    canSwitchModel,
    currentMode,
    busySendMode,
    eveInference,
    formatModeLabel,
    handleSheetModeChange,
    isEveConversation,
    isMobile,
    loadedMcpStatuses,
    loadedSkills,
    model_info,
    runtimeView.isProcessing,
    selectModel,
    setContent,
    t,
  ]);

  useAddEventListener('acp.selected.file', setAtPath);
  useAddEventListener('acp.selected.file.append', (selectedItems: Array<string | FileOrFolderItem>) => {
    const merged = mergeFileSelectionItems(atPathRef.current, selectedItems);
    if (merged !== atPathRef.current) {
      setAtPath(merged as Array<string | FileOrFolderItem>);
    }
  });

  // Stop conversation handler
  const handleStop = async (): Promise<void> => {
    // Cancelling is best-effort: swallow errors (e.g. backend WS not yet
    // connected → 409) so they don't bubble up as unhandled rejections.
    // UI state resets immediately; the backend acknowledgement is applied when
    // it arrives so a stalled cancel request does not freeze the composer.
    pause();
    const turnId = runtimeView.activeTurnId;
    if (!turnId) {
      resetState();
      resetActiveExecution('stop');
      return;
    }
    runtimeView.markStopRequested(turnId);
    resetState();
    resetActiveExecution('stop');
    void ipcBridge.conversation.stop
      .invoke({ conversation_id, turn_id: turnId })
      .then((result) => {
        runtimeView.markStopAcknowledged(turnId, result.runtime);
      })
      .catch((error) => {
        console.warn('[AcpSendBox] stop request failed', error);
        runtimeView.resetLocalGate('stop_failed');
      });
  };

  return (
    <div className='acp-send-box max-w-800px w-full mx-auto flex flex-col mt-auto mb-16px'>
      {/* Video PRE-SUBMIT cost-wall (alpha.9 OI#2): the wall opens for a pending
          video-generation request and requires an explicit confirm before the
          actual request is dispatched. Fast/720p default; 1080p explicit upgrade. */}
      <VideoCostWall
        visible={videoCostWall.visible}
        durationSeconds={videoCostWall.durationSeconds}
        onCancel={videoCostWall.cancel}
        onConfirm={videoCostWall.confirm}
      />
      <AcpDocumentPreparationStatus state={documentPreparation} />
      <CommandQueuePanel
        items={queuedCommands}
        paused={isQueuePaused}
        interactionLocked={isQueueInteractionLocked}
        promotingCommandIds={promotingQueuedCommandIds}
        onPause={pause}
        onResume={resume}
        onInteractionLock={lockInteraction}
        onInteractionUnlock={unlockInteraction}
        onEdit={handleEditQueuedCommand}
        onPromote={runtimeView.isProcessing ? handlePromoteQueuedCommand : undefined}
        onReorder={reorder}
        onRemove={remove}
        onClear={clear}
      />
      <ThoughtDisplay running={aiProcessing && !hasThinkingMessage} onStop={handleStop} />

      <SendBox
        onMobilePlusClick={isMobile ? () => setIsMobileSheetOpen(true) : undefined}
        value={content}
        onChange={handleContentChange}
        selectedWorkspaceItems={atPath}
        onSelectedWorkspaceItemsChange={(items) => {
          emitter.emit('acp.selected.file', items);
          setAtPath(items);
        }}
        loading={isBusy || documentPreparationInFlightRef.current}
        disabled={false}
        hasPendingSpeechInput={speechInputStatus === 'recording'}
        transcribePendingSpeechInput={transcribePendingSpeechInput}
        placeholder={
          isEveConversation
            ? t('conversation.welcome.evePlaceholder')
            : t('acp.sendbox.placeholder', {
                backend: agent_name || backend,
                defaultValue: `Send message to {{backend}}...`,
              })
        }
        onStop={handleStop}
        className='z-10'
        onFilesAdded={handleFilesAdded}
        hasPendingAttachments={uploadFile.length > 0 || atPath.length > 0}
        enableBtw={isSideQuestionSupported({ type: 'acp', backend })}
        supportedExts={allSupportedExts}
        defaultMultiLine={!isMobile}
        lockMultiLine={!isMobile}
        tools={
          <div className='flex min-w-0 items-center gap-6px'>
            <FileAttachButton
              openFileSelector={openFileSelector}
              onLocalFilesAdded={handleFilesAdded}
              loadedMcpStatuses={loadedMcpStatuses}
            />
            {!isMobile ? <WorkspaceContextControl workspacePath={workspacePath} /> : null}
          </div>
        }
        hideSpeechButton
        rightTools={
          // The ONE Claude-Code-style control cluster (STEP 4), shared with the
          // start screen. Founder mandate: the in-chat model/inference picker now
          // lives HERE in the bottom bar's modelSlot (like Claude Code), NOT in the
          // chat header — so the start screen and the in-chat surface read
          // identically. EVE conversations get the EveInferencePicker (tier/Stufe);
          // every other ACP backend gets the existing AcpModelSelector. On mobile
          // the picker stays in the `+` action sheet (sheetEntries), so the bar's
          // modelSlot is left empty there to avoid a duplicate.
          // Order: [model · permission · context+credits · mic]. SendBox owns send.
          <UnifiedSendBar
            busyModeSlot={
              isMobile ? null : (
                <ConversationBusyModeControl
                  visible={runtimeView.isProcessing}
                  value={busySendMode}
                  onChange={setBusySendMode}
                />
              )
            }
            modelSlot={
              isMobile ? null : isEveConversation ? (
                <EveInferencePicker disabled={isBusy} />
              ) : (
                <AcpModelSelector conversation_id={conversation_id} backend={backend} waitForWarmup />
              )
            }
            permissionSlot={
              showModeSelector ? (
                <AgentModeSelector
                  backend={backend}
                  conversation_id={conversation_id}
                  compact
                  initialMode={session_mode}
                  compactLeadingIcon={<Shield theme='outline' size='14' fill={iconColors.secondary} />}
                  modeLabelFormatter={formatModeLabel}
                  compactLabelPrefix={t('agentMode.permission')}
                  hideCompactLabelPrefixOnMobile
                  onModeChanged={handleDesktopModeChanged}
                  beforeRuntimeSync={prepareRuntimeSync}
                />
              ) : null
            }
            contextSlot={
              /* Consumed-context ring + credits popover (Claude-Code-style). Quiet
                 until the first acp_context_usage frame arrives (renders null with no
                 tokenUsage). Model-sensitive window via the live request_trace model. */
              isEveConversation ? null : (
                <ContextUsageIndicator
                  tokenUsage={tokenUsage}
                  context_limit={context_limit}
                  modelId={indicatorModelId}
                />
              )
            }
            eveControl={
              !isMobile && isEveConversation
                ? {
                    tokenUsage,
                    contextLimit: context_limit,
                    modelId: indicatorModelId,
                    disabled: isBusy,
                  }
                : undefined
            }
            micSlot={
              <SpeechInputButton
                ref={speechInputRef}
                disabled={isBusy}
                locale={i18n?.language || 'en-US'}
                onTranscript={handleSpeechTranscript}
                onStatusChange={setSpeechInputStatus}
              />
            }
          />
        }
        prefix={
          <>
            {uploadFile.length > 0 && (
              <HorizontalFileList>
                {uploadFile.map((path) => (
                  <FilePreview
                    key={path}
                    path={path}
                    onRemove={() => setUploadFile(uploadFile.filter((v) => v !== path))}
                  />
                ))}
              </HorizontalFileList>
            )}
            {atPath.some((item) => (typeof item === 'string' ? false : !item.isFile)) && (
              <div className='flex flex-wrap items-center gap-8px mb-8px'>
                {atPath.map((item) => {
                  if (typeof item === 'string') return null;
                  if (!item.isFile) {
                    return (
                      <Tag
                        key={item.path}
                        color='blue'
                        closable
                        onClose={() => {
                          const newAtPath = atPath.filter((v) => (typeof v === 'string' ? true : v.path !== item.path));
                          emitter.emit('acp.selected.file', newAtPath);
                          setAtPath(newAtPath);
                        }}
                      >
                        {item.name}
                      </Tag>
                    );
                  }
                  return null;
                })}
              </div>
            )}
          </>
        }
        onSend={onSendHandler}
        slash_commands={slashCommands}
        onSlashBuiltinCommand={onSlashBuiltinCommand}
        allowSendWhileLoading
        compactActions={false}
      ></SendBox>
      {isMobile && (
        <>
          <MobileActionSheet
            open={isMobileSheetOpen}
            onClose={() => setIsMobileSheetOpen(false)}
            title={t('common.more', { defaultValue: 'More' })}
            entries={sheetEntries}
          />
          {attachHiddenInput}
        </>
      )}
    </div>
  );
};

export default AcpSendBox;
