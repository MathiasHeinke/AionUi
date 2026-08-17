import { commandEveProviderCallRequestId, isContentFreeCallIdentity } from './commandEveProviderCallIdentity';

export const COMMAND_EVE_DESKTOP_EVENT_META_KEY = 'commandEveDesktop' as const;
export const COMMAND_EVE_DESKTOP_EVENT_VERSION = 'command-eve-desktop-event/v1' as const;
export const COMMAND_EVE_RUNTIME_STATUS_META_KEY = 'commandEveRuntimeStatus' as const;
export const COMMAND_EVE_RUNTIME_STATUS_VERSION = 'command-eve-runtime-status/v1' as const;
export const COMMAND_EVE_PROVIDER_TURN_BINDING_META_KEY = 'commandEveProviderTurnBinding' as const;
export const COMMAND_EVE_PROVIDER_TURN_BINDING_VERSION = 'command-eve-provider-turn-binding/v1' as const;

export type CommandEvePane = 'chat' | 'files' | 'terminal' | 'review' | 'sessions';

export type CommandEveDesktopEvent =
  | { event: 'preview.open'; payload: { url: string; label?: string } }
  | { event: 'pane.reveal'; payload: { pane: CommandEvePane } };

export type CommandEveDesktopToolCall = {
  toolCallId: string;
  desktopEvent: CommandEveDesktopEvent;
};

export type CommandEveRuntimeStatus = {
  phase: 'provider_wait' | 'retry_wait';
  observedAt: string;
  attempt?: number;
  maxAttempts?: number;
  retryAfterMs?: number;
};

export type CommandEveProviderTurnBinding = {
  sessionId: string;
  aionCoreTurnId: string;
  hermesTurnId: string;
  requestId: string;
  callIndex: number;
};

export type CommandEveProviderTurnBindingPersistenceRequest = CommandEveProviderTurnBinding & {
  conversationId: string;
};

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const isBoundedInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;

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

/** Parse the content-free, ephemeral provider lifecycle carried over ACP metadata. */
export function parseCommandEveRuntimeStatus(
  update: unknown,
  expectedSessionId: string | undefined,
  canonicalTurnId: string | undefined,
  expectedTurnId: string | null | undefined
): CommandEveRuntimeStatus | null {
  const info = asRecord(update);
  if (!info || !hasOnlyKeys(info, ['_meta', 'title', 'updated_at', 'session_id'])) return null;
  const sessionId = info.session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) return null;
  if (expectedSessionId && sessionId !== expectedSessionId) return null;
  if (info.title !== undefined && info.title !== null && typeof info.title !== 'string') return null;
  if (info.updated_at !== undefined && info.updated_at !== null && typeof info.updated_at !== 'string') return null;

  const meta = asRecord(info._meta);
  if (!meta || !hasOnlyKeys(meta, [COMMAND_EVE_RUNTIME_STATUS_META_KEY])) return null;
  const envelope = asRecord(meta[COMMAND_EVE_RUNTIME_STATUS_META_KEY]);
  if (!envelope) return null;
  const commonKeys = ['version', 'sessionId', 'phase', 'observedAt'] as const;
  const retryKeys = [...commonKeys, 'attempt', 'maxAttempts', 'retryAfterMs'] as const;
  if (!hasOnlyKeys(envelope, envelope.phase === 'retry_wait' ? retryKeys : commonKeys)) return null;
  if (!commonKeys.every((key) => Object.prototype.hasOwnProperty.call(envelope, key))) return null;
  if (envelope.version !== COMMAND_EVE_RUNTIME_STATUS_VERSION || envelope.sessionId !== sessionId) return null;
  // Hermes ACP does not receive AionCore's outer turn id. AionCore adds that
  // canonical id to the WebSocket frame, so bind it here instead of accepting
  // an invented nested id from the provider runtime.
  if (!canonicalTurnId || !expectedTurnId || canonicalTurnId !== expectedTurnId) return null;
  if (
    typeof envelope.observedAt !== 'string' ||
    envelope.observedAt.length > 64 ||
    !Number.isFinite(Date.parse(envelope.observedAt))
  ) {
    return null;
  }
  if (envelope.phase === 'provider_wait') {
    return { phase: 'provider_wait', observedAt: envelope.observedAt };
  }
  if (envelope.phase !== 'retry_wait') return null;
  if (!isBoundedInteger(envelope.attempt, 1, 100)) return null;
  if (!isBoundedInteger(envelope.maxAttempts, envelope.attempt, 100)) return null;
  if (!isBoundedInteger(envelope.retryAfterMs, 0, 600_000)) return null;
  return {
    phase: 'retry_wait',
    observedAt: envelope.observedAt,
    attempt: envelope.attempt,
    maxAttempts: envelope.maxAttempts,
    retryAfterMs: envelope.retryAfterMs,
  };
}

/** Parse Hermes' exact provider-call identity and bind it to AionCore's outer turn. */
export function parseCommandEveProviderTurnBinding(
  update: unknown,
  expectedSessionId: string | undefined,
  canonicalTurnId: string | undefined,
  expectedTurnId: string | null | undefined
): CommandEveProviderTurnBinding | null {
  const info = asRecord(update);
  if (!info || !hasOnlyKeys(info, ['_meta', 'title', 'updated_at', 'session_id'])) return null;
  const sessionId = info.session_id;
  if (
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    sessionId.length > 256 ||
    !expectedSessionId ||
    sessionId !== expectedSessionId
  ) {
    return null;
  }
  if (info.title !== undefined && info.title !== null && typeof info.title !== 'string') return null;
  if (info.updated_at !== undefined && info.updated_at !== null && typeof info.updated_at !== 'string') return null;
  if (!canonicalTurnId || !expectedTurnId || canonicalTurnId !== expectedTurnId) return null;

  const meta = asRecord(info._meta);
  if (!meta || !hasOnlyKeys(meta, [COMMAND_EVE_PROVIDER_TURN_BINDING_META_KEY])) return null;
  const envelope = asRecord(meta[COMMAND_EVE_PROVIDER_TURN_BINDING_META_KEY]);
  const keys = ['version', 'hermesTurnId', 'requestId', 'callIndex', 'sessionId'] as const;
  if (!envelope || !hasOnlyKeys(envelope, keys) || !keys.every((key) => Object.hasOwn(envelope, key))) return null;
  if (
    envelope.version !== COMMAND_EVE_PROVIDER_TURN_BINDING_VERSION ||
    envelope.sessionId !== sessionId ||
    !isContentFreeCallIdentity(envelope.hermesTurnId) ||
    !isContentFreeCallIdentity(envelope.requestId) ||
    !isBoundedInteger(envelope.callIndex, 1, 100) ||
    envelope.requestId !== commandEveProviderCallRequestId(envelope.hermesTurnId, envelope.callIndex)
  ) {
    return null;
  }
  return {
    sessionId,
    aionCoreTurnId: canonicalTurnId,
    hermesTurnId: envelope.hermesTurnId,
    requestId: envelope.requestId,
    callIndex: envelope.callIndex,
  };
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
