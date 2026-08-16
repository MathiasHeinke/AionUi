/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IConversationMcpStatus, IConversationMcpStatusKind } from '@/common/config/storage';
import { userVisibleConversationMcpStatuses } from '@/common/config/eveManagedMcpCore';
import { Button, Menu, Message, Trigger } from '@arco-design/web-react';
import { FolderOpen, Lightning, Paperclip, Plus, Right, Shield } from '@renderer/components/icons';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { useSkillCapabilityCatalog } from '@/renderer/hooks/capabilities';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { FileService } from '@/renderer/services/FileService';
import type { FileMetadata } from '@/renderer/services/FileService';
import { emitter } from '@/renderer/utils/emitter';
import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { COMMAND_EVE_SHELL_ENABLED } from '@/common/config/commandEveShell';
import {
  SKILL_CAPABILITY_MENU_POPUP_STYLE,
  SkillCapabilityCountLabel,
  SkillCapabilityMenuItems,
} from './SkillCapabilityMenu';

interface FileAttachButtonProps {
  openFileSelector: () => void;
  onLocalFilesAdded?: (files: FileMetadata[]) => void;
  loadedSkills?: string[];
  loadedMcpStatuses?: IConversationMcpStatus[];
  /** Command EVE uses the universal add affordance beside its tools launcher. */
  icon?: 'paperclip' | 'plus';
}

const MenuItem: React.FC<{
  icon: React.ReactNode;
  label: React.ReactNode;
  description?: React.ReactNode;
  suffix?: React.ReactNode;
  onClick?: () => void;
  className?: string;
  title?: string;
}> = ({ icon, label, description, suffix, onClick, className = '', title }) => {
  const content = (
    <>
      <span className='eve-menu-icon'>{icon}</span>
      <span className='min-w-0 flex-1'>
        <span className='block leading-none'>{label}</span>
        {description ? (
          <span className='mt-4px block text-12px leading-16px text-t-secondary'>{description}</span>
        ) : null}
      </span>
      {suffix}
    </>
  );

  return onClick ? (
    <button
      type='button'
      role='menuitem'
      className={`eve-menu-item w-full flex items-center gap-10px px-10px py-8px border-none bg-transparent text-left cursor-pointer text-14px select-none ${className}`}
      style={{ transitionDuration: 'var(--eve-motion-duration-state)' }}
      onClick={onClick}
      title={title}
    >
      {content}
    </button>
  ) : (
    <div
      role='menuitem'
      aria-disabled='true'
      className={`eve-menu-item flex items-center gap-10px px-10px py-8px text-14px ${className}`}
      style={{ transitionDuration: 'var(--eve-motion-duration-state)' }}
      title={title}
    >
      {content}
    </div>
  );
};

const MCP_STATUS_CLASS_NAME: Record<IConversationMcpStatusKind, string> = {
  loaded: 'text-[var(--color-success-6)]',
  failed: 'text-[var(--color-danger-6)]',
  unsupported: 'text-[var(--color-warning-6)]',
};

