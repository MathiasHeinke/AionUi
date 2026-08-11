import { describe, expect, it } from 'vitest';

import {
  COMMAND_EVE_BROWSER_WORKBENCH_STATE_SCHEMA,
  normalizeBrowserWorkbenchState,
  sanitizeBrowserResumeUrl,
} from '@/common/config/browserWorkbenchStateCore';

describe('browserWorkbenchStateCore', () => {
  it.each([
    'file:///tmp/private.txt',
    'data:text/html,<h1>private</h1>',
    'blob:https://example.com/private',
    'javascript:alert(1)',
  ])('refuses non-network resume metadata: %s', (url) => {
    expect(sanitizeBrowserResumeUrl(url)).toBeNull();
  });

  it('removes credential query keys, userinfo and fragments', () => {
    expect(
      sanitizeBrowserResumeUrl(
        'https://user:password@example.com/path?view=compact&code=oauth-code&recovery_code=123#access_token=raw'
      )
    ).toBe('https://example.com/path?view=compact');
  });

  it('normalizes bounded tabs and never persists a raw secret canary', () => {
    const secret = 'sk-commandevebrowserproof123456789';
    const state = normalizeBrowserWorkbenchState(
      {
        active_tab_id: 'browser-1',
        tabs: [
          {
            id: 'browser-1',
            title: `Private ${secret}`,
            url: `https://example.com/work?api_key=${secret}&mode=qa#${secret}`,
            conversation_id: 'conversation-1',
            history: {
              back: ['file:///tmp/no', `https://example.com/previous?token=${secret}`],
              forward: ['https://example.com/next'],
            },
          },
        ],
      },
      () => new Date('2026-08-11T15:00:00.000Z')
    );
    expect(state.schema_version).toBe(COMMAND_EVE_BROWSER_WORKBENCH_STATE_SCHEMA);
    expect(state.active_tab_id).toBe('browser-1');
    expect(state.tabs[0]).toMatchObject({
      title: 'Browser',
      url: 'https://example.com/work?mode=qa',
      conversation_id: 'conversation-1',
      history: { back: ['https://example.com/previous'], forward: ['https://example.com/next'] },
    });
    expect(JSON.stringify(state)).not.toContain(secret);
  });

  it('drops an active id that does not belong to this account+seed state', () => {
    const state = normalizeBrowserWorkbenchState({ active_tab_id: 'foreign', tabs: [] });
    expect(state.active_tab_id).toBeNull();
  });
});
