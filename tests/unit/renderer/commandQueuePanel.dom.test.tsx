import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CommandQueuePanel from '@/renderer/components/chat/CommandQueuePanel';
import type { ConversationCommandQueueItem } from '@/renderer/pages/conversation/platforms/useConversationCommandQueue';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; count?: number }) => options?.defaultValue ?? key,
  }),
}));

const createItem = (files: string[] = []): ConversationCommandQueueItem => ({
  id: 'queued-1',
  input: 'Correct the running task now',
  files,
  created_at: 1,
});

const renderPanel = (
  item: ConversationCommandQueueItem,
  onPromote = vi.fn(),
  promotingCommandIds: ReadonlySet<string> = new Set()
) => {
  render(
    <CommandQueuePanel
      items={[item]}
      paused={false}
      interactionLocked={false}
      promotingCommandIds={promotingCommandIds}
      onPause={vi.fn()}
      onResume={vi.fn()}
      onInteractionLock={vi.fn()}
      onInteractionUnlock={vi.fn()}
      onPromote={onPromote}
      onReorder={vi.fn()}
      onRemove={vi.fn()}
      onClear={vi.fn()}
    />
  );
  return onPromote;
};

describe('CommandQueuePanel', () => {
  it('lets a queued text command be pushed into the running turn as a correction', () => {
    const item = createItem();
    const onPromote = renderPanel(item);

    fireEvent.click(screen.getByRole('button', { name: 'Push as correction now' }));

    expect(onPromote).toHaveBeenCalledWith(item);
  });

  it('keeps file-bearing commands queued because steering cannot carry attachments', () => {
    const onPromote = renderPanel(createItem(['/tmp/evidence.pdf']));

    expect(screen.getByRole('button', { name: 'Push as correction now' })).toBeDisabled();
    expect(onPromote).not.toHaveBeenCalled();
  });

  it('counts only user-visible files while keeping internal sidecars non-promotable', () => {
    const item = {
      ...createItem(['/tmp/report.pdf', '/tmp/document-intelligence/report.md']),
      displayFiles: ['/tmp/report.pdf'],
    };
    renderPanel(item);

    expect(screen.getByText('1 files')).toBeInTheDocument();
    expect(screen.queryByText('2 files')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Push as correction now' })).toBeDisabled();
  });

  it('disables promotion while the same queued command is already being dispatched', () => {
    const item = createItem();
    const onPromote = renderPanel(item, vi.fn(), new Set([item.id]));

    fireEvent.click(screen.getByRole('button', { name: 'Push as correction now' }));

    expect(screen.getByRole('button', { name: 'Push as correction now' })).toBeDisabled();
    expect(onPromote).not.toHaveBeenCalled();
  });
});
