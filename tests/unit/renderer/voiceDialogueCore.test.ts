import type { TMessage } from '@/common/chat/chatLib';
import {
  findLatestAssistantMessageId,
  resolveVoiceDialogueLanguage,
  resolveVoiceDialoguePhase,
  selectAssistantReplyAfter,
} from '@/renderer/components/chat/voiceDialogue/voiceDialogueCore';
import { describe, expect, it } from 'vitest';

const textMessage = (id: string, position: 'left' | 'right', content: string): TMessage => ({
  id,
  msg_id: id,
  conversation_id: 'conv-1',
  type: 'text',
  position,
  content: { content },
});

describe('voiceDialogueCore', () => {
  it('reports the operator-visible phase without claiming passive listening', () => {
    expect(resolveVoiceDialoguePhase({ enabled: false, speechStatus: 'recording', turnActive: true })).toBe('off');
    expect(resolveVoiceDialoguePhase({ enabled: true, speechStatus: 'idle' })).toBe('ready');
    expect(resolveVoiceDialoguePhase({ enabled: true, speechStatus: 'recording' })).toBe('listening');
    expect(resolveVoiceDialoguePhase({ enabled: true, speechStatus: 'transcribing' })).toBe('transcribing');
    expect(resolveVoiceDialoguePhase({ enabled: true, speechStatus: 'idle', turnActive: true })).toBe('thinking');
    expect(
      resolveVoiceDialoguePhase({ enabled: true, speechStatus: 'idle', playbackState: 'speaking', turnActive: false })
    ).toBe('speaking');
    expect(resolveVoiceDialoguePhase({ enabled: true, speechStatus: 'error' })).toBe('error');
  });

  it('uses German as the safe TTS default while respecting explicit app languages', () => {
    expect(resolveVoiceDialogueLanguage()).toBe('de-DE');
    expect(resolveVoiceDialogueLanguage('auto')).toBe('de-DE');
    expect(resolveVoiceDialogueLanguage('de')).toBe('de-DE');
    expect(resolveVoiceDialogueLanguage('en-GB')).toBe('en-US');
    expect(resolveVoiceDialogueLanguage('fr-FR')).toBe('fr-FR');
  });

  it('selects only a new assistant reply after the armed baseline', () => {
    const messages = [
      textMessage('user-1', 'right', 'Hallo'),
      textMessage('assistant-old', 'left', 'Historie'),
      textMessage('user-2', 'right', 'Neue Frage'),
      textMessage('assistant-new', 'left', '<think>privat</think>Neue Antwort'),
    ];

    expect(findLatestAssistantMessageId(messages.slice(0, 2))).toBe('assistant-old');
    expect(selectAssistantReplyAfter(messages, 'assistant-old')).toEqual({
      id: 'assistant-new',
      text: 'Neue Antwort',
    });
  });

  it('fails closed when hydration removed the recorded baseline', () => {
    expect(
      selectAssistantReplyAfter([textMessage('assistant-old', 'left', 'Historie')], 'missing-baseline')
    ).toBeNull();
  });
});
