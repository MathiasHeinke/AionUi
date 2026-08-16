/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ComposerWorkProductMode,
  ComposerWorkProductModeOption,
  ComposerWorkProductReferenceKind,
  LocalizedComposerWorkProductActionDescriptor,
  LocalizedComposerWorkProductModeDescriptor,
} from '@/common/config/composerWorkProductModeCore';
import { Button, Dropdown, Menu, Tooltip } from '@arco-design/web-react';
import {
  AllApplication,
  CloseSmall,
  FileExcel,
  FilePdf,
  FileWord,
  Magic,
  Picture,
  Projector,
  Right,
  Video,
} from '@renderer/components/icons';
import React, { useMemo } from 'react';
import { COMPOSER_MENU_TRIGGER_PROPS } from '@/renderer/utils/ui/composerMenuMotion';
import styles from './WorkProductModeSelector.module.css';

export type WorkProductReferenceChip = Readonly<{
  title: string;
  kind: ComposerWorkProductReferenceKind;
  kindLabel: string;
  preview?: React.ReactNode;
}>;

type WorkProductModeSelectorBaseProps = Readonly<{
  value: ComposerWorkProductMode;
  onChange: (mode: ComposerWorkProductMode) => void;
  modes: readonly LocalizedComposerWorkProductModeDescriptor[];
  actions: LocalizedComposerWorkProductActionDescriptor;
  disabled?: boolean;
  className?: string;
}>;

export type WorkProductModeSelectorProps = WorkProductModeSelectorBaseProps &
  Readonly<{
    capabilityLabel?: string;
    capabilityCount?: number;
    capabilityMenu?: React.ReactNode;
    onOpenCapabilities?: () => void;
  }>;

export type WorkProductModeHeaderProps = WorkProductModeSelectorBaseProps &
  Readonly<{ controls?: React.ReactNode }> &
  (
    | Readonly<{ selectedReference?: undefined; onRemoveReference?: undefined }>
    | Readonly<{ selectedReference: WorkProductReferenceChip; onRemoveReference: () => void }>
  );

const MODE_ORDER: readonly ComposerWorkProductModeOption[] = ['image', 'video', 'presentation', 'pdf', 'word', 'excel'];
const MODE_SET = new Set<ComposerWorkProductModeOption>(MODE_ORDER);

function modeIcon(mode: ComposerWorkProductModeOption, size = 17): React.ReactNode {
  const iconProps = { theme: 'outline' as const, size, fill: 'currentColor', strokeWidth: 3 };
  switch (mode) {
    case 'image':
      return <Picture {...iconProps} />;
    case 'video':
      return <Video {...iconProps} />;
    case 'presentation':
      return <Projector {...iconProps} />;
    case 'pdf':
      return <FilePdf {...iconProps} />;
    case 'word':
      return <FileWord {...iconProps} />;
    case 'excel':
      return <FileExcel {...iconProps} />;
  }
}

function safeModeDescriptors(
  modes: readonly LocalizedComposerWorkProductModeDescriptor[]
): readonly LocalizedComposerWorkProductModeDescriptor[] {
  const seen = new Set<ComposerWorkProductModeOption>();
  return modes.filter((descriptor) => {
    const mode = descriptor.mode;
    if (!MODE_SET.has(mode) || seen.has(mode)) return false;
    if (typeof descriptor.label !== 'string' || descriptor.label.trim().length === 0) return false;
    if (typeof descriptor.tooltip !== 'string' || descriptor.tooltip.trim().length === 0) return false;
    seen.add(mode);
    return true;
  });
}

