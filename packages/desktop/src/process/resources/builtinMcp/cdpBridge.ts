/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 单目标 CDP 通道：只把「侧边浏览器那一个 webContents」暴露给 Agent。
 *
 * 替代 Chromium 的 remote-debugging-port。那个开关是应用级的，没有 per-target ACL，
 * 一开就把主窗口（连着 preload 桥）暴露给本机任意进程。这里改成：
 *   - 只绑 127.0.0.1，且必须带口令才能连
 *   - 只服务一个目标，Target.* 由 cdpTargetProtocol 本地应答
 *   - 其余命令透传给 webContents.debugger
 *
 * Single-target CDP bridge: exposes only the in-app browser's webContents to the agent.
 * Replaces Chromium's remote-debugging-port, which is application-wide with no
 * per-target ACL and therefore also exposes the main window and its preload bridge.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { session, type Debugger, type WebContents } from 'electron';
import { classifyBrowserAuthSurface, type BrowserAuthSurfaceSnapshot } from '@/common/config/browserAuthChallengeCore';
import {
  BROWSER_CONTROL_EPOCH_RE,
  BROWSER_CONTROL_LEASE_RE,
  decideBrowserControlAnnouncement,
  isExactBrowserControlLease,
  type BrowserControlLease,
} from '@/common/config/browserWorkbenchControlCore';
import {
  SINGLE_SESSION_ID,
  buildListPayload,
  buildTargetInfo,
  buildVersionPayload,
  decideCdpCommand,
  isAcceptableSessionId,
  tokensMatch,
  type CdpRequest,
} from './cdpTargetProtocol';

const HOST = '127.0.0.1';

export type CdpBridgeHandle = {
  port: number;
  /** 侧边浏览器的 webContents id；未附加时为 null。/ null while nothing is attached. */
  attachedWebContentsId: () => number | null;
  registerGuest: (contents: WebContents) => { ok: true } | { ok: false; reason: string };
  activateContext: (contextId: string, partition: string, controlEpoch: string) => { cdpUrl: string };
  deactivateContext: (contextId: string, controlEpoch: string) => void;
  attach: (
    webContentsId: number,
    contextId: string,
    controlEpoch: string
  ) => { ok: true; leaseId: string } | { ok: false; reason: string };
  release: (lease: BrowserControlLease) => { ok: true } | { ok: false; reason: string };
  detachActiveTarget: (reason: string) => void;
  close: () => Promise<void>;
};

type AttachedState = BrowserControlLease & {
  contents: WebContents;
  dbg: Debugger;
  onMessage: (event: unknown, method: string, params: unknown, sessionId: string) => void;
  onDestroyed: () => void;
  onRenderProcessGone: () => void;
};

type ActiveContext = {
  id: string;
  partition: string;
  controlEpoch: string;
  capability: string;
};

type RegisteredGuest = {
  contents: WebContents;
  onDestroyed: () => void;
};

type SocketBinding = {
  lease: BrowserControlLease;
  attachment: AttachedState;
};

let attached: AttachedState | null = null;
let sockets = new Map<WebSocket, SocketBinding>();
let activeContext: ActiveContext | null = null;
const registeredGuests = new Map<number, RegisteredGuest>();

const hasLiveAttachedTarget = (): boolean =>
  Boolean(
    attached &&
    activeContext &&
    !attached.contents.isDestroyed() &&
    attached.contextId === activeContext.id &&
    attached.controlEpoch === activeContext.controlEpoch
  );

const currentTargetInfo = () => {
  if (!hasLiveAttachedTarget() || !attached) return buildTargetInfo('', 'about:blank');
  return buildTargetInfo(attached.contents.getTitle(), attached.contents.getURL());
};

const leaseFromAttachment = (attachment: AttachedState): BrowserControlLease => ({
  contextId: attachment.contextId,
  controlEpoch: attachment.controlEpoch,
  webContentsId: attachment.webContentsId,
  leaseId: attachment.leaseId,
});

