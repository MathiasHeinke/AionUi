/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { Input } from '@arco-design/web-react';
import { Check, Close, Down, FolderClose, FolderOpen } from '@icon-park/react';
import { isElectronDesktop } from '@renderer/utils/platform';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_RECENT_WS_KEY, addRecentWorkspace, getRecentWorkspaces } from './recentWorkspaces';
import styles from './WorkspaceFolderSelect.module.css';

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;
const MAX_MENU_HEIGHT = 320;
const MENU_TRANSITION_MS = 400;

const transitionDelay = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 0
    : MENU_TRANSITION_MS;

type MenuPosition = {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
};

const estimateMenuHeight = (recentCount: number): number => {
  const recentSectionHeight = recentCount > 0 ? 36 + recentCount * 56 + 10 : 0;
  const browseActionHeight = 52;
  const menuPadding = 12;
  return recentSectionHeight + browseActionHeight + menuPadding;
};

type WorkspaceFolderSelectProps = {
  value?: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  placeholder: string;
  input_placeholder?: string;
  recentLabel: string;
  chooseDifferentLabel: string;
  recentStorageKey?: string;
  triggerTestId?: string;
  menuTestId?: string;
  menuZIndex?: number;
};

const WorkspaceFolderSelect: React.FC<WorkspaceFolderSelectProps> = ({
  value,
  onChange,
  onClear,
  placeholder,
  input_placeholder,
  recentLabel,
  chooseDifferentLabel,
  recentStorageKey = DEFAULT_RECENT_WS_KEY,
  triggerTestId,
  menuTestId,
  menuZIndex = 10010,
}) => {
  const { t } = useTranslation();
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition>({ top: 0, left: 0, width: 0, maxHeight: MAX_MENU_HEIGHT });
  const triggerRef = useRef<HTMLDivElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDesktop = isElectronDesktop();
  const recentWorkspaces = getRecentWorkspaces(recentStorageKey);

  const hideMenu = useCallback((restoreFocus = false) => {
    setMenuVisible(false);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setMenuMounted(false), transitionDelay());
    if (restoreFocus) triggerButtonRef.current?.focus({ preventScroll: true });
  }, []);

  const showMenu = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    setMenuMounted(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setMenuVisible(true)));
  }, []);

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    []
  );

  const updateMenuPosition = useCallback(() => {
    if (!triggerRef.current) return;

    const rect = triggerRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const belowSpace = Math.max(viewportHeight - rect.bottom - VIEWPORT_MARGIN, 0);
    const aboveSpace = Math.max(rect.top - VIEWPORT_MARGIN, 0);
    const estimatedHeight = Math.min(MAX_MENU_HEIGHT, estimateMenuHeight(recentWorkspaces.length));
    const openAbove = belowSpace < estimatedHeight && aboveSpace > belowSpace;
    const availableSpace = openAbove ? aboveSpace : belowSpace;

    setMenuPos({
      left: rect.left,
      width: rect.width,
      top: openAbove ? undefined : rect.bottom + MENU_GAP,
      bottom: openAbove ? viewportHeight - rect.top + MENU_GAP : undefined,
      maxHeight: Math.min(MAX_MENU_HEIGHT, availableSpace),
    });
  }, [recentWorkspaces.length]);

  useEffect(() => {
    if (!menuMounted) return;

    updateMenuPosition();

    const handleOutsideClick = (event: MouseEvent) => {
      if (triggerRef.current && !triggerRef.current.contains(event.target as Node)) {
        hideMenu();
      }
    };

    const handleViewportChange = () => updateMenuPosition();

    document.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('resize', handleViewportChange);
    document.addEventListener('scroll', handleViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('resize', handleViewportChange);
      document.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [hideMenu, menuMounted, updateMenuPosition]);

  const handleBrowse = async () => {
    hideMenu();

    const files = await ipcBridge.dialog.showOpen.invoke({ properties: ['openDirectory', 'createDirectory'] });
    if (files?.[0]) {
      onChange(files[0]);
      addRecentWorkspace(files[0], recentStorageKey);
    }
  };

  const handleSelectRecent = (path: string) => {
    onChange(path);
    addRecentWorkspace(path, recentStorageKey);
    hideMenu();
  };

  const handleClear = (event: React.MouseEvent) => {
    event.stopPropagation();
    onClear?.();
    if (!onClear) {
      onChange('');
    }
    hideMenu();
  };

  const folderName = value ? value.split(/[\\/]/).pop() || value : '';

  if (!isDesktop) {
    return <Input placeholder={input_placeholder ?? placeholder} value={value ?? ''} onChange={onChange} />;
  }

  return (
    <div className='relative' ref={triggerRef}>
      <div
        className={`flex items-center gap-10px rounded-10px border px-12px py-10px transition-all ${styles.trigger} ${
          menuVisible
            ? 'border-primary-5 bg-fill-2 shadow-sm'
            : 'border-border-2 bg-fill-1 hover:border-border-1 hover:bg-fill-2'
        }`}
      >
        <button
          ref={triggerButtonRef}
          type='button'
          data-testid={triggerTestId}
          role='combobox'
          aria-expanded={menuVisible}
          aria-haspopup='listbox'
          aria-controls={menuTestId}
          className='flex min-w-0 flex-1 cursor-pointer items-center gap-10px border-none bg-transparent p-0 text-left'
          onClick={() => {
            if (recentWorkspaces.length === 0) {
              void handleBrowse();
              return;
            }

            if (!menuVisible) {
              updateMenuPosition();
              showMenu();
              return;
            }
            hideMenu();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && menuMounted) {
              event.preventDefault();
              hideMenu(true);
              return;
            }
            if (event.key !== 'ArrowDown') return;
            event.preventDefault();
            updateMenuPosition();
            showMenu();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus())
            );
          }}
        >
          <FolderOpen theme='outline' size='16' fill='currentColor' className='block shrink-0 text-t-secondary' />
          {value ? (
            <span className='flex min-w-0 flex-1 flex-col justify-center'>
              <span className='text-sm leading-20px text-t-primary'>{folderName}</span>
              <span className='truncate text-11px leading-16px text-t-tertiary'>{value}</span>
            </span>
          ) : (
            <span className='min-w-0 flex-1 truncate text-sm leading-20px text-t-secondary'>{placeholder}</span>
          )}
          {!value && (
            <span className='flex h-20px w-20px shrink-0 items-center justify-center text-t-secondary'>
              <Down size='14' fill='currentColor' />
            </span>
          )}
        </button>
        {value ? (
          <button
            type='button'
            aria-label={t('common.clear')}
            className='flex h-20px w-20px shrink-0 cursor-pointer items-center justify-center text-t-secondary transition-colors hover:text-t-primary'
            onClick={handleClear}
          >
            <Close theme='outline' size='14' fill='currentColor' />
          </button>
        ) : null}
      </div>

      {menuMounted && (
        <div
          ref={menuRef}
          id={menuTestId}
          data-testid={menuTestId}
          role='listbox'
          data-eve-interaction-role='composite-control'
          style={{
            position: 'fixed',
            top: menuPos.top,
            bottom: menuPos.bottom,
            left: menuPos.left,
            width: menuPos.width,
            maxHeight: menuPos.maxHeight > 0 ? menuPos.maxHeight : undefined,
            zIndex: menuZIndex,
            isolation: 'isolate',
          }}
          className={`eve-menu-surface ${styles.menu} ${menuVisible ? styles.menuVisible : ''}`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              hideMenu(true);
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const options = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
            if (options.length === 0) return;
            const currentIndex = options.indexOf(document.activeElement as HTMLElement);
            const nextIndex =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? options.length - 1
                  : event.key === 'ArrowUp'
                    ? (currentIndex - 1 + options.length) % options.length
                    : (currentIndex + 1) % options.length;
            options[nextIndex]?.focus();
          }}
        >
          {recentWorkspaces.length > 0 && (
            <>
              <div className='px-10px pb-4px pt-6px text-10px font-500 uppercase tracking-[0.08em] text-t-tertiary'>
                {recentLabel}
              </div>
              {recentWorkspaces.map((path) => {
                const recentName = path.split(/[\\/]/).pop() || path;
                const isSelected = value === path;

                return (
                  <button
                    type='button'
                    role='option'
                    aria-selected={isSelected}
                    key={path}
                    onClick={() => handleSelectRecent(path)}
                    className='eve-menu-item w-full flex cursor-pointer items-center gap-10px border-none bg-transparent text-left px-10px py-7px'
                    style={{ transitionDuration: 'var(--eve-motion-duration-state)' }}
                  >
                    <FolderClose
                      theme='outline'
                      size='16'
                      fill='currentColor'
                      className={`eve-menu-icon ${isSelected ? 'text-[var(--eve-focus-ring)]' : ''}`}
                    />
                    <div className='min-w-0 flex-1'>
                      <div className='truncate text-13px leading-18px text-t-primary'>{recentName}</div>
                      <div className='truncate text-11px leading-14px text-t-tertiary'>{path}</div>
                    </div>
                    {isSelected && (
                      <span className='flex h-20px w-20px shrink-0 items-center justify-center text-aou-6'>
                        <Check size='14' fill='currentColor' />
                      </span>
                    )}
                  </button>
                );
              })}
              <div className='eve-menu-divider' />
            </>
          )}

          <button
            type='button'
            role='option'
            aria-selected='false'
            onClick={() => void handleBrowse()}
            className='eve-menu-item w-full flex cursor-pointer items-center gap-10px border-none bg-transparent text-left px-10px py-7px'
            style={{ transitionDuration: 'var(--eve-motion-duration-state)' }}
          >
            <FolderOpen theme='outline' size='16' fill='currentColor' className='eve-menu-icon' />
            <span className='text-13px text-t-primary'>{chooseDifferentLabel}</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default WorkspaceFolderSelect;
