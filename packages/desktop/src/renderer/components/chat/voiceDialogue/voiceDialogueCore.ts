import type { TMessage } from '@/common/chat/chatLib';
import { stripThinkTags } from '@/renderer/utils/chat/thinkTagFilter';

export type VoiceDialoguePhase = 'off' | 'ready' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';

export type VoiceDialoguePlaybackState = 'idle' | 'speaking' | 'error';

type VoiceDialogueSpeechStatus = 'idle' | 'recording' | 'transcribing' | 'error';

export function resolveVoiceDialoguePhase(input: {
  enabled: boolean;
  speechStatus: VoiceDialogueSpeechStatus;
  turnActive?: boolean;
  playbackState?: VoiceDialoguePlaybackState;
}): VoiceDialoguePhase {
  if (!input.enabled) return 'off';
  if (input.speechStatus === 'recording') return 'listening';
  if (input.speechStatus === 'transcribing') return 'transcribing';
  if (input.speechStatus === 'error' || input.playbackState === 'error') return 'error';
  if (input.playbackState === 'speaking') return 'speaking';
  if (input.turnActive) return 'thinking';
  return 'ready';
}

export function resolveVoiceDialogueLanguage(locale?: string): string {
  const normalized = locale?.trim();
  if (!normalized || normalized.toLowerCase() === 'auto') return 'de-DE';
  if (/^de(?:-|$)/i.test(normalized)) return 'de-DE';
  if (/^en(?:-|$)/i.test(normalized)) return 'en-US';
  return normalized;
}

const sanitizeVoiceReply = (content: string): string =>
  stripThinkTags(content)
    .replace(/\[SKILL_SUGGEST\][\s\S]*?\[\/SKILL_SUGGEST\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const isAssistantText = (message: TMessage): message is Extract<TMessage, { type: 'text' }> =>
  message.type === 'text' && message.position === 'left' && !message.hidden;

export function findLatestAssistantMessageId(messages: TMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isAssistantText(message)) return message.id;
  }
  return null;
}

/**
 * Select only an assistant text created after the voice turn was armed.
 *
 * If a previously observed baseline disappeared (for example because history
 * was replaced during hydration), fail closed instead of speaking some older
 * message. This is what prevents restart/history replays from talking on their
 * own.
 */
export function selectAssistantReplyAfter(
  messages: TMessage[],
  baselineAssistantMessageId: string | null
): { id: string; text: string } | null {
  let lowerBound = 0;
  if (baselineAssistantMessageId) {
    const baselineIndex = messages.findIndex((message) => message.id === baselineAssistantMessageId);
    if (baselineIndex < 0) return null;
    lowerBound = baselineIndex + 1;
  }

  for (let index = messages.length - 1; index >= lowerBound; index -= 1) {
    const message = messages[index];
    if (!isAssistantText(message)) continue;
    const text = sanitizeVoiceReply(message.content.content);
    if (text) return { id: message.id, text };
  }
  return null;
}