const isCurrentAttachment = (attachment: AttachedState): boolean =>
  Boolean(
    attached === attachment &&
    activeContext &&
    !attachment.contents.isDestroyed() &&
    attachment.contextId === activeContext.id &&
    attachment.controlEpoch === activeContext.controlEpoch &&
    isExactBrowserControlLease(attached, leaseFromAttachment(attachment))
  );

const isCurrentSocketBinding = (ws: WebSocket, binding: SocketBinding): boolean =>
  sockets.get(ws) === binding && isCurrentAttachment(binding.attachment);

const broadcastForLease = (lease: BrowserControlLease, payload: Record<string, unknown>) => {
  const text = JSON.stringify(payload);
  for (const [ws, binding] of sockets) {
    if (isExactBrowserControlLease(binding.lease, lease) && ws.readyState === ws.OPEN) ws.send(text);
  }
};

const closeSockets = (reason: string) => {
  for (const ws of sockets.keys()) {
    try {
      ws.close(4001, reason);
    } catch {
      ws.terminate();
    }
  }
  sockets = new Map();
};

const detachExactLease = (expected: BrowserControlLease, reason: string, emitTargetDestroyed = true): boolean => {
  if (!attached || !isExactBrowserControlLease(attached, expected)) return false;
  const { contents, dbg, onMessage, onDestroyed, onRenderProcessGone } = attached;
  attached = null;
  try {
    dbg.removeListener('message', onMessage);
    contents.removeListener('destroyed', onDestroyed);
    contents.removeListener('render-process-gone', onRenderProcessGone);
    if (dbg.isAttached()) dbg.detach();
  } catch {
    // 已经销毁/已分离时 Electron 会抛，忽略即可。
    // Electron throws if it is already destroyed or detached; nothing to do.
  }
  if (emitTargetDestroyed) {
    broadcastForLease(expected, {
      method: 'Target.targetDestroyed',
      params: { targetId: currentTargetInfo().targetId },
    });
  }
  closeSockets(reason);
  return true;
};

const detachActiveTarget = (reason: string, emitTargetDestroyed = true): void => {
  if (!attached) {
    closeSockets(reason);
    return;
  }
  const expected: BrowserControlLease = {
    contextId: attached.contextId,
    controlEpoch: attached.controlEpoch,
    webContentsId: attached.webContentsId,
    leaseId: attached.leaseId,
  };
  detachExactLease(expected, reason, emitTargetDestroyed);
};

/**
 * 附加到指定 webContents。
 *
 * 两道校验都必须报错而不是「尽力而为」：
 *  - getType() 必须是 webview：防止把主窗口（带 preload 桥）交出去，这正是原方案的漏洞。
 *  - debugger.attach() 会和同一个 webContents 上打开的 DevTools 冲突（Electron 限制），
 *    这时给出可读的原因，而不是抛一个原始异常。
 *
 * Both checks must fail loudly rather than degrade:
 *  - getType() must be 'webview', so the main window (with its preload bridge) can never
 *    be handed over — that is precisely the hole in the process-wide approach.
 *  - debugger.attach() conflicts with DevTools open on the same webContents (an Electron
 *    limitation); surface a readable reason instead of a raw throw.
 */
