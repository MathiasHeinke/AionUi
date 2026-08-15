/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ICommandEveAssistantReadiness, ICommandEveRuntimeStatus } from '@/common/adapter/ipcBridge';
import {
  COMMAND_EVE_ASSISTANT_ID,
  COMMAND_EVE_DEFAULT_ACP_BACKEND,
  COMMAND_EVE_DISPLAY_NAME,
  COMMAND_EVE_SHELL_ENABLED,
  getCommandEveAcpModelIdForTier,
  normalizeCommandEveLocalModelTierId,
} from '@/common/config/commandEveShell';
import { configService } from '@/common/config/configService';
import {
  isConnectedSelection,
  isEveInferenceSelection,
  resolveEffectiveInferenceSelection,
} from '@/common/config/eveInferenceCore';
import { isCommandEveManagedImageMcp } from '@/common/config/eveManagedMcpCore';
import type { IMcpServer, TProviderWithModel } from '@/common/config/storage';
import { buildAgentConversationParams } from '@/common/utils/buildAgentConversationParams';
import { getConversationCreateErrorMessage } from '@/renderer/pages/conversation/utils/conversationCreateError';
import type { SkillCapabilityCatalog } from '@/renderer/hooks/capabilities';
import { useEveMaxAuthority } from '@/renderer/hooks/agent/useEveMaxAuthority';
import { toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import { emitter } from '@/renderer/utils/emitter';
import { updateWorkspaceTime } from '@/renderer/utils/workspace/workspaceHistory';
import { Message } from '@arco-design/web-react';
import { useCallback, useRef } from 'react';
import { type TFunction } from 'i18next';
import type { NavigateFunction } from 'react-router-dom';
import type { AcpModelInfo, AvailableAgent, EffectiveAgentInfo } from '../types';
import { scrubModelIdentifiers } from '@/common/config/modelIdentifierScrub';
import { CLOUD_MODEL_IDENTIFIERS } from '@/renderer/utils/model/modelContextLimits';
import { isVideoLaneRequest } from '@/common/config/videoCostCore';
import type { VideoDraftSelection } from '@/renderer/components/billing/useVideoComposerSelection';

export type GuidSendDeps = {
  // Input state
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  files: string[];
  setFiles: React.Dispatch<React.SetStateAction<string[]>>;
  dir: string;
  setDir: React.Dispatch<React.SetStateAction<string>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  loading: boolean;

  // Agent state
  selectedAgent: string;
  selectedAgentKey: string;
  selectedAgentInfo: AvailableAgent | undefined;
  is_presetAgent: boolean;
  selectedMode: string;
  selectedAcpModel: string | null;
  currentAcpCachedModelInfo: AcpModelInfo | null;
  current_model: TProviderWithModel | undefined;

  // Agent helpers
  findAgentByKey: (key: string) => AvailableAgent | undefined;
  getEffectiveAgentType: (
    agentInfo: { agent_type: string; backend?: string; custom_agent_id?: string } | undefined
  ) => EffectiveAgentInfo;
  resolvePresetRulesAndSkills: (
    agentInfo: { agent_type: string; backend?: string; custom_agent_id?: string; context?: string } | undefined
  ) => Promise<{ rules?: string; skills?: string }>;
  skillCatalog: SkillCapabilityCatalog;
  availableMcpServers?: IMcpServer[];
  selectedMcpServerIds?: string[];
  currentEffectiveAgentInfo: EffectiveAgentInfo;
  isGoogleAuth: boolean;

  /**
   * MAT-1773 (P3) — the video-creation selection held by the start-chat pill,
   * read at send time. Optional: shells without the pill never carry one.
   */
  getVideoSelection?: () => VideoDraftSelection;

  // Mention state reset
  setMentionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMentionQuery: React.Dispatch<React.SetStateAction<string | null>>;
  setMentionSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMentionActiveIndex: React.Dispatch<React.SetStateAction<number>>;

  // Navigation
  navigate: NavigateFunction;
  t: TFunction;
};

export type GuidSendResult = {
  handleSend: () => Promise<boolean>;
  sendMessageHandler: () => void;
  isButtonDisabled: boolean;
  /**
   * TRUE while MAIN reports the EVE lane HELD (MAX intent, entitlement not yet
   * verified). Exposed so a surface can EXPLAIN the held send button; the hold
   * itself is already applied to `isButtonDisabled` and `sendMessageHandler`.
   */
  eveSendHeld: boolean;
};

const toCommandEveRuntimeModelId = (acpModelId: string): string => acpModelId.replace(/^custom:/, '');

const navigateToConversation = async (navigate: NavigateFunction, conversationId: string): Promise<void> => {
  const target = `/conversation/${conversationId}`;
  await Promise.resolve(navigate(target));
  if (typeof window !== 'undefined' && window.location.hash.startsWith('#/') && window.location.hash !== `#${target}`) {
    window.location.hash = target;
  }
};

export const commandEveWarmupReadyForModel = (
  warmup: ICommandEveRuntimeStatus['model_warmup'] | undefined,
  runtimeModelId: string
): boolean => Boolean(warmup && warmup.model === runtimeModelId && warmup.status === 'ready');

export type CommandEveCloudUnavailableReason = 'offline' | 'activation';

export const resolveCommandEveCloudUnavailableReason = ({
  isOffline,
  hasResolvedProvider,
}: {
  isOffline: boolean;
  hasResolvedProvider: boolean;
}): CommandEveCloudUnavailableReason | null => {
  if (isOffline) return 'offline';
  return hasResolvedProvider ? null : 'activation';
};

/**
 * Hook that manages the send logic for all conversation types (openclaw/nanobot/acp).
 */
export const useGuidSend = (deps: GuidSendDeps): GuidSendResult => {
  const {
    input,
    setInput,
    files,
    setFiles,
    dir,
    setDir,
    setLoading,
    loading,
    selectedAgent,
    selectedAgentKey,
    selectedAgentInfo,
    is_presetAgent,
    selectedMode,
    selectedAcpModel,
    currentAcpCachedModelInfo,
    current_model,
    findAgentByKey,
    getEffectiveAgentType,
    resolvePresetRulesAndSkills,
    skillCatalog,
    availableMcpServers = [],
    selectedMcpServerIds,
    setMentionOpen,
    setMentionQuery,
    setMentionSelectorOpen,
    setMentionActiveIndex,
    navigate,
    t,
  } = deps;
  const getVideoSelection = deps.getVideoSelection;
  const sendingRef = useRef(false);
  // The MAIN-process lane decision, read through the SAME authority the composer
  // paints from — never a second derivation. `entitlementPending` is true only
  // while main reports a HELD lane for the active seat: MAX intent whose
  // entitlement is not yet verified. Only meaningful in the EVE shell, which is
  // the only shell that has a MAX lane at all.
  const { entitlementPending } = useEveMaxAuthority();
  const eveSendHeld = COMMAND_EVE_SHELL_ENABLED && entitlementPending;
  const skillSelectionReady = skillCatalog.mode === 'selection' && skillCatalog.status === 'ready';
  const guidEnabledSkills = skillSelectionReady ? skillCatalog.selection.enabledSkills : undefined;
  const guidDisabledBuiltinSkills = skillSelectionReady ? skillCatalog.selection.excludedAutoInjectSkills : undefined;

  const handleSend = useCallback(async () => {
    // THE HOLD LIVES HERE, on the function that actually starts the turn.
    //
    // It used to live only in `sendMessageHandler` below, which wraps this one —
    // but `handleSend` is RETURNED from this hook and is therefore directly
    // callable by anything holding the result, wrapper or no wrapper. A guard on
    // the wrapper protects the wrapper's callers, not the exported entry point,
    // and the committed tests demonstrate the gap rather than close it: five of
    // them call `handleSend()` directly and every one of them would have started a
    // turn on a held lane. The wrapper keeps its own early return (it must not
    // flip loading state for a turn that will not run); this is the one that
    // decides whether a held turn can begin at all.
    if (eveSendHeld) return false;
    let commandEveRuntimeModel: TProviderWithModel | undefined;
    let commandEveRuntimeModelId: string | undefined;
    let commandEveAssistantReadiness: ICommandEveAssistantReadiness | undefined;
    // The branded shell must stay on EVE even when its persisted assistant seed
    // is temporarily unavailable. The readiness call below repairs/loads the
    // assistant; falling back to the selected raw CLI would leak internals and
    // route the user's first message through the wrong public contract.
    const isCommandEveAssistant = COMMAND_EVE_SHELL_ENABLED;

    if (isCommandEveAssistant) {
      await ipcBridge.commandEve.evaluateGateDecision.invoke({ action: 'truth_gate' }).catch((error) => {
        console.warn('[Command EVE] Failed to log truth-gate decision:', error);
      });
      const readiness = await ipcBridge.commandEve.ensureAssistant.invoke().catch((error): undefined => {
        console.warn('[Command EVE] Failed to refresh assistant readiness before send:', error);
        return undefined;
      });
      if (readiness?.success && readiness.data?.status === 'ready') {
        commandEveAssistantReadiness = readiness.data;
      }
      await configService.whenReady().catch((): undefined => undefined);

      // EVE Inference (cloud) lane: when the PERSISTED selection is an EVE tier,
      // resolve the synthetic provider in the MAIN process (which injects the
      // CEVE license bearer) and route straight to the eve-inference Edge
      // Function — no local model warmup. The local Gemma lanes fall through to
      // the existing warmup path below.
      // Default a fresh chat (no persisted selection) to the routine cloud lane;
      // local Gemma is opt-in via Settings → Modell. Same default
      // useEveInferenceSelection applies, so both paths agree.
      const inferenceSelection = resolveEffectiveInferenceSelection(configService.get('commandEve.inferenceSelection'));
      // EVE cloud is an explicit cloud lane. If it cannot be resolved, do not
      // silently fall back to local Gemma: that starts a hidden local inference /
      // warm-up job and can freeze small machines right as the user expects cloud
      // work to begin. Explicit local selections still take the local branch below.
      const useEveCloud = isEveInferenceSelection(inferenceSelection);
      if (useEveCloud) {
        const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
        const resolved = isOffline
          ? undefined
          : await ipcBridge.commandEve.resolveInferenceProvider
              .invoke({ selection: inferenceSelection as string })
              .catch((): undefined => undefined);
        const unavailableReason = resolveCommandEveCloudUnavailableReason({
          isOffline,
          hasResolvedProvider: Boolean(resolved?.success && resolved.data?.provider),
        });
        if (unavailableReason) {
          Message.error(
            unavailableReason === 'offline'
              ? t('conversation.eveInference.offlineUnavailable', 'EVE Cloud benötigt eine Internetverbindung.')
              : t('conversation.eveInference.activationUnavailable', 'EVE Cloud ist erst nach Aktivierung verfügbar.')
          );
          return false;
        }
        commandEveRuntimeModel = resolved?.data?.provider;
        commandEveRuntimeModelId = commandEveRuntimeModel?.use_model;
        // Skip local warmup: this is the cloud lane.
      }
      // Connected (BYOK) lane — BEFORE the local warmup, and that order is the
      // whole point of this branch.
      //
      // This block had exactly two branches: EVE cloud, and "everything else is
      // local". A connected selection therefore fell into the second one and
      // started a Gemma warm-up — the operator picked their own provider and got
      // the local model, with the local model's name painted next to it. That is
      // the falsehood; skipping the warmup is only half the fix, naming it is the
      // other half.
      //
      // It SENDS now. The shim's fourth lane
      // (`handleConnectedProviderCompletions`) carries the turn to the operator's
      // own provider, and main resolves the row + key per turn, so nothing has to
      // be resolved or carried here. What this branch still owes is the one thing
      // it always owed: not falling into the local warmup.
      //
      // The resolver is asked anyway, so an unusable row (deleted, disabled, key
      // removed, model gone) is refused OUT LOUD here rather than becoming an
      // opaque failure three layers down.
      const useConnected = !useEveCloud && isConnectedSelection(inferenceSelection);
      if (useConnected) {
        const resolvedConnected = await ipcBridge.commandEve.resolveInferenceProvider
          .invoke({ selection: inferenceSelection as string })
          .catch((): undefined => undefined);
        if (!resolvedConnected?.success) {
          Message.error(
            t(
              'conversation.eveInference.connectedNotRoutable',
              'Dieser Anbieter ist nicht verfügbar. Prüfe Schlüssel und Modell in den Einstellungen.'
            )
          );
          return false;
        }
        commandEveRuntimeModel = resolvedConnected.data?.provider;
        commandEveRuntimeModelId = commandEveRuntimeModel?.use_model;
        // Skip local warmup: this turn leaves the machine.
      }
      if (!useEveCloud && !useConnected) {
        const tierId = normalizeCommandEveLocalModelTierId(configService.get('commandEve.localModelTierId'));
        const expectedModel = getCommandEveAcpModelIdForTier(tierId);
        const expectedRuntimeModel = toCommandEveRuntimeModelId(expectedModel);
        const currentStatus = await ipcBridge.commandEve.runtimeStatus.invoke().catch((): undefined => undefined);
        const isRuntimeReady =
          currentStatus?.success &&
          currentStatus.data?.status === 'ready' &&
          currentStatus.data.default_model === expectedRuntimeModel;
        const isWarm = commandEveWarmupReadyForModel(currentStatus?.data?.model_warmup, expectedRuntimeModel);
        if (!isRuntimeReady || !isWarm) {
          Message.info(t('conversation.commandEveRuntimePreparing'));
          const ensureResult = await ipcBridge.commandEve.warmLocalModel.invoke({ tierId });
          const warmedStatus = ensureResult.data;
          const warmedReady =
            ensureResult.success &&
            warmedStatus?.status === 'ready' &&
            warmedStatus.default_model === expectedRuntimeModel &&
            commandEveWarmupReadyForModel(warmedStatus.model_warmup, expectedRuntimeModel);
          if (!warmedReady) {
            Message.error(
              t('conversation.commandEveRuntimeNotReady', {
                // `msg` / `model_warmup.error` / `next_action` are RAW BACKEND
                // text interpolated straight into a toast. A warm-up failure is
                // one of the likeliest places for a provider/model slug to appear,
                // and i18n interpolation does not launder it.
                reason: scrubModelIdentifiers(
                  ensureResult?.msg ||
                    warmedStatus?.model_warmup?.error ||
                    warmedStatus?.next_action ||
                    'runtime not ready',
                  CLOUD_MODEL_IDENTIFIERS
                ),
              })
            );
            return false;
          }
        }

        // Re-prove the security-owned provider row immediately before every
        // local send. Boot reconciliation is intentionally non-fatal, and an
        // operator may have opened the generic provider settings since boot;
        // neither may turn into a later opaque AionCore 401/unknown-upstream.
        const resolvedLocal = await ipcBridge.commandEve.resolveInferenceProvider
          .invoke({ localTierId: tierId })
          .catch((): undefined => undefined);
        if (!resolvedLocal?.success || !resolvedLocal.data?.provider) {
          Message.error(
            t('conversation.commandEveRuntimeNotReady', {
              reason: scrubModelIdentifiers(
                resolvedLocal?.msg || 'local provider security reconciliation failed',
                CLOUD_MODEL_IDENTIFIERS
              ),
            })
          );
          return false;
        }
        commandEveRuntimeModel = resolvedLocal.data.provider;
        commandEveRuntimeModelId = expectedModel;
      }
    }
    const effectiveCurrentModel = commandEveRuntimeModel ?? current_model;
    const effectiveAcpModelId =
      commandEveRuntimeModelId || selectedAcpModel || currentAcpCachedModelInfo?.current_model_id || undefined;

    const isCustomWorkspace = !!dir;
    const finalWorkspace = dir || '';

    const commandEveFallbackAgentInfo: AvailableAgent | undefined =
      isCommandEveAssistant && !selectedAgentInfo
        ? {
            agent_type: COMMAND_EVE_DEFAULT_ACP_BACKEND,
            backend: COMMAND_EVE_DEFAULT_ACP_BACKEND,
            name: COMMAND_EVE_DISPLAY_NAME,
            id: COMMAND_EVE_ASSISTANT_ID,
            custom_agent_id: COMMAND_EVE_ASSISTANT_ID,
            is_preset: true,
            context: '',
            presetAgentType: COMMAND_EVE_DEFAULT_ACP_BACKEND,
          }
        : undefined;
    const agentInfo = selectedAgentInfo ?? commandEveFallbackAgentInfo;
    const is_preset = isCommandEveAssistant || is_presetAgent;
    const preset_assistant_id = is_preset ? agentInfo?.custom_agent_id : undefined;

    const { agent_type: effectiveAgentType } = getEffectiveAgentType(agentInfo);

    const { rules: preset_rules, skills: preset_skills } = await resolvePresetRulesAndSkills(agentInfo);
    const preset_context = [preset_rules, preset_skills]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join('\n\n');
    // The ready catalog is the only frontend selection authority. In loading or
    // error states omit both fields so the backend applies assistant defaults;
    // never combine a fresh readiness response with an invisible stale menu.
    // Preserve explicit empty arrays so toggling every optional skill off is
    // materially different from leaving the backend default unspecified.
    const skillSelectionExtra = skillSelectionReady
      ? {
          ...(guidEnabledSkills !== undefined ? { preset_enabled_skills: guidEnabledSkills } : {}),
          ...(guidDisabledBuiltinSkills !== undefined ? { exclude_auto_inject_skills: guidDisabledBuiltinSkills } : {}),
        }
      : {};
    const enabled_skills = guidEnabledSkills;
    const excludeBuiltinSkills = guidDisabledBuiltinSkills;
    const selectedMcpServerIdSet = new Set(selectedMcpServerIds ?? []);
    const selectedUserMcpServerIds = availableMcpServers
      .filter((server) => selectedMcpServerIdSet.has(server.id) && server.builtin !== true)
      .map((server) => server.id);
    const selectedAllSessionMcpServers = availableMcpServers
      .filter((server) => selectedMcpServerIdSet.has(server.id))
      .map((server) => toSessionMcpServer(server));
    const selectedBuiltinSessionMcpServers = availableMcpServers
      .filter(
        (server) =>
          selectedMcpServerIdSet.has(server.id) && server.builtin === true && !isCommandEveManagedImageMcp(server)
      )
      .map((server) => toSessionMcpServer(server));

    const finalEffectiveAgentType = isCommandEveAssistant ? COMMAND_EVE_DEFAULT_ACP_BACKEND : effectiveAgentType;

    // OpenClaw Gateway path
    if (selectedAgent === 'openclaw-gateway') {
      const openclawAgentInfo = agentInfo || findAgentByKey(selectedAgentKey);
      const openclawConversationParams = buildAgentConversationParams({
        backend: openclawAgentInfo?.backend || 'openclaw-gateway',
        name: input,
        agent_name: openclawAgentInfo?.name,
        preset_assistant_id,
        workspace: finalWorkspace,
        model: effectiveCurrentModel!,
        cli_path: openclawAgentInfo?.cli_path,
        custom_agent_id: openclawAgentInfo?.custom_agent_id,
        custom_workspace: isCustomWorkspace,
        extra: {
          default_files: files,
          runtime_validation: {
            expected_workspace: finalWorkspace,
            expected_backend: openclawAgentInfo?.backend,
            expected_agent_name: openclawAgentInfo?.name,
            expected_cli_path: openclawAgentInfo?.cli_path,
            expected_model: effectiveCurrentModel?.use_model,
            switched_at: Date.now(),
          },
          ...skillSelectionExtra,
        },
      });

      try {
        const conversation = await ipcBridge.conversation.create.invoke(openclawConversationParams);

        if (!conversation || !conversation.id) {
          Message.error(t('conversation.createFailed', { defaultValue: 'Failed to create conversation' }));
          return false;
        }

        if (isCustomWorkspace) {
          updateWorkspaceTime(finalWorkspace);
        }

        emitter.emit('chat.history.refresh');

        const initialMessage = {
          input,
          files: files.length > 0 ? files : undefined,
        };
        sessionStorage.setItem(`openclaw_initial_message_${conversation.id}`, JSON.stringify(initialMessage));

        await navigateToConversation(navigate, conversation.id);
      } catch (error: unknown) {
        Message.error(getConversationCreateErrorMessage(error, t));
        throw error;
      }
      return true;
    }

    // Nanobot path
    if (selectedAgent === 'nanobot') {
      const nanobotAgentInfo = agentInfo || findAgentByKey(selectedAgentKey);
      const nanobotConversationParams = buildAgentConversationParams({
        backend: nanobotAgentInfo?.backend || 'nanobot',
        name: input,
        agent_name: nanobotAgentInfo?.name,
        preset_assistant_id,
        workspace: finalWorkspace,
        model: effectiveCurrentModel!,
        custom_agent_id: nanobotAgentInfo?.custom_agent_id,
        custom_workspace: isCustomWorkspace,
        extra: {
          default_files: files,
          ...skillSelectionExtra,
        },
      });

      try {
        const conversation = await ipcBridge.conversation.create.invoke(nanobotConversationParams);

        if (!conversation || !conversation.id) {
          Message.error(t('conversation.createFailed', { defaultValue: 'Failed to create conversation' }));
          return false;
        }

        if (isCustomWorkspace) {
          updateWorkspaceTime(finalWorkspace);
        }

        emitter.emit('chat.history.refresh');

        const initialMessage = {
          input,
          files: files.length > 0 ? files : undefined,
        };
        sessionStorage.setItem(`nanobot_initial_message_${conversation.id}`, JSON.stringify(initialMessage));

        await navigateToConversation(navigate, conversation.id);
      } catch (error: unknown) {
        Message.error(getConversationCreateErrorMessage(error, t));
        throw error;
      }
      return true;
    }

    // Aionrs path (direct selection or preset assistant with aionrs as main agent)
    if ((!isCommandEveAssistant && selectedAgent === 'aionrs') || (is_preset && finalEffectiveAgentType === 'aionrs')) {
      if (!effectiveCurrentModel) {
        Message.warning(t('conversation.noModelConfigured'));
        return false;
      }
      try {
        const conversation = await ipcBridge.conversation.create.invoke({
          type: 'aionrs',
          name: input,
          model: effectiveCurrentModel,
          extra: {
            default_files: files,
            workspace: finalWorkspace,
            custom_workspace: isCustomWorkspace,
            preset_rules: is_preset ? preset_context : undefined,
            selected_mcp_server_ids: selectedUserMcpServerIds,
            selected_session_mcp_servers: selectedAllSessionMcpServers,
            ...skillSelectionExtra,
            preset_assistant_id,
            session_mode: selectedMode,
          },
        });

        if (!conversation || !conversation.id) {
          Message.error(t('conversation.createFailed', { defaultValue: 'Failed to create conversation' }));
          return false;
        }

        if (isCustomWorkspace) {
          updateWorkspaceTime(finalWorkspace);
        }

        emitter.emit('chat.history.refresh');

        const initialMessage = {
          input,
          files: files.length > 0 ? files : undefined,
        };
        sessionStorage.setItem(
          `aionrs_initial_message_${configService.getCurrentSeatId()}_${conversation.id}`,
          JSON.stringify(initialMessage)
        );

        await navigateToConversation(navigate, conversation.id);
      } catch (error: unknown) {
        Message.error(getConversationCreateErrorMessage(error, t));
        throw error;
      }
      return true;
    }

    // Remaining agent path (ACP/remote/custom, including preset fallbacks)
    {
      // Agent-type fallback only applies to preset assistants whose primary agent
      // was unavailable and got switched. For non-preset
      // agents (including extension-contributed ACP adapters with backend='custom'),
      // we must keep the original selectedAgent so the correct backend/cli_path is used.
      const agent_typeChanged = is_preset && selectedAgent !== finalEffectiveAgentType;
      const acpBackend: string | undefined = agent_typeChanged
        ? finalEffectiveAgentType
        : is_preset
          ? finalEffectiveAgentType
          : selectedAgent;

      const acpAgentInfo = agent_typeChanged
        ? findAgentByKey(acpBackend as string)
        : agentInfo || findAgentByKey(selectedAgentKey);

      if (!acpAgentInfo && !is_preset) {
        console.warn(`${acpBackend} CLI not found, but proceeding to let conversation panel handle it.`);
      }
      const agentBackend = acpBackend || selectedAgent;
      const agentConversationParams = buildAgentConversationParams({
        backend: agentBackend,
        name: input,
        // For row-scoped rows (custom ACP / remote) the backend factory
        // needs the actual catalog id — `backend` collapses to the `custom`
        // slot so it cannot discriminate between rows on its own.
        agent_id:
          isCommandEveAssistant && commandEveAssistantReadiness?.agent_id
            ? commandEveAssistantReadiness.agent_id
            : acpAgentInfo?.id,
        agent_name:
          isCommandEveAssistant && commandEveAssistantReadiness?.agent_name
            ? commandEveAssistantReadiness.agent_name
            : acpAgentInfo?.name,
        preset_assistant_id,
        workspace: finalWorkspace,
        model: effectiveCurrentModel!,
        cli_path: acpAgentInfo?.cli_path,
        ...(isCommandEveAssistant && commandEveAssistantReadiness?.cli_path
          ? { cli_path: commandEveAssistantReadiness.cli_path }
          : {}),
        custom_agent_id: acpAgentInfo?.custom_agent_id,
        custom_workspace: isCustomWorkspace,
        is_preset,
        preset_agent_type: finalEffectiveAgentType,
        preset_resources: is_preset
          ? {
              rules: preset_context,
              enabled_skills,
              exclude_auto_inject_skills: excludeBuiltinSkills,
            }
          : undefined,
        session_mode: selectedMode,
        current_model_id: effectiveAcpModelId,
        extra: {
          default_files: files,
          ...skillSelectionExtra,
          selected_mcp_server_ids: selectedUserMcpServerIds,
          selected_session_mcp_servers: selectedBuiltinSessionMcpServers,
        },
      });

      try {
        const conversation = await ipcBridge.conversation.create.invoke(agentConversationParams);
        if (!conversation || !conversation.id) {
          console.error('Failed to create ACP conversation - conversation object is null or missing id');
          Message.error(t('conversation.createFailed', { defaultValue: 'Failed to create conversation' }));
          return false;
        }

        if (isCustomWorkspace) {
          updateWorkspaceTime(finalWorkspace);
        }

        emitter.emit('chat.history.refresh');

        // MAT-1773 (P3): a video selection made on the start-chat surface rides
        // the initial message, so the new conversation's first send carries the
        // exact model/resolution/duration the user picked there.
        const carriedVideoSelection =
          COMMAND_EVE_SHELL_ENABLED && isVideoLaneRequest({ message: input, resolvedAgentId: null })
            ? (getVideoSelection?.() ?? null)
            : null;
        const initialMessage = {
          input,
          files: files.length > 0 ? files : undefined,
          ...(carriedVideoSelection ? { videoSelection: carriedVideoSelection } : {}),
        };
        sessionStorage.setItem(
          `acp_initial_message_${configService.getCurrentSeatId()}_${conversation.id}`,
          JSON.stringify(initialMessage)
        );

        await navigateToConversation(navigate, conversation.id);
      } catch (error: unknown) {
        console.error('Failed to create ACP conversation:', error);
        Message.error(getConversationCreateErrorMessage(error, t));
        throw error;
      }
      return true;
    }
  }, [
    input,
    files,
    dir,
    selectedAgent,
    selectedAgentKey,
    selectedAgentInfo,
    is_presetAgent,
    selectedMode,
    selectedAcpModel,
    currentAcpCachedModelInfo,
    current_model,
    findAgentByKey,
    getEffectiveAgentType,
    resolvePresetRulesAndSkills,
    availableMcpServers,
    selectedMcpServerIds,
    skillSelectionReady,
    guidDisabledBuiltinSkills,
    guidEnabledSkills,
    navigate,
    t,
    eveSendHeld,
    getVideoSelection,
  ]);

  const sendMessageHandler = useCallback(() => {
    // THE SUBMISSION HOLD, AT THE FUNNEL. Both the send button and the Enter key
    // land here, and only here — the button reads `isButtonDisabled` below, while
    // GuidPage's key handler calls this directly, so a guard on the button alone
    // would let the keyboard walk straight past it. Main refuses a held turn
    // anyway; this is the surface refusing to pretend it did not know.
    if (eveSendHeld) return;
    if (loading || sendingRef.current) return;
    sendingRef.current = true;
    setLoading(true);
    handleSend()
      .then((sent) => {
        if (!sent) return;
        setInput('');
        setMentionOpen(false);
        setMentionQuery(null);
        setMentionSelectorOpen(false);
        setMentionActiveIndex(0);
        setFiles([]);
        setDir('');
      })
      .catch((error) => {
        console.error('Failed to send message:', error);
      })
      .finally(() => {
        sendingRef.current = false;
        setLoading(false);
      });
  }, [
    eveSendHeld,
    loading,
    handleSend,
    setLoading,
    setInput,
    setMentionOpen,
    setMentionQuery,
    setMentionSelectorOpen,
    setMentionActiveIndex,
    setFiles,
    setDir,
  ]);

  // Calculate button disabled state
  const isButtonDisabled = loading || !input.trim() || eveSendHeld;

  return {
    handleSend,
    sendMessageHandler,
    isButtonDisabled,
    eveSendHeld,
  };
};
