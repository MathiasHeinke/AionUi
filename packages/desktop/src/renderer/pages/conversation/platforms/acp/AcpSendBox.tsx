import { ipcBridge } from '@/common';
import { userVisibleConversationMcpStatuses } from '@/common/config/eveManagedMcpCore';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { isSideQuestionSupported } from '@/common/chat/sideQuestion';
import { parseError, uuid } from '@/common/utils';
import AgentModeSelector from '@/renderer/components/agent/AgentModeSelector';
import AcpModelSelector from '@/renderer/components/agent/AcpModelSelector';
import EveMaxToggle from '@/renderer/components/agent/EveMaxToggle';
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
  createModeLabelFormatter,
  isCommandEveModeExpansion,
} from '@/renderer/utils/model/agentModes';
import { useEveInferenceSelection } from '@/renderer/hooks/agent/useEveInferenceSelection';
import {
  EVE_DEFAULT_INFERENCE_SELECTION,
  isEveInferenceSelection,
  resolveWireTierFromSelection,
} from '@/common/config/eveInferenceCore';
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
import { waitForConversationActiveTurnId } from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';
import {
  markConversationDocumentPreparationSettled,
  markConversationDocumentPreparationStarted,
  useConversationDocumentPreparation,
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
import { isCommandEvePresentationPath } from '@/common/config/evePresentationIntelligenceCore';
import { isCommandEveImagePath } from '@/common/config/eveImageIntelligenceCore';
import {
  buildCommandEvePreparedAgentInput,
  composeCommandEvePreparedContext,
} from '@/common/config/evePreparedContextCore';
import {
  extractCommandEveManagedVisualTurnToken,
  resolveCommandEveManagedVisualPreferredTier,
} from '@/common/config/eveManagedVisualTurnCore';
import type { CommandEveCloudVisualPolicyReceipt } from '@/common/config/visual/cloudVisualPolicyCore';
import { Message, Modal, Tag } from '@arco-design/web-react';
import { Brain, EditOne, MagicHat, Shield, Time } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildSendFailureError } from './buildSendFailureError';
import { runProjectChatIntentGate } from '@/renderer/pages/conversation/shared/projectChatIntentGate';
import AcpDocumentPreparationStatus, { type AcpDocumentPreparationState } from './AcpDocumentPreparationStatus';
import { useCommandEveVisualPreparation } from './useCommandEveVisualPreparation';
import { useAcpInitialMessage } from './useAcpInitialMessage';
import type { UseAcpMessageReturn } from './useAcpMessage';
import { useVideoCostWall } from '@/renderer/hooks/useVideoCostWall';
import {
  isVideoLaneRequest,
  VIDEO_LANE_AGENT_ID,
  DEFAULT_VIDEO_DURATION_SECONDS,
  DEFAULT_VIDEO_TIER_ID,
  isVideoTierAvailable,
  type VideoInputMode,
  type VideoQualityTier,
} from '@/common/config/videoCostCore';
import VideoQualityPill from '@/renderer/components/billing/VideoQualityPill';
import { isImageFile } from '@/renderer/pages/conversation/Preview/fileUtils';
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
  const loadedMcpStatuses = userVisibleConversationMcpStatuses(
    conversationContext?.loadedMcpStatuses,
    conversationContext?.loadedMcpServers
  );
  const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);
  const [currentMode, setCurrentMode] = useState<string | undefined>(session_mode);
  const [busySendMode, setBusySendMode] = useState<ConversationBusyControlMode>('queue');
  const [documentPreparation, setDocumentPreparation] = useState<AcpDocumentPreparationState | null>(null);
  const documentPreparationInFlightRef = useRef(false);
  // Reactive twin of the ref for rendering: the ref serves synchronous guards,
  // the store-backed hook keeps `loading` correct regardless of microtask
  // ordering (the S81/R3 intent gate adds an await before preparation starts).
  const documentPreparationInFlight = useConversationDocumentPreparation(conversation_id);
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
  const { preparePresentationFiles, prepareImageFiles } = useCommandEveVisualPreparation({
    isEveConversation,
    workspacePath,
    setDocumentPreparation,
  });
  const availablePermissionModes = useMemo(
    () => (isEveConversation ? boundCommandEveModeMenu(availableAgentModes) : availableAgentModes),
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
          setCurrentMode(result.mode);
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

        if (!isExpansion) {
          setCurrentMode(mode);
          emitter.emit('acp.permission.mode', { conversation_id, mode });
          await savePreferredMode(backend, requestedBackendMode);
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
            await savePreferredMode(backend, requestedBackendMode);
            setCurrentMode(mode);
            emitter.emit('acp.permission.mode', { conversation_id, mode });
          }

          if (isLeaderInTeam) teamPermission?.propagateMode?.(confirmedMode);
          Message.success(t('agentMode.switchSuccess'));
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
  const steerRetryRequestIdsRef = useRef(new Map<string, string>());

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
    async ({
      input,
      files,
      displayFiles,
      preparedContext,
      managedVisualSourceCount,
    }: Pick<
      ConversationCommandQueueItem,
      'input' | 'files' | 'displayFiles' | 'preparedContext' | 'managedVisualSourceCount'
    >) => {
      try {
        let dispatchPreparedContext = preparedContext;
        if (managedVisualSourceCount !== undefined) {
          if (
            !dispatchPreparedContext ||
            extractCommandEveManagedVisualTurnToken(dispatchPreparedContext) !== undefined ||
            !Number.isInteger(managedVisualSourceCount) ||
            managedVisualSourceCount < 1 ||
            managedVisualSourceCount > 6
          ) {
            throw new Error('EVE_MANAGED_VISUAL_DISPATCH_RECIPE_INVALID');
          }

          const flowId = `visual_${uuid().replace(/-/g, '')}`;
          const receiptResult = await ipcBridge.commandEve.cloudVisualPolicyReceipt.invoke({ flowId });
          if (!receiptResult.success || !receiptResult.data?.ok) {
            // CommandEveCloudVisualPolicyReceiptResult carries no `message` field on
            // either branch (see cloudVisualPolicyCore.ts) — the translated sentence
            // is the only honest content here, matching issueVisualAuthority below.
            throw new Error(
              t('conversation.visual.managedCloudFailed', {
                defaultValue: 'Cloud visual analysis is disabled or unavailable for this seat.',
              })
            );
          }
          const authorization = await ipcBridge.commandEve.managedVisualTurnAuthorize.invoke({
            flowId,
            visualPolicyReceipt: receiptResult.data.receipt,
            preferredTier: resolveCommandEveManagedVisualPreferredTier(
              resolveWireTierFromSelection(eveInference.selection)
            ),
            sourceCount: managedVisualSourceCount,
          });
          if (!authorization.success || !authorization.data?.ok || !authorization.data.marker) {
            throw new Error(
              authorization.data?.message ||
                t('conversation.visual.managedCloudFailed', {
                  defaultValue: 'Managed visual analysis could not be authorized. Please try again.',
                })
            );
          }
          dispatchPreparedContext = `${authorization.data.marker}\n${dispatchPreparedContext}`;
        }

        const agentInput = buildCommandEvePreparedAgentInput(input, dispatchPreparedContext);
        const displayMessage = buildDisplayMessage(agentInput, displayFiles ?? files, workspacePath || '');

        runtimeView.markSendStarted();
        // 1.7.3 (Codex #2): mark generation at SEND time so the seat-switch guard
        // covers the window between submit and the first `start` stream event, during
        // which the response stream is silent. The stream's finish/error clears it on
        // a real turn; the catch below clears it if the send never starts.
        markConversationGenerating(conversation_id);
        setAiProcessing(true);

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
    [
      backend,
      checkAndUpdateTitle,
      conversation_id,
      eveInference.selection,
      resetState,
      runtimeView,
      setAiProcessing,
      t,
      teamPermission,
      workspacePath,
    ]
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

  // Video submit seam. Video is the most expensive single action, so the cost
  // stays visible — but it is no longer a question. There is no confirm step:
  // asking for a video IS the authorisation to make one. The tier below travels
  // into the dispatched message, so the price the user saw is the spec the agent
  // receives. The only thing that may REFUSE is the server-side pre-flight
  // reservation (reservePaidLane -> canAfford, 402).
  const videoCostWall = useVideoCostWall();

  // Inline quality selection. Fast/720p until the user clicks HD — never
  // auto-upgraded, which is what keeps the "explicit upgrade" property true.
  const [videoTierId, setVideoTierId] = useState<VideoQualityTier>(DEFAULT_VIDEO_TIER_ID);

  // Show the quality selector only while the DRAFT already routes to the video
  // lane, using the same predicate the send path uses.
  //
  // Same predicate, DIFFERENT input, and the asymmetry is the point: the send
  // path classifies the enriched message (draft + reply quote + DOM snippets +
  // send-time speech transcript), which is always a superset of the draft. So
  // the picker can never appear for a send that will NOT be a video — but it can
  // stay hidden for one that will. That case is handled where it matters, at the
  // send: no visible picker means no honoured selection, and the request goes out
  // at the cheap default. An earlier version of this comment claimed the two
  // surfaces read the same text; CAO disproved it on 6c59706a.
  const draftRoutesToVideo = useMemo(
    () =>
      isEveConversation &&
      isVideoLaneRequest({
        message: content,
        resolvedAgentId: addressesVideoMarketer(content) ? VIDEO_LANE_AGENT_ID : null,
      }),
    [content, isEveConversation]
  );

  // 1080p exists only as image->video: grok-imagine-video-1.5 reaches it but does
  // not accept a bare prompt, and grok-imagine-video (which does) stops at 720p.
  //
  // This was briefly fixed at 'text', because the request built below sent
  // prompt, tier and duration and NEVER the image bytes — a picker that widened
  // on an attachment was a promise the send could not keep. That gap is now
  // closed: the send below forwards the attached image's PATH, and MAIN (not
  // this renderer) re-reads that grant-verified file and computes its hash
  // before anything reaches the gateway. So deriving the mode from the actual
  // attachment is honest again — the request really does carry what the picker
  // shows.
  const videoInputMode: VideoInputMode = useMemo(
    () => (uploadFile.some((path) => isImageFile(path)) ? 'image' : 'text'),
    [uploadFile]
  );

  const dispatchSteer = useCallback(
    async (input: string, requestId?: string) => {
      const turnId = runtimeView.activeTurnId ?? (await waitForConversationActiveTurnId(conversation_id));
      if (!turnId) {
        throw new Error(
          t('conversation.commandQueue.activeTurnUnavailable', {
            defaultValue: 'The current run is not ready for a correction yet.',
          })
        );
      }

      const normalizedInput = input.trim();
      const inFlightKey = `${turnId}\u0000${normalizedInput}`;
      const existingRequest = activeSteerRequestsRef.current.get(inFlightKey);
      if (existingRequest) return existingRequest;

      const stableRequestId = requestId ?? steerRetryRequestIdsRef.current.get(inFlightKey) ?? uuid();
      if (!requestId) steerRetryRequestIdsRef.current.set(inFlightKey, stableRequestId);
      const pendingRequest = ipcBridge.acpConversation.steer.invoke({
        input: normalizedInput,
        conversation_id,
        turn_id: turnId,
        request_id: stableRequestId,
      });
      activeSteerRequestsRef.current.set(inFlightKey, pendingRequest);

      const clearActiveRequest = () => {
        if (activeSteerRequestsRef.current.get(inFlightKey) === pendingRequest) {
          activeSteerRequestsRef.current.delete(inFlightKey);
        }
      };
      void pendingRequest.then(() => {
        clearActiveRequest();
        if (!requestId && steerRetryRequestIdsRef.current.get(inFlightKey) === stableRequestId) {
          steerRetryRequestIdsRef.current.delete(inFlightKey);
        }
      }, clearActiveRequest);
      return pendingRequest;
    },
    [conversation_id, runtimeView.activeTurnId, t]
  );

  // The real dispatch (queue or execute) for an already-cleared message. Both
  // the normal send and the post-confirm video send route through this so the
  // queue/in-flight semantics are identical.
  const dispatchMessage = useCallback(
    async (
      message: string,
      agentFiles: string[],
      displayFiles: string[] = agentFiles,
      preparedContext?: string,
      managedVisualSourceCount?: number
    ) => {
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

      if (busyControlCommand?.mode === 'steer') {
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

      const queuedMessage =
        requestedBusyControlCommand && (requestedBusyControlCommand.mode === 'queue' || agentFiles.length > 0)
          ? requestedBusyControlCommand.input.replace(/^\/(?:queue|steer)\s+/i, '').trim()
          : message;

      if (
        shouldEnqueueConversationCommand({
          enabled: true,
          isBusy,
          hasPendingCommands,
        })
      ) {
        return (
          enqueue({
            input: queuedMessage,
            files: agentFiles,
            displayFiles,
            preparedContext,
            managedVisualSourceCount,
          }) !== null
        );
      }
      await executeCommand({
        input: queuedMessage,
        files: agentFiles,
        displayFiles,
        preparedContext,
        managedVisualSourceCount,
      });
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
      // S81/R3: bounded, fail-open project intent gate — always first, before
      // PDF prep or dispatch, and never touching executeCommand/sendMessage.
      await runProjectChatIntentGate({ conversation_id, message });

      if (documentPreparationInFlightRef.current) {
        controls.restoreDraftAndFiles();
        Message.warning(t('conversation.documents.preparationInProgress'));
        return false;
      }

      // Heavy-lane routing (DUX-6, FAIL-SAFE) classifies BEFORE any document
      // preparation runs — not after it. A video intent must never trigger
      // presentation/image cloud analysis: an attached image on a video send is
      // a VIDEO SOURCE, not a vision-analysis request, and running it through
      // that pipeline first would spend an unrelated cloud call and could
      // surface a consent/policy flow the video lane never asked for. Founder
      // review 2026-07-31 rejected the earlier ordering for exactly this: it ran
      // image/presentation prep for every send, including a video one, before
      // this check ever ran.
      //
      // NOTE the input. This classifies `message` — what SendBox hands to onSend,
      // which is the draft PLUS whatever SendBox added on the way: a reply quote,
      // DOM snippets, a speech transcript captured at send time. The quality pill
      // classifies the raw draft. So the two are NOT the same text, and `message`
      // is always the superset: the pill can be hidden for a send that does route
      // to video (quote a video request, answer "ja bitte"), but never visible for
      // one that does not. CAO proved this on 6c59706a; an earlier comment here
      // claimed the opposite and was wrong.
      const routesToVideo =
        isEveConversation &&
        isVideoLaneRequest({
          message,
          resolvedAgentId: addressesVideoMarketer(message) ? VIDEO_LANE_AGENT_ID : null,
        });

      if (routesToVideo) {
        // Only a single supported image source travels with a video request —
        // the exact file `videoInputMode` already looked at. Its PATH is
        // forwarded as-is; MAIN re-reads it through the grant-verified, bounded
        // local-image boundary and computes the base64/SHA-256 that actually
        // reaches the gateway. This never calls prepareImageFiles /
        // preparePresentationFiles, so the existing file-selection grant for
        // that image is left untouched for MAIN — no cloud vision call, no
        // sidecar, no visual-policy receipt for a video request.
        const attachedImagePath = allFiles.find((filePath) => isImageFile(filePath));
        controls.clearSelection();

        // A selection only counts if the user could SEE it. On the divergence
        // above the picker never appeared, so there is no choice to honour and we
        // fall to the cheap default rather than spending a stale HD pick that the
        // user cannot connect to this send. Structural, not documented: the
        // expensive direction is unreachable instead of merely discouraged.
        // Two guards, in order. A tier the user could not SEE does not count
        // (below), and a tier the provider cannot PRODUCE is refused rather than
        // silently downgraded — a downgrade would bill 720p for a 1080p promise.
        const selectedTier = draftRoutesToVideo ? videoTierId : DEFAULT_VIDEO_TIER_ID;
        const producibleTier = isVideoTierAvailable(selectedTier, { inputMode: videoInputMode })
          ? selectedTier
          : DEFAULT_VIDEO_TIER_ID;

        videoCostWall.requestVideo(
          { tierId: producibleTier },
          (resolved) => {
            // The ONLY provider job this send starts. An earlier revision ALSO
            // dispatched a `[EVE:VIDEO ...]`-stamped message into the normal ACP
            // turn — a second path that could ask the agent/runtime to execute
            // the same generation intent again. One user send now creates AT
            // MOST ONE provider video job: this call, and nothing else — no
            // message is sent to the agent for a managed video request.
            void ipcBridge.commandEve.videoGenerate
              .invoke({
                prompt: message,
                tierId: resolved.tierId,
                durationSeconds: DEFAULT_VIDEO_DURATION_SECONDS,
                conversationId: conversation_id,
                ...(attachedImagePath ? { imagePath: attachedImagePath } : {}),
              })
              .then((response) => {
                const outcome = response?.data;
                if (!response?.success || !outcome) {
                  Message.error({
                    content: t('credits.video.failed', {
                      defaultValue: 'Die Videoerstellung konnte nicht gestartet werden.',
                    }),
                    duration: 6000,
                  });
                  controls.restoreDraftAndFiles();
                  return;
                }
                if (outcome.ok === false) {
                  // The server's reason, not a generic sentence. Distinguishing
                  // "out of credits" from "1080p needs an image" is the whole
                  // point of the gateway returning six different refusals. No
                  // artifact is emitted on a refusal — there is nothing to show.
                  Message.error({ content: outcome.message, duration: 8000 });
                  controls.restoreDraftAndFiles();
                  return;
                }
                // conversationArtifact is the durable, path-based record MAIN
                // already saved to disk (and to its own local artifact store) —
                // NOT the raw base64 artifact. Emitting only when present keeps
                // this lane from ever showing a "success" with nothing to play.
                // MessageList renders it directly from the artifact list, so no
                // chat message needs to carry it.
                if (outcome.conversationArtifact) {
                  emitter.emit('acp.video.generated', {
                    conversation_id,
                    artifact: outcome.conversationArtifact,
                  });
                }
                // The tier is per REQUEST, not per conversation: "default stays
                // Fast/Standard" has to be true for the NEXT video, so a made
                // video ends its own tier here. Only here — see the failure
                // paths above, which deliberately leave the choice standing.
                setVideoTierId(DEFAULT_VIDEO_TIER_ID);
              })
              .catch(() => {
                Message.error({
                  content: t('credits.video.failed', {
                    defaultValue: 'Die Videoerstellung konnte nicht gestartet werden.',
                  }),
                  duration: 6000,
                });
                controls.restoreDraftAndFiles();
              });

            // The reset used to happen HERE, synchronously, before the outcome
            // was known — and an earlier comment defended that as deliberate.
            // A live 480p test proved it backwards: the request was refused,
            // the draft came back, and the picker read 720p. Resetting to the
            // default is only cheaper when the user picked HD; from 480p the
            // same line silently RAISES the price of the obvious next action,
            // which is to send the restored draft again. The reset now lives in
            // the success path, where the video it belonged to actually exists.
          },
          () => {
            controls.restoreDraftAndFiles();
          }
        );
        return true;
      }

      const hasDocumentFiles =
        isEveConversation &&
        allFiles.some(
          (file) => isCommandEvePdfPath(file) || isCommandEvePresentationPath(file) || isCommandEveImagePath(file)
        );
      if (hasDocumentFiles) {
        documentPreparationInFlightRef.current = true;
        markConversationDocumentPreparationStarted(conversation_id);
      }

      const pdfPreparedFiles = await preparePdfFiles(allFiles);
      // A cancelled/failed OCR gate must leave the draft and selected files intact.
      if (pdfPreparedFiles === null) {
        controls.restoreDraftAndFiles();
        documentPreparationInFlightRef.current = false;
        markConversationDocumentPreparationSettled(conversation_id);
        return false;
      }
      const visualSourceCount = pdfPreparedFiles.filter(
        (file) => isCommandEvePresentationPath(file) || isCommandEveImagePath(file)
      ).length;
      let visualAuthority:
        | {
            flowId: string;
            visualPolicyReceipt: CommandEveCloudVisualPolicyReceipt;
          }
        | undefined;
      if (isEveConversation && visualSourceCount > 6) {
        controls.restoreDraftAndFiles();
        documentPreparationInFlightRef.current = false;
        markConversationDocumentPreparationSettled(conversation_id);
        Message.error({
          content: t('conversation.visual.sourceLimit', {
            defaultValue: 'Select no more than six images or presentations per turn.',
          }),
          duration: 6000,
        });
        return false;
      }

      const flowId = visualSourceCount > 0 ? `visual_${uuid().replace(/-/g, '')}` : undefined;
      const issueVisualAuthority = async () => {
        if (!flowId) return undefined;
        try {
          const receiptResult = await ipcBridge.commandEve.cloudVisualPolicyReceipt.invoke({ flowId });
          if (!receiptResult.success || !receiptResult.data?.ok) {
            setDocumentPreparation({
              phase: 'presentation_error',
              fileCount: visualSourceCount,
              startedAt: Date.now(),
            });
            Message.error({
              content: t('conversation.visual.managedCloudFailed', {
                defaultValue: 'Cloud visual analysis is disabled or unavailable for this seat.',
              }),
              duration: 6000,
            });
            return undefined;
          }
          return { flowId, visualPolicyReceipt: receiptResult.data.receipt };
        } catch (error) {
          setDocumentPreparation({ phase: 'presentation_error', fileCount: visualSourceCount, startedAt: Date.now() });
          Message.error({
            content:
              getConversationRuntimeWorkspaceErrorMessage(error, t) ||
              t('conversation.visual.managedCloudFailed', {
                defaultValue: 'Cloud visual analysis is disabled or unavailable for this seat.',
              }),
            duration: 6000,
          });
          return undefined;
        }
      };
      const stopAfterVisualAuthorityFailure = () => {
        controls.restoreDraftAndFiles();
        documentPreparationInFlightRef.current = false;
        markConversationDocumentPreparationSettled(conversation_id);
      };

      // Always let Main inspect PPTX/image sources locally first. A receipt is
      // requested only when Main reports that uncached cloud work is pending; if
      // every sidecar is already local, issuance is deferred until marker minting.
      let presentationPreparation = await preparePresentationFiles(pdfPreparedFiles);
      if (presentationPreparation === null) {
        controls.restoreDraftAndFiles();
        documentPreparationInFlightRef.current = false;
        markConversationDocumentPreparationSettled(conversation_id);
        return false;
      }
      let imagePreparation = await prepareImageFiles(presentationPreparation.files);
      if (imagePreparation === null) {
        controls.restoreDraftAndFiles();
        documentPreparationInFlightRef.current = false;
        markConversationDocumentPreparationSettled(conversation_id);
        return false;
      }

      if (presentationPreparation.requiresVisualPolicyReceipt || imagePreparation.requiresVisualPolicyReceipt) {
        visualAuthority = await issueVisualAuthority();
        if (!visualAuthority) {
          stopAfterVisualAuthorityFailure();
          return false;
        }

        if (presentationPreparation.requiresVisualPolicyReceipt) {
          const retriedPresentationPreparation = await preparePresentationFiles(pdfPreparedFiles, visualAuthority);
          if (retriedPresentationPreparation === null) {
            controls.restoreDraftAndFiles();
            documentPreparationInFlightRef.current = false;
            markConversationDocumentPreparationSettled(conversation_id);
            return false;
          }
          presentationPreparation = retriedPresentationPreparation;
        }

        if (imagePreparation.requiresVisualPolicyReceipt) {
          const retriedImagePreparation = await prepareImageFiles(presentationPreparation.files, visualAuthority);
          if (retriedImagePreparation === null) {
            controls.restoreDraftAndFiles();
            documentPreparationInFlightRef.current = false;
            markConversationDocumentPreparationSettled(conversation_id);
            return false;
          }
          imagePreparation = retriedImagePreparation;
        } else {
          imagePreparation = {
            ...imagePreparation,
            files: Array.from(new Set([...presentationPreparation.files, ...imagePreparation.files])),
          };
        }
      }

      const visualContexts = [...presentationPreparation.contexts, ...imagePreparation.contexts];
      const composedContext = visualContexts.length > 0 ? composeCommandEvePreparedContext(visualContexts) : null;
      if (composedContext?.ok === false) {
        controls.restoreDraftAndFiles();
        documentPreparationInFlightRef.current = false;
        markConversationDocumentPreparationSettled(conversation_id);
        Message.error({
          content:
            composedContext.reason_code === 'EVE_PREPARED_CONTEXT_TOO_LARGE'
              ? t('conversation.presentation.contextTooLarge', {
                  defaultValue: 'The prepared presentation context is too large. Split the deck and try again.',
                })
              : t('conversation.presentation.prepareFailed'),
          duration: 6000,
        });
        return false;
      }
      const preparedContext = composedContext?.context;
      const visuallyPreparedFiles = imagePreparation.files;

      controls.clearSelection();

      try {
        const accepted = await dispatchMessage(
          message,
          visuallyPreparedFiles,
          allFiles,
          preparedContext,
          visualContexts.length || undefined
        );
        if (!accepted) controls.restoreDraftAndFiles();
        return accepted;
      } catch (error) {
        controls.restoreDraftAndFiles();
        throw error;
      } finally {
        documentPreparationInFlightRef.current = false;
        if (hasDocumentFiles) {
          setDocumentPreparation(null);
          markConversationDocumentPreparationSettled(conversation_id);
        }
      }
    },
    [
      conversation_id,
      dispatchMessage,
      eveInference.selection,
      isEveConversation,
      preparePdfFiles,
      prepareImageFiles,
      preparePresentationFiles,
      videoCostWall.requestVideo,
      videoTierId,
      draftRoutesToVideo,
      videoInputMode,
    ]
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
      // FOUNDER CONTRACT (MAT-1749): no cloud intelligence ladder on mobile
      // either. This entry is now the LANE choice — EVE Cloud (the unnamed
      // default) vs the private local lane — and carries NO tier nomenclature.
      // MAX is reached through the composer's MAX toggle, nowhere else.
      const cloudLaneLabel = t('conversation.eveInference.cloudLane', { defaultValue: 'EVE Cloud' });
      const localItems = eveInference.groups.find((group) => group.kind === 'local')?.items ?? [];
      const laneOptions: MobileActionSheetOption[] = [
        {
          key: EVE_DEFAULT_INFERENCE_SELECTION,
          label: cloudLaneLabel,
          description: t('conversation.eveInference.cloudLaneDescription', {
            defaultValue: 'EVE arbeitet in der Cloud.',
          }),
          active: isEveInferenceSelection(eveInference.selection),
        },
        ...localItems.map((item) => ({
          key: item.value,
          label: `${t('common.localModel', { defaultValue: 'Lokal' })} · ${item.label}`,
          description: item.sublabel,
          active: item.value === eveInference.selection && !item.disabled,
          disabled: item.disabled,
        })),
      ];
      const currentLaneLabel = isEveInferenceSelection(eveInference.selection)
        ? cloudLaneLabel
        : `${t('common.localModel', { defaultValue: 'Lokal' })} · ${eveInference.activeItem?.label ?? ''}`.trim();
      entries.push({
        key: 'eve-inference',
        icon: <Brain theme='outline' size='16' />,
        label: t('conversation.eveInference.lane', { defaultValue: 'Verarbeitung' }),
        meta: currentLaneLabel,
        submenu: {
          title: t('conversation.eveInference.lane', { defaultValue: 'Verarbeitung' }),
          options: laneOptions,
          // The cloud row commits the UNNAMED default. Re-engaging MAX is the
          // MAX toggle's job — a lane switch must never silently re-meter.
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
        loading={isBusy || documentPreparationInFlight}
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
          // start screen.
          //
          // FOUNDER CONTRACT (MAT-1749): an EVE composer shows NO cloud
          // intelligence ladder at all. The routine lane is UNNAMED — it is
          // simply EVE working — and the only cloud-intelligence affordance is
          // the additive MAX toggle. So `modelSlot` is empty for EVE; every
          // other ACP backend keeps its existing AcpModelSelector. Choosing the
          // LOCAL lane is a deliberate Settings → Modell decision, not a
          // composer control.
          // Order: [MAX · EVE control · mic · send]. SendBox owns send.
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
              isMobile || isEveConversation ? null : (
                <AcpModelSelector conversation_id={conversation_id} backend={backend} waitForWarmup />
              )
            }
            // Only an EVE conversation gets the MAX lane control — and therefore
            // only an EVE composer can ever wear the MAX visual state. This is
            // the composer's ONE cloud-intelligence affordance: off = EVE's
            // normal unnamed behaviour, on = the MAX state.
            maxSlot={isEveConversation ? <EveMaxToggle disabled={isBusy} /> : null}
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
                    disabled: false,
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
            {/* Quality picker for the pending video. Renders in the draft band,
                never as an overlay — it cannot intercept or delay a send. */}
            <VideoQualityPill
              visible={draftRoutesToVideo}
              value={videoTierId}
              onChange={setVideoTierId}
              inputMode={videoInputMode}
            />
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
