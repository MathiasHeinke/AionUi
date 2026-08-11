/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { detectCommandEveSensitiveEgress } from '@/common/api/egressBoundaryCore';

/**
 * 单目标 CDP 转发层的纯协议逻辑（不含 Electron / socket 依赖，便于单测）。
 *
 * 为什么需要这一层：Chromium 的 remote-debugging-port 是「整个应用级」的，没有
 * per-target ACL，开一个口子等于把主窗口（连着 preload 桥）一起暴露给本机任意进程。
 * 我们改成只对侧边浏览器那一个 webContents 暴露，但 chrome-devtools-mcp 用的是
 * puppeteer 的 browserURL 连接方式，它上来就把对面当成「一整个浏览器」，先发
 * Target.setDiscoverTargets / setAutoAttach，再靠 Target.attachToTarget 拿 sessionId。
 * Electron 的 webContents.debugger 只能服务单个页面，答不上这些命令。
 *
 * 所以这里把自己伪装成「只有一个标签页的浏览器」：Target.* 由我们本地应答，其余命令
 * 透传给 debugger。Electron 的 debugger 收发两端都支持 sessionId（electron.d.ts
 * sendCommand(method, params, sessionId) 与 'message' 事件的 sessionId 参数），
 * 所以 puppeteer 要的 flatten 模式能对上。
 *
 * Pure protocol logic for the single-target CDP bridge (no Electron or socket
 * dependency, so it can be unit-tested).
 *
 * Why this layer exists: Chromium's remote-debugging-port is application-wide with no
 * per-target ACL, so opening it exposes the main window — and its preload bridge — to
 * any local process. We narrow it to just the browser webview, but chrome-devtools-mcp
 * connects via puppeteer's browserURL, which treats the endpoint as a whole browser: it
 * sends Target.setDiscoverTargets / setAutoAttach up front and obtains a sessionId via
 * Target.attachToTarget. Electron's webContents.debugger serves a single page and cannot
 * answer those.
 *
 * So we present ourselves as a browser that happens to have exactly one tab: Target.*
 * is answered locally, everything else is forwarded to the debugger. Electron's debugger
 * supports sessionId in both directions, so puppeteer's flatten mode lines up.
 */

/** 伪造的稳定 id：只有一个目标，不需要真的分配。/ Fixed ids — there is only ever one target. */
export const SINGLE_TARGET_ID = 'aionui-browser-target';
export const SINGLE_SESSION_ID = 'aionui-browser-session';
export const SINGLE_BROWSER_CONTEXT_ID = 'aionui-browser-context';

export type TargetInfo = {
  targetId: string;
  type: 'page';
  title: string;
  url: string;
  attached: boolean;
  canAccessOpener: boolean;
  browserContextId: string;
};

export type CdpRequest = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

/** 本地应答 / 透传给 debugger / 明确拒绝。 */
export type CdpDecision =
  | { kind: 'reply'; payload: Record<string, unknown> }
  | {
      kind: 'reply-and-emit';
      payload: Record<string, unknown>;
      emit: Array<{ method: string; params: Record<string, unknown> }>;
    }
  | { kind: 'forward' }
  | { kind: 'error'; message: string };

export type ProjectedCdpEvent = { method: string; params: Record<string, unknown> };

const CDP_EGRESS_METHODS = new Set([
  'Fetch.continueRequest',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Network.setExtraHTTPHeaders',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.navigate',
  'Runtime.callFunctionOn',
  'Runtime.evaluate',
]);

const CDP_CREDENTIAL_READ_METHODS = new Set([
  'Network.getAllCookies',
  'Network.getCookies',
  'Storage.getCookies',
  'DOMStorage.getDOMStorageItems',
]);

