/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Message } from '@arco-design/web-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const {
  listArtifactsInvokeMock,
  videoArtifactsListInvokeMock,
  imageArtifactsListInvokeMock,
  imageArtifactPreviewInvokeMock,
  previewOpenMock,
  openFileInvokeMock,
  showItemInFolderInvokeMock,
  useConversationContextSafeMock,
  getFileMetadataInvokeMock,
  readGeneratedArtifactPreviewInvokeMock,
} = vi.hoisted(() => ({
  listArtifactsInvokeMock: vi.fn(),
  videoArtifactsListInvokeMock: vi.fn(),
  imageArtifactsListInvokeMock: vi.fn(),
  imageArtifactPreviewInvokeMock: vi.fn(),
  previewOpenMock: vi.fn(),
  openFileInvokeMock: vi.fn(),
  showItemInFolderInvokeMock: vi.fn(),
  useConversationContextSafeMock: vi.fn(),
  getFileMetadataInvokeMock: vi.fn(),
  readGeneratedArtifactPreviewInvokeMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      getFileMetadata: { invoke: getFileMetadataInvokeMock },
      getImageBase64: { invoke: vi.fn() },
      readFileBuffer: { invoke: vi.fn() },
    },
    application: {
      readGeneratedArtifactPreview: { invoke: readGeneratedArtifactPreviewInvokeMock },
    },
    shell: {
      openFile: { invoke: openFileInvokeMock },
      openExternal: { invoke: vi.fn() },
      showItemInFolder: { invoke: showItemInFolderInvokeMock },
    },
    conversation: {
      listArtifacts: { invoke: listArtifactsInvokeMock },
      artifactStream: { on: vi.fn(() => () => {}) },
    },
    commandEve: {
      videoArtifactsList: { invoke: videoArtifactsListInvokeMock },
      imageArtifactsList: { invoke: imageArtifactsListInvokeMock },
      imageArtifactsChanged: { on: () => () => undefined },
      imageArtifactPreview: { invoke: imageArtifactPreviewInvokeMock },
    },
  },
}));

// MessageGeneratedArtifact pulls a wide renderer surface (markdown, PDF viewer,
// conversation context). Only the pieces the managed-image branch touches are
// kept real; the rest is doubled shallowly.
vi.mock('@/renderer/components/Markdown', () => ({ default: () => null }));
vi.mock('../../Preview/components/viewers/PDFViewer', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => useConversationContextSafeMock(),
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ openPreview: previewOpenMock }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => String(options?.defaultValue ?? key),
  }),
}));

import type { IConversationArtifact } from '@/common/adapter/ipcBridge';
import type { CommandEveActiveImageArtifact } from '@/common/config/managedImageArtifactCore';
import {
  ConversationArtifactProvider,
  isUsableMediaEditSource,
  mediaArtifactTypeOf,
  selectLatestVisibleMediaSourceArtifact,
  useConversationArtifacts,
} from '@/renderer/pages/conversation/Messages/artifacts';
import MessageGeneratedArtifact from '@/renderer/pages/conversation/Messages/components/MessageGeneratedArtifact';
import { emitter } from '@/renderer/utils/emitter';

const IMAGE_SHA = 'b'.repeat(64);

function managedImageArtifact(overrides: Record<string, unknown> = {}): CommandEveActiveImageArtifact {
  return {
    id: 'img_generated1',
    conversation_id: 'conv-1',
    kind: 'image',
    status: 'active',
    payload: {
      artifact_type: 'image',
      title: 'Bild 1K',
      description: '1K · 16:9 · gemini',
      managed_image: true,
      mime_type: 'image/png',
      sha256: IMAGE_SHA,
      size: 1234,
      tier: 'quality',
      model: 'gemini',
      resolution: '1K',
      aspect_ratio: '16:9',
      prompt_sha256: 'c'.repeat(64),
    },
    created_at: 1_754_000_000_000,
    updated_at: 1_754_000_000_000,
    ...overrides,
  } as CommandEveActiveImageArtifact;
}

const asConversationArtifact = (record: CommandEveActiveImageArtifact): IConversationArtifact =>
  record as unknown as IConversationArtifact;

