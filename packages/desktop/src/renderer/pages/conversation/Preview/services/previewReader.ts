import type { PreviewTab } from '../context/PreviewContext';

export type PreviewReadOptions = {
  count?: number;
  start?: number;
};

export type PreviewReadResult = {
  end: number;
  kind: string;
  note?: string;
  path?: string;
  start: number;
  text: string;
  title: string;
  total_chars: number;
  url: string;
};

export const COMMAND_EVE_READ_PREVIEW_VERSION = 'command-eve-read-preview/v1' as const;

export type CommandEveReadPreviewRequest = {
  version: typeof COMMAND_EVE_READ_PREVIEW_VERSION;
  request_id: string;
  session_id: string;
  count?: number;
  start?: number;
};

export type CommandEveReadPreviewResponse = {
  version: typeof COMMAND_EVE_READ_PREVIEW_VERSION;
  request_id: string;
  session_id: string;
  result: PreviewReadResult | null;
};

type PreviewPage = {
  text: string;
  title: string;
  url: string;
};

type PreviewPageReader = () => Promise<PreviewPage>;

/**
 * One bounded read must not be able to flood the active model context. This
 * deliberately matches the post-0.20 Hermes `read_preview` contract so the
 * ACP adapter can be replaced by upstream once the next release carries it.
 */
export const PREVIEW_READ_MAX_CHARS = 24_000;
export const PREVIEW_READ_MAX_RESPONSE_BYTES = 32 * 1024;

const REQUEST_KEYS = new Set(['version', 'request_id', 'session_id', 'start', 'count']);

export function parseCommandEveReadPreviewRequest(
  value: unknown,
  expectedSessionId: string | undefined
): CommandEveReadPreviewRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !expectedSessionId) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !REQUEST_KEYS.has(key))) return null;
  if (candidate.version !== COMMAND_EVE_READ_PREVIEW_VERSION) return null;
  if (candidate.session_id !== expectedSessionId) return null;
  if (typeof candidate.request_id !== 'string' || !candidate.request_id || candidate.request_id.length > 128) {
    return null;
  }
  const start = candidate.start;
  const count = candidate.count;
  if (start !== undefined && (!Number.isSafeInteger(start) || (start as number) < 0)) return null;
  if (
    count !== undefined &&
    (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > PREVIEW_READ_MAX_CHARS)
  ) {
    return null;
  }
  return {
    version: COMMAND_EVE_READ_PREVIEW_VERSION,
    request_id: candidate.request_id,
    session_id: expectedSessionId,
    ...(start === undefined ? {} : { start: start as number }),
    ...(count === undefined ? {} : { count: count as number }),
  };
}

export function createCommandEveReadPreviewResponse(
  request: CommandEveReadPreviewRequest,
  result: PreviewReadResult | null
): CommandEveReadPreviewResponse {
  const create = (boundedResult: PreviewReadResult | null): CommandEveReadPreviewResponse => ({
    version: COMMAND_EVE_READ_PREVIEW_VERSION,
    request_id: request.request_id,
    session_id: request.session_id,
    result: boundedResult,
  });
  let response = create(result);
  if (!result || new TextEncoder().encode(JSON.stringify(response)).byteLength <= PREVIEW_READ_MAX_RESPONSE_BYTES) {
    return response;
  }

  // The official contract caps visible text by character window, while the
  // ACP transport also has a smaller byte envelope. Unicode pages can hit the
  // byte cap before 24k characters, so retain the largest prefix that fits
  // instead of turning a valid page into a failed tool call.
  let low = 0;
  let high = result.text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const text = result.text.slice(0, mid);
    const candidate = create({ ...result, end: result.start + text.length, text });
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength <= PREVIEW_READ_MAX_RESPONSE_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  if (low > 0) {
    const lastCodeUnit = result.text.charCodeAt(low - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) low -= 1;
  }
  const text = result.text.slice(0, low);
  response = create({ ...result, end: result.start + text.length, text });
  return response;
}

function previewKindFor(tab: PreviewTab): 'url' | 'file' | 'artifact' {
  if (tab.content_type === 'url') return 'url';
  if (tab.metadata?.file_path || tab.metadata?.file_name) return 'file';
  return 'artifact';
}

const readers = new Map<string, PreviewPageReader>();

export function registerPreviewPageReader(tabId: string, reader: PreviewPageReader): () => void {
  readers.set(tabId, reader);
  return () => {
    if (readers.get(tabId) === reader) readers.delete(tabId);
  };
}

function windowText(
  base: Omit<PreviewReadResult, 'end' | 'start' | 'text' | 'total_chars'>,
  text: string,
  options: PreviewReadOptions
): PreviewReadResult {
  const total = text.length;
  const requestedStart = Number.isFinite(options.start) ? Math.trunc(options.start as number) : 0;
  const requestedCount = Number.isFinite(options.count) ? Math.trunc(options.count as number) : PREVIEW_READ_MAX_CHARS;
  const start = Math.max(0, Math.min(requestedStart, total));
  const count = Math.min(Math.max(1, requestedCount), PREVIEW_READ_MAX_CHARS);
  const end = Math.max(start, Math.min(start + count, total));
  return { ...base, end, start, text: text.slice(start, end), total_chars: total };
}

function identityFor(tab: PreviewTab): Omit<PreviewReadResult, 'end' | 'start' | 'text' | 'total_chars'> {
  const path = (tab.metadata?.file_path || tab.metadata?.file_name)?.slice(0, 4096);
  const url = tab.content_type === 'url' ? tab.content.slice(0, 4096) : '';
  const note =
    tab.content_type === 'url'
      ? 'The page has not finished loading — retry in a moment.'
      : path
        ? 'File preview — read the file itself with read_file.'
        : 'Generated artifact — its content is in the conversation that produced it.';
  return {
    kind: previewKindFor(tab),
    note,
    ...(path ? { path } : {}),
    title: tab.title.slice(0, 512),
    url,
  };
}

/**
 * Serialize only the preview that is visibly active for this conversation.
 * The conversation scope is part of the data boundary: an ACP request from one
 * chat must never fall back to a still-mounted browser belonging to another.
 */
export async function readActiveConversationPreview(input: {
  activeTabId: string | null;
  conversationId: string;
  isOpen: boolean;
  options?: PreviewReadOptions;
  tabs: PreviewTab[];
}): Promise<PreviewReadResult | null> {
  if (!input.isOpen || !input.activeTabId) return null;
  const tab = input.tabs.find(
    (candidate) => candidate.id === input.activeTabId && candidate.metadata?.conversation_id === input.conversationId
  );
  if (!tab) return null;

  const options = input.options ?? {};
  const reader = readers.get(tab.id);
  if (reader) {
    try {
      const page = await reader();
      return windowText(
        {
          kind: previewKindFor(tab),
          ...(tab.metadata?.file_path ? { path: tab.metadata.file_path } : {}),
          title: (page.title || tab.title).slice(0, 512),
          url: (page.url || (tab.content_type === 'url' ? tab.content : '')).slice(0, 4096),
        },
        page.text,
        options
      );
    } catch {
      // A just-mounted or navigating webview has no stable DOM yet. Return its
      // identity so the model can retry without turning a UI race into a turn
      // failure.
    }
  }

  return windowText(identityFor(tab), '', options);
}
