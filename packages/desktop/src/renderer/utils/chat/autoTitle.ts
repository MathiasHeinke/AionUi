import type { TMessage } from '@/common/chat/chatLib';
import { COMMAND_EVE_CLOUD_TITLE_TEXT_MAX_CHARS, prepareCommandEveCloudTitleText } from '@/common/config/eveTitleCore';
import { readMessageContent } from '@/renderer/utils/chat/conversationExport';
import { hasThinkTags, stripThinkTags } from '@/renderer/utils/chat/thinkTagFilter';

export const AUTO_TITLE_CLOUD_TEXT_MAX_CHARS = COMMAND_EVE_CLOUD_TITLE_TEXT_MAX_CHARS;

export const buildAutoTitleFromContent = (content: string): string | null => {
  const withoutThinkTags = hasThinkTags(content) ? stripThinkTags(content) : content;
  const lines = withoutThinkTags
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== '```');

  const firstLine = lines[0] ?? '';
  const normalized = firstLine
    .replace(/^[#>*\-\d.\s]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);

  return normalized || null;
};

const normalizeExchangeContent = (content: string): string => {
  const withoutThinkTags = hasThinkTags(content) ? stripThinkTags(content) : content;
  return withoutThinkTags.replace(/\s+/g, ' ').trim();
};

export interface AutoTitleExchange {
  userText: string;
  assistantText: string;
  text: string;
}

export const buildAutoTitleExchangeText = (userText: string, assistantText: string): string | null => {
  const user = normalizeExchangeContent(userText);
  const assistant = normalizeExchangeContent(assistantText);
  if (!user || !assistant) return null;
  return [`User: ${user}`, `EVE: ${assistant}`].join('\n');
};

export const prepareCloudAutoTitleText = (exchangeText: string): string | null => {
  return prepareCommandEveCloudTitleText(exchangeText);
};

/**
 * Pick the very first user prompt from conversation history.
 * Falls back to the current send-box content when history has no user prompt yet.
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

/**
 * Pick the first complete user -> assistant exchange for model-generated titles.
 * Falls back to the current send-box content only for the user side, because the
 * assistant response may not have been flushed to history when the send starts.
 */
export const deriveAutoTitleExchangeFromMessages = (
  messages: TMessage[],
  fallbackContent?: string
): AutoTitleExchange | null => {
  let userText = '';
  let assistantAfterUser = '';
  let firstAssistantWithoutUser = '';
  let userFromHistory = false;

  for (const message of messages) {
    if (message.type !== 'text') continue;
    const content = normalizeExchangeContent(readMessageContent(message));
    if (!content) continue;

    if (message.position === 'right') {
      if (!userText) {
        userText = content;
        userFromHistory = true;
      }
      continue;
    }

    if (message.position === 'left') {
      if (userText && !assistantAfterUser) {
        assistantAfterUser = content;
        break;
      }
      if (!userText && !firstAssistantWithoutUser) {
        firstAssistantWithoutUser = content;
      }
    }
  }

  if (!userText && fallbackContent) {
    userText = normalizeExchangeContent(fallbackContent);
  }

  const assistantText = assistantAfterUser || (!userFromHistory ? firstAssistantWithoutUser : '');
  const text = buildAutoTitleExchangeText(userText, assistantText);
  return text ? { userText, assistantText, text } : null;
};
