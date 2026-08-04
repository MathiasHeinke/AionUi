/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';

const mocks = vi.hoisted(() => ({
  copyText: vi.fn().mockResolvedValue(undefined),
  copySuccess: vi.fn(),
  copyError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@arco-design/web-react', async () => {
  const Menu = Object.assign(
    ({ children, onClickMenuItem }: { children: React.ReactNode; onClickMenuItem?: (key: string) => void }) => (
      <div role='menu'>
        {React.Children.map(children, (child) =>
          React.isValidElement(child)
            ? React.cloneElement(child as React.ReactElement<{ onClick?: () => void }>, {
                onClick: () => onClickMenuItem?.(String(child.key)),
              })
            : child
        )}
      </div>
    ),
    {
      Item: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
        <div role='menuitem' onClick={onClick}>
          {children}
        </div>
      ),
    }
  );

  return {
    Checkbox: ({ checked }: { checked?: boolean }) => <input readOnly type='checkbox' checked={checked} />,
    Dropdown: ({ children, droplist }: { children: React.ReactNode; droplist: React.ReactNode }) => (
      <>
        {children}
        {droplist}
      </>
    ),
    Message: { success: mocks.copySuccess, error: mocks.copyError },
    Menu,
    Spin: () => <span data-testid='spin' />,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText: mocks.copyText }));

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

    expect(screen.getByTestId('command-eve-glyph').querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('uses the restrained EVE selected-row treatment and current-page semantics', () => {
    const { container } = renderRow({ selected: true, hasError: true });
    const row = container.querySelector('#c-conv-1');
    const primaryAction = screen.getByRole('button', { name: 'Client kickoff' });

    expect(primaryAction.getAttribute('aria-current')).toBe('page');
    expect(row?.classList.contains('eve-row')).toBe(true);
    expect(row?.classList.contains('eve-row--selected')).toBe(true);
    expect(row?.classList.contains('!bg-fill-3')).toBe(false);
    expect(screen.getByTestId('session-status-dot').getAttribute('data-shape')).toBe('square');
    expect(screen.getByTestId('session-status-dot').getAttribute('data-status')).toBe('error');
  });

  it('shows a completed receipt as a circular done dot', () => {
    renderRow({ selected: true, hasCompletionUnread: true });

    const status = screen.getByTestId('session-status-dot');
    expect(status.getAttribute('data-shape')).toBe('circle');
    expect(status.getAttribute('data-status')).toBe('done');
  });

  it('uses a native primary action and keeps the menu a separate button', () => {
    const onConversationClick = vi.fn();
    renderRow({ onConversationClick });

    const row = screen.getByRole('button', { name: 'Client kickoff' });
    fireEvent.click(row);

    expect(row.tagName).toBe('BUTTON');
    expect(onConversationClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'common.more' }).getAttribute('aria-haspopup')).toBe('menu');
  });

  it('uses checkbox semantics on a native batch action', () => {
    const onToggleChecked = vi.fn();
    renderRow({ batchMode: true, checked: true, onToggleChecked });

    const row = screen.getByRole('checkbox', { name: 'Client kickoff' });
    fireEvent.click(row);

    expect(row.tagName).toBe('BUTTON');
    expect(row.getAttribute('aria-checked')).toBe('true');
    expect(onToggleChecked).toHaveBeenCalledTimes(1);
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

  it('copies the exact opaque session id from the row menu', async () => {
    renderRow();

    fireEvent.click(screen.getByText('conversation.history.copySessionId'));

    expect(mocks.copyText).toHaveBeenCalledWith('conv-1');
    await vi.waitFor(() => expect(mocks.copySuccess).toHaveBeenCalledWith('messages.copiedToClipboard'));
  });
});
