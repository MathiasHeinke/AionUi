import { ipcBridge } from '@/common';
import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import { userVisibleConversationMcpStatuses } from '@/common/config/eveManagedMcpCore';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { isSideQuestionSupported } from '@/common/chat/sideQuestion';
import { parseError, uuid } from '@/common/utils';
import AgentModeSelector from '@/renderer/components/agent/AgentModeSelector';
import AcpModelSelector from '@/renderer/components/agent/AcpModelSelector';
import EveMaxToggle from '@/renderer/components/agent/EveMaxToggle';
import ContextUsageIndicator from '@/renderer/components/agent/ContextUsageIndicator';
import ComposerContextDeck from '@/renderer/components/chat/ComposerContextDeck';
import ComposerReferencePreview from '@/renderer/components/chat/ComposerReferencePreview';
import { resolveComposerAttachmentPresentation } from '@/renderer/components/chat/composerAttachmentPresentation';
import UnifiedSendBar from '@/renderer/components/chat/UnifiedSendBar';
import WorkProductModeSelector, { WorkProductModeHeader } from '@/renderer/components/chat/WorkProductModeSelector';
import VoiceDialogueControl from '@/renderer/components/chat/voiceDialogue/VoiceDialogueControl';
import { useVoiceDialogue } from '@/renderer/components/chat/voiceDialogue/useVoiceDialogue';
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
import { useEveMaxAuthority } from '@/renderer/hooks/agent/useEveMaxAuthority';
import { COMPOSER_GLOW_ATTRIBUTE, resolveComposerGlowState } from '@/renderer/components/agent/eveComposerGlowCore';
import { isEveInferenceSelection, resolveWireTierFromSelection } from '@/common/config/eveInferenceCore';
import { scrubModelIdentifiers } from '@/common/config/modelIdentifierScrub';
import { CLOUD_MODEL_IDENTIFIERS } from '@/renderer/utils/model/modelContextLimits';
import { isCommandEveAcpConversation } from '@/common/config/commandEveShell';
import { type EveLadderRung } from '@/common/config/eveAuthorityCore';
import { resolveStoredGrant } from '@/common/config/eveAuthorityStoreCore';
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
import { useActiveSeatId } from '@/renderer/hooks/useActiveSeatId';
import { useAddOrUpdateMessage, useMessageList } from '@/renderer/pages/conversation/Messages/hooks';
import { emitAcpPerformanceMark } from '@/renderer/utils/performance/acpPerformanceMarks';
import {
  buildConversationBusyControlCommand,
  shouldEnqueueConversationCommand,
  useConversationCommandQueue,
  type ConversationBusyControlMode,
  type ConversationCommandDispatchResult,
  type ConversationCommandQueueItem,
} from '@/renderer/pages/conversation/platforms/useConversationCommandQueue';
import ConversationBusyModeControl from '@/renderer/pages/conversation/platforms/ConversationBusyModeControl';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import {
  getConversationRuntimeViewSnapshot,
  waitForConversationActiveTurnId,
  type ConversationRuntimeSeatTicket,
} from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';
import {
  markConversationDocumentPreparationSettled,
  markConversationDocumentPreparationStarted,
  useConversationDocumentPreparation,
} from '@/renderer/pages/conversation/runtime/conversationDocumentPreparationStore';
import { getConversationRuntimeWorkspaceErrorMessage } from '@/renderer/pages/conversation/utils/conversationCreateError';
import {
  getWarmupConversationStatus,
  settleConversationWarmupForSend,
  warmupConversation,
} from '@/renderer/pages/conversation/utils/warmupConversation';
import { useTeamPermission } from '@/renderer/pages/team/hooks/TeamPermissionContext';
import { allSupportedExts } from '@/renderer/services/FileService';
import { emitter, useAddEventListener } from '@/renderer/utils/emitter';
import { mergeFileSelectionItems } from '@/renderer/utils/file/fileSelection';
import { buildDisplayMessage } from '@/renderer/utils/file/messageFiles';
import {
  isCommandEvePdfPath,
  mergeCommandEvePreparedPdfFiles,
  validateCommandEvePdfPrepareReceipt,
} from '@/common/config/evePdfIntelligenceCore';
import { isCommandEvePresentationPath } from '@/common/config/evePresentationIntelligenceCore';
import { isCommandEveImagePath } from '@/common/config/eveImageIntelligenceCore';
import {
  buildCommandEveAttachmentGroundingRequest,
  groundingExpectationFromPdf,
  validateCommandEveAttachmentGroundingReceipt,
  type CommandEveAttachmentGroundingExpectation,
  type CommandEveAttachmentGroundingRequest,
} from '@/common/config/eveAttachmentGroundingCore';
import { composeCommandEvePreparedContext } from '@/common/config/evePreparedContextCore';
import { buildCommandEveAgentTurnInput } from '@/common/config/eveArtifactContextEnvelopeCore';
import {
  DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION,
  composerWorkProductModeSupportsImageGeneration,
  consumeComposerWorkProductSelection,
  renderComposerSelectedArtifactPreparedContext,
  resolveComposerWorkProductInjectedSkills,
  selectExplicitComposerWorkProductMode,
  type ComposerWorkProductMode,
  type ComposerWorkProductSelection,
} from '@/common/config/composerWorkProductModeCore';
import {
  resolveComposerArtifactReference,
  type ComposerArtifactReference,
} from '@/common/config/composerArtifactReferenceCore';
import {
  extractCommandEveManagedVisualTurnToken,
  resolveCommandEveManagedVisualPreferredTier,
} from '@/common/config/eveManagedVisualTurnCore';
import {
  createCommandEveCloudVisualFlowId,
  type CommandEveCloudVisualPolicyReceipt,
} from '@/common/config/visual/cloudVisualPolicyCore';
import { Menu, Message, Modal, Tag } from '@arco-design/web-react';
import { Brain, EditOne, MagicHat, Shield, Time } from '@renderer/components/icons';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { describeOfficeArtifactRefusal } from '@renderer/services/i18n/officeArtifactRefusal';
import { buildSendFailureError } from './buildSendFailureError';
import { runProjectChatIntentGate } from '@/renderer/pages/conversation/shared/projectChatIntentGate';
import AcpDocumentPreparationStatus, { type AcpDocumentPreparationState } from './AcpDocumentPreparationStatus';
import AcpVisionEnablementPrompt from './AcpVisionEnablementPrompt';
import { readSelectedPdfArtifactSourcePath, resolveManagedArtifactInput } from './resolveManagedArtifactInput';
import { useCommandEveVisualPreparation } from './useCommandEveVisualPreparation';
import { stripEmbeddedJsonFromSendFailureText, useAcpInitialMessage } from './useAcpInitialMessage';
import type { UseAcpMessageReturn } from './useAcpMessage';
import { MAX_VIDEO_REFERENCE_AUDIOS, VIDEO_PRESET_VOICES, type VideoModeKind } from '@/common/config/videoCostCore';
import {
  useVideoComposerSelection,
  type VideoDraftSelection,
} from '@/renderer/components/billing/useVideoComposerSelection';
import VideoQualityPill from '@/renderer/components/billing/VideoQualityPill';
import ImageAspectRatioPill from '@/renderer/components/billing/ImageAspectRatioPill';
import ImageModelPill from '@/renderer/components/billing/ImageModelPill';
import ImageReferenceCeilingHint from '@/renderer/components/billing/ImageReferenceCeilingHint';
import { useImageComposerSelection } from '@/renderer/components/billing/useImageComposerSelection';
import { resolveReferenceCapableImageModelTier } from '@/common/config/eveImageModelRegistryCore';
import { isImageFile } from '@/renderer/pages/conversation/Preview/fileUtils';
import { configService } from '@/common/config/configService';
import { estimateVideoEditCredits } from '@/common/config/videoEditRequestCore';
import { isVideoEditEligibleTier } from '@/common/config/videoGenerationRequestCore';
import {
  isUsableMediaEditSource,
  isVisibleConversationArtifact,
  useConversationArtifacts,
} from '@renderer/pages/conversation/Messages/artifacts';
import type { ProjectWorkspaceConversationArtifactDTO } from '@/common/types/project-workspace/ui';

/**
 * MAT-1769. Thrown ONLY by the marker-minting receipt read inside
 * `executeCommand` when Main reports the cloud visual policy DISABLED (every
 * sidecar was already cached, so no earlier wall fired). `submitMessage` catches
 * it and raises the one-time in-chat enablement prompt instead of an error; it
 * must never pass through the generic send-failure rendering, which is why it
 * is a type rather than a message string.
 */
class CommandEveVisionPolicyDisabledError extends Error {
  constructor() {
    super('EVE_VISION_POLICY_DISABLED');
    this.name = 'CommandEveVisionPolicyDisabledError';
  }
}

type AcpDispatchResult = ConversationCommandDispatchResult;

const COMMAND_EVE_AUTHORITY_RUNG_KEYS: Readonly<Record<EveLadderRung, string>> = {
  0: 'authority.rung.watch',
  1: 'authority.rung.ask',
  2: 'authority.rung.routine',
  3: 'authority.rung.work',
  4: 'authority.rung.independent',
  5: 'authority.rung.full',
};

const useAcpSendBoxDraft = getSendBoxDraftHook('acp', {
  _type: 'acp',
  atPath: [],
  content: '',
  uploadFile: [],
});

const EMPTY_AT_PATH: Array<string | FileOrFolderItem> = [];
const EMPTY_UPLOAD_FILES: string[] = [];

/**
 * 1.820.4 (MAT-1772) — pick the durable project title for the composer chip:
 * the NEWEST successful (state === 'completed') project workspace artifact of
 * the current conversation. Ordering keys off (updated_at, created_at) so a
 * re-completed artifact wins; anything not completed or title-less is ignored.
 * The payload is path-free by main-side construction — only the title crosses.
 */
export const selectNewestCompletedProjectTitle = (
  artifacts: readonly ProjectWorkspaceConversationArtifactDTO[]
): string | null => {
  let newest: ProjectWorkspaceConversationArtifactDTO | null = null;
  for (const artifact of artifacts) {
    if (artifact.payload.state !== 'completed') continue;
    if (typeof artifact.payload.project_title !== 'string' || artifact.payload.project_title.trim().length === 0) {
      continue;
    }
    if (
      !newest ||
      artifact.updated_at > newest.updated_at ||
      (artifact.updated_at === newest.updated_at && artifact.created_at >= newest.created_at)
    ) {
      newest = artifact;
    }
  }
  return newest ? newest.payload.project_title : null;
};

/**
 * Track the newest completed project artifact title for a conversation. The
 * durable main-side store is the authority: initial list + re-list on every
 * `artifact-changed` push for this conversation (never a renderer-side guess).
 */
