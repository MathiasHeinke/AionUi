import { describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_DESKTOP_EVENT_VERSION,
  parseCommandEveDesktopEvent,
} from '../../../packages/desktop/src/common/config/hermesDesktopEventCore';

const wire = (event: string, payload: unknown, sessionId = 'acp-session-1') => ({
  _meta: {
    commandEveDesktop: {
      version: COMMAND_EVE_DESKTOP_EVENT_VERSION,
      sessionId,
      event,
      payload,
    },
  },
});

describe('parseCommandEveDesktopEvent', () => {
  it('accepts only the versioned preview and files-pane contracts', () => {
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
    expect(
      parseCommandEveDesktopEvent(
        { ...wire('pane.reveal', { pane: 'files' }), title: 'Files', updated_at: '2026-08-08T08:00:00Z' },
        'acp-session-1'
      )
    ).toEqual({ event: 'pane.reveal', payload: { pane: 'files' } });
  });

  it.each([
    ['unknown event', wire('terminal.read', {})],
    ['foreign session', wire('preview.open', { url: 'https://example.com' }, 'foreign')],
    ['unsafe scheme', wire('preview.open', { url: 'javascript:alert(1)' })],
    ['credentialed url', wire('preview.open', { url: 'https://user:secret@example.com' })],
    ['extra preview key', wire('preview.open', { url: 'https://example.com', execute: true })],
    ['other pane', wire('pane.reveal', { pane: 'terminal' })],
    ['pre-relay discriminator', { ...wire('pane.reveal', { pane: 'files' }), sessionUpdate: 'session_info_update' }],
    ['unknown top-level key', { ...wire('pane.reveal', { pane: 'files' }), authority: 'seat' }],
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
    expect(parseCommandEveDesktopEvent(wire('preview.open', { url: 'https://example.com' }), undefined)).toBeNull();
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