const attachInternal = (
  webContentsId: number,
  contextId: string,
  controlEpoch: string
): { ok: true; leaseId: string } | { ok: false; reason: string } => {
  if (attached?.contents.isDestroyed()) {
    const destroyedLease: BrowserControlLease = {
      contextId: attached.contextId,
      controlEpoch: attached.controlEpoch,
      webContentsId: attached.webContentsId,
      leaseId: attached.leaseId,
    };
    detachExactLease(destroyedLease, 'browser target was destroyed');
  }

  const decision = decideBrowserControlAnnouncement(
    activeContext ? { contextId: activeContext.id, controlEpoch: activeContext.controlEpoch } : null,
    attached,
    { contextId, controlEpoch, webContentsId }
  );
  if (decision.kind === 'reject') return { ok: false, reason: decision.reason };
  if (decision.kind === 'idempotent') return { ok: true, leaseId: decision.leaseId };

  const registered = registeredGuests.get(webContentsId);
  const contents = registered?.contents;
  if (!contents || contents.isDestroyed()) {
    return { ok: false, reason: `No live webContents with id ${webContentsId}` };
  }

  const type = contents.getType();
  if (type !== 'webview') {
    return {
      ok: false,
      reason: `Refusing to attach to webContents of type "${type}"; only the in-app browser webview may be exposed.`,
    };
  }

  if (!activeContext || contents.session !== session.fromPartition(activeContext.partition)) {
    return {
      ok: false,
      reason: 'Refusing webview from another account or seed partition.',
    };
  }

  const dbg = contents.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Could not attach debugger (DevTools open on this view will block it): ${message}` };
  }

  const lease: BrowserControlLease = {
    contextId,
    controlEpoch,
    webContentsId,
    leaseId: randomBytes(16).toString('hex'),
  };
  const onMessage = (_event: unknown, method: string, params: unknown, _sessionId: string) => {
    /**
     * 统一贴上我们那个固定 sessionId 再转发。
     *
     * puppeteer 用 flatten 模式，它靠 sessionId 把事件路由到对应的页面会话；不贴的话
     * 事件会被当成浏览器级的，Page/Runtime 那些事件就丢了。
     *
     * Stamp our fixed sessionId before forwarding. puppeteer runs in flatten mode and
     * routes events to the page session by sessionId; without it these would look
     * browser-level and Page/Runtime events would be dropped.
     */
    if (!attached || !isExactBrowserControlLease(attached, lease)) return;
    broadcastForLease(lease, { method, params: params ?? {}, sessionId: SINGLE_SESSION_ID });
  };

  const onDestroyed = () => {
    detachExactLease(lease, 'browser target was destroyed');
  };
  const onRenderProcessGone = () => {
    detachExactLease(lease, 'browser target renderer process exited');
  };

  dbg.on('message', onMessage);
  contents.once('destroyed', onDestroyed);
  contents.on('render-process-gone', onRenderProcessGone);
  attached = { ...lease, contents, dbg, onMessage, onDestroyed, onRenderProcessGone };
  return { ok: true, leaseId: lease.leaseId };
};

const registerGuest = (contents: WebContents): { ok: true } | { ok: false; reason: string } => {
  if (contents.isDestroyed() || contents.getType() !== 'webview') {
    return { ok: false, reason: 'Only a live in-app browser webview may be registered for control.' };
  }
  const existing = registeredGuests.get(contents.id);
  if (existing?.contents === contents) return { ok: true };
  if (existing) existing.contents.removeListener('destroyed', existing.onDestroyed);

  const onDestroyed = () => {
    const current = registeredGuests.get(contents.id);
    if (current?.contents === contents) registeredGuests.delete(contents.id);
  };
  contents.once('destroyed', onDestroyed);
  registeredGuests.set(contents.id, { contents, onDestroyed });
  return { ok: true };
};

const releaseInternal = (lease: BrowserControlLease): { ok: true } | { ok: false; reason: string } => {
  if (!BROWSER_CONTROL_EPOCH_RE.test(lease.controlEpoch) || !BROWSER_CONTROL_LEASE_RE.test(lease.leaseId)) {
    return { ok: false, reason: 'Browser control lease is malformed.' };
  }
  if (!attached) return { ok: true };
  if (!isExactBrowserControlLease(attached, lease)) {
    return { ok: false, reason: 'Refusing stale browser control lease release.' };
  }
  detachExactLease(lease, 'browser target lease released');
  return { ok: true };
};

const sendSocketPayload = (ws: WebSocket, payload: Record<string, unknown>): void => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
};

const sendError = (ws: WebSocket, id: number | undefined, message: string) =>
  sendSocketPayload(ws, { id: id ?? 0, error: { code: -32601, message } });

const AUTH_GATED_INPUT_METHODS = new Set([
  'Autofill.trigger',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
]);

const detectNeedsUser = async (attachment: AttachedState, method: string): Promise<string | null> => {
  if (!AUTH_GATED_INPUT_METHODS.has(method) || attachment.contents.isDestroyed()) return null;
  try {
    const evaluated = (await attachment.dbg.sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const active = document.activeElement;
        const text = (document.body?.innerText || '').slice(0, 12000).toLowerCase();
        const activeName = [active?.getAttribute?.('name'), active?.id, active?.getAttribute?.('aria-label')]
          .filter(Boolean).join(' ');
        return {
          active_type: active?.getAttribute?.('type') || '',
          active_autocomplete: active?.getAttribute?.('autocomplete') || '',
          active_name: activeName,
          has_mfa_signal: Boolean(document.querySelector('[autocomplete="one-time-code"]')) || /one[- ]time code|verification code|recovery code|two[- ]factor/.test(text),
          has_passkey_signal: Boolean(document.querySelector('[data-passkey], [autocomplete="webauthn"]')) || /use (a )?passkey|security key/.test(text),
          has_captcha_signal: Boolean(document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-captcha], .g-recaptcha, .h-captcha')) || /verify you are human|captcha/.test(text),
          has_risk_signal: Boolean(document.querySelector('[data-risk-challenge]')) || /unusual activity|verify it(?:'|’)s you|suspicious sign[- ]in/.test(text),
        };
      })()`,
      returnByValue: true,
    })) as { result?: { value?: BrowserAuthSurfaceSnapshot } };
    const decision = classifyBrowserAuthSurface(evaluated.result?.value ?? {});
    return decision ? `needs_user:${decision.reason}` : null;
  } catch {
    // A failed classifier must never turn into permission. Input can be
    // retried after the visible page settles; treating an unreadable surface
    // as a risk challenge keeps passwords/MFA/passkeys out of the agent path.
    return 'needs_user:risk-challenge';
  }
};

