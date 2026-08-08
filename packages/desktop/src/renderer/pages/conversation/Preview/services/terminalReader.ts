import type { Terminal as XtermTerminal } from '@xterm/xterm';

export const COMMAND_EVE_READ_TERMINAL_VERSION = 'command-eve-read-terminal/v1' as const;
export const TERMINAL_READ_MAX_LINES = 24_000;
export const TERMINAL_READ_MAX_CHARS = 24_000;
export const TERMINAL_READ_MAX_RESPONSE_BYTES = 32 * 1024;

export type TerminalReadOptions = {
  count?: number;
  start?: number;
};

export type TerminalReadResult = {
  total_lines: number;
  start: number;
  end: number;
  viewport_rows: number;
  cursor_row: number;
  text: string;
};

export type CommandEveReadTerminalRequest = {
  version: typeof COMMAND_EVE_READ_TERMINAL_VERSION;
  request_id: string;
  session_id: string;
  count?: number;
  start?: number;
};

export type CommandEveReadTerminalResponse = {
  version: typeof COMMAND_EVE_READ_TERMINAL_VERSION;
  request_id: string;
  session_id: string;
  result: TerminalReadResult | null;
};

type TerminalReader = (options: TerminalReadOptions) => TerminalReadResult;
type RegisteredTerminalReader = { tabId: string; reader: TerminalReader };

const REQUEST_KEYS = new Set(['version', 'request_id', 'session_id', 'start', 'count']);
const readers = new Map<string, RegisteredTerminalReader>();

export function parseCommandEveReadTerminalRequest(
  value: unknown,
  expectedSessionId: string | undefined
): CommandEveReadTerminalRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !expectedSessionId) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !REQUEST_KEYS.has(key))) return null;
  if (candidate.version !== COMMAND_EVE_READ_TERMINAL_VERSION || candidate.session_id !== expectedSessionId)
    return null;
  if (typeof candidate.request_id !== 'string' || !candidate.request_id || candidate.request_id.length > 128)
    return null;
  const start = candidate.start;
  const count = candidate.count;
  if (start !== undefined && (!Number.isSafeInteger(start) || (start as number) < 0)) return null;
  if (
    count !== undefined &&
    (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > TERMINAL_READ_MAX_LINES)
  ) {
    return null;
  }
  return {
    version: COMMAND_EVE_READ_TERMINAL_VERSION,
    request_id: candidate.request_id,
    session_id: expectedSessionId,
    ...(start === undefined ? {} : { start: start as number }),
    ...(count === undefined ? {} : { count: count as number }),
  };
}

export function createCommandEveReadTerminalResponse(
  request: CommandEveReadTerminalRequest,
  result: TerminalReadResult | null
): CommandEveReadTerminalResponse {
  const response = (boundedResult: TerminalReadResult | null): CommandEveReadTerminalResponse => ({
    version: COMMAND_EVE_READ_TERMINAL_VERSION,
    request_id: request.request_id,
    session_id: request.session_id,
    result: boundedResult,
  });
  if (
    !result ||
    (result.text.length <= TERMINAL_READ_MAX_CHARS &&
      new TextEncoder().encode(JSON.stringify(response(result))).byteLength <= TERMINAL_READ_MAX_RESPONSE_BYTES)
  ) {
    return response(result);
  }

  const lines = result.text.split('\n').slice(0, Math.max(0, result.end - result.start));
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const lineCount = Math.ceil((low + high) / 2);
    const text = lines.slice(0, lineCount).join('\n');
    const candidate = response({ ...result, end: result.start + lineCount, text });
    if (
      text.length <= TERMINAL_READ_MAX_CHARS &&
      new TextEncoder().encode(JSON.stringify(candidate)).byteLength <= TERMINAL_READ_MAX_RESPONSE_BYTES
    ) {
      low = lineCount;
    } else {
      high = lineCount - 1;
    }
  }
  if (low > 0) {
    return response({ ...result, end: result.start + low, text: lines.slice(0, low).join('\n') });
  }

  // Xterm wraps normal output to the configured column width, so a single row
  // should never approach this cap. If a malformed/custom buffer still does,
  // consume exactly that row and make the data loss explicit rather than
  // silently advancing past an invisible suffix.
  const marker = ' …[terminal row truncated]';
  const firstLine = Array.from(lines[0] ?? '');
  let charLow = 0;
  let charHigh = Math.min(firstLine.length, TERMINAL_READ_MAX_CHARS - marker.length);
  while (charLow < charHigh) {
    const charCount = Math.ceil((charLow + charHigh) / 2);
    const text = `${firstLine.slice(0, charCount).join('')}${marker}`;
    const candidate = response({ ...result, end: result.start + 1, text });
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength <= TERMINAL_READ_MAX_RESPONSE_BYTES) {
      charLow = charCount;
    } else {
      charHigh = charCount - 1;
    }
  }
  return response({
    ...result,
    end: Math.min(result.end, result.start + 1),
    text: `${firstLine.slice(0, charLow).join('')}${marker}`,
  });
}

export function readXtermBuffer(terminal: XtermTerminal, options: TerminalReadOptions = {}): TerminalReadResult {
  const buffer = terminal.buffer.active;
  const totalLines = Math.min(10_000_000, Math.max(0, buffer.length));
  const viewportRows = Math.min(TERMINAL_READ_MAX_LINES, Math.max(1, terminal.rows));
  const requestedCount = Number.isSafeInteger(options.count) ? (options.count as number) : viewportRows;
  const count = Math.min(TERMINAL_READ_MAX_LINES, Math.max(1, requestedCount));
  // Hermes 0.20 defines an argument-free read as "what's currently shown".
  // xterm's viewportY is the first visible row even when the user has scrolled
  // back; using the tail here would let EVE read a different screen than the
  // one beside the chat.
  const defaultStart = Math.min(totalLines, Math.max(0, buffer.viewportY));
  const requestedStart = Number.isSafeInteger(options.start) ? (options.start as number) : defaultStart;
  const start = Math.min(totalLines, Math.max(0, requestedStart));
  const end = Math.min(totalLines, start + count);
  const lines: string[] = [];
  for (let row = start; row < end; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
  }
  return {
    total_lines: totalLines,
    start,
    end,
    viewport_rows: viewportRows,
    cursor_row: Math.min(totalLines, Math.max(0, buffer.baseY + buffer.cursorY)),
    text: lines.join('\n'),
  };
}

export function registerConversationTerminalReader(
  conversationId: string,
  tabId: string,
  reader: TerminalReader
): () => void {
  const registration = { tabId, reader };
  readers.set(conversationId, registration);
  return () => {
    if (readers.get(conversationId) === registration) readers.delete(conversationId);
  };
}

export function readActiveConversationTerminal(input: {
  activeTabId: string | null;
  conversationId: string;
  isOpen: boolean;
  options?: TerminalReadOptions;
}): TerminalReadResult | null {
  if (!input.isOpen || !input.activeTabId) return null;
  const registration = readers.get(input.conversationId);
  if (!registration || registration.tabId !== input.activeTabId) return null;
  return registration.reader(input.options ?? {});
}
