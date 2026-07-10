/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@arco-design/web-react', async () => {
  const Menu = Object.assign(({ children }: { children: React.ReactNode }) => <div role='menu'>{children}</div>, {
    Item: ({ children }: { children: React.ReactNode }) => <div role='menuitem'>{children}</div>,
  });

  return {
    Checkbox: ({ checked }: { checked?: boolean }) => <input readOnly type='checkbox' checked={checked} />,
    Dropdown: ({ children, droplist }: { children: React.ReactNode; droplist: React.ReactNode }) => (
      <>
        {children}
        {droplist}
      </>
    ),
    Menu,
    Spin: () => <span data-testid='spin' />,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/utils/ui/siderTooltip', () => ({
  cleanupSiderTooltips: vi.fn(),
  getSiderTooltipProps: () => ({}),
}));

import ConversationRow, {
  formatConversationActivityTime,
} from '@renderer/pages/conversation/GroupedHistory/ConversationRow';
import type { ConversationRowProps } from '@renderer/pages/conversation/GroupedHistory/types';

const makeConversation = (extra: Record<string, unknown> = {}): TChatConversation =>
  ({
    id: 'conv-1',
    name: 'Client kickoff',
    type: 'aionrs',
    model: 'command-eve',
    status: 'finished',
    created_at: Date.parse('2026-07-05T08:00:00Z'),
    modified_at: Date.parse('2026-07-06T09:30:00Z'),
    extra: { workspace: '/tmp/work', ...extra },
  }) as unknown as TChatConversation;

const renderRow = (overrides: Partial<ConversationRowProps> = {}) => {
  const props: ConversationRowProps = {
    conversation: makeConversation(),
    isGenerating: false,
    hasCompletionUnread: false,
    isWaitingInput: false,
    hasError: false,
    collapsed: false,
    tooltipEnabled: false,
    batchMode: false,
    checked: false,
    selected: false,
    menuVisible: true,
    onToggleChecked: vi.fn(),
    onConversationClick: vi.fn(),
    onOpenMenu: vi.fn(),
    onMenuVisibleChange: vi.fn(),
    onEditStart: vi.fn(),
    onDelete: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleArchive: vi.fn(),
    getJobStatus: () => 'none',
    ...overrides,
  };

  return render(<ConversationRow {...props} />);
};

describe('ConversationRow archive UI', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-06T12:00:00Z'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows Archive for visible conversations and the last active time', () => {
    const conversation = makeConversation();
    renderRow({ conversation });

    expect(screen.getByText('conversation.history.archive')).toBeTruthy();
    expect(screen.queryByText('conversation.history.restore')).toBeNull();
    expect(screen.getByText(formatConversationActivityTime(conversation.modified_at, Date.now()))).toBeTruthy();
  });

  it('shows only the public EVE identity, never a runtime or assistant image', () => {
    const { container } = renderRow();

    expect(screen.getByTestId('command-eve-glyph').textContent).toBe('⌘');
    expect(container.querySelector('img')).toBeNull();
  });

  it('uses the restrained EVE selected-row treatment and current-page semantics', () => {
    const { container } = renderRow({ selected: true, hasError: true });
    const row = container.querySelector('#c-conv-1');

    expect(row?.getAttribute('aria-current')).toBe('page');
    expect(row?.classList.contains('eve-row')).toBe(true);
    expect(row?.classList.contains('eve-row--selected')).toBe(true);
    expect(row?.classList.contains('!bg-fill-3')).toBe(false);
    expect(screen.getByTestId('session-status-dot').getAttribute('data-shape')).toBe('square');
    expect(screen.getByTestId('session-status-dot').getAttribute('data-status')).toBe('error');
  });

  it('shows Restore for archived conversations', () => {
    renderRow({ conversation: makeConversation({ archived: true, archived_at: Date.now() }) });

    expect(screen.getByText('conversation.history.restore')).toBeTruthy();
    expect(screen.queryByText('conversation.history.archive')).toBeNull();
  });

  it('hides the archive action when the parent does not wire it', () => {
    renderRow({ onToggleArchive: undefined });

    expect(screen.queryByText('conversation.history.archive')).toBeNull();
    expect(screen.queryByText('conversation.history.restore')).toBeNull();
  });

  it('shows the move action only when the parent wires it', () => {
    renderRow({ onMoveStart: vi.fn() });
    expect(screen.getByText('conversation.history.moveToFolder')).toBeTruthy();

    cleanup();
    renderRow({ onMoveStart: undefined });
    expect(screen.queryByText('conversation.history.moveToFolder')).toBeNull();
  });
});
