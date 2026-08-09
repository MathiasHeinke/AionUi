import { beforeEach, describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_READ_PREVIEW_VERSION,
  PREVIEW_READ_MAX_CHARS,
  PREVIEW_READ_MAX_RESPONSE_BYTES,
  createCommandEveReadPreviewResponse,
  parseCommandEveReadPreviewRequest,
  readActiveConversationPreview,
  registerPreviewPageReader,
} from '@/renderer/pages/conversation/Preview/services/previewReader';
import type { PreviewTab } from '@/renderer/pages/conversation/Preview/context/PreviewContext';

const urlTab = (id = 'browser'): PreviewTab => ({
  id,
  title: 'Browser',
  content: 'https://example.com',
  content_type: 'url',
  isDirty: false,
  originalContent: 'https://example.com',
  metadata: { conversation_id: 'conv-1', title: 'Browser' },
});

describe('Command EVE preview reader', () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it('returns the live visible page with upstream-compatible paging metadata', async () => {
    const tab = urlTab();
    cleanups.push(
      registerPreviewPageReader(tab.id, async () => ({
        text: 'abcdefghij',
        title: 'Live title',
        url: 'https://example.com/live',
      }))
    );

    await expect(
      readActiveConversationPreview({
        activeTabId: tab.id,
        conversationId: 'conv-1',
        isOpen: true,
        options: { start: 2, count: 4 },
        tabs: [tab],
      })
    ).resolves.toMatchObject({
      end: 6,
      start: 2,
      text: 'cdef',
      title: 'Live title',
      total_chars: 10,
      url: 'https://example.com/live',
    });
  });

  it('accepts only the exact versioned request for the active ACP session', () => {
    const request = parseCommandEveReadPreviewRequest(
      {
        version: COMMAND_EVE_READ_PREVIEW_VERSION,
        request_id: 'request-1',
        session_id: 'session-1',
        start: 2,
        count: 4,
      },
      'session-1'
    );
    expect(request).toEqual({
      version: COMMAND_EVE_READ_PREVIEW_VERSION,
      request_id: 'request-1',
      session_id: 'session-1',
      start: 2,
      count: 4,
    });
    expect(createCommandEveReadPreviewResponse(request!, null)).toEqual({
      version: COMMAND_EVE_READ_PREVIEW_VERSION,
      request_id: 'request-1',
      session_id: 'session-1',
      result: null,
    });
  });

  it('shrinks a Unicode page only as far as the 32 KiB ACP envelope requires', () => {
    const request = parseCommandEveReadPreviewRequest(
      {
        version: COMMAND_EVE_READ_PREVIEW_VERSION,
        request_id: 'request-unicode',
        session_id: 'session-1',
      },
      'session-1'
    )!;
    const response = createCommandEveReadPreviewResponse(request, {
      kind: 'url',
      url: 'https://example.com',
      title: 'Unicode',
      text: '€'.repeat(PREVIEW_READ_MAX_CHARS),
      start: 0,
      end: PREVIEW_READ_MAX_CHARS,
      total_chars: PREVIEW_READ_MAX_CHARS,
    });

    expect(response.result?.text.length).toBeLessThan(PREVIEW_READ_MAX_CHARS);
    expect(response.result?.end).toBe(response.result?.text.length);
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(
      PREVIEW_READ_MAX_RESPONSE_BYTES
    );
  });

  it.each([
    [{ version: COMMAND_EVE_READ_PREVIEW_VERSION, request_id: 'r', session_id: 'foreign' }],
    [{ version: 'future', request_id: 'r', session_id: 'session-1' }],
    [{ version: COMMAND_EVE_READ_PREVIEW_VERSION, request_id: 'r', session_id: 'session-1', extra: true }],
    [{ version: COMMAND_EVE_READ_PREVIEW_VERSION, request_id: 'r', session_id: 'session-1', start: -1 }],
    [
      {
        version: COMMAND_EVE_READ_PREVIEW_VERSION,
        request_id: 'r',
        session_id: 'session-1',
        count: PREVIEW_READ_MAX_CHARS + 1,
      },
    ],
  ])('rejects malformed, foreign, future, or widened requests', (candidate) => {
    expect(parseCommandEveReadPreviewRequest(candidate, 'session-1')).toBeNull();
  });

  it('caps a single model-facing read', async () => {
    const tab = urlTab();
    cleanups.push(
      registerPreviewPageReader(tab.id, async () => ({
        text: 'x'.repeat(PREVIEW_READ_MAX_CHARS + 500),
        title: '',
        url: '',
      }))
    );
    const result = await readActiveConversationPreview({
      activeTabId: tab.id,
      conversationId: 'conv-1',
      isOpen: true,
      options: { count: PREVIEW_READ_MAX_CHARS + 500 },
      tabs: [tab],
    });
    expect(result?.text).toHaveLength(PREVIEW_READ_MAX_CHARS);
    expect(result?.total_chars).toBe(PREVIEW_READ_MAX_CHARS + 500);
  });

  it('fails closed across conversations even when the foreign webview remains mounted', async () => {
    const tab = urlTab('foreign-browser');
    cleanups.push(
      registerPreviewPageReader(tab.id, async () => ({ text: 'private', title: 'Foreign', url: tab.content }))
    );
    await expect(
      readActiveConversationPreview({
        activeTabId: tab.id,
        conversationId: 'conv-2',
        isOpen: true,
        tabs: [tab],
      })
    ).resolves.toBeNull();
  });

  it('returns no page while Chat is the active workbench surface', async () => {
    const tab = urlTab();
    await expect(
      readActiveConversationPreview({
        activeTabId: tab.id,
        conversationId: 'conv-1',
        isOpen: false,
        tabs: [tab],
      })
    ).resolves.toBeNull();
  });

  it('returns an identity plus retry note while the webview is still booting', async () => {
    const tab = urlTab();
    await expect(
      readActiveConversationPreview({
        activeTabId: tab.id,
        conversationId: 'conv-1',
        isOpen: true,
        tabs: [tab],
      })
    ).resolves.toMatchObject({
      kind: 'url',
      note: expect.stringContaining('retry'),
      text: '',
      url: 'https://example.com',
    });
  });

  it('normalizes AionUI content types to the strict upstream surface kinds', async () => {
    const fileTab: PreviewTab = {
      ...urlTab('file-tab'),
      content: '# Notes',
      content_type: 'markdown',
      metadata: { conversation_id: 'conv-1', file_path: '/workspace/notes.md' },
    };
    const artifactTab: PreviewTab = {
      ...urlTab('artifact-tab'),
      content: 'generated',
      content_type: 'markdown',
      metadata: { conversation_id: 'conv-1' },
    };

    await expect(
      readActiveConversationPreview({
        activeTabId: fileTab.id,
        conversationId: 'conv-1',
        isOpen: true,
        tabs: [fileTab],
      })
    ).resolves.toMatchObject({ kind: 'file', path: '/workspace/notes.md' });
    await expect(
      readActiveConversationPreview({
        activeTabId: artifactTab.id,
        conversationId: 'conv-1',
        isOpen: true,
        tabs: [artifactTab],
      })
    ).resolves.toMatchObject({ kind: 'artifact' });
  });

  it.each(['markdown', 'html', 'code', 'diff'] as const)(
    'reads the bounded source of an active %s tab instead of returning only its identity',
    async (contentType) => {
      const tab: PreviewTab = {
        ...urlTab(`${contentType}-tab`),
        content: '0123456789',
        content_type: contentType,
        metadata: { conversation_id: 'conv-1', file_path: `/workspace/example.${contentType}` },
      };

      await expect(
        readActiveConversationPreview({
          activeTabId: tab.id,
          conversationId: 'conv-1',
          isOpen: true,
          options: { start: 3, count: 4 },
          tabs: [tab],
        })
      ).resolves.toMatchObject({
        kind: 'file',
        path: `/workspace/example.${contentType}`,
        start: 3,
        end: 7,
        text: '3456',
        total_chars: 10,
      });
    }
  );

  it('marks a truncated direct-text preview so its loaded length is never presented as the complete file', async () => {
    const tab: PreviewTab = {
      ...urlTab('truncated-code-tab'),
      content: 'loaded excerpt',
      content_type: 'code',
      metadata: {
        conversation_id: 'conv-1',
        file_path: '/workspace/large.ts',
        truncated: true,
      },
    };

    await expect(
      readActiveConversationPreview({
        activeTabId: tab.id,
        conversationId: 'conv-1',
        isOpen: true,
        tabs: [tab],
      })
    ).resolves.toMatchObject({
      note: expect.stringContaining('truncated'),
      total_chars: 'loaded excerpt'.length,
    });
  });
});
