/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAcpInitialMessage } from '@/renderer/pages/conversation/platforms/acp/useAcpInitialMessage';
import { DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION } from '@/common/config/composerWorkProductModeCore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('useAcpInitialMessage', () => {
  const seatId = 'seat-1';
  const storageKey = `acp_initial_message_${seatId}_conversation-1`;
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
      storageKey,
      JSON.stringify({
        input: 'Read this PDF',
        files: ['/tmp/source.pdf', 42, null],
      })
    );

    const { rerender } = renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conversation-1',
        seatId,
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
    expect(sendInitialMessage).toHaveBeenCalledWith(
      'Read this PDF',
      ['/tmp/source.pdf'],
      undefined,
      DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION
    );
    expect(sessionStorage.getItem(storageKey)).toBeNull();
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
      storageKey,
      JSON.stringify({
        input: 'Erstelle ein Video: Aubergine.',
        videoSelection: { modelId: 'google/veo-3.1', resolution: '1080p', durationSeconds: 8 },
      })
    );

    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conversation-1',
        seatId,
        sendInitialMessage,
        resetState: vi.fn(),
        addOrUpdateMessage: vi.fn(),
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendInitialMessage).toHaveBeenCalledWith(
      'Erstelle ein Video: Aubergine.',
      [],
      {
        modelId: 'google/veo-3.1',
        resolution: '1080p',
        durationSeconds: 8,
      },
      DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION
    );
  });

  it('carries the exact explicit image tier, resolution and format through the fresh-chat handoff', async () => {
    const sendInitialMessage = vi.fn().mockResolvedValue(true);
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        input: 'Erstelle ein Editorial-Motiv.',
        files: ['/tmp/reference.png'],
        composerSelection: {
          mode: 'image',
          authority: 'explicit_user_selection',
          hasSelectedReference: false,
          selectedReferenceKind: null,
          imageOptions: { tierId: 'max', resolution: '2K', aspectRatio: '1:1' },
        },
      })
    );

    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conversation-1',
        seatId,
        sendInitialMessage,
        resetState: vi.fn(),
        addOrUpdateMessage: vi.fn(),
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendInitialMessage).toHaveBeenCalledWith(
      'Erstelle ein Editorial-Motiv.',
      ['/tmp/reference.png'],
      undefined,
      expect.objectContaining({
        mode: 'image',
        imageOptions: { tierId: 'max', resolution: '2K', aspectRatio: '1:1' },
      })
    );
  });

  it('drops a malformed carried selection rather than failing the send', async () => {
    const sendInitialMessage = vi.fn().mockResolvedValue(true);
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        input: 'Erstelle ein Video: Aubergine.',
        videoSelection: { modelId: '', durationSeconds: 'acht' },
      })
    );

    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conversation-1',
        seatId,
        sendInitialMessage,
        resetState: vi.fn(),
        addOrUpdateMessage: vi.fn(),
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendInitialMessage).toHaveBeenCalledWith(
      'Erstelle ein Video: Aubergine.',
      [],
      undefined,
      DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION
    );
  });

  it('releases the fresh-chat loading state when the shared submission fails closed', async () => {
    const sendInitialMessage = vi.fn().mockResolvedValue(false);
    const resetState = vi.fn();
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        input: 'Analysiere dieses Bild.',
        files: ['/tmp/source.png'],
      })
    );

    renderHook(() =>
      useAcpInitialMessage({
        conversation_id: 'conversation-1',
        seatId,
        sendInitialMessage,
        resetState,
        addOrUpdateMessage: vi.fn(),
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendInitialMessage).toHaveBeenCalledTimes(1);
    expect(resetState).toHaveBeenCalledTimes(1);
  });
});
