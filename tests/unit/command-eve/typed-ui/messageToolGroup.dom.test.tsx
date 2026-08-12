/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageToolGroup } from '@/common/chat/chatLib';
import MessageToolGroup from '@/renderer/pages/conversation/Messages/components/MessageToolGroup';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const generatedArtifactMock = vi.hoisted(() => vi.fn(() => 'generated-artifact-stub'));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@arco-design/web-react', () => ({
  Alert: ({ content, children }: { content?: React.ReactNode; children?: React.ReactNode }) => (
    <div>
      {content}
      {children}
    </div>
  ),
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
  Image: { PreviewGroup: ({ children }: { children?: React.ReactNode }) => <>{children}</> },
  Message: { error: vi.fn(), useMessage: () => [{ error: vi.fn(), success: vi.fn() }, null] },
  Radio: { Group: ({ children }: { children?: React.ReactNode }) => <>{children}</> },
  Tag: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@icon-park/react', () => ({
  Copy: () => null,
  Download: () => null,
  LoadingOne: () => null,
}));

vi.mock('@/renderer/components/base/FeedbackButton', () => ({ default: () => null }));
vi.mock('@/renderer/components/base/FileChangesPanel', () => ({ default: () => null }));
vi.mock('@/renderer/components/chat/CollapsibleContent', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/renderer/components/media/LocalImageView', () => ({ default: () => null }));
vi.mock('@/renderer/components/Markdown', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/renderer/hooks/file/useDiffPreviewHandlers', () => ({ useDiffPreviewHandlers: () => ({}) }));
vi.mock('@/renderer/utils/file/diffUtils', () => ({ parseDiff: () => ({}) }));
vi.mock('@/renderer/utils/common', () => ({
  ToolConfirmationOutcome: { ProceedOnce: 'once', ProceedAlways: 'always', Cancel: 'cancel' },
}));
vi.mock('@/renderer/pages/conversation/Messages/MessageFileChanges', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/MessageList', async () => {
  const ReactModule = await import('react');
  return { ImagePreviewContext: ReactModule.createContext({ inPreviewGroup: false }) };
});
vi.mock('@/renderer/pages/conversation/Messages/components/MessageGeneratedArtifact', () => ({
  default: generatedArtifactMock,
}));

function typedPublishTool(status: IMessageToolGroup['content'][number]['status']): IMessageToolGroup {
  return {
    id: 'tool-group-typed-ui',
    msg_id: 'message-typed-ui',
    conversation_id: 'conversation-typed-ui',
    type: 'tool_group',
    position: 'left',
    created_at: 1,
    content: [
      {
        call_id: 'call-typed-ui',
        description: 'Publish validated UI',
        name: 'eve_typed_ui_publish',
        render_output_as_markdown: false,
        status,
        result_display: {
          ok: true,
          artifact_type: 'file',
          mime_type: 'application/vnd.command-eve.typed-ui+json',
          schema_version: 'command-eve.typed-ui/v2',
          catalog_version: 'command-eve.typed-ui.catalog/v2',
          content: '{"schema_version":"command-eve.typed-ui/v2"}',
        },
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  generatedArtifactMock.mockClear();
});

describe('Typed UI tool publication', () => {
  it('keeps a valid-looking publish result inert until the tool has terminal Success', () => {
    const { rerender } = render(<MessageToolGroup message={typedPublishTool('Executing')} />);

    expect(screen.getByText('eve_typed_ui_publish')).toBeInTheDocument();
    expect(screen.getByText(/application\/vnd\.command-eve\.typed-ui\+json/)).toBeInTheDocument();
    expect(screen.queryByText('generated-artifact-stub')).toBeNull();
    expect(generatedArtifactMock).not.toHaveBeenCalled();

    rerender(<MessageToolGroup message={typedPublishTool('Success')} />);

    expect(screen.getByText('generated-artifact-stub')).toBeInTheDocument();
    expect(generatedArtifactMock).toHaveBeenCalled();
  });
});
