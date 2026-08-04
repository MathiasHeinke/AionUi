import { LOCAL_BACKEND_CAPABILITY_HEADER } from '@aionui/web-host';
import WebSocket, { type RawData } from 'ws';
import { mapConversationTurnCompletedEvent } from '@/common/adapter/conversationTurnCompletedMapper';
import { isCommandEveAcpConversation } from '@/common/config/commandEveShell';
import { EVE_TITLE_FUNCTION_URL, type CommandEveTitleLocale } from '@/common/config/eveTitleCore';
import type {
  ProjectWorkspaceEnsureAutoProjectRequest,
  ProjectWorkspaceEnsureAutoProjectResult,
} from '@/common/types/project-workspace/ui';
import type { ProjectConversationMetadata, ProjectConversationMetadataClient } from './conversationBindingClient';

const TITLE_TIMEOUT_MS = 12_000;
const TITLE_SOURCE_MAX_CHARS = 1_000;
const TITLE_MAX_CHARS = 36;
const MAX_COMPLETION_RECEIPTS = 512;
const RECONNECT_MIN_MS = 750;
const RECONNECT_MAX_MS = 10_000;
const GREETING_ONLY =
  /^(?:hallo|hello|hi|hey|servus|moin(?:\s+moin)?|guten\s+(?:morgen|tag|abend)|good\s+(?:morning|afternoon|evening)|gr(?:ü|ue)(?:ß|ss)(?:\s+dich|\s+euch)?)[\s,!?.…–—-]*$/iu;

type SuccessfulTurnCompletion = {
  conversation_id: string;
  turn_id: string;
  assistant_text: string;
};

type TitleSource = {
  text: string;
  first_user_text: string;
};

export type AutoProjectCompletionOutcome =
  | { status: 'ignored'; reason: string }
  | { status: 'retryable'; reason: string }
  | { status: 'completed'; result: ProjectWorkspaceEnsureAutoProjectResult };

type AutoProjectCompletionDeps = {
  binding_client: ProjectConversationMetadataClient;
  fetch_impl: typeof globalThis.fetch;
  get_port: () => number;
  read_license: () => string | undefined;
  ensure_after_successful_turn: (
    input: ProjectWorkspaceEnsureAutoProjectRequest
  ) => Promise<ProjectWorkspaceEnsureAutoProjectResult>;
  title_function_url?: string;
};

type MainRealtimeRelayDeps = {
  get_port: () => number;
  get_capability: () => string;
  on_turn_completed: (payload: unknown) => Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(value);
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  return typeof value.content === 'string' ? value.content.trim() : '';
}

