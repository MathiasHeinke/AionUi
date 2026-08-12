export const COMMAND_EVE_DESKTOP_EVENT_META_KEY = 'commandEveDesktop' as const;
export const COMMAND_EVE_DESKTOP_EVENT_VERSION = 'command-eve-desktop-event/v1' as const;

export type CommandEvePane = 'chat' | 'files' | 'terminal' | 'review' | 'sessions';

export type CommandEveDesktopEvent =
  | { event: 'preview.open'; payload: { url: string; label?: string } }
  | { event: 'pane.reveal'; payload: { pane: CommandEvePane } };

export type CommandEveDesktopToolCall = {
  toolCallId: string;
  desktopEvent: CommandEveDesktopEvent;
};

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function parsePreviewPayload(value: unknown): CommandEveDesktopEvent | null {
  const payload = asRecord(value);
  if (!payload || !hasOnlyKeys(payload, ['url', 'label'])) return null;
  if (typeof payload.url !== 'string' || payload.url.length === 0 || payload.url.length > 4096) return null;
  if (payload.label !== undefined && (typeof payload.label !== 'string' || payload.label.length > 200)) return null;
  try {
    const url = new URL(payload.url);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
  } catch {
    return null;
  }
  return {
    event: 'preview.open',
    payload: { url: payload.url, ...(typeof payload.label === 'string' ? { label: payload.label } : {}) },
  };
}

function parsePanePayload(value: unknown): CommandEveDesktopEvent | null {
  const payload = asRecord(value);
  if (!payload || !hasOnlyKeys(payload, ['pane']) || typeof payload.pane !== 'string') return null;
  const panes: readonly CommandEvePane[] = ['chat', 'files', 'terminal', 'review', 'sessions'];
  if (!panes.includes(payload.pane as CommandEvePane)) return null;
  return { event: 'pane.reveal', payload: { pane: payload.pane as CommandEvePane } };
}

/**
 * Parse the only Hermes desktop events Command EVE accepts.
 *
 * The ACP conversation is checked by the caller before this parser runs. This
 * additionally binds the event to the current ACP session, rejects schema
 * extensions, and leaves every unknown desktop capability fail-closed.
 */
export function parseCommandEveDesktopEvent(
  update: unknown,
  expectedSessionId: string | undefined
): CommandEveDesktopEvent | null {
  const info = asRecord(update);
  if (typeof expectedSessionId !== 'string' || !expectedSessionId.trim()) return null;
  const normalizedExpectedSessionId = expectedSessionId.trim();
  // AionCore removes the ACP enum discriminator when it translates
  // SessionInfoUpdate into `acp_session_info`; StreamRelay then projects the
  // canonical outer ACP session id as renderer-facing `session_id`. Accept only
  // that final WebSocket payload, never the internal camelCase relay object, a
  // pre-relay ACP update, or an extended top-level object.
  if (!info || !hasOnlyKeys(info, ['_meta', 'title', 'updated_at', 'session_id'])) return null;
  const canonicalSessionId = info.session_id;
  if (typeof canonicalSessionId !== 'string' || !canonicalSessionId.trim()) return null;
  if (canonicalSessionId !== normalizedExpectedSessionId) return null;
  // ACP's SessionInfoUpdate models omitted title/timestamp values as explicit
  // nulls. AionCore correctly preserves those protocol values while removing
  // only the enum discriminator, so accept null as the ACP "clear" value but
  // keep every other non-string type fail-closed.
  if (info.title !== undefined && info.title !== null && typeof info.title !== 'string') return null;
  if (info.updated_at !== undefined && info.updated_at !== null && typeof info.updated_at !== 'string') return null;
  const meta = asRecord(info._meta);
  if (!meta || !hasOnlyKeys(meta, [COMMAND_EVE_DESKTOP_EVENT_META_KEY])) return null;
  const envelope = asRecord(meta[COMMAND_EVE_DESKTOP_EVENT_META_KEY]);
  if (!envelope || !hasOnlyKeys(envelope, ['version', 'sessionId', 'event', 'payload'])) return null;
  if (envelope.version !== COMMAND_EVE_DESKTOP_EVENT_VERSION) return null;
  if (envelope.sessionId !== undefined && envelope.sessionId !== canonicalSessionId) return null;
  if (envelope.event === 'preview.open') return parsePreviewPayload(envelope.payload);
  if (envelope.event === 'pane.reveal') return parsePanePayload(envelope.payload);
  return null;
}

/**
 * Recover the same bounded desktop command from the completed standard ACP tool
 * frame. Hermes Desktop normally carries renderer events over its gateway bus;
 * the ACP adapter has no equivalent client-event channel, while AionCore already
 * transports this completed tool frame with conversation + turn identity. Keep
 * the custom SessionInfoUpdate bridge as a fast path, but never make visible UI
 * depend on that transient metadata event reaching a late-mounted renderer.
 */
export function parseCommandEveDesktopToolCall(update: unknown): CommandEveDesktopToolCall | null {
  const record = asRecord(update);
  if (!record) return null;
  const sessionUpdate = record.session_update ?? record.sessionUpdate;
  if (sessionUpdate !== 'tool_call_update' || record.status !== 'completed') return null;
  const toolCallId = record.tool_call_id ?? record.toolCallId;
  if (typeof toolCallId !== 'string' || !toolCallId.trim()) return null;
  const rawInput = asRecord(record.raw_input ?? record.rawInput);
  if (!rawInput) return null;

  let desktopEvent: CommandEveDesktopEvent | null = null;
  if (record.title === 'open_preview') desktopEvent = parsePreviewPayload(rawInput);
  if (record.title === 'focus_pane') desktopEvent = parsePanePayload(rawInput);
  return desktopEvent ? { toolCallId, desktopEvent } : null;
}
