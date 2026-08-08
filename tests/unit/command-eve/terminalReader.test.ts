import { describe, expect, it } from 'vitest';
import type { Terminal as XtermTerminal } from '@xterm/xterm';

import {
  COMMAND_EVE_READ_TERMINAL_VERSION,
  TERMINAL_READ_MAX_CHARS,
  TERMINAL_READ_MAX_RESPONSE_BYTES,
  createCommandEveReadTerminalResponse,
  parseCommandEveReadTerminalRequest,
  readActiveConversationTerminal,
  readXtermBuffer,
  registerConversationTerminalReader,
} from '@/renderer/pages/conversation/Preview/services/terminalReader';

const fakeTerminal = (
  lines: string[],
  rows = 3,
  cursorRow = lines.length - 1,
  viewportY = Math.max(0, lines.length - rows)
): XtermTerminal =>
  ({
    rows,
    buffer: {
      active: {
        length: lines.length,
        viewportY,
        baseY: Math.max(0, cursorRow - 1),
        cursorY: Math.min(1, cursorRow),
        getLine: (index: number) => ({ translateToString: () => lines[index] ?? '' }),
      },
    },
  }) as unknown as XtermTerminal;

describe('Command EVE terminal reader', () => {
  it('parses only the current ACP session and bounded line windows', () => {
    expect(
      parseCommandEveReadTerminalRequest(
        {
          version: COMMAND_EVE_READ_TERMINAL_VERSION,
          request_id: 'request-1',
          session_id: 'session-1',
          start: 4,
          count: 20,
        },
        'session-1'
      )
    ).toMatchObject({ start: 4, count: 20 });
    expect(
      parseCommandEveReadTerminalRequest(
        { version: COMMAND_EVE_READ_TERMINAL_VERSION, request_id: 'request-1', session_id: 'foreign' },
        'session-1'
      )
    ).toBeNull();
    expect(
      parseCommandEveReadTerminalRequest(
        {
          version: COMMAND_EVE_READ_TERMINAL_VERSION,
          request_id: 'request-1',
          session_id: 'session-1',
          count: 24001,
        },
        'session-1'
      )
    ).toBeNull();
  });

  it('reads the requested plain-text xterm line window with cursor metadata', () => {
    const terminal = fakeTerminal(['zero', 'one', 'two', 'three', 'four'], 3, 4);
    expect(readXtermBuffer(terminal, { start: 1, count: 3 })).toEqual({
      total_lines: 5,
      start: 1,
      end: 4,
      viewport_rows: 3,
      cursor_row: 4,
      text: 'one\ntwo\nthree',
    });
    expect(readXtermBuffer(terminal)).toMatchObject({ start: 2, end: 5, text: 'two\nthree\nfour' });
  });

  it('reads the screen the user is visibly scrolled to instead of the unseen tail', () => {
    const terminal = fakeTerminal(['zero', 'one', 'two', 'three', 'four'], 2, 4, 1);
    expect(readXtermBuffer(terminal)).toMatchObject({ start: 1, end: 3, text: 'one\ntwo' });
  });

  it('returns only the active terminal owned by the requesting conversation', () => {
    const unregister = registerConversationTerminalReader('conv-1', 'terminal-1', () => ({
      total_lines: 1,
      start: 0,
      end: 1,
      viewport_rows: 1,
      cursor_row: 0,
      text: 'ready',
    }));
    expect(
      readActiveConversationTerminal({
        activeTabId: 'terminal-1',
        conversationId: 'conv-1',
        isOpen: true,
      })
    ).toMatchObject({ text: 'ready' });
    expect(
      readActiveConversationTerminal({
        activeTabId: 'terminal-1',
        conversationId: 'conv-2',
        isOpen: true,
      })
    ).toBeNull();
    unregister();
  });

  it('trims whole lines until the strict ACP response envelope fits', () => {
    const request = {
      version: COMMAND_EVE_READ_TERMINAL_VERSION,
      request_id: 'request-1',
      session_id: 'session-1',
    } as const;
    const text = Array.from({ length: 2000 }, (_, index) => `${index}:${'ü'.repeat(40)}`).join('\n');
    const response = createCommandEveReadTerminalResponse(request, {
      total_lines: 2000,
      start: 0,
      end: 2000,
      viewport_rows: 40,
      cursor_row: 1999,
      text,
    });
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(
      TERMINAL_READ_MAX_RESPONSE_BYTES
    );
    expect(response.result?.end).toBeLessThan(2000);
    expect(response.result?.text.split('\n')).toHaveLength(response.result?.end ?? 0);
    expect(response.result?.text.split('\n')).toEqual(text.split('\n').slice(0, response.result?.end ?? 0));
  });

  it('also enforces the AionCore 24k-character contract for one very long line', () => {
    const request = {
      version: COMMAND_EVE_READ_TERMINAL_VERSION,
      request_id: 'request-long-line',
      session_id: 'session-1',
    } as const;
    const response = createCommandEveReadTerminalResponse(request, {
      total_lines: 1,
      start: 0,
      end: 1,
      viewport_rows: 1,
      cursor_row: 0,
      text: '🙂'.repeat(TERMINAL_READ_MAX_CHARS),
    });
    expect(response.result?.text.length ?? 0).toBeLessThanOrEqual(TERMINAL_READ_MAX_CHARS);
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(
      TERMINAL_READ_MAX_RESPONSE_BYTES
    );
    expect(response.result?.end).toBe(1);
    expect(response.result?.text).toMatch(/ …\[terminal row truncated\]$/);
  });
});
