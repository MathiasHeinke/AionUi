import type { TMessage } from '@/common/chat/chatLib';
import { readMessageContent } from '@/renderer/utils/chat/conversationExport';
import { hasThinkTags, stripThinkTags } from '@/renderer/utils/chat/thinkTagFilter';

const GREETING_ONLY_TITLE =
  /^(?:(?:hallo|hello|hi|hey|servus|moin(?:\s+moin)?|guten\s+(?:morgen|tag|abend)|good\s+(?:morning|afternoon|evening)|gr(?:ü|ue)(?:ß|ss)(?:\s+dich|\s+euch)?)(?:\s*[,!?.…–—-]\s*)?)+(?:ich\s+bin\s+da|da\s+bin\s+ich|i\s+am\s+here|here\s+i\s+am|wie\s+geht(?:'|’)?s(?:\s+dir)?)?[\s,!?.…–—-]*$/iu;

/**
 * True for the low-information greetings that must never become the durable
 * identity of a conversation. Exported so the hook can heal titles written by
 * older builds ("Hallo.", "Moin", …) once a substantive user turn arrives.
 */
export const isGreetingOnlyAutoTitle = (value: string): boolean => GREETING_ONLY_TITLE.test(value.trim());

const normalizeTitleLine = (line: string): string =>
  line
    .replace(/^[#>*\-\d.\s]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);

export const buildAutoTitleFromContent = (content: string): string | null => {
  const withoutThinkTags = hasThinkTags(content) ? stripThinkTags(content) : content;
  const lines = withoutThinkTags
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== '```');

  for (const line of lines) {
    const normalized = normalizeTitleLine(line);
    if (normalized && !isGreetingOnlyAutoTitle(normalized)) return normalized;
  }

  return null;
};

/**
 * Pick the first substantive user prompt from conversation history.
 * Falls back to the current send-box content when history has no user prompt yet.
 * Greeting-only turns are intentionally skipped: a later real task should name
 * the conversation, not leave a sidebar full of indistinguishable "Hallo." rows.
 */
export const deriveAutoTitleFromMessages = (messages: TMessage[], fallbackContent?: string): string | null => {
  for (const message of messages) {
    if (message.type !== 'text' || message.position !== 'right') {
      continue;
    }

    const title = buildAutoTitleFromContent(readMessageContent(message));
    if (title) {
      return title;
    }
  }

  if (fallbackContent) {
    return buildAutoTitleFromContent(fallbackContent);
  }

  return null;
};