const handleSocketMessage = async (ws: WebSocket, binding: SocketBinding, raw: string) => {
  if (!isCurrentSocketBinding(ws, binding)) return;
  let req: CdpRequest;
  try {
    req = JSON.parse(raw) as CdpRequest;
  } catch {
    return; // 非 JSON 直接忽略 / ignore non-JSON frames
  }

  const { id, method, params, sessionId } = req;
  if (!method) return;

  if (!isAcceptableSessionId(sessionId)) {
    sendError(ws, id, `Unknown sessionId: ${sessionId}`);
    return;
  }

  const targetInfo = () =>
    buildTargetInfo(binding.attachment.contents.getTitle(), binding.attachment.contents.getURL());
  const decision = decideCdpCommand(req, targetInfo);

  if (decision.kind === 'error') {
    sendError(ws, id, decision.message);
    return;
  }

  if (decision.kind === 'reply' || decision.kind === 'reply-and-emit') {
    sendSocketPayload(ws, { id, result: decision.payload });
    if (decision.kind === 'reply-and-emit') {
      for (const evt of decision.emit) {
        sendSocketPayload(ws, { method: evt.method, params: evt.params });
      }
    }
    return;
  }

  // forward
  if (!isCurrentSocketBinding(ws, binding)) {
    sendError(ws, id, 'The in-app browser is not currently attached.');
    return;
  }

  const needsUser = await detectNeedsUser(binding.attachment, method);
  if (!isCurrentSocketBinding(ws, binding)) return;
  if (needsUser) {
    sendError(ws, id, needsUser);
    return;
  }

  try {
    const result = await binding.attachment.dbg.sendCommand(method, params ?? {});
    if (!isCurrentSocketBinding(ws, binding)) return;
    sendSocketPayload(ws, { id, result: result ?? {}, sessionId });
  } catch (error) {
    if (!isCurrentSocketBinding(ws, binding)) return;
    const message = error instanceof Error ? error.message : String(error);
    sendSocketPayload(ws, { id, error: { code: -32000, message }, sessionId });
  }
};

