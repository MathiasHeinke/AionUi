import { describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_DESKTOP_EVENT_VERSION,
  COMMAND_EVE_RUNTIME_STATUS_VERSION,
  parseCommandEveDesktopEvent,
  parseCommandEveDesktopToolCall,
  parseCommandEveRuntimeStatus,
} from '../../../packages/desktop/src/common/config/hermesDesktopEventCore';

const wire = (event: string, payload: unknown, sessionId = 'acp-session-1') => ({
  session_id: sessionId,
  _meta: {
    commandEveDesktop: {
      version: COMMAND_EVE_DESKTOP_EVENT_VERSION,
      sessionId,
      event,
      payload,
    },
  },
});

const completedToolCall = (title: string, rawInput: unknown, overrides: Record<string, unknown> = {}) => ({
  session_update: 'tool_call_update',
  tool_call_id: 'tool-desktop-1',
  status: 'completed',
  title,
  raw_input: rawInput,
  ...overrides,
});

const runtimeWire = (payload: Record<string, unknown>, sessionId = 'acp-session-1') => ({
  session_id: sessionId,
  title: null,
  updated_at: null,
  _meta: {
    commandEveRuntimeStatus: {
      version: COMMAND_EVE_RUNTIME_STATUS_VERSION,
      sessionId,
      observedAt: '2026-08-13T21:39:18Z',
      ...payload,
    },
  },
});

describe('parseCommandEveRuntimeStatus', () => {
  it('accepts only content-free provider wait and bounded retry metadata for the current turn', () => {
    expect(
      parseCommandEveRuntimeStatus(runtimeWire({ phase: 'provider_wait' }), undefined, 'turn-1', 'turn-1')
    ).toEqual({
      phase: 'provider_wait',
      observedAt: '2026-08-13T21:39:18Z',
    });
    expect(
      parseCommandEveRuntimeStatus(
        runtimeWire({ phase: 'retry_wait', attempt: 2, maxAttempts: 3, retryAfterMs: 2020 }),
        'acp-session-1',
        'turn-1',
        'turn-1'
      )
    ).toEqual({
      phase: 'retry_wait',
      observedAt: '2026-08-13T21:39:18Z',
      attempt: 2,
      maxAttempts: 3,
      retryAfterMs: 2020,
    });
  });

  it.each([
    ['no accepted turn', runtimeWire({ phase: 'provider_wait' }), undefined],
    ['old outer turn', runtimeWire({ phase: 'provider_wait' }), 'turn-old'],
    ['foreign session', runtimeWire({ phase: 'provider_wait' }, 'foreign'), 'turn-1'],
    ['raw provider text', runtimeWire({ phase: 'provider_wait', message: 'vendor/model timeout' }), 'turn-1'],
    ['unknown phase', runtimeWire({ phase: 'recovering' }), 'turn-1'],
    ['missing retry values', runtimeWire({ phase: 'retry_wait' }), 'turn-1'],
    [
      'unbounded wait',
      runtimeWire({ phase: 'retry_wait', attempt: 1, maxAttempts: 2, retryAfterMs: 900_000 }),
      'turn-1',
    ],
  ])('rejects %s fail-closed', (_label, input, outerTurn) => {
    expect(parseCommandEveRuntimeStatus(input, 'acp-session-1', outerTurn, 'turn-1')).toBeNull();
  });
});

describe('parseCommandEveDesktopToolCall', () => {
  it('recovers the bounded commands from real completed ACP tool frames', () => {
    expect(
      parseCommandEveDesktopToolCall(
        completedToolCall('open_preview', { url: 'https://example.com/live', label: 'Live' })
      )
    ).toEqual({
      toolCallId: 'tool-desktop-1',
      desktopEvent: { event: 'preview.open', payload: { url: 'https://example.com/live', label: 'Live' } },
    });
    expect(parseCommandEveDesktopToolCall(completedToolCall('focus_pane', { pane: 'files' }))).toEqual({
      toolCallId: 'tool-desktop-1',
      desktopEvent: { event: 'pane.reveal', payload: { pane: 'files' } },
    });
    for (const pane of ['chat', 'terminal', 'review', 'sessions'] as const) {
      expect(parseCommandEveDesktopToolCall(completedToolCall('focus_pane', { pane }))).toEqual({
        toolCallId: 'tool-desktop-1',
        desktopEvent: { event: 'pane.reveal', payload: { pane } },
      });
    }
  });

  it.each([
    ['pending', completedToolCall('open_preview', { url: 'https://example.com' }, { status: 'in_progress' })],
    ['failed', completedToolCall('open_preview', { url: 'https://example.com' }, { status: 'failed' })],
    ['wrong tool', completedToolCall('terminal', { url: 'https://example.com' })],
    ['unsafe url', completedToolCall('open_preview', { url: 'file:///etc/passwd' })],
    ['extra input', completedToolCall('open_preview', { url: 'https://example.com', execute: true })],
    ['unknown pane', completedToolCall('focus_pane', { pane: 'kanban' })],
    ['missing id', completedToolCall('focus_pane', { pane: 'files' }, { tool_call_id: '' })],
  ])('rejects %s', (_label, update) => {
    expect(parseCommandEveDesktopToolCall(update)).toBeNull();
  });
});

