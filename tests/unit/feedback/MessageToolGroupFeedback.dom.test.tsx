/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Verifies MessageToolGroup renders the FeedbackButton only when a tool call
 * has status='Error' and wires it to module=conversation-session.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const openFeedbackMock = vi.fn(() => Promise.resolve());
vi.mock('@/renderer/hooks/context/FeedbackContext', () => ({
  useFeedback: () => ({ openFeedback: openFeedbackMock }),
}));

// Stub heavy dependencies that MessageToolGroup pulls in so this test can
// render in pure jsdom without the whole app tree.
vi.mock('@renderer/components/chat/CollapsibleContent', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@renderer/components/Markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@renderer/components/media/LocalImageView', () => ({
  default: () => null,
}));
vi.mock('@/renderer/components/base/FileChangesPanel', () => ({
  default: () => null,
}));
vi.mock('@/renderer/hooks/file/useDiffPreviewHandlers', () => ({
  useDiffPreviewHandlers: () => ({ openDiff: () => {}, openFile: () => {} }),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: { respondToConfirmation: { invoke: vi.fn() } },
    conversation: { respondToConfirmation: { invoke: vi.fn() } },
  },
}));

import MessageToolGroup from '@/renderer/pages/conversation/Messages/components/MessageToolGroup';
import type { IMessageToolGroup } from '@/common/chat/chatLib';

const buildToolGroup = (status: IMessageToolGroup['content'][number]['status']): IMessageToolGroup =>
  ({
    id: 'tg-1',
    conversation_id: 'conversation-1',
    type: 'tool_group',
    content: [
      {
        call_id: 'c1',
        description: 'ran something',
        name: 'Read',
        render_output_as_markdown: false,
        status,
        result_display: 'ENOENT: no such file',
      },
    ],
  }) as IMessageToolGroup;

const buildGeneratedVideoToolGroup = (): IMessageToolGroup =>
  ({
    id: 'tg-video',
    conversation_id: 'conversation-1',
    created_at: 10,
    type: 'tool_group',
    content: [
      {
        call_id: 'c-video',
        description: 'Generated video',
        name: 'GrokVideo',
        render_output_as_markdown: false,
        status: 'Success',
        result_display: {
          artifact_type: 'video',
          title: 'Launch clip',
          url: 'https://cdn.example.com/launch.mp4',
          mime_type: 'video/mp4',
          provider: 'xAI',
          model: 'grok-video',
        },
      },
    ],
  }) as IMessageToolGroup;

describe('MessageToolGroup — FeedbackButton wiring', () => {
  beforeEach(() => {
    openFeedbackMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render FeedbackButton on successful tool calls', () => {
    render(<MessageToolGroup message={buildToolGroup('Success')} />);
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
  });

  it('renders generic generated media tool results as artifact previews', () => {
    render(<MessageToolGroup message={buildGeneratedVideoToolGroup()} />);

    expect(screen.getByTestId('generated-artifact-card')).toBeInTheDocument();
    expect(screen.getByTestId('generated-artifact-video')).toHaveAttribute('src', 'https://cdn.example.com/launch.mp4');
    expect(screen.getByText('Launch clip')).toBeInTheDocument();
    expect(screen.getByText('xAI · grok-video · video/mp4')).toBeInTheDocument();
  });

  it('does not render FeedbackButton on canceled tool calls', () => {
    render(<MessageToolGroup message={buildToolGroup('Canceled')} />);
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
  });

  it('renders FeedbackButton when status=Error', () => {
    render(<MessageToolGroup message={buildToolGroup('Error')} />);
    expect(screen.getByText('settings.oneClickFeedback')).toBeInTheDocument();
  });

  it('click opens feedback with module=conversation-session', async () => {
    const user = userEvent.setup();
    render(<MessageToolGroup message={buildToolGroup('Error')} />);
    await user.click(screen.getByText('settings.oneClickFeedback'));

    expect(openFeedbackMock).toHaveBeenCalledTimes(1);
    expect(openFeedbackMock).toHaveBeenCalledWith({
      module: 'conversation-session',
      autoScreenshot: true,
    });
  });
});
