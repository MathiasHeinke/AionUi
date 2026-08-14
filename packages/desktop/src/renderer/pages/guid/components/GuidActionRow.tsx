/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IMcpServer } from '@/common/config/storage';
import AgentModeSelector from '@/renderer/components/agent/AgentModeSelector';
import EveMaxToggle from '@/renderer/components/agent/EveMaxToggle';
import ComposerContextDeck from '@/renderer/components/chat/ComposerContextDeck';
import UnifiedSendBar from '@/renderer/components/chat/UnifiedSendBar';
import WorkProductModeSelector from '@/renderer/components/chat/WorkProductModeSelector';
import type { ComposerWorkProductMode } from '@/common/config/composerWorkProductModeCore';
import {
  SKILL_CAPABILITY_MENU_POPUP_STYLE,
  SkillCapabilityCountLabel,
  SkillCapabilityMenuItems,
} from '@/renderer/components/media/SkillCapabilityMenu';
import { WorkspaceContextControl } from '@/renderer/components/workspace';
import type { SkillCapabilityCatalog } from '@/renderer/hooks/capabilities';
import { createModeLabelFormatter, supportsModeSwitch } from '@/renderer/utils/model/agentModes';
import {
  COMMAND_EVE_DEFAULT_ACP_BACKEND,
  COMMAND_EVE_SHELL_ENABLED,
  isCommandEveAcpConversation,
} from '@/common/config/commandEveShell';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { getCleanFileNames, FileService } from '@/renderer/services/FileService';
import { iconColors } from '@/renderer/styles/colors';
import { isElectronDesktop } from '@/renderer/utils/platform';
import type { AvailableAgent } from '../types';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import PresetAgentTag, { type AgentSwitcherItem } from './PresetAgentTag';
import { Button, Checkbox, Menu, Message, Tooltip } from '@arco-design/web-react';
import { ArrowUp, Lightning, Plus, Shield } from '@icon-park/react';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../index.module.css';

type GuidActionRowProps = {
  // File handling
  files: string[];
  onFilesUploaded: (paths: string[]) => void;
  workspaceDir: string;
  onSelectWorkspace: (dir: string) => void;
  onClearWorkspace: () => void;

  // Model selector node (rendered by parent)
  modelSelectorNode: React.ReactNode;

  // Agent mode
  selectedAgent: string | 'custom';
  effectiveModeAgent?: string;
  selectedMode: string;
  onModeSelect: (mode: string) => void;

  // Preset agent tag
  is_presetAgent: boolean;
  selectedAgentInfo: AvailableAgent | undefined;
  /**
   * Backend-merged preset catalog — drives the preset tag label lookup. Not
   * the ACP engine-config list (custom agents from the AgentRegistry).
   */
  assistants: Assistant[];
  localeKey: string;
  onClosePresetTag: () => void;
  agentLogo?: string | null;
  agentSwitcherItems?: AgentSwitcherItem[];
  onAgentSwitch?: (key: string) => void;
  hideModeSwitch?: boolean;
  hidePresetTag?: boolean;

  // Skills management
  skillCatalog: SkillCapabilityCatalog;
  onToggleSkill: (name: string, isAuto: boolean) => void;
  mcpServers: IMcpServer[];
  selectedMcpServerIds: string[];
  onToggleMcpServer: (serverId: string) => void;

  // Explicit work-product mode. Text in the draft never changes this value.
  workProductMode?: ComposerWorkProductMode;
  onWorkProductModeChange?: (mode: ComposerWorkProductMode) => void;

  // Send button
  loading: boolean;
  isButtonDisabled: boolean;
  speechInputNode?: React.ReactNode;
  /**
   * Context + credits indicator (STEP 4). Mounted into the shared bar so the
   * consumed-context/credits surface is the same on the start screen and in-chat.
   * Pre-conversation it stays quiet (no token usage yet) but the credits half is
   * live, matching the in-chat indicator.
   */
  contextIndicatorNode?: React.ReactNode;
  onSend: () => void;
};