/**
 * Browser Use CLI 3.0 is intentionally constrained to typed operations against
 * the visible EVE target. Arbitrary page scripts are not an EVE capability:
 * JavaScript shares the page's origin-backed cookie/storage/DOM surfaces, and
 * no lexical scanner or isolated world can turn that into a credential boundary.
 *
 * The reviewed Command EVE profile for browser-use==0.13.7 /
 * browser_harness==0.1.8 therefore supports the upstream typed hooks used by
 * goto_url/current_tab, Accessibility + DOM box Read, click_at_xy,
 * type_text/press_key, scroll, capture_screenshot, and fixed-target cleanup.
 * Upstream page_info(), js(), wait_for_load(), wait_for_element(), and
 * fill_input() depend on Runtime.evaluate and are explicitly unsupported. The
 * Hermes adapter prepares equivalent no-eval AX perception for this profile.
 */
const CDP_SCRIPT_METHODS = new Set([
  'Debugger.evaluateOnCallFrame',
  'Page.addScriptToEvaluateOnLoad',
  'Page.addScriptToEvaluateOnNewDocument',
  'Runtime.callFunctionOn',
  'Runtime.compileScript',
  'Runtime.evaluate',
  'Runtime.runScript',
]);

/**
 * Reviewed against the pinned official Browser Use CLI 3.0 package's explicit
 * Command EVE profile above. Unknown methods fail closed instead of inheriting
 * Chromium's much wider CDP surface.
 */
const CDP_ALLOWED_FORWARD_METHODS = new Set([
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
  'Page.navigate',
  'Runtime.disable',
  'Runtime.enable',
]);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const compact = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

/** Strip capability-bearing URL parts before a target URL can reach the agent. */
export const sanitizeCdpUrlForAgent = (value: string): string => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'about:blank';
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    if (detectCommandEveSensitiveEgress(parsed.pathname).length > 0) parsed.pathname = '/';
    return parsed.toString();
  } catch {
    return 'about:blank';
  }
};

/**
 * Project debugger events onto the tiny schema required by the pinned CLI.
 * Default-drop is deliberate: CDP Network/Fetch/Runtime events can otherwise
 * carry Cookie, Set-Cookie, Authorization, response bodies, console values, or
 * exception payloads without ever passing the command policy.
 */
export const decideCdpEvent = (method: string, rawParams: unknown): ProjectedCdpEvent | null => {
  const params = asRecord(rawParams);
  switch (method) {
    case 'Page.loadEventFired':
    case 'Page.domContentEventFired':
      return { method, params: compact({ timestamp: finiteNumber(params.timestamp) }) };
    case 'Page.frameStartedLoading':
    case 'Page.frameStoppedLoading':
      return { method, params: compact({ frameId: nonEmptyString(params.frameId) }) };
    case 'Page.lifecycleEvent':
      return {
        method,
        params: compact({
          frameId: nonEmptyString(params.frameId),
          loaderId: nonEmptyString(params.loaderId),
          name: nonEmptyString(params.name),
          timestamp: finiteNumber(params.timestamp),
        }),
      };
    case 'Network.requestWillBeSent':
    case 'Network.responseReceived':
    case 'Network.loadingFinished':
    case 'Network.loadingFailed':
      return { method, params: compact({ requestId: nonEmptyString(params.requestId) }) };
    default:
      return null;
  }
};

const safeAccessibilityText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  if (
    detectCommandEveSensitiveEgress(value).some((finding) => ['secret', 'financial', 'health'].includes(finding.kind))
  ) {
    return '[redacted]';
  }
  return value.slice(0, 4096);
};

const projectAxProperty = (value: unknown): Record<string, unknown> | undefined => {
  const property = asRecord(value);
  const projectedValue = safeAccessibilityText(property.value);
  if (projectedValue === undefined) return undefined;
  return compact({ type: nonEmptyString(property.type), value: projectedValue });
};

