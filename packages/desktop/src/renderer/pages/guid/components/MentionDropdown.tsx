/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MentionOption } from '../types';
import { resolveExtensionAssetUrl } from '@/renderer/utils/platform';
import { Dropdown, Menu } from '@arco-design/web-react';
import { Down, Robot } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

type MentionDropdownProps = {
  menuRef: React.RefObject<HTMLDivElement | null>;
  options: MentionOption[];
  selectedKey: string;
  onSelect: (key: string) => void;
};

const MentionDropdown: React.FC<MentionDropdownProps> = ({ menuRef, options, selectedKey, onSelect }) => {
  const { t } = useTranslation();

  return (
    <div ref={menuRef} className='eve-menu-surface min-w-180px max-h-320px' data-eve-interaction-role='event-boundary'>
      <Menu
        selectedKeys={[selectedKey]}
        onClickMenuItem={(key) => onSelect(String(key))}
        className='min-w-180px bg-transparent!'
      >
        {options.length > 0 ? (
          options.map((option, index) => (
            <Menu.Item
              key={option.key}
              data-mention-index={index}
              className='eve-menu-item'
              style={{ transitionDuration: 'var(--eve-motion-duration-state)' }}
            >
              <div className='flex items-center gap-8px'>
                <span className='eve-menu-icon text-14px leading-16px'>
                  {option.avatarImage ? (
                    <img
                      src={resolveExtensionAssetUrl(option.avatarImage)}
                      alt=''
                      width={16}
                      height={16}
                      style={{ objectFit: 'contain' }}
                    />
                  ) : option.avatar ? (
                    option.avatar
                  ) : option.logo ? (
                    <img src={option.logo} alt={option.label} width={16} height={16} style={{ objectFit: 'contain' }} />
                  ) : (
                    <Robot theme='outline' size={16} />
                  )}
                </span>
                <span>{option.label}</span>
              </div>
            </Menu.Item>
          ))
        ) : (
          <Menu.Item key='empty' disabled className='eve-menu-item'>
            {t('conversation.welcome.none', { defaultValue: 'None' })}
          </Menu.Item>
        )}
      </Menu>
    </div>
  );
};

export default MentionDropdown;

// MentionSelectorBadge component
type MentionSelectorBadgeProps = {
  visible: boolean;
  open: boolean;
  onOpenChange: (visible: boolean) => void;
  agentLabel: string;
  mentionMenu: React.ReactNode;
  onResetQuery: () => void;
};

export const MentionSelectorBadge: React.FC<MentionSelectorBadgeProps> = ({
  visible,
  open,
  onOpenChange,
  agentLabel,
  mentionMenu,
  onResetQuery,
}) => {
  if (!visible) return null;

  return (
    <div className='flex items-center gap-8px mb-8px'>
      <Dropdown
        trigger='click'
        popupVisible={open}
        onVisibleChange={(v) => {
          onOpenChange(v);
          if (v) {
            onResetQuery();
          }
        }}
        droplist={mentionMenu}
      >
        <button
          type='button'
          aria-haspopup='menu'
          aria-expanded={open}
          className='eve-focus-ring eve-menu-item flex items-center gap-6px border-none bg-fill-2 px-10px py-4px rd-16px cursor-pointer select-none'
          style={{ transitionDuration: 'var(--eve-motion-duration-state)' }}
        >
          <span className='text-14px font-medium text-t-primary'>@{agentLabel}</span>
          <Down theme='outline' size={12} />
        </button>
      </Dropdown>
    </div>
  );
};