const GuidActionRow: React.FC<GuidActionRowProps> = ({
  files,
  onFilesUploaded,
  workspaceDir,
  onSelectWorkspace,
  onClearWorkspace,
  modelSelectorNode,
  selectedAgent,
  effectiveModeAgent,
  selectedMode,
  onModeSelect,
  is_presetAgent,
  selectedAgentInfo,
  assistants,
  localeKey,
  onClosePresetTag,
  agentLogo,
  agentSwitcherItems,
  onAgentSwitch,
  hideModeSwitch = false,
  skillCatalog,
  onToggleSkill,
  mcpServers,
  selectedMcpServerIds,
  onToggleMcpServer,
  workProductMode = 'chat',
  onWorkProductModeChange,
  hidePresetTag = false,
  loading,
  isButtonDisabled,
  speechInputNode,
  contextIndicatorNode,
  onSend,
}) => {
  const { t } = useTranslation();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  // In the Command-EVE shell every conversation runs on the hermes ACP backend, so the
  // START-screen mode selector must use hermes' modes + EVE labels (Fragen / Auto-Edits /
  // Nicht fragen) — IDENTICAL to in-session. Otherwise modeBackend fell back to the agent's
  // apparent backend (aionrs → Standard / Auto-Bearbeitung / YOLO), which both mislabeled it
  // AND made the start screen save a 'yolo' value hermes doesn't understand.
  const modeBackend = COMMAND_EVE_SHELL_ENABLED ? COMMAND_EVE_DEFAULT_ACP_BACKEND : effectiveModeAgent || selectedAgent;
  const showModeSwitch = !hideModeSwitch && supportsModeSwitch(modeBackend);

  // Browser file picker ref (WebUI only)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleLocalFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList || fileList.length === 0) return;
      setUploading(true);
      try {
        const processed = await FileService.processDroppedFiles(fileList);
        if (processed.length > 0) {
          onFilesUploaded(processed.map((f) => f.path));
        }
      } catch {
        Message.error(t('common.fileAttach.failed'));
      } finally {
        setUploading(false);
      }
      // Reset so the same file can be re-selected
      e.target.value = '';
    },
    [onFilesUploaded, t]
  );

  // EVE-aware permission-mode label formatter. For the Hermes/EVE backend it
  // maps the three honest modes to the clean EVE labels (Standard / Änderungen
  // übernehmen / YOLO); other backends keep their generic agentMode.<value>
  // labels. modeBackend resolves to the agent actually driving the picker.
  const getModeDisplayLabel = useMemo(() => createModeLabelFormatter(modeBackend, t), [modeBackend, t]);

  const isWebUI = !isElectronDesktop();

  const activeMcpCount = selectedMcpServerIds.length;

  const capabilityMenu = (
    <>
      {skillCatalog.totalCount > 0 && (
        <Menu.SubMenu
          key='skills'
          title={
            <div className='flex items-center gap-8px'>
              <Lightning theme='filled' size='16' fill={iconColors.primary} style={{ lineHeight: 0 }} />
              <SkillCapabilityCountLabel catalog={skillCatalog} />
            </div>
          }
          triggerProps={{
            popupStyle: SKILL_CAPABILITY_MENU_POPUP_STYLE,
          }}
        >
          <SkillCapabilityMenuItems
            catalog={skillCatalog}
            onToggleSkill={(skill) => onToggleSkill(skill.name, skill.isAutoInject)}
          />
        </Menu.SubMenu>
      )}
      {mcpServers.length > 0 && (
        <Menu.SubMenu
          key='mcp'
          title={
            <div className='flex items-center gap-8px'>
              <Shield theme='outline' size='16' fill={iconColors.primary} style={{ lineHeight: 0 }} />
              <span>
                {t('mcp.label')} ({activeMcpCount}/{mcpServers.length})
              </span>
            </div>
          }
          triggerProps={{
            popupStyle: {
              maxHeight: 360,
              overflowY: 'auto',
              overflowX: 'hidden',
            },
          }}
        >
          {mcpServers.map((server) => (
            <Menu.Item
              key={`mcp-${server.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleMcpServer(server.id);
              }}
            >
              <Checkbox
                checked={selectedMcpServerIds.includes(server.id)}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                onChange={() => onToggleMcpServer(server.id)}
              >
                <span className='text-13px'>
                  {server.name}
                  {server.tools?.length ? ` (${server.tools.length} ${t('mcp.tools')})` : ''}
                </span>
              </Checkbox>
            </Menu.Item>
          ))}
        </Menu.SubMenu>
      )}
      {skillCatalog.totalCount === 0 && mcpServers.length === 0 ? (
        <Menu.Item key='capabilities-empty' disabled>
          {t('conversation.workProduct.capabilitiesEmpty')}
        </Menu.Item>
      ) : null}
    </>
  );

  const openFilePicker = useCallback(() => {
    if (isWebUI) {
      fileInputRef.current?.click();
      return;
    }
    Promise.resolve(ipcBridge.dialog.showOpen.invoke({ properties: ['openFile', 'multiSelections'] }))
      .then((uploadedFiles) => {
        if (uploadedFiles?.length) onFilesUploaded(uploadedFiles);
      })
      .catch((error) => console.error('Failed to open file dialog:', error));
  }, [isWebUI, onFilesUploaded]);

  const workProductModes = [
    {
      mode: 'image' as const,
      label: t('conversation.workProduct.image.label'),
      tooltip: t('conversation.workProduct.image.tooltip'),
    },
    {
      mode: 'video' as const,
      label: t('conversation.workProduct.video.label'),
      tooltip: t('conversation.workProduct.video.tooltip'),
    },
    {
      mode: 'presentation' as const,
      label: t('conversation.workProduct.presentation.label'),
      tooltip: t('conversation.workProduct.presentation.tooltip'),
    },
    {
      mode: 'pdf' as const,
      label: t('conversation.workProduct.pdf.label'),
      tooltip: t('conversation.workProduct.pdf.tooltip'),
    },
  ];
  const workProductActions = {
    toolbarLabel: t('conversation.workProduct.toolbarLabel'),
    returnToChatLabel: t('conversation.workProduct.returnToChat'),
    selectedReferenceLabel: t('conversation.workProduct.selectedReference'),
    removeReferenceLabel: t('conversation.workProduct.removeReference'),
  };

  // The plus does exactly one thing: attach. The adjacent tools button owns
  // work products and capability discovery, so neither promise changes later.
  const fileAttachSlot = (
    <div className={styles.actionEntry}>
      <span className='flex items-center gap-4px lh-[1]'>
        <Button
          type='secondary'
          shape='circle'
          className='eve-composer-icon-button eve-composer-attach-button'
          icon={<Plus theme='outline' size='19' strokeWidth={2.2} fill='currentColor' />}
          loading={uploading}
          disabled={uploading}
          data-testid='file-upload-btn'
          aria-label={t('common.fileAttach.addFiles')}
          onClick={openFilePicker}
        />
        {files.length > 0 && (
          <Tooltip
            className={'!max-w-max'}
            content={<span className='whitespace-break-spaces'>{getCleanFileNames(files).join('\n')}</span>}
          >
            <span className='text-t-primary'>File({files.length})</span>
          </Tooltip>
        )}
      </span>
      {isWebUI && (
        <input ref={fileInputRef} type='file' multiple style={{ display: 'none' }} onChange={handleLocalFileChange} />
      )}
    </div>
  );

  const workProductSlot = COMMAND_EVE_SHELL_ENABLED ? (
    <WorkProductModeSelector
      value={workProductMode}
      onChange={onWorkProductModeChange ?? (() => undefined)}
      modes={workProductModes}
      actions={workProductActions}
      disabled={loading || !onWorkProductModeChange}
      capabilityLabel={t('conversation.workProduct.capabilities')}
      capabilityCount={skillCatalog.totalCount + mcpServers.length}
      capabilityMenu={capabilityMenu}
    />
  ) : null;

  // Model picker + permission mode form one visual config group (same CSS as
  // before: `.actionConfigGroup :global(.sendbox-model-btn …)` styles the pill).
  // The permission selector is the EVE 3-mode selector and stays a LOCAL callback
  // (onModeSelect) — pre-conversation, so the choice seeds the first message's
  // session_mode rather than calling ipcBridge.acpConversation.setMode.
  const modelSlot = modelSelectorNode ? (
    <div className={styles.actionConfigGroup} data-mobile={isMobile ? 'true' : undefined}>
      {modelSelectorNode}
    </div>
  ) : null;

  const permissionSlot = showModeSwitch ? (
    <div className={styles.actionConfigGroup} data-mobile={isMobile ? 'true' : undefined}>
      <AgentModeSelector
        backend={modeBackend}
        compact
        initialMode={selectedMode}
        onModeSelect={onModeSelect}
        compactLeadingIcon={<Shield theme='outline' size='14' fill={iconColors.secondary} />}
        modeLabelFormatter={getModeDisplayLabel}
        compactLabelPrefix={isCommandEveAcpConversation(modeBackend) ? t('agentMode.permission') : undefined}
        hideCompactLabelPrefixOnMobile
      />
    </div>
  ) : null;

  // The preset-agent tag rides between the config group and the right controls,
  // exactly where it sat in the old actionSubmit row.
  const presetTagSlot =
    !hidePresetTag && is_presetAgent && selectedAgentInfo ? (
      <div className={styles.actionPresetAgent}>
        <PresetAgentTag
          agentInfo={selectedAgentInfo}
          assistants={assistants}
          localeKey={localeKey}
          onClose={onClosePresetTag}
          agentLogo={agentLogo}
          agentSwitcherItems={agentSwitcherItems}
          onAgentSwitch={onAgentSwitch}
        />
      </div>
    ) : null;

  const sendButton = (
    <Button
      shape='circle'
      type='primary'
      loading={loading}
      disabled={isButtonDisabled}
      className='send-button-custom'
      icon={<ArrowUp theme='filled' size='14' fill='white' strokeWidth={5} />}
      onClick={onSend}
      data-testid='guid-send-btn'
      aria-label={t('common.send')}
    />
  );

  // ONE Claude-Code-style control row (STEP 4), shared with the in-chat send box.
  // The textarea, file previews and mention dropdown stay in GuidInputCard above
  // this row; the bar only arranges the controls.
  return (
    <div className={styles.actionRow}>
      {COMMAND_EVE_SHELL_ENABLED ? (
        <>
          <UnifiedSendBar
            leftSlot={
              <>
                {fileAttachSlot}
                {workProductSlot}
              </>
            }
            centerSlot={presetTagSlot}
            micSlot={speechInputNode}
            sendSlot={sendButton}
          />
          {/* Keep the Hermes session-mode compatibility controller mounted
              while the six-rung authority becomes the visible control. */}
          {permissionSlot ? <div className={styles.compatibilityController}>{permissionSlot}</div> : null}
          <ComposerContextDeck
            projectSlot={
              <WorkspaceContextControl
                workspacePath={workspaceDir}
                compactLabel
                editable
                disabled={loading}
                onSelectWorkspace={onSelectWorkspace}
                onClearWorkspace={onClearWorkspace}
              />
            }
            maxSlot={<EveMaxToggle disabled={loading} />}
            tokenUsage={null}
            disabled={loading}
          />
        </>
      ) : (
        <UnifiedSendBar
          leftSlot={
            <>
              {fileAttachSlot}
              <WorkspaceContextControl
                workspacePath={workspaceDir}
                editable
                disabled={loading}
                onSelectWorkspace={onSelectWorkspace}
                onClearWorkspace={onClearWorkspace}
              />
            </>
          }
          centerSlot={presetTagSlot}
          modelSlot={modelSlot}
          permissionSlot={permissionSlot}
          contextSlot={contextIndicatorNode}
          micSlot={speechInputNode}
          sendSlot={sendButton}
        />
      )}
    </div>
  );
};

export default GuidActionRow;