function normalizedPromptTitle(value: string): string {
  return (
    value
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
      ?.replace(/^[#>*\-\d.\s]+/u, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50) ?? ''
  );
}

function titleLocale(text: string): CommandEveTitleLocale {
  return /[äöüß]|\b(?:der|die|das|und|ich|wir|bitte|für|mit|eine?|einen|erstellen|machen|bauen)\b/iu.test(text)
    ? 'de-DE'
    : 'en-US';
}

function isEligibleMetadata(metadata: ProjectConversationMetadata): boolean {
  return (
    metadata.conversation_type === 'acp' &&
    metadata.backend !== null &&
    isCommandEveAcpConversation(metadata.backend) &&
    metadata.is_temporary_workspace === true &&
    metadata.custom_workspace !== true &&
    metadata.binding === null
  );
}

function isLikelyAutomaticTitle(currentTitle: string, firstUserText: string): boolean {
  const current = currentTitle.replace(/\s+/g, ' ').trim();
  const user = firstUserText.replace(/\s+/g, ' ').trim();
  return (
    !current ||
    GREETING_ONLY.test(current) ||
    current === user ||
    current === normalizedPromptTitle(firstUserText) ||
    (current.length >= 24 && user.startsWith(current))
  );
}

export function parseSuccessfulTurnCompletion(raw: unknown): SuccessfulTurnCompletion | null {
  if (!isRecord(raw)) return null;
  const event = mapConversationTurnCompletedEvent(raw);
  const conversationId = event.session_id.trim();
  const turnId = event.turn_id.trim();
  if (!validOpaqueId(conversationId) || !validOpaqueId(turnId)) return null;
  if (
    event.status !== 'finished' ||
    event.state !== 'ai_waiting_input' ||
    event.can_send_message !== true ||
    event.has_substantive_output !== true ||
    event.runtime.is_processing !== false ||
    event.runtime.can_send_message !== true ||
    event.runtime.pending_confirmations !== 0
  ) {
    return null;
  }
  return {
    conversation_id: conversationId,
    turn_id: turnId,
    assistant_text: messageText(event.last_message.content),
  };
}

export function deriveTitleSource(messages: unknown, assistantFallback = ''): TitleSource | null {
  if (!Array.isArray(messages)) return null;
  let firstUserText = '';
  let assistantText = '';
  let sawUser = false;

  for (const raw of messages) {
    if (!isRecord(raw) || raw.type !== 'text') continue;
    const text = messageText(raw.content);
    if (!text) continue;
    if (raw.position === 'right') {
      if (!GREETING_ONLY.test(text) && !firstUserText) {
        firstUserText = text;
        sawUser = true;
      }
      continue;
    }
    if (sawUser && raw.position === 'left' && !assistantText) {
      assistantText = text;
    }
  }

  if (!firstUserText) return null;
  const assistant = assistantText || assistantFallback.trim();
  const text = [`User: ${firstUserText}`, assistant ? `EVE: ${assistant}` : '']
    .filter(Boolean)
    .join('\n\n')
    .slice(0, TITLE_SOURCE_MAX_CHARS)
    .trim();
  return text ? { text, first_user_text: firstUserText } : null;
}

async function responsePayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  try {
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

async function fetchTitleSource(
  deps: AutoProjectCompletionDeps,
  conversationId: string,
  assistantFallback: string
): Promise<TitleSource | null> {
  const port = deps.get_port();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const response = await deps.fetch_impl(
    `http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=100&content_mode=compact`,
    { method: 'GET', redirect: 'error' }
  );
  if (!response.ok) return null;
  const body = await responsePayload(response);
  const envelope = isRecord(body) && isRecord(body.data) ? body.data : body;
  const items = isRecord(envelope) ? envelope.items : undefined;
  return deriveTitleSource(items, assistantFallback);
}

async function generateDeepSeekTitle(deps: AutoProjectCompletionDeps, source: TitleSource): Promise<string | null> {
  const license = deps.read_license()?.trim() ?? '';
  const functionUrl = deps.title_function_url ?? EVE_TITLE_FUNCTION_URL;
  if (!license || !functionUrl.startsWith('https://')) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  try {
    const response = await deps.fetch_impl(functionUrl, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${license}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ text: source.text, locale: titleLocale(source.first_user_text) }),
    });
    const body = await responsePayload(response);
    const title = isRecord(body) && body.ok === true && typeof body.title === 'string' ? body.title.trim() : '';
    return response.ok && title.length >= 3 && title.length <= TITLE_MAX_CHARS ? title : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function persistConversationTitle(
  deps: AutoProjectCompletionDeps,
  conversationId: string,
  title: string
): Promise<boolean> {
  const port = deps.get_port();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const response = await deps.fetch_impl(
    `http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: 'PATCH',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: title }),
    }
  );
  if (!response.ok) return false;
  try {
    return (await deps.binding_client.readMetadata(conversationId)).name === title;
  } catch {
    return false;
  }
}

export async function runAutoProjectAfterCompletion(
  raw: unknown,
  deps: AutoProjectCompletionDeps
): Promise<AutoProjectCompletionOutcome> {
  const completion = parseSuccessfulTurnCompletion(raw);
  if (!completion) return { status: 'ignored', reason: 'turn-not-successful' };

  let metadata: ProjectConversationMetadata;
  try {
    metadata = await deps.binding_client.readMetadata(completion.conversation_id);
  } catch {
    return { status: 'retryable', reason: 'metadata-unavailable' };
  }
  if (!isEligibleMetadata(metadata)) return { status: 'ignored', reason: 'conversation-ineligible' };

  let source: TitleSource | null;
  try {
    source = await fetchTitleSource(deps, completion.conversation_id, completion.assistant_text);
  } catch {
    return { status: 'retryable', reason: 'messages-unavailable' };
  }
  if (!source) return { status: 'retryable', reason: 'title-source-unavailable' };

  const currentTitle = metadata.name.trim();
  if (isLikelyAutomaticTitle(currentTitle, source.first_user_text)) {
    const title = await generateDeepSeekTitle(deps, source);
    if (!title) return { status: 'retryable', reason: 'deepseek-title-unavailable' };
    if (!(await persistConversationTitle(deps, completion.conversation_id, title))) {
      return { status: 'retryable', reason: 'title-persist-failed' };
    }
  } else if (!currentTitle || currentTitle.length > TITLE_MAX_CHARS) {
    // Preserve an intentional user rename, but never turn an oversized manual
    // title into an ugly automatic folder. The user can shorten it and retry.
    return { status: 'ignored', reason: 'manual-title-too-long' };
  }

  try {
    const result = await deps.ensure_after_successful_turn({
      conversation_id: completion.conversation_id,
      turn_id: completion.turn_id,
    });
    return { status: 'completed', result };
  } catch {
    return { status: 'retryable', reason: 'auto-project-failed' };
  }
}

export function createAutoProjectCompletionCoordinator(deps: AutoProjectCompletionDeps): {
  handle: (payload: unknown) => Promise<AutoProjectCompletionOutcome>;
} {
  const inFlight = new Map<string, Promise<AutoProjectCompletionOutcome>>();
  const completed = new Set<string>();
  return {
    handle: async (payload) => {
      const event = parseSuccessfulTurnCompletion(payload);
      if (!event) return { status: 'ignored', reason: 'turn-not-successful' };
      const key = `${event.conversation_id}\0${event.turn_id}`;
      if (completed.has(key)) return { status: 'ignored', reason: 'duplicate-turn' };
      const existing = inFlight.get(key);
      if (existing) return existing;
      const operation = runAutoProjectAfterCompletion(payload, deps).then((outcome) => {
        if (
          outcome.status === 'completed' ||
          (outcome.status === 'ignored' && outcome.reason !== 'turn-not-successful')
        ) {
          completed.add(key);
          if (completed.size > MAX_COMPLETION_RECEIPTS) completed.delete(completed.values().next().value as string);
        }
        return outcome;
      });
      inFlight.set(key, operation);
      try {
        return await operation;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

/**
 * Persistent Main-process AionCore realtime consumer. Unlike the renderer
 * sidebar listener it survives navigation and hidden windows, reconnects after
 * seat/backend restarts, and never exposes the launch capability to renderer
 * code or logs.
 */
export function startMainAutoProjectTurnCompletionRelay(deps: MainRealtimeRelayDeps): () => void {
  let disposed = false;
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;

  const scheduleReconnect = (): void => {
    if (disposed || reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(4, reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    unrefTimer(reconnectTimer);
  };

  const connect = (): void => {
    if (disposed || socket) return;
    const port = deps.get_port();
    const capability = deps.get_capability();
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !capability) {
      scheduleReconnect();
      return;
    }

    const current = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { [LOCAL_BACKEND_CAPABILITY_HEADER]: capability },
    });
    socket = current;
    current.on('open', () => {
      reconnectAttempt = 0;
      console.log('[ProjectWorkspace] Main turn-completion relay connected');
    });
    current.on('message', (data: RawData) => {
      try {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        const eventName =
          typeof frame.name === 'string' ? frame.name : typeof frame.event === 'string' ? frame.event : '';
        const payload = frame.data ?? frame.payload;
        if (eventName === 'ping') {
          if (current.readyState === WebSocket.OPEN)
            current.send(JSON.stringify({ name: 'pong', data: payload ?? {} }));
          return;
        }
        if (eventName !== 'turn.completed') return;
        void deps
          .on_turn_completed(payload)
          .then((outcome) => console.log('[ProjectWorkspace] Main post-turn outcome', outcome))
          .catch((error: unknown) => console.error('[ProjectWorkspace] Main post-turn relay failed', error));
      } catch {
        // Ignore non-JSON frames. AionCore's protocol is JSON and reconnecting
        // for an unrelated frame would turn harmless noise into data loss.
      }
    });
    current.on('error', () => current.close());
    current.on('close', () => {
      if (socket === current) socket = undefined;
      scheduleReconnect();
    });
  };

  connect();
  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    socket?.close();
    socket = undefined;
  };
}
