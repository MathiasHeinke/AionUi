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
import SpeechInputButton from '@/renderer/components/chat/SpeechInputButton';
import { appendSpeechTranscript } from '@/renderer/hooks/system/useSpeechInput';
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
import { createModeLabelFormatter } from '@/renderer/utils/model/agentModes';
import { useEveInferenceSelection } from '@/renderer/hooks/agent/useEveInferenceSelection';
import { isEveInferenceSelection } from '@/common/config/eveInferenceCore';
import { isCommandEveAcpConversation } from '@/common/config/commandEveShell';
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
  shouldEnqueueConversationCommand,
  useConversationCommandQueue,
  type ConversationCommandQueueItem,
} from '@/renderer/pages/conversation/platforms/useConversationCommandQueue';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import { getConversationRuntimeWorkspaceErrorMessage } from '@/renderer/pages/conversation/utils/conversationCreateError';
import { warmupConversation } from '@/renderer/pages/conversation/utils/warmupConversation';
import { useTeamPermission } from '@/renderer/pages/team/hooks/TeamPermissionContext';
import { allSupportedExts } from '@/renderer/services/FileService';
import { iconColors } from '@/renderer/styles/colors';
import { emitter, useAddEventListener } from '@/renderer/utils/emitter';
import { mergeFileSelectionItems } from '@/renderer/utils/file/fileSelection';
import { buildDisplayMessage } from '@/renderer/utils/file/messageFiles';
import { Message, Tag } from '@arco-design/web-react';
import { Brain, MagicHat, Shield } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildSendFailureError } from './buildSendFailureError';
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
  const isEveConversation = isCommandEveAcpConversation(backend);
  const eveInference = useEveInferenceSelection();

  // Model id handed to the context indicator/popover. On an EVE conversation the
  // runtime `request_trace.model_id` carries Hermes' LOCAL config model (one
  // managed Ollama config, reported on cloud turns too), so it reads as a local
  // 64k model — that is exactly why the cloud Max popover showed "55K / 65.5K"
  // instead of the model's real ~1M window: the resolver could not tell the turn
  // was a CLOUD turn from that local-looking id. When an EVE Inference (cloud)
  // tier is the active selection AND the cloud bearer is usable, use that cloud
  // SELECTION id (e.g. "command-eve-inference:eve-max") so the window resolver
  // detects the cloud lane and floors at the model's real window. When a LOCAL
  // tier is selected (or the bearer is missing so a send silently falls back to
  // local), keep the live runtime model id whose 64k IS the real local window.
  const cloudSelectionActive =
    isEveConversation && isEveInferenceSelection(eveInference.selection) && eveInference.cloudBearerAvailable === true;
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
  }, [conversation_id, isMobile, isMobileSheetOpen, prepareRuntimeSync]);

  const handleSheetModeChange = useCallback(
    async (mode: string) => {
      if (mode === currentMode) return;
      try {
        await prepareRuntimeSync();
        const confirmed = await ipcBridge.acpConversation.setMode.invoke({ conversation_id, mode });
        const confirmedMode = confirmed.mode || mode;
        setCurrentMode(confirmedMode);
        if (backend) void savePreferredMode(backend, confirmedMode);
        if (isLeaderInTeam) teamPermission?.propagateMode?.(confirmedMode);
        Message.success(t('agentMode.switchSuccess'));
      } catch (error) {
        console.error('[AcpSendBox] Failed to switch mode via sheet:', error);
        Message.error(t('agentMode.switchFailed'));
      }
    },
    [backend, conversation_id, currentMode, isLeaderInTeam, prepareRuntimeSync, t, teamPermission]
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

  const addOrUpdateMessage = useAddOrUpdateMessage(); // Move this here so it's available in useEffect
  const addOrUpdateMessageRef = useLatestRef(addOrUpdateMessage);
  const runtimeView = useConversationRuntimeView(conversation_id);

  // Shared file handling logic
  const { handleFilesAdded, clearFiles } = useSendBoxFiles({
    atPath,
    uploadFile,
    setAtPath,
    setUploadFile,
  });
  const isBusy = runtimeView.isProcessing || !runtimeView.canSendMessage;

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

  // Check for and send initial message from guid page
  useAcpInitialMessage({
    conversation_id: conversation_id,
    backend,
    workspacePath,
    setAiProcessing,
    resetState,
    markSendStarted: runtimeView.markSendStarted,
    markSendAccepted: runtimeView.markSendAccepted,
    markSendFailed: runtimeView.markSendFailed,
    checkAndUpdateTitle,
    addOrUpdateMessage: addOrUpdateMessageRef.current,
  });

  const executeCommand = useCallback(
    async ({ input, files }: Pick<ConversationCommandQueueItem, 'input' | 'files'>) => {
      const displayMessage = buildDisplayMessage(input, files, workspacePath || '');

      runtimeView.markSendStarted();
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

  // The real dispatch (queue or execute) for an already-cleared message. Both
  // the normal send and the post-confirm video send route through this so the
  // queue/in-flight semantics are identical.
  const dispatchMessage = useCallback(
    async (message: string, allFiles: string[]) => {
      if (
        shouldEnqueueConversationCommand({
          enabled: true,
          isBusy,
          hasPendingCommands,
        })
      ) {
        enqueue({ input: message, files: allFiles });
        return;
      }
      await executeCommand({ input: message, files: allFiles });
    },
    [enqueue, executeCommand, hasPendingCommands, isBusy]
  );

  const onSendHandler = async (message: string) => {
    const atPathFiles = atPath.map((item) => (typeof item === 'string' ? item : item.path));
    const allFiles = [...uploadFile, ...atPathFiles];

    clearFiles();
    emitter.emit('acp.selected.file.clear');

    // Heavy-lane guardrail (DUX-6, FAIL-SAFE): in a Command EVE conversation a
    // request that reaches the heavy video lane by ANY path is routed through the
    // cost-wall first. The gate is NOT the NL regex alone — it ALSO fires when the
    // message addresses the videomarketer worker by name/role (and, where a
    // resolver surfaces it, the resolved video capability). A regex false-negative
    // can no longer silently bypass the most expensive lane.
    const routesToVideo = isEveConversation &&
      isVideoLaneRequest({
        message,
        // The videomarketer is addressed in-prompt today; surface that as a
        // resolved-worker signal so the wall fires even when the verb/noun regex
        // misses. (A backend resolver may later pass resolvedVideoCapability.)
        resolvedAgentId: addressesVideoMarketer(message) ? VIDEO_LANE_AGENT_ID : null,
      });

    if (routesToVideo) {
      // `requestVideo` opens the wall (transparent cost preview) and only fires
      // the real dispatch from the user's explicit confirm. DUX-5: on confirm we
      // dispatch the RESOLVED video request — the original text PLUS an explicit
      // video directive carrying the confirmed tier/resolution/credit ceiling —
      // not the unmodified original message. Confirming now actually routes a
      // video request at exactly the spec the user approved.
      videoCostWall.requestVideo({}, (resolved) => {
        const resolvedMessage = buildResolvedVideoMessage(message, resolved);
        void dispatchMessage(resolvedMessage, allFiles);
      });
      return;
    }

    await dispatchMessage(message, allFiles);
  };

  const handleEditQueuedCommand = useCallback(
    (item: ConversationCommandQueueItem) => {
      remove(item.id);
      setContent(item.input);
      setUploadFile(Array.from(new Set(item.files)));
      setAtPath([]);
      emitter.emit('acp.selected.file.clear');
    },
    [remove, setAtPath, setContent, setUploadFile]
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

    const modeOptions: MobileActionSheetOption[] = availableAgentModes.map((mode) => ({
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
          label: group.kind === 'eve' ? `EVE Cloud · ${item.label}` : `${t('common.localModel', { defaultValue: 'Lokal' })} · ${item.label}`,
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
    availableAgentModes,
    canSwitchModel,
    currentMode,
    eveInference,
    formatModeLabel,
    handleSheetModeChange,
    isEveConversation,
    isMobile,
    loadedMcpStatuses,
    loadedSkills,
    model_info,
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
    // UI state is still reset via finally.
    const turnId = runtimeView.activeTurnId;
    if (!turnId) {
      resetState();
      resetActiveExecution('stop');
      return;
    }
    runtimeView.markStopRequested(turnId);
    try {
      const result = await ipcBridge.conversation.stop.invoke({ conversation_id, turn_id: turnId });
      runtimeView.markStopAcknowledged(turnId, result.runtime);
    } catch (error) {
      console.warn('[AcpSendBox] stop request failed', error);
      runtimeView.resetLocalGate('stop_failed');
    } finally {
      resetState();
      resetActiveExecution('stop');
    }
  };

  return (
    <div className='max-w-800px w-full mx-auto flex flex-col mt-auto mb-16px'>
      {/* Video PRE-SUBMIT cost-wall (alpha.9 OI#2): the wall opens for a pending
          video-generation request and requires an explicit confirm before the
          actual request is dispatched. Fast/720p default; 1080p explicit upgrade. */}
      <VideoCostWall
        visible={videoCostWall.visible}
        durationSeconds={videoCostWall.durationSeconds}
        onCancel={videoCostWall.cancel}
        onConfirm={videoCostWall.confirm}
      />
      <CommandQueuePanel
        items={queuedCommands}
        paused={isQueuePaused}
        interactionLocked={isQueueInteractionLocked}
        onPause={pause}
        onResume={resume}
        onInteractionLock={lockInteraction}
        onInteractionUnlock={unlockInteraction}
        onEdit={handleEditQueuedCommand}
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
        loading={isBusy}
        disabled={false}
        placeholder={t('acp.sendbox.placeholder', {
          backend: agent_name || backend,
          defaultValue: `Send message to {{backend}}...`,
        })}
        onStop={handleStop}
        className='z-10'
        onFilesAdded={handleFilesAdded}
        hasPendingAttachments={uploadFile.length > 0 || atPath.length > 0}
        enableBtw={isSideQuestionSupported({ type: 'acp', backend })}
        supportedExts={allSupportedExts}
        defaultMultiLine={!isMobile}
        lockMultiLine={!isMobile}
        tools={
          <FileAttachButton
            openFileSelector={openFileSelector}
            onLocalFilesAdded={handleFilesAdded}
            loadedMcpStatuses={loadedMcpStatuses}
          />
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
                  onModeChanged={isLeaderInTeam ? teamPermission?.propagateMode : undefined}
                  beforeRuntimeSync={prepareRuntimeSync}
                />
              ) : null
            }
            contextSlot={
              /* Consumed-context ring + credits popover (Claude-Code-style). Quiet
                 until the first acp_context_usage frame arrives (renders null with no
                 tokenUsage). Model-sensitive window via the live request_trace model. */
              <ContextUsageIndicator
                tokenUsage={tokenUsage}
                context_limit={context_limit}
                modelId={indicatorModelId}
              />
            }
            micSlot={
              <SpeechInputButton
                disabled={isBusy}
                locale={i18n?.language || 'en-US'}
                onTranscript={handleSpeechTranscript}
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