function localPdfArtifact(path: string): IConversationArtifact {
  return {
    id: 'pdf_generated1',
    conversation_id: 'conv-1',
    kind: 'file',
    status: 'active',
    payload: {
      artifact_type: 'file',
      mime_type: 'application/pdf',
      path,
      title: 'Report',
    },
    created_at: 1_754_000_000_000,
    updated_at: 1_754_000_000_000,
  };
}

const fileMetadata = {
  name: 'report.pdf',
  path: '/Users/probe/workspace/reports/report.pdf',
  size: 1234,
  type: 'application/pdf',
  lastModified: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  useConversationContextSafeMock.mockReturnValue(null);
  listArtifactsInvokeMock.mockResolvedValue([]);
  videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [] });
  imageArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [] });
  imageArtifactPreviewInvokeMock.mockResolvedValue({
    success: true,
    data: { data_base64: Buffer.from('png-bytes').toString('base64'), mime_type: 'image/png', size: 9 },
  });
});

afterEach(() => {
  cleanup();
});

describe('the media helpers qualify id-based managed image records', () => {
  it('mediaArtifactTypeOf reads the image payload type', () => {
    expect(mediaArtifactTypeOf(asConversationArtifact(managedImageArtifact()))).toBe('image');
    expect(
      mediaArtifactTypeOf(asConversationArtifact(managedImageArtifact({ payload: { artifact_type: 'file' } })))
    ).toBeNull();
  });

  it('isUsableMediaEditSource: a managed image qualifies by marker; a dismissed one never does', () => {
    expect(isUsableMediaEditSource(asConversationArtifact(managedImageArtifact()))).toBe(true);
    expect(isUsableMediaEditSource(asConversationArtifact(managedImageArtifact({ status: 'dismissed' })))).toBe(false);
    expect(isUsableMediaEditSource(asConversationArtifact(managedImageArtifact({ status: 'pending' })))).toBe(false);
    // An id-based record WITHOUT the marker (no path, no url) is not a source.
    const unmarked = managedImageArtifact();
    (unmarked.payload as { managed_image?: unknown }).managed_image = undefined;
    expect(isUsableMediaEditSource(asConversationArtifact(unmarked))).toBe(false);
  });

  it('selectLatestVisibleMediaSourceArtifact picks the newest usable IMAGE, per medium', () => {
    const older = asConversationArtifact(managedImageArtifact({ id: 'img_older', created_at: 1000 }));
    const newer = asConversationArtifact(managedImageArtifact({ id: 'img_newer', created_at: 2000 }));
    const dismissedNewest = asConversationArtifact(
      managedImageArtifact({ id: 'img_dismissed', created_at: 3000, status: 'dismissed' })
    );
    expect(selectLatestVisibleMediaSourceArtifact([older, newer, dismissedNewest], 'image')?.id).toBe('img_newer');
    expect(selectLatestVisibleMediaSourceArtifact([older, newer], 'video')).toBeNull();
  });
});

describe('ConversationArtifactProvider merges the managed image store', () => {
  const Probe: React.FC<{ onArtifacts: (artifacts: IConversationArtifact[]) => void }> = ({ onArtifacts }) => {
    const artifacts = useConversationArtifacts();
    React.useEffect(() => {
      onArtifacts(artifacts);
    }, [artifacts, onArtifacts]);
    return null;
  };

  it('loads imageArtifactsList alongside the other sources — and the finish refresh re-reads it (same-turn card + Artefakte +1)', async () => {
    const seen: IConversationArtifact[][] = [];
    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <Probe onArtifacts={(artifacts) => seen.push(artifacts)} />
      </ConversationArtifactProvider>
    );
    await waitFor(() => expect(imageArtifactsListInvokeMock).toHaveBeenCalledWith({ conversationId: 'conv-1' }));
    await waitFor(() => expect(seen.at(-1)).toEqual([]));

    // The turn produced an image: Main bound it, the terminal finish fires the
    // refresh, and the next read exposes it — no reload, no remount.
    imageArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [managedImageArtifact()] });
    act(() => {
      emitter.emit('commandEve.artifacts.refresh', { conversation_id: 'conv-1' });
    });
    await waitFor(() => {
      const latest = seen.at(-1) ?? [];
      expect(latest.map((artifact) => artifact.id)).toContain('img_generated1');
    });
    // Reload persistence: a fresh mount reads the same durable list back.
    cleanup();
    const remount: IConversationArtifact[][] = [];
    render(
      <ConversationArtifactProvider conversation_id='conv-1'>
        <Probe onArtifacts={(artifacts) => remount.push(artifacts)} />
      </ConversationArtifactProvider>
    );
    await waitFor(() => {
      const latest = remount.at(-1) ?? [];
      expect(latest.map((artifact) => artifact.id)).toContain('img_generated1');
    });
  });
});

