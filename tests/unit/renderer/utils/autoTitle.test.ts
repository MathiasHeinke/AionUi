/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AUTO_TITLE_CLOUD_TEXT_MAX_CHARS,
  buildAutoTitleExchangeText,
  buildAutoTitleFromContent,
  deriveAutoTitleExchangeFromMessages,
  deriveAutoTitleFromMessages,
  prepareCloudAutoTitleText,
} from '@/renderer/utils/chat/autoTitle';
import type { TMessage } from '@/common/chat/chatLib';

vi.mock('@/renderer/utils/chat/thinkTagFilter', () => ({
  hasThinkTags: (content: string) => content.includes('<think>'),
  stripThinkTags: (content: string) => content.replace(/<think>.*?<\/think>/g, ''),
}));

vi.mock('@/renderer/utils/chat/conversationExport', () => ({
  readMessageContent: (message: TMessage) => message.content || '',
}));

describe('autoTitle', () => {
  describe('buildAutoTitleFromContent', () => {
    it('returns first line of content', () => {
      const content = 'First line\nSecond line';
      expect(buildAutoTitleFromContent(content)).toBe('First line');
    });

    it('strips heading markdown', () => {
      expect(buildAutoTitleFromContent('## Heading')).toBe('Heading');
      expect(buildAutoTitleFromContent('# Title')).toBe('Title');
      expect(buildAutoTitleFromContent('### Another')).toBe('Another');
    });

    it('strips list markers', () => {
      expect(buildAutoTitleFromContent('* List item')).toBe('List item');
      expect(buildAutoTitleFromContent('- Dash item')).toBe('Dash item');
      expect(buildAutoTitleFromContent('1. Numbered item')).toBe('Numbered item');
    });

    it('strips blockquote markers', () => {
      expect(buildAutoTitleFromContent('> Quote')).toBe('Quote');
    });

    it('truncates to 50 characters', () => {
      const longText = 'a'.repeat(100);
      const result = buildAutoTitleFromContent(longText);
      expect(result).toHaveLength(50);
    });

    it('normalizes multiple spaces', () => {
      expect(buildAutoTitleFromContent('Text   with    spaces')).toBe('Text with spaces');
    });

    it('removes empty lines and code fence markers', () => {
      const content = '```\n\nFirst line\nSecond line';
      expect(buildAutoTitleFromContent(content)).toBe('First line');
    });

    it('handles CRLF line endings', () => {
      const content = 'First line\r\nSecond line';
      expect(buildAutoTitleFromContent(content)).toBe('First line');
    });

    it('strips think tags before processing', () => {
      const content = '<think>thinking</think>Main content';
      expect(buildAutoTitleFromContent(content)).toBe('Main content');
    });

    it('returns null for empty content', () => {
      expect(buildAutoTitleFromContent('')).toBeNull();
      expect(buildAutoTitleFromContent('   ')).toBeNull();
    });

    it('returns null for content with only markers', () => {
      expect(buildAutoTitleFromContent('```\n\n')).toBeNull();
      expect(buildAutoTitleFromContent('##')).toBeNull();
    });

    it('handles mixed whitespace', () => {
      expect(buildAutoTitleFromContent('  \n  First line  ')).toBe('First line');
    });

    it('handles content with only newlines', () => {
      expect(buildAutoTitleFromContent('\n\n\n')).toBeNull();
    });
  });

  describe('deriveAutoTitleFromMessages', () => {
    const mockUserMessage = (content: string): TMessage =>
      ({
        id: 'msg-1',
        type: 'text',
        position: 'right',
        content,
      }) as TMessage;

    const mockAssistantMessage = (content: string): TMessage =>
      ({
        id: 'msg-2',
        type: 'text',
        position: 'left',
        content,
      }) as TMessage;

    it('returns title from first user message', () => {
      const messages = [mockUserMessage('User question')];
      expect(deriveAutoTitleFromMessages(messages)).toBe('User question');
    });

    it('skips assistant messages', () => {
      const messages = [mockAssistantMessage('Assistant response'), mockUserMessage('User question')];
      expect(deriveAutoTitleFromMessages(messages)).toBe('User question');
    });

    it('returns fallback content when no user messages', () => {
      const messages = [mockAssistantMessage('Assistant response')];
      expect(deriveAutoTitleFromMessages(messages, 'Fallback title')).toBe('Fallback title');
    });

    it('returns null when no user messages and no fallback', () => {
      const messages = [mockAssistantMessage('Assistant response')];
      expect(deriveAutoTitleFromMessages(messages)).toBeNull();
    });

    it('skips empty user messages', () => {
      const messages = [mockUserMessage(''), mockUserMessage('Second message')];
      expect(deriveAutoTitleFromMessages(messages)).toBe('Second message');
    });

    it('handles empty message list with fallback', () => {
      expect(deriveAutoTitleFromMessages([], 'Fallback')).toBe('Fallback');
    });

    it('handles empty message list without fallback', () => {
      expect(deriveAutoTitleFromMessages([])).toBeNull();
    });

    it('processes markdown in user messages', () => {
      const messages = [mockUserMessage('## Title')];
      expect(deriveAutoTitleFromMessages(messages)).toBe('Title');
    });
  });

  describe('buildAutoTitleExchangeText', () => {
    it('builds the user/EVE exchange context for model title generation', () => {
      expect(buildAutoTitleExchangeText('  Build a funnel  ', '  I will draft the plan.  ')).toBe(
        'User: Build a funnel\nEVE: I will draft the plan.'
      );
    });

    it('strips think tags from exchange content', () => {
      expect(buildAutoTitleExchangeText('Task', '<think>hidden</think>Real answer')).toBe(
        'User: Task\nEVE: Real answer'
      );
    });

    it('returns null until both sides exist', () => {
      expect(buildAutoTitleExchangeText('Task', '')).toBeNull();
      expect(buildAutoTitleExchangeText('', 'Answer')).toBeNull();
    });

    it('redacts and caps the cloud title payload before egress', () => {
      const raw = buildAutoTitleExchangeText(
        'api_key=sk-test-1234567890 und ' + 'x'.repeat(1200),
        'Ich plane den naechsten Schritt.'
      );
      expect(raw).toBeTruthy();

      const prepared = prepareCloudAutoTitleText(raw!);
      expect(prepared).toContain('[REDACTED_SECRET_ASSIGNMENT]');
      expect(prepared).not.toContain('sk-test-1234567890');
      expect(prepared!.length).toBeLessThanOrEqual(AUTO_TITLE_CLOUD_TEXT_MAX_CHARS);
    });
  });

  describe('deriveAutoTitleExchangeFromMessages', () => {
    const mockUserMessage = (content: string, id = 'msg-user'): TMessage =>
      ({
        id,
        type: 'text',
        position: 'right',
        content,
      }) as TMessage;

    const mockAssistantMessage = (content: string, id = 'msg-assistant'): TMessage =>
      ({
        id,
        type: 'text',
        position: 'left',
        content,
      }) as TMessage;

    it('returns the first complete user to assistant exchange', () => {
      const exchange = deriveAutoTitleExchangeFromMessages([
        mockUserMessage('First user task', 'u1'),
        mockAssistantMessage('First EVE answer', 'a1'),
        mockUserMessage('Second user task', 'u2'),
        mockAssistantMessage('Second EVE answer', 'a2'),
      ]);
      expect(exchange?.text).toBe('User: First user task\nEVE: First EVE answer');
    });

    it('returns null while the first assistant answer is missing', () => {
      expect(deriveAutoTitleExchangeFromMessages([mockUserMessage('First user task')])).toBeNull();
    });

    it('does not pair an assistant message that appeared before the first user message', () => {
      expect(
        deriveAutoTitleExchangeFromMessages([mockAssistantMessage('Old assistant'), mockUserMessage('First user task')])
      ).toBeNull();
    });

    it('uses fallback content as the user side when history has only the assistant response', () => {
      const exchange = deriveAutoTitleExchangeFromMessages(
        [mockAssistantMessage('First EVE answer')],
        'Fresh user task'
      );
      expect(exchange?.text).toBe('User: Fresh user task\nEVE: First EVE answer');
    });
  });
});