/** One calm launcher. Only a real menu click can grant a work-product lane. */
const WorkProductModeSelector: React.FC<WorkProductModeSelectorProps> = ({
  value,
  onChange,
  modes,
  actions,
  disabled = false,
  className,
  capabilityLabel,
  capabilityCount,
  capabilityMenu,
  onOpenCapabilities,
}) => {
  const descriptors = useMemo(() => safeModeDescriptors(modes), [modes]);
  const menu = (
    <Menu
      className={styles.menu}
      onClickMenuItem={(key) => {
        if (MODE_SET.has(key as ComposerWorkProductModeOption)) {
          onChange(key as ComposerWorkProductModeOption);
          return;
        }
        if (key === 'capabilities') onOpenCapabilities?.();
      }}
    >
      {descriptors.map((descriptor) => (
        <Menu.Item key={descriptor.mode} data-testid={`work-product-mode-${descriptor.mode}`}>
          <span className={styles.menuItem}>
            <span className={styles.menuIcon} data-mode={descriptor.mode} aria-hidden='true'>
              {modeIcon(descriptor.mode)}
            </span>
            <span className={styles.menuLabel}>{descriptor.label}</span>
            {value === descriptor.mode ? (
              <span className={styles.activeDot} data-mode={descriptor.mode} aria-hidden='true' />
            ) : null}
          </span>
        </Menu.Item>
      ))}
      {capabilityLabel ? <div className={styles.menuDivider} role='separator' /> : null}
      {capabilityLabel && capabilityMenu ? (
        <Menu.SubMenu
          key='capabilities-submenu'
          title={
            <span className={styles.menuItem}>
              <span className={styles.menuIcon} aria-hidden='true'>
                <AllApplication theme='outline' size={16} fill='currentColor' strokeWidth={3} />
              </span>
              <span className={styles.menuLabel}>{capabilityLabel}</span>
              {typeof capabilityCount === 'number' ? <span className={styles.count}>{capabilityCount}</span> : null}
            </span>
          }
        >
          {capabilityMenu}
        </Menu.SubMenu>
      ) : capabilityLabel ? (
        <Menu.Item key='capabilities'>
          <span className={styles.menuItem}>
            <span className={styles.menuIcon} aria-hidden='true'>
              <AllApplication theme='outline' size={16} fill='currentColor' strokeWidth={3} />
            </span>
            <span className={styles.menuLabel}>{capabilityLabel}</span>
            {typeof capabilityCount === 'number' ? <span className={styles.count}>{capabilityCount}</span> : null}
            <Right className={styles.chevron} theme='outline' size={13} fill='currentColor' strokeWidth={3} />
          </span>
        </Menu.Item>
      ) : null}
    </Menu>
  );

  return (
    <Dropdown
      trigger='click'
      position='tl'
      droplist={menu}
      disabled={disabled}
      triggerProps={COMPOSER_MENU_TRIGGER_PROPS}
    >
      <Tooltip content={actions.toolbarLabel} position='top' mini>
        <Button
          type='text'
          shape='circle'
          className={[styles.trigger, className].filter(Boolean).join(' ')}
          disabled={disabled}
          aria-label={actions.toolbarLabel}
          aria-haspopup='menu'
          data-active={value === 'chat' ? 'false' : 'true'}
          data-mode={value}
          data-testid='work-product-tools-trigger'
        >
          <Magic theme='outline' size={18} fill='currentColor' strokeWidth={3} />
        </Button>
      </Tooltip>
    </Dropdown>
  );
};

/** Active lane settings above the input; ordinary chat renders no header. */
export const WorkProductModeHeader: React.FC<WorkProductModeHeaderProps> = ({
  value,
  onChange,
  modes,
  actions,
  disabled = false,
  className,
  controls,
  selectedReference,
  onRemoveReference,
}) => {
  const descriptors = useMemo(() => safeModeDescriptors(modes), [modes]);
  const active = descriptors.find((descriptor) => descriptor.mode === value);
  if (!active || value === 'chat') return null;

  return (
    <div className={[styles.header, className].filter(Boolean).join(' ')} data-testid='work-product-mode-header'>
      <div className={styles.headerControls}>
        <Tooltip content={actions.returnToChatLabel} position='top' mini>
          <Button
            type='text'
            className={styles.activeMode}
            disabled={disabled}
            aria-label={actions.returnToChatLabel}
            aria-pressed='true'
            data-mode={value}
            data-testid={`work-product-active-${value}`}
            onClick={() => onChange('chat')}
          >
            <span aria-hidden='true'>{modeIcon(value)}</span>
            <span>{active.label}</span>
          </Button>
        </Tooltip>
        {controls ? <div className={styles.optionRail}>{controls}</div> : null}
      </div>

      {selectedReference ? (
        <div
          className={styles.referenceChip}
          role='group'
          aria-label={actions.selectedReferenceLabel}
          data-kind={selectedReference.kind}
          data-testid='work-product-reference-chip'
        >
          {selectedReference.preview ? (
            <span className={styles.referencePreview}>{selectedReference.preview}</span>
          ) : (
            <span className={styles.referenceKind}>{selectedReference.kindLabel}</span>
          )}
          <span className={styles.referenceTitle} title={selectedReference.title}>
            {selectedReference.preview ? selectedReference.kindLabel : selectedReference.title}
          </span>
          <Tooltip content={actions.removeReferenceLabel} position='top' mini>
            <Button
              type='text'
              className={styles.removeReference}
              aria-label={actions.removeReferenceLabel}
              disabled={disabled}
              data-testid='work-product-reference-remove'
              onClick={onRemoveReference}
            >
              <CloseSmall theme='outline' size={14} fill='currentColor' strokeWidth={3} />
            </Button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
};

export default WorkProductModeSelector;
