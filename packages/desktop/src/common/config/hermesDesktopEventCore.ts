export const COMMAND_EVE_DESKTOP_EVENT_META_KEY = 'commandEveDesktop' as const;
export const COMMAND_EVE_DESKTOP_EVENT_VERSION = 'command-eve-desktop-event/v1' as const;

export type CommandEveDesktopEvent =
  | { event: 'preview.open'; payload: { url: string; label?: string } }
  | { event: 'pane.reveal'; payload: { pane: 'files' } };

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
  if (!payload || !hasOnlyKeys(payload, ['pane']) || payload.pane !== 'files') return null;
  return { event: 'pane.reveal', payload: { pane: 'files' } };
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
  if (!expectedSessionId) return null;
  const info = asRecord(update);
  // AionCore removes the ACP enum discriminator when it translates
  // SessionInfoUpdate into `acp_session_info`. Accept only that final payload,
  // never a pre-relay ACP update or an extended top-level object.
  if (!info || !hasOnlyKeys(info, ['_meta', 'title', 'updated_at'])) return null;
  if (info.title !== undefined && typeof info.title !== 'string') return null;
  if (info.updated_at !== undefined && typeof info.updated_at !== 'string') return null;
  const meta = asRecord(info._meta);
  if (!meta || !hasOnlyKeys(meta, [COMMAND_EVE_DESKTOP_EVENT_META_KEY])) return null;
  const envelope = asRecord(meta[COMMAND_EVE_DESKTOP_EVENT_META_KEY]);
  if (!envelope || !hasOnlyKeys(envelope, ['version', 'sessionId', 'event', 'payload'])) return null;
  if (envelope.version !== COMMAND_EVE_DESKTOP_EVENT_VERSION || envelope.sessionId !== expectedSessionId) return null;
  if (envelope.event === 'preview.open') return parsePreviewPayload(envelope.payload);
  if (envelope.event === 'pane.reveal') return parsePanePayload(envelope.payload);
  return null;
}
