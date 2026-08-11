import type { TMessage } from '@/common/chat/chatLib';
import { useVoiceDialogue } from '@/renderer/components/chat/voiceDialogue/useVoiceDialogue';
import { VOICE_DIALOGUE_PREFERENCE_KEY } from '@/renderer/components/chat/voiceDialogue/useVoiceDialoguePreference';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readAloudTextMock, stopReadAloudMock } = vi.hoisted(() => ({
  readAloudTextMock: vi.fn(),
  stopReadAloudMock: vi.fn(),
}));

vi.mock('@/renderer/services/ReadAloudService', () => ({
  readAloudText: readAloudTextMock,
  stopReadAloud: stopReadAloudMock,
}));

const textMessage = (id: string, position: 'left' | 'right', content: string): TMessage => ({
  id,
  msg_id: id,
  conversation_id: 'conv-1',
  type: 'text',
  position,
  content: { content },
});

type HookInput = Parameters<typeof useVoiceDialogue>[0];

describe('useVoiceDialogue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.localStorage.setItem(VOICE_DIALOGUE_PREFERENCE_KEY, 'true');
    readAloudTextMock.mockImplementation(async (_text: string, options?: { onStart?: () => void }) => {
      options?.onStart?.();
      return true;
    });
  });

  it('never speaks conversation history merely because the view mounted', () => {
    const initial: HookInput = {
      activeTurnId: null,
      available: true,
      completion: { sequence: 4, turnId: 'old-turn', completedAt: 100 },
      conversationId: 'conv-1',
      isTurnActive: false,
      language: 'de-DE',
      messages: [textMessage('assistant-old', 'left', 'Historie')],
      speechStatus: 'idle',
      turnErrored: false,
    };

    renderHook(() => useVoiceDialogue(initial));
    expect(readAloudTextMock).not.toHaveBeenCalled();
  });

  it('arms a start-chat turn that is already active when the conversation view mounts', async () => {
    const history = [textMessage('assistant-old', 'left', 'Historie')];
    let input: HookInput = {
      activeTurnId: 'turn-start',
      available: true,
      completion: null,
      conversationId: 'conv-1',
      isTurnActive: true,
      messages: history,
      speechStatus: 'idle',
      turnErrored: false,
    };
    const { rerender } = renderHook(() => useVoiceDialogue(input));

    input = {
      ...input,
      completion: { sequence: 1, turnId: 'turn-start', completedAt: 200 },
      isTurnActive: false,
      messages: [...history, textMessage('assistant-start', 'left', 'Antwort aus dem Start-Chat')],
    };
    rerender();

    await waitFor(() => expect(readAloudTextMock).toHaveBeenCalledTimes(1));
    expect(readAloudTextMock.mock.calls[0]?.[0]).toBe('Antwort aus dem Start-Chat');
  });

  it('speaks one newly completed reply through the local-only German lane', async () => {
    const history = [textMessage('assistant-old', 'left', 'Historie')];
    let input: HookInput = {
      activeTurnId: null,
      available: true,
      completion: null,
      conversationId: 'conv-1',
      isTurnActive: false,
      language: 'de',
      messages: history,
      speechStatus: 'idle',
      turnErrored: false,
    };
    const { rerender } = renderHook(() => useVoiceDialogue(input));

    input = { ...input, activeTurnId: 'turn-1', isTurnActive: true };
    rerender();
    input = {
      ...input,
      completion: { sequence: 1, turnId: 'turn-1', completedAt: 200 },
      isTurnActive: false,
      messages: [...history, textMessage('assistant-new', 'left', 'Guten Tag')],
    };
    rerender();

    await waitFor(() => expect(readAloudTextMock).toHaveBeenCalledTimes(1));
    expect(readAloudTextMock).toHaveBeenCalledWith(
      'Guten Tag',
      expect.objectContaining({ lang: 'de-DE', preferCloud: false })
    );
  });

  it('cancels playback and asks the caller to stop an active ACP turn before recording', () => {
    const input: HookInput = {
      activeTurnId: 'turn-1',
      available: true,
      completion: null,
      conversationId: 'conv-1',
      isTurnActive: true,
      messages: [],
      speechStatus: 'idle',
      turnErrored: false,
    };
    const { result } = renderHook(() => useVoiceDialogue(input));

    let shouldStop = false;
    act(() => {
      shouldStop = result.current.beforeStartRecording();
    });

    expect(shouldStop).toBe(true);
    expect(stopReadAloudMock).toHaveBeenCalled();
  });

  it('stops any previous reply when a new voice turn becomes active', () => {
    let input: HookInput = {
      activeTurnId: null,
      available: true,
      completion: null,
      conversationId: 'conv-1',
      isTurnActive: false,
      messages: [],
      speechStatus: 'idle',
      turnErrored: false,
    };
    const { rerender } = renderHook(() => useVoiceDialogue(input));

    input = { ...input, activeTurnId: 'turn-1', isTurnActive: true };
    rerender();

    expect(stopReadAloudMock).toHaveBeenCalledTimes(1);
  });

  it('stops hook-owned playback when the conversation view unmounts', async () => {
    const history = [textMessage('assistant-old', 'left', 'Historie')];
    let input: HookInput = {
      activeTurnId: null,
      available: true,
      completion: null,
      conversationId: 'conv-1',
      isTurnActive: false,
      messages: history,
      speechStatus: 'idle',
      turnErrored: false,
    };
    const { rerender, unmount } = renderHook(() => useVoiceDialogue(input));
    input = { ...input, activeTurnId: 'turn-1', isTurnActive: true };
    rerender();
    input = {
      ...input,
      completion: { sequence: 1, turnId: 'turn-1', completedAt: 200 },
      isTurnActive: false,
      messages: [...history, textMessage('assistant-new', 'left', 'Neue Antwort')],
    };
    rerender();
    await waitFor(() => expect(readAloudTextMock).toHaveBeenCalledTimes(1));
    const stopCallsBeforeUnmount = stopReadAloudMock.mock.calls.length;

    unmount();

    expect(stopReadAloudMock).toHaveBeenCalledTimes(stopCallsBeforeUnmount + 1);
  });

  it('scopes completion sequencing to the current conversation', async () => {
    let input: HookInput = {
      activeTurnId: null,
      available: true,
      completion: null,
      conversationId: 'conv-1',
      isTurnActive: false,
      messages: [],
      speechStatus: 'idle',
      turnErrored: false,
    };
    const { rerender } = renderHook(() => useVoiceDialogue(input));
    input = { ...input, activeTurnId: 'turn-5', isTurnActive: true };
    rerender();
    input = {
      ...input,
      completion: { sequence: 5, turnId: 'turn-5', completedAt: 500 },
      isTurnActive: false,
      messages: [textMessage('assistant-5', 'left', 'Antwort eins')],
    };
    rerender();
    await waitFor(() => expect(readAloudTextMock).toHaveBeenCalledTimes(1));

    input = {
      ...input,
      activeTurnId: null,
      completion: null,
      conversationId: 'conv-2',
      isTurnActive: false,
      messages: [],
    };
    rerender();
    input = { ...input, activeTurnId: 'turn-1', isTurnActive: true };
    rerender();
    input = {
      ...input,
      completion: { sequence: 1, turnId: 'turn-1', completedAt: 600 },
      isTurnActive: false,
      messages: [
        {
          ...textMessage('assistant-1', 'left', 'Antwort zwei'),
          conversation_id: 'conv-2',
        },
      ],
    };
    rerender();

    await waitFor(() => expect(readAloudTextMock).toHaveBeenCalledTimes(2));
    expect(readAloudTextMock.mock.calls[1]?.[0]).toBe('Antwort zwei');
  });

  it('waits for the accepted turn id and ignores an unmatched terminal receipt', async () => {
    let input: HookInput = {
      activeTurnId: null,
      available: true,
      completion: null,
      conversationId: 'conv-1',
      isTurnActive: false,
      messages: [],
      speechStatus: 'idle',
      turnErrored: false,
    };
    const { rerender } = renderHook(() => useVoiceDialogue(input));

    input = { ...input, isTurnActive: true };
    rerender();
    input = {
      ...input,
      completion: { sequence: 1, turnId: 'late-turn-a', completedAt: 100 },
      messages: [textMessage('assistant-b', 'left', 'Antwort B im Aufbau')],
    };
    rerender();
    expect(readAloudTextMock).not.toHaveBeenCalled();

    input = { ...input, activeTurnId: 'turn-b' };
    rerender();
    input = {
      ...input,
      completion: { sequence: 2, turnId: 'turn-b', completedAt: 200 },
      isTurnActive: false,
      messages: [textMessage('assistant-b', 'left', 'Antwort B vollständig')],
    };
    rerender();

    await waitFor(() => expect(readAloudTextMock).toHaveBeenCalledTimes(1));
    expect(readAloudTextMock.mock.calls[0]?.[0]).toBe('Antwort B vollständig');
  });

  it('ignores terminal callbacks from playback canceled by a newer turn', async () => {
    const callbacks: Array<{ onEnd?: () => void; onStart?: () => void }> = [];
    readAloudTextMock.mockImplementation(
      async (_text: string, options?: { onEnd?: () => void; onStart?: () => void }) => {
        callbacks.push(options ?? {});
        options?.onStart?.();
        return true;
      }
    );
    let input: HookInput = {
      activeTurnId: null,
      available: true,
      completion: null,
      conversationId: 'conv-1',
      isTurnActive: false,
      messages: [],
      speechStatus: 'idle',
      turnErrored: false,
    };
    const { rerender, result } = renderHook(() => useVoiceDialogue(input));

    input = { ...input, activeTurnId: 'turn-a', isTurnActive: true };
    rerender();
    input = {
      ...input,
      completion: { sequence: 1, turnId: 'turn-a', completedAt: 100 },
      isTurnActive: false,
      messages: [textMessage('assistant-a', 'left', 'Antwort A')],
    };
    rerender();
    await waitFor(() => expect(readAloudTextMock).toHaveBeenCalledTimes(1));

    input = { ...input, activeTurnId: 'turn-b', isTurnActive: true };
    rerender();
    input = {
      ...input,
      completion: { sequence: 2, turnId: 'turn-b', completedAt: 200 },
      isTurnActive: false,
      messages: [textMessage('assistant-a', 'left', 'Antwort A'), textMessage('assistant-b', 'left', 'Antwort B')],
    };
    rerender();
    await waitFor(() => expect(readAloudTextMock).toHaveBeenCalledTimes(2));
    expect(result.current.phase).toBe('speaking');

    act(() => callbacks[0]?.onEnd?.());

    expect(result.current.phase).toBe('speaking');
  });
});