describe('generated artifact shell actions use a native authority', () => {
  it('does not open a traversal path when AionCore rejects it', async () => {
    useConversationContextSafeMock.mockReturnValue({ workspace: '/Users/probe/workspace' });
    getFileMetadataInvokeMock.mockResolvedValue(undefined);
    readGeneratedArtifactPreviewInvokeMock.mockResolvedValue(null);
    const error = vi.spyOn(Message, 'error').mockImplementation(() => () => undefined);

    render(<MessageGeneratedArtifact artifact={localPdfArtifact('../outside.pdf') as never} />);
    fireEvent.click(screen.getByTestId('generated-artifact-open'));

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(openFileInvokeMock).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not reveal an external absolute path when both native authorities reject it', async () => {
    useConversationContextSafeMock.mockReturnValue({ workspace: '/Users/probe/workspace' });
    getFileMetadataInvokeMock.mockResolvedValue(undefined);
    readGeneratedArtifactPreviewInvokeMock.mockResolvedValue(null);
    const error = vi.spyOn(Message, 'error').mockImplementation(() => () => undefined);

    render(<MessageGeneratedArtifact artifact={localPdfArtifact('/Users/probe/outside.pdf') as never} />);
    fireEvent.click(screen.getByTestId('generated-artifact-reveal'));

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(showItemInFolderInvokeMock).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('opens a workspace artifact after AionCore metadata approves it', async () => {
    useConversationContextSafeMock.mockReturnValue({ workspace: '/Users/probe/workspace' });
    getFileMetadataInvokeMock.mockResolvedValue(fileMetadata);

    render(<MessageGeneratedArtifact artifact={localPdfArtifact('reports/report.pdf') as never} />);
    fireEvent.click(screen.getByTestId('generated-artifact-open'));

    await waitFor(() => expect(openFileInvokeMock).toHaveBeenCalledWith('/Users/probe/workspace/reports/report.pdf'));
    expect(getFileMetadataInvokeMock).toHaveBeenCalledWith({
      path: '/Users/probe/workspace/reports/report.pdf',
      workspace: '/Users/probe/workspace',
    });
  });

  it('reveals a Downloads artifact after the generated-preview authority approves it', async () => {
    getFileMetadataInvokeMock.mockResolvedValue(undefined);
    readGeneratedArtifactPreviewInvokeMock.mockResolvedValue({
      data: 'JVBERi0=',
      encoding: 'base64',
      mimeType: 'application/pdf',
      size: 8,
    });

    render(<MessageGeneratedArtifact artifact={localPdfArtifact('/Users/probe/Downloads/report.pdf') as never} />);
    await waitFor(() => expect(readGeneratedArtifactPreviewInvokeMock).toHaveBeenCalled());
    readGeneratedArtifactPreviewInvokeMock.mockClear();

    fireEvent.click(screen.getByTestId('generated-artifact-reveal'));

    await waitFor(() => expect(showItemInFolderInvokeMock).toHaveBeenCalledWith('/Users/probe/Downloads/report.pdf'));
    expect(readGeneratedArtifactPreviewInvokeMock).toHaveBeenCalledWith({
      path: '/Users/probe/Downloads/report.pdf',
      kind: 'pdf',
    });
  });
});

describe('the managed image card previews by artifact id', () => {
  it('renders generated-artifact-image from the preview IPC — never a path', async () => {
    render(<MessageGeneratedArtifact artifact={asConversationArtifact(managedImageArtifact()) as never} />);
    await waitFor(() =>
      expect(imageArtifactPreviewInvokeMock).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        artifactId: 'img_generated1',
      })
    );
    const img = await screen.findByTestId('generated-artifact-image');
    expect(img.getAttribute('src')?.startsWith('data:image/png;base64,')).toBe(true);
    // No open/reveal affordance without a path — and no path anywhere in the DOM.
    expect(screen.queryByTestId('generated-artifact-reveal')).toBeNull();
    expect(document.body.innerHTML).not.toContain('/Users/');
  });

  it('keeps previewing through the bridge when the placement path resolves against a workspace (1.823.x regression)', async () => {
    // Live evidence 2026-08-18: a temp conversation's workspace
    // (hermes-temp-<conv>) resolved the payload's relative placement path into
    // a file: source, which flipped the card off the managed bridge and ended
    // in fs/metadata 400s — the card showed "keine direkte Vorschau" for a
    // byte-perfect image. The marker alone must drive the bridge now.
    useConversationContextSafeMock.mockReturnValue({
      workspace: '/Users/probe/.command-eve/conversations/hermes-temp-conv-1',
    });
    const placed = managedImageArtifact();
    (placed.payload as Record<string, unknown>).path = 'bilder/erstelle-hiermit-das-bild-2026-08-18.png';

    render(<MessageGeneratedArtifact artifact={asConversationArtifact(placed) as never} />);
    await waitFor(() =>
      expect(imageArtifactPreviewInvokeMock).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        artifactId: 'img_generated1',
      })
    );
    const img = await screen.findByTestId('generated-artifact-image');
    expect(img.getAttribute('src')?.startsWith('data:image/png;base64,')).toBe(true);
    // The managed artifact never previews from the payload path: no metadata
    // probe against the (wrong) conversation workspace, no generated-artifact
    // fallback read.
    expect(getFileMetadataInvokeMock).not.toHaveBeenCalled();
    expect(readGeneratedArtifactPreviewInvokeMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('generated-artifact-reveal')).toBeNull();
  });

  it('opens a placed managed image in the verified workbench preview instead of its placement hint', async () => {
    useConversationContextSafeMock.mockReturnValue({ workspace: '/Users/probe/wrong-conversation-workspace' });
    const placed = managedImageArtifact();
    (placed.payload as Record<string, unknown>).path = 'bilder/managed.png';

    render(<MessageGeneratedArtifact artifact={asConversationArtifact(placed) as never} />);
    await screen.findByTestId('generated-artifact-image');
    fireEvent.click(screen.getByTestId('generated-artifact-open'));

    expect(previewOpenMock).toHaveBeenCalledWith(
      expect.stringMatching(/^data:image\/png;base64,/),
      'image',
      expect.objectContaining({
        artifact_id: 'img_generated1',
        conversation_id: 'conv-1',
        file_name: 'managed.png',
      })
    );
    expect(openFileInvokeMock).not.toHaveBeenCalled();
  });

  it('downloads the verified managed preview without fetching an internal artifact handle', async () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:managed-image');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const success = vi.spyOn(Message, 'success').mockImplementation(() => () => undefined);

    render(<MessageGeneratedArtifact artifact={asConversationArtifact(managedImageArtifact()) as never} />);
    await screen.findByTestId('generated-artifact-image');
    fireEvent.click(screen.getByTestId('generated-artifact-download'));

    await waitFor(() => expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob)));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:managed-image');

    click.mockRestore();
    revokeObjectUrl.mockRestore();
    createObjectUrl.mockRestore();
    success.mockRestore();
  });

  it('downloads verified bytes before considering a placed managed image path', async () => {
    useConversationContextSafeMock.mockReturnValue({ workspace: '/Users/probe/wrong-conversation-workspace' });
    const placed = managedImageArtifact();
    (placed.payload as Record<string, unknown>).path = 'bilder/managed.png';
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:managed-placement');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const success = vi.spyOn(Message, 'success').mockImplementation(() => () => undefined);

    render(<MessageGeneratedArtifact artifact={asConversationArtifact(placed) as never} />);
    await screen.findByTestId('generated-artifact-image');
    fireEvent.click(screen.getByTestId('generated-artifact-download'));

    await waitFor(() => expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob)));
    expect(getFileMetadataInvokeMock).not.toHaveBeenCalled();
    expect(readGeneratedArtifactPreviewInvokeMock).not.toHaveBeenCalled();

    click.mockRestore();
    revokeObjectUrl.mockRestore();
    createObjectUrl.mockRestore();
    success.mockRestore();
  });
});
