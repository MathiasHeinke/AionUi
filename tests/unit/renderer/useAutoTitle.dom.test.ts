import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoTitle } from '@/renderer/hooks/chat/useAutoTitle';
import type { TMessage } from '@/common/chat/chatLib';

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
    getConversationOrNullMock.mockResolvedValue({ id: 'conv-title-cloud-only', name: 'Bitte plane den Launch' });
    getConversationMessagesMock.mockResolvedValue({
      items: [textMessage('right', 'Bitte plane den Launch'), textMessage('left', 'Ich erstelle einen Launchplan.')],
    });
    generateCloudTitleMock.mockResolvedValue({ data: { ok: false, reason_code: 'TITLE_CLOUD_TIMEOUT' } });
    generateLocalTitleMock.mockResolvedValue({ data: { ok: true, title: 'Lokaler Gemma Titel' } });
    conversationUpdateMock.mockResolvedValue(true);
  });

  it('does not fall back to local Gemma when cloud title generation fails', async () => {
    const { result } = renderHook(() => useAutoTitle());

    await act(async () => {
      await result.current.checkAndUpdateTitle('conv-title-cloud-only', 'Bitte plane den Launch');
    });

    await waitFor(() => {
      expect(generateCloudTitleMock).toHaveBeenCalledTimes(1);
    });
    expect(generateLocalTitleMock).not.toHaveBeenCalled();
    expect(conversationUpdateMock).not.toHaveBeenCalled();
  });

  it('uses the AionCore cursor-page contract for cloud title exchange detection', async () => {
    generateCloudTitleMock.mockResolvedValue({ data: { ok: true, title: 'Launchplan erstellen' } });

    const { result } = renderHook(() => useAutoTitle());

    await act(async () => {
      await result.current.checkAndUpdateTitle('conv-title-query-shape', 'Bitte plane den Launch');
    });

    await waitFor(() => {
      expect(generateCloudTitleMock).toHaveBeenCalledTimes(1);
    });
    expect(getConversationMessagesMock).toHaveBeenCalledWith({
      conversation_id: 'conv-title-query-shape',
      limit: 200,
    });
    expect(conversationUpdateMock).toHaveBeenCalledWith({
      id: 'conv-title-query-shape',
      updates: { name: 'Launchplan erstellen' },
    });
  });

  it('does not overwrite a manually renamed conversation title', async () => {
    getConversationOrNullMock.mockResolvedValue({ id: 'conv-manual-title', name: 'Manueller Kundentitel' });
    generateCloudTitleMock.mockResolvedValue({ data: { ok: true, title: 'Launchplan erstellen' } });

    const { result } = renderHook(() => useAutoTitle());

    await act(async () => {
      await result.current.checkAndUpdateTitle('conv-manual-title', 'Bitte plane den Launch');
    });

    expect(generateCloudTitleMock).not.toHaveBeenCalled();
    expect(conversationUpdateMock).not.toHaveBeenCalled();
  });

  it('upgrades a default conversation after setting the heuristic baseline title', async () => {
    getConversationOrNullMock
      .mockResolvedValueOnce({ id: 'conv-default-title', name: 'New Conversation' })
      .mockResolvedValue({ id: 'conv-default-title', name: 'Bitte plane den Launch' });
    generateCloudTitleMock.mockResolvedValue({ data: { ok: true, title: 'Launchplan erstellen' } });

    const { result } = renderHook(() => useAutoTitle());

    await act(async () => {
      await result.current.checkAndUpdateTitle('conv-default-title', 'Bitte plane den Launch');
    });

    await waitFor(() => {
      expect(conversationUpdateMock).toHaveBeenCalledTimes(2);
    });
    expect(conversationUpdateMock).toHaveBeenNthCalledWith(1, {
      id: 'conv-default-title',
      updates: { name: 'Bitte plane den Launch' },
    });
    expect(conversationUpdateMock).toHaveBeenNthCalledWith(2, {
      id: 'conv-default-title',
      updates: { name: 'Launchplan erstellen' },
    });
    expect(emitterEmitMock).toHaveBeenCalledWith('chat.history.refresh');
  });
});
