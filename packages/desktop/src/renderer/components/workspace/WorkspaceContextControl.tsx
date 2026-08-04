/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import {
  dispatchElementsRailSelectEvent,
  dispatchWorkspaceOpenEvent,
} from '@/renderer/utils/workspace/workspaceEvents';
import { Button, Dropdown, Menu, Tooltip } from '@arco-design/web-react';
import { Check, Down, FolderBlock, FolderOpen, FolderPlus } from '@icon-park/react';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addRecentWorkspace, getRecentWorkspaces } from './recentWorkspaces';
import styles from './WorkspaceContextControl.module.css';

export type WorkspaceContextControlProps = {
  workspacePath?: string;
  /**
   * 1.820.4 (MAT-1772) — durable project title from a completed project
   * workspace artifact (path-free by main-side contract). Display priority:
   * the project name ALWAYS wins over the basename of a temporary
   * (`hermes-temp-*`) workspace — and over any basename, since a bound
   * project is the truthful context label. Never a path.
   */
  projectName?: string;
  editable?: boolean;
  disabled?: boolean;
  onSelectWorkspace?: (path: string) => void;
  onClearWorkspace?: () => void;
};

const workspaceNameFromPath = (path?: string): string => {
  if (!path) return '';
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || path
  );
};

/**
 * Compact project context used by both the start composer and active chats.
 * Before a chat it is an editable recent-project picker. Inside a chat it is a
 * truthful state button that opens the rail's Context tab without mutating the
 * conversation workspace underneath a running agent.
 */
const WorkspaceContextControl: React.FC<WorkspaceContextControlProps> = ({
  workspacePath,
  projectName,
  editable = false,
  disabled = false,
  onSelectWorkspace,
  onClearWorkspace,
}) => {
  const { t } = useTranslation();
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() => getRecentWorkspaces());
  const durableProjectName = projectName?.trim() ? projectName.trim() : '';
  const workspaceName = durableProjectName || workspaceNameFromPath(workspacePath);
  const displayLabel = workspaceName || t('guid.workspace.workInProject');

  const inspectContext = useCallback(() => {
    dispatchElementsRailSelectEvent('context');
    dispatchWorkspaceOpenEvent();
  }, []);

  const chooseWorkspace = useCallback(async () => {
    const dirs = await ipcBridge.dialog.showOpen.invoke({ properties: ['openDirectory', 'createDirectory'] });
    const selected = dirs?.[0];
    if (!selected) return;
    addRecentWorkspace(selected);
    setRecentWorkspaces(getRecentWorkspaces());
    onSelectWorkspace?.(selected);
  }, [onSelectWorkspace]);

  const menu = useMemo(
    () => (
      <Menu
        className={styles.menu}
        onClickMenuItem={(key) => {
          if (key === 'browse') {
            void chooseWorkspace();
            return;
          }
          if (key === 'clear') {
            onClearWorkspace?.();
            return;
          }
          if (!key.startsWith('recent:')) return;
          const index = Number(key.slice('recent:'.length));
          const path = recentWorkspaces[index];
          if (!path) return;
          addRecentWorkspace(path);
          onSelectWorkspace?.(path);
        }}
      >
        {recentWorkspaces.map((path, index) => {
          const active = path === workspacePath;
          return (
            <Menu.Item key={`recent:${index}`}>
              <span className={styles.menuItem}>
                <FolderOpen size={15} aria-hidden='true' />
                <span className={styles.menuItemLabel}>{workspaceNameFromPath(path)}</span>
                {active ? <Check size={14} className={styles.menuItemCheck} aria-hidden='true' /> : null}
              </span>
            </Menu.Item>
          );
        })}
        {recentWorkspaces.length > 0 ? <div className={styles.menuDivider} role='separator' /> : null}
        <Menu.Item key='browse'>
          <span className={styles.menuItem}>
            <FolderPlus size={15} aria-hidden='true' />
            <span className={styles.menuItemLabel}>{t('team.create.chooseDifferentFolder')}</span>
          </span>
        </Menu.Item>
        <Menu.Item key='clear' disabled={!workspacePath}>
          <span className={styles.menuItem}>
            <FolderBlock size={15} aria-hidden='true' />
            <span className={styles.menuItemLabel}>{t('guid.workspace.noProject')}</span>
          </span>
        </Menu.Item>
      </Menu>
    ),
    [chooseWorkspace, onClearWorkspace, onSelectWorkspace, recentWorkspaces, t, workspacePath]
  );

  const control = (
    <Button
      type='text'
      shape='round'
      className={styles.control}
      disabled={disabled}
      onClick={editable ? undefined : inspectContext}
      data-testid='workspace-context-control'
      aria-label={displayLabel}
    >
      <span className={styles.controlContent}>
        <FolderOpen size={16} aria-hidden='true' />
        <span className={styles.controlLabel}>{displayLabel}</span>
        {editable ? <Down size={12} aria-hidden='true' /> : null}
      </span>
    </Button>
  );

  return (
    // When a durable project name wins, the tooltip shows THAT name — never
    // the internal temporary workspace path underneath it.
    <Tooltip
      content={durableProjectName ? displayLabel : workspacePath || displayLabel}
      position='top'
      disabled={!workspacePath && !durableProjectName}
    >
      {editable ? (
        <Dropdown
          trigger='click'
          position='bl'
          droplist={menu}
          disabled={disabled}
          onVisibleChange={(visible) => {
            if (visible) setRecentWorkspaces(getRecentWorkspaces());
          }}
        >
          {control}
        </Dropdown>
      ) : (
        control
      )}
    </Tooltip>
  );
};

export default WorkspaceContextControl;
