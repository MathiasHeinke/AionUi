/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';
import CommandEveGlyph from '@/renderer/components/commandEve/CommandEveGlyph';
import React from 'react';

type DragOverlayContentProps = {
  conversation?: TChatConversation;
};

const DragOverlayContent: React.FC<DragOverlayContentProps> = ({ conversation }) => {
  if (!conversation) return null;

  return (
    <div
      className='flex items-center gap-10px px-12px py-8px rd-8px min-w-200px max-w-300px'
      style={{
        backgroundColor: 'var(--color-bg-1)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        border: '1px solid var(--color-border-2)',
        transform: 'scale(1.02)',
      }}
    >
      <CommandEveGlyph size={18} className='flex-shrink-0' />
      <div className='text-14px lh-24px text-t-primary truncate flex-1'>{conversation.name}</div>
    </div>
  );
};

export default DragOverlayContent;
