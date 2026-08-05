/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAcpInitialMessage } from '@/renderer/pages/conversation/platforms/acp/useAcpInitialMessage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('useAcpInitialMessage', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('hands a stored fresh-chat request to the shared submission path exactly once', async () => {
    const sendInitialMessage = vi.fn().mockResolvedValue(true);
    const addOrUpdateMessage = vi.fn();
    const resetState = vi.fn();
    sessionStorage.setItem(
      'acp_initial_message_conversation-1',
      JSON.stringify({
        input: 'Read this PDF',
        files: ['/tmp/source.pdf', 42, null],
      })
    );

    const { rerender } = renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conversation-1',
        sendInitialMessage,
        resetState,
        addOrUpdateMessage,
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendInitialMessage).toHaveBeenCalledTimes(1);
    expect(sendInitialMessage).toHaveBeenCalledWith('Read this PDF', ['/tmp/source.pdf'], undefined);
    expect(sessionStorage.getItem('acp_initial_message_conversation-1')).toBeNull();
    expect(addOrUpdateMessage).not.toHaveBeenCalled();
    expect(resetState).not.toHaveBeenCalled();

    rerender();
    await act(async () => {
      await Promise.resolve();
    });
    expect(sendInitialMessage).toHaveBeenCalledTimes(1);
  });

  it('carries a well-formed guid video selection through to the submission path (MAT-1773 P3)', async () => {
    const sendInitialMessage = vi.fn().mockResolvedValue(true);
    sessionStorage.setItem(
      'acp_initial_message_conversation-1',
      JSON.stringify({
        input: 'Erstelle ein Video: Aubergine.',
        videoSelection: { modelId: 'google/veo-3.1', resolution: '1080p', durationSeconds: 8 },
      })
    );

    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conversation-1',
        sendInitialMessage,
        resetState: vi.fn(),
        addOrUpdateMessage: vi.fn(),
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendInitialMessage).toHaveBeenCalledWith('Erstelle ein Video: Aubergine.', [], {
      modelId: 'google/veo-3.1',
      resolution: '1080p',
      durationSeconds: 8,
    });
  });

  it('drops a malformed carried selection rather than failing the send', async () => {
    const sendInitialMessage = vi.fn().mockResolvedValue(true);
    sessionStorage.setItem(
      'acp_initial_message_conversation-1',
      JSON.stringify({
        input: 'Erstelle ein Video: Aubergine.',
        videoSelection: { modelId: '', durationSeconds: 'acht' },
      })
    );

    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conversation-1',
        sendInitialMessage,
        resetState: vi.fn(),
        addOrUpdateMessage: vi.fn(),
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendInitialMessage).toHaveBeenCalledWith('Erstelle ein Video: Aubergine.', [], undefined);
  });
});