const writeJson = (res: ServerResponse, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
};

/**
 * Start the loopback bridge. Discovery and WebSocket paths are both scoped by
 * an ephemeral capability that rotates whenever the account+seed context
 * changes. The capability is written only to the owner-only MAIN runtime file
 * consumed by Hermes; scanning the loopback port no longer reveals it.
 */
export const startCdpBridge = async (): Promise<CdpBridgeHandle> => {
  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const context = activeContext;
    if (!context) {
      res.writeHead(404).end('not found');
      return;
    }
    const prefix = `/session/${context.capability}`;
    const wsUrl = `ws://${HOST}:${port}${prefix}/aionui-cdp`;
    const info = currentTargetInfo();

    if (url.pathname === `${prefix}/json/version`) {
      writeJson(res, buildVersionPayload(wsUrl, process.versions.chrome ?? '0.0.0.0'));
      return;
    }
    if (url.pathname === `${prefix}/json/list` || url.pathname === `${prefix}/json`) {
      writeJson(res, hasLiveAttachedTarget() ? buildListPayload(wsUrl, info.title, info.url) : []);
      return;
    }
    res.writeHead(404).end('not found');
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const context = activeContext;
    const attachment = attached;
    const segments = url.pathname.split('/').filter(Boolean);
    const capability = segments.length === 3 && segments[0] === 'session' ? segments[1] : '';
    if (
      !context ||
      !attachment ||
      !isCurrentAttachment(attachment) ||
      segments[2] !== 'aionui-cdp' ||
      !tokensMatch(context.capability, capability)
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!isCurrentAttachment(attachment)) {
        ws.close(4001, 'browser target changed during connection');
        return;
      }
      const binding: SocketBinding = { lease: leaseFromAttachment(attachment), attachment };
      sockets.set(ws, binding);
      ws.on('message', (data) => void handleSocketMessage(ws, binding, data.toString()));
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', () => sockets.delete(ws));
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    // 端口 0 = 让系统分配空闲端口，避免和别的服务撞。
    // Port 0 lets the OS pick a free port so we cannot collide with another service.
    httpServer.listen(0, HOST, () => {
      const addr = httpServer.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('Could not determine bridge port'));
    });
  });

  return {
    port,
    attachedWebContentsId: () => (attached && !attached.contents.isDestroyed() ? attached.contents.id : null),
    registerGuest,
    activateContext: (contextId: string, partition: string, controlEpoch: string) => {
      if (!contextId || !partition || !BROWSER_CONTROL_EPOCH_RE.test(controlEpoch)) {
        throw new Error('Browser context activation requires identity, partition, and a valid control epoch.');
      }
      if (
        activeContext?.id !== contextId ||
        activeContext.partition !== partition ||
        activeContext.controlEpoch !== controlEpoch
      ) {
        detachActiveTarget('browser context changed', false);
        activeContext = {
          id: contextId,
          partition,
          controlEpoch,
          capability: randomBytes(24).toString('hex'),
        };
      }
      return { cdpUrl: `http://${HOST}:${port}/session/${activeContext.capability}` };
    },
    deactivateContext: (contextId: string, controlEpoch: string) => {
      if (!activeContext || activeContext.id !== contextId || activeContext.controlEpoch !== controlEpoch) return;
      detachActiveTarget('browser context revoked', false);
      activeContext = null;
    },
    attach: attachInternal,
    release: releaseInternal,
    detachActiveTarget,
    close: async () => {
      detachActiveTarget('browser bridge closed', false);
      activeContext = null;
      for (const registration of registeredGuests.values()) {
        registration.contents.removeListener('destroyed', registration.onDestroyed);
      }
      registeredGuests.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      });
    },
  };
};
