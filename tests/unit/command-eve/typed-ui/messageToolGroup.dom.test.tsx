/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageToolGroup } from '@/common/chat/chatLib';
import MessageToolGroup from '@/renderer/pages/conversation/Messages/components/MessageToolGroup';
import {
  canResolveWorkbenchArtifact,
  openWorkbenchArtifact,
  resetWorkbenchArtifactResolversForTest,
} from '@/renderer/pages/conversation/Preview/services/workbenchArtifactResolver';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { typedUIFixture } from './fixtures';

const generatedArtifactMock = vi.hoisted(() => vi.fn(() => 'generated-artifact-stub'));
const realArtifactState = vi.hoisted(() => ({ enabled: false }));
const ipcMock = vi.hoisted(() => ({ attestTypedUI: vi.fn() }));
const previewMock = vi.hoisted(() => ({ openPreview: vi.fn() }));
const seatMock = vi.hoisted(() => ({
  current: 'seat-a',
  listeners: new Set<(seatId: string) => void>(),
}));

function typedUIAttestationResponse(artifact: {
  artifact_id: string;
  conversation_id: string;
  source_message_id: string;
}) {
  return {
    success: true,
    data: {
      version: 'command-eve.typed-ui-provenance-attestation/v2',
      attestation_id: `tuia_${'a'.repeat(64)}`,
      artifact_id: artifact.artifact_id,
      conversation_id: artifact.conversation_id,
      source_message_id: artifact.source_message_id,
      content_sha256: 'b'.repeat(64),
      action_set_sha256: 'c'.repeat(64),
      identity_sha256: 'd'.repeat(64),
      request_id_sha256: 'e'.repeat(64),
      receipt_sha256: 'f'.repeat(64),
      seat_context_revision: 1,
      status: 'verified' as const,
      recorded_at: '2026-08-12T00:00:00.000Z',
    },
  };
}

vi.mock('@/common/config/configService', () => ({
  configService: {
    getCurrentSeatId: () => seatMock.current,
    onSeatRebind: (listener: (seatId: string) => void) => {
      seatMock.listeners.add(listener);
      return () => seatMock.listeners.delete(listener);
    },
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: { confirmMessage: { invoke: vi.fn() } },
    commandEve: { typedUIProvenanceAttestation: { invoke: ipcMock.attestTypedUI } },
    shell: {
      openFile: { invoke: vi.fn() },
      openExternal: { invoke: vi.fn() },
      showItemInFolder: { invoke: vi.fn() },
    },
    fs: {
      readFile: { invoke: vi.fn() },
      readFileBuffer: { invoke: vi.fn() },
      getImageBase64: { invoke: vi.fn() },
      getFileMetadata: { invoke: vi.fn() },
    },
    application: { readGeneratedArtifactPreview: { invoke: vi.fn() } },
  },
}));

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
  FolderOpen: () => null,
  LoadingOne: () => null,
  Paperclip: () => null,
  PreviewOpen: () => null,
}));

vi.mock('@/renderer/components/base/FeedbackButton', () => ({ default: () => null }));
vi.mock('@/renderer/components/base/FileChangesPanel', () => ({ default: () => null }));
vi.mock('@/renderer/components/chat/CollapsibleContent', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/renderer/components/media/LocalImageView', () => ({
  default: ({ src }: { src: string }) => <img data-testid='legacy-image-preview' src={src} alt='' />,
}));
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
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({ conversation_id: 'conversation-typed-ui', workspace: '/tmp' }),
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => previewMock,
}));
vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit: vi.fn() } }));
vi.mock('@/renderer/pages/conversation/Preview/components/viewers/PDFViewer', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/TypedGenerativeUI', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/renderer/pages/conversation/Messages/components/TypedGenerativeUI')>();
  return {
    ...actual,
    TypedUIRenderer: () => <div data-testid='typed-ui-rendered' />,
  };
});
vi.mock('@/renderer/pages/conversation/Messages/components/MessageGeneratedArtifact', async (importOriginal) => {
  const ReactModule = await import('react');
  const actual =
    await importOriginal<typeof import('@/renderer/pages/conversation/Messages/components/MessageGeneratedArtifact')>();
  return {
    default: (props: React.ComponentProps<typeof actual.default>) =>
      realArtifactState.enabled ? ReactModule.createElement(actual.default, props) : generatedArtifactMock(props),
  };
});

