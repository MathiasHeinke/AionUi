import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';

const MAX_CONVERSATION_MESSAGE_PAGE_SIZE = 200;

type FetchAllConversationMessagesOptions = {
  contentMode?: 'compact' | 'full';
};

/** Load a stable chronological transcript through AionCore's cursor API. */
export async function fetchAllConversationMessages(
  conversation_id: string,
  options: FetchAllConversationMessagesOptions = {}
): Promise<TMessage[]> {
  const pages: TMessage[][] = [];
  const seenCursors = new Set<string>();
  let before: string | undefined;

  while (true) {
    const page = await ipcBridge.database.getConversationMessages.invoke({
      conversation_id,
      limit: MAX_CONVERSATION_MESSAGE_PAGE_SIZE,
      ...(before ? { before } : {}),
      ...(options.contentMode ? { content_mode: options.contentMode } : {}),
    });
    pages.unshift(page.items);

    if (!page.has_more_before) break;
    const nextCursor = page.oldest_cursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error(`Conversation history cursor did not advance for ${conversation_id}`);
    }
    seenCursors.add(nextCursor);
    before = nextCursor;
  }

  const seenMessageIds = new Set<string>();
  return pages.flat().filter((message) => {
    if (seenMessageIds.has(message.id)) return false;
    seenMessageIds.add(message.id);
    return true;
  });
}

export function getConversationInputHistory(messages: TMessage[], conversation_id?: string): string[] {
  if (!conversation_id) {
    return [];
  }

  const history: string[] = [];
  const seen = new Set<string>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.conversation_id !== conversation_id ||
      message.type !== 'text' ||
      message.position !== 'right' ||
      !message.content.content.trim()
    ) {
      continue;
    }

    const content = message.content.content;
    if (seen.has(content)) {
      continue;
    }

    seen.add(content);
    history.push(content);
  }

  return history;
}

export function isCaretOnFirstLine(textarea: HTMLTextAreaElement): boolean {
  const selectionStart = textarea.selectionStart ?? 0;
  return !textarea.value.slice(0, selectionStart).includes('\n');
}

export function isCaretOnLastLine(textarea: HTMLTextAreaElement): boolean {
  const selectionEnd = textarea.selectionEnd ?? textarea.value.length;
  return !textarea.value.slice(selectionEnd).includes('\n');
}