/** Remove editable values and opaque AX metadata before a Read result leaves MAIN. */
export const projectCdpResult = (method: string, rawResult: unknown): Record<string, unknown> => {
  const result = asRecord(rawResult);
  if (method !== 'Accessibility.getFullAXTree') return result;
  const nodes = Array.isArray(result.nodes) ? result.nodes : [];
  return {
    nodes: nodes.map((rawNode) => {
      const node = asRecord(rawNode);
      return compact({
        nodeId: nonEmptyString(node.nodeId),
        ignored: typeof node.ignored === 'boolean' ? node.ignored : undefined,
        role: projectAxProperty(node.role),
        name: projectAxProperty(node.name),
        description: projectAxProperty(node.description),
        backendDOMNodeId: finiteNumber(node.backendDOMNodeId),
        parentId: nonEmptyString(node.parentId),
        childIds: Array.isArray(node.childIds)
          ? node.childIds.filter((value): value is string => typeof value === 'string')
          : undefined,
        // Deliberately no `value` or free-form `properties`: those fields can
        // contain text/password/OTP input contents and browser credential state.
      });
    }),
  };
};

const containsS3Egress = (method: string, params: Record<string, unknown> | undefined): boolean => {
  if (!CDP_EGRESS_METHODS.has(method) || !params) return false;
  let serialized = '';
  try {
    serialized = JSON.stringify(params);
  } catch {
    // JSON-wire requests are serializable. A future internal bypass must fail closed.
    return true;
  }
  return detectCommandEveSensitiveEgress(serialized).some((finding) =>
    ['secret', 'financial', 'health'].includes(finding.kind)
  );
};

const isSafeCdpNavigation = (params: Record<string, unknown> | undefined): boolean => {
  if (typeof params?.url !== 'string') return false;
  try {
    const target = new URL(params.url);
    return target.protocol === 'https:' || target.protocol === 'http:';
  } catch {
    return false;
  }
};

export const buildTargetInfo = (title: string, url: string): TargetInfo => ({
  targetId: SINGLE_TARGET_ID,
  type: 'page',
  title,
  url,
  attached: true,
  canAccessOpener: false,
  browserContextId: SINGLE_BROWSER_CONTEXT_ID,
});

/**
 * /json/version 的响应。puppeteer 的 getWSEndpoint() 只读 webSocketDebuggerUrl，
 * 但 Browser.version() 会用到 Browser 字段，一并给全避免后续报错。
 *
 * puppeteer's getWSEndpoint() only reads webSocketDebuggerUrl, but Browser.version()
 * surfaces the Browser field, so provide both.
 */
export const buildVersionPayload = (wsUrl: string, chromeVersion: string) => ({
  Browser: `Chrome/${chromeVersion}`,
  'Protocol-Version': '1.3',
  'User-Agent': `AionUi in-app browser (Chrome/${chromeVersion})`,
  'V8-Version': process.versions.v8 ?? '',
  'WebKit-Version': '',
  webSocketDebuggerUrl: wsUrl,
});

/** /json/list 的响应：永远只有那一个页面。/ Always exactly one page. */
export const buildListPayload = (wsUrl: string, title: string, url: string) => [
  {
    description: '',
    devtoolsFrontendUrl: '',
    id: SINGLE_TARGET_ID,
    title,
    type: 'page',
    url,
    webSocketDebuggerUrl: wsUrl,
  },
];

/**
 * 决定一条入站命令怎么处理。
 *
 * 关键取舍：Target.createTarget 明确报错而不是静默忽略。这个命令的语义是「新开一个
 * 标签页」，我们做不到，但如果假装成功、返回那个唯一的 targetId，Agent 会以为自己开了
 * 新页面，实际上在原页面上继续操作 —— 那种错法比直接失败更难查。宁可让它拿到一个
 * 说明清楚的错误。
 *
 * Deliberate choice: Target.createTarget errors out rather than silently no-oping.
 * It means "open a new tab", which we cannot do; pretending it succeeded and handing
 * back the one existing targetId would leave the agent believing it had a fresh page
 * while it kept driving the old one — a failure far harder to diagnose than an explicit
 * error.
 */