function typedPublishTool(
  status: IMessageToolGroup['content'][number]['status'],
  resultDisplayOverrides: Record<string, unknown> = {}
): IMessageToolGroup {
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
          content: JSON.stringify(typedUIFixture()),
          ...resultDisplayOverrides,
        },
      },
    ],
  };
}

function imageGenerationTool(
  status: IMessageToolGroup['content'][number]['status'],
  resultDisplayOverrides: Record<string, unknown> = {}
): IMessageToolGroup {
  return {
    id: 'tool-group-image',
    msg_id: 'message-image',
    conversation_id: 'conversation-image',
    type: 'tool_group',
    position: 'left',
    created_at: 1,
    content: [
      {
        call_id: 'call-image',
        description: 'Generate image',
        name: 'ImageGeneration',
        render_output_as_markdown: false,
        status,
        result_display: {
          img_url: 'data:image/png;base64,AAECAw==',
          relative_path: 'candidate.png',
          ...resultDisplayOverrides,
        },
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  generatedArtifactMock.mockClear();
  realArtifactState.enabled = false;
  ipcMock.attestTypedUI.mockReset();
  previewMock.openPreview.mockReset();
  seatMock.current = 'seat-a';
  seatMock.listeners.clear();
  resetWorkbenchArtifactResolversForTest();
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

  it('keeps a contradictory Success publish with an error marker as ordinary tool data', () => {
    render(<MessageToolGroup message={typedPublishTool('Success', { error: 'Provider rejected the artifact.' })} />);

    expect(screen.getByText(/"error": "Provider rejected the artifact\."/)).toBeInTheDocument();
    expect(screen.queryByText('generated-artifact-stub')).toBeNull();
    expect(generatedArtifactMock).not.toHaveBeenCalled();
  });

  it('keeps a contradictory Success publish with a failed receipt as ordinary tool data', () => {
    render(<MessageToolGroup message={typedPublishTool('Success', { receipt: { status: 'failed' } })} />);

    expect(screen.getByText(/"status": "failed"/)).toBeInTheDocument();
    expect(screen.queryByText('generated-artifact-stub')).toBeNull();
    expect(generatedArtifactMock).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'unverified'] as const)(
    'keeps a contradictory Success publish with a %s receipt as ordinary tool data',
    (receiptStatus) => {
      render(<MessageToolGroup message={typedPublishTool('Success', { receipt: { status: receiptStatus } })} />);

      expect(screen.getByText(new RegExp(`"status": "${receiptStatus}"`))).toBeInTheDocument();
      expect(screen.queryByText('generated-artifact-stub')).toBeNull();
      expect(generatedArtifactMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['error marker', { error: 'Provider rejected the artifact.' }],
    ['failure marker', { failure: 'Provider rejected the artifact.' }],
    ['negative ok marker', { ok: false }],
    ['negative success marker', { success: false }],
    ['failed boolean marker', { failed: true }],
    ['blocked boolean marker', { blocked: true }],
  ])(
    'keeps a contradictory Success publish with a successful-looking receipt %s as ordinary tool data',
    (_label, marker) => {
      render(<MessageToolGroup message={typedPublishTool('Success', { receipt: { status: 'done', ...marker } })} />);

      expect(screen.getByText(/"status": "done"/)).toBeInTheDocument();
      expect(screen.queryByText('generated-artifact-stub')).toBeNull();
      expect(generatedArtifactMock).not.toHaveBeenCalled();
    }
  );

  it.each(['failed', 'blocked', 'unverified'] as const)(
    'keeps a contradictory Success publish with a %s payload status as ordinary tool data',
    (payloadStatus) => {
      render(<MessageToolGroup message={typedPublishTool('Success', { status: payloadStatus })} />);

      expect(screen.getByText(new RegExp(`"status": "${payloadStatus}"`))).toBeInTheDocument();
      expect(screen.queryByText('generated-artifact-stub')).toBeNull();
      expect(generatedArtifactMock).not.toHaveBeenCalled();
    }
  );

  it.each(['Executing', 'Pending', 'Error', 'Canceled'] as const)(
    'keeps legacy ImageGeneration output as ordinary tool data while %s',
    (status) => {
      render(<MessageToolGroup message={imageGenerationTool(status)} />);

      expect(screen.getByText(/ImageGeneration/)).toBeInTheDocument();
      expect(screen.getByText(/data:image\/png;base64,AAECAw==/)).toBeInTheDocument();
      expect(screen.queryByTestId('legacy-image-preview')).toBeNull();
      expect(screen.queryByText('generated-artifact-stub')).toBeNull();
      expect(generatedArtifactMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['error marker', { error: 'Provider rejected the image.' }],
    ['failed receipt', { receipt: { status: 'failed' } }],
    ['blocked receipt', { receipt: { status: 'blocked' } }],
    ['unverified receipt', { receipt: { status: 'unverified' } }],
    ['failed payload status', { status: 'failed' }],
    ['blocked payload status', { status: 'blocked' }],
    ['unverified payload status', { status: 'unverified' }],
    ['successful-looking failed receipt', { receipt: { status: 'done', failed: true } }],
  ])('keeps legacy ImageGeneration Success with a %s as ordinary tool data', (_label, contradiction) => {
    render(<MessageToolGroup message={imageGenerationTool('Success', contradiction)} />);

    expect(screen.getByText(/ImageGeneration/)).toBeInTheDocument();
    expect(screen.getByText(/data:image\/png;base64,AAECAw==/)).toBeInTheDocument();
    expect(screen.queryByTestId('legacy-image-preview')).toBeNull();
    expect(screen.queryByText('generated-artifact-stub')).toBeNull();
    expect(generatedArtifactMock).not.toHaveBeenCalled();
  });

  it('materializes legacy ImageGeneration output only after terminal Success', () => {
    render(<MessageToolGroup message={imageGenerationTool('Success')} />);

    expect(screen.getByText('generated-artifact-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('legacy-image-preview')).toBeNull();
    expect(generatedArtifactMock).toHaveBeenCalledOnce();
  });

  it('keeps a real legacy typed tool_group non-addressable until Main verifies it', async () => {
    realArtifactState.enabled = true;
    ipcMock.attestTypedUI.mockImplementation(
      ({ request }: { request: { artifact: Parameters<typeof typedUIAttestationResponse>[0] } }) => {
        const response = typedUIAttestationResponse(request.artifact);
        return { ...response, data: { ...response.data, status: 'rejected' as const, reason: 'receipt_missing' } };
      }
    );
    const reference = {
      kind: 'chat' as const,
      artifactId: 'tool-artifact-call-typed-ui',
      conversationId: 'conversation-typed-ui',
    };

    render(<MessageToolGroup message={typedPublishTool('Success')} />);

    await waitFor(() => expect(screen.getByTestId('typed-ui-provenance-rejected')).toBeInTheDocument());
    expect(screen.queryByTestId('generated-artifact-card')).toBeNull();
    expect(canResolveWorkbenchArtifact(reference)).toBe(false);
  });

  it('registers a real legacy typed tool_group exactly after Main verifies it', async () => {
    realArtifactState.enabled = true;
    ipcMock.attestTypedUI.mockImplementation(
      ({ request }: { request: { artifact: Parameters<typeof typedUIAttestationResponse>[0] } }) =>
        typedUIAttestationResponse(request.artifact)
    );
    const reference = {
      kind: 'chat' as const,
      artifactId: 'tool-artifact-call-typed-ui',
      conversationId: 'conversation-typed-ui',
    };

    const { rerender } = render(<MessageToolGroup message={typedPublishTool('Executing')} />);

    expect(canResolveWorkbenchArtifact(reference)).toBe(false);
    rerender(<MessageToolGroup message={typedPublishTool('Success')} />);

    await waitFor(() => expect(screen.getByTestId('generated-artifact-card')).toBeInTheDocument());
    await waitFor(() => expect(canResolveWorkbenchArtifact(reference)).toBe(true));
    await openWorkbenchArtifact(reference);
    expect(previewMock.openPreview).toHaveBeenCalledOnce();
  });
});
