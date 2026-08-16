/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import { Popover } from '@arco-design/web-react';
import { Lightning } from '@renderer/components/icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';

type ConversationSkillsIndicatorProps = {
  conversation: TChatConversation | undefined;
};

/**
 * Shows the skills mounted on this conversation, read directly from
 * `conversation.extra.skills` (snapshot written at creation time by the
 * backend). Joins with the global `/api/skills` index for descriptions.
 */
const ConversationSkillsIndicator: React.FC<ConversationSkillsIndicatorProps> = ({ conversation }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const names = (conversation?.extra as { skills?: string[] } | undefined)?.skills ?? [];

  const { data: skillIndex } = useSWR(names.length > 0 ? 'skills-index' : null, () =>
    ipcBridge.fs.listAvailableSkills.invoke()
  );

  if (names.length === 0) return null;

  const descriptionByName = new Map((skillIndex ?? []).map((s) => [s.name, s.description]));

  const handleSkillClick = (skillName: string) => {
    navigate(`/settings/capabilities?tab=skills&highlight=${encodeURIComponent(skillName)}`);
  };

  const content = (
    <div className='max-w-320px max-h-300px overflow-y-auto'>
      <div className='text-12px font-500 text-t-secondary mb-8px'>
        {t('conversation.skills.loaded')} ({names.length})
      </div>
      <div className='flex flex-col gap-4px'>
        {names.map((name) => (
          <button
            type='button'
            key={name}
            className='w-full flex items-center gap-8px py-4px px-8px border-none bg-transparent text-left rounded-4px hover:bg-2 cursor-pointer text-13px text-t-primary truncate'
            onClick={() => handleSkillClick(name)}
            title={descriptionByName.get(name) ?? ''}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Popover content={content} trigger='click' position='br'>
      <button
        type='button'
        aria-label={`${t('conversation.skills.loaded')} (${names.length})`}
        className='eve-pill inline-flex items-center gap-4px px-8px py-2px border-none cursor-pointer'
        data-testid='skills-indicator'
      >
        <Lightning theme='filled' size={14} style={{ lineHeight: 0 }} />
        <span className='text-13px text-t-primary lh-[1]' data-testid='skills-indicator-count'>
          {names.length}
        </span>
      </button>
    </Popover>
  );
};

export default ConversationSkillsIndicator;
