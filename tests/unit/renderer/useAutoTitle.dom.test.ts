import { act, renderHook, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoTitle } from '@/renderer/hooks/chat/useAutoTitle';
import type { TMessage } from '@/common/chat/chatLib';

/**
 * R2 ON THE CLIENT: the auto-title lane draws NO cloud inference.
 *
 * This file used to prove the opposite. It asserted that `generateCloudTitle`
 * was invoked once per new conversation — a passing test pinning an UNMETERED
 * OpenRouter call as correct behaviour. The server lane behind it (`eve-title`)
 * verified only a licence signature, so a cancelled or revoked tenant drew it,
 * and the desktop fired it on the first exchange of EVERY new conversation.
 *
 * The lane is retired. Titles are derived locally from the already-metered
 * conversation, which is what users saw whenever the cloud call failed anyway.
 * The mocks below deliberately still EXPOSE a `generateCloudTitle` provider: if
 * the hook ever reaches for one again, the "no cloud call" test reddens instead
 * of the mock quietly throwing an unrelated TypeError.
 */

const {
  getConversationMessagesMock,
  generateCloudTitleMock,
  generateLocalTitleMock,
  conversationUpdateMock,
  getConversationOrNullMock,
  emitterEmitMock,
} = vi.hoisted(() => ({
  getConversationMessagesMock: vi.fn(),
  generateCloudTitleMock: vi.fn(),
  generateLocalTitleMock: vi.fn(),
  conversationUpdateMock: vi.fn(),
  getConversationOrNullMock: vi.fn(),
  emitterEmitMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    database: {
      getConversationMessages: {
        invoke: getConversationMessagesMock,
      },
    },
    commandEve: {
      // Present on purpose — see the header. A hook that calls it fails the gate.
      generateCloudTitle: {
        invoke: generateCloudTitleMock,
      },
      generateLocalTitle: {
        invoke: generateLocalTitleMock,
      },
    },
    conversation: {
      update: {
        invoke: conversationUpdateMock,
      },
    },
  },
}));

vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: getConversationOrNullMock,
}));

vi.mock('@/renderer/utils/emitter', () => ({
  emitter: {
    emit: emitterEmitMock,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'conversation.welcome.newConversation' ? 'New Conversation' : key),
    i18n: { language: 'de-DE' },
  }),
}));

const textMessage = (position: 'left' | 'right', content: string): TMessage =>
  ({
    id: `${position}-${content}`,
    type: 'text',
    position,
    content,
  }) as TMessage;

describe('useAutoTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConversationOrNullMock.mockResolvedValue({ id: 'conv-1', name: 'New Conversation' });
    getConversationMessagesMock.mockResolvedValue({
      items: [textMessage('right', 'Bitte plane den Launch'), textMessage('left', 'Ich erstelle einen Launchplan.')],
    });
    generateCloudTitleMock.mockResolvedValue({ data: { ok: true, title: 'Ein Cloud-Titel' } });
    generateLocalTitleMock.mockResolvedValue({ data: { ok: true, title: 'Lokaler Gemma Titel' } });
    conversationUpdateMock.mockResolvedValue(true);
  });

  it('derives the title locally from the first user message', async () => {
    const { result } = renderHook(() => useAutoTitle());

    await act(async () => {
      await result.current.checkAndUpdateTitle('conv-1', 'Bitte plane den Launch');
    });

    await waitFor(() => {
      expect(conversationUpdateMock).toHaveBeenCalledWith({
        id: 'conv-1',
        updates: { name: 'Bitte plane den Launch' },
      });
    });
    expect(emitterEmitMock).toHaveBeenCalledWith('chat.history.refresh');
  });

  it('draws NO cloud inference for a title — not the retired cloud lane, not local Gemma', async () => {
    // The load-bearing R2 assertion. Both providers are mocked and available;
    // the hook must reach for neither. Restoring the retired upgrade path turns
    // this red.
    const { result } = renderHook(() => useAutoTitle());

    await act(async () => {
      await result.current.checkAndUpdateTitle('conv-1', 'Bitte plane den Launch');
    });

    expect(generateCloudTitleMock).not.toHaveBeenCalled();
    expect(generateLocalTitleMock).not.toHaveBeenCalled();
  });

  it('does not rename a conversation the user already titled', async () => {
    getConversationOrNullMock.mockResolvedValue({ id: 'conv-2', name: 'Mein eigener Titel' });
    const { result } = renderHook(() => useAutoTitle());

    await act(async () => {
      await result.current.checkAndUpdateTitle('conv-2', 'Bitte plane den Launch');
    });

    expect(conversationUpdateMock).not.toHaveBeenCalled();
    expect(generateCloudTitleMock).not.toHaveBeenCalled();
  });

  it('leaves the conversation alone when history yields no usable title', async () => {
    getConversationMessagesMock.mockResolvedValue({ items: [] });
    const { result } = renderHook(() => useAutoTitle());

    await act(async () => {
      await result.current.checkAndUpdateTitle('conv-3', '');
    });

    expect(conversationUpdateMock).not.toHaveBeenCalled();
  });

  it('the hook source contains no cloud-title call site at all', () => {
    // Behavioural absence proves the current code path. This proves the SHAPE:
    // a future edit cannot reintroduce the call behind a condition these mocks
    // happen not to trigger.
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/renderer/hooks/chat/useAutoTitle.ts'),
      'utf-8'
    );
    expect(source).not.toContain('generateCloudTitle');
    expect(source).not.toContain('generateLocalTitle');
    expect(source).not.toContain('prepareCloudAutoTitleText');
    // Anti-vacuity: the file must actually be the hook we think it is.
    expect(source).toContain('deriveAutoTitleFromMessages');
  });
});