describe('parseCommandEveDesktopEvent', () => {
  it('accepts only the versioned preview and native pane contracts', () => {
    expect(
      parseCommandEveDesktopEvent(
        wire('preview.open', { url: 'https://example.com', label: 'Example' }),
        'acp-session-1'
      )
    ).toEqual({
      event: 'preview.open',
      payload: { url: 'https://example.com', label: 'Example' },
    });
    expect(parseCommandEveDesktopEvent(wire('pane.reveal', { pane: 'files' }), 'acp-session-1')).toEqual({
      event: 'pane.reveal',
      payload: { pane: 'files' },
    });
    for (const pane of ['chat', 'terminal', 'review', 'sessions'] as const) {
      expect(parseCommandEveDesktopEvent(wire('pane.reveal', { pane }), 'acp-session-1')).toEqual({
        event: 'pane.reveal',
        payload: { pane },
      });
    }
    expect(
      parseCommandEveDesktopEvent(
        { ...wire('pane.reveal', { pane: 'files' }), title: 'Files', updated_at: '2026-08-08T08:00:00Z' },
        'acp-session-1'
      )
    ).toEqual({ event: 'pane.reveal', payload: { pane: 'files' } });
    expect(
      parseCommandEveDesktopEvent(
        { ...wire('pane.reveal', { pane: 'files' }), title: null, updated_at: null },
        'acp-session-1'
      )
    ).toEqual({ event: 'pane.reveal', payload: { pane: 'files' } });
    expect(parseCommandEveDesktopEvent(wire('pane.reveal', { pane: 'files' }), undefined)).toBeNull();
  });

  it.each([
    ['unknown event', wire('terminal.read', {})],
    ['foreign active session', { ...wire('preview.open', { url: 'https://example.com' }), session_id: 'foreign' }],
    [
      'nested session mismatch',
      {
        ...wire('preview.open', { url: 'https://example.com' }),
        _meta: {
          commandEveDesktop: {
            ...wire('preview.open', { url: 'https://example.com' })._meta.commandEveDesktop,
            sessionId: 'foreign',
          },
        },
      },
    ],
    ['missing canonical session', { ...wire('pane.reveal', { pane: 'files' }), session_id: undefined }],
    ['non-string canonical session', { ...wire('pane.reveal', { pane: 'files' }), session_id: 7 }],
    ['unsafe scheme', wire('preview.open', { url: 'javascript:alert(1)' })],
    ['credentialed url', wire('preview.open', { url: 'https://user:secret@example.com' })],
    ['extra preview key', wire('preview.open', { url: 'https://example.com', execute: true })],
    ['unknown pane', wire('pane.reveal', { pane: 'kanban' })],
    ['pre-relay discriminator', { ...wire('pane.reveal', { pane: 'files' }), sessionUpdate: 'session_info_update' }],
    ['unknown top-level key', { ...wire('pane.reveal', { pane: 'files' }), authority: 'seat' }],
    ['non-protocol title type', { ...wire('pane.reveal', { pane: 'files' }), title: 7 }],
    ['non-protocol timestamp type', { ...wire('pane.reveal', { pane: 'files' }), updated_at: false }],
    ['internal camelCase relay shape', { ...wire('pane.reveal', { pane: 'files' }), updatedAt: null }],
    [
      'extra envelope key',
      {
        ...wire('pane.reveal', { pane: 'files' }),
        _meta: {
          commandEveDesktop: {
            ...wire('pane.reveal', { pane: 'files' })._meta.commandEveDesktop,
            authority: 'seat',
          },
        },
      },
    ],
    [
      'wrong version',
      {
        ...wire('pane.reveal', { pane: 'files' }),
        _meta: {
          commandEveDesktop: {
            ...wire('pane.reveal', { pane: 'files' })._meta.commandEveDesktop,
            version: 'command-eve-desktop-event/v2',
          },
        },
      },
    ],
  ])('rejects %s fail-closed', (_label, input) => {
    expect(parseCommandEveDesktopEvent(input, 'acp-session-1')).toBeNull();
  });

  it('rejects a missing binding and oversized values', () => {
    expect(
      parseCommandEveDesktopEvent(
        { ...wire('preview.open', { url: 'https://example.com' }), session_id: '' },
        undefined
      )
    ).toBeNull();
    expect(
      parseCommandEveDesktopEvent(
        wire('preview.open', { url: `https://example.com/${'x'.repeat(4096)}` }),
        'acp-session-1'
      )
    ).toBeNull();
    expect(
      parseCommandEveDesktopEvent(
        wire('preview.open', { url: 'https://example.com', label: 'x'.repeat(201) }),
        'acp-session-1'
      )
    ).toBeNull();
  });
});