const FileAttachButton: React.FC<FileAttachButtonProps> = ({
  openFileSelector,
  onLocalFilesAdded,
  loadedSkills,
  loadedMcpStatuses,
  icon = 'paperclip',
}) => {
  const conversationContext = useConversationContextSafe();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [open, setOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);

  const skillNames = loadedSkills ?? conversationContext?.loadedSkills ?? [];
  const skillCatalog = useSkillCapabilityCatalog({ mode: 'runtime', activeSkills: skillNames });
  const mcpStatuses = userVisibleConversationMcpStatuses(
    loadedMcpStatuses ?? conversationContext?.loadedMcpStatuses,
    conversationContext?.loadedMcpServers
  );
  const handleSkillClick = useCallback((name: string) => {
    setOpen(false);
    emitter.emit('sendbox.fill', `/${name} `);
  }, []);

  const handleOpenMcpSettings = useCallback(() => {
    setOpen(false);
    setSkillsOpen(false);
    setMcpOpen(false);
    void navigate(COMMAND_EVE_SHELL_ENABLED ? '/connectors' : '/settings/capabilities?tab=tools');
  }, [navigate]);

  const handleLocalFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList || fileList.length === 0 || !onLocalFilesAdded) return;
      setUploading(true);
      try {
        const processed = await FileService.processDroppedFiles(fileList, conversationContext?.conversation_id);
        if (processed.length > 0) onLocalFilesAdded(processed);
      } catch {
        Message.error(t('common.fileAttach.failed'));
      } finally {
        setUploading(false);
      }
      e.target.value = '';
    },
    [conversationContext?.conversation_id, onLocalFilesAdded, t]
  );

  const isDesktop = isElectronDesktop();
  const hasSkills = skillCatalog.activeCount > 0;
  const hasMcpServers = mcpStatuses.length > 0;
  const attachIcon =
    icon === 'plus' ? (
      <Plus theme='outline' size='19' strokeWidth={2.2} fill='currentColor' />
    ) : (
      <Paperclip theme='outline' size='17' strokeWidth={2} fill='currentColor' />
    );

  // A paperclip has one stable promise: choose files. Skills and connector
  // status live in EVE's dedicated control menu, so loaded capabilities must
  // never silently change this button into a different interaction.
  if (isDesktop) {
    return (
      <Button
        type='secondary'
        shape='circle'
        className='eve-composer-icon-button eve-composer-attach-button'
        icon={attachIcon}
        onClick={openFileSelector}
        data-testid='aionrs-attach-folder-btn'
        aria-label={t('common.fileAttach.addFiles')}
      />
    );
  }

  const menuSizingStyle: React.CSSProperties = {
    minWidth: 220,
    maxHeight: 'min(430px, calc(100dvh - 88px))',
    zIndex: 1050,
  };

  const skillsPanel = (
    <Menu
      className='eve-menu-surface'
      data-eve-interaction-role='event-boundary'
      style={{
        ...menuSizingStyle,
        ...SKILL_CAPABILITY_MENU_POPUP_STYLE,
        minWidth: 220,
        width: 'min(320px, calc(100vw - 96px))',
        maxWidth: 320,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <SkillCapabilityMenuItems catalog={skillCatalog} onInvokeSkill={(skill) => handleSkillClick(skill.name)} />
    </Menu>
  );

  const mcpPanel = (
    <div
      role='menu'
      className='eve-menu-surface'
      data-eve-interaction-role='event-boundary'
      style={{
        ...menuSizingStyle,
        minWidth: 220,
        width: 'min(320px, calc(100vw - 96px))',
        maxWidth: 320,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {mcpStatuses.map((item) => (
        <MenuItem
          key={`${item.id}-${item.status}`}
          icon={<Shield theme='outline' size={16} />}
          label={item.name}
          suffix={
            item.status === 'loaded' ? undefined : (
              <span className={`text-12px leading-none ${MCP_STATUS_CLASS_NAME[item.status]}`}>
                {t(`conversation.mcp.status.${item.status}` as const)}
              </span>
            )
          }
          className='cursor-default'
          title={item.reason}
        />
      ))}
      <div className='eve-menu-divider' />
      <div className='px-10px py-8px'>
        <div className='text-12px leading-16px text-t-secondary whitespace-normal break-words'>
          {t('conversation.mcp.managementHint', {
            defaultValue:
              'Connector health is checked in the Connector Catalog. Run read-only preflights there; raw MCP setup stays gated.',
          })}
        </div>
        <Button
          type='text'
          size='mini'
          className='mt-6px h-auto! px-0! text-12px! inline-flex! items-center! gap-4px!'
          onClick={handleOpenMcpSettings}
        >
          <span className='leading-none'>
            {t('conversation.mcp.openSettings', {
              defaultValue: 'Open Connector Catalog',
            })}
          </span>
          <span className='inline-flex h-12px w-12px flex-shrink-0 items-center justify-center'>
            <Right theme='outline' size={12} className='block' />
          </span>
        </Button>
      </div>
    </div>
  );

  const menu = (
    <div
      role='menu'
      className='eve-menu-surface'
      data-eve-interaction-role='event-boundary'
      style={menuSizingStyle}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Loaded items stay above file actions so the session snapshot is visible */}
      {(hasMcpServers || hasSkills) && (
        <>
          {hasMcpServers && (
            <div className='px-6px'>
              <Trigger
                popup={() => mcpPanel}
                trigger='hover'
                position='right'
                popupVisible={mcpOpen}
                onVisibleChange={setMcpOpen}
                mouseEnterDelay={400}
                mouseLeaveDelay={420}
              >
                <div>
                  <MenuItem
                    icon={<Shield theme='outline' size={16} />}
                    label={`${t('conversation.mcp.loaded', { defaultValue: 'Loaded MCP' })} · ${mcpStatuses.length}`}
                    suffix={<Right theme='outline' size={13} className='text-t-tertiary' />}
                  />
                </div>
              </Trigger>
            </div>
          )}
          {hasSkills && (
            <div className='px-6px'>
              <Trigger
                popup={() => skillsPanel}
                trigger='hover'
                position='right'
                popupVisible={skillsOpen}
                onVisibleChange={setSkillsOpen}
                mouseEnterDelay={400}
                mouseLeaveDelay={420}
              >
                <div>
                  <MenuItem
                    icon={<Lightning theme='outline' size={16} />}
                    label={<SkillCapabilityCountLabel catalog={skillCatalog} />}
                    suffix={<Right theme='outline' size={13} className='text-t-tertiary' />}
                  />
                </div>
              </Trigger>
            </div>
          )}
          <div className='eve-menu-divider' />
        </>
      )}

      {/* 文件操作最常用，在最下（离 + 最近） */}
      <div className='px-6px'>
        {!isDesktop && (
          <MenuItem
            icon={<FolderOpen theme='outline' size={16} />}
            label={t('common.fileAttach.myDevice', { defaultValue: 'Upload from device' })}
            onClick={() => {
              fileInputRef.current?.click();
              setOpen(false);
            }}
          />
        )}
        <MenuItem
          icon={<Paperclip theme='outline' size={16} />}
          label={t('common.fileAttach.addFiles', { defaultValue: 'Add files' })}
          onClick={() => {
            openFileSelector();
            setOpen(false);
          }}
        />
      </div>
    </div>
  );

  return (
    <>
      <Trigger
        popup={() => menu}
        trigger='click'
        position='tl'
        popupVisible={open}
        onVisibleChange={setOpen}
        clickToClose
        popupAlign={{ bottom: 8 }}
      >
        <Button
          type='secondary'
          shape='circle'
          className='eve-composer-icon-button eve-composer-attach-button'
          icon={attachIcon}
          loading={uploading}
          disabled={uploading}
          data-testid='aionrs-attach-folder-btn'
          aria-label={t('common.fileAttach.addFiles')}
        />
      </Trigger>
      <input
        ref={fileInputRef}
        type='file'
        multiple
        style={{ display: 'none' }}
        onChange={handleLocalFileChange}
        data-testid='aionrs-file-upload-input'
      />
    </>
  );
};

export default FileAttachButton;