const useNewestCompletedProjectTitle = (conversationId: string): string | null => {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // The project-workspace bridge is additive (1.820.4): a renderer host or
    // test double without it simply never shows the durable chip — the
    // composer itself must never crash on the absent namespace.
    const workspaceBridge = (ipcBridge as Partial<typeof ipcBridge>).projectWorkspace;
    if (!workspaceBridge) return undefined;
    const refresh = () =>
      workspaceBridge.listConversationArtifacts
        .invoke({ conversation_id: conversationId })
        .then((artifacts) => {
          if (!cancelled) setTitle(selectNewestCompletedProjectTitle(artifacts ?? []));
        })
        .catch(() => {
          /* a missing artifact store must never blank the composer */
        });
    void refresh();
    const unsubscribe = workspaceBridge.artifactChanged.on((payload) => {
      if (payload.conversation_id !== conversationId) return;
      void refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [conversationId]);
  return title;
};

const useSendBoxDraft = (conversation_id: string, seatId: string) => {
  const { data, mutate } = useAcpSendBoxDraft(conversation_id, seatId);
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
    running,
    aiProcessing,
    setAiProcessing,
    resetState,
    hasThinkingMessage,
    slashCommands,
    fetchSlashCommands,
    tokenUsage,
    context_limit,
    runtimeActivity,
    beginSubmitActivity,
    bindSubmitActivityTurn,
    clearSubmitActivity,
    lastCompletedTurn,
    quotaWall,
  } = messageState;
  const { t, i18n } = useTranslation();
  const activeSeatId = useActiveSeatId();
  const teamPermission = useTeamPermission();
  // In team mode, all agents show the permission mode selector (members don't propagate)
  const showModeSelector = true;
  const isLeaderInTeam = teamPermission && conversation_id === teamPermission.leaderConversationId;
  const { checkAndUpdateTitle } = useAutoTitle();
  const { atPath, uploadFile, setAtPath, setUploadFile, content, setContent } = useSendBoxDraft(
    conversation_id,
    activeSeatId
  );
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
  // MAT-1769 — the pending send parked behind the one-time Vision enablement
  // prompt. Non-null renders the in-chat card in the draft band; the exact
  // send arguments travel with it so "Vision aktivieren" can re-drive the
  // identical send after the policy flips, with the draft already restored.
  const [visionEnablementPending, setVisionEnablementPending] = useState<{
    seatTicket: ConversationRuntimeSeatTicket;
    message: string;
    allFiles: string[];
    controls: { clearSelection: () => void; restoreDraftAndFiles: () => void };
  } | null>(null);
  const [visionEnablementBusy, setVisionEnablementBusy] = useState(false);
  const documentPreparationInFlightRef = useRef(false);
  const documentPreparationTicketRef = useRef<ConversationRuntimeSeatTicket | null>(null);
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
  // Display and spend preparation consume the same pure resolver as the
  // clarify card. Primitive snapshots stay stable even when a test double or
  // config backend reconstructs JSON values on every read.
  const subscribeEveAuthority = useCallback((listener: () => void) => {
    const unsubscribeAuthority = configService.subscribe('commandEve.authority', listener);
    const unsubscribeLegacy = configService.subscribe('acp.config', listener);
    return () => {
      unsubscribeAuthority();
      unsubscribeLegacy();
    };
  }, []);
  const readEveAuthorityLadder = useCallback(
    () => resolveStoredGrant(configService.get('commandEve.authority'), configService.get('acp.config')).ladder,
    []
  );
  const eveAuthorityLadder = useSyncExternalStore(
    subscribeEveAuthority,
    readEveAuthorityLadder,
    readEveAuthorityLadder
  );
  const eveAuthorityLabel = useMemo(() => {
    if (!isEveConversation) return undefined;
    return t(`commandEve.${COMMAND_EVE_AUTHORITY_RUNG_KEYS[eveAuthorityLadder]}.title`);
  }, [eveAuthorityLadder, isEveConversation, t]);
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

  // Command EVE (Hermes) conversations expose NO cloud intelligence ladder. There
  // is no tier picker here any more: the composer offers an UNNAMED default plus
  // the additive MAX toggle, and nothing else. Choosing the private LOCAL lane is a
  // deliberate opt-in in Settings → Modell, not a composer control.
  //
  // (This comment used to name "Standard/High/Max + Private" — a picker that no
  // longer exists. Stale text on a user-facing surface is worse than most: it is
  // what the next reader builds against.)
  //
  // Same persistence key as every other surface, so a switch made anywhere takes
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

  // SUBMISSION HOLD. When MAIN reports the lane HELD — MAX intent on a seat whose
  // entitlement is not yet verified — this composer must not submit. Main refuses
  // the turn anyway (it builds no route), so this is not the spend control; it is
  // the surface being honest instead of letting the user fire a turn that will
  // only come back as an error. Read from the SAME authority that paints the MAX
  // state, so the composer cannot be held while claiming a lane, or vice versa.
  const { entitlementPending, maxActive } = useEveMaxAuthority();
  const eveSendHeld = isEveConversation && entitlementPending;

  // 1.820.5 (MAT-1773) — the MAX composer glow STATE MODEL. One attribute on
  // the composer surface, derived from the SAME truth the runtime status
  // footer reads (`runtimeActivity.phase`) and the SAME main-process MAX
  // authority the toggle paints from — never a parallel source. The stylesheet
  // owns every animation; this only stamps the state. `off` removes the
  // attribute, so the standard composer keeps its neutral look exactly.
  const composerRootRef = useRef<HTMLDivElement>(null);
  const composerGlowState = resolveComposerGlowState({ maxActive, phase: runtimeActivity.phase });
  useEffect(() => {
    const surface = composerRootRef.current?.querySelector<HTMLElement>('.eve-composer-surface');
    if (!surface) return;
    if (composerGlowState === 'off') {
      surface.removeAttribute(COMPOSER_GLOW_ATTRIBUTE);
      return;
    }
    surface.setAttribute(COMPOSER_GLOW_ATTRIBUTE, composerGlowState);
    return () => surface.removeAttribute(COMPOSER_GLOW_ATTRIBUTE);
  }, [composerGlowState]);

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
        // SCRUBBED (MAT-1749): the builder's own fallback is the RAW upstream
        // string, so every rendered use of it has to go through the scrub.
        Message.error(
          scrubModelIdentifiers(getConversationRuntimeWorkspaceErrorMessage(error, t), CLOUD_MODEL_IDENTIFIERS)
        );
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
  const messageList = useMessageList();
  const addOrUpdateMessageRef = useLatestRef(addOrUpdateMessage);
  const runtimeView = useConversationRuntimeView(conversation_id);
  const activeSteerRequestsRef = useRef(new Map<string, Promise<Exclude<AcpDispatchResult, 'rejected'>>>());
  const steerRetryRequestIdsRef = useRef(new Map<string, string>());

  // Shared file handling logic
  const { handleFilesAdded, clearFiles } = useSendBoxFiles({
    atPath,
    uploadFile,
    setAtPath,
    setUploadFile,
  });
  const isBusy = runtimeView.isProcessing || !runtimeView.canSendMessage;
  const conversationMessages = useMemo(
    () => messageList.filter((message) => message.conversation_id === conversation_id),
    [conversation_id, messageList]
  );
  const voiceDialogue = useVoiceDialogue({
    activeTurnId: runtimeView.activeTurnId,
    available: isEveConversation,
    completion: lastCompletedTurn,
    conversationId: conversation_id,
    isTurnActive: running || aiProcessing || runtimeView.isProcessing,
    language: i18n?.language,
    messages: conversationMessages,
    speechStatus: speechInputStatus,
    turnErrored: runtimeActivity.phase === 'error',
  });

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

  const conversationArtifacts = useConversationArtifacts();
  const imageModelRegistryRevisionRef = useRef<string | null>(null);

  const executeCommand = useCallback(
    async ({
      id: commandId,
      input,
      files,
      displayFiles,
      preparedContext,
      managedVisualSourceCount,
      attachmentGrounding,
      composerSelection,
      selectedArtifactId,
      seatTicket,
    }: Pick<
      ConversationCommandQueueItem,
      | 'id'
      | 'input'
      | 'files'
      | 'displayFiles'
      | 'preparedContext'
      | 'managedVisualSourceCount'
      | 'attachmentGrounding'
      | 'composerSelection'
      | 'selectedArtifactId'
    > & { seatTicket: ConversationRuntimeSeatTicket }): Promise<Exclude<AcpDispatchResult, 'rejected'>> => {
      if (!runtimeView.isSeatTicketCurrent(seatTicket)) return 'stale';
      const sendTicket = runtimeView.issueSendAttempt();
      if (!sendTicket) return 'stale';
      let sendStarted = false;
      let sendAccepted = false;
      beginSubmitActivity({ attemptId: sendTicket.attemptId, seatGeneration: sendTicket.seatGeneration });
      emitAcpPerformanceMark({
        stage: 'submit_started',
        conversationId: conversation_id,
        attemptId: sendTicket.attemptId,
        seatGeneration: sendTicket.seatGeneration,
      });
      // The images travelling with THIS turn, in the order the user attached
      // them. They are what a reference-to-video render would use, and naming
      // them in the envelope is what stops a follow-up from asking the user to
      // choose them again. Over the ceiling Main emits NOTHING rather than a
      // short list — under-reporting what is attached is worse than silence.
      const referenceImagePathsForTurn = (files ?? []).filter((filePath) => isImageFile(filePath));

      try {
        let agentFiles = files;
        let dispatchPreparedContext = preparedContext;
        const consumedComposerSelection = consumeComposerWorkProductSelection(composerSelection);
        const workProductRequest = consumedComposerSelection.request;
        const injectedWorkProductSkills = workProductRequest
          ? resolveComposerWorkProductInjectedSkills(workProductRequest.mode)
          : [];
        if (workProductRequest) {
          const selectedArtifactContext = renderComposerSelectedArtifactPreparedContext(
            selectedArtifactId,
            workProductRequest.selectedReferenceKind
          );
          dispatchPreparedContext = [
            workProductRequest.preparedContext,
            selectedArtifactContext,
            dispatchPreparedContext,
          ]
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .join('\n\n');
        }
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

          const flowId = createCommandEveCloudVisualFlowId(uuid(32));
          const receiptResult = await ipcBridge.commandEve.cloudVisualPolicyReceipt.invoke({ flowId });
          if (!runtimeView.isSeatTicketCurrent(seatTicket)) return 'stale';
          if (!receiptResult.success || !receiptResult.data?.ok) {
            // MAT-1769: a DISABLED policy is not an error — it is the one case
            // the user can fix in place. Surface it as the typed signal
            // `submitMessage` turns into the one-time in-chat enablement
            // prompt, never as a dead-end toast. Everything else (unavailable,
            // transport) keeps the honest failure below.
            const failedPolicy = receiptResult.data?.ok === false ? receiptResult.data.policy : undefined;
            if (failedPolicy?.status === 'disabled') {
              throw new CommandEveVisionPolicyDisabledError();
            }
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
          if (!runtimeView.isSeatTicketCurrent(seatTicket)) return 'stale';
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

        // MAT-1747 C1. The artifact registry rides THIS turn instead of costing
        // an extra inference turn to announce itself. It is wrapped in the same
        // `[[COMMAND_EVE_PREPARED_CONTEXT]]` delimiters MessageText already
        // strips, so what the user sees is byte-identical to what it would be
        // WITHOUT the envelope. (Not "to what they typed": that stripper has
        // always trimmed leading whitespace off every message it renders, with
        // or without this feature.)
        //
        // Everything here is best-effort by design: a conversation with no
        // artifacts gets `''` and the turn is unchanged, and a failed lookup
        // must never stop a message from being sent. That is why this is a
        // separate try/catch — the enclosing one turns a throw into a failed
        // send, and a missing registry is not a failed send.
        let artifactEnvelope = '';
        const requestedEditOperation =
          workProductRequest?.action === 'edit' && workProductRequest.mode === 'video' ? 'video_edit' : undefined;
        const selectedArtifactIdsForEnvelope =
          selectedArtifactId !== undefined &&
          !(
            workProductRequest?.action === 'create' &&
            workProductRequest.selectedReferenceKind !== workProductRequest.mode
          )
            ? [selectedArtifactId]
            : undefined;
        const requestedOfficeMode =
          (workProductRequest?.action === 'create' || workProductRequest?.action === 'edit') &&
          (workProductRequest.mode === 'word' || workProductRequest.mode === 'excel')
            ? workProductRequest.mode
            : undefined;
        try {
          // The video spend permit follows ONLY the explicit selected artifact,
          // never draft wording. Image edits rely on Hermes' native ACP tool
          // approval and never mint a model-visible pre-send credential.
          const envelopeResult = await ipcBridge.commandEve.artifactContextEnvelope
            .invoke({
              conversationId: conversation_id,
              // The raw turn, so Main can bind THIS send's single-use spend permit
              // to it. Main hashes it and keeps no copy of the TEXT — the digest
              // is persisted, because that is the binding; the sentence is not. No
              // permit is minted for a turn that carries no text.
              //
              // RAW HERE MEANS RAW, and this is the one path that claim covers.
              // `input` goes to the mint UNTOUCHED and to `buildCommandEveAgentTurnInput`
              // below UNTOUCHED, so on an ordinary turn the bytes the permit is
              // bound to and the bytes the agent reads are the same bytes,
              // whitespace included. The correction path in `dispatchSteer` is a
              // different rule and says so at its own call site.
              userTurnText: input,
              // MAT-1753 item C. The reference images pending on the draft, as
              // PATHS — Main grant-verifies and hashes them and emits neither. They
              // ride this envelope rather than a surface of their own, so the agent
              // sees exactly the files the user is looking at and there is no
              // second picker that could show something else.
              ...(referenceImagePathsForTurn.length === 0 ? {} : { referenceImagePaths: referenceImagePathsForTurn }),
              ...(selectedArtifactIdsForEnvelope === undefined
                ? {}
                : { selectedArtifactIds: selectedArtifactIdsForEnvelope }),
              ...(requestedEditOperation === undefined ? {} : { requestedEditOperation }),
              ...(requestedOfficeMode === undefined ? {} : { requestedOfficeMode }),
              ...(requestedOfficeMode === undefined ? {} : { officeOperationRequestId: commandId }),
            })
            .catch((error: unknown): undefined => {
              if (requestedOfficeMode) {
                throw new Error(t('conversation.workProduct.officeRefusal.preparationUnavailable'));
              }
              if (requestedEditOperation !== undefined) {
                throw new Error(t('conversation.workProduct.mediaEditPreparationUnavailable'));
              }
              // The envelope enriches a Hermes turn; it is not the chat
              // engine and must never become a second admission gate. Native
              // Hermes approval remains authoritative for ordinary/create
              // tool use when the optional envelope is unavailable.
              return undefined;
            });
          if (!runtimeView.isSeatTicketCurrent(seatTicket)) return 'stale';
          if (requestedEditOperation !== undefined && envelopeResult?.data?.mediaEditOperation?.status !== 'ready') {
            throw new Error(t('conversation.workProduct.mediaEditPreparationUnavailable'));
          }
          if (envelopeResult?.success && typeof envelopeResult.data?.envelope === 'string') {
            artifactEnvelope = envelopeResult.data.envelope;
          }
          if (requestedOfficeMode) {
            const officeOperation = envelopeResult?.success === true ? envelopeResult.data?.officeOperation : undefined;
            if (officeOperation?.status === 'refused') {
              throw new Error(describeOfficeArtifactRefusal(t, officeOperation.reasonCode));
            }
            if (officeOperation?.status !== 'ready') {
              throw new Error(t('conversation.workProduct.officeRefusal.preparationUnavailable'));
            }
            if (workProductRequest?.action === 'edit') {
              const officeAttachment = envelopeResult?.success ? envelopeResult.data?.officeAttachment : undefined;
              if (officeAttachment?.status === 'refused') {
                throw new Error(describeOfficeArtifactRefusal(t, officeAttachment.reasonCode));
              }
              const officePath = officeAttachment?.status === 'ready' ? officeAttachment.path : '';
              if (
                !officePath ||
                officePath.length > 4096 ||
                officePath.includes('\0') ||
                (!officePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(officePath))
              ) {
                throw new Error(t('conversation.workProduct.officeRefusal.attachmentUnavailable'));
              }
              agentFiles = Array.from(new Set([...(files ?? []), officePath]));
            }
          }
        } catch (error) {
          if (requestedOfficeMode || requestedEditOperation !== undefined) {
            throw error;
          }
          artifactEnvelope = '';
        }

        const agentInput = buildCommandEveAgentTurnInput({
          userInput: input,
          preparedContext: dispatchPreparedContext,
          artifactEnvelope,
        });
        const displayMessage = buildDisplayMessage(agentInput, displayFiles ?? files, workspacePath || '');

        // Grounded sends use Core's native warmup boundary to finish both the
        // ACP handshake and Hermes session readiness before prompt admission.
        // This keeps cold boot out of the ordinary 15s send request while a
        // failed warmup still leaves the draft retryable and unsent.
        const warmupStatus = getWarmupConversationStatus(conversation_id);
        emitAcpPerformanceMark({
          stage:
            warmupStatus.phase === 'preparing'
              ? 'warmup_joined'
              : warmupStatus.phase === 'ready'
                ? 'runtime_resident'
                : 'warmup_started',
          conversationId: conversation_id,
          attemptId: sendTicket.attemptId,
          seatGeneration: sendTicket.seatGeneration,
        });
        if (attachmentGrounding) {
          try {
            await warmupConversation(conversation_id, { revalidate: true });
            emitAcpPerformanceMark({
              stage: 'warmup_ready',
              conversationId: conversation_id,
              attemptId: sendTicket.attemptId,
              seatGeneration: sendTicket.seatGeneration,
              outcome: 'ready',
            });
          } catch (error) {
            emitAcpPerformanceMark({
              stage: 'warmup_failed',
              conversationId: conversation_id,
              attemptId: sendTicket.attemptId,
              seatGeneration: sendTicket.seatGeneration,
              outcome: 'failed',
            });
            throw error;
          }
          if (!runtimeView.isSeatTicketCurrent(seatTicket)) return 'stale';
        } else {
          // Join any proactive warmup before prompt admission. This is
          // deliberately fail-open: a failed or slow optimization may not
          // discard an ordinary user message, and the real Core send remains
          // the authoritative task admission path.
          const warmupOutcome = await settleConversationWarmupForSend(conversation_id);
          emitAcpPerformanceMark({
            stage:
              warmupOutcome === 'ready'
                ? 'warmup_ready'
                : warmupOutcome === 'failed'
                  ? 'warmup_failed'
                  : 'warmup_timeout',
            conversationId: conversation_id,
            attemptId: sendTicket.attemptId,
            seatGeneration: sendTicket.seatGeneration,
            outcome: warmupOutcome,
          });
          if (!runtimeView.isSeatTicketCurrent(seatTicket)) return 'stale';
        }

        if (teamPermission) await teamPermission.warmupSession();
        if (!runtimeView.isSeatTicketCurrent(seatTicket)) return 'stale';
        if (!runtimeView.markSendStarted(sendTicket)) return 'stale';
        sendStarted = true;
        // 1.7.3 (Codex #2): mark generation at SEND time so the seat-switch guard
        // covers the window between submit and the first `start` stream event, during
        // which the response stream is silent. The stream's finish/error clears it on
        // a real turn; the catch below clears it if the send never starts.
        markConversationGenerating(conversation_id);
        setAiProcessing(true);

        const result = await ipcBridge.acpConversation.sendMessage.invoke({
          input: displayMessage,
          conversation_id,
          files: agentFiles,
          ...(attachmentGrounding ? { attachment_grounding: attachmentGrounding } : {}),
          ...(injectedWorkProductSkills.length > 0 ? { inject_skills: [...injectedWorkProductSkills] } : {}),
        });
        if (
          attachmentGrounding &&
          !validateCommandEveAttachmentGroundingReceipt(attachmentGrounding, result.attachment_grounding_receipt)
        ) {
          throw new Error('ATTACHMENT_GROUNDING_RECEIPT_INVALID');
        }
        if (!runtimeView.markSendAccepted(sendTicket, result.turn_id, result.runtime, result.msg_id)) return 'stale';
        sendAccepted = true;
        bindSubmitActivityTurn({ attemptId: sendTicket.attemptId, turnId: result.turn_id });
        emitAcpPerformanceMark({
          stage: 'turn_admitted',
          conversationId: conversation_id,
          turnId: result.turn_id,
          messageId: result.msg_id,
          attemptId: sendTicket.attemptId,
          seatGeneration: sendTicket.seatGeneration,
        });
        void checkAndUpdateTitle(conversation_id, input, () => runtimeView.isSeatTicketCurrent(seatTicket));
        emitAcpPerformanceMark({
          stage: 'request_accepted',
          conversationId: conversation_id,
          turnId: result.turn_id,
          messageId: result.msg_id,
          attemptId: sendTicket.attemptId,
          seatGeneration: sendTicket.seatGeneration,
        });
        emitter.emit('chat.history.refresh');
      } catch (error: unknown) {
        // MAT-1769: the disabled-policy signal belongs to the enablement prompt
        // in `submitMessage`, not to the failure rendering below — and no turn
        // state was marked yet on that path, so there is nothing to clean up.
        if (error instanceof CommandEveVisionPolicyDisabledError) {
          if (!runtimeView.abandonAttempt(sendTicket)) return 'stale';
          throw error;
        }
        // SCRUBBED (MAT-1749) AT THE BINDING, not at one of its four sinks. This
        // sentence is rendered into the chat as a `tips` message, into the ACP
        // auth-failure stream message, into the archived-conversation toast, and
        // into `buildSendFailureError`. It originates upstream and can carry a
        // provider/model id; scrubbing one sink and not the others is how the
        // raw one shipped. Scrub once, here, and every consumer is covered.
        // CEVE-18205, same binding: a backend-relayed provider failure can carry
        // its raw machine body as flat text (python-repr JSON included — the
        // observed leak ended in `0.1}]}`). Strip the blob HERE so every sink
        // below gets the readable half; empty remainder falls back to the
        // translated unknown-error copy, never to an empty card.
        const errorMsg =
          stripEmbeddedJsonFromSendFailureText(
            scrubModelIdentifiers(
              getConversationRuntimeWorkspaceErrorMessage(error, t) || parseError(error) || t('common.unknownError'),
              CLOUD_MODEL_IDENTIFIERS
            )
          ) || t('common.unknownError');
        const attemptApplied = sendStarted
          ? runtimeView.markSendFailed(sendTicket, errorMsg)
          : runtimeView.abandonAttempt(sendTicket);
        if (!attemptApplied) return 'stale';
        // 1.7.3: the send never became a running turn — clear the guard flag (the
        // non-error failure path emits no terminal stream event to clear it).
        clearConversationGenerating(conversation_id);

        // Archived conversation (e.g. legacy Gemini). Backend signals this
        // via HTTP 410 + code='CONVERSATION_ARCHIVED' — identified by code,
        // not by substring matching.
        if (isBackendHttpError(error) && error.code === 'CONVERSATION_ARCHIVED') {
          Message.error({
            // `backendMessage` is upstream text that never passed through the
            // binding above, so it gets its own scrub.
            content: scrubModelIdentifiers(error.backendMessage || errorMsg, CLOUD_MODEL_IDENTIFIERS),
            duration: 6000,
          });
          setAiProcessing(false);
          throw error;
        }

        // CEVE-18205 quota gate (the forensics fix): a 402 quota_exhausted that
        // kills the SEND itself used to die here as a cold UNKNOWN_UPSTREAM_ERROR
        // card — the warm-wall detection lived only on the stream-error lane
        // (useAcpMessage's 'error' case), and this catch never asked it. Ask
        // FIRST: a recognized quota signal (or empty-tank daily cap) sets the
        // wall state the container already renders. `jobInFlight: true` because
        // the user just actively submitted this send — exactly the in-flight
        // attempt the walls' idle-suppression exists to require. On a signal the
        // cold card below is skipped (it would contradict the wall — the v1.6
        // both-surfaces defect); everything else renders exactly as before.
        // Guarded call: this runs INSIDE the failure path, where a wiring gap
        // (a partial messageState in a harness) must degrade to the cold card,
        // never to a second exception that skips the state resets below.
        const quotaSignal = quotaWall?.reportInferenceError?.(error, { jobInFlight: true }) === true;
        const isAuthError =
          !quotaSignal &&
          (errorMsg.includes('[ACP-AUTH-') ||
            errorMsg.includes('authentication failed') ||
            errorMsg.includes('认证失败'));
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
        } else if (!quotaSignal) {
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
      } finally {
        if (!sendAccepted) clearSubmitActivity(sendTicket.attemptId);
      }

      if (files.length > 0) {
        emitter.emit('acp.workspace.refresh');
      }
      return 'accepted';
    },
    [
      backend,
      beginSubmitActivity,
      bindSubmitActivityTurn,
      checkAndUpdateTitle,
      clearSubmitActivity,
      conversationArtifacts,
      conversation_id,
      eveInference.selection,
      quotaWall?.reportInferenceError,
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
    onExecute: async (item, seatTicket) => {
      return executeCommand({ ...item, seatTicket });
    },
  });

  // Inline quality selection. Fast/720p until the user clicks HD — never
  // auto-upgraded, which is what keeps the "explicit upgrade" property true.
  // MAT-1773 (P3): the state lives in the SHARED hook so the start-chat (guid)
  // surface holds and carries exactly the same selection through the same pill.
  const {
    tierId: videoTierId,
    modelId: videoModelId,
    resolution: videoResolution,
    durationSeconds: videoDurationSeconds,
    capabilities: videoCapabilities,
    catalog: videoCatalog,
    handleTierChange: handleVideoTierChange,
    handleModelChange: handleVideoModelChange,
    handleResolutionChange: handleVideoResolutionChange,
    setDurationSeconds: setVideoDurationSeconds,
    applySelection: applyVideoSelection,
    resetSelection: resetVideoSelection,
  } = useVideoComposerSelection();

  // One Main-authoritative per-seat image selection powers BOTH the start and
  // in-session composer. Resolution + format remain draft-local and are
  // snapshotted into the explicit one-shot work-product request.
  const {
    tierId: imageModelTier,
    registry: imageModelRegistry,
    registryRevision: imageModelRegistryRevision,
    resolution: imageResolution,
    aspectRatio: imageAspectRatio,
    setTierId: setImageModelTier,
    setResolution: setImageResolution,
    setAspectRatio: setImageAspectRatio,
  } = useImageComposerSelection();
  useEffect(() => {
    imageModelRegistryRevisionRef.current = imageModelRegistryRevision;
  }, [imageModelRegistryRevision]);

  // 1.823.0 — explicit work-product authority. Draft prose never activates a
  // paid/generative lane. A click in the mode dock, or a click on one exact
  // artifact's "Bearbeiten" action, is the only constructor below.
  const [composerSelection, setComposerSelection] = useState<ComposerWorkProductSelection>(
    DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION
  );
  const [selectedArtifactReference, setSelectedArtifactReference] = useState<ComposerArtifactReference | null>(null);
  const showImageEditControls =
    composerSelection.mode === 'image' && selectedArtifactReference?.referenceKind === 'image';

  useEffect(() => {
    setComposerSelection((selection) =>
      composerWorkProductModeSupportsImageGeneration(selection.mode) && !selection.hasSelectedReference
        ? selectExplicitComposerWorkProductMode(selection.mode, undefined, {
            tierId: imageModelTier,
            aspectRatio: selection.imageOptions?.aspectRatio ?? imageAspectRatio,
            resolution: selection.imageOptions?.resolution ?? imageResolution,
          })
        : selection
    );
  }, [imageAspectRatio, imageModelTier, imageResolution]);

  useEffect(() => {
    setComposerSelection(DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION);
    setSelectedArtifactReference(null);
  }, [activeSeatId, conversation_id]);

  useAddEventListener(
    'commandEve.composer.reference.select',
    ({ conversation_id: targetConversationId, artifact_id: artifactId }) => {
      if (targetConversationId !== conversation_id || !isEveConversation) return;
      const artifact = conversationArtifacts.find((candidate) => candidate.id === artifactId);
      const reference = resolveComposerArtifactReference(artifact);
      if (
        !artifact ||
        !reference ||
        reference.conversationId !== targetConversationId ||
        !isVisibleConversationArtifact(artifact) ||
        ((reference.mode === 'image' || reference.mode === 'video') && !isUsableMediaEditSource(artifact))
      ) {
        Message.warning(
          t('conversation.workProduct.referenceUnavailable', {
            defaultValue: 'Dieses Artefakt kann nicht mehr als Bearbeitungsquelle verwendet werden.',
          })
        );
        return;
      }
      setSelectedArtifactReference(reference);
      setComposerSelection(
        selectExplicitComposerWorkProductMode(
          reference.mode,
          { selected: true, kind: reference.referenceKind },
          reference.mode === 'image'
            ? {
                tierId:
                  (imageModelRegistry
                    ? resolveReferenceCapableImageModelTier(imageModelRegistry, imageModelTier)
                    : null) ?? imageModelTier,
                aspectRatio: imageAspectRatio,
                resolution: imageResolution,
              }
            : undefined
        )
      );
    },
    [
      conversationArtifacts,
      conversation_id,
      imageAspectRatio,
      imageModelRegistry,
      imageModelTier,
      imageResolution,
      isEveConversation,
      t,
    ]
  );

  const handleComposerModeChange = useCallback(
    (mode: ComposerWorkProductMode) => {
      if (mode === 'chat') {
        setSelectedArtifactReference(null);
        setComposerSelection(DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION);
        return;
      }
      const keepReference =
        selectedArtifactReference !== null &&
        (selectedArtifactReference.mode === mode ||
          (selectedArtifactReference.referenceKind === 'image' &&
            (mode === 'video' || mode === 'presentation' || mode === 'pdf' || mode === 'word' || mode === 'excel')));
      if (!keepReference) setSelectedArtifactReference(null);
      const imageTier =
        keepReference && selectedArtifactReference.referenceKind === 'image' && imageModelRegistry
          ? (resolveReferenceCapableImageModelTier(imageModelRegistry, imageModelTier) ?? imageModelTier)
          : imageModelTier;
      setComposerSelection(
        selectExplicitComposerWorkProductMode(
          mode,
          keepReference ? { selected: true, kind: selectedArtifactReference.referenceKind } : undefined,
          composerWorkProductModeSupportsImageGeneration(mode) && !keepReference
            ? { tierId: imageTier, aspectRatio: imageAspectRatio, resolution: imageResolution }
            : undefined
        )
      );
    },
    [
      composerSelection.mode,
      imageAspectRatio,
      imageModelRegistry,
      imageModelTier,
      imageResolution,
      selectedArtifactReference,
    ]
  );

  const clearComposerReference = useCallback(() => {
    setSelectedArtifactReference(null);
    setComposerSelection((selection) =>
      selectExplicitComposerWorkProductMode(
        selection.mode,
        undefined,
        composerWorkProductModeSupportsImageGeneration(selection.mode)
          ? { tierId: imageModelTier, aspectRatio: imageAspectRatio, resolution: imageResolution }
          : undefined
      )
    );
  }, [imageAspectRatio, imageModelTier, imageResolution]);

  const handleImageModelTierChange = useCallback(
    (tierId: typeof imageModelTier) => {
      setImageModelTier(tierId, { persist: !showImageEditControls });
      setComposerSelection((selection) =>
        selection.mode === 'image' ||
        (composerWorkProductModeSupportsImageGeneration(selection.mode) && !selection.hasSelectedReference)
          ? selectExplicitComposerWorkProductMode(
              selection.mode,
              selection.hasSelectedReference ? { selected: true, kind: selection.selectedReferenceKind } : undefined,
              { tierId, aspectRatio: imageAspectRatio, resolution: imageResolution }
            )
          : selection
      );
    },
    [imageAspectRatio, imageResolution, setImageModelTier, showImageEditControls]
  );

  const handleImageResolutionChange = useCallback(
    (resolution: '1K' | '2K') => {
      setImageResolution(resolution);
      setComposerSelection((selection) =>
        selection.mode === 'image' ||
        (composerWorkProductModeSupportsImageGeneration(selection.mode) && !selection.hasSelectedReference)
          ? selectExplicitComposerWorkProductMode(
              selection.mode,
              selection.hasSelectedReference ? { selected: true, kind: selection.selectedReferenceKind } : undefined,
              { tierId: selection.imageOptions?.tierId ?? imageModelTier, aspectRatio: imageAspectRatio, resolution }
            )
          : selection
      );
    },
    [imageAspectRatio, imageModelTier, setImageResolution]
  );

  const handleImageAspectRatioChange = useCallback(
    (aspectRatio: typeof imageAspectRatio) => {
      setImageAspectRatio(aspectRatio);
      setComposerSelection((selection) =>
        selection.mode === 'image' ||
        (composerWorkProductModeSupportsImageGeneration(selection.mode) && !selection.hasSelectedReference)
          ? selectExplicitComposerWorkProductMode(
              selection.mode,
              selection.hasSelectedReference ? { selected: true, kind: selection.selectedReferenceKind } : undefined,
              { tierId: selection.imageOptions?.tierId ?? imageModelTier, aspectRatio, resolution: imageResolution }
            )
          : selection
      );
    },
    [imageModelTier, imageResolution, setImageAspectRatio]
  );

  const consumeComposerSelection = useCallback(() => {
    // Sticky lane (founder ruling 2026-08-18): a send consumes neither the mode
    // nor — on an EDIT — the bound artifact. The core owns that decision; this
    // call site only applies it.
    //
    // An EDIT keeps its target, because "und jetzt die Linie blau" is the same
    // edit continued, not a new picture described in three words. It keeps
    // pointing at the SOURCE until a successor actually exists; the lineage
    // effect below is what moves it. A CREATE drops it: an attached reference
    // image was an input to the render that just happened, never a target for
    // the next one.
    //
    // THE UPDATER FORM IS LOAD-BEARING, and a test found that the hard way. An
    // earlier revision read the selection from a `useLatestRef` so it could also
    // clear the artifact chip here. That ref is written in a layout effect, so a
    // send whose result lands before React commits — the start-screen handoff,
    // where the mode is set and the send resolves in the same tick — consumed a
    // STALE chat selection and silently dropped the lane the operator had just
    // chosen. The updater always sees the current state; the chip is kept in
    // step by the mirror effect below instead.
    setComposerSelection((selection) => consumeComposerWorkProductSelection(selection).nextSelection);
  }, []);

  // ONE INVARIANT, ONE PLACE: the visible reference chip mirrors the authority.
  // A selection that carries no reference cannot leave a chip standing, whoever
  // cleared it — a consumed create, a mode switch, an exit. Deriving this rather
  // than clearing at each call site is what stops the two from disagreeing about
  // whether a lane is still an edit lane.
  useEffect(() => {
    if (!composerSelection.hasSelectedReference) setSelectedArtifactReference(null);
  }, [composerSelection.hasSelectedReference]);

  // 1.820.4 (MAT-1772) — the durable project chip truth: the newest COMPLETED
  // project workspace artifact's title, path-free, ahead of hermes-temp-*.
  const durableProjectName = useNewestCompletedProjectTitle(conversation_id);
  const selectedReferenceArtifact = useMemo(
    () =>
      selectedArtifactReference
        ? (conversationArtifacts.find((artifact) => artifact.id === selectedArtifactReference.artifactId) ?? null)
        : null,
    [conversationArtifacts, selectedArtifactReference]
  );

  // THE EDIT CHAIN (founder ruling 2026-08-18, second pass). A successful image,
  // video or Office edit writes a NEW artifact that NAMES its source in
  // `parent_artifact_id`. When that successor appears, the armed reference moves
  // onto it — so "orange, nein grün, warte blau" each build on the step the
  // operator is looking at, instead of silently re-editing the first version
  // three times.
  //
  // LINEAGE, NOT RECENCY, and that is the entire safety argument. Only an
  // artifact that names the current reference as its parent qualifies; there is
  // no wall-clock guess and no "newest image wins". A refused, failed or
  // still-running edit produces no such artifact, so NOTHING MOVES and a retry
  // hits exactly the same source the operator chose. The same rule keeps a
  // parallel unrelated generation from hijacking the lane.
  //
  // Moving the reference spends nothing: it restates WHICH artifact is targeted.
  // Every paid edit still mints its own single-use permit at send time, bound to
  // that turn's own text.
  //
  // IT WALKS TO THE END OF THE CHAIN IN ONE PASS, and that is deliberate rather
  // than incidental. Re-pointing one hop per render would make this effect feed
  // itself, and a malformed cycle (A names B, B names A) would spin forever —
  // found by sabotage, not by reasoning: removing the lineage test below made
  // every artifact a candidate and the suite HUNG instead of failing. So the
  // walk carries a visited set, ends at the artifact with no further
  // descendant, and writes state only when that differs from what is armed.
  // The next run then finds the same terminal artifact and writes nothing.
  useEffect(() => {
    const reference = selectedArtifactReference;
    if (!reference) return;
    // Every artifact this walk has already stood on. An id enters exactly once,
    // so a self-naming record or a cycle ends the walk instead of driving it.
    const visited = new Set<string>([reference.artifactId]);
    let current = reference;
    for (;;) {
      let successor: { reference: ComposerArtifactReference; createdAt: number } | null = null;
      for (const artifact of conversationArtifacts) {
        const payload = artifact.payload as { parent_artifact_id?: unknown };
        if (payload.parent_artifact_id !== current.artifactId || visited.has(artifact.id)) continue;
        if (!isVisibleConversationArtifact(artifact)) continue;
        const candidate = resolveComposerArtifactReference(artifact);
        // Same medium only, and it must satisfy the SAME edit-source predicate
        // the manual "Bearbeiten" action uses. A successor the app would refuse
        // to edit must not become the armed target, or the next send would be a
        // refusal the operator never asked for.
        if (!candidate || candidate.mode !== reference.mode) continue;
        if ((candidate.mode === 'image' || candidate.mode === 'video') && !isUsableMediaEditSource(artifact)) continue;
        if (!successor || artifact.created_at > successor.createdAt) {
          successor = { reference: candidate, createdAt: artifact.created_at };
        }
      }
      if (!successor) break;
      visited.add(successor.reference.artifactId);
      current = successor.reference;
    }
    if (current.artifactId !== reference.artifactId) setSelectedArtifactReference(current);
  }, [conversationArtifacts, selectedArtifactReference]);
  const showImageControls =
    composerWorkProductModeSupportsImageGeneration(composerSelection.mode) &&
    (composerSelection.mode === 'image' || selectedArtifactReference === null);
  const showVideoCreateControls =
    composerSelection.mode === 'video' &&
    (selectedArtifactReference === null || selectedArtifactReference.referenceKind === 'image');
  const showVideoEditHint = composerSelection.mode === 'video' && selectedArtifactReference?.referenceKind === 'video';
  // The honest inline edit price for the VIDEO affordance: the MATCHING video
  // source's own tier and seconds (a video edit inherits source
  // quality/duration — never the overall latest media artifact's). Null when
  // the source is not edit-eligible, so the affordance never quotes a price
  // that would refuse.
  const videoEditEstimate = useMemo(() => {
    if (!showVideoEditHint || !selectedReferenceArtifact) return null;
    const payload = selectedReferenceArtifact.payload as { tier_id?: unknown; duration_seconds?: unknown };
    const tierId = payload.tier_id === 'sd' || payload.tier_id === 'fast' ? payload.tier_id : null;
    const seconds = typeof payload.duration_seconds === 'number' ? payload.duration_seconds : null;
    if (tierId === null || seconds === null || !isVideoEditEligibleTier(tierId)) return null;
    const credits = estimateVideoEditCredits(tierId, seconds);
    return Number.isFinite(credits) ? { credits, seconds } : null;
  }, [showVideoEditHint, selectedReferenceArtifact]);

  // WHAT THE SEAT MAY OFFER (capabilities + catalog) is fetched inside the
  // shared useVideoComposerSelection hook — asked of MAIN, never decided here:
  // an absent or failed answer stays fail-closed (both flags false), and the
  // catalog falls back to the bundled snapshot marked approximate.

  const selectedImageTier = composerSelection.imageOptions?.tierId ?? imageModelTier;

  // A reference edit retains the user's previous model where the live registry
  // proves it can accept references. If it cannot, select the registry default
  // (or its declared reference-capable fallback) for THIS request only; do not
  // overwrite the seat's create preference.
  useEffect(() => {
    if (!showImageEditControls || !imageModelRegistry) return;
    const resolvedTier = resolveReferenceCapableImageModelTier(imageModelRegistry, selectedImageTier);
    if (!resolvedTier || resolvedTier === selectedImageTier) return;
    setComposerSelection((selection) =>
      selectExplicitComposerWorkProductMode(
        'image',
        selection.hasSelectedReference ? { selected: true, kind: selection.selectedReferenceKind } : undefined,
        { tierId: resolvedTier, aspectRatio: imageAspectRatio, resolution: imageResolution }
      )
    );
  }, [imageAspectRatio, imageModelRegistry, imageResolution, selectedImageTier, showImageEditControls]);

  // WHICH OF THE FOUR MODES this send is. Derived from the attachments the user
  // can already see, which is the whole of item C: reference images ARE the files
  // already on the draft, so there is no second picker that could disagree with
  // what the user is looking at.
  //
  //   0 images     -> text-to-video (1.5 reaches 1080p from a bare prompt)
  //   1 image      -> image-to-video
  //   2..7 images  -> reference-to-video (1.5, clamped to 720p and 15s)
  //   8+ images    -> still 'reference' here, and refused BY NAME in Main rather
  //                   than silently truncated to seven.
  //
  // An earlier comment on this binding said 1080p "exists only as image->video".
  // It was wrong about the provider, and it is gone.
  const videoImagePaths = useMemo(() => uploadFile.filter((path) => isImageFile(path)), [uploadFile]);
  // THE REFERENCE IMAGES AN IMAGE SEND WOULD CARRY — counted from exactly the
  // sources the send path uses, so the warning and the request can never
  // disagree. `submitMessage` builds `allFiles` as uploads PLUS @-mentioned
  // paths and then filters it with the same `isImageFile`; counting only the
  // uploads here would under-report an @-referenced image and warn one too
  // late. The video binding above deliberately reads only `uploadFile`,
  // because its own send does.
  const imageReferenceCount = useMemo(
    () =>
      [...uploadFile, ...atPath.map((item) => (typeof item === 'string' ? item : item.path))].filter((path) =>
        isImageFile(path)
      ).length,
    [atPath, uploadFile]
  );
  const videoModeKind: VideoModeKind = useMemo(
    () =>
      selectedArtifactReference?.referenceKind === 'image'
        ? 'image'
        : videoImagePaths.length === 0
          ? 'text'
          : videoImagePaths.length === 1
            ? 'image'
            : 'reference',
    [selectedArtifactReference, videoImagePaths]
  );

  // Preset voices, when the seat is entitled and the mode can carry them. The
  // ceiling is re-enforced in the core; capping here only avoids inviting a
  // choice that would be refused.
  const [videoVoiceIds, setVideoVoiceIds] = useState<readonly string[]>([]);
  const toggleVideoVoice = useCallback((voiceId: string) => {
    setVideoVoiceIds((current) =>
      current.includes(voiceId)
        ? current.filter((id) => id !== voiceId)
        : current.length >= MAX_VIDEO_REFERENCE_AUDIOS
          ? current
          : [...current, voiceId]
    );
  }, []);

  const dispatchSteer = useCallback(
    async (
      seatTicket: ConversationRuntimeSeatTicket,
      input: string,
      requestId?: string
    ): Promise<Exclude<AcpDispatchResult, 'rejected'>> => {
      if (!runtimeView.isSeatTicketCurrent(seatTicket)) return 'stale';
      const turnId = runtimeView.activeTurnId ?? (await waitForConversationActiveTurnId(conversation_id));
      if (!runtimeView.isSeatTicketCurrent(seatTicket)) return 'stale';
      if (!turnId) {
        throw new Error(
          t('conversation.commandQueue.activeTurnUnavailable', {
            defaultValue: 'The current run is not ready for a correction yet.',
          })
        );
      }

      const normalizedInput = input.trim();
      const inFlightKey = `${seatTicket.seatId}\u0000${seatTicket.rebindEpoch}\u0000${turnId}\u0000${normalizedInput}`;
      const existingRequest = activeSteerRequestsRef.current.get(inFlightKey);
      if (existingRequest) return existingRequest;

      const stableRequestId = requestId ?? steerRetryRequestIdsRef.current.get(inFlightKey) ?? uuid();
      if (!requestId) steerRetryRequestIdsRef.current.set(inFlightKey, stableRequestId);

      // MAT-1747. A correction is a real user turn, and it is the ONLY kind of
      // real user turn that never builds a context envelope — it goes straight
      // to the runtime over HTTP. So this is the one place that can retire the
      // spend permit minted for the turn the user is now correcting; without it,
      // that permit stayed live right across the person saying something else.
      //
      // BEFORE the correction reaches the run, not after: the other order leaves
      // a window in which the model holds both the new instruction and the old
      // permit.
      //
      // A FAILURE HERE IS NOT SWALLOWED — it is answered in main. Round 3 caught
      // this rejection and let the permit live on, and that was fail-open on
      // spending: local storage misbehaves and the app quietly keeps the ability
      // to charge the user against an instruction they have already superseded.
      //
      // The rule is now split instead of traded. The CORRECTION is still never
      // blocked by the permit store — that is what this catch protects, and it is
      // the whole of what it protects. The PAID EDIT AUTHORITY fails closed
      // elsewhere: `handleCommandEveArtifactTurnSteer` puts the conversation into
      // a retired state whenever a permit store exists for it, which is every
      // case in which a live permit could exist, and does that whether the
      // revoke worked or threw. `handleCommandEveVideoEdit` then reads that
      // state before it fetches or debits anything.
      //
      // WHAT THIS CATCH STILL CANNOT COVER, stated because the two calls below
      // do not share a transport: the retire is a renderer->main IPC provider,
      // while `acpConversation.steer` is an HTTP POST from the renderer straight
      // to the runtime. So an IPC layer that is down takes the retire with it and
      // leaves the correction working — main never learns, and nothing here can
      // tell it. That residual is in the decision record and is not closed.
      //
      // WRAPPED, so the in-flight entry below is still registered SYNCHRONOUSLY.
      // Awaiting the retire out here instead would put an await between the
      // duplicate check and the `set` that answers it, and two rapid promotions
      // of the same command would both send a correction.
      const pendingRequest = (async () => {
        try {
          await ipcBridge.commandEve.artifactTurnSteer.invoke({
            conversationId: conversation_id,
            // `normalizedInput`, NOT `input`, and that is the contract rather
            // than an oversight. A correction MINTS NOTHING; it retires
            // authority. The right thing for a retirement to name is what the
            // run was actually told, which is the very string handed to
            // `acpConversation.steer` four lines below — so the recorded turn
            // and the turn the agent read are the same bytes by construction.
            //
            // It is therefore NOT the raw-keystroke binding used when a permit
            // is MINTED (see `userTurnText` on the send path above). Saying
            // "raw bytes" of both was an overclaim; the two paths carry two
            // different invariants on purpose.
            //
            // AND THERE IS NO RAW VALUE HERE TO BIND EVEN IF WE WANTED ONE. Both
            // callers reach `dispatchSteer` through
            // `buildConversationBusyControlCommand`, which does not pass the
            // user's text along — it REBUILDS it as `/steer <trimmed args>`. So
            // by the time `input` arrives it is already a command string the
            // person never typed, with the padding gone. `input.trim()` above is
            // defensive, not the place the whitespace is lost. Proved by
            // sabotage: replacing this value with `input` leaves the suite green
            // (the two are equal here), while decoupling it from the string sent
            // to the runtime turns four tests red.
            //
            // Consequence, stated: a correction that differs from the minting
            // turn only in leading or trailing whitespace leaves this pointer
            // where it was. The revoke and the unconditional deny in Main both
            // still fire, which is why the pointer is the backstop here and not
            // the defence.
            steerText: normalizedInput,
          });
          if (!runtimeView.isSeatTicketCurrent(seatTicket)) return 'stale' as const;
        } catch {
          /* see above: a correction is never blocked by the permit store */
        }
        await ipcBridge.acpConversation.steer.invoke({
          input: normalizedInput,
          conversation_id,
          turn_id: turnId,
          request_id: stableRequestId,
        });
        return runtimeView.isSeatTicketCurrent(seatTicket) ? ('accepted' as const) : ('stale' as const);
      })();
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
    [conversation_id, runtimeView, t]
  );

  // The real dispatch (queue or execute) for an already-cleared message. Both
  // the normal send and the post-confirm video send route through this so the
  // queue/in-flight semantics are identical.
  const dispatchMessage = useCallback(
    async (
      seatTicket: ConversationRuntimeSeatTicket,
      message: string,
      agentFiles: string[],
      displayFiles: string[] = agentFiles,
      preparedContext?: string,
      managedVisualSourceCount?: number,
      attachmentGrounding?: CommandEveAttachmentGroundingRequest,
      queuedComposerSelection?: ComposerWorkProductSelection,
      selectedArtifactId?: string
    ): Promise<AcpDispatchResult> => {
      if (!runtimeView.isSeatTicketCurrent(seatTicket)) return 'stale';
      const requestedBusyControlCommand = runtimeView.isProcessing
        ? buildConversationBusyControlCommand({ input: message, mode: busySendMode })
        : null;
      const busyControlCommand =
        agentFiles.length === 0 && !queuedComposerSelection ? requestedBusyControlCommand : null;

      if (agentFiles.length > 0 && requestedBusyControlCommand?.mode === 'steer') {
        Message.warning(
          t('conversation.commandQueue.steerFilesQueued', {
            defaultValue: 'Corrections cannot include files, so this message was queued for afterwards.',
          })
        );
      }

      if (busyControlCommand?.mode === 'steer') {
        try {
          const result = await dispatchSteer(seatTicket, busyControlCommand.input);
          if (result === 'stale') return 'stale';
          emitter.emit('chat.history.refresh');
          return 'accepted';
        } catch (error) {
          // SCRUBBED (MAT-1749): a steer dispatch failure can carry upstream text.
          const steerFailureText = scrubModelIdentifiers(parseError(error), CLOUD_MODEL_IDENTIFIERS);
          Message.error({
            content:
              steerFailureText ||
              t('conversation.commandQueue.promoteFailed', {
                defaultValue: 'The correction could not be pushed into the current run.',
              }),
            duration: 5000,
          });
          return 'rejected';
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
        return enqueue({
          input: queuedMessage,
          files: agentFiles,
          displayFiles,
          preparedContext,
          managedVisualSourceCount,
          attachmentGrounding,
          composerSelection: queuedComposerSelection,
          selectedArtifactId,
          seatTicket,
        }) !== null
          ? 'accepted'
          : 'rejected';
      }
      return executeCommand({
        id: uuid(),
        input: queuedMessage,
        files: agentFiles,
        displayFiles,
        preparedContext,
        managedVisualSourceCount,
        attachmentGrounding,
        seatTicket,
        composerSelection: queuedComposerSelection,
        selectedArtifactId,
      });
    },
    [busySendMode, dispatchSteer, enqueue, executeCommand, hasPendingCommands, isBusy, runtimeView.isProcessing, t]
  );

  const preparePdfFiles = useCallback(
    async (
      files: string[],
      isCurrent: () => boolean = () => true
    ): Promise<{ files: string[]; attachmentGroundingEntries: CommandEveAttachmentGroundingExpectation[] } | null> => {
      if (!isCurrent()) return null;
      if (!isEveConversation) return { files, attachmentGroundingEntries: [] };
      const pdfFiles = files.filter(isCommandEvePdfPath);
      if (pdfFiles.length === 0) return { files, attachmentGroundingEntries: [] };

      const startedAt = Date.now();
      setDocumentPreparation({ phase: 'reading_local', fileCount: pdfFiles.length, startedAt });

      const invoke = (allowCloudOcr: boolean) =>
        ipcBridge.commandEve.pdfPrepare.invoke({
          filePaths: pdfFiles,
          allowCloudOcr,
          privacyLane: 'cloud_auto',
          requestId: `pdf-${Date.now().toString(36)}`,
        });
      const acceptPreparedReceipt = (
        raw: unknown
      ): { files: string[]; attachmentGroundingEntries: CommandEveAttachmentGroundingExpectation[] } | null => {
        if (!isCurrent()) return null;
        const validated = validateCommandEvePdfPrepareReceipt(pdfFiles, raw);
        if (validated.ok === false) {
          setDocumentPreparation({ phase: 'error', fileCount: pdfFiles.length, startedAt });
          Message.error({
            content: t('conversation.pdf.prepareFailed'),
            duration: 6000,
          });
          return null;
        }
        setDocumentPreparation({ phase: 'handoff', fileCount: pdfFiles.length, startedAt });
        return {
          files: mergeCommandEvePreparedPdfFiles(files, validated.documents),
          attachmentGroundingEntries: validated.documents.map(groundingExpectationFromPdf),
        };
      };
      try {
        let response = await invoke(false);
        if (!isCurrent()) return null;
        if (response.success && response.data?.ok) {
          return acceptPreparedReceipt(response.data);
        }

        const initialFailure = response.data?.ok === false ? response.data : undefined;
        if (initialFailure?.requires_cloud_ocr_consent !== true) {
          setDocumentPreparation({ phase: 'error', fileCount: pdfFiles.length, startedAt });
          // SCRUBBED (MAT-1749) AT THE READ: `initialFailure.message` originates
          // upstream and may carry a provider/model id. Bound before the toast so
          // no raw read of it survives anywhere in a rendered position.
          const initialFailureText = scrubModelIdentifiers(initialFailure?.message ?? '', CLOUD_MODEL_IDENTIFIERS);
          Message.error({
            content: initialFailureText || t('conversation.pdf.prepareFailed'),
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
        if (!isCurrent()) return null;
        if (!approved) {
          setDocumentPreparation(null);
          return null;
        }

        setDocumentPreparation({ phase: 'reading_cloud', fileCount: pdfFiles.length, startedAt });
        response = await invoke(true);
        if (!isCurrent()) return null;
        if (!response.success || !response.data?.ok) {
          setDocumentPreparation({ phase: 'error', fileCount: pdfFiles.length, startedAt });
          const cloudFailure = response.data?.ok === false ? response.data : undefined;
          // SCRUBBED (MAT-1749), exactly like the initialFailure toast above.
          // This is the CLOUD RETRY — the one attempt that actually reached a
          // provider, so it is the MORE likely of the two to carry a
          // provider/model id, and it shipped raw for ten lines' distance from
          // its scrubbed sibling. Pinned in modelIdentifierScrub.test.ts.
          const cloudFailureText = scrubModelIdentifiers(cloudFailure?.message ?? '', CLOUD_MODEL_IDENTIFIERS);
          Message.error({
            content: cloudFailureText || t('conversation.pdf.cloudOcrFailed'),
            duration: 6000,
          });
          return null;
        }
        return acceptPreparedReceipt(response.data);
      } catch (error) {
        if (!isCurrent()) return null;
        setDocumentPreparation({ phase: 'error', fileCount: pdfFiles.length, startedAt });
        // SCRUBBED (MAT-1749): the builder's own fallback is the RAW upstream string.
        const prepareFailureText = scrubModelIdentifiers(
          getConversationRuntimeWorkspaceErrorMessage(error, t),
          CLOUD_MODEL_IDENTIFIERS
        );
        Message.error({
          content: prepareFailureText || t('conversation.pdf.prepareFailed'),
          duration: 6000,
        });
        return null;
      }
    },
    [isEveConversation, t]
  );

  // MAT-1769 — raise the ONE-TIME in-chat Vision enablement prompt for a send
  // that hit the disabled cloud-visual policy wall. Two guards make it honest:
  // a seat that already answered "Nicht jetzt" gets a quiet notice and never
  // the question again, and an already-open card is never stacked by a second
  // blocked send. The draft and files were already restored by the caller, so
  // parking the exact send arguments is enough to re-drive it on accept.
  const raiseVisionEnablementPrompt = useCallback(
    (
      seatTicket: ConversationRuntimeSeatTicket,
      message: string,
      allFiles: string[],
      controls: { clearSelection: () => void; restoreDraftAndFiles: () => void }
    ) => {
      if (!runtimeView.isSeatTicketCurrent(seatTicket)) return;
      if (configService.get('commandEve.visionEnablementDeclined') === true) {
        Message.warning({
          content: t('conversation.visual.enablement.declinedNotice', {
            defaultValue:
              'Vision stays off, so the image was not sent. You can enable Vision any time under Settings → Privacy.',
          }),
          duration: 6000,
        });
        return;
      }
      setVisionEnablementPending((previous) => previous ?? { seatTicket, message, allFiles, controls });
    },
    [runtimeView, t]
  );

  const submitMessage = useCallback(
    async (
      seatTicket: ConversationRuntimeSeatTicket,
      message: string,
      allFiles: string[],
      controls: {
        clearSelection: () => void;
        restoreDraftAndFiles: () => void;
        /**
         * The GUID HANDOFF (MAT-1773 P3): a selection made on the start-chat
         * surface rides the initial message and wins over the composer's own
         * resting state for exactly this send.
         */
        videoSelection?: VideoDraftSelection;
        composerSelection?: ComposerWorkProductSelection;
        selectedArtifactReference?: ComposerArtifactReference | null;
        consumeComposerSelection?: () => void;
      }
    ): Promise<AcpDispatchResult> => {
      const isCurrent = () => runtimeView.isSeatTicketCurrent(seatTicket);
      if (!isCurrent()) return 'stale';
      // S81/R3: bounded, fail-open project intent gate — always first, before
      // PDF prep or dispatch, and never touching executeCommand/sendMessage.
      await runProjectChatIntentGate({ conversation_id, message, isCurrent });
      if (!isCurrent()) return 'stale';

      if (documentPreparationInFlightRef.current) {
        controls.restoreDraftAndFiles();
        Message.warning(t('conversation.documents.preparationInProgress'));
        return 'rejected';
      }

      const activeComposerSelection = controls.composerSelection ?? DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION;
      const workProductRequest = consumeComposerWorkProductSelection(activeComposerSelection).request;
      const activeArtifactReference = controls.selectedArtifactReference ?? null;

      // Heavy-lane routing (DUX-6, FAIL-SAFE) resolves BEFORE any document
      // preparation runs — not after it. An explicitly selected video mode must never trigger
      // presentation/image cloud analysis: an attached image on a video send is
      // a VIDEO SOURCE, not a vision-analysis request, and running it through
      // that pipeline first would spend an unrelated cloud call and could
      // surface a consent/policy flow the video lane never asked for. Founder
      // review 2026-07-31 rejected the earlier ordering for exactly this: it ran
      // image/presentation prep for every send, including a video one, before
      // this check ever ran.
      //
      if (
        isEveConversation &&
        workProductRequest?.mode === 'image' &&
        workProductRequest.action === 'create' &&
        activeArtifactReference === null
      ) {
        const nonImageFiles = allFiles.filter((filePath) => !isImageFile(filePath));
        const imageReferenceCount = allFiles.filter((filePath) => isImageFile(filePath)).length;
        if (nonImageFiles.length > 0 || imageReferenceCount > 4) {
          controls.restoreDraftAndFiles();
          Message.warning(
            t('conversation.workProduct.image.referencesOnly', {
              defaultValue: 'Im Bildmodus kannst du nur Bilder als Referenz anhängen.',
            })
          );
          return 'rejected';
        }
      }

      // A managed image selected for document creation and a selected PDF edit
      // both become ordinary private agent attachments. The path remains
      // IPC-only; `allFiles` stays the display list and never exposes it in the
      // transcript.
      const shouldResolveManagedImageInput =
        isEveConversation &&
        workProductRequest?.action === 'create' &&
        workProductRequest.selectedReferenceKind === 'image' &&
        activeArtifactReference !== null &&
        workProductRequest.mode !== 'image' &&
        workProductRequest.mode !== 'video';
      const pdfEditSelected =
        isEveConversation &&
        workProductRequest?.mode === 'pdf' &&
        workProductRequest.action === 'edit' &&
        activeArtifactReference?.referenceKind === 'pdf';
      const pdfEditSourcePath = pdfEditSelected
        ? readSelectedPdfArtifactSourcePath({
            artifact: selectedReferenceArtifact,
            conversationId: conversation_id,
            artifactId: activeArtifactReference.artifactId,
          })
        : undefined;
      const shouldResolveManagedArtifactInput = shouldResolveManagedImageInput || pdfEditSelected;
      let agentInputFiles = allFiles;
      if (shouldResolveManagedArtifactInput) {
        if (pdfEditSelected && !pdfEditSourcePath) {
          controls.restoreDraftAndFiles();
          Message.error({ content: t('conversation.workProduct.artifactInputUnavailable'), duration: 6000 });
          return 'rejected';
        }
        const artifactInput = await resolveManagedArtifactInput({
          conversationId: conversation_id,
          artifactId: activeArtifactReference.artifactId,
          ...(pdfEditSourcePath === undefined ? {} : { sourcePath: pdfEditSourcePath }),
          isCurrent,
          invoke: (request) => ipcBridge.commandEve.artifactInputResolve.invoke(request),
        });
        if (artifactInput.status === 'stale') return 'stale';
        if (artifactInput.status === 'unavailable') {
          controls.restoreDraftAndFiles();
          Message.error({ content: t('conversation.workProduct.artifactInputUnavailable'), duration: 6000 });
          return 'rejected';
        }
        agentInputFiles = Array.from(new Set([...allFiles, artifactInput.agentFilePath]));
      }

      const hasDocumentFiles =
        isEveConversation &&
        !(workProductRequest?.mode === 'image' && workProductRequest.action === 'create') &&
        agentInputFiles.some(
          (file) => isCommandEvePdfPath(file) || isCommandEvePresentationPath(file) || isImageFile(file)
        );
      if (
        (workProductRequest?.mode === 'image' || workProductRequest?.mode === 'video') &&
        workProductRequest.action === 'create'
      ) {
        controls.clearSelection();
        try {
          const dispatchResult = await dispatchMessage(
            seatTicket,
            message,
            agentInputFiles,
            allFiles,
            undefined,
            undefined,
            undefined,
            activeComposerSelection,
            activeArtifactReference?.artifactId
          );
          if (dispatchResult === 'rejected') controls.restoreDraftAndFiles();
          return dispatchResult;
        } catch (error) {
          if (!isCurrent()) return 'stale';
          controls.restoreDraftAndFiles();
          throw error;
        }
      }
      if (hasDocumentFiles) {
        documentPreparationInFlightRef.current = true;
        documentPreparationTicketRef.current = seatTicket;
        markConversationDocumentPreparationStarted(conversation_id);
      }
      const settleOwnedDocumentPreparation = () => {
        if (documentPreparationTicketRef.current !== seatTicket) return false;
        documentPreparationTicketRef.current = null;
        documentPreparationInFlightRef.current = false;
        markConversationDocumentPreparationSettled(conversation_id);
        return true;
      };

      const pdfPreparation = await preparePdfFiles(agentInputFiles, isCurrent);
      if (!isCurrent()) return 'stale';
      // A cancelled/failed OCR gate must leave the draft and selected files intact.
      if (pdfPreparation === null) {
        controls.restoreDraftAndFiles();
        settleOwnedDocumentPreparation();
        return 'rejected';
      }
      const pdfPreparedFiles = pdfPreparation.files;
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
        settleOwnedDocumentPreparation();
        Message.error({
          content: t('conversation.visual.sourceLimit', {
            defaultValue: 'Select no more than six images or presentations per turn.',
          }),
          duration: 6000,
        });
        return 'rejected';
      }

      const flowId = visualSourceCount > 0 ? createCommandEveCloudVisualFlowId(uuid(32)) : undefined;
      // MAT-1769 tri-state: 'disabled' reaches the caller WITHOUT a toast so it
      // can raise the one-time in-chat enablement prompt; 'unavailable' gets the
      // honest unavailable notice here (no prompt — a toggle cannot fix a seat
      // whose policy cannot be read); anything else keeps the existing failure.
      type VisualAuthorityIssue =
        | { status: 'issued'; flowId: string; visualPolicyReceipt: CommandEveCloudVisualPolicyReceipt }
        | { status: 'none' }
        | { status: 'disabled' }
        | { status: 'failed' };
      const issueVisualAuthority = async (): Promise<VisualAuthorityIssue> => {
        if (!flowId) return { status: 'none' };
        try {
          const receiptResult = await ipcBridge.commandEve.cloudVisualPolicyReceipt.invoke({ flowId });
          if (!isCurrent()) return { status: 'failed' };
          if (!receiptResult.success || !receiptResult.data?.ok) {
            const failedPolicy = receiptResult.data?.ok === false ? receiptResult.data.policy : undefined;
            if (failedPolicy?.status === 'disabled') {
              return { status: 'disabled' };
            }
            setDocumentPreparation({
              phase: 'presentation_error',
              fileCount: visualSourceCount,
              startedAt: Date.now(),
            });
            Message.error({
              content:
                failedPolicy?.status === 'unavailable'
                  ? t('conversation.visual.enablement.unavailableNotice', {
                      defaultValue:
                        'Vision is currently unavailable for this seat. The image was not sent; draft and files are preserved.',
                    })
                  : t('conversation.visual.managedCloudFailed', {
                      defaultValue: 'Cloud visual analysis is disabled or unavailable for this seat.',
                    }),
              duration: 6000,
            });
            return { status: 'failed' };
          }
          return { status: 'issued', flowId, visualPolicyReceipt: receiptResult.data.receipt };
        } catch (error) {
          if (!isCurrent()) return { status: 'failed' };
          setDocumentPreparation({ phase: 'presentation_error', fileCount: visualSourceCount, startedAt: Date.now() });
          // SCRUBBED (MAT-1749): the builder's own fallback is the RAW upstream string.
          const visualFailureText = scrubModelIdentifiers(
            getConversationRuntimeWorkspaceErrorMessage(error, t),
            CLOUD_MODEL_IDENTIFIERS
          );
          Message.error({
            content:
              visualFailureText ||
              t('conversation.visual.managedCloudFailed', {
                defaultValue: 'Cloud visual analysis is disabled or unavailable for this seat.',
              }),
            duration: 6000,
          });
          return { status: 'failed' };
        }
      };
      const stopAfterVisualAuthorityFailure = () => {
        controls.restoreDraftAndFiles();
        settleOwnedDocumentPreparation();
      };

      // Always let Main inspect PPTX/image sources locally first. A receipt is
      // requested only when Main reports that uncached cloud work is pending; if
      // every sidecar is already local, issuance is deferred until marker minting.
      let presentationPreparation = await preparePresentationFiles(pdfPreparedFiles, undefined, isCurrent);
      if (!isCurrent()) return 'stale';
      if (presentationPreparation === null) {
        controls.restoreDraftAndFiles();
        settleOwnedDocumentPreparation();
        return 'rejected';
      }
      let imagePreparation = await prepareImageFiles(presentationPreparation.files, undefined, isCurrent);
      if (!isCurrent()) return 'stale';
      if (imagePreparation === null) {
        controls.restoreDraftAndFiles();
        settleOwnedDocumentPreparation();
        return 'rejected';
      }

      if (presentationPreparation.requiresVisualPolicyReceipt || imagePreparation.requiresVisualPolicyReceipt) {
        const issued = await issueVisualAuthority();
        if (!isCurrent()) return 'stale';
        if (issued.status === 'disabled') {
          // MAT-1769: the dead-end toast is replaced by the contextual in-chat
          // question. The draft and files are restored first, so the pending
          // send parked on the card is exactly the one the user tried.
          stopAfterVisualAuthorityFailure();
          raiseVisionEnablementPrompt(seatTicket, message, allFiles, controls);
          return 'rejected';
        }
        if (issued.status !== 'issued') {
          stopAfterVisualAuthorityFailure();
          return 'rejected';
        }
        visualAuthority = { flowId: issued.flowId, visualPolicyReceipt: issued.visualPolicyReceipt };

        if (presentationPreparation.requiresVisualPolicyReceipt) {
          const retriedPresentationPreparation = await preparePresentationFiles(
            pdfPreparedFiles,
            visualAuthority,
            isCurrent
          );
          if (!isCurrent()) return 'stale';
          if (retriedPresentationPreparation === null) {
            controls.restoreDraftAndFiles();
            settleOwnedDocumentPreparation();
            return 'rejected';
          }
          presentationPreparation = retriedPresentationPreparation;
        }

        if (imagePreparation.requiresVisualPolicyReceipt) {
          const retriedImagePreparation = await prepareImageFiles(
            presentationPreparation.files,
            visualAuthority,
            isCurrent
          );
          if (!isCurrent()) return 'stale';
          if (retriedImagePreparation === null) {
            controls.restoreDraftAndFiles();
            settleOwnedDocumentPreparation();
            return 'rejected';
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
        settleOwnedDocumentPreparation();
        Message.error({
          content:
            composedContext.reason_code === 'EVE_PREPARED_CONTEXT_TOO_LARGE'
              ? t('conversation.presentation.contextTooLarge', {
                  defaultValue: 'The prepared presentation context is too large. Split the deck and try again.',
                })
              : t('conversation.presentation.prepareFailed'),
          duration: 6000,
        });
        return 'rejected';
      }
      const preparedContext = composedContext?.context;
      const visuallyPreparedFiles = imagePreparation.files;
      const attachmentGroundingEntries = [
        ...pdfPreparation.attachmentGroundingEntries,
        ...imagePreparation.attachmentGroundingEntries,
      ];
      const expectedGroundingCount = agentInputFiles.filter(
        (file) => isCommandEvePdfPath(file) || isImageFile(file)
      ).length;
      const attachmentGrounding = buildCommandEveAttachmentGroundingRequest(attachmentGroundingEntries);
      if (
        isEveConversation &&
        expectedGroundingCount > 0 &&
        (attachmentGroundingEntries.length !== expectedGroundingCount || !attachmentGrounding)
      ) {
        controls.restoreDraftAndFiles();
        settleOwnedDocumentPreparation();
        Message.error({ content: t('conversation.documents.prepareFailed'), duration: 6000 });
        return 'rejected';
      }

      controls.clearSelection();

      try {
        const dispatchResult = await dispatchMessage(
          seatTicket,
          message,
          visuallyPreparedFiles,
          allFiles,
          preparedContext,
          visualContexts.length || undefined,
          attachmentGrounding,
          workProductRequest ? activeComposerSelection : undefined,
          activeArtifactReference?.artifactId
        );
        if (dispatchResult === 'rejected') controls.restoreDraftAndFiles();
        if (dispatchResult === 'accepted' && workProductRequest) {
          controls.consumeComposerSelection?.();
        }
        // A stale result belongs to the seat/generation that was fenced while
        // this async send was in flight. Restoring that draft would write old
        // seat input and attachments into the newly bound seat, so stale work
        // is discarded without any shared UI mutation.
        return dispatchResult;
      } catch (error) {
        if (!isCurrent()) return 'stale';
        controls.restoreDraftAndFiles();
        // MAT-1769: every sidecar was cached, so the disabled policy only
        // surfaced at marker minting inside executeCommand. Same answer as the
        // first wall: ask once, in chat, instead of failing the send.
        if (error instanceof CommandEveVisionPolicyDisabledError) {
          raiseVisionEnablementPrompt(seatTicket, message, allFiles, controls);
          return 'rejected';
        }
        throw error;
      } finally {
        // A late preparation callback from seat A must not clear seat B's
        // in-flight preparation after a same-conversation rebind. Ownership is
        // the exact immutable seat ticket captured before the first await.
        const settledOwnedPreparation = hasDocumentFiles && settleOwnedDocumentPreparation();
        if (settledOwnedPreparation && isCurrent()) {
          setDocumentPreparation(null);
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
      raiseVisionEnablementPrompt,
      selectedReferenceArtifact,
      videoTierId,
      videoModelId,
      videoDurationSeconds,
      videoCapabilities,
      videoVoiceIds,
    ]
  );

  // MAT-1769 — "Vision aktivieren": persist the enablement through the existing
  // Main-authoritative policy path (the ONE-TIME decision, per seat), then
  // re-drive the exact parked send. Preparation re-runs against Main's local
  // sidecars, the receipt now issues, and the send continues with no further
  // question. A failed mutation keeps the card open and sends nothing — the
  // image never leaves the device on a half-made decision.
  //
  // SINGLE-FLIGHT (Grok review 2026-08-03, MAJOR 2): the busy flag lives in a
  // REF checked synchronously, because a useState guard only takes effect
  // after the re-render — a double-click inside that window would run the
  // policy write AND the paid re-drive twice. Busy holds through the re-drive,
  // not just through the policy call.
  const visionEnablementBusyRef = useRef(false);
  const visionEnablementBusyTicketRef = useRef<ConversationRuntimeSeatTicket | null>(null);
  const handleVisionEnablementAccept = useCallback(async () => {
    const pending = visionEnablementPending;
    if (!pending || visionEnablementBusyRef.current) return;
    if (!runtimeView.isSeatTicketCurrent(pending.seatTicket)) {
      setVisionEnablementPending(null);
      return;
    }
    visionEnablementBusyRef.current = true;
    visionEnablementBusyTicketRef.current = pending.seatTicket;
    setVisionEnablementBusy(true);
    try {
      let result: Awaited<ReturnType<typeof ipcBridge.commandEve.cloudVisualPolicySet.invoke>>;
      try {
        result = await ipcBridge.commandEve.cloudVisualPolicySet.invoke({
          expectedSeatId: pending.seatTicket.seatId,
          enabled: true,
        });
      } catch {
        if (!runtimeView.isSeatTicketCurrent(pending.seatTicket)) return;
        Message.error({
          content: t('conversation.visual.enablement.enableFailed', {
            defaultValue: 'Vision could not be enabled. Draft and files are preserved.',
          }),
          duration: 6000,
        });
        return;
      }
      if (!runtimeView.isSeatTicketCurrent(pending.seatTicket)) return;
      if (!result.success || !result.data?.ok) {
        // A failed mutation keeps the card open and sends nothing — the image
        // never leaves the device on a half-made decision.
        Message.error({
          content: t('conversation.visual.enablement.enableFailed', {
            defaultValue: 'Vision could not be enabled. Draft and files are preserved.',
          }),
          duration: 6000,
        });
        return;
      }
      // The re-drive runs INSIDE the busy window: a second click while it is in
      // flight is refused by the ref, not by a rendered state.
      setVisionEnablementPending(null);
      await submitMessage(pending.seatTicket, pending.message, pending.allFiles, pending.controls);
    } finally {
      if (visionEnablementBusyTicketRef.current === pending.seatTicket) {
        visionEnablementBusyTicketRef.current = null;
        visionEnablementBusyRef.current = false;
        setVisionEnablementBusy(false);
      }
    }
  }, [runtimeView, submitMessage, t, visionEnablementPending]);

  // MAT-1769 — "Nicht jetzt": persist the DECLINE (per seat, one-time), dismiss
  // the card, and send nothing. No upload, no provider call and no debit happen
  // on this path. The "never again" claim is only made when the write LANDED
  // (Grok review 2026-08-03, MAJOR 3): a failed persist gets the honest notice
  // that the question will come back — the decline itself is always free.
  const handleVisionEnablementDecline = useCallback(async () => {
    const pending = visionEnablementPending;
    if (!pending || visionEnablementBusyRef.current) return;
    if (!runtimeView.isSeatTicketCurrent(pending.seatTicket)) {
      setVisionEnablementPending(null);
      return;
    }
    visionEnablementBusyRef.current = true;
    visionEnablementBusyTicketRef.current = pending.seatTicket;
    setVisionEnablementBusy(true);
    setVisionEnablementPending(null);
    try {
      await configService.set('commandEve.visionEnablementDeclined', true);
      if (!runtimeView.isSeatTicketCurrent(pending.seatTicket)) return;
      Message.warning({
        content: t('conversation.visual.enablement.declinedNotice', {
          defaultValue:
            'Vision stays off, so the image was not sent. You can enable Vision any time under Settings → Privacy.',
        }),
        duration: 6000,
      });
    } catch {
      if (!runtimeView.isSeatTicketCurrent(pending.seatTicket)) return;
      Message.warning({
        content: t('conversation.visual.enablement.declineSaveFailed', {
          defaultValue:
            'Vision stays off, so the image was not sent. Your decision could not be saved and will be asked again for the next image.',
        }),
        duration: 6000,
      });
    } finally {
      if (visionEnablementBusyTicketRef.current === pending.seatTicket) {
        visionEnablementBusyTicketRef.current = null;
        visionEnablementBusyRef.current = false;
        setVisionEnablementBusy(false);
      }
    }
  }, [runtimeView, t, visionEnablementPending]);

  useEffect(
    () => () => {
      documentPreparationInFlightRef.current = false;
      documentPreparationTicketRef.current = null;
      visionEnablementBusyTicketRef.current = null;
      markConversationDocumentPreparationSettled(conversation_id);
    },
    [conversation_id]
  );

  useEffect(() => {
    documentPreparationInFlightRef.current = false;
    documentPreparationTicketRef.current = null;
    setDocumentPreparation(null);
    setVisionEnablementPending(null);
    visionEnablementBusyTicketRef.current = null;
    visionEnablementBusyRef.current = false;
    setVisionEnablementBusy(false);
  }, [activeSeatId]);

  const onSendHandler = useCallback(
    async (message: string): Promise<void> => {
      const seatTicket = runtimeView.captureSeatTicket();
      const draftContent = content || message;
      const selectedAtPath = [...atPath];
      const selectedUploadFiles = [...uploadFile];
      const atPathFiles = selectedAtPath.map((item) => (typeof item === 'string' ? item : item.path));
      const allFiles = [...selectedUploadFiles, ...atPathFiles];

      await submitMessage(seatTicket, message, allFiles, {
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
        composerSelection,
        selectedArtifactReference,
        consumeComposerSelection,
      });
    },
    [
      atPath,
      clearFiles,
      composerSelection,
      conversationMessages,
      consumeComposerSelection,
      content,
      isEveConversation,
      runtimeView,
      selectedArtifactReference,
      setAtPath,
      setContent,
      setUploadFile,
      submitMessage,
      t,
      uploadFile,
    ]
  );

  const sendInitialMessage = useCallback(
    async (
      input: string,
      files: string[],
      videoSelection: VideoDraftSelection | undefined,
      initialComposerSelection: ComposerWorkProductSelection = DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION
    ): Promise<boolean> => {
      // The guid handoff carries the picker state with the first send: adopt it
      // so the pill shows what was sent, and pass it THROUGH as data — state
      // set here would not reach this send's own closure.
      if (videoSelection) applyVideoSelection(videoSelection);
      setComposerSelection(initialComposerSelection);
      const seatTicket = runtimeView.captureSeatTicket();
      try {
        return (
          (await submitMessage(seatTicket, input, files, {
            clearSelection: () => {},
            restoreDraftAndFiles: () => {
              if (!runtimeView.isSeatTicketCurrent(seatTicket)) return;
              setContent(input);
              setUploadFile(files);
              setAtPath([]);
              emitter.emit('acp.selected.file.clear');
            },
            ...(videoSelection === undefined ? {} : { videoSelection }),
            composerSelection: initialComposerSelection,
            selectedArtifactReference: null,
            consumeComposerSelection,
          })) === 'accepted'
        );
      } catch {
        // executeCommand already rendered the structured failure and restored
        // the fresh-chat draft. Do not add a second generic error message here.
        return false;
      }
    },
    [
      applyVideoSelection,
      consumeComposerSelection,
      runtimeView,
      setAtPath,
      setComposerSelection,
      setContent,
      setUploadFile,
      submitMessage,
    ]
  );

  // The Guid/startscreen handoff is only transport. All real submission work
  // stays in submitMessage so PDFs, video gates, queues, and recovery cannot drift.
  useAcpInitialMessage({
    conversation_id,
    seatId: activeSeatId,
    sendInitialMessage,
    resetState,
    addOrUpdateMessage: addOrUpdateMessageRef.current,
    // CEVE-18205: the fresh-chat handoff dies on the same send path — feed the
    // same wall, so its 402 shows the warm credits wall too, not a cold card.
    reportInferenceError: quotaWall?.reportInferenceError,
  });

  const handleEditQueuedCommand = useCallback(
    (item: ConversationCommandQueueItem) => {
      remove(item.id);
      setContent(item.input);
      setUploadFile(Array.from(new Set(item.displayFiles ?? item.files)));
      setAtPath([]);
      emitter.emit('acp.selected.file.clear');
      if (item.composerSelection) {
        setComposerSelection(item.composerSelection);
        const artifact = item.selectedArtifactId
          ? conversationArtifacts.find((candidate) => candidate.id === item.selectedArtifactId)
          : undefined;
        setSelectedArtifactReference(resolveComposerArtifactReference(artifact));
      } else {
        setComposerSelection(DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION);
        setSelectedArtifactReference(null);
      }
    },
    [conversationArtifacts, remove, setAtPath, setContent, setUploadFile]
  );

  const handlePromoteQueuedCommand = useCallback(
    async (item: ConversationCommandQueueItem) => {
      if (item.composerSelection !== undefined || item.selectedArtifactId !== undefined) {
        Message.warning(
          t('conversation.commandQueue.promoteAuthorityUnsupported', {
            defaultValue: 'Work with an explicit artifact or work product stays queued.',
          })
        );
        return;
      }
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
      const seatTicket = runtimeView.captureSeatTicket();
      if (!runtimeView.isSeatTicketCurrent(seatTicket) || item.conversationId !== conversation_id) {
        unlockInteraction();
        return;
      }

      try {
        // Remove before dispatch so a double click cannot send the same correction
        // twice. A failed dispatch restores the exact item below.
        await remove(item.id);
        const correction = buildConversationBusyControlCommand({ input: item.input, mode: 'steer' });
        if (!correction) {
          throw new Error('Queued correction is empty.');
        }
        const result = await dispatchSteer(seatTicket, correction.input, item.id);
        if (result === 'stale') return;
        emitter.emit('chat.history.refresh');
      } catch (error) {
        if (!runtimeView.isSeatTicketCurrent(seatTicket)) return;
        await restore(item);
        // SCRUBBED (MAT-1749): a steer dispatch failure can carry upstream text.
        const promoteFailureText = scrubModelIdentifiers(parseError(error), CLOUD_MODEL_IDENTIFIERS);
        Message.error({
          content:
            promoteFailureText ||
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
      conversation_id,
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
    const currentPermissionLabel = isEveConversation ? (eveAuthorityLabel ?? currentModeLabel) : currentModeLabel;

    const entries: MobileActionSheetEntry[] = [];

    // THE LANE ENTRY IS GONE (MAT-1749). It offered `Verarbeitung → EVE Cloud /
    // Lokal`, which is a composer intelligence/lane-selection affordance — the
    // exact class this release removes, ladder nomenclature or not. Choosing the
    // private LOCAL lane is a deliberate Settings → Modell decision now, and the
    // composer's ONE intelligence affordance is the MAX toggle.
    //
    // The `isEveConversation` guard STAYS, and it is load-bearing: without it an
    // EVE conversation would fall into the raw model list below and simply swap
    // one composer lane picker for another.
    if (!isEveConversation && modelOptions.length > 0) {
      // Model entry: only when the agent exposes a switchable list. Otherwise
      // (Codex with no list, no info) skip — exposing a no-op row would be noise.
      entries.push({
        key: 'model',
        icon: <Brain size='16' />,
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
        icon: <Shield size='16' />,
        label: t('agentMode.permission', { defaultValue: 'Permission' }),
        meta: currentPermissionLabel,
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
        icon: busySendMode === 'steer' ? <EditOne size='16' /> : <Time size='16' />,
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
        icon: <MagicHat size='16' />,
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
        icon: <Shield size='16' />,
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
    eveAuthorityLabel,
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
  const handleStop = async (): Promise<boolean> => {
    const stopTicket = runtimeView.issueStopAttempt();
    if (!stopTicket) return false;
    voiceDialogue.cancel();
    pause();
    const turnId =
      runtimeView.activeTurnId ??
      (runtimeView.view.localSubmitting
        ? await waitForConversationActiveTurnId(conversation_id, { timeoutMs: 5_000 })
        : null);
    if (!turnId) {
      if (!runtimeView.abandonAttempt(stopTicket)) return false;
      const currentRuntime = getConversationRuntimeViewSnapshot(conversation_id);
      if (!currentRuntime.isProcessing) {
        resetState();
        resetActiveExecution('stop');
        return true;
      }
      emitAcpPerformanceMark({
        stage: 'turn_cancel_failed',
        conversationId: conversation_id,
      });
      Message.error(
        t('conversation.chat.voiceDialogue.cancelFailed', {
          defaultValue: 'The running reply could not be stopped. Your microphone state is unchanged.',
        })
      );
      return false;
    }
    if (!runtimeView.markStopRequested(stopTicket, turnId)) return false;
    emitAcpPerformanceMark({
      stage: 'turn_cancel_requested',
      conversationId: conversation_id,
      turnId,
    });
    try {
      const result = await ipcBridge.conversation.stop.invoke({ conversation_id, turn_id: turnId });
      if (!runtimeView.markStopAcknowledged(stopTicket, turnId, result.runtime)) return false;
      resetState();
      resetActiveExecution('stop');
      emitAcpPerformanceMark({
        stage: 'turn_cancel_acknowledged',
        conversationId: conversation_id,
        turnId,
      });
      return true;
    } catch (error) {
      console.warn('[AcpSendBox] stop request failed', error);
      if (!runtimeView.resetLocalGate(stopTicket, 'stop_failed')) return false;
      emitAcpPerformanceMark({
        stage: 'turn_cancel_failed',
        conversationId: conversation_id,
        turnId,
      });
      Message.error(
        t('conversation.chat.voiceDialogue.cancelFailed', {
          defaultValue: 'The running reply could not be stopped. Your microphone state is unchanged.',
        })
      );
      return false;
    }
  };

  const workProductModes = [
    {
      mode: 'image' as const,
      label: t('conversation.workProduct.image.label', { defaultValue: 'Bild erstellen' }),
      tooltip: t('conversation.workProduct.image.tooltip', { defaultValue: 'Bild erstellen oder bearbeiten' }),
    },
    {
      mode: 'video' as const,
      label: t('conversation.workProduct.video.label', { defaultValue: 'Video erstellen' }),
      tooltip: t('conversation.workProduct.video.tooltip', { defaultValue: 'Video erstellen oder bearbeiten' }),
    },
    {
      mode: 'presentation' as const,
      label: t('conversation.workProduct.presentation.label', { defaultValue: 'Präsentation erstellen' }),
      tooltip: t('conversation.workProduct.presentation.tooltip', {
        defaultValue: 'Präsentation erstellen oder bearbeiten',
      }),
    },
    {
      mode: 'pdf' as const,
      label: t('conversation.workProduct.pdf.label', { defaultValue: 'PDF erstellen' }),
      tooltip: t('conversation.workProduct.pdf.tooltip', { defaultValue: 'PDF erstellen oder bearbeiten' }),
    },
    {
      mode: 'word' as const,
      label: t('conversation.workProduct.word.label', { defaultValue: 'Word erstellen' }),
      tooltip: t('conversation.workProduct.word.tooltip', { defaultValue: 'Word-Dokument erstellen oder bearbeiten' }),
    },
    {
      mode: 'excel' as const,
      label: t('conversation.workProduct.excel.label', { defaultValue: 'Excel erstellen' }),
      tooltip: t('conversation.workProduct.excel.tooltip', { defaultValue: 'Excel-Datei erstellen oder bearbeiten' }),
    },
  ];
  const workProductActions = {
    toolbarLabel: t('conversation.workProduct.toolbarLabel', { defaultValue: 'Arbeitsprodukt auswählen' }),
    returnToChatLabel: t('conversation.workProduct.returnToChat', { defaultValue: 'Zurück zum normalen Chat' }),
    selectedReferenceLabel: t('conversation.workProduct.selectedReference', {
      defaultValue: 'Ausgewähltes Artefakt',
    }),
    removeReferenceLabel: t('conversation.workProduct.removeReference', { defaultValue: 'Artefakt entfernen' }),
  };
  const { referenceImagePath: localImageReferencePath, visibleFiles: visibleUploadFiles } =
    resolveComposerAttachmentPresentation(composerSelection.mode, uploadFile, selectedArtifactReference !== null);
  const selectedReferenceChip = selectedArtifactReference
    ? {
        title: selectedArtifactReference.title,
        kind: selectedArtifactReference.referenceKind,
        kindLabel:
          selectedArtifactReference.referenceKind === 'image'
            ? t('conversation.workProduct.referenceImage', { defaultValue: 'Referenzbild' })
            : t(`conversation.workProduct.kind.${selectedArtifactReference.referenceKind}`, {
                defaultValue:
                  selectedArtifactReference.referenceKind === 'video'
                    ? 'Video'
                    : selectedArtifactReference.referenceKind === 'presentation'
                      ? 'PPTX'
                      : selectedArtifactReference.referenceKind === 'pdf'
                        ? 'PDF'
                        : selectedArtifactReference.referenceKind === 'word'
                          ? 'Word'
                          : 'Excel',
              }),
        preview:
          selectedArtifactReference.referenceKind === 'image' && selectedArtifactReference.managedImage ? (
            <ComposerReferencePreview
              conversationId={selectedArtifactReference.conversationId}
              artifactId={selectedArtifactReference.artifactId}
              alt=''
            />
          ) : undefined,
      }
    : localImageReferencePath
      ? {
          title: localImageReferencePath.split(/[\\/]/).at(-1) || 'Referenzbild',
          kind: 'image' as const,
          kindLabel: t('conversation.workProduct.referenceImage', { defaultValue: 'Referenzbild' }),
          preview: <ComposerReferencePreview path={localImageReferencePath} alt='' />,
        }
      : undefined;
  const removeSelectedReference = selectedArtifactReference
    ? clearComposerReference
    : localImageReferencePath
      ? () => setUploadFile(uploadFile.filter((path) => path !== localImageReferencePath))
      : undefined;
  const workProductCapabilityMenu = (
    <>
      {loadedSkills.map((name) => (
        <Menu.Item
          key={`work-product-skill-${name}`}
          onClick={(event) => {
            event.stopPropagation();
            setContent(`/${name} `);
          }}
        >
          <span className='inline-flex min-w-0 items-center gap-8px'>
            <MagicHat size='15' aria-hidden='true' />
            <span className='truncate'>/{name}</span>
          </span>
        </Menu.Item>
      ))}
      {loadedMcpStatuses.map((item) => (
        <Menu.Item
          key={`work-product-mcp-${item.id}`}
          onClick={(event) => {
            event.stopPropagation();
            window.location.hash = '#/connectors';
          }}
        >
          <span className='inline-flex min-w-0 items-center gap-8px'>
            <Shield size='15' aria-hidden='true' />
            <span className='truncate'>{item.name}</span>
            <span className='ml-auto text-11px text-t-secondary'>
              {t(`conversation.mcp.status.${item.status}` as const)}
            </span>
          </span>
        </Menu.Item>
      ))}
      <Menu.Item
        key='work-product-capability-catalog'
        onClick={(event) => {
          event.stopPropagation();
          window.location.hash = '#/connectors';
        }}
      >
        <span className='text-12px text-t-secondary'>
          {t('conversation.mcp.openSettings', { defaultValue: 'Connector Catalog öffnen' })}
        </span>
      </Menu.Item>
    </>
  );
  const agentModeControl = showModeSelector ? (
    <AgentModeSelector
      backend={backend}
      conversation_id={conversation_id}
      compact
      initialMode={session_mode}
      compactLeadingIcon={<Shield size='14' />}
      modeLabelFormatter={formatModeLabel}
      compactLabelOverride={eveAuthorityLabel}
      compactLabelPrefix={t('agentMode.permission')}
      hideCompactLabelPrefixOnMobile
      onModeChanged={handleDesktopModeChanged}
      beforeRuntimeSync={prepareRuntimeSync}
    />
  ) : null;
  const workProductOptionControls = (
    <>
      <ImageModelPill
        visible={showImageControls && (!showImageEditControls || imageModelRegistry !== null)}
        value={selectedImageTier}
        onChange={handleImageModelTierChange}
        registry={imageModelRegistry}
        resolution={imageResolution}
        onResolutionChange={handleImageResolutionChange}
        operation={showImageEditControls ? 'edit' : 'generate'}
        referenceCount={imageReferenceCount}
      />
      <ImageAspectRatioPill
        visible={showImageControls && (!showImageEditControls || imageModelRegistry !== null)}
        value={imageAspectRatio}
        onChange={handleImageAspectRatioChange}
      />
      <VideoQualityPill
        visible={showVideoCreateControls}
        value={videoTierId}
        onChange={handleVideoTierChange}
        modelId={videoModelId}
        onModelChange={handleVideoModelChange}
        resolution={videoResolution}
        onResolutionChange={handleVideoResolutionChange}
        durationSeconds={videoDurationSeconds}
        onDurationChange={setVideoDurationSeconds}
        modeKind={videoModeKind}
        capabilities={videoCapabilities}
        catalogEntries={videoCatalog.entries}
        catalogApproximate={videoCatalog.approximate}
        presetVoices={VIDEO_PRESET_VOICES}
        selectedVoiceIds={videoVoiceIds}
        onVoiceToggle={toggleVideoVoice}
      />
    </>
  );

  return (
    <div ref={composerRootRef} className='acp-send-box max-w-800px w-full mx-auto flex flex-col mt-auto mb-16px'>
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
        // The ONLY thing that disables this composer's send: a HELD lane. The
        // textarea stays editable (keepInputEditableWhenDisabled semantics), so a
        // held turn can still be composed — it just cannot leave.
        disabled={eveSendHeld}
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
        onStop={async () => {
          await handleStop();
        }}
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
              icon={isEveConversation ? 'plus' : 'paperclip'}
            />
            {isEveConversation ? (
              <WorkProductModeSelector
                value={composerSelection.mode}
                onChange={handleComposerModeChange}
                modes={workProductModes}
                actions={workProductActions}
                disabled={eveSendHeld}
                capabilityLabel={t('conversation.workProduct.capabilities')}
                capabilityCount={loadedSkills.length + loadedMcpStatuses.length}
                capabilityMenu={workProductCapabilityMenu}
              />
            ) : !isMobile ? (
              <WorkspaceContextControl workspacePath={workspacePath} projectName={durableProjectName ?? undefined} />
            ) : null}
            {isEveConversation && agentModeControl ? (
              <span style={{ display: 'none' }} aria-hidden='true'>
                {agentModeControl}
              </span>
            ) : null}
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
            permissionSlot={isEveConversation ? null : agentModeControl}
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
            micSlot={
              <>
                {isEveConversation ? (
                  <VoiceDialogueControl
                    enabled={voiceDialogue.enabled}
                    phase={voiceDialogue.phase}
                    onToggle={voiceDialogue.toggle}
                  />
                ) : null}
                <SpeechInputButton
                  ref={speechInputRef}
                  beforeStartRecording={
                    isEveConversation
                      ? async () => {
                          if (voiceDialogue.beforeStartRecording()) return handleStop();
                          return true;
                        }
                      : undefined
                  }
                  disabled={
                    isBusy &&
                    !(
                      isEveConversation &&
                      voiceDialogue.enabled &&
                      (runtimeView.view.localSubmitting || Boolean(runtimeView.activeTurnId))
                    )
                  }
                  forceLocalTranscription={isEveConversation && voiceDialogue.enabled}
                  locale={i18n?.language || 'de-DE'}
                  onTranscript={handleSpeechTranscript}
                  onStatusChange={setSpeechInputStatus}
                />
              </>
            }
          />
        }
        prefix={
          <>
            {isEveConversation ? (
              selectedReferenceChip ? (
                <WorkProductModeHeader
                  value={composerSelection.mode}
                  onChange={handleComposerModeChange}
                  modes={workProductModes}
                  actions={workProductActions}
                  disabled={eveSendHeld}
                  controls={workProductOptionControls}
                  selectedReference={selectedReferenceChip}
                  onRemoveReference={removeSelectedReference as () => void}
                />
              ) : (
                <WorkProductModeHeader
                  value={composerSelection.mode}
                  onChange={handleComposerModeChange}
                  modes={workProductModes}
                  actions={workProductActions}
                  disabled={eveSendHeld}
                  controls={workProductOptionControls}
                />
              )
            ) : null}
            {/* One-time Vision enablement prompt (MAT-1769). Renders in the
                draft band like the pills — inline, keyboard-reachable, never a
                modal — and only for a send that actually hit the disabled
                cloud-visual policy wall. Already-enabled seats never see it. */}
            {visionEnablementPending ? (
              <AcpVisionEnablementPrompt
                busy={visionEnablementBusy}
                onAccept={() => void handleVisionEnablementAccept()}
                onDecline={handleVisionEnablementDecline}
              />
            ) : null}
            {/* Compact video-EDIT affordance (1.820.3). A mutation intent
                over the visible source clip shows this — no resolution,
                duration or voice selector, because the edit tool inherits
                all of them from the source. Visibility only: the send stays
                a normal Hermes turn. */}
            {showVideoEditHint ? (
              <div className='video-edit-hint' role='note' aria-live='polite' data-testid='video-edit-hint'>
                <span className='video-edit-hint__label'>
                  {t('credits.video.editHintLabel', { defaultValue: 'Video bearbeiten' })}
                </span>
                {videoEditEstimate ? (
                  <span className='video-edit-hint__estimate'>
                    {t('credits.video.inlineEstimate', {
                      defaultValue: 'ca. {{credits}} Credits / {{sec}}s',
                      credits: videoEditEstimate.credits,
                      sec: videoEditEstimate.seconds,
                    })}
                  </span>
                ) : null}
              </div>
            ) : null}
            {/* The reference ceiling, BEFORE sending. A warning, never a gate:
                send stays enabled and the gateway remains the only enforcer.
                It sits beside the attachments it is about, so the number and
                the thumbnails are read together. */}
            <ImageReferenceCeilingHint
              visible={showImageControls}
              registry={imageModelRegistry}
              tierId={selectedImageTier}
              referenceCount={imageReferenceCount}
            />
            {visibleUploadFiles.length > 0 && (
              <HorizontalFileList>
                {visibleUploadFiles.map((path) => (
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
        footerSlot={
          isEveConversation ? (
            <ComposerContextDeck
              projectSlot={
                <WorkspaceContextControl
                  workspacePath={workspacePath}
                  projectName={durableProjectName ?? undefined}
                  compactLabel
                />
              }
              maxSlot={<EveMaxToggle disabled={isBusy} />}
              tokenUsage={tokenUsage}
              contextLimit={context_limit}
              modelId={indicatorModelId}
            />
          ) : undefined
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