export const decideCdpCommand = (req: CdpRequest, getTargetInfo: () => TargetInfo): CdpDecision => {
  const method = req.method ?? '';

  if (CDP_CREDENTIAL_READ_METHODS.has(method)) {
    return { kind: 'error', message: 'Command EVE blocks raw browser credentials from agent output.' };
  }

  if (CDP_SCRIPT_METHODS.has(method)) {
    return {
      kind: 'error',
      message: 'Command EVE blocks arbitrary page scripts; use typed browser operations.',
    };
  }

  if (containsS3Egress(method, req.params)) {
    return {
      kind: 'error',
      message: 'Command EVE blocked sensitive S3 data from leaving through browser control.',
    };
  }

  if (method === 'Page.navigate' && !isSafeCdpNavigation(req.params)) {
    return {
      kind: 'error',
      message: 'Command EVE browser control permits only http(s) navigation.',
    };
  }

  switch (method) {
    /**
     * discover:true 时 Chromium 会立刻补发已存在目标的 targetCreated。puppeteer 靠
     * 这个事件建立 Target 对象，不补发它就一直等在 initialize() 里。
     *
     * With discover:true Chromium backfills targetCreated for existing targets.
     * puppeteer builds its Target objects from that event and would otherwise hang
     * inside initialize().
     */
    case 'Target.setDiscoverTargets': {
      const discover = req.params?.discover === true;
      if (!discover) return { kind: 'reply', payload: {} };
      return {
        kind: 'reply-and-emit',
        payload: {},
        emit: [{ method: 'Target.targetCreated', params: { targetInfo: getTargetInfo() } }],
      };
    }

    case 'Target.setAutoAttach': {
      /**
       * 只有「浏览器级」的 setAutoAttach 才补发 attachedToTarget。
       *
       * 实测踩到的死循环：puppeteer 收到 attachedToTarget 后会为新 session 再发一次
       * setAutoAttach（递归附加子目标），如果我们对每一次都补发，就会
       * setAutoAttach → attachedToTarget → setAutoAttach … 无限循环，
       * 连接永远初始化不完。带 sessionId 的那次代表「在页面会话里问子目标」，
       * 我们没有子目标（没有 iframe/worker 需要暴露），直接应答空即可。
       *
       * Only the browser-level setAutoAttach backfills attachedToTarget. Testing hit an
       * infinite loop: on receiving attachedToTarget puppeteer issues another setAutoAttach
       * on the new session (to recurse into sub-targets), so backfilling on every call
       * produced setAutoAttach → attachedToTarget → setAutoAttach … forever and the
       * connection never finished initialising. The call carrying a sessionId means "list
       * sub-targets within the page session"; we expose none, so an empty ack is correct.
       */
      const isBrowserLevel = req.sessionId === undefined || req.sessionId === '';
      if (!isBrowserLevel) return { kind: 'reply', payload: {} };

      /**
       * 必须主动补发 attachedToTarget，否则 puppeteer 认不出这个页面。
       *
       * puppeteer 的 TargetManager.getAvailableTargets() 返回的是
       * #attachedTargetsByTargetId —— 只有「已附加」的目标才算数，而「已附加」只由
       * attachedToTarget 事件建立。targetCreated 只进 discovered 列表，
       * 所以只发 targetCreated 会让 browser.pages() 返回 0。
       *
       * filter 里的 {type:'page', exclude:true} 看着像「别自动附加页面」，但那管的是
       * 运行中新开的页面；对连接时就已存在的页面，真实 Chrome 会在 setAutoAttach 时
       * 直接补发 attachedToTarget。我们那个常驻页面属于后者。
       *
       * We must proactively emit attachedToTarget or puppeteer never recognises the page:
       * getAvailableTargets() returns #attachedTargetsByTargetId, and only the
       * attachedToTarget event establishes attachment. targetCreated merely populates the
       * discovered list, so emitting it alone leaves browser.pages() at 0.
       *
       * The {type:'page', exclude:true} filter looks like "do not auto-attach pages", but
       * that governs pages opened later; for pages already present at connect time real
       * Chrome backfills attachedToTarget during setAutoAttach. Our persistent page is that
       * case.
       */
      return {
        kind: 'reply-and-emit',
        payload: {},
        emit: [
          {
            method: 'Target.attachedToTarget',
            params: { sessionId: SINGLE_SESSION_ID, targetInfo: getTargetInfo(), waitingForDebugger: false },
          },
        ],
      };
    }

    case 'Target.getTargets':
      return { kind: 'reply', payload: { targetInfos: [getTargetInfo()] } };

    case 'Target.getTargetInfo':
      if (typeof req.params?.targetId === 'string' && req.params.targetId !== SINGLE_TARGET_ID) {
        return { kind: 'error', message: `No such target id: ${req.params.targetId}` };
      }
      return { kind: 'reply', payload: { targetInfo: getTargetInfo() } };

    case 'Target.getBrowserContexts':
      return { kind: 'reply', payload: { browserContextIds: [SINGLE_BROWSER_CONTEXT_ID] } };

    /**
     * 只允许附加到我们唯一的目标；其它 id 直接报错，避免把请求转给一个不存在的会话。
     * attachedToTarget 事件带 sessionId，flatten 模式下 puppeteer 依赖它路由后续命令。
     *
     * Only our single target may be attached; any other id errors out instead of being
     * routed to a session that does not exist. The attachedToTarget event carries the
     * sessionId that puppeteer uses to route later commands in flatten mode.
     */
    case 'Target.attachToTarget': {
      const requested = req.params?.targetId;
      if (typeof requested === 'string' && requested !== SINGLE_TARGET_ID) {
        return { kind: 'error', message: `No such target id: ${requested}` };
      }
      return {
        kind: 'reply-and-emit',
        payload: { sessionId: SINGLE_SESSION_ID },
        emit: [
          {
            method: 'Target.attachedToTarget',
            params: { sessionId: SINGLE_SESSION_ID, targetInfo: getTargetInfo(), waitingForDebugger: false },
          },
        ],
      };
    }

    case 'Target.detachFromTarget':
      // 关掉侧边浏览器不该由 Agent 决定，静默应答即可。
      // Closing the in-app browser is not the agent's call; acknowledge and do nothing.
      return { kind: 'reply', payload: {} };

    case 'Target.activateTarget':
    case 'Target.closeTarget': {
      const requested = req.params?.targetId;
      if (typeof requested === 'string' && requested !== SINGLE_TARGET_ID) {
        return { kind: 'error', message: `No such target id: ${requested}` };
      }
      return { kind: 'reply', payload: {} };
    }

    case 'Target.createTarget':
      return {
        kind: 'error',
        message: 'AionUi in-app browser exposes a single fixed tab; Target.createTarget is not supported.',
      };

    case 'Target.createBrowserContext':
    case 'Target.disposeBrowserContext':
      return { kind: 'error', message: 'AionUi in-app browser does not support multiple browser contexts.' };

    /**
     * Browser.close 会关掉整个应用 —— 绝不能让 Agent 触发。
     * Browser.close would terminate the whole app; never let the agent reach it.
     */
    case 'Browser.close':
      return { kind: 'error', message: 'Browser.close is not permitted against the AionUi in-app browser.' };

    default:
      return CDP_ALLOWED_FORWARD_METHODS.has(method)
        ? { kind: 'forward' }
        : { kind: 'error', message: 'Command EVE CDP policy does not permit this method.' };
  }
};

/**
 * 判断入站 sessionId 是否可接受。
 *
 * 空 sessionId = 浏览器级命令；我们那个固定 session = 页面级。其余一律拒绝，
 * 而不是当成浏览器级放过去 —— 静默放行会让错路由的命令看起来「成功」。
 *
 * An empty sessionId means a browser-level command; our fixed session means page level.
 * Anything else is rejected rather than quietly treated as browser-level, since letting
 * it through would make a misrouted command look like it succeeded.
 */
export const isAcceptableSessionId = (sessionId: string | undefined): boolean =>
  sessionId === undefined || sessionId === '' || sessionId === SINGLE_SESSION_ID;

/** 常量时间比较，避免用字符串比较泄漏 token 前缀信息。/ Constant-time compare so token prefixes do not leak. */
export const tokensMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};
